/**
 * matrix/flakyTracker.js — detect flaky tests across run history.
 *
 * A "flaky test" is one that:
 *   • Passes on some runs of the same target URL
 *   • Fails on others
 *   • Has no consistent pattern (i.e. not a regression — just non-deterministic)
 *
 * Strategy:
 *   1. Group runs by target URL
 *   2. For each ruleId observed in any run of that URL, count:
 *      - passCount: runs where the ruleId did NOT appear in findings
 *      - failCount: runs where the ruleId DID appear in findings
 *   3. If passCount >= 1 AND failCount >= 1 → flaky
 *   4. Compute a flakiness ratio = failCount / (passCount + failCount)
 *
 * The tracker persists findings summaries per run to a JSON file so it
 * doesn't need to re-read every historical run JSON. Phase 6 ships the
 * interface + a file-based implementation. Phase 6.5 could add SQLite
 * for faster queries on large histories.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_HISTORY_FILE = 'flaky-history.json';

/**
 * Build a per-run summary to persist for flaky tracking.
 * Just the fields we need: url, runId, startedAt, finding ruleIds.
 */
export function buildRunSummary(run) {
  return {
    runId: run.runId,
    url: run.url,
    startedAt: run.startedAt,
    status: run.status,
    ruleIds: new Set((run.findings || []).map(f => f.ruleId).filter(Boolean)),
  };
}

/**
 * FlakyTracker — persists + analyzes run history.
 *
 * Storage format (JSON):
 *   {
 *     runs: Array<{ runId, url, startedAt, status, ruleIds: string[] }>,
 *     updatedAt: ISO timestamp,
 *   }
 */
export class FlakyTracker {
  constructor({ dataDir = './data', historyFile = DEFAULT_HISTORY_FILE } = {}) {
    this.dataDir = dataDir;
    this.historyFile = path.join(dataDir, historyFile);
    this._cache = null;
  }

  async _load() {
    if (this._cache) return this._cache;
    if (!existsSync(this.historyFile)) {
      this._cache = { runs: [], updatedAt: null };
      return this._cache;
    }
    try {
      const text = await fs.readFile(this.historyFile, 'utf-8');
      this._cache = JSON.parse(text);
    } catch {
      this._cache = { runs: [], updatedAt: null };
    }
    return this._cache;
  }

  async _save() {
    if (!this._cache) return;
    this._cache.updatedAt = new Date().toISOString();
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.historyFile, JSON.stringify(this._cache, null, 2), 'utf-8');
  }

  /**
   * Record a completed run.
   * Idempotent — re-recording the same runId overwrites.
   */
  async recordRun(run) {
    const data = await this._load();
    const summary = buildRunSummary(run);
    // Convert Set to array for JSON serialization
    const record = {
      runId: summary.runId,
      url: summary.url,
      startedAt: summary.startedAt,
      status: summary.status,
      ruleIds: Array.from(summary.ruleIds),
    };

    // Replace if runId already exists
    const idx = data.runs.findIndex(r => r.runId === record.runId);
    if (idx >= 0) {
      data.runs[idx] = record;
    } else {
      data.runs.push(record);
    }

    // Sort by startedAt so we can analyze history in order
    data.runs.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

    await this._save();
  }

  /**
   * Compute flaky tests across all recorded runs.
   * Returns array of:
   *   { ruleId, url, passCount, failCount, flakinessRatio, lastFailedAt }
   */
  async detectFlakyTests() {
    const data = await this._load();

    // Group runs by URL
    const byUrl = new Map();
    for (const run of data.runs) {
      if (run.status !== 'completed') continue;  // skip failed runs
      if (!byUrl.has(run.url)) byUrl.set(run.url, []);
      byUrl.get(run.url).push(run);
    }

    const flaky = [];

    for (const [url, runs] of byUrl) {
      if (runs.length < 2) continue;  // need ≥2 runs to detect flakiness

      // For each ruleId observed in this URL's history, count pass/fail
      const allRuleIds = new Set();
      for (const r of runs) {
        for (const id of r.ruleIds) allRuleIds.add(id);
      }

      for (const ruleId of allRuleIds) {
        let passCount = 0;
        let failCount = 0;
        let lastFailedAt = null;

        for (const r of runs) {
          if (r.ruleIds.includes(ruleId)) {
            failCount++;
            if (!lastFailedAt || new Date(r.startedAt) > new Date(lastFailedAt)) {
              lastFailedAt = r.startedAt;
            }
          } else {
            passCount++;
          }
        }

        // Flaky: passed at least once AND failed at least once
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

    // Sort by flakiness ratio desc, then by failCount desc
    flaky.sort((a, b) => {
      if (b.flakinessRatio !== a.flakinessRatio) {
        return b.flakinessRatio - a.flakinessRatio;
      }
      return b.failCount - a.failCount;
    });

    return flaky;
  }

  /**
   * Get all recorded runs (for debugging / UI display).
   */
  async listRuns() {
    const data = await this._load();
    return data.runs;
  }

  /**
   * Clear all history. Used by tests + manual reset.
   */
  async clear() {
    this._cache = { runs: [], updatedAt: null };
    await this._save();
  }

  /**
   * Get stats about the history itself.
   */
  async stats() {
    const data = await this._load();
    return {
      totalRuns: data.runs.length,
      uniqueUrls: new Set(data.runs.map(r => r.url)).size,
      uniqueRuleIds: new Set(data.runs.flatMap(r => r.ruleIds)).size,
      updatedAt: data.updatedAt,
    };
  }
}

/**
 * Detect flaky tests from a list of runs (pure function — no file I/O).
 * Useful for the dashboard's trends view + unit testing.
 */
export function detectFlakyFromRuns(runs) {
  const completed = runs.filter(r => r.status === 'completed');

  // Group by URL
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
      for (const f of r.findings || []) {
        if (f.ruleId) allRuleIds.add(f.ruleId);
      }
    }

    for (const ruleId of allRuleIds) {
      let passCount = 0, failCount = 0, lastFailedAt = null;
      for (const r of urlRuns) {
        const hasFinding = (r.findings || []).some(f => f.ruleId === ruleId);
        if (hasFinding) {
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
          ruleId, url, passCount, failCount,
          totalRuns: passCount + failCount,
          flakinessRatio: failCount / (passCount + failCount),
          lastFailedAt,
        });
      }
    }
  }

  flaky.sort((a, b) => b.flakinessRatio - a.flakinessRatio);
  return flaky;
}
