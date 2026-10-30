/**
 * mcp/reporting.js — build structured, agent-facing reports from run objects.
 *
 * Every response returned by any MCP tool passes through buildMcpReport():
 *   • silent-zero metrics are normalized (0 where unmeasured → null +
 *     explicit unmeasured flag),
 *   • URLs and free text are redacted via mcp/redact.js,
 *   • the result is checked with the shared validateReport() invariant
 *     gate (src/reporting/invariants.js) — if it fails, the report is NOT
 *     returned; the caller gets the validation errors instead, because an
 *     agent acting on a malformed report has no human to notice.
 */
import { validateReport, ALWAYS_MEASURED_FIELDS } from '../reporting/invariants.js';
import { isCoverageFailure, isUnauthenticatedProbe } from '../services/scoring.js';
import { redactFinding, sanitizeUrl } from './redact.js';

/**
 * No raw 0 may appear for an "always measured" metric without an explicit
 * unmeasured flag. A real measurement of 0ms is not physically plausible
 * for LCP/FCP/TTFB, so a literal 0 means "probe did not produce a value" —
 * we convert it to null plus an unmeasured marker. (Design choice, flagged:
 * we normalize rather than reject, so a broken perf probe degrades the
 * report's honesty instead of failing the whole tool call.)
 */
export function normalizeSilentZeros(findings) {
  for (const f of findings) {
    const metrics = f?.metrics;
    if (!metrics || typeof metrics !== 'object') continue;
    for (const field of ALWAYS_MEASURED_FIELDS) {
      if (metrics[field] === 0) {
        metrics[field] = null;
        if (!Array.isArray(metrics._unmeasured)) metrics._unmeasured = [];
        if (!metrics._unmeasured.includes(field)) metrics._unmeasured.push(field);
        metrics.measured = { ...(metrics.measured || {}), [field]: false };
      }
    }
  }
  return findings;
}

/**
 * Build a compact structured report from a run object.
 *
 * @param {object} run   — run object (findings, score, coverage, summary…)
 * @param {object} [opts]
 * @param {'summary'|'full'} [opts.verbosity='summary']
 * @returns {{ report: object|null, validation: {valid: boolean, errors: string[]} }}
 */
export function buildMcpReport(run, { verbosity = 'summary' } = {}) {
  if (!run || typeof run !== 'object') {
    return { report: null, validation: { valid: false, errors: ['Run object is null or not an object'] } };
  }

  const findings = normalizeSilentZeros(
    (Array.isArray(run.findings) ? run.findings : []).map(f => structuredCloneSafe(f))
  );

  // Classification MUST match the validator's own helpers exactly
  // (isCoverageFailure / isUnauthenticatedProbe) or the counter invariants
  // will false-fail. Findings outside all three buckets land in "other" so
  // nothing silently disappears from an agent's view.
  const confirmed = findings.filter(f =>
    !isCoverageFailure(f) && !isUnauthenticatedProbe(f) &&
    f.confidence === 'confirmed' && (f.findingType === 'bug' || !f.findingType)
  );
  const suspected = findings.filter(f =>
    !isCoverageFailure(f) && isUnauthenticatedProbe(f)
  );
  const coverageFailures = findings.filter(isCoverageFailure);
  const other = findings.filter(f =>
    !confirmed.includes(f) && !suspected.includes(f) && !coverageFailures.includes(f)
  );

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of confirmed) {
    if (bySeverity[f.severity] !== undefined) bySeverity[f.severity]++;
  }

  // Coverage — prefer the run's own record; derive from findings otherwise.
  const coverage = run.coverage && typeof run.coverage === 'object'
    ? { ...run.coverage }
    : deriveCoverage(run, coverageFailures.length);

  const report = {
    schemaVersion: 1,
    source: 'testflow-mcp',
    runId: run.runId || null,
    url: sanitizeUrl(run.url || ''),
    status: run.status || 'unknown',
    score: typeof run.score === 'number' ? run.score : null,
    summary: {
      // The headline total is exactly what validateReport checks the sum against.
      totalFindingsShown: confirmed.length + suspected.length + coverageFailures.length,
      confirmedBugs: confirmed.length,
      unauthenticatedProbes: suspected.length,
      coverageFailures: coverageFailures.length,
      bySeverity,
    },
    coverage,
    confirmed: confirmed.map(f => redactFinding(f, verbosity)),
    suspected: suspected.map(f => redactFinding(f, verbosity)),
    otherCount: other.length,
    other: other.map(f => redactFinding(f, verbosity)),
    coverageFailures: coverageFailures.map(f => ({
      rule: f.ruleId || 'page-load-failure',
      url: sanitizeUrl(f.pageUrl || f.url || ''),
      reason: (f.description || f.evidence || 'page failed to load').slice(0, 300),
      blockedExecutors: f.blockedExecutors || null,
    })),
    // Flat union of every finding in redacted form. validateReport() reads
    // this array to re-derive the bucket counts — the summary counters and
    // the findings the agent sees are therefore always the same numbers.
    findings: [
      ...confirmed, ...suspected, ...coverageFailures, ...other,
    ].map(f => redactFinding(f, verbosity)),
  };

  if (verbosity === 'full') {
    // Everything else, for when the agent explicitly asks for full detail.
    report.allFindings = findings.map(f => redactFinding(f, 'full'));
    if (run.summary) report.runSummary = run.summary;
  }

  const validation = validateReport(report, { throwOnError: false });
  if (!validation.valid) {
    // Never hand an agent a report that fails the invariants — the errors
    // ARE the response.
    return { report: null, validation };
  }
  return { report, validation };
}

function deriveCoverage(run, coverageFailureCount) {
  const pagesAttempted = Array.isArray(run.pages)
    ? run.pages.length
    : (run.options?.maxPages || 1);
  const pagesScanned = Math.max(0, pagesAttempted - coverageFailureCount);
  return {
    pagesAttempted,
    pagesScanned,
    coverageRatio: pagesAttempted > 0 ? pagesScanned / pagesAttempted : 1.0,
  };
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value ?? null));
  }
}
