import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planMatrix, summarizeMatrix, filterMatrix } from '../src/matrix/matrixPlanner.js';

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
  executors: ['api-contract', 'security', 'fuzz', 'e2e', 'accessibility-deep', 'perf', 'visual'],
  pages: [],
  flows: [
    { name: 'Login', startUrl: 'https://example.com/login', steps: [{ action: 'assertVisible', selector: 'main' }] },
    { name: 'Admin Login', startUrl: 'https://example.com/admin', steps: [{ action: 'assertVisible', selector: 'main' }] },
  ],
  apiEndpoints: [],
  fuzzTargets: [],
  a11yRules: [],
  perfBudgets: [],
  visualBaselines: [],
  generatedBy: 'test',
};

describe('planMatrix', () => {
  it('throws on null plan', () => {
    assert.throws(() => planMatrix(null), /requires a plan/i);
  });

  it('includes the "anon" role by default', () => {
    const cells = planMatrix({ ...samplePlan, flows: [] });
    const roles = new Set(cells.map(c => c.role));
    assert.ok(roles.has('anon'));
  });

  it('infers roles from auth flows', () => {
    const cells = planMatrix(samplePlan);
    const roles = new Set(cells.map(c => c.role));
    assert.ok(roles.has('anon'));
    assert.ok(roles.has('user'));      // from "Login"
    assert.ok(roles.has('admin'));      // from "Admin Login"
  });

  it('creates one no-browser cell per role for api-contract/security/fuzz', () => {
    const cells = planMatrix(samplePlan);
    const noBrowserCells = cells.filter(c => !c.needsBrowser);
    // 3 roles × 3 no-browser executors grouped → 3 cells
    assert.equal(noBrowserCells.length, 3);
    assert.ok(noBrowserCells.every(c => c.executors.includes('api-contract')));
    assert.ok(noBrowserCells.every(c => c.executors.includes('security')));
    assert.ok(noBrowserCells.every(c => c.executors.includes('fuzz')));
  });

  it('creates browser-only cells per (browser, role) for e2e', () => {
    const cells = planMatrix(samplePlan);
    const e2eCells = cells.filter(c => c.executors.includes('e2e'));
    // 2 browsers × 3 roles = 6
    assert.equal(e2eCells.length, 6);
    assert.ok(e2eCells.every(c => c.needsBrowser));
  });

  it('creates full-matrix cells per (browser, viewport, role) for a11y/perf/visual', () => {
    const cells = planMatrix(samplePlan);
    const fullCells = cells.filter(c => c.executors.includes('visual'));
    // 2 browsers × 2 viewports × 3 roles = 12
    assert.equal(fullCells.length, 12);
    assert.ok(fullCells.every(c => c.needsBrowser));
    assert.ok(fullCells.every(c => c.viewport !== null));
  });

  it('uses sensible defaults when plan omits browsers/viewports/executors', () => {
    const minimal = { ...samplePlan, browsers: [], viewports: [], executors: [] };
    const cells = planMatrix(minimal);
    // No executors → no cells
    assert.equal(cells.length, 0);
  });

  it('uses only chromium when browsers is empty', () => {
    const cells = planMatrix({ ...samplePlan, browsers: [], executors: ['e2e'] });
    const browsers = new Set(cells.map(c => c.browser));
    assert.ok(browsers.has('chromium'));
    assert.equal(browsers.size, 1);
  });

  it('accepts explicit roles override', () => {
    const cells = planMatrix(samplePlan, ['guest', 'member']);
    const roles = new Set(cells.map(c => c.role));
    assert.ok(roles.has('guest'));
    assert.ok(roles.has('member'));
    assert.equal(roles.size, 2);
  });
});

describe('summarizeMatrix', () => {
  it('counts cells by browser, viewport, role, executor', () => {
    const cells = planMatrix(samplePlan);
    const summary = summarizeMatrix(cells);

    assert.equal(summary.totalCells, cells.length);
    assert.ok(summary.byBrowser.chromium > 0);
    assert.ok(summary.byBrowser.firefox > 0);
    assert.ok(summary.byViewport.desktop > 0);
    assert.ok(summary.byViewport.mobile > 0);
    assert.ok(summary.byRole.anon > 0);
    assert.ok(summary.byExecutor.visual > 0);
    assert.ok(summary.browserCells > 0);
    assert.ok(summary.noBrowserCells > 0);
  });

  it('handles empty matrix', () => {
    const summary = summarizeMatrix([]);
    assert.equal(summary.totalCells, 0);
    assert.deepEqual(summary.byBrowser, {});
  });
});

describe('filterMatrix', () => {
  const cells = planMatrix(samplePlan);

  it('filters by browser', () => {
    const filtered = filterMatrix(cells, { browsers: ['chromium'] });
    assert.ok(filtered.every(c => c.browser === 'chromium' || c.browser === null));
  });

  it('filters by viewport name', () => {
    const filtered = filterMatrix(cells, { viewports: ['mobile'] });
    assert.ok(filtered.every(c => c.viewport?.name === 'mobile' || !c.viewport));
  });

  it('filters by role', () => {
    const filtered = filterMatrix(cells, { roles: ['admin'] });
    assert.ok(filtered.every(c => c.role === 'admin'));
  });

  it('filters by executor', () => {
    const filtered = filterMatrix(cells, { executors: ['visual'] });
    assert.ok(filtered.every(c => c.executors.includes('visual')));
  });

  it('returns all cells when filter is empty', () => {
    const filtered = filterMatrix(cells, {});
    assert.equal(filtered.length, cells.length);
  });
});
