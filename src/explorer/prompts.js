/**
 * prompts.js — prompt templates for the Explorer.
 *
 * Convention:
 *   • Each prompt is a function that takes structured input and returns
 *     { system, user } strings.
 *   • The user prompt includes crawl STRUCTURE as JSON so the LLM can
 *     reason about the app's shape — never concrete values.
 *   • We explicitly demand JSON output matching the TestPlan sub-schema.
 *
 * PRIVACY BOUNDARY — everything that leaves the machine passes through
 * this file, and it is the only place allowed to build LLM messages:
 *   • URLs are sanitized to origin + path + parameter NAMES (no values).
 *   • Request/response bodies are reduced to shape (keys + type names).
 *   No cookie values, tokens, emails, or user data can appear in any
 *   prompt. Tests in test/llmPrivacy.test.js enforce this boundary.
 */

// ─── privacy helpers (exported for tests) ────────────────────────────

/**
 * Strip query VALUES from a URL, keeping parameter names: the LLM needs to
 * know a URL has ?lang=&v= — never what those values were.
 */
export function sanitizeUrlForPrompt(url) {
  try {
    const u = new URL(url);
    const names = [...u.searchParams.keys()].slice(0, 8);
    const query = names.map(k => `${k}=`).join('&');
    return `${u.origin}${u.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return String(url || '');
  }
}

/**
 * Reduce a value to its SHAPE: keys and primitive type names only.
 * `"SECRET-JWT"` → `"string"`, `42` → `"number"`. Arrays keep the shape of
 * their first item; objects recurse (depth-capped). The LLM infers schemas
 * from shapes — actual values never need to leave the machine.
 */
export function toShapeOnly(value, depth = 0) {
  if (value === null) return null;
  if (depth >= 6) return '…';
  switch (typeof value) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': {
      if (Array.isArray(value)) {
        return value.length ? [toShapeOnly(value[0], depth + 1)] : [];
      }
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 25)) {
        out[k] = toShapeOnly(v, depth + 1);
      }
      return out;
    }
    default: return 'string';
  }
}

// ─── flow inference ───────────────────────────────────────────────────

export function flowInferencePrompt({ pages }) {
  // We strip noisy fields to keep the prompt under token budget.
  // Keep: sanitized url, title, h1, forms, buttons, inputs, meta.h1.
  const summary = pages.map(p => ({
    url: sanitizeUrlForPrompt(p.url),
    title: p.title,
    h1: p.meta?.h1 || null,
    forms: p.forms,
    buttons: p.buttons,
    inputs: p.inputs,
    // Limit link count — LLM doesn't need every link, just signal of
    // navigation breadth
    linkSample: (p.links || []).slice(0, 15).map(l => sanitizeUrlForPrompt(l)),
    // Observed API calls (just method+url+status) — informs flow inference
    apiCalls: (p.apiCalls || []).slice(0, 10).map(c => ({
      method: c.method, url: sanitizeUrlForPrompt(c.url), status: c.status,
    })),
  }));

  return {
    system: `You are a senior QA engineer designing end-to-end test flows for a web app.
Analyze the crawled page structure and propose Playwright-style user flows that exercise the app's critical paths.

Rules:
1. Each flow must have a clear name and a startUrl that exists in the crawled pages.
2. Each step must be one of:
   - { action: "navigate", selector: "<css>", value: "<url>" }
   - { action: "click", selector: "<css>" }
   - { action: "fill", selector: "<css>", value: "<test-value>" }
   - { action: "assertVisible", selector: "<css>" }
   - { action: "assertUrl", urlContains: "<substring>" }
   - { action: "assertText", selector: "<css>", contains: "<text>" }
3. Use realistic CSS selectors (form#login input[name="email"], button[type="submit"], nav a[href="/dashboard"], etc.)
4. Cover: authentication, primary CTAs, form submission + validation, navigation between pages.
5. For forms, fill inputs with plausible test values (test@example.com, "Test User", etc.)
6. Limit to 3-5 high-value flows. Quality over quantity.
7. Always end each flow with at least one assertion.

Return JSON in this exact shape:
{ "flows": [ { "name": "...", "startUrl": "...", "steps": [ ... ] } ] }`,

    user: `Crawled pages (JSON):\n\n${JSON.stringify(summary, null, 2)}\n\nPropose 3-5 test flows as JSON.`,
  };
}

// ─── API inference ────────────────────────────────────────────────────

export function apiInferencePrompt({ apiCalls, siteOrigin }) {
  // Group calls by (method, normalized path) and count occurrences
  const grouped = new Map();
  for (const c of apiCalls) {
    let path;
    try {
      path = new URL(c.url).pathname;
    } catch {
      continue;
    }
    // Naive param detection: numeric path segments become :id
    const normalizedPath = path
      .split('/')
      .map(seg => /^\d+$/.test(seg) ? ':id' : seg)
      .join('/');
    const key = `${c.method} ${normalizedPath}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        method: c.method,
        path: normalizedPath,
        sampleUrl: sanitizeUrlForPrompt(c.url),
        observedStatuses: new Set(),
        sampleRequestBody: toShapeOnly(c.requestBody),
        sampleResponseBody: toShapeOnly(c.responseBody),
        sampleResponseContentType: c.responseContentType,
        count: 0,
      });
    }
    const g = grouped.get(key);
    g.count++;
    if (c.status) g.observedStatuses.add(c.status);
  }

  const catalog = Array.from(grouped.values()).map(g => ({
    method: g.method,
    path: g.path,
    sampleUrl: g.sampleUrl,
    observedStatuses: Array.from(g.observedStatuses),
    count: g.count,
    hasRequestBody: g.sampleRequestBody != null,
    // Shape only — keys and type names, never values (privacy boundary)
    sampleRequestBody: g.sampleRequestBody,
    sampleResponseBody: g.sampleResponseBody,
    responseContentType: g.sampleResponseContentType,
  }));

  return {
    system: `You are an API contract designer. Given observed XHR/fetch traffic SHAPES from a crawl (bodies are reduced to keys + type names — actual values are withheld for privacy), infer:
1. What each endpoint does (semantic name + description)
2. What status code is "expected" for a successful call
3. What the request body shape looks like (if any)
4. What the response body shape looks like

Rules:
- Treat path segments that look like IDs as :id, :slug, etc.
- Don't invent endpoints that weren't observed.
- If a body is observed, infer a minimal JSON schema from its shape.
- expectedStatus is the success status (usually 200, 201 for POSTs).

Return JSON in this exact shape:
{ "endpoints": [ {
    "method": "GET|POST|...",
    "path": "/api/...",
    "expectedStatus": 200,
    "description": "...",
    "requestSchema": { ... } | null,
    "responseSchema": { ... } | null,
    "pathParams": { "id": "sample" } | {}
  } ] }`,

    user: `Site origin: ${siteOrigin}\n\nObserved API calls (grouped + shape samples):\n\n${JSON.stringify(catalog, null, 2)}\n\nInfer API endpoint contracts as JSON.`,
  };
}

