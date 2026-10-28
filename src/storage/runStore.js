/**
 * storage/runStore.js — SQLite persistence for test execution runs.
 *
 * Handles run saving, retrieval, listing, and cleanup using standard SQL.
 */
import { getDatabase } from './db.js';

function safeParse(jsonStr, fallback = null) {
  if (!jsonStr) return fallback;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return fallback;
  }
}

/**
 * Convert a database row to a domain run object.
 */
export function rowToRun(row) {
  if (!row) return null;
  const metadata = safeParse(row.metadata_json, {});
  return {
    runId: row.id,
    url: row.url,
    status: row.status,
    mode: row.mode || 'matrix',
    score: row.score,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    options: safeParse(row.options_json, {}),
    summary: safeParse(row.summary_json, null),
    findings: safeParse(row.findings_json, []),
    events: safeParse(row.events_json, []),
    pages: safeParse(row.pages_json, []),
    plan: safeParse(row.plan_json, null),
    matrixStats: safeParse(row.stats_json, null),
    workflowResults: safeParse(row.workflow_results_json, []),
    trackerStats: metadata.trackerStats || null,
    ...metadata,
  };
}

/**
 * Save or update a run in the SQLite database.
 * @param {object} run Domain run object
 * @param {object} [db] Optional database instance (uses default if omitted)
 */
export function saveRun(run, db = getDatabase()) {
  if (!run || !run.runId) {
    throw new Error('Run object must have a valid runId');
  }

  const {
    runId,
    url,
    status = 'queued',
    mode = 'matrix',
    score = null,
    startedAt = new Date().toISOString(),
    completedAt = null,
    error = null,
    options = {},
    summary = null,
    findings = [],
    events = [],
    pages = [],
    plan = null,
    preApprovedPlan = null,
    matrixStats = null,
    workflowResults = [],
    trackerStats = null,
    ...rest
  } = run;

  const metadata = { ...rest };
  if (trackerStats) metadata.trackerStats = trackerStats;

  const stmt = db.prepare(`
    INSERT INTO runs (
      id, url, status, mode, score, started_at, completed_at, error,
      options_json, summary_json, findings_json, events_json,
      pages_json, plan_json, stats_json, workflow_results_json,
      metadata_json, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      status = excluded.status,
      mode = excluded.mode,
      score = excluded.score,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      error = excluded.error,
      options_json = excluded.options_json,
      summary_json = excluded.summary_json,
      findings_json = excluded.findings_json,
      events_json = excluded.events_json,
      pages_json = excluded.pages_json,
      plan_json = excluded.plan_json,
      stats_json = excluded.stats_json,
      workflow_results_json = excluded.workflow_results_json,
      metadata_json = excluded.metadata_json,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    runId,
    url || '',
    status,
    mode,
    score !== undefined ? score : null,
    startedAt,
    completedAt,
    error,
    JSON.stringify(options || {}),
    summary ? JSON.stringify(summary) : null,
    JSON.stringify(findings || []),
    JSON.stringify(events || []),
    JSON.stringify(pages || []),
    JSON.stringify(plan || preApprovedPlan || null),
    matrixStats ? JSON.stringify(matrixStats) : null,
    JSON.stringify(workflowResults || []),
    JSON.stringify(metadata)
  );

  return run;
}

/**
 * Retrieve a full run object by its runId.
 */
export function getRun(runId, db = getDatabase()) {
  const stmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const row = stmt.get(runId);
  return rowToRun(row);
}

/**
 * List runs, returning summaries sorted by started_at DESC.
 */
export function listRuns({ db = getDatabase(), limit = 100, offset = 0, status, url } = {}) {
  let query = 'SELECT id, url, status, mode, score, started_at, completed_at, summary_json, error FROM runs';
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (url) {
    conditions.push('url = ?');
    params.push(url);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);

  return rows.map(row => ({
    runId: row.id,
    url: row.url,
    status: row.status,
    mode: row.mode || 'matrix',
    startedAt: row.started_at,
    completedAt: row.completed_at,
    score: row.score,
    summary: safeParse(row.summary_json, null),
    error: row.error,
  }));
}

/**
 * Delete a run from SQLite.
 */
export function deleteRun(runId, db = getDatabase()) {
  const stmt = db.prepare('DELETE FROM runs WHERE id = ?');
  const info = stmt.run(runId);
  return info.changes > 0;
}

/**
 * Clean up runs older than maxAgeMs.
 */
export function cleanupOldRuns(maxAgeMs = 24 * 60 * 60 * 1000, db = getDatabase()) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stmt = db.prepare('DELETE FROM runs WHERE started_at < ?');
  const info = stmt.run(cutoff);
  return info.changes;
}
