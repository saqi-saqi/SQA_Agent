/**
 * services/scheduler.js — monitoring loop (Rung 3).
 *
 * A 60-second setInterval that turns due monitors into runs:
 *   • For each enabled monitor past its interval → trigger
 *     runManager.createRunWithMatrix() stamped with monitoring metadata
 *     (monitorId, previousRunId for regression filtering, per-monitor webhook).
 *   • For monitors with a finished lastRunId, refresh lastScore/lastStatus
 *     so the dashboard's monitor list stays current.
 *
 * No cron/external process needed — lives inside the dashboard server.
 * Concurrency is already handled by runManager's queue (MAX_CONCURRENT_RUNS).
 */
import { config } from '../utils/config.js';
import { MonitorStore } from './monitors.js';

export class Scheduler {
  /**
   * @param {object} deps
   * @param {MonitorStore} deps.monitorStore
   * @param {(input: {url: string, options?: object}) => Promise<string>} deps.createRun
   *        — normally runManager.createRunWithMatrix
   * @param {(runId: string) => Promise<object|null>} deps.getRun
   * @param {(msg: string) => void} [deps.log]
   * @param {number} [deps.intervalMs] — tick interval (default from config)
   */
  constructor({ monitorStore, createRun, getRun, log = console.log, intervalMs } = {}) {
    if (!monitorStore) throw new Error('Scheduler requires monitorStore');
    if (!createRun) throw new Error('Scheduler requires createRun');
    if (!getRun) throw new Error('Scheduler requires getRun');
    this.monitorStore = monitorStore;
    this.createRun = createRun;
    this.getRun = getRun;
    this.log = log;
    this.intervalMs = intervalMs || config.schedulerIntervalMs || 60000;
    this.timer = null;
    this._ticking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(err => this.log(`Scheduler tick failed: ${err.message}`)), this.intervalMs);
    // Don't keep the process alive just for the scheduler
    if (this.timer.unref) this.timer.unref();
    this.log(`Scheduler started — checking monitors every ${Math.round(this.intervalMs / 1000)}s`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log('Scheduler stopped');
    }
  }

  /**
   * One scheduler pass: refresh states, then fire due monitors.
   * Exposed for tests — normally invoked by the interval.
   */
  async tick(now = Date.now()) {
    if (this._ticking) return { triggered: [], refreshed: [] };
    this._ticking = true;
    try {
      await this._refreshRunStates();
      const due = await this.monitorStore.dueMonitors(now);
      const triggered = [];
      for (const monitor of due) {
        const runId = await this._trigger(monitor).catch(err => {
          this.log(`Failed to trigger monitor ${monitor.id}: ${err.message}`);
          return null;
        });
        if (runId) triggered.push({ monitorId: monitor.id, runId });
      }
      return { triggered, refreshed: this._refreshedIds || [] };
    } finally {
      this._ticking = false;
    }
  }

  async _trigger(monitor) {
    return triggerMonitor(monitor, {
      monitorStore: this.monitorStore,
      createRun: this.createRun,
      log: this.log,
    });
  }

  /** Update lastScore/lastStatus for monitors whose lastRunId has finished. */
  async _refreshRunStates() {
    const monitors = await this.monitorStore.list();
    this._refreshedIds = [];
    for (const monitor of monitors) {
      if (!monitor.lastRunId) continue;
      if (monitor.lastStatus === 'completed' || monitor.lastStatus === 'failed') continue;
      const run = await this.getRun(monitor.lastRunId).catch(() => null);
      if (!run) continue;
      if (run.status === 'completed' || run.status === 'failed') {
        const patch = {
          lastStatus: run.status,
          lastScore: run.score ?? null,
          // Recorded-session health: flagged when a run lands on login pages
          // despite the session; cleared once a run reports it healthy again.
          sessionExpired: Boolean(run.sessionExpired),
        };
        await this.monitorStore.update(monitor.id, patch);
        this._refreshedIds.push(monitor.id);
      } else if (run.status !== monitor.lastStatus) {
        await this.monitorStore.update(monitor.id, { lastStatus: run.status });
      }
    }
  }
}

/**
 * Trigger a run for a monitor and stamp its state. Shared by the scheduler
 * tick and the "run now" API endpoint so both behave identically.
 *
 * @returns {Promise<string>} runId
 */
export async function triggerMonitor(monitor, { monitorStore, createRun, log = () => {} }) {
  const runId = await createRun({
    url: monitor.url,
    options: {
      ...monitor.options,
      monitorId: monitor.id,
      // The previous run (if any) is the regression baseline
      previousRunId: monitor.lastRunId || undefined,
      onlyNewFindings: monitor.onlyNewFindings !== false,
      ...(monitor.webhookUrl ? { webhookUrl: monitor.webhookUrl } : {}),
    },
  });
  log(`Monitor ${monitor.id} triggered → ${runId}`);
  await monitorStore.update(monitor.id, {
    lastRunAt: new Date().toISOString(),
    lastRunId: runId,
    lastStatus: 'queued',
    lastScore: null,
  });
  return runId;
}

/** Convenience factory used by the dashboard server. */
export function startScheduler({ monitorStore, createRun, getRun, log = console.log } = {}) {
  if (!config.schedulerEnabled) {
    log('Scheduler disabled (SQA_SCHEDULER_ENABLED=false)');
    return null;
  }
  const scheduler = new Scheduler({ monitorStore, createRun, getRun, log });
  scheduler.start();
  return scheduler;
}
