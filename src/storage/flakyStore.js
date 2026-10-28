/**
 * storage/flakyStore.js — SQLite persistence for flaky test tracking.
 */
import { getDatabase } from './db.js';
import { buildRunSummary } from '../matrix/flakyTracker.js';

export class SqliteFlakyStore {
  constructor({ db = getDatabase() } = {}) {
    this.db = db;
  }

  /**
   * Record a run's ruleIds into flaky history.
   */
  async recordRun(run) {
    const summary = buildRunSummary(run);
    const ruleIds = Array.from(summary.ruleIds || []);

    const stmt = this.db.prepare(`
      INSERT INTO flaky_history (run_id, url, started_at, status, rule_ids_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        url = excluded.url,
        started_at = excluded.started_at,
        status = excluded.status,
        rule_ids_json = excluded.rule_ids_json
    `);

    stmt.run(
      summary.runId,
      summary.url,
      summary.startedAt || new Date().toISOString(),
      summary.status || 'completed',
      JSON.stringify(ruleIds)
    );
  }

  /**
   * Detect flaky tests across all stored runs in SQLite.
   */
  async detectFlakyTests() {
    const rows = this.db.prepare(`
      SELECT run_id, url, started_at, status, rule_ids_json
      FROM flaky_history
      ORDER BY started_at ASC
    `).all();

    const runs = rows.map(r => {
      let ruleIds = [];
      try {
        ruleIds = JSON.parse(r.rule_ids_json);
      } catch { /* empty */ }
      return {
        runId: r.run_id,
        url: r.url,
        startedAt: r.started_at,
        status: r.status,
        ruleIds: Array.isArray(ruleIds) ? ruleIds : [],
      };
    });

    const completed = runs.filter(r => r.status === 'completed');
    const byUrl = new Map();
    for (const run of completed) {
      if (!byUrl.has(run.url)) byUrl.set(run.url, []);
      byUrl.get(run.url).push(run);
    }

    const flaky = [];
    for (const [url, urlRuns] of byUrl) {
      if (urlRuns.length < 2) continue;

      const allRuleIds = new Set();
      for (const r of urlRuns) {
        for (const id of r.ruleIds) allRuleIds.add(id);
      }

      for (const ruleId of allRuleIds) {
        let passCount = 0;
        let failCount = 0;
        let lastFailedAt = null;

        for (const r of urlRuns) {
          if (r.ruleIds.includes(ruleId)) {
            failCount++;
            if (!lastFailedAt || new Date(r.startedAt) > new Date(lastFailedAt)) {
              lastFailedAt = r.startedAt;
            }
          } else {
            passCount++;
          }
        }

        if (passCount >= 1 && failCount >= 1) {
          flaky.push({
            ruleId,
            url,
            passCount,
            failCount,
            totalRuns: passCount + failCount,
            flakinessRatio: failCount / (passCount + failCount),
            lastFailedAt,
          });
        }
      }
    }

    return flaky;
  }
}
