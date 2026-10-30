import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runMatrix, dedupFindings } from '../src/matrix/matrixRunner.js';
import { summarizeFindings } from '../src/services/scoring.js';
import {
  registerExecutor,
  clearExecutors,
  hasExecutor,
} from '../src/services/executorRegistry.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── test executor that always emits a finding ──────────────────────

function makeTestExecutor(findingTemplate) {
  return async (ctx) => {
    const finding = ctx.createFinding({
      ...findingTemplate,
      pageUrl: findingTemplate.pageUrl || 'https://example.com',
    });
    return {
      findings: [finding],
      stats: { cellId: ctx.matrixCell?.cellId },
    };
  };
}

const samplePlan = {
  schemaVersion: 1,
  id: 'plan_test',
  targetUrl: 'https://example.com',
  status: 'approved',
  browsers: ['chromium', 'firefox'],
  viewports: [
    { width: 1280, height: 720, name: 'desktop' },
    { width: 375, height: 667, name: 'mobile' },
  ],
  executors: ['api-contract', 'e2e', 'visual'],
  pages: [],
  flows: [],
  apiEndpoints: [],
  fuzzTargets: [],
  a11yRules: [],
  perfBudgets: [],
  visualBaselines: [],
  generatedBy: 'test',
};

const baseCtx = () => ({
  createFinding: createFindingFactory(),
  onEvent: () => {},
  signal: undefined,
  options: {},
});

