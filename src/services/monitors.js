/**
 * services/monitors.js — persistent monitor configurations + due logic.
 *
 * A "monitor" is a site the agent watches on a schedule (Rung 3: nightly
 * monitoring for a few trusted clients). Monitors live in
 * `<dataDir>/monitors.json` so they survive restarts, and the scheduler
 * (scheduler.js) turns them into runs via runManager.
 *
 * Monitor shape:
 *   {
 *     id:              string  — short unique slug
 *     label:           string  — human name (client/site)
 *     url:             string  — site to scan
 *     options:         object  — run options (maxPages, maxDepth, executors…)
 *     intervalHours:   number  — how often to run (min 1)
 *     enabled:         boolean
 *     onlyNewFindings: boolean — file/publish only findings not present in the
 *                                previous completed run (regressions only)
 *     webhookUrl:      string  — optional per-monitor webhook override
 *     // state (managed by scheduler/runs):
 *     lastRunAt:       string|null — ISO timestamp of last triggered run
 *     lastRunId:       string|null
 *     lastScore:       number|null
 *     lastStatus:      string|null — 'completed' | 'failed' | 'running' | 'queued'
 *   }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const RUN_OPTIONS_SCHEMA = z.object({
  maxPages: z.number().int().min(1).max(100).optional(),
  maxDepth: z.number().int().min(0).max(5).optional(),
  browsers: z.array(z.string()).optional(),
  viewports: z.array(z.any()).optional(),
  executors: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  dedup: z.boolean().optional(),
}).strict();

export const MonitorSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  label: z.string().min(1).max(120),
  url: z.string().url(),
  options: RUN_OPTIONS_SCHEMA.default({}),
  intervalHours: z.number().min(1).max(24 * 30).default(24),
  enabled: z.boolean().default(true),
  onlyNewFindings: z.boolean().default(true),
  webhookUrl: z.string().url().optional().or(z.literal('')).default(''),

  // ─── state ───
  lastRunAt: z.string().nullable().default(null),
  lastRunId: z.string().nullable().default(null),
  lastScore: z.number().nullable().default(null),
  lastStatus: z.string().nullable().default(null),
});

// ─── pure helpers (unit-tested) ──────────────────────────────────────

/** True when the monitor should run at time `now` (ms epoch). */
export function isDue(monitor, now = Date.now()) {
  if (!monitor.enabled) return false;
  if (!monitor.lastRunAt) return true;
  const last = Date.parse(monitor.lastRunAt);
  if (Number.isNaN(last)) return true;
  return now - last >= monitor.intervalHours * 3600 * 1000;
}

/** Next time the monitor would run, as ISO (or null when never/disabled). */
export function nextRunAt(monitor) {
  if (!monitor.enabled) return null;
  if (!monitor.lastRunAt) return new Date().toISOString();
  const last = Date.parse(monitor.lastRunAt);
  if (Number.isNaN(last)) return new Date().toISOString();
  return new Date(last + monitor.intervalHours * 3600 * 1000).toISOString();
}

// ─── store ───────────────────────────────────────────────────────────

export class MonitorStore {
  constructor(dataDir = path.join(process.cwd(), 'data')) {
    this.filePath = path.join(dataDir, 'monitors.json');
    this._monitors = null;
  }

  async _load() {
    if (this._monitors) return this._monitors;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this._monitors = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Failed to read ${this.filePath}:`, err.message);
      }
      this._monitors = [];
    }
    return this._monitors;
  }

  async _save(monitors) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(monitors, null, 2));
    this._monitors = monitors;
  }

  async list() {
    return [...(await this._load())];
  }

  async get(id) {
    const monitors = await this._load();
    return monitors.find(m => m.id === id) || null;
  }

  /** Validate + add. Returns { ok, monitor } | { ok:false, error }. */
  async add(input) {
    const parsed = MonitorSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    const monitors = await this._load();
    if (monitors.some(m => m.id === parsed.data.id)) {
      return { ok: false, error: `Monitor id already exists: ${parsed.data.id}` };
    }
    monitors.push(parsed.data);
    await this._save(monitors);
    return { ok: true, monitor: parsed.data };
  }

  async remove(id) {
    const monitors = await this._load();
    const next = monitors.filter(m => m.id !== id);
    if (next.length === monitors.length) return false;
    await this._save(next);
    return true;
  }

  /** Merge a partial update (usually state fields) into a monitor. */
  async update(id, patch) {
    const monitors = await this._load();
    const idx = monitors.findIndex(m => m.id === id);
    if (idx === -1) return null;
    monitors[idx] = { ...monitors[idx], ...patch };
    await this._save(monitors);
    return monitors[idx];
  }

  async dueMonitors(now = Date.now()) {
    const monitors = await this._load();
    return monitors.filter(m => isDue(m, now));
  }
}
