/**
 * storage/db.js — SQLite connection and standard relational schema.
 *
 * Designed with standard ANSI SQL data types (TEXT, REAL, INTEGER) so it
 * can seamlessly migrate to PostgreSQL/Supabase when scaling up.
 * Runs completely locally with zero cost and zero external infrastructure.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'testflow.sqlite');

let _dbInstance = null;

export const SCHEMA_SQL = `
-- Runs table: stores all execution outcomes, reports, and metadata
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT DEFAULT 'matrix',
  score REAL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  options_json TEXT,
  summary_json TEXT,
  findings_json TEXT,
  events_json TEXT,
  pages_json TEXT,
  plan_json TEXT,
  stats_json TEXT,
  workflow_results_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_runs_url ON runs(url);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);

-- Monitors table: scheduled continuous scanning configurations
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_hours REAL NOT NULL DEFAULT 24,
  enabled INTEGER NOT NULL DEFAULT 1,
  only_new_findings INTEGER NOT NULL DEFAULT 1,
  webhook_url TEXT,
  options_json TEXT,
  last_run_at TEXT,
  last_run_id TEXT,
  last_score REAL,
  last_status TEXT,
  session_recorded_at TEXT,
  session_expired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_monitors_enabled ON monitors(enabled);

-- Job Queue table: persistent, crash-resilient queue replacing in-memory arrays
CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  queue_name TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_priority ON job_queue(status, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_locked_at ON job_queue(locked_at);

-- Flaky history table: tracks non-deterministic test outcomes across runs
CREATE TABLE IF NOT EXISTS flaky_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  rule_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_flaky_url ON flaky_history(url);
`;

/**
 * Initialize schema on the provided database instance.
 */
export function initSchema(db) {
  db.exec(SCHEMA_SQL);
}

/**
 * Get or create the active SQLite database instance.
 * @param {string} [customPath] Custom database path (e.g. for testing)
 */
export function getDatabase(customPath) {
  if (customPath && customPath !== ':memory:') {
    const dir = path.dirname(customPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = new Database(customPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    return db;
  }

  if (customPath === ':memory:') {
    const memDb = new Database(':memory:');
    initSchema(memDb);
    return memDb;
  }

  if (!_dbInstance) {
    const dbPath = process.env.TESTFLOW_DB_PATH || process.env.SQA_DB_PATH || DEFAULT_DB_PATH;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    _dbInstance = new Database(dbPath);
    _dbInstance.pragma('journal_mode = WAL');
    _dbInstance.pragma('busy_timeout = 5000');
    _dbInstance.pragma('foreign_keys = ON');
    initSchema(_dbInstance);
  }

  return _dbInstance;
}

/**
 * Close database connection (e.g. on shutdown or after tests)
 */
export function closeDatabase(db) {
  const target = db || _dbInstance;
  if (target && target.open) {
    target.close();
  }
  if (!db || db === _dbInstance) {
    _dbInstance = null;
  }
}