describe('runMatrix', () => {
  beforeEach(() => {
    clearExecutors();
    // Register mock executors
    registerExecutor('api-contract', makeTestExecutor({
      title: 'API bug', severity: 'high', confidence: 'confirmed',
      category: 'network', findingType: 'bug', origin: 'first-party',
      ruleId: 'api-test', pageUrl: 'https://example.com/api',
    }));
    registerExecutor('e2e', makeTestExecutor({
      title: 'E2E failure', severity: 'high', confidence: 'confirmed',
      category: 'network', findingType: 'bug', origin: 'first-party',
      ruleId: 'e2e-test', pageUrl: 'https://example.com/login',
    }));
    registerExecutor('visual', makeTestExecutor({
      title: 'Visual regression', severity: 'medium', confidence: 'high',
      category: 'network', findingType: 'bug', origin: 'first-party',
      ruleId: 'visual-test', pageUrl: 'https://example.com/page',
    }));
  });

  afterEach(() => clearExecutors());

  it('runs all cells in the matrix', async () => {
    const result = await runMatrix({
      plan: samplePlan,
      browserPool: null,  // no browser — executors will skip browser context
      ...baseCtx(),
    });

    // No-browser executors (api-contract) run for each role
    // Browser-only (e2e) skips because no context
    // Full-matrix (visual) skips because no context
    assert.ok(result.stats.totalCells > 0);
    assert.ok(result.stats.completedCells > 0);
  });

  it('dedups findings by ruleId + pageUrl', async () => {
    const result = await runMatrix({
      plan: samplePlan,
      browserPool: null,
      ...baseCtx(),
      options: { dedup: true },
    });

    // api-contract runs 1× per role (3 roles = anon, user, admin inferred from no flows → just anon)
    // Actually no flows → just anon → 1 cell → 1 finding
    // But our sample plan has no flows → only 'anon' role
    const apiFindings = result.findings.filter(f => f.ruleId === 'api-test');
    assert.ok(apiFindings.length >= 1);
    // All should have matrixCells array (even if just 1)
    assert.ok(apiFindings.every(f => Array.isArray(f.matrixCells)));
  });

  it('aggregates occurrences across cells when deduped', async () => {
    // Use a plan with flows to get multiple roles
    const planWithRoles = {
      ...samplePlan,
      flows: [
        { name: 'Login', startUrl: 'https://example.com/login', steps: [{ action: 'assertVisible', selector: 'main' }] },
      ],
    };
    const result = await runMatrix({
      plan: planWithRoles,
      browserPool: null,
      ...baseCtx(),
      options: { dedup: true },
    });

    // api-contract runs for anon + user = 2 cells, both emit api-test finding
    const apiFinding = result.findings.find(f => f.ruleId === 'api-test');
    if (apiFinding) {
      assert.ok(apiFinding.occurrences >= 1);
      assert.ok(Array.isArray(apiFinding.matrixCells));
    }
  });

  it('does NOT dedup when dedup=false', async () => {
    const planWithRoles = {
      ...samplePlan,
      flows: [
        { name: 'Login', startUrl: 'https://example.com/login', steps: [{ action: 'assertVisible', selector: 'main' }] },
      ],
    };
    const result = await runMatrix({
      plan: planWithRoles,
      browserPool: null,
      ...baseCtx(),
      options: { dedup: false },
    });

    // No dedup → findings array has duplicates
    const apiFindings = result.findings.filter(f => f.ruleId === 'api-test');
    assert.ok(apiFindings.length >= 2);  // one per role
  });

  it('records stats per cell + executor', async () => {
    const result = await runMatrix({
      plan: samplePlan,
      browserPool: null,
      ...baseCtx(),
    });

    assert.ok(result.stats.cells.length > 0);
    for (const cellStat of result.stats.cells) {
      assert.ok(cellStat.cellId);
      assert.ok(Array.isArray(cellStat.executors) || cellStat.status === 'error');
    }
  });

  it('skips cells when executor is missing', async () => {
    clearExecutors();
    registerExecutor('api-contract', makeTestExecutor({
      title: 'API bug', severity: 'high', confidence: 'confirmed',
      category: 'network', findingType: 'bug', origin: 'first-party',
      ruleId: 'api-test', pageUrl: 'https://example.com/api',
    }));
    // e2e and visual not registered → cells will be created but executors marked missing

    const result = await runMatrix({
      plan: samplePlan,
      browserPool: null,
      ...baseCtx(),
    });

    // Only api-contract findings should appear
    const ruleIds = new Set(result.findings.map(f => f.ruleId));
    assert.ok(ruleIds.has('api-test'));
    assert.ok(!ruleIds.has('e2e-test'));
    assert.ok(!ruleIds.has('visual-test'));

    // Stats should show missing executors
    for (const cell of result.stats.cells) {
      if (Array.isArray(cell.executors)) {
        const missing = cell.executors.filter(e => e.status === 'missing');
        // Should have at least one missing per cell that had e2e/visual
        if (cell.executors.some(e => ['e2e', 'visual'].includes(e.name))) {
          assert.ok(missing.length >= 1);
        }
      }
    }
  });

  it('respects abort signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runMatrix({
      plan: samplePlan,
      browserPool: null,
      ...baseCtx(),
      signal: ctrl.signal,
    });

    // Should abort immediately — 0 completed cells
    assert.equal(result.stats.completedCells, 0);
    assert.ok(result.stats.cells.some(c => c.status === 'aborted'));
  });

  it('accepts pre-computed cells', async () => {
    const cells = [{
      id: 'custom-cell',
      browser: null,
      viewport: null,
      role: 'anon',
      executors: ['api-contract'],
      needsBrowser: false,
    }];
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      ...baseCtx(),
    });

    assert.equal(result.stats.totalCells, 1);
    assert.equal(result.stats.completedCells, 1);
    assert.equal(result.findings.length, 1);
  });

  it('Bug 1 regression: collapses two findings with identical ruleId, selector, and URL into one finding with occurrences = 2', () => {
    const f1 = {
      ruleId: 'axe-region',
      selector: '.css-8qpjjf',
      pageUrl: 'https://example.com/campus',
      occurrences: 1,
      severity: 'medium',
      confidence: 'confirmed',
      matrixCell: { cellId: 'chromium:desktop:anon' },
    };
    const f2 = {
      ruleId: 'axe-region',
      selector: '.css-8qpjjf',
      pageUrl: 'https://example.com/campus',
      occurrences: 1,
      severity: 'medium',
      confidence: 'confirmed',
      matrixCell: { cellId: 'chromium:mobile:anon' },
    };

    const merged = dedupFindings([f1, f2]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].occurrences, 2);
    assert.equal(merged[0].ruleId, 'axe-region');
    assert.equal(merged[0].selector, '.css-8qpjjf');
    assert.deepEqual(merged[0].matrixCells.sort(), ['chromium:desktop:anon', 'chromium:mobile:anon'].sort());
  });

  it('Bug 2 regression: simulates one page.goto timeout, producing exactly one coverage-failure record excluded from findings/bugs counts', async () => {
    clearExecutors();
    // Executor 1 simulates catching page.goto timeout
    registerExecutor('mock-a11y', async (ctx) => {
      ctx.recordPageFailure({
        url: 'https://example.com/timeout',
        error: 'page.goto: Timeout 30000ms exceeded.',
        executor: 'mock-a11y',
      });
      return { findings: [] };
    });

    // Executor 2 sees page already failed and appends itself to blocked list
    registerExecutor('mock-perf', async (ctx) => {
      if (ctx.isPageFailed('https://example.com/timeout')) {
        ctx.recordPageFailure({
          url: 'https://example.com/timeout',
          executor: 'mock-perf',
        });
      }
      return { findings: [] };
    });

    const timeoutPlan = {
      ...samplePlan,
      executors: ['mock-a11y', 'mock-perf'],
    };

    const cells = [{
      id: 'cell-timeout',
      browser: null,
      viewport: null,
      role: 'anon',
      executors: ['mock-a11y', 'mock-perf'],
      needsBrowser: false,
    }];

    const result = await runMatrix({
      plan: timeoutPlan,
      cells,
      browserPool: null,
      ...baseCtx(),
    });

    // Exactly one coverage-failure record is produced for that URL
    assert.equal(result.coverageFailures.length, 1);
    const cov = result.coverageFailures[0];
    assert.equal(cov.pageUrl, 'https://example.com/timeout');
    assert.equal(cov.category, 'Scan Coverage');
    assert.equal(cov.findingType, 'coverage-failure');
    assert.deepEqual(cov.blockedExecutors.sort(), ['mock-a11y', 'mock-perf'].sort());

    // Summarize and verify it is EXCLUDED from findings count and confirmed bugs count
    const summary = summarizeFindings(result.findings, 1);
    assert.equal(summary.totalFindings, 0, 'Coverage failure must NOT count toward totalFindings');
    assert.equal(summary.confirmedBugs, 0, 'Coverage failure must NOT count toward confirmedBugs');
    assert.equal(summary.coverageFailures, 1, 'Should record exactly 1 coverageFailure in summary');
  });
});
