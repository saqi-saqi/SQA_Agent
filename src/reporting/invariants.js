import { isCoverageFailure, isUnauthenticatedProbe } from '../services/scoring.js';
import { verdict } from '../services/report.js';
import { canonicalizeUrl } from '../utils/classify.js';
import { getNodeSignature } from '../matrix/matrixRunner.js';

export const ALWAYS_MEASURED_FIELDS = ['LCP', 'FCP', 'TTFB'];

/**
 * Validates a TestFlow report or run object against system-wide correctness invariants:
 *
 * 1. Count consistency:
 *    - Confirmed bugs count matches only actual CONFIRMED bug findings.
 *    - Confirmed + Suspected + Coverage-failures === Total findings shown.
 * 2. Coverage threshold vs quality label:
 *    - Scan coverage < threshold (default 80%) implies the score verdict cannot carry the top 'Excellent' quality label.
 * 3. No silent-zero metrics:
 *    - No finding's metrics object contains a literal 0 where the field is documented as "always measured"
 *      (LCP, FCP, TTFB) without an explicit measured:false / unmeasured flag alongside it.
 * 4. No duplicate findings:
 *    - No two findings share identical (ruleId, selector, url) within the same report.
 *
 * @param {object} report - Run or report object to validate
 * @param {object} [options={}] - Validation options
 * @param {number} [options.coverageThreshold=0.8] - Coverage ratio required for 'Excellent' (0.8 = 80%)
 * @param {boolean} [options.throwOnError=true] - Whether to throw an Error if validation fails
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateReport(report, options = {}) {
  const errors = [];
  const coverageThreshold = options.coverageThreshold ?? 0.8;
  const throwOnError = options.throwOnError ?? true;

  if (!report || typeof report !== 'object') {
    errors.push('Report object is null or not an object');
    if (throwOnError) {
      throw new Error(`Report invariant validation failed:\n- ${errors.join('\n- ')}`);
    }
    return { valid: false, errors };
  }

  const allFindings = Array.isArray(report.findings) ? report.findings : [];
  const coverageFailuresList = Array.isArray(report.coverageFailures) && report.coverageFailures.length > 0
    ? report.coverageFailures
    : allFindings.filter(isCoverageFailure);
  const unauthProbesList = Array.isArray(report.unauthenticatedProbes) && report.unauthenticatedProbes.length > 0
    ? report.unauthenticatedProbes
    : allFindings.filter(isUnauthenticatedProbe);

  // Content findings are normal findings excluding coverage failures and unauthenticated probes
  const contentFindings = allFindings.filter(f => !isCoverageFailure(f) && !isUnauthenticatedProbe(f));

  // 1. Count consistency check: Confirmed findings, Suspected findings, Coverage failures
  const actualConfirmedBugs = contentFindings.filter(
    f => f.confidence === 'confirmed' && (f.findingType === 'bug' || !f.findingType)
  ).length;

  const summary = report.summary || {};

  // Confirmed-bugs counter check (YouTube bug regression)
  if (summary.confirmedBugs != null && summary.confirmedBugs !== actualConfirmedBugs) {
    errors.push(
      `Confirmed-bugs counter mismatch: summary.confirmedBugs (${summary.confirmedBugs}) does not match actual CONFIRMED bug findings (${actualConfirmedBugs}).`
    );
  }

  // Coverage-failures counter check
  const actualCoverageFailures = coverageFailuresList.length;
  if (summary.coverageFailures != null && summary.coverageFailures !== actualCoverageFailures) {
    errors.push(
      `Coverage-failures counter mismatch: summary.coverageFailures (${summary.coverageFailures}) does not match actual coverage failures (${actualCoverageFailures}).`
    );
  }

  // Suspected counter check
  const actualSuspectedProbes = unauthProbesList.length;
  if (summary.unauthenticatedProbes != null && summary.unauthenticatedProbes !== actualSuspectedProbes) {
    errors.push(
      `Suspected probes counter mismatch: summary.unauthenticatedProbes (${summary.unauthenticatedProbes}) does not match actual suspected probes (${actualSuspectedProbes}).`
    );
  }

  // Confirmed + Suspected + Coverage-failures === Total findings shown
  const confirmedCount = actualConfirmedBugs;
  const suspectedCount = actualSuspectedProbes;
  const coverageCount = actualCoverageFailures;
  const expectedSum = confirmedCount + suspectedCount + coverageCount;

  // If a headline totalFindingsShown is present in the report or summary, verify the sum exactly equals it
  const displayedTotal = summary.totalFindingsShown ?? report.totalFindingsShown;
  if (displayedTotal != null && displayedTotal !== expectedSum) {
    errors.push(
      `Findings sum mismatch: Confirmed (${confirmedCount}) + Suspected (${suspectedCount}) + Coverage-failures (${coverageCount}) = ${expectedSum}, but displayed findings total is ${displayedTotal}.`
    );
  }

  // 2. Coverage threshold vs quality label check
  const pagesAttempted = report.coverage?.pagesAttempted ?? (report.pages ? report.pages.length : (report.options?.maxPages || 1));
  const pagesScanned = report.coverage?.pagesScanned ?? Math.max(0, pagesAttempted - actualCoverageFailures);
  const coverageRatio = report.coverage?.coverageRatio ?? (pagesAttempted > 0 ? pagesScanned / pagesAttempted : 1.0);

  const reportLabel = report.verdict?.label || report.label;
  const computedVerdict = verdict(report.score, coverageRatio);
  if (coverageRatio < coverageThreshold && (reportLabel === 'Excellent' || computedVerdict.label === 'Excellent')) {
    errors.push(
      `Quality label violation: Scan coverage is ${(coverageRatio * 100).toFixed(1)}% (below ${coverageThreshold * 100}% threshold), but score verdict carries top 'Excellent' label.`
    );
  }

  // 3. No silent-zero metrics check
  for (const f of allFindings) {
    const metrics = f.metrics;
    if (metrics && typeof metrics === 'object') {
      for (const field of ALWAYS_MEASURED_FIELDS) {
        const val = metrics[field];
        if (val === 0) {
          // Check for explicit unmeasured flags
          const isExplicitlyUnmeasured =
            metrics.measured?.[field] === false ||
            metrics[field + '_measured'] === false ||
            (Array.isArray(metrics._unmeasured) && metrics._unmeasured.includes(field)) ||
            (typeof val === 'object' && val !== null && val.measured === false);

          if (!isExplicitlyUnmeasured) {
            errors.push(
              `Silent-zero metric violation: Finding '${f.id || f.title}' has metric '${field}' with literal 0 value without an explicit measured:false or unmeasured flag.`
            );
          }
        }
      }
    }
  }

  // 4. No duplicate findings check (ruleId + selector + url within same report)
  const seenSignatures = new Map();
  for (const f of allFindings) {
    const ruleId = f.ruleId || 'gen';
    const selector = getNodeSignature(f);
    const rawUrl = f.pageUrl || f.url || '';
    const normUrl = canonicalizeUrl(rawUrl);
    const key = `${ruleId}::${selector}::${normUrl}`;

    if (seenSignatures.has(key)) {
      errors.push(
        `Duplicate finding violation: Findings '${seenSignatures.get(key).id || 'first'}' and '${f.id || 'second'}' share identical key (${key}) within the same report.`
      );
    } else {
      seenSignatures.set(key, f);
    }
  }

  const isValid = errors.length === 0;
  if (!isValid && throwOnError) {
    const message = `Report invariant validation failed with ${errors.length} error(s):\n- ${errors.join('\n- ')}`;
    const err = new Error(message);
    err.validationErrors = errors;
    throw err;
  }

  return { valid: isValid, errors };
}
