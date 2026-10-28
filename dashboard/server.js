/**
 * dashboard/server.js — lightweight HTTP dashboard for the SQA agent.
 *
 * Reads run JSON files from the runManager's data dir and serves:
 *   • Static HTML/CSS/JS at /            → dashboard UI
 *   • GET  /api/runs                     → list of runs (metadata only)
 *   • GET  /api/runs/:runId              → full run details + findings
 *   • GET  /api/runs/:runId/events       → SSE stream of run events
 *   • GET  /api/runs/:runId/report.json  → machine-readable report
 *   • GET  /api/runs/:runId/report.html  → human-readable HTML report
 *   • GET  /api/trends                    → aggregate stats across recent runs
 *   • GET  /api/runs/:runId/screenshots/:file  → screenshot PNG
 *
 * No external deps — uses Node's built-in http + fs. Designed to integrate
 * with the existing runManager without changes.
 *
 * Note: runManager + report modules are lazy-imported inside handlers so
 * the dashboard test suite can import computeTrends() without requiring
 * the user's checks/* modules (which runManager.js imports at top-level).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(process.cwd(), 'data');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

const DEFAULT_PORT = Number(process.env.SQA_DASHBOARD_PORT) || 8080;

// Lazy imports — only loaded when an API route actually needs them.
// This keeps the test for computeTrends() isolated from runManager.
let _runManager = null;
async function runManager() {
  if (!_runManager) {
    _runManager = await import('../src/services/runManager.js');
  }
  return _runManager;
}

let _report = null;
async function report() {
  if (!_report) {
    _report = await import('../src/services/report.js');
  }
  return _report;
}

let _monitors = null;
async function monitors() {
  if (!_monitors) {
    const { MonitorStore } = await import('../src/services/monitors.js');
    _monitors = new MonitorStore(DATA_DIR);
  }
  return _monitors;
}

// ─── record-once login (session capture) ─────────────────────────────

let _sessionStore = null;
async function sessionStore() {
  if (!_sessionStore) {
    const { SessionStore } = await import('../src/services/sessionStore.js');
    _sessionStore = new SessionStore({ dataDir: DATA_DIR });
  }
  return _sessionStore;
}

let _recorder = null;
async function recorder() {
  if (!_recorder) {
    const { LoginRecorder } = await import('../src/services/loginRecorder.js');
    _recorder = new LoginRecorder({ log: (...a) => console.log('[recorder]', ...a) });
  }
  return _recorder;
}

/** Save a finished recording for a monitor + stamp its state. */
async function persistRecording(monitorId, state) {
  const store = await sessionStore();
  const meta = await store.saveSession(monitorId, state);
  const monitorStore = await monitors();
  await monitorStore.update(monitorId, {
    sessionRecordedAt: meta.recordedAt,
    sessionExpired: false,
  });
  return meta;
}

