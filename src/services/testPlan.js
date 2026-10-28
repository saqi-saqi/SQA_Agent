/**
 * testPlan.js — Zod schema for an AI-authored, human-approved test plan.
 *
 * A TestPlan describes everything the agent intends to verify about a target:
 *   • which pages to assert on
 *   • which user flows to run end-to-end
 *   • which API endpoints to contract-test
 *   • which input fields to fuzz
 *   • which a11y rules to enforce
 *   • which perf budgets to apply
 *   • which visual baselines to compare against
 *
 * Lifecycle:
 *   draft  →  proposed  →  approved  →  executing  →  completed | failed
 *
 * Phase 0 ships the schema + validators. Phase 1 wires the explorer to
 * produce draft plans; Phase 2 wires executors to consume them.
 */
import { z } from 'zod';

// ─── shared primitives ────────────────────────────────────────────────

const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const Viewport = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),        // 'desktop', 'mobile', etc.
  userAgent: z.string().optional(),
  deviceScaleFactor: z.number().positive().optional(),
  isMobile: z.boolean().optional(),
  hasTouch: z.boolean().optional(),
});

const AuthContext = z.object({
  type: z.enum(['none', 'cookie', 'bearer', 'basic', 'custom']),
  // For 'cookie' / 'bearer' / 'basic' — secret name only, never the value.
  // Executors resolve the secret from env / vault at runtime.
  secretRef: z.string().optional(),
  cookieName: z.string().optional(),
  headerName: z.string().optional(),
  loginFlow: z.string().optional(),   // reference to a Flow.name to run first
}).strict();

// ─── page assertion ───────────────────────────────────────────────────

const ElementAssertion = z.object({
  selector: z.string().min(1),
  state: z.enum(['visible', 'hidden', 'attached', 'detached', 'enabled', 'disabled', 'stable']),
  timeoutMs: z.number().int().positive().max(30000).optional(),
}).strict();

const PageAssertion = z.object({
  url: z.string().url(),
  label: z.string().optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  expectedTitle: z.string().optional(),
  expectedElements: z.array(ElementAssertion).default([]),
  forbiddenText: z.array(z.string()).default([]),
  viewport: Viewport.optional(),
  auth: AuthContext.optional(),
}).strict();

// ─── flow (E2E journey) ───────────────────────────────────────────────

const FlowStep = z.union([
  z.object({
    action: z.enum(['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'hover', 'focus', 'press', 'upload']),
    selector: z.string().min(1),
    value: z.string().optional(),
    timeoutMs: z.number().int().positive().max(30000).optional(),
  }).strict(),
  z.object({
    action: z.literal('wait'),
    selector: z.string().min(1).optional(),
    ms: z.number().int().positive().max(10000).optional(),
    state: z.enum(['visible', 'hidden', 'attached', 'detached', 'stable']).optional(),
  }).strict(),
  z.object({
    action: z.literal('assertVisible'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().max(30000).optional(),
  }).strict(),
  z.object({
    action: z.literal('assertHidden'),
    selector: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal('assertText'),
    selector: z.string().min(1),
    equals: z.string().optional(),
    contains: z.string().optional(),
  }).strict().refine(d => d.equals != null || d.contains != null, {
    message: 'assertText requires equals or contains',
  }),
  z.object({
    action: z.literal('assertUrl'),
    url: z.string().optional(),
    urlMatches: z.string().optional(),    // regex
    urlContains: z.string().optional(),
  }).strict().refine(d => d.url || d.urlMatches || d.urlContains, {
    message: 'assertUrl requires one of: url | urlMatches | urlContains',
  }),
  z.object({
    action: z.literal('assertStatus'),
    status: z.number().int().min(100).max(599),
  }).strict(),
]);

const Flow = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startUrl: z.string().url(),
  steps: z.array(FlowStep).min(1),
  auth: AuthContext.optional(),
  viewport: Viewport.optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(5).default(2),
    backoffMs: z.number().int().positive().max(10000).default(500),
  }).default({}),
  tags: z.array(z.string()).default([]),
}).strict();

// ─── API contract ─────────────────────────────────────────────────────

const JsonSchema = z.union([
  z.record(z.string(), z.any()),
  z.array(z.any()),
  z.null(),
]);

const ApiEndpoint = z.object({
  method: HttpMethod,
  path: z.string().min(1),                          // e.g. '/api/users/:id'
  baseUrl: z.string().url().optional(),             // override run target
  expectedStatus: z.number().int().min(100).max(599).optional(),
  requestSchema: JsonSchema.nullish(),              // null | undefined | object | array
  responseSchema: JsonSchema.nullish(),
  auth: AuthContext.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  // True when the original captured request carried session credentials
  // (cookie/authorization). Anonymous replays of such endpoints failing is
  // expected — the contract executor downgrades those mismatches.
  requiresSession: z.boolean().optional(),
  // Statuses the real browser observed for this endpoint during the crawl.
  // A replay reproducing one of these means the site behaves as before —
  // the expectation was wrong, not the site.
  observedStatuses: z.array(z.number().int().min(100).max(599)).optional(),
  // Path params / query params / body — concrete values to send during the contract probe.
  pathParams: z.record(z.string(), z.string()).default({}),
  queryParams: z.record(z.string(), z.string()).default({}),
  body: z.any().optional(),
  description: z.string().optional(),
}).strict();

// ─── fuzz ─────────────────────────────────────────────────────────────

const FuzzGenerator = z.enum([
  'empty',          // ''
  'oversize',       // 10_000 chars
  'unicode',        // emoji + RTL + combining marks
  'sql',            // sqli payloads
  'xss',            // reflected-xss payloads
  'path',           // path traversal
  'numeric-overflow',
  'negative',
  'null-byte',
  'random',         // random printable
]);

