/**
 * mcp/tools.js — the seven MCP tools TestFlow exposes to coding agents.
 *
 * Design rules:
 *   • Structured JSON only — every result is a JSON object serialized as
 *     the single text content block. No prose, no HTML.
 *   • Every report-shaped response goes through buildMcpReport() and is
 *     gated by validateReport() before it reaches the agent.
 *   • Heavy modules (playwright, runManager, storage) are lazily imported
 *     inside handlers so server startup (stdio handshake) stays fast and
 *     unit tests of schemas don't pay the full import cost.
 *   • start_full_scan accepts ONLY scan-shape options. Credential material
 *     (storageState, cookies, tokens) is rejected outright — sessions live
 *     in monitors via the record-once login, never on the MCP surface.
 */
import { z } from 'zod';
import { validateUrlSafe } from '../services/ssrf.js';
import { sanitizeError } from './redact.js';
import { buildMcpReport } from './reporting.js';
import { explainRule } from './rules.js';

// ─── helpers ─────────────────────────────────────────────────────────

/** Serialize a tool result as JSON text content. */
function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/** Uniform error envelope: scrubbed message, no stack traces, ever. */
function errorResult(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: sanitizeError(err) }, null, 2) }],
  };
}

/** Wrap a handler so no raw exception or stack trace reaches the agent. */
function safe(handler) {
  return async (args) => {
    try {
      return jsonResult(await handler(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

/** Reject anything that looks like credential material in scan options. */
const FORBIDDEN_OPTION_KEYS = [
  'storagestate', 'storage_state', 'cookies', 'session', 'sessioncookie',
  'token', 'authorization', 'password', 'secret', 'apikey', 'api_key', 'cred', 'credentials',
];

function sanitizeScanOptions(options = {}) {
  if (typeof options !== 'object' || options == null || Array.isArray(options)) {
    throw new Error('options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (FORBIDDEN_OPTION_KEYS.includes(key.toLowerCase())) {
      throw new Error(`options.${key} is not accepted over MCP: credential material never crosses this interface. Use a monitor's record-once login for authenticated scans.`);
    }
  }
  const allowed = {};
  if (options.maxPages != null) allowed.maxPages = Math.min(Math.max(Number(options.maxPages) || 1, 1), 100);
  if (options.maxDepth != null) allowed.maxDepth = Math.min(Math.max(Number(options.maxDepth) || 1, 1), 10);
  if (options.browsers != null) allowed.browsers = options.browsers;
  if (options.viewports != null) allowed.viewports = options.viewports;
  if (options.executors != null) allowed.executors = options.executors;
  return allowed;
}

/** Shared SSRF pre-check with the exact same error text as the scan path. */
async function assertUrlAllowed(url) {
  const check = await validateUrlSafe(url);
  if (!check.safe) {
    const err = new Error(check.error);
    err.code = 'URL_BLOCKED';
    throw err;
  }
}

// ─── tool definitions ────────────────────────────────────────────────

export const TOOL_DEFS = [
  {
    name: 'quick_check',
    description:
      'Fast scoped check of a single page or local dev server URL (~15s): accessibility (axe-core), ' +
      'browser console errors, network failures, and same-origin API error responses. ' +
      'Returns pass/fail plus CONFIRMED findings (and low-noise SUSPECTED items) as structured JSON. ' +
      'Use frequently inside an edit-test-fix loop; use start_full_scan for deep matrix scans.',
    inputSchema: {
      url: z.string().describe('Absolute http(s) URL of the page to check, e.g. http://localhost:3000/'),
      scope: z.object({
        a11y: z.boolean().optional().describe('Run the axe-core accessibility audit (default true)'),
        console: z.boolean().optional().describe('Capture console errors / uncaught exceptions (default true)'),
        network: z.boolean().optional().describe('Capture failed same-origin network requests (default true)'),
        api: z.boolean().optional().describe('Capture same-origin API responses with status >= 400 (default true)'),
      }).strict().optional().describe('Restrict which checks run; omit for all'),
    },
    handler: safe(async ({ url, scope }) => {
      await assertUrlAllowed(url);
      const { scanSinglePage } = await import('./scanEngine.js');
      const run = await scanSinglePage({ url, checks: scope || {} });
      const { report, validation } = buildMcpReport(run, { verbosity: 'summary' });
      if (!report) {
        return { pass: false, error: 'Internal report failed invariant validation — not returned.', validationErrors: validation.errors };
      }
      const confirmed = report.confirmed;
      const hasCoverageFailure = (report.summary?.coverageFailures || 0) > 0 || (report.coverage?.pagesScanned || 0) === 0;
      return {
        pass: confirmed.length === 0 && !hasCoverageFailure,
        url: report.url,
        checked: run.options.checks,
        coverage: report.coverage,
        confirmedCount: confirmed.length,
        suspectedCount: report.suspected.length,
        confirmed,
        suspected: report.suspected,
        validationErrors: validation.errors.length ? validation.errors : undefined,
      };
    }),
  },

  {
    name: 'start_full_scan',
    description:
      'Start a full TestFlow matrix scan (crawl + plan + browser × viewport matrix + all executors). ' +
      'Returns a job_id immediately; poll with get_scan_status, then fetch results with get_scan_report. ' +
      'Accepts only scan-shape options — credential/session material is rejected by design (use a monitor with record-once login for authenticated scans).',
    inputSchema: {
      url: z.string().describe('Absolute http(s) URL to scan'),
      options: z.object({
        maxPages: z.number().int().min(1).max(100).optional().describe('Max pages to crawl (default 5)'),
        maxDepth: z.number().int().min(1).max(10).optional().describe('Max crawl depth (default 2)'),
        browsers: z.array(z.string()).optional().describe('Browser names, e.g. ["chromium"]'),
        viewports: z.array(z.object({ width: z.number().int(), height: z.number().int() })).optional().describe('Viewport matrix'),
        executors: z.array(z.string()).optional().describe('Executor IDs to run (default: plan defaults)'),
      }).strict().optional().describe('Scan shape only — session/credential keys are rejected'),
    },
    handler: safe(async ({ url, options }) => {
      await assertUrlAllowed(url);
      const cleanOptions = sanitizeScanOptions(options);
      const { createRunWithMatrix } = await import('../services/runManager.js');
      const runId = await createRunWithMatrix({ url, options: cleanOptions });
      return {
        job_id: runId,
        status: 'pending',
        pollWith: 'get_scan_status',
        fetchReportWith: 'get_scan_report',
      };
    }),
  },

  {
    name: 'get_scan_status',
    description:
      'Status of a full-scan job: pending | running | complete | failed, plus progress (pages scanned so far) when available.',
    inputSchema: {
      job_id: z.string().describe('The job_id returned by start_full_scan (a run ID)'),
    },
    handler: safe(async ({ job_id }) => {
      const { JobQueue } = await import('../storage/jobQueue.js');
      const { getRun } = await import('../storage/runStore.js');
      const queue = new JobQueue();
      const job = queue.getJob(job_id);
      const run = getRun(job_id);
      const jobStatus = job?.status || run?.status || null;
      if (!jobStatus) {
        throw new Error(`Unknown job_id: ${job_id}`);
      }
      const map = { queued: 'pending', running: 'running', completed: 'complete', failed: 'failed' };
      const status = map[jobStatus] || jobStatus;
      const progress = run?.pages?.length != null
        ? { pagesScanned: run.pages.length }
        : undefined;
      const out = { job_id, status };
      if (progress) out.progress = progress;
      if (status === 'failed') out.error = run?.error || job?.last_error || null;
      if (status === 'complete') out.nextStep = 'get_scan_report';
      return out;
    }),
  },

  {
    name: 'get_scan_report',
    description:
      'Structured report for a completed scan job. verbosity "summary" (default): counts, score, coverage, and CONFIRMED findings only, ' +
      'each as {rule, severity, url, selector, suggestedFix}. verbosity "full": everything including evidence (redacted). ' +
      'The report is validated against TestFlow\'s correctness invariants before being returned; a report that fails validation is never sent.',
    inputSchema: {
      job_id: z.string().describe('The job_id from start_full_scan'),
      verbosity: z.enum(['summary', 'full']).optional().describe('Default "summary"'),
    },
    handler: safe(async ({ job_id, verbosity }) => {
      const { getRun } = await import('../storage/runStore.js');
      const run = await getRun(job_id);
      if (!run) throw new Error(`Unknown job_id: ${job_id}`);
      const { report, validation } = buildMcpReport(run, { verbosity: verbosity || 'summary' });
      if (!report) {
        return {
          error: 'The run report failed invariant validation and was withheld.',
          validationErrors: validation.errors,
        };
      }
      return report;
    }),
  },

  {
    name: 'check_accessibility',
    description:
      'Accessibility-only check of a single URL (axe-core, all rules). Narrow and fast — for when you only touched markup/ARIA/styling and want to know if you broke a11y.',
    inputSchema: {
      url: z.string().describe('Absolute http(s) URL of the page to audit'),
    },
    handler: safe(async ({ url }) => {
      await assertUrlAllowed(url);
      const { scanSinglePage } = await import('./scanEngine.js');
      const run = await scanSinglePage({ url, checks: { a11y: true, console: false, network: false, api: false } });
      const { report, validation } = buildMcpReport(run, { verbosity: 'summary' });
      if (!report) {
        return { pass: false, error: 'Internal report failed invariant validation — not returned.', validationErrors: validation.errors };
      }
      const hasCoverageFailure = (report.summary?.coverageFailures || 0) > 0 || (report.coverage?.pagesScanned || 0) === 0;
      return {
        pass: report.confirmed.length === 0 && !hasCoverageFailure,
        url: report.url,
        confirmedCount: report.confirmed.length,
        confirmed: report.confirmed,
        validationErrors: validation.errors.length ? validation.errors : undefined,
      };
    }),
  },

  {
    name: 'check_api_contract',
    description:
      'API-contract check. With `endpoints`: probes each endpoint (method, path, expectedStatus, responseSchema) against the base URL and reports violations. ' +
      'Without `endpoints`: loads the page once, observes same-origin API traffic, replays it, and reports 5xx errors / status changes. ' +
      'No browser matrix, no crawl.',
    inputSchema: {
      url: z.string().describe('Base URL (page or API origin)'),
      endpoints: z.array(z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
        path: z.string().describe('Path, e.g. /api/users'),
        expectedStatus: z.number().int().optional().describe('Expected HTTP status (default 200 for GET, ignored otherwise)'),
        responseSchema: z.object({}).passthrough().optional().describe('Minimal schema: {type:"object", properties:{...}} or {field:"string"}'),
        queryParams: z.record(z.string()).optional(),
        body: z.unknown().optional().describe('JSON body for POST/PUT/PATCH (shape or literal)'),
      })).optional().describe('Endpoints to probe; omit to auto-observe from the page'),
    },
    handler: safe(async ({ url, endpoints }) => {
      await assertUrlAllowed(url);

      if (Array.isArray(endpoints) && endpoints.length > 0) {
        const { probeEndpoint } = await import('../executors/apiContract.js');
        const { createFindingFactory } = await import('../services/findingFactory.js');
        const createFinding = createFindingFactory();
        const findings = [];
        for (const endpoint of endpoints) {
          const ep = {
            method: endpoint.method || 'GET',
            path: endpoint.path,
            expectedStatus: endpoint.expectedStatus ?? (epDefaultStatus(endpoint)),
            responseSchema: endpoint.responseSchema,
            queryParams: endpoint.queryParams,
            body: endpoint.body,
          };
          const { finding } = await probeEndpoint(ep, {
            plan: { targetUrl: url },
            options: { timeout: 8000 },
            createFinding,
          });
          if (finding) findings.push(finding);
        }
        const { report, validation } = buildMcpReport(
          { runId: `mcp_api_${Date.now()}`, url, status: 'completed', findings, pages: [] },
          { verbosity: 'summary' }
        );
        if (!report) {
          return { pass: false, error: 'Internal report failed invariant validation — not returned.', validationErrors: validation.errors };
        }
        const hasCoverageFailure = (report.summary?.coverageFailures || 0) > 0;
        return {
          pass: report.confirmed.length === 0 && !hasCoverageFailure,
          url: report.url,
          probed: endpoints.length,
          confirmedCount: report.confirmed.length,
          suspectedCount: report.suspected.length,
          confirmed: report.confirmed,
          suspected: report.suspected,
          validationErrors: validation.errors.length ? validation.errors : undefined,
        };
      }

      // No endpoints given — observe traffic from a single page load, then replay.
      const { scanSinglePage } = await import('./scanEngine.js');
      const observedRun = await scanSinglePage({ url, checks: { a11y: false, console: false, network: false, api: true } });
      const apiFindings = observedRun.findings.filter(f => f.ruleId === 'api-error' || f.ruleId === 'api-status-mismatch');
      const { report, validation } = buildMcpReport(observedRun, { verbosity: 'summary' });
      if (!report) {
        return { pass: false, error: 'Internal report failed invariant validation — not returned.', validationErrors: validation.errors };
      }
      const hasCoverageFailure = (report.summary?.coverageFailures || 0) > 0 || (report.coverage?.pagesScanned || 0) === 0;
      return {
        pass: apiFindings.filter(f => f.confidence === 'confirmed').length === 0 && !hasCoverageFailure,
        url: report.url,
        mode: 'observed-traffic',
        confirmedCount: report.confirmed.length,
        suspectedCount: report.suspected.length,
        confirmed: report.confirmed,
        suspected: report.suspected,
        validationErrors: validation.errors.length ? validation.errors : undefined,
      };
    }),
  },

  {
    name: 'explain_finding',
    description:
      'Plain-language explanation + suggested fix for a rule ID (e.g. from a prior quick_check/get_scan_report finding). ' +
      'Covers TestFlow rule IDs and the most common axe-core rules.',
    inputSchema: {
      rule_id: z.string().describe('Rule ID, e.g. "api-status-mismatch", "console-error", "color-contrast"'),
    },
    handler: safe(async ({ rule_id }) => {
      const info = explainRule(rule_id);
      return {
        ruleId: rule_id,
        known: info.known,
        title: info.title,
        explanation: info.explanation,
        suggestedFix: info.suggestedFix,
        docs: info.docs || undefined,
      };
    }),
  },
];

function epDefaultStatus(endpoint) {
  return endpoint.method && endpoint.method !== 'GET' ? null : 200;
}