async function handleRecordLogin(res, monitorId) {
  try {
    const monitorStore = await monitors();
    const monitor = await monitorStore.get(monitorId);
    if (!monitor) {
      sendError(res, 404, `Monitor not found: ${monitorId}`);
      return;
    }
    const rec = await recorder();
    await rec.start({
      monitorId,
      url: monitor.url,
      onDone: async (result) => {
        if (result.ok && result.state) {
          try {
            const meta = await persistRecording(monitorId, result.state);
            console.log(`[recorder] session saved for ${monitorId} (${meta.cookieCount} cookies)`);
          } catch (err) {
            console.error(`[recorder] failed to save session for ${monitorId}: ${err.message}`);
          }
        } else {
          console.log(`[recorder] recording ended for ${monitorId}: ${result.reason} — ${result.message || ''}`);
        }
      },
    });
    sendJson(res, 202, { started: true, monitorId, message: 'A browser window opened — log in, then click "Save session" in the banner.' });
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

async function handleRecordStatus(res) {
  const rec = await recorder();
  sendJson(res, 200, rec.getStatus());
}

async function handleRecordCancel(res) {
  const rec = await recorder();
  const result = await rec.cancel('user-cancel-dashboard');
  sendJson(res, 200, result);
}

async function handleDeleteSession(res, monitorId) {
  try {
    const store = await sessionStore();
    const deleted = await store.deleteSession(monitorId);
    const monitorStore = await monitors();
    await monitorStore.update(monitorId, { sessionRecordedAt: null, sessionExpired: false });
    sendJson(res, 200, { deleted, monitorId });
  } catch (err) {
    sendError(res, 500, `Failed to delete session: ${err.message}`);
  }
}

// ─── MIME types ──────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── response helpers ────────────────────────────────────────────────

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

// ─── auth (Rung 3) ───────────────────────────────────────────────────

/**
 * Token gate for the API. When SQA_API_TOKEN is set, every /api/* route
 * except /health requires it — via 'Authorization: Bearer <token>' or a
 * '?token=' query param (EventSource and report links can't set headers).
 * Static UI files stay open; the SPA collects the key and attaches it.
 *
 * No token configured = open mode (local development unchanged).
 *
 * @returns {boolean}
 */
export function isAuthorized(req, url, token = process.env.SQA_API_TOKEN || '') {
  if (!token) return true;
  const pathname = url.pathname;
  if (pathname === '/health') return true;
  if (!pathname.startsWith('/api/')) return true;

  const header = req.headers['authorization'] || '';
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get('token') === token;
}

async function sendStaticFile(res, filePath) {
  try {
    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendError(res, 404, 'File not found');
    } else {
      sendError(res, 500, err.message);
    }
  }
}

// ─── route handlers ──────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleCreateRun(req, res) {
  try {
    const payload = await readJsonBody(req);
    const { url, options = {}, mode = 'matrix', plan } = payload;
    if (!url) {
      sendError(res, 400, 'Missing url field');
      return;
    }

    const { createRun, createRunWithMatrix } = await runManager();
    const { registerAllExecutors } = await import('../src/executors/index.js');
    registerAllExecutors();
    const { registerLegacyChecks } = await import('../src/checks/index.js');
    registerLegacyChecks();

    let runId;
    if (mode === 'legacy') {
      runId = await createRun(url, options);
    } else {
      runId = await createRunWithMatrix({ url, options, plan });
    }
    sendJson(res, 202, { runId, mode });
  } catch (err) {
    sendError(res, 400, `Failed to create run: ${err.message}`);
  }
}

// ─── monitor handlers (Rung 3) ───────────────────────────────────────

async function handleListMonitors(res) {
  try {
    const store = await monitors();
    const { nextRunAt } = await import('../src/services/monitors.js');
    const ss = await sessionStore();
    const list = await store.list();
    const withSession = await Promise.all(list.map(async m => ({
      ...m,
      nextRunAt: nextRunAt(m),
      session: await ss.getSessionMeta(m.id),
    })));
    sendJson(res, 200, {
      monitors: withSession,
      count: withSession.length,
      schedulerEnabled: process.env.SQA_SCHEDULER_ENABLED !== 'false',
      authRequired: Boolean(process.env.SQA_API_TOKEN),
    });
  } catch (err) {
    sendError(res, 500, `Failed to list monitors: ${err.message}`);
  }
}

async function handleCreateMonitor(req, res) {
  try {
    const body = await readJsonBody(req);
    const store = await monitors();
    const result = await store.add({
      id: body.id,
      label: body.label || body.id,
      url: body.url,
      options: body.options || {},
      intervalHours: body.intervalHours ?? 24,
      enabled: body.enabled ?? true,
      onlyNewFindings: body.onlyNewFindings ?? true,
      webhookUrl: body.webhookUrl || '',
    });
    if (!result.ok) {
      sendError(res, 400, result.error);
      return;
    }
    sendJson(res, 201, { monitor: result.monitor });
  } catch (err) {
    sendError(res, 400, `Failed to create monitor: ${err.message}`);
  }
}

