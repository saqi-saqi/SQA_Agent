import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerExecutor,
  getExecutor,
  listExecutors,
  hasExecutor,
  unregisterExecutor,
  clearExecutors,
  runExecutor,
  runAllExecutors,
  wrapLegacyCheck,
} from '../src/services/executorRegistry.js';

describe('executorRegistry', () => {
  beforeEach(() => clearExecutors());
  afterEach(() => clearExecutors());

  it('registers and retrieves an executor', () => {
    const fn = async () => ({ findings: [] });
    registerExecutor('e2e', fn, { version: '0.1.0', description: 'Playwright E2E' });

    assert.equal(hasExecutor('e2e'), true);
    assert.equal(hasExecutor('missing'), false);
    assert.equal(getExecutor('e2e'), fn);
    assert.equal(listExecutors().length, 1);
    assert.equal(listExecutors()[0].name, 'e2e');
    assert.equal(listExecutors()[0].version, '0.1.0');
  });

  it('rejects empty name or non-function', () => {
    assert.throws(() => registerExecutor('', () => {}), /non-empty string/i);
    assert.throws(() => registerExecutor('bad', null), /must be a function/i);
  });

  it('refuses double registration', () => {
    registerExecutor('dup', async () => ({ findings: [] }));
    assert.throws(
      () => registerExecutor('dup', async () => ({ findings: [] })),
      /already registered/i,
    );
  });

  it('runs an executor and returns findings', async () => {
    registerExecutor('noop', async (ctx) => ({
      findings: [{ id: 'X-001', title: 'stub', severity: 'low', confidence: 'confirmed' }],
      stats: { pagesChecked: 3 },
    }));

    const result = await runExecutor('noop', { plan: { executors: [] } });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, 'X-001');
    assert.equal(result.stats.pagesChecked, 3);
  });

  it('throws on unknown executor', async () => {
    await assert.rejects(() => runExecutor('ghost', {}), /Unknown executor/i);
  });

  it('throws if executor returns malformed result', async () => {
    registerExecutor('bad', async () => ({ notFindings: true }));
    await assert.rejects(() => runExecutor('bad', {}), /did not return/i);
  });

  it('runAllExecutors runs sequentially and aggregates findings', async () => {
    const callOrder = [];
    registerExecutor('a', async (ctx) => {
      callOrder.push('a-start');
      await new Promise(r => setTimeout(r, 5));
      callOrder.push('a-end');
      return { findings: [{ id: 'A-001' }] };
    });
    registerExecutor('b', async (ctx) => {
      callOrder.push('b-start');
      await new Promise(r => setTimeout(r, 5));
      callOrder.push('b-end');
      return { findings: [{ id: 'B-001' }, { id: 'B-002' }] };
    });

    const ctx = { plan: { executors: ['a', 'b'] }, signal: undefined };
    const result = await runAllExecutors(ctx);

    assert.deepEqual(callOrder, ['a-start', 'a-end', 'b-start', 'b-end']);
    assert.equal(result.findings.length, 3);
    assert.equal(result.stats.length, 2);
    assert.equal(result.stats[0].name, 'a');
    assert.equal(result.stats[0].findingCount, 1);
    assert.equal(result.stats[1].name, 'b');
    assert.equal(result.stats[1].findingCount, 2);
  });

  it('runAllExecutors continues after a failing executor', async () => {
    registerExecutor('boom', async () => { throw new Error('kaboom'); });
    registerExecutor('ok', async () => ({ findings: [{ id: 'OK-001' }] }));

    const ctx = { plan: { executors: ['boom', 'ok'] }, signal: undefined };
    const result = await runAllExecutors(ctx);

    assert.equal(result.findings.length, 1);
    assert.equal(result.stats[0].error, 'kaboom');
    assert.equal(result.stats[1].findingCount, 1);
  });

  it('runAllExecutors honors abort signal', async () => {
    const controller = new AbortController();
    registerExecutor('a', async () => ({ findings: [{ id: 'A-001' }] }));
    registerExecutor('b', async () => ({ findings: [{ id: 'B-001' }] }));

    controller.abort();
    const ctx = { plan: { executors: ['a', 'b'] }, signal: controller.signal };
    const result = await runAllExecutors(ctx);

    assert.equal(result.findings.length, 0);
    assert.equal(result.stats[0].error, 'aborted');
  });

  it('unregister removes a specific executor', () => {
    registerExecutor('tmp', async () => ({ findings: [] }));
    assert.equal(hasExecutor('tmp'), true);
    unregisterExecutor('tmp');
    assert.equal(hasExecutor('tmp'), false);
  });

  it('wrapLegacyCheck adapts v1 check signature to executor', async () => {
    // Simulate a legacy check_* function with the v1 signature:
    //   checkFoo(pages, createFinding, onEvent, screenshotsDir, runId, signal)
    function legacyCheck(pages, createFinding, onEvent, screenshotsDir, runId, signal, ...extra) {
      onEvent?.('legacy-check-started');
      const finding = createFinding({
        title: 'stub',
        severity: 'low',
        category: 'links',
        pageUrl: pages[0]?.url,
      });
      return Promise.resolve([finding]);
    }

    wrapLegacyCheck('legacy-links', legacyCheck);
    assert.equal(hasExecutor('legacy-links'), true);

    const events = [];
    const createFinding = (opts) => ({ id: 'LEG-001', ...opts });
    const ctx = {
      pages: [{ url: 'https://example.com' }],
      createFinding,
      onEvent: (m) => events.push(m),
      screenshotsDir: '/tmp',
      runId: 'run_test',
      signal: undefined,
      options: {},
    };

    const result = await runExecutor('legacy-links', ctx);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].title, 'stub');
    assert.deepEqual(events, ['legacy-check-started']);
  });
});
