import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase, closeDatabase, initSchema } from '../src/storage/db.js';
import { saveRun, getRun, listRuns, deleteRun, cleanupOldRuns } from '../src/storage/runStore.js';
import { SqliteMonitorStore } from '../src/storage/monitorStore.js';
import { SqliteFlakyStore } from '../src/storage/flakyStore.js';

describe('SQLite Storage Layer', () => {
  let db;

  beforeEach(() => {
    db = getDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('runStore', () => {
    const sampleRun = {
      runId: 'run_test_001',
      url: 'https://example.com/checkout',
      status: 'completed',
      mode: 'matrix',
      score: 95.5,
      startedAt: '2026-01-01T10:00:00.000Z',
      completedAt: '2026-01-01T10:02:00.000Z',
      error: null,
      options: { maxPages: 5, browsers: ['chromium', 'firefox'], concurrency: 2 },
      summary: { totalPages: 5, totalFindings: 1, bySeverity: { critical: 0, high: 1 } },
      findings: [
        {
          ruleId: 'a11y-img-alt',
          title: 'Missing image alt',
          severity: 'high',
          confidence: 'confirmed',
          pageUrl: 'https://example.com/checkout',
        },
      ],
      events: [{ message: 'Started', timestamp: '2026-01-01T10:00:00.000Z' }],
      pages: [{ url: 'https://example.com/checkout', status: 200 }],
      plan: { version: '1.0', flows: [] },
      matrixStats: { totalCells: 4, completedCells: 4 },
      workflowResults: [{ name: 'checkout-flow', passed: true }],
      trackerStats: { filed: 1, updated: 0 },
    };

    it('saves and retrieves a complete run object', () => {
      saveRun(sampleRun, db);
      const retrieved = getRun('run_test_001', db);

      assert.ok(retrieved);
      assert.equal(retrieved.runId, sampleRun.runId);
      assert.equal(retrieved.url, sampleRun.url);
      assert.equal(retrieved.status, 'completed');
      assert.equal(retrieved.score, 95.5);
      assert.deepEqual(retrieved.options, sampleRun.options);
      assert.deepEqual(retrieved.summary, sampleRun.summary);
      assert.equal(retrieved.findings.length, 1);
      assert.equal(retrieved.findings[0].ruleId, 'a11y-img-alt');
      assert.equal(retrieved.events.length, 1);
      assert.equal(retrieved.pages.length, 1);
      assert.deepEqual(retrieved.plan, sampleRun.plan);
      assert.deepEqual(retrieved.matrixStats, sampleRun.matrixStats);
      assert.deepEqual(retrieved.workflowResults, sampleRun.workflowResults);
      assert.deepEqual(retrieved.trackerStats, sampleRun.trackerStats);
    });

    it('updates existing run on conflict', () => {
      saveRun(sampleRun, db);
      const updated = {
        ...sampleRun,
        status: 'failed',
        error: 'Network timeout',
        score: 0,
      };
      saveRun(updated, db);

      const retrieved = getRun('run_test_001', db);
      assert.equal(retrieved.status, 'failed');
      assert.equal(retrieved.error, 'Network timeout');
      assert.equal(retrieved.score, 0);
    });

    it('lists runs with pagination and filtering', () => {
      saveRun({ ...sampleRun, runId: 'r1', startedAt: '2026-01-01T10:00:00.000Z', status: 'completed' }, db);
      saveRun({ ...sampleRun, runId: 'r2', startedAt: '2026-01-01T11:00:00.000Z', status: 'failed', url: 'https://other.com' }, db);
      saveRun({ ...sampleRun, runId: 'r3', startedAt: '2026-01-01T12:00:00.000Z', status: 'completed' }, db);

      const all = listRuns({ db });
      assert.equal(all.length, 3);
      assert.equal(all[0].runId, 'r3'); // Sorted DESC

      const filteredStatus = listRuns({ db, status: 'failed' });
      assert.equal(filteredStatus.length, 1);
      assert.equal(filteredStatus[0].runId, 'r2');

      const filteredUrl = listRuns({ db, url: 'https://other.com' });
      assert.equal(filteredUrl.length, 1);
      assert.equal(filteredUrl[0].runId, 'r2');

      const paginated = listRuns({ db, limit: 2, offset: 1 });
      assert.equal(paginated.length, 2);
      assert.equal(paginated[0].runId, 'r2');
      assert.equal(paginated[1].runId, 'r1');
    });

    it('deletes a run', () => {
      saveRun(sampleRun, db);
      assert.ok(getRun('run_test_001', db));
      const deleted = deleteRun('run_test_001', db);
      assert.equal(deleted, true);
      assert.equal(getRun('run_test_001', db), null);
    });

    it('cleans up old runs past maxAgeMs', () => {
      const oldTime = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const newTime = new Date().toISOString();

      saveRun({ ...sampleRun, runId: 'old_run', startedAt: oldTime }, db);
      saveRun({ ...sampleRun, runId: 'new_run', startedAt: newTime }, db);

      const cleaned = cleanupOldRuns(24 * 3600 * 1000, db);
      assert.equal(cleaned, 1);
      assert.equal(getRun('old_run', db), null);
      assert.ok(getRun('new_run', db));
    });
  });

  describe('SqliteMonitorStore', () => {
    it('adds, gets, updates, and removes monitors', async () => {
      const store = new SqliteMonitorStore({ db });

      const res = await store.add({
        id: 'monitor-alpha',
        label: 'Alpha Site',
        url: 'https://alpha.example.com',
        intervalHours: 12,
        options: { maxPages: 3 },
      });

      assert.equal(res.ok, true);
      assert.equal(res.monitor.id, 'monitor-alpha');

      // Duplicate rejection
      const dup = await store.add({
        id: 'monitor-alpha',
        label: 'Alpha 2',
        url: 'https://alpha2.example.com',
      });
      assert.equal(dup.ok, false);

      // List & Get
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'monitor-alpha');

      const fetched = await store.get('monitor-alpha');
      assert.equal(fetched.label, 'Alpha Site');

      // Update
      const updated = await store.update('monitor-alpha', {
        lastScore: 88,
        lastStatus: 'completed',
        lastRunAt: new Date().toISOString(),
      });
      assert.equal(updated.lastScore, 88);
      assert.equal(updated.lastStatus, 'completed');

      // Due check
      const due = await store.dueMonitors(Date.now() + 24 * 3600 * 1000);
      assert.equal(due.length, 1);

      // Remove
      const removed = await store.remove('monitor-alpha');
      assert.equal(removed, true);
      assert.equal((await store.list()).length, 0);
    });
  });

  describe('SqliteFlakyStore', () => {
    it('records runs and detects flaky tests across history', async () => {
      const store = new SqliteFlakyStore({ db });

      const run1 = {
        runId: 'r1',
        url: 'https://example.com',
        startedAt: '2026-01-01T00:00:00Z',
        status: 'completed',
        findings: [{ ruleId: 'flaky-link', severity: 'high', confidence: 'confirmed' }],
      };
      const run2 = {
        runId: 'r2',
        url: 'https://example.com',
        startedAt: '2026-01-02T00:00:00Z',
        status: 'completed',
        findings: [], // passed!
      };

      await store.recordRun(run1);
      await store.recordRun(run2);

      const flaky = await store.detectFlakyTests();
      assert.equal(flaky.length, 1);
      assert.equal(flaky[0].ruleId, 'flaky-link');
      assert.equal(flaky[0].url, 'https://example.com');
      assert.equal(flaky[0].passCount, 1);
      assert.equal(flaky[0].failCount, 1);
      assert.equal(flaky[0].flakinessRatio, 0.5);
    });
  });
});