async function handleDeleteMonitor(res, id) {
  try {
    const store = await monitors();
    const removed = await store.remove(id);
    if (!removed) {
      sendError(res, 404, `Monitor not found: ${id}`);
      return;
    }
    sendJson(res, 200, { deleted: id });
  } catch (err) {
    sendError(res, 500, `Failed to delete monitor: ${err.message}`);
  }
}

async function handleRunMonitor(res, id) {
  try {
    const store = await monitors();
    const monitor = await store.get(id);
    if (!monitor) {
      sendError(res, 404, `Monitor not found: ${id}`);
      return;
    }
    // Trigger immediately with monitoring metadata, mirroring the scheduler
    const { triggerMonitor } = await import('../src/services/scheduler.js');
    const rm = await runManager();
    const runId = await triggerMonitor(monitor, {
      monitorStore: store,
      createRun: (input) => rm.createRunWithMatrix(input),
      log: console.log,
    });
    sendJson(res, 202, { runId, monitorId: id });
  } catch (err) {
    sendError(res, 400, `Failed to run monitor: ${err.message}`);
  }
}

async function handleListRuns(res) {
  try {
    const { listRuns } = await runManager();
    const runs = await listRuns();
    sendJson(res, 200, { runs, count: runs.length });
  } catch (err) {
    sendError(res, 500, `Failed to list runs: ${err.message}`);
  }
}

async function handleGetRun(res, runId) {
  try {
    const { getRun } = await runManager();
    const run = await getRun(runId);
    if (!run) {
      sendError(res, 404, `Run not found: ${runId}`);
      return;
    }
    sendJson(res, 200, run);
  } catch (err) {
    sendError(res, 500, `Failed to fetch run: ${err.message}`);
  }
}

async function handleGetReport(res, runId, format) {
  try {
    const { getRun } = await runManager();
    const { generateHtmlReport, generateJsonReport, generatePdfReport } = await report();
    const run = await getRun(runId);
    if (!run) {
      sendError(res, 404, `Run not found: ${runId}`);
      return;
    }
    if (format === 'pdf') {
      const pdf = await generatePdfReport(run, {
        publicUrl: `http://localhost:${process.env.SQA_DASHBOARD_PORT || 8080}`,
      });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${runId}.pdf"`,
      });
      res.end(pdf);
      return;
    }
    if (format === 'json') {
      const body = generateJsonReport(run);
      res.writeHead(200, {
        'Content-Type': MIME['.json'],
        'Content-Disposition': `attachment; filename="${runId}.json"`,
      });
      res.end(body);
    } else {
      const body = generateHtmlReport(run);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(body);
    }
  } catch (err) {
    sendError(res, 500, `Failed to generate report: ${err.message}`);
  }
}

async function handleScreenshot(res, runId, filename) {
  // Sanitize filename — prevent path traversal
  const safe = path.basename(filename);
  if (safe !== filename) {
    sendError(res, 400, 'Invalid filename');
    return;
  }
  const filePath = path.join(SCREENSHOTS_DIR, safe);
  await sendStaticFile(res, filePath);
}

async function handleTrends(res) {
  try {
    const { listRuns } = await runManager();
    const runs = await listRuns();
    const trends = computeTrends(runs);

    // Phase 6: include flaky test detection from recorded history
    try {
      const { FlakyTracker } = await import('../src/matrix/flakyTracker.js');
      const tracker = new FlakyTracker({ dataDir: DATA_DIR });
      trends.flakyTests = await tracker.detectFlakyTests();
    } catch (err) {
      // Flaky tracking is best-effort — don't fail the whole trends endpoint
      trends.flakyTests = [];
      trends.flakyError = err.message;
    }

    sendJson(res, 200, trends);
  } catch (err) {
    sendError(res, 500, `Failed to compute trends: ${err.message}`);
  }
}

/**
 * Health check endpoint — used by load balancers / container orchestrators.
 * Returns 200 if the server can read the data dir + respond to requests.
 */
