/**
 * src/cli/check.js — CI gate.
 *
 * Usage:
 *   npx sqa-agent check <url> [--fail-on critical|high|medium|low|info|none]
 *
 * Runs a bounded scan of the given URL and exits non-zero if findings
 * at or above the requested severity threshold are found. Designed for
 * CI/CD: quick, non-interactive, exit-code driven, and logged for the CI
 * system to parse.
 *
 * Environment:
 *   SQA_ALLOW_PRIVATE — allow localhost/private URLs (default: off)
 *   SQA_MAX_PAGES     — max pages to crawl (default: 10 for CI)
 *   SQA_MAX_DEPTH     — max crawl depth (default: 1 for CI)
 *   SQA_CI_TIMEOUT    — run timeout in ms (default: 120000)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_URL_MISSING = 64;
const EXIT_SCAN_FAILED = 70;
const EXIT_THRESHOLD_EXCEEDED = 1;

/** Severity ordering: lower index = more severe. */
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Parse command-line arguments. */
function parseArgs(argv) {
  const args = argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  const opts = { failOn: 'none', timeout: 120000, maxPages: 10, maxDepth: 1 };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fail-on' || arg === '-f') {
      opts.failOn = args[++i] || 'none';
      if (!['info', 'low', 'medium', 'high', 'critical', 'none'].includes(opts.failOn)) {
        throw new Error(`Invalid --fail-on value: ${opts.failOn}. Must be one of: info, low, medium, high, critical, none`);
      }
    } else if (arg === '--timeout' || arg === '-t') {
      opts.timeout = Number(args[++i]) || 120000;
    } else if (arg === '--max-pages' || arg === '-p') {
      opts.maxPages = Number(args[++i]) || 10;
    } else if (arg === '--max-depth' || arg === '-d') {
      opts.maxDepth = Number(args[++i]) || 1;
    } else if (arg === '--json') {
      opts.json = true;
    }
  }

  if (!url) {
    throw new Error('Usage: npx sqa-agent check <url> [--fail-on critical|high|medium|low|info|none]');
  }

  return { url, ...opts };
}

/** Print a compact scan summary to stdout (CI-friendly). */
function printSummary({ url, score, findings, pages, compliance }) {
  console.log(`SQA Agent CI check`);
  console.log(`URL: ${url}`);
  console.log(`Pages: ${pages || 0} | Score: ${score || '?'}/100 | Findings: ${findings?.length || 0}`);

  if (compliance) {
    console.log(`WCAG: ${compliance.conformancePct || '?'}% checked | ` +
                 `blocked: ${compliance.blockers?.length || 0}`);
  }

  if (findings?.length) {
    const bySeverity = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }
    console.log('Findings by severity: ' + Object.entries(bySeverity)
      .map(([s, c]) => `${s}=${c}`)
      .join(', '));

    if (!opts?.json) {
      for (const f of findings.slice(0, 20)) {
        console.log(`  [${f.severity}] ${f.title} (${f.pageUrl || '—'})`);
      }
      if (findings.length > 20) {
        console.log(`  ... and ${findings.length - 20} more`);
      }
    }
  }
}

/** Determine whether to fail given findings and the threshold. */
function shouldFail(findings, failOn) {
  if (failOn === 'none') return false;
  const threshold = SEVERITY_RANK[failOn];
  if (threshold === undefined) return false;
  return findings?.some(f => SEVERITY_RANK[f.severity] ?? 0 >= threshold);
}

/** Run a bounded scan of the URL using the matrix. */
async function runCheck({ url, timeout, maxPages, maxDepth }) {
  process.env.SQA_ALLOW_PRIVATE = process.env.SQA_ALLOW_PRIVATE || 'true';
  process.env.SQA_MAX_PAGES = process.env.SQA_MAX_PAGES || String(maxPages);
  process.env.SQA_MAX_DEPTH = process.env.SQA_MAX_DEPTH || String(maxDepth);

  const { createRunWithMatrix } = await import('../services/runManager.js');
  const { registerAllExecutors } = await import('../executors/index.js');
  const { registerLegacyChecks } = await import('../checks/index.js');

  registerAllExecutors();
  registerLegacyChecks();

  const { startRun } = await import('../matrix/runner.js');
  const { getRun } = await import('../services/runManager.js');

  const runId = await startRun({ url, options: { maxPages, maxDepth }, plan: null });
  console.log(`Scanning ${url} (run ${runId})...`);

  const deadline = Date.now() + timeout;
  let run;
  while (Date.now() < deadline) {
    run = await getRun(runId);
    if (run?.status === 'completed') break;
    if (run?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!run) throw new Error('Run never completed within timeout');

  return run;
}

export async function checkMain(argv = process.argv) {
  try {
    const { url, failOn, timeout, maxPages, maxDepth, json } = parseArgs(argv);
    process.stdout.write(`SQA Agent CI check — ${url}\n`);

    const run = await runCheck({ url, timeout, maxPages, maxDepth });
    const findings = run.findings || [];
    const compliance = await (async () => {
      try {
        const { computeCompliance } = await import('../services/compliance.js');
        return computeCompliance(run);
      } catch {
        return null;
      }
    })();

    if (json) {
      const out = {
        url,
        runId: run.runId,
        score: run.score,
        status: run.status,
        findings,
        compliance,
        threshold: failOn,
        failed: shouldFail(findings, failOn),
        timestamp: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(out, null, 2));
      process.stdout.write('\n');
    } else {
      printSummary({ url, score: run.score, findings, pages: run.pages?.length, compliance });
    }

    const failed = shouldFail(findings, failOn);
    if (failed) {
      process.stdout.write(`FAIL: findings at or above ${failOn} severity threshold\n`);
      return EXIT_THRESHOLD_EXCEEDED;
    }
    process.stdout.write(`PASS: no findings at or above ${failOn} severity threshold\n`);
    return EXIT_OK;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.stderr.write(err.stack + '\n');
    return EXIT_SCAN_FAILED;
  }
}
