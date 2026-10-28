/**
 * Calculates a score based on findings.
 * @param {Array<Object>} findings - The list of findings.
 * @returns {number} The calculated score (0-100).
 */
export function calculateScore(findings) {
  if (!findings || findings.length === 0) return 100;

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
    const base = severityBase[finding.severity] || 0;
    
    // Default multipliers if unexpected value is present
    const confMult = confidenceMultiplier[finding.confidence] ?? 1.0;
    const typeMult = findingTypeMultiplier[finding.findingType] ?? 1.0;
    
    // Origin defaults to 1.0, third-party applies a 0.2 multiplier
    let originMult = 1.0;
    if (finding.origin === 'third-party') {
      originMult = 0.2;
    }

    const deduction = base * confMult * typeMult * originMult;
    totalDeductions += deduction;
  }

  // Score formula: score = max(0, min(100, 100 - totalDeductions))
  return Math.max(0, Math.min(100, 100 - totalDeductions));
}

/**
 * Summarizes findings and returns a rich summary object.
 * @param {Array<Object>} findings - The list of findings.
 * @param {Array<Object>|number} pages - The pages evaluated or total page count.
 * @returns {Object} The rich summary of the evaluation.
 */
export function summarizeFindings(findings, pages) {
  const totalPages = Array.isArray(pages) ? pages.length : (typeof pages === 'number' ? pages : 0);
  
  const summary = {
    totalPages,
    totalFindings: findings ? findings.length : 0,
    totalOccurrences: 0,
    score: calculateScore(findings || []),
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    byCategory: {},
    byConfidence: { confirmed: 0, high: 0, medium: 0, low: 0 },
    byFindingType: { bug: 0, warning: 0, recommendation: 0, informational: 0, environmental: 0 },
    byOrigin: { 'first-party': 0, 'third-party': 0, unknown: 0 },
    confirmedBugs: 0,
    observationCount: 0,
    recommendationCount: 0
  };

  if (!findings) return summary;

  for (const finding of findings) {
    // Total occurrences
    summary.totalOccurrences += finding.occurrences || 1;

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
    if (finding.confidence === 'confirmed' && finding.findingType === 'bug') {
      summary.confirmedBugs++;
    }

    if (finding.findingType === 'warning') {
      summary.observationCount++;
    }

    if (finding.findingType === 'recommendation') {
      summary.recommendationCount++;
    }
  }

  return summary;
}
