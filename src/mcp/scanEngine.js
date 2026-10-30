/**
 * mcp/scanEngine.js — fast, single-page scan used by the MCP quick/narrow
 * tools (quick_check, check_accessibility, check_api_contract).
 *
 * Design constraints (agent edit-test-fix loop):
 *   • ONE page, ONE browser, ONE viewport — no matrix, no crawl, no LLM.
 *   • Time budget ~15s by default: page load ≤10s, the rest is axe +
 *     teardown. (Design choice, flagged: 15s balances agent-loop latency
 *     against slow local dev servers; tune via SQA_MCP_QUICK_BUDGET_MS.)
 *   • Checks are switchable per call: a11y / console / network / api.
 *
 * SSRF: the URL goes through the SAME validateUrl() gate as every regular
 * scan — no localhost exceptions beyond what SQA_ALLOW_PRIVATE already
 * controls globally.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { validateUrl } from '../services/ssrf.js';
import { createFindingFactory } from '../services/findingFactory.js';
import { runAxeOnPage, axeResultsToFindings } from '../executors/a11yDeep.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function localAxePath() {
  const local = path.join(__dirname, '..', '..', 'node_modules', 'axe-core', 'axe.min.js');
  return existsSync(local) ? local : null;
}

function quickBudgetMs() {
  return parseInt(process.env.SQA_MCP_QUICK_BUDGET_MS || '15000', 10);
}

const STATIC_EXTENSIONS = /\.(png|jpe?g|gif|svg|ico|css|js|mjs|woff2?|ttf|map|bmp|webp|avif)$/i;

/**
 * Run a scoped single-page scan.
 *
 * @param {object} input
 * @param {string} input.url           — target (SSRF-validated)
 * @param {object} [input.checks]      — { a11y, console, network, api } booleans
 * @returns {Promise<{run: object}>}   — a run-shaped object for buildMcpReport
 */
