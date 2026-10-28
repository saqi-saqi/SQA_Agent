import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runMatrix } from '../src/matrix/matrixRunner.js';
import {
  registerExecutor,
  clearExecutors,
} from '../src/services/executorRegistry.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── concurrency test setup ──────────────────────────────────────────

function makeSlowExecutor(delayMs, findingRuleId) {
  return async (ctx) => {
    const start = Date.now();
    await new Promise(r => setTimeout(r, delayMs));
    const finding = ctx.createFinding({
      title: `Slow executor finding`,
      severity: 'medium',
      confidence: 'confirmed',
      category: 'network',
      findingType: 'bug',
      origin: 'first-party',
      ruleId: findingRuleId,
      pageUrl: 'https://example.com',
    });
    return {
      findings: [finding],
      stats: { durationMs: Date.now() - start },
    };
  };
}

const samplePlan = {
  schemaVersion: 1,
  id: 'plan_concurrency',
  targetUrl: 'https://example.com',
  status: 'approved',
  browsers: ['chromium'],
  viewports: [{ width: 1280, height: 720, name: 'desktop' }],
  executors: ['test-exec'],
  pages: [],
  flows: [],
  apiEndpoints: [],
  fuzzTargets: [],
  a11yRules: [],
  perfBudgets: [],
  visualBaselines: [],
  generatedBy: 'test',
};

function makeCells(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `cell-${i}`,
    browser: null,
    viewport: null,
    role: 'anon',
    executors: ['test-exec'],
    needsBrowser: false,
  }));
}

describe('matrixRunner concurrency', () => {
  beforeEach(() => {
    clearExecutors();
    // Register a slow executor (50ms per cell)
    registerExecutor('test-exec', makeSlowExecutor(50, 'test-rule'));
  });
  afterEach(() => clearExecutors());

  it('runs cells sequentially when concurrency=1 (default)', async () => {
    const cells = makeCells(4);
    const start = Date.now();
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 1, dedup: false },
    });
    const elapsed = Date.now() - start;
    // 4 cells × 50ms = 200ms minimum (sequential)
    assert.ok(elapsed >= 180, `Expected ≥180ms, got ${elapsed}`);
    assert.ok(elapsed < 400, `Expected <400ms, got ${elapsed}`);
    assert.equal(result.findings.length, 4);  // dedup=false → 4 separate findings
    assert.equal(result.stats.concurrency, 1);
    assert.equal(result.stats.completedCells, 4);
  });

  it('runs cells in parallel when concurrency > 1', async () => {
    const cells = makeCells(4);
    const start = Date.now();
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 4, dedup: false },
    });
    const elapsed = Date.now() - start;
    // 4 cells in parallel × 50ms = ~50ms (much faster than 200ms sequential)
    assert.ok(elapsed < 150, `Expected <150ms with concurrency=4, got ${elapsed}`);
    assert.equal(result.findings.length, 4);  // dedup=false → 4 separate findings
    assert.equal(result.stats.concurrency, 4);
    assert.equal(result.stats.completedCells, 4);
  });

  it('dedups findings across parallel cells', async () => {
    const cells = makeCells(4);  // all 4 cells produce same ruleId 'test-rule'
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 4, dedup: true },
    });
    // All 4 cells produced findings with ruleId='test-rule' + same pageUrl → 1 merged finding
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'test-rule');
    assert.ok(result.findings[0].occurrences >= 4);
    assert.ok(result.findings[0].matrixCells.length >= 4);
  });

  it('does NOT dedup when dedup=false', async () => {
    const cells = makeCells(4);
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 4, dedup: false },
    });
    assert.equal(result.findings.length, 4);
  });

  it('handles concurrency > number of cells', async () => {
    const cells = makeCells(2);
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 10 },
    });
    assert.equal(result.stats.completedCells, 2);
    assert.equal(result.findings.length, 1);  // deduped
  });

  it('respects abort signal even with concurrency', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const cells = makeCells(4);
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: ctrl.signal,
      options: { concurrency: 4 },
    });
    assert.equal(result.stats.completedCells, 0);
  });

  it('handles cell errors without breaking other cells', async () => {
    clearExecutors();
    registerExecutor('test-exec', async (ctx) => {
      if (ctx.matrixCell.cellId === 'cell-1') {
        throw new Error('boom');
      }
      await new Promise(r => setTimeout(r, 20));
      return { findings: [], stats: {} };
    });

    const cells = makeCells(4);
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 4 },
    });

    // All 4 cells completed (executor errors are recorded per-executor, not as cell failures)
    assert.equal(result.stats.completedCells, 4);
    assert.equal(result.stats.failedCells, 0);

    // But cell-1's executor status should be 'error'
    const cell1Stat = result.stats.cells.find(c => c.cellId === 'cell-1');
    assert.ok(cell1Stat);
    const cell1ExecutorStat = cell1Stat.executors.find(e => e.name === 'test-exec');
    assert.equal(cell1ExecutorStat.status, 'error');
    assert.match(cell1ExecutorStat.error, /boom/);

    // The other 3 cells should have ok executors
    const otherCells = result.stats.cells.filter(c => c.cellId !== 'cell-1');
    assert.equal(otherCells.length, 3);
    for (const c of otherCells) {
      const execStat = c.executors.find(e => e.name === 'test-exec');
      assert.equal(execStat.status, 'ok');
    }
  });

  it('records totalDurationMs', async () => {
    const cells = makeCells(3);
    const result = await runMatrix({
      plan: samplePlan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 1 },
    });
    assert.ok(result.stats.totalDurationMs > 0);
    // Should be at least 3 × 50ms = 150ms
    assert.ok(result.stats.totalDurationMs >= 100);
  });
});
