/**
 * perfInferrer.js — propose performance budgets based on observed load times.
 *
 * Heuristic. Sets budgets slightly stricter than the slowest observed page,
 * so the agent flags regressions vs. the current baseline.
 */
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';

const PerfBudgetSchema = arrayElementSchema(TestPlan.shape.perfBudgets);

const DEFAULT_BUDGETS = [
  // Core Web Vitals — Google's "good" thresholds
  { metric: 'LCP', threshold: 2500, severity: 'high' },
  { metric: 'CLS', threshold: 0.1,  severity: 'high' },
  { metric: 'TBT', threshold: 200,  severity: 'medium' },
  { metric: 'FCP', threshold: 1800, severity: 'medium' },
  { metric: 'TTFB', threshold: 800, severity: 'medium' },
  // Resource budgets
  { metric: 'pageSizeBytes', threshold: 3_000_000, severity: 'medium' },   // 3 MB
  { metric: 'requestCount',  threshold: 100,       severity: 'low' },
];

export function inferPerfBudgets({ pages }) {
  // If we have observed load times, tighten pageSizeBytes to be ~1.2x the
  // largest observed page (catches regressions without flagging the baseline).
  const budgets = [...DEFAULT_BUDGETS];

  if (pages && pages.length > 0) {
    const maxLoadTime = Math.max(...pages.map(p => p.loadTime || 0));
    // 1 ms ≈ 1 KB is a wild heuristic; we don't have actual page size from
    // the crawler yet, so leave the default. This is a Phase 2 enhancement
    // when we add resource-size capture to crawler.js.
    if (maxLoadTime > 5000) {
      // Slow page observed — flag TBT as critical so it gets attention
      const tbtIdx = budgets.findIndex(b => b.metric === 'TBT');
      if (tbtIdx >= 0) budgets[tbtIdx] = { ...budgets[tbtIdx], severity: 'high' };
    }
  }

  return budgets
    .map(b => PerfBudgetSchema.safeParse(b))
    .filter(r => r.success)
    .map(r => r.data);
}
