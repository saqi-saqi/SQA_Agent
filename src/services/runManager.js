import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../utils/config.js';
import { info, error as logError, warn } from '../utils/logger.js';
import { validateUrl } from './ssrf.js';
import { crawlSite, closeCrawlSession } from './crawler.js';
import { createFindingFactory } from './findingFactory.js';
import { calculateScore, summarizeFindings } from './scoring.js';
import { checkLinks } from './checks/links.js';
import { checkConsole } from './checks/console.js';
import { checkNetwork } from './checks/network.js';
import { checkAccessibility } from './checks/accessibility.js';
import { checkSeo } from './checks/seo.js';
import { checkPerformance } from './checks/performance.js';
import { checkWorkflows } from './checks/workflows.js';
import {
  saveRun as dbSaveRun,
  getRun as dbGetRun,
  listRuns as dbListRuns,
  deleteRun as dbDeleteRun,
  cleanupOldRuns as dbCleanupOldRuns
} from '../storage/runStore.js';
import { JobQueue } from '../storage/jobQueue.js';

const runs = new Map();
const sseClients = new Map();
let activeRuns = 0;
const jobQueue = new JobQueue();

const MAX_CONCURRENT_RUNS = 2;
const DATA_DIR = path.join(process.cwd(), 'data');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

export async function ensureDataDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
}

export function emitEvent(runId, message) {
  const clients = sseClients.get(runId);
  const timestamp = new Date().toISOString();
  if (clients) {
    const data = JSON.stringify({ type: 'progress', message, timestamp });
    for (const res of clients) {
      res.write(`data: ${data}\n\n`);
    }
  }
  const run = runs.get(runId);
  if (run) {
    if (!run.events) run.events = [];
    run.events.push({ message, timestamp });
  }
}

export function addSSEClient(runId, res) {
  if (!sseClients.has(runId)) {
    sseClients.set(runId, new Set());
  }
  sseClients.get(runId).add(res);
  
  res.on('close', () => {
    removeSSEClient(runId, res);
  });
}

export function removeSSEClient(runId, res) {
  const clients = sseClients.get(runId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(runId);
    }
  }
}

export async function createRun(url, options) {
  const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
  
  await validateUrl(url);
  for (const workflow of options.workflows || []) {
    await validateUrl(workflow.startUrl);
  }

  const maxPages = Math.min(Math.max(options.maxPages || 1, 1), config.maxPagesHardLimit || 100);
  const maxDepth = options.maxDepth || 2;
  const checks = options.checks || [];
  const workflows = options.workflows || [];

  const run = {
    runId,
    url,
    status: 'queued',
    startedAt: new Date().toISOString(),
    options: {
      maxPages,
      maxDepth,
      checks,
      workflows
    },
    events: [],
    findings: [],
    workflowResults: [],
    pages: [],
    score: null,
    summary: null
  };

  runs.set(runId, run);
  await saveRun(run);

  jobQueue.enqueue({
    runId,
    payload: { mode: 'legacy', runId, url, options: run.options },
  });

  processQueue();
  return runId;
}

export async function saveRun(run) {
  try {
    dbSaveRun(run);
    runs.set(run.runId, run);
  } catch (err) {
    logError(`Failed to save run ${run.runId}`, err);
  }
}

export async function getRun(runId) {
  if (runs.has(runId)) {
    return runs.get(runId);
  }
  try {
    const run = dbGetRun(runId);
    if (run) {
      runs.set(runId, run);
      return run;
    }
    return null;
  } catch (err) {
    logError(`Failed to get run ${runId}`, err);
    return null;
  }
}

export async function listRuns(opts = {}) {
  try {
    return dbListRuns(opts);
  } catch (err) {
    logError('Failed to list runs', err);
    return [];
  }
}

