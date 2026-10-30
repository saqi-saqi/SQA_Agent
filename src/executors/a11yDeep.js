/**
 * executors/a11yDeep.js — axe-core accessibility audit.
 *
 * Consumes: plan.a11yRules[]
 * Produces: findings per axe-core violation (one finding per rule × element)
 *
 * Requires Playwright BrowserContext. Uses axe-core injected into the page.
 * Falls back gracefully if axe-core isn't available.
 *
 * axe-core is injected from the local node_modules install (bundled via
 * @axe-core/playwright). Local file injection bypasses site CSP, which the
 * CDN URL approach could not (e.g. facebook.com blocks unpkg.com).
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../utils/config.js';

const AXE_RULE_TO_SEVERITY = {
  critical: 'critical',
  serious: 'serious',
  moderate: 'medium',
  minor: 'low',
};

function resolveLocalAxePath() {
  // Project root is two levels up from this file (src/executors/).
  const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const local = path.join(projectRoot, 'node_modules', 'axe-core', 'axe.min.js');
  return existsSync(local) ? local : null;
}

/**
 * Run axe-core against a single page using the injected axe object.
 *
 * @param {object} page    — Playwright Page with axe-core injected
 * @param {string[]} rules — axe rule IDs to run (empty = all rules)
 */
export async function runAxeOnPage(page, rules = []) {
  // page.evaluate runs in the browser context — axe must already be loaded.
  // Expected return shape: { violations: [{ id, impact, nodes, help, tags }] }
  const results = await page.evaluate((ruleList) => {
    if (typeof axe === 'undefined') {
      return { error: 'axe-core not loaded' };
    }
    let opts = {};
    if (ruleList.length) {
      // Filter against the loaded axe version — plan rule IDs may drift
      // across axe releases, and an unknown ID makes axe.run() throw.
      const known = new Set(axe.getRules().map(r => r.ruleId));
      const valid = ruleList.filter(r => known.has(r));
      if (valid.length) {
        opts = { runOnly: { type: 'rule', values: valid } };
      }
    }
    return axe.run(opts);
  }, rules);

  if (results.error) {
    throw new Error(results.error);
  }

  return results;
}

/** Translate axe-core results into findings */
export function axeResultsToFindings(results, pageUrl, createFinding) {
  const findings = [];
  for (const violation of results.violations || []) {
    const severity = AXE_RULE_TO_SEVERITY[violation.impact] || 'medium';
    const nodeCount = violation.nodes?.length || 0;
    const targets = violation.nodes?.map(n => Array.isArray(n.target) ? n.target.join(' ') : n.target).filter(Boolean);
    const selector = targets && targets.length ? targets.slice(0, 5).join('; ') : null;

    findings.push(createFinding({
      title: `a11y: ${violation.help} (${violation.id})`,
      severity,
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      origin: 'first-party',
      ruleId: `axe-${violation.id}`,
      pageUrl,
      description: `${violation.description}\nAffected: ${nodeCount} node(s)`,
      evidence: violation.nodes?.slice(0, 3).map((n, i) => `Node ${i + 1}: ${n.html}\nTarget: ${n.target.join(', ')}`).join('\n---\n') || '',
      occurrences: nodeCount,
      affectedPages: [pageUrl],
      affectedElements: nodeCount,
      selector,
      suggestedFix: violation.helpUrl
        ? `See: ${violation.helpUrl}`
        : 'Refactor the markup to satisfy the rule.',
    }));
  }
  return findings;
}

/** Main executor entry — registered as 'accessibility-deep' in the registry. */
export default async function a11yDeepExecutor(ctx) {
  if (!ctx.context) {
    ctx.onEvent?.('a11y-deep skipped — no Playwright context available');
    return { findings: [], stats: { skipped: true, reason: 'no-browser-context' } };
  }

  const pages = ctx.plan?.pages || [];
  const rules = (ctx.plan?.a11yRules || []).map(r => r.rule);
  const findings = [];

  ctx.onEvent?.(`Running axe-core on ${pages.length} pages (${rules.length} rules)`);

  for (const pageInfo of pages) {
    if (ctx.signal?.aborted) break;

    if (ctx.isPageFailed?.(pageInfo.url)) {
      ctx.recordPageFailure?.({ url: pageInfo.url, executor: 'accessibility-deep' });
      continue;
    }

    const page = await ctx.context.newPage();
    try {
      await page.goto(pageInfo.url, { waitUntil: 'load', timeout: config?.pageTimeoutMs || 30000 });

      // Inject axe-core from the local install (CSP-safe). Fall back to the
      // CDN only if the local package is missing. Skip if both fail.
      const localAxePath = resolveLocalAxePath();
      try {
        if (localAxePath) {
          await page.addScriptTag({ path: localAxePath });
        } else {
          await page.addScriptTag({ url: 'https://unpkg.com/axe-core@4.10.0/axe.min.js' });
        }
      } catch (injectionErr) {
        findings.push(ctx.createFinding({
          title: 'a11y-deep: failed to inject axe-core',
          severity: 'low',
          confidence: 'high',
          category: 'accessibility',
          findingType: 'environmental',
          origin: 'first-party',
          ruleId: 'axe-injection-failed',
          pageUrl: pageInfo.url,
          description: `Could not inject axe-core into this page (${injectionErr.message}). Skipping deep a11y scan for this page.`,
          suggestedFix: 'Ensure the browser context allows script injection, or bundle axe-core locally.',
        }));
        continue;
      }

      const results = await runAxeOnPage(page, rules);
      findings.push(...axeResultsToFindings(results, pageInfo.url, ctx.createFinding));
    } catch (err) {
      if (ctx.recordPageFailure) {
        ctx.recordPageFailure({ url: pageInfo.url, error: err.message, executor: 'accessibility-deep' });
      } else {
        findings.push(ctx.createFinding({
          title: `Page load failed: ${pageInfo.url}`,
          severity: 'info',
          confidence: 'high',
          category: 'Scan Coverage',
          findingType: 'coverage-failure',
          origin: 'first-party',
          ruleId: 'page-load-failure',
          pageUrl: pageInfo.url,
          description: err.message,
          evidence: err.message,
          blockedExecutors: ['accessibility-deep'],
        }));
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`a11y-deep complete: ${findings.length} findings`);
  return { findings, stats: { pagesScanned: pages.length, ruleCount: rules.length } };
}
