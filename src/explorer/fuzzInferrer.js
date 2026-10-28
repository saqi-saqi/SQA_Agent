/**
 * fuzzInferrer.js — propose fuzz targets for every input field + API field.
 *
 * Heuristic, no LLM needed. The "full matrix" coverage bar means we err
 * on the side of proposing more targets — the human approver can prune.
 *
 * For form inputs we use selectors derived from the crawled page's imageDetails
 * (which already include id / data-testid / nth-of-type fallbacks).
 * For API endpoints we propose fuzzing each top-level field of the
 * observed request body.
 */
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';

const FuzzTargetSchema = arrayElementSchema(TestPlan.shape.fuzzTargets);

// Default generator set for unknown input types — covers boundary + injection.
const DEFAULT_GENERATORS = ['empty', 'oversize', 'unicode', 'sql', 'xss'];

// Type-specific generator sets — keep tight to avoid 1000s of iterations.
const TYPE_GENERATORS = {
  email:    ['empty', 'oversize', 'unicode', 'sql', 'xss'],
  password: ['empty', 'oversize', 'unicode'],
  number:   ['empty', 'numeric-overflow', 'negative', 'null-byte'],
  tel:      ['empty', 'oversize', 'unicode'],
  text:     ['empty', 'oversize', 'unicode', 'sql', 'xss', 'path'],
  search:   ['empty', 'oversize', 'unicode', 'sql', 'xss'],
  url:      ['empty', 'oversize', 'unicode', 'sql', 'xss', 'path'],
};

function generatorsForInput(input) {
  const type = (input.type || 'text').toLowerCase();
  return TYPE_GENERATORS[type] || DEFAULT_GENERATORS;
}

/**
 * Infer fuzz targets from crawled form inputs.
 * The crawler's `imageDetails`-equivalent for inputs isn't captured by the
 * current crawler.js — but `forms`, `buttons`, `inputs` counts are. To do
 * this properly we need the per-input DOM data, so for now we re-extract
 * from the live Playwright page if available, OR rely on the page having
 * an `inputDetails[]` field (Phase 1.5 enhancement).
 *
 * For Phase 1, we generate per-page fuzz targets using a generic selector
 * ('input, textarea, select') so the executor can walk them at runtime.
 */
export function inferFuzzTargetsFromPages(pages) {
  const targets = [];

  for (const page of pages || []) {
    // Skip pages with no inputs
    if (!page.inputs || page.inputs === 0) continue;

    // Phase 1 generic target: "fuzz all inputs on this page"
    // Phase 1.5 will split this into per-input targets once crawler exposes inputDetails.
    const target = {
      pageUrl: page.url,
      formSelector: 'form',  // matches first form on page; executor can iterate
      fieldSelector: 'input, textarea, select',
      generators: DEFAULT_GENERATORS,
      iterations: 20,        // per generator, so ~100 inputs per page max
      expectStatus: 'no-5xx',
    };

    const parsed = FuzzTargetSchema.safeParse(target);
    if (parsed.success) targets.push(parsed.data);
  }

  return targets;
}

/**
 * Infer fuzz targets for API endpoints — one target per endpoint
 * that has an observed request body with top-level fields.
 */
export function inferFuzzTargetsFromEndpoints(endpoints) {
  const targets = [];

  for (const ep of endpoints || []) {
    // If we don't have a sample request body, skip
    if (!ep.requestSchema || typeof ep.requestSchema !== 'object') continue;
    const fields = Object.keys(ep.requestSchema);
    if (fields.length === 0) continue;

    for (const field of fields) {
      const target = {
        apiEndpointRef: ep.path,
        field,
        generators: DEFAULT_GENERATORS,
        iterations: 10,
        expectStatus: 'no-5xx',
      };
      const parsed = FuzzTargetSchema.safeParse(target);
      if (parsed.success) targets.push(parsed.data);
    }
  }

  return targets;
}

export function inferFuzzTargets({ pages, endpoints }) {
  const fromPages = inferFuzzTargetsFromPages(pages);
  const fromApis = inferFuzzTargetsFromEndpoints(endpoints);
  return [...fromPages, ...fromApis];
}