const FuzzTarget = z.object({
  // Either target a form on a page (by selector) or an API endpoint (by reference).
  pageUrl: z.string().url().optional(),
  formSelector: z.string().min(1).optional(),
  fieldSelector: z.string().min(1).optional(),

  // For API fuzzing
  apiEndpointRef: z.string().min(1).optional(),   // matches ApiEndpoint.path or label
  field: z.string().min(1).optional(),            // body field name

  generators: z.array(FuzzGenerator).min(1),
  iterations: z.number().int().min(1).max(1000).default(20),
  expectStatus: z.union([
    z.literal('any-2xx-or-4xx'),
    z.literal('no-5xx'),
    z.literal('no-crash'),
  ]).default('no-5xx'),
}).strict().refine(d => (d.pageUrl && d.fieldSelector) || (d.apiEndpointRef && d.field), {
  message: 'FuzzTarget must specify either (pageUrl + fieldSelector) or (apiEndpointRef + field)',
});

// ─── a11y / security / perf / visual ──────────────────────────────────

const A11yRule = z.object({
  rule: z.string().min(1),                         // axe-core rule id, e.g. 'color-contrast'
  level: z.enum(['minor', 'moderate', 'serious', 'critical']).default('serious'),
  selector: z.string().optional(),                 // scope to selector
}).strict();

const PerfBudget = z.object({
  metric: z.enum(['LCP', 'CLS', 'TBT', 'FCP', 'TTFB', 'pageSizeBytes', 'requestCount']),
  threshold: z.number().positive(),
  // Failure severity when exceeded — info findings don't lower score
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('medium'),
}).strict();

const VisualBaseline = z.object({
  pageUrl: z.string().url(),
  label: z.string().optional(),
  viewport: Viewport,
  maskSelectors: z.array(z.string()).default([]),
  // Baseline image path — agent stores hash + path; comparison pixel-diffs against it
  baselinePath: z.string().optional(),
  threshold: z.number().min(0).max(1).default(0.01),   // 1% pixel diff tolerated
}).strict();

// ─── top-level plan ───────────────────────────────────────────────────

export const TestPlan = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),                            // UUID
  targetUrl: z.string().url(),
  generatedAt: z.string().datetime().optional(),
  generatedBy: z.string().default('sqa-agent-explorer'),
  status: z.enum(['draft', 'proposed', 'approved', 'executing', 'completed', 'failed'])
    .default('draft'),
  notes: z.string().default(''),

  // Discoverable scope
  pages: z.array(PageAssertion).default([]),
  flows: z.array(Flow).default([]),
  apiEndpoints: z.array(ApiEndpoint).default([]),
  fuzzTargets: z.array(FuzzTarget).default([]),
  a11yRules: z.array(A11yRule).default([]),
  perfBudgets: z.array(PerfBudget).default([]),
  visualBaselines: z.array(VisualBaseline).default([]),

  // Execution config
  viewports: z.array(Viewport).default([]),         // matrix
  browsers: z.array(z.enum(['chromium', 'firefox', 'webkit'])).default(['chromium']),
  executors: z.array(z.string()).default([]),       // names from executorRegistry
}).strict();

// Convenience exports
export const TestPlanStatus = TestPlan.shape.status;
export const HttpMethodEnum = HttpMethod;
export const ViewportSchema = Viewport;
export const AuthContextSchema = AuthContext;

// Element schema extractor — peels ZodDefault / ZodOptional / ZodNullable
// wrappers off a ZodArray to get the inner element schema.
// Used by the Explorer inferrers to validate individual items without
// re-importing the schema definitions above.
export function arrayElementSchema(maybeWrappedArray) {
  let s = maybeWrappedArray;
  // Walk through wrapper types until we hit ZodArray
  for (let i = 0; i < 5; i++) {
    const name = s?._def?.typeName;
    if (name === 'ZodArray') {
      // Return the element schema, not the array schema itself
      return s._def.type;
    }
    // ZodDefault / ZodOptional / ZodNullable expose .unwrap()
    if (typeof s?.unwrap === 'function') {
      s = s.unwrap();
    } else if (s?._def?.innerType) {
      s = s._def.innerType;
    } else {
      break;
    }
  }
  return s;
}

// ─── helpers ──────────────────────────────────────────────────────────

/** Validate a raw object and return a typed TestPlan, throwing on invalid. */
export function parseTestPlan(raw) {
  return TestPlan.parse(raw);
}

/** Safe validate — returns { ok: true, plan } | { ok: false, error }. */
export function validateTestPlan(raw) {
  const result = TestPlan.safeParse(raw);
  if (result.success) {
    return { ok: true, plan: result.data };
  }
  return {
    ok: false,
    error: result.error.issues.map(i => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    })),
  };
}

/** Transition a plan's status — validates the new status is legal. */
export function transitionStatus(plan, to) {
  const order = ['draft', 'proposed', 'approved', 'executing', 'completed', 'failed'];
  const fromIdx = order.indexOf(plan.status);
  const toIdx = order.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) throw new Error(`Invalid status: ${to}`);
  // Allow 'failed' from any post-approved state
  if (to === 'failed' && fromIdx >= 2) return { ...plan, status: 'failed' };
  if (toIdx !== fromIdx + 1) {
    throw new Error(`Illegal status transition: ${plan.status} → ${to}`);
  }
  return { ...plan, status: to };
}

/** Create an empty draft plan for a given target URL. */
export function createDraftPlan(id, targetUrl) {
  return TestPlan.parse({
    schemaVersion: 1,
    id,
    targetUrl,
    status: 'draft',
  });
}
