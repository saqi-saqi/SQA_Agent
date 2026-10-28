/**
 * visualInferrer.js — propose visual regression baselines for crawled pages.
 *
 * Heuristic. One baseline per (page, viewport) pair. Default viewport is
 * desktop 1280x720. Phase 2 will add a mobile viewport (375x667) so we
 * get a cross-viewport matrix.
 */
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';
import { randomUUID } from 'node:crypto';

const VisualBaselineSchema = arrayElementSchema(TestPlan.shape.visualBaselines);

const DESKTOP_VIEWPORT = { width: 1280, height: 720, name: 'desktop' };
const MOBILE_VIEWPORT = { width: 375, height: 667, name: 'mobile', isMobile: true, hasTouch: true };

export function inferVisualBaselines({ pages, viewports = [DESKTOP_VIEWPORT] }) {
  const baselines = [];

  for (const page of pages || []) {
    for (const viewport of viewports) {
      const baseline = {
        pageUrl: page.url,
        label: `${viewport.name || 'default'}-${baselines.length + 1}`,
        viewport,
        maskSelectors: [],     // Phase 2: auto-detect ad banners / dynamic content
        threshold: 0.01,
        // baselinePath intentionally omitted — schema marks it optional, and
        // it's set only after the first run captures the screenshot.
      };
      const parsed = VisualBaselineSchema.safeParse(baseline);
      if (parsed.success) baselines.push(parsed.data);
    }
  }

  return baselines;
}

export function inferViewports({ pages }) {
  // Default: ship both desktop + mobile unless the target appears to be
  // a non-responsive API-only doc site (no <meta viewport>).
  const hasViewportMeta = (pages || []).some(p =>
    p.meta?.viewport && /width=device-width/i.test(p.meta.viewport)
  );

  if (hasViewportMeta) {
    return [DESKTOP_VIEWPORT, MOBILE_VIEWPORT];
  }
  return [DESKTOP_VIEWPORT];
}
