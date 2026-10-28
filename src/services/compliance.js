/**
 * services/compliance.js — WCAG 2.x conformance scoring (zero LLM, pure code).
 *
 * Turns the run's axe-core findings into a compliance statement:
 *   { conformancePct, criteria[], blockers[], levels{A,AA,bestPractice} }
 *
 * Mapping: each axe rule used by the accessibility executor maps to a WCAG
 * 2.x success criterion (or "best practice" — axe rules with no SC, which
 * are reported but NOT counted in the conformance percentage, matching how
 * WCAG conformance is actually claimed).
 */

// axe rule id (without the `axe-` prefix) → WCAG 2.x success criterion.
// `criterion: null` = W3C/axe "best practice" rule — valuable, but not a
// WCAG success criterion, so excluded from the conformance percentage.
export const AXE_RULE_WCAG_MAP = {
  'image-alt':             { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'bypass':                { criterion: '2.4.1', title: 'Bypass Blocks',                 level: 'A'  },
  'document-title':        { criterion: '2.4.2', title: 'Page Titled',                   level: 'A'  },
  'tabindex':              { criterion: '2.4.3', title: 'Focus Order',                   level: 'A'  },
  'html-has-lang':         { criterion: '3.1.1', title: 'Language of Page',              level: 'A'  },
  'label':                 { criterion: '3.3.2', title: 'Labels or Instructions',        level: 'A'  },
  'button-name':           { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'link-name':             { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'nested-interactive':    { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-required-attr':    { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-valid-attr':       { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-roles':            { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'color-contrast':        { criterion: '1.4.3', title: 'Contrast (Minimum)',            level: 'AA' },
  'valid-lang':            { criterion: '3.1.2', title: 'Language of Parts',             level: 'AA' },
  // Best practices — reported, excluded from the WCAG percentage
  'heading-order':         { criterion: null, title: 'Heading levels increase by one' },
  'page-has-heading-one':  { criterion: null, title: 'Page has a level-one heading' },
  'landmark-one-main':     { criterion: null, title: 'Document has one main landmark' },
  'region':                { criterion: null, title: 'All content in landmarks' },
  'focus-order-semantics': { criterion: null, title: 'Focusable elements have sensible semantics' },
};

const SEV_RANK = { info: 0, low: 1, medium: 2, serious: 2.5, high: 3, critical: 4 };

/**
 * Compute the WCAG conformance statement for a run.
 *
 * @param {object} run — a run object (findings + optional plan.a11yRules)
 * @returns {object} { conformancePct, criteria, blockers, levels, checkedCount, violatedCount }
 */
export function computeCompliance(run) {
  const findings = run?.findings || [];
  const a11yFindings = findings.filter(f =>
    typeof f.ruleId === 'string' && f.ruleId.startsWith('axe-') &&
    f.findingType !== 'informational' && f.findingType !== 'environmental' &&
    f.confidence !== 'suspected'
  );

  // Which axe rules actually ran? Prefer the plan (it reflects the rules
  // used for THIS run); fall back to the full default map.
  const ranRules = (run?.plan?.a11yRules || []).map(r => r.rule).filter(Boolean);
  const ruleIds = ranRules.length ? ranRules : Object.keys(AXE_RULE_WCAG_MAP);

  // Violated rules: axe rule ids with confirmed findings
  const violatedRules = new Map(); // ruleId (bare) → { worstSeverity, occurrences, pages }
  for (const f of a11yFindings) {
    const bare = f.ruleId.replace(/^axe-/, '');
    if (!AXE_RULE_WCAG_MAP[bare]) continue; // unknown rule — ignore
    const existing = violatedRules.get(bare);
    const occurrences = f.occurrences || 1;
    if (!existing) {
      violatedRules.set(bare, { worstSeverity: f.severity, occurrences, pages: new Set(f.affectedPages?.length ? f.affectedPages : [f.pageUrl].filter(Boolean)) });
    } else {
      existing.occurrences += occurrences;
      for (const p of (f.affectedPages?.length ? f.affectedPages : [f.pageUrl].filter(Boolean))) existing.pages.add(p);
      if ((SEV_RANK[f.severity] || 0) > (SEV_RANK[existing.worstSeverity] || 0)) existing.worstSeverity = f.severity;
    }
  }

  // Build per-criterion status for every mapped rule that ran
  const criteriaMap = new Map(); // criterion → entry
  const bestPractice = [];
  for (const ruleId of ruleIds) {
    const mapping = AXE_RULE_WCAG_MAP[ruleId];
    if (!mapping) continue;
    const violation = violatedRules.get(ruleId) || null;

    if (!mapping.criterion) {
      bestPractice.push({
        rule: ruleId,
        title: mapping.title,
        status: violation ? 'fail' : 'pass',
        severity: violation?.worstSeverity || null,
        occurrences: violation?.occurrences || 0,
      });
      continue;
    }

    if (!criteriaMap.has(mapping.criterion)) {
      criteriaMap.set(mapping.criterion, {
        criterion: mapping.criterion,
        title: mapping.title,
        level: mapping.level,
        rules: [],
        status: 'pass',
        severity: null,
        occurrences: 0,
        pages: new Set(),
      });
    }
    const entry = criteriaMap.get(mapping.criterion);
    entry.rules.push(ruleId);
    if (violation) {
      entry.status = 'fail';
      entry.occurrences += violation.occurrences;
      for (const p of violation.pages) entry.pages.add(p);
      if (!entry.severity || (SEV_RANK[violation.worstSeverity] || 0) > (SEV_RANK[entry.severity] || 0)) {
        entry.severity = violation.worstSeverity;
      }
    }
  }

  const criteria = Array.from(criteriaMap.values())
    .map(c => ({ ...c, pages: [...c.pages] }))
    .sort((a, b) => a.criterion.localeCompare(b.criterion));

  const levels = { A: { checked: 0, violated: 0 }, AA: { checked: 0, violated: 0 } };
  const blockers = [];
  for (const c of criteria) {
    levels[c.level].checked++;
    if (c.status === 'fail') {
      levels[c.level].violated++;
      if (c.severity === 'critical' || c.severity === 'serious' || c.severity === 'high') {
        blockers.push(c);
      }
    }
  }

  const checkedCount = levels.A.checked + levels.AA.checked;
  const violatedCount = levels.A.violated + levels.AA.violated;
  const conformancePct = checkedCount === 0
    ? 100
    : Math.round(((checkedCount - violatedCount) / checkedCount) * 100);

  const bpFailed = bestPractice.filter(b => b.status === 'fail');

  return {
    conformancePct,
    checkedCount,
    violatedCount,
    levels: {
      A: { ...levels.A, pct: levels.A.checked ? Math.round(((levels.A.checked - levels.A.violated) / levels.A.checked) * 100) : 100 },
      AA: { ...levels.AA, pct: levels.AA.checked ? Math.round(((levels.AA.checked - levels.AA.violated) / levels.AA.checked) * 100) : 100 },
      bestPractice: { checked: bestPractice.length, violated: bpFailed.length },
    },
    criteria,
    bestPractice,
    blockers: blockers.map(b => ({ ...b, pages: [...b.pages] })),
    // Honest limitation note — automated a11y testing catches only a subset
    limitation: 'Automated testing covers a subset of WCAG criteria. Manual testing (keyboard, screen reader, cognition) is required for full conformance claims.',
  };
}