// ─── page summary (for the human-readable plan notes) ────────────────

export function pageSummaryPrompt({ pages }) {
  const brief = pages.map(p => ({
    url: sanitizeUrlForPrompt(p.url),
    title: p.title,
    h1: p.meta?.h1,
    forms: p.forms,
    buttons: p.buttons,
    inputs: p.inputs,
  }));

  return {
    system: `You are a technical writer summarizing a crawl for a QA engineer.
Write a 2-3 sentence overview of what this app appears to be (auth flow? e-commerce? admin dashboard? marketing site?).
Then list 1-2 sentences per page noting what's notable (forms present, navigation depth, API usage).

Return plain text. No JSON.`,
    user: `Crawled pages:\n\n${JSON.stringify(brief, null, 2)}\n\nSummarize.`,
  };
}

// ─── risk prioritization (for the plan's notes field) ─────────────────

export function riskPrioritizationPrompt({ flows, endpoints, fuzzTargets }) {
  return {
    system: `You are a QA lead prioritizing tests by risk. Given a list of proposed flows, API endpoints, and fuzz targets, write a short prioritized list (highest-risk first) explaining what to test first and why.

Return plain text. No JSON. Keep under 200 words.`,
    user: `Flows:\n${JSON.stringify(flows.map(f => f.name), null, 2)}\n\nEndpoints:\n${JSON.stringify(endpoints.map(e => `${e.method} ${e.path}`), null, 2)}\n\nFuzz targets:\n${JSON.stringify(fuzzTargets.map(f => ({ field: f.fieldSelector || f.field, generators: f.generators })), null, 2)}\n\nPrioritize by risk.`,
  };
}
