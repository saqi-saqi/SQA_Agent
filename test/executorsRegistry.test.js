import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerAllExecutors, REGISTRATIONS } from '../src/executors/index.js';
import {
  clearExecutors,
  listExecutors,
  hasExecutor,
  runExecutor,
} from '../src/services/executorRegistry.js';

describe('registerAllExecutors', () => {
  beforeEach(() => clearExecutors());
  afterEach(() => clearExecutors());

  it('registers all 7 executors with one call', () => {
    registerAllExecutors();
    const names = listExecutors().map(e => e.name);
    assert.equal(names.length, 7);
    for (const [name] of REGISTRATIONS) {
      assert.ok(hasExecutor(name), `expected ${name} to be registered`);
    }
  });

  it('registers each executor with description metadata', () => {
    registerAllExecutors();
    const list = listExecutors();
    assert.ok(list.every(e => typeof e.description === 'string' && e.description.length > 0));
  });

  it('is idempotent — calling twice does not throw', () => {
    registerAllExecutors();
    assert.doesNotThrow(() => registerAllExecutors());
    assert.equal(listExecutors().length, 7);
  });

  it('each executor returns { findings: [] } on empty plan', async () => {
    registerAllExecutors();
    const ctx = {
      plan: { pages: [], flows: [], apiEndpoints: [], fuzzTargets: [], a11yRules: [], perfBudgets: [], visualBaselines: [] },
      createFinding: () => ({ id: 'X-001' }),
      onEvent: () => {},
      signal: undefined,
      options: {},
      screenshotsDir: '/tmp',
      runId: 'run_test',
    };

    for (const [name] of REGISTRATIONS) {
      const result = await runExecutor(name, ctx);
      assert.ok(Array.isArray(result.findings), `${name} should return findings array`);
    }
  });

  it('browser-based executors skip gracefully when context is missing', async () => {
    registerAllExecutors();
    const ctx = {
      plan: {
        pages: [{ url: 'https://example.com' }],
        flows: [{ name: 'X', startUrl: 'https://example.com', steps: [] }],
        a11yRules: [{ rule: 'color-contrast' }],
        perfBudgets: [{ metric: 'LCP', threshold: 1000, severity: 'low' }],
        visualBaselines: [{ pageUrl: 'https://example.com', viewport: { width: 1280, height: 720 } }],
      },
      createFinding: () => ({ id: 'X-001' }),
      onEvent: () => {},
      signal: undefined,
      options: {},
      screenshotsDir: '/tmp',
      runId: 'run_test',
      // No `context` — should skip
    };

    for (const name of ['e2e', 'accessibility-deep', 'perf', 'visual']) {
      const result = await runExecutor(name, ctx);
      assert.equal(result.findings.length, 0, `${name} should return 0 findings without context`);
      assert.equal(result.stats.skipped, true, `${name} should report skipped:true`);
    }
  });
});