export async function scanSinglePage({ url, checks = {} }) {
  const enabled = {
    a11y: checks.a11y !== false,
    console: checks.console !== false,
    network: checks.network !== false,
    api: checks.api !== false,
  };

  // SSRF gate — identical to the regular scan path. Throws on private
  // targets unless SQA_ALLOW_PRIVATE=true.
  const validated = await validateUrl(url);
  const targetUrl = validated.url;

  const budgetMs = quickBudgetMs();
  const startedAt = new Date().toISOString();
  const createFinding = createFindingFactory();
  const findings = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const consoleErrors = new Map();   // message → count
    const pageErrors = new Map();      // message → count
    const failedRequests = new Map();  // "method url err" → count
    const apiResponses = new Map();    // "method url" → { status, bodySnippet }
    let targetOrigin = null;
    try { targetOrigin = new URL(targetUrl).origin; } catch { /* unreachable after validateUrl */ }

    if (enabled.console) {
      page.on('console', msg => {
        if (msg.type() === 'error') {
          const text = (msg.text() || '').slice(0, 300);
          consoleErrors.set(text, (consoleErrors.get(text) || 0) + 1);
        }
      });
      page.on('pageerror', err => {
        const text = String(err?.message || err || 'unknown page error').slice(0, 300);
        pageErrors.set(text, (pageErrors.get(text) || 0) + 1);
      });
    }
    if (enabled.network || enabled.api) {
      page.on('requestfailed', req => {
        const failure = req.failure()?.errorText || 'requestfailed';
        if (failure === 'ERR_ABORTED') return; // navigation cancellations, not failures
        const reqUrl = req.url();
        let sameOrigin = true;
        try { sameOrigin = new URL(reqUrl).origin === targetOrigin; } catch { sameOrigin = false; }
        if (!sameOrigin) return; // third-party noise is reported by the full scan, not quick checks
        const key = `${req.method()} ${reqUrl} ${failure}`;
        failedRequests.set(key, (failedRequests.get(key) || 0) + 1);
      });
    }
    if (enabled.api) {
      page.on('response', async res => {
        try {
          const reqUrl = res.url();
          if (new URL(reqUrl).origin !== targetOrigin) return;
          if (STATIC_EXTENSIONS.test(new URL(reqUrl).pathname)) return;
          if (res.request().resourceType() === 'document') return;
          const status = res.status();
          if (status < 400) return; // only failures are findings
          const key = `${res.request().method()} ${reqUrl}`;
          if (!apiResponses.has(key)) {
            let snippet = '';
            try { snippet = (await res.text()).slice(0, 200); } catch { /* body gone */ }
            apiResponses.set(key, { status, snippet });
          }
        } catch { /* never let observation break the scan */ }
      });
    }

    // ─── Load the page (≤10s of the budget) ────────────────────────
    let loadError = null;
    try {
      await page.goto(targetUrl, {
        waitUntil: 'load',
        timeout: Math.min(10000, budgetMs - 4000),
      });
    } catch (err) {
      loadError = err.message;
    }

    if (loadError) {
      findings.push(createFinding({
        title: `Page load failed: ${targetUrl}`,
        severity: 'high',
        confidence: 'confirmed',
        category: 'Scan Coverage',
        findingType: 'coverage-failure',
        origin: 'first-party',
        ruleId: 'page-load-failure',
        pageUrl: targetUrl,
        description: loadError,
        evidence: loadError,
        blockedExecutors: ['quick-check'],
      }));
    } else {
      // Short settle so late microtasks/console errors land.
      await page.waitForTimeout(300).catch(() => {});

      // ─── axe accessibility ────────────────────────────────────────
      if (enabled.a11y) {
        const axePath = localAxePath();
        try {
          if (axePath) {
            await page.addScriptTag({ path: axePath });
          } else {
            await page.addScriptTag({ url: 'https://unpkg.com/axe-core@4.10.0/axe.min.js' });
          }
          const results = await runAxeOnPage(page, []);
          findings.push(...axeResultsToFindings(results, targetUrl, createFinding));
        } catch (err) {
          findings.push(createFinding({
            title: 'a11y check: failed to run axe-core',
            severity: 'low',
            confidence: 'high',
            category: 'accessibility',
            findingType: 'environmental',
            origin: 'first-party',
            ruleId: 'axe-injection-failed',
            pageUrl: targetUrl,
            description: `axe-core could not run on this page: ${err.message}`,
          }));
        }
      }

      // ─── console errors ───────────────────────────────────────────
      if (enabled.console) {
        for (const [message, count] of consoleErrors) {
          findings.push(createFinding({
            title: `Console error: ${message.slice(0, 120)}`,
            severity: 'medium',
            confidence: 'confirmed',
            category: 'console',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: 'console-error',
            pageUrl: targetUrl,
            description: message,
            evidence: message,
            occurrences: count,
            // Distinct selector per distinct message keeps the
            // no-duplicate-findings invariant intact.
            selector: `console:${message.slice(0, 80)}`,
          }));
        }
        for (const [message, count] of pageErrors) {
          findings.push(createFinding({
            title: `Uncaught exception: ${message.slice(0, 120)}`,
            severity: 'high',
            confidence: 'confirmed',
            category: 'console',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: 'uncaught-exception',
            pageUrl: targetUrl,
            description: message,
            evidence: message,
            occurrences: count,
            selector: `pageerror:${message.slice(0, 80)}`,
          }));
        }
      }

      // ─── network failures ─────────────────────────────────────────
      if (enabled.network) {
        for (const [key, count] of failedRequests) {
          const [method, reqUrl, failure] = key.split(' ');
          findings.push(createFinding({
            title: `Request failed: ${method} ${reqUrl}`,
            severity: 'medium',
            confidence: 'confirmed',
            category: 'network',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: `network-failure-${failure}`,
            pageUrl: targetUrl,
            description: `${method} ${reqUrl} failed: ${failure}`,
            evidence: `Target: ${reqUrl}\n${failure}`,
            occurrences: count,
            selector: `${method} ${reqUrl}`,
          }));
        }
      }

      // ─── same-origin API responses ≥400 ──────────────────────────
      if (enabled.api) {
        for (const [key, { status, snippet }] of apiResponses) {
          const [method, reqUrl] = key.split(' ');
          // 5xx = confirmed server bug; 4xx may be intended (auth, 404s) → suspected.
          const isServer = status >= 500;
          findings.push(createFinding({
            title: `API ${method} ${new URL(reqUrl).pathname} returned ${status}`,
            severity: isServer ? 'high' : 'low',
            confidence: isServer ? 'confirmed' : 'suspected',
            category: 'network',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: isServer ? 'api-error' : 'api-status-mismatch',
            pageUrl: reqUrl,
            unauthenticated: !isServer,
            description: `Observed during page load: ${method} ${reqUrl} → ${status}.` +
              (isServer ? '' : ' 4xx during a load may be intended (auth, 404) — verify before acting.'),
            evidence: `Status: ${status}\nResponse: ${snippet}`,
            selector: `${method} ${reqUrl}`,
          }));
        }
      }
    }

    await context.close().catch(() => {});

    const completedAt = new Date().toISOString();
    return {
      runId: `mcp_quick_${Date.now()}`,
      url: targetUrl,
      status: 'completed',
      startedAt,
      completedAt,
      options: { mode: 'mcp-quick', checks: enabled },
      pages: [{ url: targetUrl, status: loadError ? 0 : 200 }],
      findings,
      score: null,
      summary: null,
      mode: 'mcp-quick',
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export { quickBudgetMs };
