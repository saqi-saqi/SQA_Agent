import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTestPlan,
  approvePlan,
  rejectPlan,
  summarizePlan,
} from '../src/explorer/index.js';
import {
  MockProvider,
  setDefaultProvider,
  ZaiSdkProvider,
} from '../src/explorer/llmProvider.js';
import { TestPlan } from '../src/services/testPlan.js';

// ─── fixture: simulated crawl output ──────────────────────────────────

const samplePages = [
  {
    url: 'https://example.com/',
    status: 200,
    title: 'Example App',
    loadTime: 1200,
    forms: 1,
    buttons: 3,
    inputs: 2,
    links: ['/login', '/dashboard', '/about'],
    imageDetails: [{ src: 'logo.png', alt: 'Logo' }],
    meta: {
      h1: 'Welcome',
      viewport: 'width=device-width, initial-scale=1',
    },
    apiCalls: [
      {
        method: 'GET',
        url: 'https://example.com/users/123',
        status: 200,
        requestHeaders: { authorization: '[REDACTED]' },
        responseHeaders: { 'content-type': 'application/json' },
        requestBody: null,
        responseBody: { id: 123, name: 'Alice' },
        responseContentType: 'application/json',
        initiator: 'main-frame',
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        method: 'POST',
        url: 'https://example.com/login',
        status: 200,
        requestHeaders: { 'content-type': 'application/json' },
        responseHeaders: { 'content-type': 'application/json' },
        requestBody: { email: 'alice@example.com', password: 'redacted' },
        responseBody: { token: '[REDACTED]' },
        responseContentType: 'application/json',
        initiator: 'main-frame',
        timestamp: '2025-01-01T00:00:01.000Z',
      },
    ],
  },
  {
    url: 'https://example.com/about',
    status: 200,
    title: 'About',
    loadTime: 600,
    forms: 0,
    buttons: 1,
    inputs: 0,
    links: ['/'],
    imageDetails: [],
    meta: { h1: 'About Us', viewport: 'width=device-width, initial-scale=1' },
    apiCalls: [],
  },
];

// ─── canned LLM responses keyed by prompt substring ───────────────────

function makeMock() {
  return new MockProvider({
    'Propose 3-5 test flows': {
      flows: [
        {
          name: 'Login',
          startUrl: 'https://example.com/',
          steps: [
            { action: 'click', selector: 'a[href="/login"]' },
            { action: 'fill', selector: 'input[name="email"]', value: 'test@example.com' },
            { action: 'fill', selector: 'input[name="password"]', value: 'Password123!' },
            { action: 'click', selector: 'button[type="submit"]' },
            { action: 'assertUrl', urlContains: '/dashboard' },
            { action: 'assertVisible', selector: '.dashboard' },
          ],
        },
        {
          name: 'Navigate to About',
          startUrl: 'https://example.com/',
          steps: [
            { action: 'click', selector: 'a[href="/about"]' },
            { action: 'assertText', selector: 'h1', contains: 'About Us' },
          ],
        },
      ],
    },
    'Infer API endpoint': {
      endpoints: [
        {
          method: 'GET',
          path: '/users/:id',
          expectedStatus: 200,
          description: 'Fetch user by ID',
          requestSchema: null,
          responseSchema: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } },
          pathParams: { id: '123' },
        },
        {
          method: 'POST',
          path: '/login',
          expectedStatus: 200,
          description: 'Authenticate user',
          requestSchema: { email: 'string', password: 'string' },
          responseSchema: { type: 'object', properties: { token: { type: 'string' } } },
          pathParams: {},
        },
      ],
    },
    'Summarize': 'This appears to be a SaaS app with a login flow and user dashboard.',
    'Prioritize by risk': '1. Login flow (auth is critical)\n2. POST /login API (security-sensitive)\n3. User fetch',
  });
}

