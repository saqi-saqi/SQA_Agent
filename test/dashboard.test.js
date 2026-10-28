import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrends } from '../dashboard/server.js';

const sampleRuns = [
  {
    runId: 'run_1',
    url: 'https://example.com',
    status: 'completed',
    startedAt: '2025-01-01T10:00:00Z',
    completedAt: '2025-01-01T10:01:00Z',
    score: 92,
    summary: {
      totalPages: 5,
      totalFindings: 3,
      bySeverity: { critical: 0, high: 1, medium: 1, low: 1, info: 0 },
      byCategory: { links: 2, network: 1 },
    },
  },
  {
    runId: 'run_2',
    url: 'https://example.com',
    status: 'completed',
    startedAt: '2025-01-01T11:00:00Z',
    completedAt: '2025-01-01T11:01:00Z',
    score: 78,
    summary: {
      totalPages: 5,
      totalFindings: 5,
      bySeverity: { critical: 1, high: 1, medium: 2, low: 1, info: 0 },
      byCategory: { links: 3, network: 2 },
    },
  },
  {
    runId: 'run_3',
    url: 'https://example.com',
    status: 'failed',
    startedAt: '2025-01-01T12:00:00Z',
    completedAt: '2025-01-01T12:00:30Z',
    score: null,
    summary: null,
  },
  {
    runId: 'run_4',
    url: 'https://example.com',
    status: 'completed',
    startedAt: '2025-01-01T13:00:00Z',
    completedAt: '2025-01-01T13:01:30Z',
    score: 85,
    summary: {
      totalPages: 5,
      totalFindings: 4,
      bySeverity: { critical: 0, high: 2, medium: 1, low: 1, info: 0 },
      byCategory: { links: 2, network: 1, accessibility: 1 },
    },
  },
];

describe('computeTrends', () => {
  it('counts total / completed / failed runs', () => {
    const t = computeTrends(sampleRuns);
    assert.equal(t.totalRuns, 4);
    assert.equal(t.completedRuns, 3);
    assert.equal(t.failedRuns, 1);
  });

  it('computes avgScore across completed runs with scores', () => {
    const t = computeTrends(sampleRuns);
    // (92 + 78 + 85) / 3 = 85
    assert.equal(t.avgScore, 85);
  });

  it('returns avgScore=null when no completed runs', () => {
    const t = computeTrends([]);
    assert.equal(t.avgScore, null);
    assert.equal(t.totalRuns, 0);
  });

  it('returns avgScore=null when completed runs have no scores', () => {
    const t = computeTrends([{ runId: 'x', status: 'completed', score: null, summary: null }]);
    assert.equal(t.avgScore, null);
  });

  it('caps scoreTrend at last 10 runs (oldest first for chart)', () => {
    const t = computeTrends(sampleRuns);
    assert.equal(t.scoreTrend.length, 3);  // only 3 completed runs
    // newest first → run_4 (score 85), run_2 (78), run_1 (92)
    assert.equal(t.scoreTrend[0].runId, 'run_4');
    assert.equal(t.scoreTrend[0].score, 85);
    assert.equal(t.scoreTrend[2].runId, 'run_1');
  });

  it('aggregates findings by severity across runs', () => {
    const t = computeTrends(sampleRuns);
    // run_1: 0/1/1/1/0 + run_2: 1/1/2/1/0 + run_4: 0/2/1/1/0 = 1/4/4/3/0
    assert.equal(t.findingsBySeverity.critical, 1);
    assert.equal(t.findingsBySeverity.high, 4);
    assert.equal(t.findingsBySeverity.medium, 4);
    assert.equal(t.findingsBySeverity.low, 3);
    assert.equal(t.findingsBySeverity.info, 0);
  });

  it('aggregates findings by category across runs', () => {
    const t = computeTrends(sampleRuns);
    // run_1: links=2, network=1; run_2: links=3, network=2; run_4: links=2, network=1, accessibility=1
    assert.equal(t.findingsByCategory.links, 7);
    assert.equal(t.findingsByCategory.network, 4);
    assert.equal(t.findingsByCategory.accessibility, 1);
  });

  it('handles runs with missing summary', () => {
    const runs = [
      { runId: 'r1', status: 'completed', score: 90, summary: null },
      { runId: 'r2', status: 'completed', score: 80,
        summary: { bySeverity: { critical: 1 }, byCategory: { links: 1 } } },
    ];
    const t = computeTrends(runs);
    assert.equal(t.avgScore, 85);
    assert.equal(t.findingsBySeverity.critical, 1);
    assert.equal(t.findingsByCategory.links, 1);
  });

  it('returns empty findings when no completed runs', () => {
    const t = computeTrends([{ runId: 'r1', status: 'failed' }]);
    assert.deepEqual(t.findingsBySeverity, { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
    assert.deepEqual(t.findingsByCategory, {});
  });

  it('always returns flakyTests array (Phase 6 will populate)', () => {
    const t = computeTrends(sampleRuns);
    assert.ok(Array.isArray(t.flakyTests));
    // Phase 4 returns empty array — Phase 6 will fill this in
    assert.equal(t.flakyTests.length, 0);
  });
});
