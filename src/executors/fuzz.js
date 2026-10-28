/**
 * executors/fuzz.js — input mutation + boundary testing.
 *
 * Consumes: plan.fuzzTargets[]
 * Produces: findings when fuzzed inputs cause 5xx, crashes, or contract violations
 *
 * Supports two target types (matches FuzzTarget schema):
 *   • Page form inputs  — drives Playwright (or mock page) to fill + submit
 *   • API fields        — sends requests with mutated body fields
 *
 * Generators are pure functions returning a string or array of strings.
 * Each generator is unit-testable in isolation.
 */

// ─── generators ──────────────────────────────────────────────────────

export const generators = {
  empty: () => '',
  oversize: () => 'A'.repeat(10_000),
  unicode: () => '¹²³üñîçødé Ω≈ç√∫˜µ åß∂ƒ©˙∆∆',
  sql: () => [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "admin'--",
    "' UNION SELECT * FROM users--",
  ],
  xss: () => [
    '<script>alert(1)</script>',
    '"><svg onload=alert(1)>',
    'javascript:alert(1)',
    '<img src=x onerror=alert(1)>',
  ],
  path: () => [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2f',
    '/etc/passwd',
  ],
  'numeric-overflow': () => String(Number.MAX_SAFE_INTEGER + 1),
  negative: () => '-1',
  'null-byte': () => 'foo\0bar',
  random: () => Math.random().toString(36).slice(2, 12),
};

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Generate all test inputs for a single FuzzTarget.
 * Returns an array of { generator, value, index } entries.
 * For multi-value generators (sql, xss, path) we expand to one entry per value.
 */
export function generateInputs(target) {
  const inputs = [];
  for (const genName of target.generators) {
    const gen = generators[genName];
    if (!gen) continue;
    const value = gen();
    if (Array.isArray(value)) {
      value.forEach((v, i) => inputs.push({ generator: `${genName}#${i}`, value: v }));
    } else {
      inputs.push({ generator: genName, value });
    }
  }
  // Cap iterations
  return inputs.slice(0, target.iterations);
}

/**
 * Determine if a fuzz response is acceptable per the target's expectStatus policy.
 *   'any-2xx-or-4xx'  → status in 2xx or 4xx range
 *   'no-5xx'          → status < 500
 *   'no-crash'        → status < 500 AND no exception thrown
 */
export function isAcceptableOutcome(status, threw, expectStatus = 'no-5xx') {
  if (threw) return expectStatus === 'no-crash' ? false : expectStatus !== 'no-5xx' ? status != null && status < 500 : false;
  if (expectStatus === 'any-2xx-or-4xx') return (status >= 200 && status < 300) || (status >= 400 && status < 500);
  if (expectStatus === 'no-5xx') return status == null || status < 500;
  if (expectStatus === 'no-crash') return status == null || status < 500;
  return true;
}

// ─── API fuzz runner ─────────────────────────────────────────────────

/**
 * Fuzz a single API field with a single value.
 * Looks up the endpoint in ctx.plan.apiEndpoints by path.
 */
export async function fuzzApiField(target, value, ctx) {
  const endpoint = ctx.plan.apiEndpoints.find(e => e.path === target.apiEndpointRef);
  if (!endpoint) {
    throw new Error(`Fuzz target references unknown endpoint: ${target.apiEndpointRef}`);
  }
  if (!['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    return { status: null, threw: false, skipped: true };
  }

  const fetchImpl = ctx.options?.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('No fetch available');

  const fallbackOrigin = (() => {
    try { return new URL(ctx.plan.targetUrl).origin; } catch { return ctx.plan.targetUrl; }
  })();
  const url = endpoint.baseUrl || fallbackOrigin + endpoint.path;

  const body = { ...(endpoint.body || {}) };
  body[target.field] = value;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ctx.options?.timeout ?? 10000);
    if (ctx.signal) ctx.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    const response = await fetchImpl(url, {
      method: endpoint.method,
      headers: { 'Content-Type': 'application/json', ...endpoint.headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { status: response.status, threw: false };
  } catch (err) {
    return { status: null, threw: true, error: err.message };
  }
}

// ─── main executor ───────────────────────────────────────────────────

export default async function fuzzExecutor(ctx) {
  const targets = ctx.plan?.fuzzTargets || [];
  const findings = [];

  ctx.onEvent?.(`Fuzzing ${targets.length} targets`);

  for (const target of targets) {
    if (ctx.signal?.aborted) break;

    const inputs = generateInputs(target);
    let failures = 0;

    for (const input of inputs) {
      if (ctx.signal?.aborted) break;

      let result;
      if (target.apiEndpointRef) {
        result = await fuzzApiField(target, input.value, ctx);
      } else {
        // Page-form fuzz requires Playwright — skip if no context
        if (!ctx.context) {
          ctx.onEvent?.(`Skipping form fuzz target (no Playwright context): ${target.fieldSelector}`);
          break;
        }
        // Phase 2.5 will implement Playwright-driven form fuzz
        continue;
      }

      if (result.skipped) continue;

      const acceptable = isAcceptableOutcome(result.status, result.threw, target.expectStatus);
      if (!acceptable) {
        failures++;
        findings.push(ctx.createFinding({
          title: `Fuzz: ${target.apiEndpointRef}.${target.field} (${input.generator}) caused ${result.threw ? 'crash' : `HTTP ${result.status}`}`,
          severity: result.threw || (result.status && result.status >= 500) ? 'high' : 'medium',
          confidence: 'confirmed',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId: 'fuzz-failure',
          pageUrl: target.apiEndpointRef,
          description: `Endpoint ${target.apiEndpointRef} field "${target.field}" failed when given value from generator "${input.generator}".`,
          evidence: `Generator: ${input.generator}\nValue: ${input.value.slice(0, 200)}\nStatus: ${result.status ?? 'n/a'}\nError: ${result.error || 'n/a'}`,
          suggestedFix: 'Validate + sanitize the field on the server side. Reject malformed input with 400 instead of crashing or returning 5xx.',
        }));
      }
    }

    ctx.onEvent?.(`Fuzz target ${target.apiEndpointRef || target.fieldSelector}: ${failures}/${inputs.length} failures`);
  }

  ctx.onEvent?.(`fuzz complete: ${findings.length} findings`);
  return {
    findings,
    stats: { targetsRun: targets.length, totalInputs: targets.reduce((s, t) => s + generateInputs(t).length, 0) },
  };
}
