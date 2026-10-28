import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, triggerMonitor } from '../src/services/scheduler.js';

/** In-memory MonitorStore double matching the store interface. */
class FakeStore {
  constructor(monitors = []) {
    this.monitors = structuredClone(monitors);
  }
  async list() { return structuredClone(this.monitors); }
  async get(id) { return this.monitors.find(m => m.id === id) || null; }
  async update(id, patch) {
    const idx = this.monitors.findIndex(m => m.id === id);
    if (idx === -1) return null;
    this.monitors[idx] = { ...this.monitors[idx], ...patch };
    return this.monitors[idx];
  }
  async dueMonitors(now) {
    const { isDue } = await import('../src/services/monitors.js');
    return this.monitors.filter(m => isDue(m, now));
  }
}

function makeScheduler(store, createdRuns = []) {
  return new Scheduler({
    monitorStore: store,
    createRun: async (input) => {
      createdRuns.push(input);
      return `run_${createdRuns.length}`;
    },
    getRun: async (runId) => store.runs?.[runId] || null,
    log: () => {},
    intervalMs: 60000,
  });
}

describe('Scheduler.tick', () => {
  let createdRuns;
  let store;
  let scheduler;

  beforeEach(() => {
    createdRuns = [];
  });

  it('triggers nothing when no monitors are due', async () => {
    const now = Date.now();
    store = new FakeStore([
      { id: 'a', enabled: true, intervalHours: 24, lastRunAt: new Date(now - 1000).toISOString(), lastRunId: 'old', lastStatus: 'completed' },
    ]);
    store.runs = {};
    scheduler = makeScheduler(store, createdRuns);
    const result = await scheduler.tick(now);
    assert.equal(result.triggered.length, 0);
    assert.equal(createdRuns.length, 0);
  });

  it('triggers a monitor that was never run', async () => {
    store = new FakeStore([
      { id: 'a', url: 'https://a.com', enabled: true, intervalHours: 24, lastRunAt: null, onlyNewFindings: true },
    ]);
    store.runs = {};
    scheduler = makeScheduler(store, createdRuns);
    const result = await scheduler.tick();
    assert.equal(result.triggered.length, 1);
    assert.equal(createdRuns.length, 1);
    assert.equal(createdRuns[0].url, 'https://a.com');
    assert.equal(createdRuns[0].options.monitorId, 'a');
  });

  it('skips disabled monitors', async () => {
    const now = Date.now();
    store = new FakeStore([
      { id: 'a', url: 'https://a.com', enabled: false, intervalHours: 1, lastRunAt: new Date(now - 100 * 3600 * 1000).toISOString() },
    ]);
    store.runs = {};
    scheduler = makeScheduler(store, createdRuns);
    const result = await scheduler.tick(now);
    assert.equal(result.triggered.length, 0);
  });

  it('passes previousRunId and webhook through to the run options', async () => {
    const now = Date.now();
    store = new FakeStore([
      {
        id: 'a', url: 'https://a.com', enabled: true, intervalHours: 1,
        lastRunAt: new Date(now - 5 * 3600 * 1000).toISOString(),
        lastRunId: 'run_prev', onlyNewFindings: true, webhookUrl: 'https://hooks.example/x',
        options: { maxPages: 3 },
      },
    ]);
    store.runs = {};
    scheduler = makeScheduler(store, createdRuns);
    await scheduler.tick(now);
    assert.equal(createdRuns[0].options.previousRunId, 'run_prev');
    assert.equal(createdRuns[0].options.webhookUrl, 'https://hooks.example/x');
    assert.equal(createdRuns[0].options.maxPages, 3);
  });

  it('stamps lastRunAt/lastRunId after triggering', async () => {
    store = new FakeStore([
      { id: 'a', url: 'https://a.com', enabled: true, intervalHours: 24, lastRunAt: null },
    ]);
    store.runs = {};
    scheduler = makeScheduler(store, createdRuns);
    await scheduler.tick();
    const monitor = await store.get('a');
    assert.equal(monitor.lastRunId, 'run_1');
    assert.ok(monitor.lastRunAt);
    assert.equal(monitor.lastStatus, 'queued');
  });

  it('refreshes lastScore/lastStatus from a finished run', async () => {
    const now = Date.now();
    store = new FakeStore([
      { id: 'a', enabled: true, intervalHours: 24, lastRunAt: new Date(now - 1000).toISOString(), lastRunId: 'run_x', lastStatus: 'running' },
    ]);
    store.runs = { run_x: { status: 'completed', score: 92 } };
    scheduler = makeScheduler(store, createdRuns);
    await scheduler.tick(now);
    const monitor = await store.get('a');
    assert.equal(monitor.lastStatus, 'completed');
    assert.equal(monitor.lastScore, 92);
  });
});

describe('triggerMonitor', () => {
  it('creates a run with monitoring metadata and updates state', async () => {
    const created = [];
    const store = new FakeStore([
      { id: 'm1', url: 'https://m.com', enabled: true, intervalHours: 24, lastRunAt: null, lastRunId: null },
    ]);
    const runId = await triggerMonitor(await store.get('m1'), {
      monitorStore: store,
      createRun: async (input) => { created.push(input); return 'run_new'; },
    });
    assert.equal(runId, 'run_new');
    assert.equal(created[0].options.monitorId, 'm1');
    const monitor = await store.get('m1');
    assert.equal(monitor.lastRunId, 'run_new');
    assert.equal(monitor.lastStatus, 'queued');
  });
});