export async function executeRun(runId) {
  activeRuns++;
  let run = runs.get(runId);
  if (!run) {
    run = await getRun(runId);
    if (!run) { activeRuns--; return; }
  }

  run.status = 'running';
  await saveRun(run);
  emitEvent(runId, 'Starting QA run');
  
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, config.maxRunTimeMs || 300000);

  let browser = null;

  try {
    emitEvent(runId, 'Validating URL');
    await validateUrl(run.url);
    
    const createFinding = createFindingFactory();
    
    emitEvent(runId, 'Crawling site');
    const crawlResult = await crawlSite({
      url: run.url,
      options: { maxPages: run.options.maxPages, maxDepth: run.options.maxDepth },
      onEvent: (msg) => emitEvent(runId, msg),
      signal: abortController.signal
    });
    
    const { pages, siteOrigin, context } = crawlResult;
    browser = crawlResult.browser;
    
    let findings = [];
    
    if (run.options.checks.length > 0) {
      emitEvent(runId, 'Running checks');
      
      const onEvent = (msg) => emitEvent(runId, msg);
      const signal = abortController.signal;
      
      for (const checkName of run.options.checks) {
        if (signal.aborted) {
          emitEvent(runId, 'Time limit reached, finalizing report...');
          break;
        }

        emitEvent(runId, `Running check: ${checkName}`);
        try {
          let checkFindings = [];
          switch (checkName) {
            case 'links':
              checkFindings = await checkLinks(pages, createFinding, onEvent, signal, siteOrigin);
              break;
            case 'console':
              checkFindings = await checkConsole(pages, createFinding, onEvent, siteOrigin);
              break;
            case 'network':
              checkFindings = await checkNetwork(pages, createFinding, onEvent, siteOrigin);
              break;
            case 'accessibility':
              checkFindings = await checkAccessibility(pages, createFinding, onEvent, SCREENSHOTS_DIR, runId, signal);
              break;
            case 'seo':
              checkFindings = await checkSeo(pages, createFinding, onEvent, SCREENSHOTS_DIR, runId, signal);
              break;
            case 'performance':
              checkFindings = await checkPerformance(pages, createFinding, onEvent, SCREENSHOTS_DIR, runId, signal);
              break;
          }
          findings = findings.concat(checkFindings || []);
          run.findings = findings;
          run.score = calculateScore(findings);
          await saveRun(run);
        } catch (err) {
          logError(`Check ${checkName} failed`, err);
          emitEvent(runId, `Check ${checkName} failed: ${err.message}`);
        }
      }
    }

    if (run.options.workflows?.length && !abortController.signal.aborted) {
      emitEvent(runId, 'Running workflow assertions');
      const workflowRun = await checkWorkflows(context, run.options.workflows, createFinding, (msg) => emitEvent(runId, msg), SCREENSHOTS_DIR, runId, abortController.signal);
      findings = findings.concat(workflowRun.findings);
      run.workflowResults = workflowRun.results;
    }

    // Close all Playwright pages before saving
    for (const p of pages) {
      if (p.page) {
        await p.page.close().catch(() => {});
      }
    }

    run.findings = findings;
    run.score = calculateScore(findings);
    run.summary = summarizeFindings(findings, pages);

    // Invariant check in non-production / test mode
    if (process.env.NODE_ENV !== 'production' || process.env.SQA_STRICT === 'true') {
      try {
        const { validateReport } = await import('../reporting/invariants.js');
        validateReport(run, { throwOnError: process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true' });
      } catch (invErr) {
        logError(`Invariant validation failure in run ${runId}: ${invErr.message}`);
        if (process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true') throw invErr;
      }
    }
    
    // Strip Playwright page instances and raw capture data before persisting
    run.pages = pages.map(p => {
      const { page, consoleLogs, pageExceptions, networkFailures, networkErrors, ...rest } = p;
      return rest;
    });

    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    emitEvent(runId, 'Completed');
    emitEvent(runId, '__DONE__');
    
  } catch (err) {
    logError(`Run ${runId} failed`, err);
    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    run.error = err.message;
    emitEvent(runId, `Run failed: ${err.message}`);
    emitEvent(runId, '__DONE__');
  } finally {
    clearTimeout(timeoutId);
    await closeCrawlSession(browser);
    await saveRun(run);
  }
}

export function processQueue() {
  while (activeRuns < MAX_CONCURRENT_RUNS) {
    const job = jobQueue.acquireNextJob({ maxConcurrent: MAX_CONCURRENT_RUNS });
    if (!job) break;

    activeRuns++;
    const isMatrix = job.payload?.mode === 'matrix';
    const executeFn = isMatrix ? executeRunWithMatrix : executeRun;

    executeFn(job.runId, job.payload)
      .then(() => {
        jobQueue.completeJob(job.runId);
      })
      .catch((err) => {
        logError(`Execution error in job ${job.runId}`, err);
        jobQueue.failJob(job.runId, err.message);
      })
      .finally(() => {
        activeRuns--;
        processQueue();
      });
  }
}

export async function cleanupOldRuns(maxAgeMs = config.cleanupMaxAgeMs || 24 * 60 * 60 * 1000) {
  try {
    dbCleanupOldRuns(maxAgeMs);
    if (existsSync(SCREENSHOTS_DIR)) {
      const now = Date.now();
      const files = await fs.readdir(SCREENSHOTS_DIR);
      for (const file of files) {
        const filePath = path.join(SCREENSHOTS_DIR, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath).catch(() => {});
        }
      }
    }
  } catch (err) {
    logError('Cleanup failed', err);
  }
}

export async function shutdown() {
  info('Shutting down run manager...');
  for (const [runId, clients] of sseClients.entries()) {
    for (const client of clients) {
      client.end();
    }
  }
  sseClients.clear();

  if (activeRuns > 0) {
    info(`Waiting for ${activeRuns} active runs to complete...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

// ─── Phase 3: Matrix execution path ───────────────────────────────────
//
// The legacy `createRun` + `executeRun` functions run the v1 check_* modules
// against crawled pages. Phase 3 adds an alternative path that:
//   1. Builds a TestPlan via the Explorer (LLM-driven)
//   2. Runs the plan through the matrix (browser × viewport × role)
//   3. Aggregates + dedups findings across cells
//
// Usage:
//   const runId = await createRunWithMatrix({ url, options: { maxPages: 5 } });
//   // SSE events stream as usual; run completes with matrix findings

/**
 * Create a run that uses the matrix execution path.
 *
 * @param {object} input
 * @param {string} input.url             — target URL
 * @param {object} [input.options]       — { maxPages, maxDepth, browsers, viewports, executors, roles, dedup }
 * @param {object} [input.plan]          — pre-approved TestPlan (skips explorer)
 * @returns {Promise<string>}            — runId
 */
export async function createRunWithMatrix({ url, options = {}, plan: preApprovedPlan }) {
  // Validate URL up front
  await validateUrl(url);

  const runId = `run_matrix_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const run = {
    runId,
    url,
    status: 'queued',
    startedAt: new Date().toISOString(),
    options: {
      maxPages: Math.min(Math.max(options.maxPages || 1, 1), 100),
      maxDepth: options.maxDepth || 2,
      browsers: options.browsers || ['chromium'],
      viewports: options.viewports || null,    // null = infer from crawl
      executors: options.executors || null,    // null = use plan defaults
      roles: options.roles || null,             // null = infer from plan
      dedup: options.dedup !== false,
      // Monitoring metadata (Rung 3) — carried through to execution so the
      // publisher can filter regressions and notify the right webhook.
      ...(options.monitorId ? { monitorId: options.monitorId } : {}),
      ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
      ...(options.onlyNewFindings != null ? { onlyNewFindings: options.onlyNewFindings } : {}),
      ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
    },
    events: [],
    findings: [],
    matrixStats: null,
    pages: [],
    score: null,
    summary: null,
    mode: 'matrix',
  };

  runs.set(runId, run);
  await saveRun(run);

  // Stash the pre-approved plan on the run object for executeRunWithMatrix
  if (preApprovedPlan) {
    run.preApprovedPlan = preApprovedPlan;
  }

  jobQueue.enqueue({
    runId,
    payload: {
      mode: 'matrix',
      runId,
      url,
      options: run.options,
      preApprovedPlan,
    },
  });

  processQueue();
  return runId;
}

/**
 * Execute a matrix run — crawl, build plan (or use pre-approved), run matrix.
 */
export async function executeRunWithMatrix(runId, payload) {
  const run = runs.get(runId) || await getRun(runId);
  if (!run) return;

  if (payload?.preApprovedPlan && !run.preApprovedPlan) {
    run.preApprovedPlan = payload.preApprovedPlan;
  }

  run.status = 'running';
  await saveRun(run);
  emitEvent(runId, 'Starting matrix run');

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), config.maxRunTimeMs || 600000);

  let browserPool = null;

  try {
    // Lazy-import matrix modules so the legacy path doesn't pay the cost
    const { createStateManager, BrowserPool, runMatrix } = await import('../matrix/index.js');
    const { buildTestPlan, approvePlan } = await import('../explorer/index.js');

    // Executors must be registered for ANY entry path (dashboard POST,
    // scheduler, monitor run-now, programmatic). Idempotent — safe to repeat.
    const { registerAllExecutors } = await import('../executors/index.js');
    registerAllExecutors();
    const { registerLegacyChecks } = await import('../checks/index.js');
    registerLegacyChecks();

    const createFinding = createFindingFactory();
    const onEvent = (msg) => emitEvent(runId, msg);
    const signal = abortController.signal;

    // ─── 0. Recorded login session (monitor runs) ─────────────────
    let recordedSession = null;
    let sessionCookie = null;
    if (run.options.monitorId) {
      const { SessionStore } = await import('./sessionStore.js');
      const sessionStore = new SessionStore();
      recordedSession = await sessionStore.loadSession(run.options.monitorId).catch(err => {
        warn(`Failed to load recorded session for ${run.options.monitorId}: ${err.message}`);
        return null;
      });
      if (recordedSession) {
        const cookieCount = recordedSession.cookies?.length || 0;
        emitEvent(runId, `Using recorded login session (${cookieCount} cookies) — testing the authenticated app`);
        run.options.sessionApplied = true;
        try {
          sessionCookie = sessionStore.cookieHeaderFor(new URL(run.url).host, recordedSession);
        } catch { /* non-parsing URL — skip API session */ }
      }
    }

    // ─── 1. Crawl ─────────────────────────────────────────────────
    emitEvent(runId, 'Crawling site');
    const crawlResult = await crawlSite({
      url: run.url,
      options: {
        maxPages: run.options.maxPages,
        maxDepth: run.options.maxDepth,
        ...(recordedSession ? { storageState: recordedSession } : {}),
      },
      onEvent, signal,
    });
    const { pages, siteOrigin } = crawlResult;
    let browser = crawlResult.browser;

    // Recorded-session expiry detection: if every crawled page looks like a
    // login page despite the session, the session has probably expired.
    if (recordedSession && pages.length > 0) {
      const { looksLikeLoginUrl } = await import('./sessionStore.js');
      const allLogin = pages.every(p => looksLikeLoginUrl(p.url || '', p.title || ''));
      if (allLogin) {
        run.sessionExpired = true;
        emitEvent(runId, '⚠ Recorded session appears EXPIRED — every crawled page looks like a login page. Re-record the login for this monitor.');
      }
    }

    // ─── 2. Build or use plan ──────────────────────────────────────
    let plan = run.preApprovedPlan;
    if (!plan) {
      emitEvent(runId, 'Building test plan via explorer');
      const result = await buildTestPlan({
        pages, targetUrl: run.url, siteOrigin, onEvent: undefined, signal,
      });
      plan = approvePlan(result.plan);
    }

    // Override plan options with run options
    if (run.options.browsers) plan.browsers = run.options.browsers;
    if (run.options.viewports) plan.viewports = run.options.viewports;
    if (run.options.executors) plan.executors = run.options.executors;

    emitEvent(runId, `Plan: ${plan.flows.length} flows, ${plan.apiEndpoints.length} endpoints, ` +
                     `${plan.fuzzTargets.length} fuzz targets, ${plan.a11yRules.length} a11y rules`);

    // ─── 3. Prime state manager ─────────────────────────────────────
    const stateManager = createStateManager({ runStep: (await import('../executors/e2e.js')).runStep });

    // Launch one browser (chromium by default) for state capture —
    // skipped when a recorded session exists (no AI login flows needed).
    if (browser && !recordedSession) {
      try {
        await stateManager.prime({
          plan, browser, browserName: 'chromium',
          viewport: plan.viewports?.[0] || { width: 1280, height: 720 },
          signal,
        });
      } catch (err) {
        warn(`State manager prime failed: ${err.message}`);
      }
    }

    // ─── 4. Build browser pool ───────────────────────────────────────
    browserPool = new BrowserPool({
      stateManager,
      ...(recordedSession ? { storageState: recordedSession } : {}),
    });

    // ─── 5. Run the matrix ──────────────────────────────────────────
    emitEvent(runId, 'Running matrix');
    const matrixResult = await runMatrix({
      plan, browserPool, createFinding, onEvent, signal,
      options: {
        dedup: run.options.dedup,
        screenshotsDir: SCREENSHOTS_DIR,
        runId,
        roles: run.options.roles,
        // Authenticated API contract probing with the recorded session
        ...(sessionCookie ? { sessionCookie } : {}),
      },
    });

    // ─── 6. Close all pages + finalize ──────────────────────────────
    for (const p of pages) {
      if (p.page) await p.page.close().catch(() => {});
    }

    run.findings = matrixResult.findings;
    run.matrixStats = matrixResult.stats;
    run.coverageFailures = matrixResult.coverageFailures || [];

    const pagesAttempted = pages.length;
    const failedUrls = new Set((run.coverageFailures || []).map(f => f.pageUrl));
    const pagesScanned = Math.max(0, pagesAttempted - failedUrls.size);
    const coverageRatio = pagesAttempted > 0 ? pagesScanned / pagesAttempted : 1.0;
    run.coverage = { pagesAttempted, pagesScanned, coverageRatio };

    const scoreOpts = {
      pagesAttempted,
      pagesScanned,
      coverageRatio,
      excludeUnauthenticated: run.options?.excludeUnauthenticated,
    };

    run.score = calculateScore(matrixResult.findings, scoreOpts);
    run.summary = summarizeFindings(matrixResult.findings, pages.length, scoreOpts);

    // Invariant check in non-production / test mode
    if (process.env.NODE_ENV !== 'production' || process.env.SQA_STRICT === 'true') {
      try {
        const { validateReport } = await import('../reporting/invariants.js');
        validateReport(run, { throwOnError: process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true' });
      } catch (invErr) {
        logError(`Invariant validation failure in matrix run ${runId}: ${invErr.message}`);
        if (process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true') throw invErr;
      }
    }
    run.pages = pages.map(p => {
      const { page, consoleLogs, pageExceptions, networkFailures, networkErrors, ...rest } = p;
      return rest;
    });

    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    emitEvent(runId, `Completed — ${matrixResult.findings.length} findings, score ${run.score}`);
    emitEvent(runId, '__DONE__');

    // ─── 7. Auto-publish findings to issue tracker (if configured) ────
    const publishOpts = {};
    if (run.options.monitorId && run.options.onlyNewFindings && run.options.previousRunId) {
      try {
        const prev = await getRun(run.options.previousRunId);
        if (prev?.findings?.length) {
          const { findingSignature } = await import('../integrations/issueTracker.js');
          publishOpts.previousSignatures = new Set(
            prev.findings.map(f => `${findingSignature(f)}::${f.severity}`)
          );
          publishOpts.onlyNewFindings = true;
        }
      } catch (err) {
        warn(`Could not load previous run for regression filter: ${err.message}`);
      }
    }
    await publishFindingsIfConfigured(run, onEvent, publishOpts).catch(err => {
      warn(`Issue tracker publish failed: ${err.message}`);
    });

    // ─── 8. Notify webhook (if configured) ────────────────────────────
    await notifyWebhook(run).catch(err => {
      warn(`Webhook notification failed: ${err.message}`);
    });

  } catch (err) {
    logError(`Matrix run ${runId} failed`, err);
    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    run.error = err.message;
    emitEvent(runId, `Run failed: ${err.message}`);
    emitEvent(runId, '__DONE__');
  } finally {
    clearTimeout(timeoutId);
    if (browserPool) await browserPool.shutdown().catch(() => {});
    await saveRun(run);
  }
}

/**
 * Auto-publish findings to an issue tracker if configured.
 * Reads config from env vars:
 *   SQA_ISSUE_TRACKER   = 'github' | 'jira' | 'console' | 'none'
 *
 * For GitHub:
 *   SQA_GITHUB_REPO     = 'owner/name'
 *   SQA_GITHUB_TOKEN    = Personal Access Token
 *
 * For Jira:
 *   SQA_JIRA_BASE_URL   = 'https://your-domain.atlassian.net'
 *   SQA_JIRA_EMAIL      = account email
 *   SQA_JIRA_API_TOKEN  = API token
 *   SQA_JIRA_PROJECT_KEY = 'SQA'
 *
 * Common options:
 *   SQA_TRACKER_MIN_SEVERITY = 'medium' | 'high' | 'critical'  (default 'medium')
 *   SQA_TRACKER_DRY_RUN     = 'true' to log actions without API calls
 */
async function publishFindingsIfConfigured(run, onEvent, opts = {}) {
  const trackerType = process.env.SQA_ISSUE_TRACKER || 'none';
  if (trackerType === 'none') return;

  let adapter = null;

  if (trackerType === 'github') {
    const { GitHubAdapter } = await import('../integrations/githubAdapter.js');
    const repo = process.env.SQA_GITHUB_REPO;
    if (!repo) {
      warn('SQA_ISSUE_TRACKER=github but SQA_GITHUB_REPO not set');
      return;
    }
    adapter = new GitHubAdapter({ repo });
  } else if (trackerType === 'jira') {
    const { JiraAdapter } = await import('../integrations/jiraAdapter.js');
    adapter = new JiraAdapter({
      baseUrl: process.env.SQA_JIRA_BASE_URL,
      email: process.env.SQA_JIRA_EMAIL,
      apiToken: process.env.SQA_JIRA_API_TOKEN,
      projectKey: process.env.SQA_JIRA_PROJECT_KEY,
    });
  } else if (trackerType === 'console') {
    // Console adapter — just logs what would be filed. Useful for CI logs.
    adapter = {
      name: 'console',
      search: async () => null,
      create: async ({ title, body, labels }) => {
        console.log('--- ISSUE CREATED ---');
        console.log('Title:', title);
        console.log('Labels:', labels.join(', '));
        console.log('Body:', body.slice(0, 500) + '...');
        return { id: 'console-' + Date.now(), url: '', state: 'open', title, labels };
      },
      update: async (issue, { comment }) => {
        if (comment) console.log('--- ISSUE UPDATED ---\n', issue.id, '\n', comment);
        return issue;
      },
    };
  } else {
    warn(`Unknown SQA_ISSUE_TRACKER: ${trackerType}`);
    return;
  }

  const { IssueTrackerPublisher } = await import('../integrations/issueTracker.js');
  const publisher = new IssueTrackerPublisher({
    adapter,
    options: {
      minSeverity: process.env.SQA_TRACKER_MIN_SEVERITY || 'medium',
      dryRun: process.env.SQA_TRACKER_DRY_RUN === 'true',
      closeResolved: process.env.SQA_TRACKER_AUTO_CLOSE === 'true',
    },
  });

  // Regression filter (Rung 3 monitoring): skip findings whose signature +
  // severity already existed in the previous run. Severity is part of the
  // key, so a bug that got worse is still reported.
  let findings = run.findings;
  if (opts.onlyNewFindings && opts.previousSignatures instanceof Set) {
    const { findingSignature } = await import('../integrations/issueTracker.js');
    const before = findings.length;
    findings = findings.filter(f => !opts.previousSignatures.has(`${findingSignature(f)}::${f.severity}`));
    if (findings.length < before) {
      onEvent?.(`Regression filter: ${before - findings.length} known finding(s) skipped, ${findings.length} new`);
    }
    if (findings.length === 0) {
      onEvent?.('No new findings to publish');
      return;
    }
  }

  onEvent?.(`Publishing ${findings.length} findings to ${trackerType}…`);

  const result = await publisher.publish(findings, {
    runId: run.runId,
    url: run.url,
    startedAt: run.startedAt,
    matrixCells: run.matrixStats?.cells?.map(c => c.cellId) || [],
  });

  onEvent?.(`Tracker: ${result.filed} filed, ${result.updated} updated, ${result.skipped} skipped, ${result.errors.length} errors`);

  run.trackerStats = result;
  await saveRun(run);
}

/**
 * POST a compact run summary to the configured webhook (Rung 3 monitoring).
 *
 * Webhook URL resolution: run.options.webhookUrl (per-monitor override)
 * → SQA_WEBHOOK_URL env. No URL configured = no-op.
 *
 * Non-blocking by design: errors are logged, never thrown into the run path.
 * Payload: { runId, url, monitorId, status, score, startedAt, completedAt,
 *            findings: [{ title, severity, confidence, ruleId, pageUrl }],
 *            reportUrl }
 */
async function notifyWebhook(run) {
  const url = run.options?.webhookUrl || process.env.SQA_WEBHOOK_URL;
  if (!url) return;

  const payload = {
    runId: run.runId,
    url: run.url,
    monitorId: run.options?.monitorId || null,
    status: run.status,
    score: run.score,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    findings: (run.findings || []).map(f => ({
      title: f.title,
      severity: f.severity,
      confidence: f.confidence,
      ruleId: f.ruleId,
      pageUrl: f.pageUrl,
    })),
  };
  // Public report link — best-effort from env (or localhost default), so the
  // receiver can open the full HTML report.
  payload.reportUrl = `${process.env.SQA_PUBLIC_URL || `http://localhost:${process.env.SQA_DASHBOARD_PORT || 8080}`}/api/runs/${run.runId}/report.html`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      warn(`Webhook responded ${res.status}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Startup: recover interrupted runs and kick off worker loop ──────
try {
  const { totalStale, recovered } = jobQueue.recoverStaleJobs();
  if (totalStale > 0) {
    info(`JobQueue: recovered ${recovered}/${totalStale} interrupted job(s) from previous session`);
  }
  processQueue();
} catch (err) {
  // Graceful fallback if database schema is initializing or running in isolation
}
