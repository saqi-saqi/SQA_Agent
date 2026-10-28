/**
 * executors/perf.js — performance metrics via CDP (Chrome DevTools Protocol).
 *
 * Consumes: plan.perfBudgets[]
 * Produces: findings when a budget is exceeded
 *
 * Uses Playwright's CDP session to capture LCP, CLS, FCP, TTFB, plus
 * per-request timing to compute TBT and resource counts.
 *
 * Phase 2 limitation: this executor requires a real Chromium browser with
 * CDP enabled. Tests use a mock CDP session; production runs use the
 * Playwright context's CDP session.
 */

// Metric → threshold unit (for human-readable finding)
const METRIC_UNITS = {
  LCP: 'ms',
  CLS: 'unitless',
  TBT: 'ms',
  FCP: 'ms',
  TTFB: 'ms',
  pageSizeBytes: 'bytes',
  requestCount: 'requests',
};

/**
 * Capture performance metrics for a single page via CDP.
 *
 * @param {object} page       — Playwright Page
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.settleMs=2500] — time to wait after load for LCP to settle
 * @returns {Promise<{ metrics: { LCP, CLS, TBT, FCP, TTFB, pageSizeBytes, requestCount } }>}
 */
export async function capturePerfMetrics(page, url, opts = {}) {
  const settleMs = opts.settleMs ?? 2500;

  // Create a CDP session
  const client = await page.context().newCDPSession(page);

  // Enable Performance domain for metrics
  await client.send('Performance.enable');
  // Enable Network domain for resource counting
  await client.send('Network.enable');

  // Track LCP/CLS via PerformanceObserver in the page
  const perfObserverResults = await page.evaluate(async (settleMs) => {
    return new Promise((resolve) => {
      const result = { LCP: 0, CLS: 0, FCP: 0, TTFB: 0, TBT: 0 };
      const entries = [];

      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          entries.push({ name: entry.name, value: entry.value, startTime: entry.startTime });
        }
      });
      po.observe({ type: 'largest-contentful-paint', buffered: true });
      po.observe({ type: 'layout-shift', buffered: true });
      po.observe({ type: 'paint', buffered: true });
      po.observe({ type: 'longtask', buffered: true });

      // Resolve after settle period
      setTimeout(() => {
        for (const e of entries) {
          if (e.name === 'largest-contentful-paint') result.LCP = Math.max(result.LCP, e.value);
          if (e.name === 'layout-shift' && !e.hadRecentInput) result.CLS += e.value;
          if (e.name === 'first-contentful-paint') result.FCP = Math.max(result.FCP, e.value);
          if (e.name === 'longtask') result.TBT += e.value;
        }
        result.TTFB = performance.timing?.responseStart - performance.timing?.requestStart || 0;
        resolve(result);
      }, settleMs);
    });
  }, settleMs);

  // Reset + navigate
  await client.send('Network.clearBrowserCache');
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  // Wait for settle
  await page.waitForTimeout(settleMs);

  // Get resource count + total size via Network domain
  const resourceStats = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource');
    let totalSize = 0;
    for (const e of entries) {
      totalSize += e.transferSize || 0;
    }
    return { requestCount: entries.length, pageSizeBytes: totalSize };
  });

  await client.detach();

  return {
    metrics: {
      LCP: Math.round(perfObserverResults.LCP || 0),
      CLS: Number(perfObserverResults.CLS?.toFixed(3) || 0),
      TBT: Math.round(perfObserverResults.TBT || 0),
      FCP: Math.round(perfObserverResults.FCP || 0),
      TTFB: Math.round(perfObserverResults.TTFB || 0),
      pageSizeBytes: resourceStats.pageSizeBytes,
      requestCount: resourceStats.requestCount,
    },
  };
}

/**
 * Compare captured metrics against the plan's budgets.
 * Returns an array of { budget, actual, exceeded_by } for each exceeded budget.
 */
export function checkBudgets(metrics, budgets) {
  const exceeded = [];
  for (const budget of budgets) {
    const actual = metrics[budget.metric];
    if (actual == null) continue;
    if (actual > budget.threshold) {
      exceeded.push({
        budget,
        actual,
        exceededBy: actual - budget.threshold,
      });
    }
  }
  return exceeded;
}

/** Main executor entry — registered as 'perf' in the registry. */
export default async function perfExecutor(ctx) {
  if (!ctx.context) {
    ctx.onEvent?.('perf skipped — no Playwright context available');
    return { findings: [], stats: { skipped: true, reason: 'no-browser-context' } };
  }

  const pages = ctx.plan?.pages || [];
  const budgets = ctx.plan?.perfBudgets || [];
  const findings = [];

  ctx.onEvent?.(`Measuring performance on ${pages.length} pages`);

  for (const pageInfo of pages) {
    if (ctx.signal?.aborted) break;

    const page = await ctx.context.newPage();
    try {
      const { metrics } = await capturePerfMetrics(page, pageInfo.url);
      const exceeded = checkBudgets(metrics, budgets);

      for (const ex of exceeded) {
        const unit = METRIC_UNITS[ex.budget.metric] || '';
        findings.push(ctx.createFinding({
          title: `Perf budget exceeded: ${ex.budget.metric} (${ex.actual}${unit} > ${ex.budget.threshold}${unit})`,
          severity: ex.budget.severity,
          confidence: 'confirmed',
          category: 'performance',
          findingType: ex.budget.severity === 'info' ? 'informational' : 'warning',
          origin: 'first-party',
          ruleId: `perf-budget-${ex.budget.metric}`,
          pageUrl: pageInfo.url,
          description: `Metric ${ex.budget.metric} exceeded its budget by ${Math.round(ex.exceededBy)}${unit}.`,
          evidence: `Budget: ${ex.budget.threshold}${unit}\nActual: ${ex.actual}${unit}\nAll metrics: ${JSON.stringify(metrics)}`,
          suggestedFix: getPerfFix(ex.budget.metric),
        }));
      }
    } catch (err) {
      findings.push(ctx.createFinding({
        title: `Perf measurement failed on ${pageInfo.url}`,
        severity: 'low',
        confidence: 'high',
        category: 'performance',
        findingType: 'environmental',
        origin: 'first-party',
        ruleId: 'perf-measurement-error',
        pageUrl: pageInfo.url,
        description: err.message,
      }));
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`perf complete: ${findings.length} findings`);
  return { findings, stats: { pagesMeasured: pages.length, budgets: budgets.length } };
}

function getPerfFix(metric) {
  const fixes = {
    LCP: 'Optimize the largest above-the-fold element: preload hero images, reduce render-blocking JS, lazy-load below-the-fold.',
    CLS: 'Reserve space for ads/images with explicit width/height. Avoid injecting DOM above existing content.',
    TBT: 'Code-split long-running JS. Defer non-critical scripts. Use requestIdleCallback for low-priority work.',
    FCP: 'Reduce server response time (TTFB). Inline critical CSS. Eliminate render-blocking resources.',
    TTFB: 'Use a CDN. Optimize server-side rendering. Cache responses at the edge.',
    pageSizeBytes: 'Compress assets (Brotli/Gzip). Serve modern image formats (AVIF/WebP). Tree-shake JS.',
    requestCount: 'Bundle assets. Use HTTP/2 multiplexing. Inline small assets. Lazy-load below-the-fold.',
  };
  return fixes[metric] || 'Investigate the metric regression.';
}
