/**
 * executors/visual.js — visual regression via screenshot pixel-diff.
 *
 * Consumes: plan.visualBaselines[]
 * Produces: findings when a page's screenshot differs from baseline > threshold
 *
 * Strategy:
 *   1. For each baseline, navigate the page, set viewport, mask dynamic elements
 *   2. If baselinePath is set, load the baseline image + diff against current
 *      screenshot. Emit finding if diff > threshold.
 *   3. If baselinePath is NOT set (first run), capture + save as the baseline.
 *
 * Phase 2 limitation: pixel diffing requires `pixelmatch` + `pngjs` (or sharp).
 * The diff function is exposed as a pure function `computePixelDiff` so tests
 * can verify the threshold math without bundling image libraries.
 *
 * In Phase 2.5 we'll bundle the diff libraries and write actual PNGs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Pure-function diff: given two PNG buffers (raw RGBA pixels), compute
 * the fraction of differing pixels.
 *
 * @param {Buffer} actual    — raw RGBA pixel data of the actual screenshot
 * @param {Buffer} baseline  — raw RGBA pixel data of the baseline screenshot
 * @returns {{ diffRatio: number, diffPixelCount: number }}
 */
export function computePixelDiff(actual, baseline) {
  if (!actual || !baseline) {
    return { diffRatio: 1.0, diffPixelCount: -1 };
  }
  if (actual.length !== baseline.length) {
    // Different dimensions = total diff
    return { diffRatio: 1.0, diffPixelCount: -1 };
  }
  const pixelCount = actual.length / 4;
  let diffPixels = 0;
  for (let i = 0; i < actual.length; i += 4) {
    // Use luminance diff with a tolerance of 30 (out of 255)
    const aLum = 0.299 * actual[i] + 0.587 * actual[i + 1] + 0.114 * actual[i + 2];
    const bLum = 0.299 * baseline[i] + 0.587 * baseline[i + 1] + 0.114 * baseline[i + 2];
    if (Math.abs(aLum - bLum) > 30) {
      diffPixels++;
    }
  }
  return { diffRatio: diffPixels / pixelCount, diffPixelCount: diffPixels };
}

/**
 * Capture a screenshot from a Playwright page with the given viewport
 * + masked elements.
 */
export async function captureScreenshot(page, baseline, screenshotsDir, runId) {
  // Set viewport if the page supports it (Playwright Page.setViewportSize)
  if (typeof page.setViewportSize === 'function') {
    await page.setViewportSize({ width: baseline.viewport.width, height: baseline.viewport.height });
  }

  await page.goto(baseline.pageUrl, { waitUntil: 'load', timeout: 30000 });

  // Apply masks — mask selectors are CSS selectors whose area should be
  // excluded from the diff (ads, dynamic content, etc.)
  const maskOptions = {};
  if (baseline.maskSelectors?.length) {
    maskOptions.mask = baseline.maskSelectors.map(s => page.locator(s));
  }

  const buffer = await page.screenshot({
    type: 'png',
    fullPage: false,
    ...maskOptions,
  });

  // Hash for tracking — useful in findings
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);

  // Filename: {runId}_{pageSlug}_{viewportName}_{hash}.png
  const slug = baseline.pageUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-50);
  const filename = `${runId}_${slug}_${baseline.viewport.name || 'default'}_${hash}.png`;
  const filepath = path.join(screenshotsDir, filename);
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.writeFile(filepath, buffer);

  return { buffer, filepath, hash };
}

/** Main executor entry — registered as 'visual' in the registry. */
export default async function visualExecutor(ctx) {
  if (!ctx.context) {
    ctx.onEvent?.('visual skipped — no Playwright context available');
    return { findings: [], stats: { skipped: true, reason: 'no-browser-context' } };
  }

  const baselines = ctx.plan?.visualBaselines || [];
  const findings = [];

  ctx.onEvent?.(`Capturing/comparing ${baselines.length} visual baselines`);

  for (const baseline of baselines) {
    if (ctx.signal?.aborted) break;

    const page = await ctx.context.newPage({ viewport: baseline.viewport });
    try {
      const { buffer, filepath, hash } = await captureScreenshot(
        page, baseline, ctx.screenshotsDir, ctx.runId
      );

      // If baseline exists, compare
      if (baseline.baselinePath) {
        try {
          const baselineBuffer = await fs.readFile(baseline.baselinePath);
          const { diffRatio, diffPixelCount } = computePixelDiff(buffer, baselineBuffer);

          if (diffRatio > baseline.threshold) {
            findings.push(ctx.createFinding({
              title: `Visual regression: ${baseline.pageUrl} (${baseline.viewport.name || 'default'})`,
              severity: 'medium',
              confidence: 'high',
              category: 'network',
              findingType: 'bug',
              origin: 'first-party',
              ruleId: 'visual-regression',
              pageUrl: baseline.pageUrl,
              description: `Pixel diff ${(diffRatio * 100).toFixed(2)}% exceeds threshold ${(baseline.threshold * 100).toFixed(2)}%.`,
              evidence: `Baseline: ${baseline.baselinePath}\nActual: ${filepath}\nDiff pixels: ${diffPixelCount} / ${(diffRatio * 100).toFixed(2)}%`,
              screenshot: filepath,
              suggestedFix: 'If the change is intentional, update the baseline. Otherwise, restore the original layout.',
            }));
          }
        } catch (err) {
          // Baseline file missing — treat as first run + update plan
          ctx.onEvent?.(`Baseline missing for ${baseline.pageUrl}; capturing new baseline at ${filepath}`);
        }
      } else {
        // First run — this screenshot IS the new baseline
        ctx.onEvent?.(`New baseline captured for ${baseline.pageUrl}: ${filepath}`);
        // Note: in production, the executor would call a callback here to
        // update the plan's baselinePath. For now we just emit an info finding.
        findings.push(ctx.createFinding({
          title: `Visual baseline captured: ${baseline.pageUrl}`,
          severity: 'info',
          confidence: 'confirmed',
          category: 'network',
          findingType: 'informational',
          origin: 'first-party',
          ruleId: 'visual-baseline-captured',
          pageUrl: baseline.pageUrl,
          description: `First-run baseline stored at ${filepath}. Future runs will diff against this.`,
          screenshot: filepath,
        }));
      }
    } catch (err) {
      findings.push(ctx.createFinding({
        title: `Visual capture failed for ${baseline.pageUrl}`,
        severity: 'low',
        confidence: 'high',
        category: 'network',
        findingType: 'environmental',
        origin: 'first-party',
        ruleId: 'visual-capture-error',
        pageUrl: baseline.pageUrl,
        description: err.message,
      }));
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`visual complete: ${findings.length} findings`);
  return { findings, stats: { baselines: baselines.length, captured: findings.filter(f => f.ruleId === 'visual-baseline-captured').length } };
}
