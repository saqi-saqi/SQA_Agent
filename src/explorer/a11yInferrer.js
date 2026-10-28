/**
 * a11yInferrer.js — propose accessibility rules to enforce.
 *
 * Heuristic, no LLM. The "full matrix" coverage bar means we apply a
 * comprehensive axe-core rule set by default, plus tighten specific rules
 * based on observed page structure (e.g. if images are present, require
 * image-alt; if forms are present, require label associations).
 */
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';

const A11yRuleSchema = arrayElementSchema(TestPlan.shape.a11yRules);

// Default rule set — covers WCAG 2.1 AA + common pitfalls
const DEFAULT_RULES = [
  { rule: 'color-contrast',          level: 'serious' },
  { rule: 'image-alt',               level: 'critical' },
  { rule: 'label',                   level: 'critical' },    // form labels
  { rule: 'button-name',             level: 'critical' },      // accessible button text
  { rule: 'link-name',               level: 'critical' },      // accessible link text
  { rule: 'html-has-lang',           level: 'serious' },
  { rule: 'valid-lang',             level: 'moderate' },
  { rule: 'document-title',         level: 'serious' },
  { rule: 'heading-order',          level: 'moderate' },
  { rule: 'landmark-one-main',      level: 'moderate' },
  { rule: 'region',                 level: 'moderate' },
  { rule: 'tabindex',               level: 'moderate' },
  { rule: 'aria-required-attr',      level: 'critical' },
  { rule: 'aria-valid-attr',         level: 'serious' },
  { rule: 'aria-roles',              level: 'critical' },
  { rule: 'focus-order-semantics',   level: 'moderate' },
  { rule: 'nested-interactive',      level: 'serious' },
  { rule: 'page-has-heading-one',    level: 'moderate' },
  { rule: 'bypass',                  level: 'serious' },       // skip-to-content link
];

export function inferA11yRules({ pages }) {
  const rules = [...DEFAULT_RULES];

  // Page-specific overrides — tighten rules based on observed content.
  // (Phase 1 keeps this minimal — Phase 2 can add per-page scoping.)
  const hasImages = (pages || []).some(p => p.imageDetails && p.imageDetails.length > 0);
  const hasForms = (pages || []).some(p => p.forms && p.forms > 0);

  // If no forms anywhere, drop the form-label rule (avoids noise).
  if (!hasForms) {
    const idx = rules.findIndex(r => r.rule === 'label');
    if (idx >= 0) rules.splice(idx, 1);
  }
  // If no images anywhere, drop image-alt.
  if (!hasImages) {
    const idx = rules.findIndex(r => r.rule === 'image-alt');
    if (idx >= 0) rules.splice(idx, 1);
  }

  // Validate each rule against the schema (defense-in-depth — schema is
  // strict so we want to catch any drift between this list and the schema).
  return rules
    .map(r => A11yRuleSchema.safeParse(r))
    .filter(r => r.success)
    .map(r => r.data);
}
