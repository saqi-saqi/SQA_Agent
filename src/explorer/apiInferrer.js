/**
 * apiInferrer.js — propose API endpoint contracts from captured XHR/fetch traffic.
 *
 * Strategy:
 *   1. Aggregate all apiCalls across pages.
 *   2. Group by (method, normalized path) where numeric segments become :id.
 *   3. Send grouped samples to LLM via apiInferencePrompt.
 *   4. Parse + validate against ApiEndpoint[] schema. Drop invalid entries.
 *
 * Falls back gracefully: if LLM fails, return raw grouped endpoints with
 * no schema (still useful — the contract executor can probe + record).
 */
import { chatJson } from './llmProvider.js';
import { apiInferencePrompt } from './prompts.js';
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';

const ApiEndpointSchema = arrayElementSchema(TestPlan.shape.apiEndpoints);

/**
 * Naive path normalization: turn /users/123/posts/456 into /users/:id/posts/:id
 * Also collapses UUIDs and long alphanumeric slugs.
 */
export function normalizePath(pathname) {
  return pathname
    .split('/')
    .map(seg => {
      if (!seg) return seg;
      // numeric ID
      if (/^\d+$/.test(seg)) return ':id';
      // UUID
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      // long slug (8+ chars alphanumeric, not a known word) — conservative
      if (seg.length >= 12 && /^[a-z0-9]+$/i.test(seg) && /\d/.test(seg)) return ':slug';
      return seg;
    })
    .join('/');
}

/**
 * True when the captured request carried session credentials. The crawler
 * redacts sensitive header VALUES but preserves their NAMES, so presence
 * of the key is enough to know the original call was authenticated.
 */
export function hasSessionHeaders(requestHeaders = {}) {
  return Object.keys(requestHeaders).some(k =>
    /^(cookie|authorization|x-api-key|x-auth-token)$/i.test(k)
  );
}

/**
 * Extract query params from a URL into a plain string record (capped —
 * tracking/count params beyond a handful are noise for replays).
 */
export function extractQueryParams(url, cap = 8) {
  const out = {};
  try {
    for (const [k, v] of new URL(url).searchParams.entries()) {
      if (Object.keys(out).length >= cap) break;
      out[k] = v;
    }
  } catch { /* malformed URL — no params */ }
  return out;
}

function urlHasQuery(url) {
  try {
    return [...new URL(url).searchParams.keys()].length > 0;
  } catch {
    return false;
  }
}

/**
 * Build a fallback endpoint list from raw apiCalls — no LLM involved.
 * Used when LLM is unavailable or as a sanity baseline.
 */