describe('buildTestPlan end-to-end (with mock LLM)', () => {
  let originalProvider;

  before(() => {
    originalProvider = new ZaiSdkProvider();  // restore later
    setDefaultProvider(makeMock());
  });
  after(() => {
    setDefaultProvider(originalProvider);
  });

  it('returns a valid TestPlan with status "proposed"', async () => {
    const { plan, warnings } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });

    assert.equal(plan.status, 'proposed');
    assert.equal(plan.targetUrl, 'https://example.com/');
    assert.equal(plan.schemaVersion, 1);
    assert.ok(plan.id.startsWith('plan_'));
    assert.ok(plan.generatedAt);
    assert.equal(plan.generatedBy, 'sqa-agent-explorer');

    // Re-validate against the schema as a sanity check
    const reValidated = TestPlan.safeParse(plan);
    assert.ok(reValidated.success, 'Plan should re-validate against TestPlan schema');
  });

  it('proposes flows from LLM output', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    assert.ok(plan.flows.length >= 1);
    assert.ok(plan.flows.some(f => f.name === 'Login'));
  });

  it('proposes API endpoints from captured apiCalls', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    assert.equal(plan.apiEndpoints.length, 2);
    const paths = plan.apiEndpoints.map(e => e.path);
    assert.ok(paths.includes('/users/:id'));
    assert.ok(paths.includes('/login'));
  });

  it('derives fuzz targets from form inputs + API request schemas', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    // 1 page with inputs + 2 API fields (email, password)
    assert.ok(plan.fuzzTargets.length >= 1);
  });

  it('includes a11y rules + perf budgets + visual baselines', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    assert.ok(plan.a11yRules.length >= 10);
    assert.ok(plan.perfBudgets.length >= 5);
    assert.ok(plan.visualBaselines.length >= 1);  // 2 pages × 2 viewports = 4
  });

  it('includes the default executor list', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    assert.ok(plan.executors.includes('e2e'));
    assert.ok(plan.executors.includes('api-contract'));
    assert.ok(plan.executors.includes('fuzz'));
    assert.ok(plan.executors.includes('accessibility-deep'));
    assert.ok(plan.executors.includes('perf'));
    assert.ok(plan.executors.includes('visual'));
  });

  it('produces a non-empty notes field (LLM summary + risk)', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    assert.ok(plan.notes.length > 0);
    assert.match(plan.notes, /Risk Prioritization/i);
  });

  it('handles LLM producing an invalid flow by dropping it', async () => {
    const mock = makeMock();
    mock.responses['Propose 3-5 test flows'] = {
      flows: [
        // Valid
        { name: 'Good', startUrl: 'https://example.com/', steps: [{ action: 'assertVisible', selector: 'main' }] },
        // Invalid — click without selector
        { name: 'Bad', startUrl: 'https://example.com/', steps: [{ action: 'click' }] },
      ],
    };
    setDefaultProvider(mock);

    const { plan, warnings } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });

    assert.equal(plan.flows.length, 1);
    assert.equal(plan.flows[0].name, 'Good');
    assert.ok(warnings.some(w => /Bad/i.test(w)));

    setDefaultProvider(makeMock());  // reset for next test
  });

  it('throws on empty pages array', async () => {
    await assert.rejects(
      () => buildTestPlan({ pages: [], targetUrl: 'https://x.com', siteOrigin: 'https://x.com' }),
      /empty crawl/i,
    );
  });

  it('throws when targetUrl is missing', async () => {
    await assert.rejects(
      () => buildTestPlan({ pages: samplePages, siteOrigin: 'https://x.com' }),
      /targetUrl/i,
    );
  });

  it('can disable summary + risk priority via options', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
      options: { summary: false, riskPriority: false },
    });
    assert.equal(plan.notes, '');
  });
});

describe('approvePlan / rejectPlan', () => {
  let originalProvider;
  before(() => {
    originalProvider = new ZaiSdkProvider();
    setDefaultProvider(makeMock());
  });
  after(() => setDefaultProvider(originalProvider));

  it('approvePlan transitions proposed → approved', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    assert.equal(plan.status, 'proposed');
    const approved = approvePlan(plan);
    assert.equal(approved.status, 'approved');
  });

  it('rejectPlan transitions back to draft with reason', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    const rejected = rejectPlan(plan, 'too many flows');
    assert.equal(rejected.status, 'draft');
    assert.match(rejected.notes, /Rejected: too many flows/i);
  });
});

describe('summarizePlan', () => {
  let originalProvider;
  before(() => {
    originalProvider = new ZaiSdkProvider();
    setDefaultProvider(makeMock());
  });
  after(() => setDefaultProvider(originalProvider));

  it('returns counts + briefs without LLM', async () => {
    const { plan } = await buildTestPlan({
      pages: samplePages,
      targetUrl: 'https://example.com/',
      siteOrigin: 'https://example.com',
    });
    const brief = summarizePlan(plan);
    assert.equal(brief.id, plan.id);
    assert.equal(brief.status, 'proposed');
    assert.equal(brief.targetUrl, 'https://example.com/');
    assert.ok(brief.counts.flows >= 1);
    assert.ok(brief.counts.apiEndpoints >= 1);
    assert.ok(brief.flowNames.includes('Login'));
    assert.ok(brief.endpointBriefs.some(e => e.includes('/login')));
  });
});
