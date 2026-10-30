import { config } from '../utils/config.js';

/**
 * Check if a finding is a coverage / page-load failure rather than a content issue.
 */
export function isCoverageFailure(finding) {
  if (!finding) return false;
  if (
    finding.category === 'Scan Coverage' ||
    finding.category === 'coverage' ||
    finding.findingType === 'coverage-failure' ||
    finding.ruleId === 'page-load-failure'
  ) {
    return true;
  }
  // Recognize legacy miscategorized page errors
  if (
    finding.ruleId === 'axe-page-error' ||
    finding.ruleId === 'perf-measurement-error' ||
    finding.ruleId === 'visual-capture-error'
  ) {
    return true;
  }
  return false;
}

/**
 * Check if a finding is an unauthenticated API probe failure (suspected missing session/CSRF).
 */
export function isUnauthenticatedProbe(finding) {
  if (!finding) return false;
  if (finding.unauthenticated === true || finding.unauthenticatedProbe === true) return true;
  if (finding.confidence === 'suspected') {
    const text = `${finding.description || ''} ${finding.evidence || ''} ${finding.title || ''}`;
    if (/session or CSRF|requires session|session-gated|replayed.*anonymously|missing session/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Calculates a score based on findings and scan coverage.
 * @param {Array<Object>} findings - The list of findings.
 * @param {Object|number} [options={}] - Scoring options or coverage ratio.
 * @param {number} [options.pagesAttempted] - Total pages attempted.
 * @param {number} [options.pagesScanned] - Total pages successfully scanned.
 * @param {number} [options.coverageRatio] - Ratio of scanned / attempted (0-1).
 * @param {boolean} [options.excludeUnauthenticated] - Exclude suspected unauthenticated replays.
 * @returns {number} The calculated score (0-100).
 */
export function calculateScore(findings, options = {}) {
  const excludeUnauth = typeof options === 'object' && options?.excludeUnauthenticated != null
    ? options.excludeUnauthenticated
    : (config?.excludeUnauthenticatedFromScoring ?? true);

  let coverageRatio = 1.0;
  if (typeof options === 'number') {
    coverageRatio = Math.min(1, Math.max(0, options));
  } else if (typeof options === 'object' && options !== null) {
    if (options.coverageRatio != null) {
      coverageRatio = Math.min(1, Math.max(0, options.coverageRatio));
    } else if (options.pagesAttempted > 0) {
      const scanned = options.pagesScanned != null ? options.pagesScanned : options.pagesAttempted;
      coverageRatio = Math.min(1, Math.max(0, scanned / options.pagesAttempted));
    }
  }

  if (!findings || findings.length === 0) {
    const rawScore = 100;
    return coverageRatio < 1.0 ? Math.round(rawScore * coverageRatio * 10) / 10 : 100;
  }

  const severityBase = {
    critical: 15,
    high: 8,
    medium: 4,
    low: 1.5,
    info: 0
  };

  const confidenceMultiplier = {
    confirmed: 1.0,
    high: 0.7,
    medium: 0.35,
    low: 0,
    // Legacy persisted runs remain readable without affecting new scoring.
    probable: 0.7, suspected: 0.3, informational: 0, environmental: 0
  };

  const findingTypeMultiplier = {
    bug: 1.0,
    warning: 0.35,
    recommendation: 0.1,
    informational: 0,
    environmental: 0,
    observation: 0.5 // legacy
  };

  let totalDeductions = 0;

  for (const finding of findings) {
    // Coverage failures are infrastructure issues, not content quality defects
    if (isCoverageFailure(finding)) {
      continue;
    }

    // Exclude suspected unauthenticated API replay failures if configured
    if (excludeUnauth && isUnauthenticatedProbe(finding)) {
      continue;
    }

    const base = severityBase[finding.severity] || 0;
    
    // Default multipliers if unexpected value is present
    const confMult = confidenceMultiplier[finding.confidence] ?? 1.0;
    let typeMult = findingTypeMultiplier[finding.findingType] ?? 1.0;
    // In aggressive detection mode (!excludeUnauth), unauthenticated probe findings
    // are penalized as defects rather than ignored as environmental
    if (!excludeUnauth && isUnauthenticatedProbe(finding) && typeMult === 0) {
      typeMult = 0.35;
    }
    
    // Origin defaults to 1.0, third-party applies a 0.2 multiplier
    let originMult = 1.0;
    if (finding.origin === 'third-party') {
      originMult = 0.2;
    }

    const deduction = base * confMult * typeMult * originMult;
    totalDeductions += deduction;
  }

  // Score formula: rawScore = max(0, min(100, 100 - totalDeductions))
  const rawScore = Math.max(0, Math.min(100, 100 - totalDeductions));

  // Factor coverage ratio into the quality score directly
  if (coverageRatio < 1.0) {
    return Math.round(rawScore * coverageRatio * 10) / 10;
  }

  return rawScore;
}

/**
 * Summarizes findings and returns a rich summary object.
 * @param {Array<Object>} findings - The list of findings.
 * @param {Array<Object>|number} pages - The pages evaluated or total page count.
 * @param {Object} [options={}] - Options for scoring and filtering.
 * @returns {Object} The rich summary of the evaluation.
 */
export function summarizeFindings(findings, pages, options = {}) {
  const totalPages = Array.isArray(pages) ? pages.length : (typeof pages === 'number' ? pages : 0);
  const excludeUnauth = options?.excludeUnauthenticated != null
    ? options.excludeUnauthenticated
    : (config?.excludeUnauthenticatedFromScoring ?? true);

  const summary = {
    totalPages,
    totalFindings: 0,
    totalOccurrences: 0,
    score: 100,
    coverageFailures: 0,
    unauthenticatedProbes: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    byCategory: {},
    byConfidence: { confirmed: 0, high: 0, medium: 0, low: 0 },
    byFindingType: { bug: 0, warning: 0, recommendation: 0, informational: 0, environmental: 0 },
    byOrigin: { 'first-party': 0, 'third-party': 0, unknown: 0 },
    confirmedBugs: 0,
    observationCount: 0,
    recommendationCount: 0
  };

  if (!findings) {
    summary.score = calculateScore([], { ...options, pagesAttempted: totalPages });
    return summary;
  }

  for (const finding of findings) {
    const isCoverage = isCoverageFailure(finding);
    const isUnauth = excludeUnauth && isUnauthenticatedProbe(finding);

    if (isCoverage) {
      summary.coverageFailures++;
    } else if (isUnauth) {
      summary.unauthenticatedProbes++;
    } else {
      // Normal content finding
      summary.totalFindings++;
      summary.totalOccurrences += finding.occurrences || 1;

      if (finding.confidence === 'confirmed' && finding.findingType === 'bug') {
        summary.confirmedBugs++;
      }
    }

    // Severity count
    if (finding.severity && summary.bySeverity.hasOwnProperty(finding.severity)) {
      summary.bySeverity[finding.severity]++;
    }

    // Category count
    if (finding.category) {
      summary.byCategory[finding.category] = (summary.byCategory[finding.category] || 0) + 1;
    }

    // Confidence count
    if (finding.confidence && summary.byConfidence.hasOwnProperty(finding.confidence)) {
      summary.byConfidence[finding.confidence]++;
    }

    // FindingType count
    if (finding.findingType && summary.byFindingType.hasOwnProperty(finding.findingType)) {
      summary.byFindingType[finding.findingType]++;
    }

    // Origin count
    const originKey = (finding.origin === 'first-party' || finding.origin === 'third-party') ? finding.origin : 'unknown';
    summary.byOrigin[originKey]++;

    // Additional aggregates
    if (!isCoverage && !isUnauth) {
      if (finding.findingType === 'warning') {
        summary.observationCount++;
      }

      if (finding.findingType === 'recommendation') {
        summary.recommendationCount++;
      }
    }
  }

  // Calculate coverage if not explicitly supplied
  const coverageOpts = { ...options };
  if (coverageOpts.pagesAttempted == null && totalPages > 0) {
    coverageOpts.pagesAttempted = totalPages;
    if (coverageOpts.pagesScanned == null) {
      coverageOpts.pagesScanned = Math.max(0, totalPages - summary.coverageFailures);
    }
  }

  summary.score = calculateScore(findings, coverageOpts);

  return summary;
}