export function fallbackEndpoints(apiCalls) {
  const grouped = new Map();
  for (const c of apiCalls || []) {
    let path;
    try {
      path = new URL(c.url).pathname;
    } catch {
      continue;
    }
    const normalized = normalizePath(path);
    const key = `${c.method} ${normalized}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        method: c.method,
        path: normalized,
        expectedStatus: c.status,
        requestSchema: null,
        responseSchema: null,
        pathParams: {},
        headers: {},
        requiresSession: hasSessionHeaders(c.requestHeaders),
        observedStatuses: new Set(),
        description: `Inferred from ${c.url}`,
        // Best full URL for replay fidelity — filled in below.
        _bestUrl: c.url,
        _best2xxUrl: null,
        _observedCount: 0,
      });
    }
    const g = grouped.get(key);
    g._observedCount++;
    if (c.status) g.observedStatuses.add(c.status);
    // Keep the most-likely-success status (2xx preferred)
    if (c.status >= 200 && c.status < 300) g.expectedStatus = c.status;
    // Replay fidelity: remember a 2xx URL, preferring one that carries its
    // query string — that's the exact request that succeeded in the browser.
    if (c.status >= 200 && c.status < 300) {
      if (!g._best2xxUrl || (!urlHasQuery(g._best2xxUrl) && urlHasQuery(c.url))) {
        g._best2xxUrl = c.url;
      }
    }
    // If ANY observed call for this endpoint used session credentials,
    // the endpoint is session-gated for probing purposes.
    if (!g.requiresSession && hasSessionHeaders(c.requestHeaders)) g.requiresSession = true;
  }

  return Array.from(grouped.values()).map(({ observedStatuses, _bestUrl, _best2xxUrl, _observedCount, ...rest }) => ({
    ...rest,
    queryParams: extractQueryParams(_best2xxUrl || _bestUrl),
    observedStatuses: Array.from(observedStatuses).filter(s => typeof s === 'number'),
    description: `${rest.description} (observed ${_observedCount}x, statuses: ${Array.from(observedStatuses).join(',')})`,
  }));
}

export async function inferApiEndpoints({ pages, siteOrigin, llmOpts = {} }) {
  let allCalls = (pages || []).flatMap(p => p.apiCalls || []);

  // Only the site's OWN api is under test. Third-party widget calls
  // (Facebook plugins, CDNs, analytics) must not be inferred as endpoints —
  // their paths would otherwise be replayed against the target origin and
  // reported as bugs on the wrong site.
  let thirdPartySkipped = 0;
  if (siteOrigin) {
    let origin = null;
    try { origin = new URL(siteOrigin).origin; } catch { /* unparseable — no filter */ }
    if (origin) {
      const own = [];
      for (const c of allCalls) {
        try {
          if (new URL(c.url).origin === origin) own.push(c);
          else thirdPartySkipped++;
        } catch { thirdPartySkipped++; }
      }
      allCalls = own;
    }
  }

  const warnings = [];
  if (allCalls.length === 0) {
    if (thirdPartySkipped > 0) {
      warnings.push(`All ${thirdPartySkipped} captured API calls were third-party (embedded widgets/CDNs) — nothing same-origin to probe.`);
    }
    return { endpoints: [], warnings };
  }

  const { system, user } = apiInferencePrompt({ apiCalls: allCalls, siteOrigin });
  const result = await chatJson({ system, user, temperature: 0.2 }, llmOpts);

  if (!result.ok) {
    warnings.push(`API inference LLM call failed: ${result.error}. Using fallback heuristics.`);
    const fallback = fallbackEndpoints(allCalls);
    if (thirdPartySkipped > 0) warnings.push(`Skipped ${thirdPartySkipped} third-party API calls (embedded widgets/CDNs).`);
    return { endpoints: fallback, warnings };
  }

  const rawEndpoints = Array.isArray(result.data?.endpoints) ? result.data.endpoints : [];

  const endpoints = [];
  for (const raw of rawEndpoints) {
    const parsed = ApiEndpointSchema.safeParse(raw);
    if (parsed.success) {
      endpoints.push(parsed.data);
    } else {
      const issues = parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      warnings.push(`Dropped invalid endpoint "${raw?.method || '?'} ${raw?.path || '?'}": ${issues}`);
    }
  }

  // If LLM returned zero valid endpoints, fall back to heuristics
  if (endpoints.length === 0 && allCalls.length > 0) {
    warnings.push('LLM produced no valid endpoints. Falling back to heuristics.');
    const fallback = fallbackEndpoints(allCalls);
    if (thirdPartySkipped > 0) warnings.push(`Skipped ${thirdPartySkipped} third-party API calls (embedded widgets/CDNs).`);
    return { endpoints: fallback, warnings };
  }

  if (thirdPartySkipped > 0) {
    warnings.push(`Skipped ${thirdPartySkipped} third-party API calls (embedded widgets/CDNs).`);
  }

  // Post-match LLM endpoints back to captured traffic so replays stay
  // faithful to what the browser actually did:
  //   • session credentials observed → requiresSession (suspected downgrades)
  //   • union of statuses the browser saw → observedStatuses
  //   • query string from the matched call → queryParams (LLMs often drop it)
  const captured = new Map();
  for (const c of allCalls) {
    try {
      const u = new URL(c.url);
      const key = `${c.method} ${u.pathname}`;
      if (!captured.has(key)) captured.set(key, []);
      captured.get(key).push(c);
    } catch { /* skip malformed */ }
  }
  for (const ep of endpoints) {
    const normalized = ep.path.startsWith('/') ? ep.path : `/${ep.path}`;
    const matches = captured.get(`${ep.method} ${normalized}`) || [];
    if (matches.length === 0) continue;

    if (matches.some(c => hasSessionHeaders(c.requestHeaders))) {
      ep.requiresSession = true;
    }
    const statuses = new Set(ep.observedStatuses || []);
    for (const c of matches) if (typeof c.status === 'number') statuses.add(c.status);
    ep.observedStatuses = [...statuses];

    if (!Object.keys(ep.queryParams || {}).length) {
      const withQuery = matches.find(c => urlHasQuery(c.url));
      if (withQuery) ep.queryParams = extractQueryParams(withQuery.url);
    }
  }

  return { endpoints, warnings };
}
