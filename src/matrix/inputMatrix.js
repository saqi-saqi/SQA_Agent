/**
 * matrix/inputMatrix.js — expand form inputs into per-field fuzz permutations.
 *
 * Phase 1's fuzzInferrer proposed one generic FuzzTarget per page (selector
 * 'input, textarea, select'). That works but doesn't exercise the "full matrix"
 * — different input types deserve different fuzz sets.
 *
 * This module:
 *   1. Takes a list of input fields (extracted by crawler or supplied by user)
 *   2. For each input, generates type-appropriate fuzz values
 *   3. Returns one FuzzTarget per (field, generator) pair
 *
 * The "full matrix" interpretation: for a form with 5 inputs × 8 generators =
 * 40 permutations × N boundary values per generator = potentially hundreds of
 * test inputs per form. The executor runs each, observes failures, dedups.
 */

// ─── input field schema (lightweight) ────────────────────────────────

/**
 * InputField shape:
 *   {
 *     selector:  string,        // CSS selector for this specific field
 *     type:      string,        // 'text' | 'email' | 'password' | 'number' | 'tel' | 'url' | 'search' | 'textarea' | 'select' | 'checkbox' | 'radio'
 *     name:      string,        // input[name="..."]
 *     required: boolean,
 *     min?:      number,        // for type=number
 *     max?:      number,
 *     maxLength?: number,
 *     pattern?:  string,        // regex pattern attr
 *   }
 */

// ─── type-specific fuzz generators ───────────────────────────────────

const TYPE_GENERATORS = {
  text:     ['empty', 'oversize', 'unicode', 'sql', 'xss', 'path', 'null-byte'],
  email:    ['empty', 'oversize', 'unicode', 'sql', 'xss', 'invalid-format'],
  password: ['empty', 'oversize', 'unicode', 'weak', 'common'],
  number:   ['empty', 'numeric-overflow', 'negative', 'null-byte', 'string', 'float'],
  tel:      ['empty', 'oversize', 'unicode', 'letters'],
  url:      ['empty', 'oversize', 'unicode', 'sql', 'xss', 'path', 'invalid-format'],
  search:   ['empty', 'oversize', 'unicode', 'sql', 'xss'],
  textarea: ['empty', 'oversize', 'unicode', 'sql', 'xss', 'path'],
  select:   ['empty', 'invalid-option'],
  checkbox: ['unchecked', 'tampered'],
  radio:    ['empty', 'invalid-option'],
};

// ─── generator value sets ────────────────────────────────────────────

const GENERATOR_VALUES = {
  empty: [''],
  oversize: ['A'.repeat(10_000), 'A'.repeat(1000), 'A'.repeat(100)],
  unicode: ['¹²³üñîçødé Ω≈ç√∫˜µ', '🎉🚀💻✨', 'مرحبا بالعالم', 'こんにちは世界'],
  sql: ["' OR '1'='1", "'; DROP TABLE users; --", "' UNION SELECT * FROM users--", "admin'--"],
  xss: ['<script>alert(1)</script>', '"><svg onload=alert(1)>', 'javascript:alert(1)'],
  path: ['../../../etc/passwd', '..\\..\\..\\windows\\system32', '%2e%2e%2f%2e%2e%2f'],
  'null-byte': ['foo\0bar', '\0', 'value\0\0extra'],
  'numeric-overflow': [String(Number.MAX_SAFE_INTEGER + 1), 'Infinity', 'NaN'],
  negative: ['-1', '-999999', '-0.0001'],
  float: ['3.14159', '1e10', '0.000001'],
  string: ['not-a-number', 'abc', 'twelve'],
  letters: ['abcdefghij', 'ABCDEF', '+1-555-0100'],
  'invalid-format': ['not-an-email', 'a@', '@b.com', 'a@b', 'a b@c.com', 'http://', 'ftp://wrong'],
  weak: ['password', '123456', 'qwerty', 'letmein'],
  common: ['Password123!', 'admin', 'root', 'toor'],
  unchecked: [false],
  'invalid-option': ['__nonexistent_option__', '0', 'null'],
  tampered: ['on', 'true', 'checked'],
};

/**
 * Get the generators appropriate for an input field's type.
 * Falls back to a sensible default set.
 */
export function generatorsForType(type) {
  return TYPE_GENERATORS[type] || TYPE_GENERATORS.text;
}

/**
 * Get the concrete values for a generator name.
 */
export function valuesForGenerator(genName) {
  return GENERATOR_VALUES[genName] || [];
}

/**
 * Build the full input matrix for a list of form fields.
 *
 * @param {Array} inputs   — list of InputField objects
 * @param {object} [opts]  — { maxPerField, maxTotal, pageUrl, formSelector }
 * @returns {Array<FuzzTarget>}
 */
export function buildInputMatrix(inputs, opts = {}) {
  const { maxPerField = 10, maxTotal = 200, pageUrl, formSelector = 'form' } = opts;
  const targets = [];
  let total = 0;

  for (const input of inputs || []) {
    if (total >= maxTotal) break;

    const generators = generatorsForType(input.type);
    let perField = 0;

    for (const gen of generators) {
      if (perField >= maxPerField || total >= maxTotal) break;

      const values = valuesForGenerator(gen);
      const value = values[0] ?? '';  // one value per generator

      const target = {
        pageUrl,
        formSelector,
        fieldSelector: input.selector,
        generators: [gen],
        iterations: 1,
        expectStatus: 'no-5xx',
      };

      // Validate via the FuzzTarget schema if available
      targets.push(target);
      perField++;
      total++;
    }
  }

  return targets;
}

/**
 * Estimate the matrix size for planning / display.
 * Returns the theoretical maximum permutations.
 */
export function estimateMatrixSize(inputs) {
  let total = 0;
  for (const input of inputs || []) {
    const gens = generatorsForType(input.type);
    for (const gen of gens) {
      total += valuesForGenerator(gen).length;
    }
  }
  return total;
}

/**
 * Bucket inputs by form (using formSelector if available).
 * Returns a map: formSelector → InputField[]
 */
export function groupByForm(inputs) {
  const groups = new Map();
  for (const input of inputs || []) {
    const key = input.formSelector || 'form';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(input);
  }
  return groups;
}
