/**
 * Finding factory – creates structured QA findings with v2 fields:
 * confidence, findingType, origin, ruleId, occurrences, affectedPages, affectedElements.
 *
 * IDs are prefixed by category (A11Y-001, LINK-001, NET-001, etc.).
 */

const CATEGORY_PREFIXES = {
  links: 'LINK',
  console: 'JS',
  network: 'NET',
  accessibility: 'A11Y',
  seo: 'SEO',
  performance: 'PERF',
};

export function createFindingFactory() {
  const counters = {};

  /**
   * @param {Object} opts
   * @param {string}   opts.title
   * @param {'critical'|'high'|'medium'|'low'|'info'} opts.severity
 * @param {'confirmed'|'high'|'medium'|'low'} [opts.confidence='confirmed']
   * @param {string}   opts.category       – 'links' | 'console' | 'network' | 'accessibility' | 'seo' | 'performance'
 * @param {'bug'|'warning'|'recommendation'|'informational'|'environmental'} [opts.findingType='bug']
   * @param {'first-party'|'third-party'|null} [opts.origin=null]
   * @param {string|null} [opts.ruleId=null]        – dedup key (e.g. 'image-alt')
   * @param {string}   opts.pageUrl
   * @param {string}   [opts.description]
   * @param {string}   [opts.evidence]
   * @param {string|null} [opts.screenshot]
   * @param {string[]} [opts.reproSteps]
   * @param {string}   [opts.suggestedFix]
   * @param {number}   [opts.occurrences=1]         – raw instance count this finding represents
   * @param {string[]} [opts.affectedPages]          – all page URLs where this was observed
   * @param {number|null} [opts.affectedElements]    – DOM element count
   */
  return function createFinding({
    title,
    severity,
    confidence,
    category,
    findingType,
    origin,
    ruleId,
    pageUrl,
    description,
    evidence,
    screenshot,
    reproSteps,
    suggestedFix,
    occurrences,
    affectedPages,
    affectedElements,
  }) {
    const prefix = CATEGORY_PREFIXES[category] || 'GEN';
    counters[prefix] = (counters[prefix] || 0) + 1;
    const id = `${prefix}-${String(counters[prefix]).padStart(3, '0')}`;

    return {
      id,
      title,
      severity:         severity || 'info',
      confidence:       confidence || 'confirmed',
      category:         category || 'general',
      findingType:      findingType || 'bug',
      origin:           origin || null,
      ruleId:           ruleId || null,
      pageUrl,
      description:      description || '',
      evidence:         evidence || '',
      screenshot:       screenshot || null,
      reproSteps:       reproSteps || [],
      suggestedFix:     suggestedFix || '',
      occurrences:      occurrences || 1,
      affectedPages:    affectedPages || (pageUrl ? [pageUrl] : []),
      affectedElements: affectedElements || null,
    };
  };
}