async function handleHealth(res) {
  try {
    const dataDirExists = existsSync(DATA_DIR);
    const screenshotsDirExists = existsSync(SCREENSHOTS_DIR);
    sendJson(res, 200, {
      status: 'ok',
      uptime: process.uptime(),
      dataDir: DATA_DIR,
      dataDirExists,
      screenshotsDirExists,
      memoryUsage: process.memoryUsage().rss,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, 500, `Health check failed: ${err.message}`);
  }
}

/**
 * GET /api/flaky — return the flaky test list (Phase 6).
 */
async function handleFlaky(res) {
  try {
    const { FlakyTracker } = await import('../src/matrix/flakyTracker.js');
    const tracker = new FlakyTracker({ dataDir: DATA_DIR });
    const flakyTests = await tracker.detectFlakyTests();
    const stats = await tracker.stats();
    sendJson(res, 200, { flakyTests, stats });
  } catch (err) {
    sendError(res, 500, `Failed to compute flaky tests: ${err.message}`);
  }
}

/**
 * Compute aggregate trends from the run list.
 * Returns:
 *   • totalRuns, completedRuns, failedRuns
 *   • avgScore, scoreTrend (last 10 runs)
 *   • findingsBySeverity (sum across all runs)
 *   • findingsByCategory (sum)
 *   • flakyTests: tests that pass on some runs and fail on others
 */
export function computeTrends(runs) {
  const completed = runs.filter(r => r.status === 'completed');
  const failed = runs.filter(r => r.status === 'failed');

  const scores = completed.map(r => r.score).filter(s => s != null);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : null;

  // Score trend: last 10 completed runs (oldest first for chart)
  const scoreTrend = completed
    .slice(-10)
    .reverse()
    .map(r => ({
      runId: r.runId,
      url: r.url,
      startedAt: r.startedAt,
      score: r.score,
    }));

  // Aggregate findings across runs
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory = {};
  const ruleIdCounts = new Map();  // ruleId → { count, occurrences, pages: Set }

  for (const run of completed) {
    const s = run.summary || {};
    if (s.bySeverity) {
      for (const [sev, count] of Object.entries(s.bySeverity)) {
        bySeverity[sev] = (bySeverity[sev] || 0) + count;
      }
    }
    if (s.byCategory) {
      for (const [cat, count] of Object.entries(s.byCategory)) {
        byCategory[cat] = (byCategory[cat] || 0) + count;
      }
    }
  }

  // Flaky test detection: same ruleId appears in some runs but not others
  // (Phase 6 will implement a proper flaky tracker; this is a heuristic)
  const flakyTests = [];

  return {
    totalRuns: runs.length,
    completedRuns: completed.length,
    failedRuns: failed.length,
    avgScore,
    scoreTrend,
    findingsBySeverity: bySeverity,
    findingsByCategory: byCategory,
    flakyTests,
  };
}

// ─── SSE handler ──────────────────────────────────────────────────────

async function handleSSE(req, res, runId) {
  const { getRun, addSSEClient, removeSSEClient } = await runManager();

  // Verify the run exists
  const run = await getRun(runId);
  if (!run) {
    sendError(res, 404, `Run not found: ${runId}`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // disable nginx buffering
  });

  // Send existing events first (replay)
  if (run.events) {
    for (const evt of run.events) {
      res.write(`data: ${JSON.stringify({ type: 'progress', ...evt })}\n\n`);
    }
  }

  // If the run is already done, send terminal marker
  if (run.status === 'completed' || run.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'progress', message: '__DONE__', timestamp: run.completedAt })}\n\n`);
  } else {
    // Register for live updates
    addSSEClient(runId, res);
    req.on('close', () => removeSSEClient(runId, res));
  }
}

// ─── router ──────────────────────────────────────────────────────────

export async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS — allow all origins (dev convenience)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Token gate (Rung 3) — see isAuthorized()
  if (!isAuthorized(req, url)) {
    sendError(res, 401, 'Unauthorized — a valid access key is required');
    return;
  }

  try {
    // API routes
    if (pathname === '/api/runs' && method === 'GET') {
      return await handleListRuns(res);
    }
    if (pathname === '/api/runs' && method === 'POST') {
      return await handleCreateRun(req, res);
    }
    if (pathname === '/api/trends' && method === 'GET') {
      return await handleTrends(res);
    }
    if (pathname === '/health' && method === 'GET') {
      return await handleHealth(res);
    }
    if (pathname === '/api/flaky' && method === 'GET') {
      return await handleFlaky(res);
    }

    // Monitor routes (Rung 3)
    if (pathname === '/api/monitors' && method === 'GET') {
      return await handleListMonitors(res);
    }
    if (pathname === '/api/monitors' && method === 'POST') {
      return await handleCreateMonitor(req, res);
    }
    const monitorDeleteMatch = pathname.match(/^\/api\/monitors\/([^/]+)$/);
    if (monitorDeleteMatch && method === 'DELETE') {
      return await handleDeleteMonitor(res, monitorDeleteMatch[1]);
    }
    const monitorRunMatch = pathname.match(/^\/api\/monitors\/([^/]+)\/run$/);
    if (monitorRunMatch && method === 'POST') {
      return await handleRunMonitor(res, monitorRunMatch[1]);
    }
    const recordLoginMatch = pathname.match(/^\/api\/monitors\/([^/]+)\/record-login$/);
    if (recordLoginMatch && method === 'POST') {
      return await handleRecordLogin(res, recordLoginMatch[1]);
    }
    const deleteSessionMatch = pathname.match(/^\/api\/monitors\/([^/]+)\/session$/);
    if (deleteSessionMatch && method === 'DELETE') {
      return await handleDeleteSession(res, deleteSessionMatch[1]);
    }
    if (pathname === '/api/record-status' && method === 'GET') {
      return await handleRecordStatus(res);
    }
    if (pathname === '/api/record-cancel' && method === 'POST') {
      return await handleRecordCancel(res);
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      return await handleGetRun(res, runMatch[1]);
    }

    const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch && method === 'GET') {
      return await handleSSE(req, res, eventsMatch[1]);
    }

    const reportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report\.(json|html|pdf)$/);
    if (reportMatch && method === 'GET') {
      return await handleGetReport(res, reportMatch[1], reportMatch[2]);
    }

    const screenshotMatch = pathname.match(/^\/api\/runs\/([^/]+)\/screenshots\/(.+)$/);
    if (screenshotMatch && method === 'GET') {
      return await handleScreenshot(res, screenshotMatch[1], screenshotMatch[2]);
    }

    // Static files
    if (pathname === '/' || pathname === '/index.html') {
      return await sendStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === '/styles.css') {
      return await sendStaticFile(res, path.join(PUBLIC_DIR, 'styles.css'));
    }
    if (pathname === '/app.js') {
      return await sendStaticFile(res, path.join(PUBLIC_DIR, 'app.js'));
    }

    sendError(res, 404, `Not found: ${method} ${pathname}`);
  } catch (err) {
    console.error('Route error:', err);
    sendError(res, 500, err.message);
  }
}

// ─── server factory ───────────────────────────────────────────────────

export function createDashboardServer({ port = DEFAULT_PORT } = {}) {
  const server = http.createServer(route);
  return {
    server,
    listen: () => new Promise((resolve) => {
      server.listen(port, () => {
        console.log(`SQA dashboard running at http://localhost:${port}`);
        // Rung 3: monitoring loop — no-op unless monitors are configured,
        // and disabled entirely with SQA_SCHEDULER_ENABLED=false.
        Promise.all([monitors(), runManager()])
          .then(([store, rm]) => import('../src/services/scheduler.js'))
          .then(({ startScheduler }) => {
            startScheduler({
              monitorStore: _monitors,
              createRun: (input) => runManager().then(m => m.createRunWithMatrix(input)),
              getRun: (id) => runManager().then(m => m.getRun(id)),
              log: (...args) => console.log('[scheduler]', ...args),
            });
          })
          .catch(err => console.error('Scheduler startup failed:', err.message));
        resolve(server);
      });
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Run if invoked directly (not imported)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { server, listen } = createDashboardServer();
  listen();
}
