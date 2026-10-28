/**
 * storage/monitorStore.js — SQLite persistence for scheduled site monitors.
 *
 * Implements the MonitorStore interface with relational SQLite storage.
 */
import { getDatabase } from './db.js';
import { MonitorSchema, isDue } from '../services/monitors.js';

function safeParse(jsonStr, fallback = {}) {
  if (!jsonStr) return fallback;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return fallback;
  }
}

export class SqliteMonitorStore {
  constructor({ db = getDatabase() } = {}) {
    this.db = db;
  }

  _rowToMonitor(row) {
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      intervalHours: row.interval_hours,
      enabled: Boolean(row.enabled),
      onlyNewFindings: Boolean(row.only_new_findings),
      webhookUrl: row.webhook_url || '',
      options: safeParse(row.options_json, {}),
      lastRunAt: row.last_run_at || null,
      lastRunId: row.last_run_id || null,
      lastScore: row.last_score !== null ? row.last_score : null,
      lastStatus: row.last_status || null,
      sessionRecordedAt: row.session_recorded_at || null,
      sessionExpired: Boolean(row.session_expired),
    };
  }

  async list() {
    const rows = this.db.prepare('SELECT * FROM monitors ORDER BY created_at ASC').all();
    return rows.map(r => this._rowToMonitor(r));
  }

  async get(id) {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);
    return this._rowToMonitor(row);
  }

  async add(input) {
    const parsed = MonitorSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }

    const m = parsed.data;
    const existing = this.db.prepare('SELECT id FROM monitors WHERE id = ?').get(m.id);
    if (existing) {
      return { ok: false, error: `Monitor id already exists: ${m.id}` };
    }

    const stmt = this.db.prepare(`
      INSERT INTO monitors (
        id, label, url, interval_hours, enabled, only_new_findings,
        webhook_url, options_json, last_run_at, last_run_id, last_score,
        last_status, session_recorded_at, session_expired, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(
      m.id,
      m.label,
      m.url,
      m.intervalHours,
      m.enabled ? 1 : 0,
      m.onlyNewFindings ? 1 : 0,
      m.webhookUrl || '',
      JSON.stringify(m.options || {}),
      m.lastRunAt || null,
      m.lastRunId || null,
      m.lastScore !== undefined ? m.lastScore : null,
      m.lastStatus || null,
      input.sessionRecordedAt || null,
      input.sessionExpired ? 1 : 0
    );

    return { ok: true, monitor: m };
  }

  async remove(id) {
    const stmt = this.db.prepare('DELETE FROM monitors WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }

  async update(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;

    const merged = { ...current, ...patch };

    const stmt = this.db.prepare(`
      UPDATE monitors SET
        label = ?,
        url = ?,
        interval_hours = ?,
        enabled = ?,
        only_new_findings = ?,
        webhook_url = ?,
        options_json = ?,
        last_run_at = ?,
        last_run_id = ?,
        last_score = ?,
        last_status = ?,
        session_recorded_at = ?,
        session_expired = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(
      merged.label,
      merged.url,
      merged.intervalHours,
      merged.enabled ? 1 : 0,
      merged.onlyNewFindings ? 1 : 0,
      merged.webhookUrl || '',
      JSON.stringify(merged.options || {}),
      merged.lastRunAt || null,
      merged.lastRunId || null,
      merged.lastScore !== undefined ? merged.lastScore : null,
      merged.lastStatus || null,
      merged.sessionRecordedAt || null,
      merged.sessionExpired ? 1 : 0,
      id
    );

    return merged;
  }

  async dueMonitors(now = Date.now()) {
    const all = await this.list();
    return all.filter(m => isDue(m, now));
  }
}
