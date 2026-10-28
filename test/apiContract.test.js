import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import apiContract, {
  substitutePathParams,
  verifySchema,
} from '../src/executors/apiContract.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── mock fetch helper ───────────────────────────────────────────────

function makeMockFetch(routes) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const u = typeof url === 'string' ? url : url.toString();
    const match = routes.find(r =>
      (!r.method || r.method === method) &&
      (r.url instanceof RegExp ? r.url.test(u) : u.includes(r.url))
    );
    if (!match) {
      const err = new Error(`Mock fetch: no route for ${method} ${u}`);
      err.name = 'FetchError';
      throw err;
    }
    if (match.throw) throw new Error(match.throw);
    return {
      status: match.status ?? 200,
      headers: new Headers(match.headers || {}),
      async json() { return match.body; },
      async text() { return typeof match.body === 'string' ? match.body : JSON.stringify(match.body); },
    };
  };
}

const baseCtx = (overrides = {}) => ({
  plan: {
    targetUrl: 'https://api.example.com',
    apiEndpoints: [],
  },
  createFinding: createFindingFactory(),
  onEvent: () => {},
  signal: undefined,
  options: {},
  ...overrides,
});

// ─── substitutePathParams ─────────────────────────────────────────────

describe('substitutePathParams', () => {
  it('substitutes :id with pathParams.id', () => {
    assert.equal(
      substitutePathParams('/users/:id', { id: '42' }),
      '/users/42'
    );
  });

  it('substitutes multiple params', () => {
    assert.equal(
      substitutePathParams('/orgs/:orgId/users/:userId', { orgId: 'acme', userId: '7' }),
      '/orgs/acme/users/7'
    );
  });

  it('falls back to 0 when param missing', () => {
    assert.equal(substitutePathParams('/users/:id', {}), '/users/0');
  });

  it('URL-encodes special chars in param values', () => {
    assert.equal(
      substitutePathParams('/search/:q', { q: 'hello world & friends' }),
      '/search/hello%20world%20%26%20friends'
    );
  });

  it('passes through paths without params', () => {
    assert.equal(substitutePathParams('/api/users', {}), '/api/users');
  });
});

// ─── verifySchema ─────────────────────────────────────────────────────

describe('verifySchema', () => {
  it('returns ok when schema is null/undefined', () => {
    assert.equal(verifySchema({ a: 1 }, null).ok, true);
    assert.equal(verifySchema({ a: 1 }, undefined).ok, true);
  });

  it('returns ok:false when body is null but schema present', () => {
    const r = verifySchema(null, { type: 'object' });
    assert.equal(r.ok, false);
    assert.match(r.mismatches[0], /body is null/i);
  });

  it('validates object type + properties', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
      },
    };
    assert.equal(verifySchema({ id: 1, name: 'Alice' }, schema).ok, true);
    const r = verifySchema({ id: 'x', name: 'Alice' }, schema);
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.some(m => /field id/.test(m)));
  });

  it('validates array type', () => {
    assert.equal(verifySchema([1, 2, 3], { type: 'array' }).ok, true);
    assert.equal(verifySchema({}, { type: 'array' }).ok, false);
  });

  it('validates primitive types', () => {
    assert.equal(verifySchema('hello', { type: 'string' }).ok, true);
    assert.equal(verifySchema(42, { type: 'string' }).ok, false);
    assert.equal(verifySchema(42, { type: 'number' }).ok, true);
    assert.equal(verifySchema(true, { type: 'boolean' }).ok, true);
    assert.equal(verifySchema('x', { type: 'number' }).ok, false);
  });

  it('supports legacy plain-object schema (field: "type")', () => {
    const schema = { email: 'string', password: 'string' };
    assert.equal(verifySchema({ email: 'a@b.com', password: 'x' }, schema).ok, true);
    const r = verifySchema({ email: 'a@b.com' }, schema);
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.some(m => /missing required field: password/.test(m)));
  });

  it('supports legacy plain-array schema', () => {
    assert.equal(verifySchema([1, 2], [1, 2]).ok, true);
    assert.equal(verifySchema({ a: 1 }, [1, 2]).ok, false);
  });
});

// ─── executor end-to-end ─────────────────────────────────────────────

describe('apiContract executor', () => {
  let ctx;

  beforeEach(() => {
    ctx = baseCtx();
  });

  it('returns no findings when all endpoints return expected status + valid schema', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: '/users/42', method: 'GET', status: 200, body: { id: 42, name: 'Alice' },
        headers: { 'content-type': 'application/json' } },
    ]);
    ctx.plan.apiEndpoints = [{
      method: 'GET',
      path: '/users/:id',
      expectedStatus: 200,
      pathParams: { id: '42' },
      responseSchema: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } },
    }];

    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.probed, 1);
    assert.equal(result.stats.failed, 0);
  });

  it('emits finding when status mismatches expected', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: '/users/42', method: 'GET', status: 500, body: { error: 'oops' },
        headers: { 'content-type': 'application/json' } },
    ]);
    ctx.plan.apiEndpoints = [{
      method: 'GET',
      path: '/users/:id',
      expectedStatus: 200,
      pathParams: { id: '42' },
    }];

    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'high');  // 5xx → high
    assert.equal(result.findings[0].ruleId, 'api-status-mismatch');
    assert.match(result.findings[0].description, /Expected status 200 but got 500/);
  });

  it('emits finding when response schema mismatches', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: '/users/42', method: 'GET', status: 200, body: { wrong: true },
        headers: { 'content-type': 'application/json' } },
    ]);
    ctx.plan.apiEndpoints = [{
      method: 'GET',
      path: '/users/:id',
      expectedStatus: 200,
      pathParams: { id: '42' },
      responseSchema: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } },
    }];

    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'api-schema-mismatch');
  });

  it('emits finding on network error', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: '/users/42', method: 'GET', throw: 'ECONNREFUSED' },
    ]);
    ctx.plan.apiEndpoints = [{
      method: 'GET',
      path: '/users/:id',
      expectedStatus: 200,
      pathParams: { id: '42' },
    }];

    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'high');
    assert.equal(result.findings[0].ruleId, 'api-error');
  });

  it('sends POST body for POST endpoints', async () => {
    let capturedInit;
    ctx.options.fetch = async (url, init) => {
      capturedInit = init;
      return {
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() { return { created: true }; },
        async text() { return '{}'; },
      };
    };
    ctx.plan.apiEndpoints = [{
      method: 'POST',
      path: '/users',
      expectedStatus: 201,
      body: { email: 'a@b.com', name: 'Alice' },
    }];

    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(capturedInit.method, 'POST');
    assert.equal(capturedInit.headers['Content-Type'], 'application/json');
    assert.ok(capturedInit.body.includes('Alice'));
  });

  it('handles empty endpoints list (no-op)', async () => {
    ctx.plan.apiEndpoints = [];
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.probed, 0);
  });

  it('respects abort signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    ctx.signal = ctrl.signal;
    ctx.plan.apiEndpoints = [
      { method: 'GET', path: '/a' },
      { method: 'GET', path: '/b' },
    ];
    ctx.options.fetch = makeMockFetch([
      { url: '/a', method: 'GET', status: 200, body: {} },
      { url: '/b', method: 'GET', status: 200, body: {} },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 0);
  });
});

// ─── session-gated / bot-wall classification (Rung 3 noise fixes) ────

describe('apiContract session-gated classification', () => {
  function ctxWithEndpoints(endpoints) {
    const ctx = baseCtx();
    ctx.plan.apiEndpoints = endpoints;
    return ctx;
  }

  it('downgrades a session-gated GET status mismatch to suspected/environmental', async () => {
    const ctx = ctxWithEndpoints([
      { method: 'GET', path: '/accounts/xuserid/', expectedStatus: 200, requiresSession: true },
    ]);
    ctx.options.fetch = makeMockFetch([
      { url: '/accounts/xuserid/', method: 'GET', status: 404, body: 'Not Found' },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.severity, 'low');
    assert.equal(f.confidence, 'suspected');
    assert.equal(f.findingType, 'environmental');
  });

  it('keeps a public GET status mismatch as a confirmed bug', async () => {
    const ctx = ctxWithEndpoints([
      { method: 'GET', path: '/api/public-data', expectedStatus: 200 },
    ]);
    ctx.options.fetch = makeMockFetch([
      { url: '/api/public-data', method: 'GET', status: 404, body: 'Not Found' },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.severity, 'medium');
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.findingType, 'bug');
  });

  it('downgrades an empty-body schema mismatch (bot wall) to suspected/environmental', async () => {
    const ctx = ctxWithEndpoints([
      {
        method: 'POST',
        path: '/ajax/bz',
        expectedStatus: 200,
        responseSchema: { type: 'object', properties: { __ar: { type: 'integer' } } },
      },
    ]);
    ctx.options.fetch = makeMockFetch([
      { url: '/ajax/bz', method: 'POST', status: 200, body: '', headers: {} },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.ruleId, 'api-schema-mismatch');
    assert.equal(f.severity, 'low');
    assert.equal(f.confidence, 'suspected');
    assert.equal(f.findingType, 'environmental');
  });

  it('keeps a genuine schema break on a public endpoint as a bug', async () => {
    const ctx = ctxWithEndpoints([
      {
        method: 'GET',
        path: '/api/profile',
        expectedStatus: 200,
        responseSchema: { type: 'object', properties: { id: { type: 'number' } } },
      },
    ]);
    ctx.options.fetch = makeMockFetch([
      { url: '/api/profile', method: 'GET', status: 200, body: { name: 'Alice' },
        headers: { 'content-type': 'application/json' } },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.ruleId, 'api-schema-mismatch');
    assert.equal(f.severity, 'medium');
    assert.equal(f.confidence, 'high');
    assert.equal(f.findingType, 'bug');
  });
});

describe('apiContract observedStatuses classification', () => {
  function ctxWithEndpoints(endpoints) {
    const ctx = baseCtx();
    ctx.plan.apiEndpoints = endpoints;
    return ctx;
  }

  it('downgrades a mismatch whose status the browser also saw during the crawl', async () => {
    const ctx = ctxWithEndpoints([
      { method: 'GET', path: '/i/lib/nls/localeElements.js', expectedStatus: 200, observedStatuses: [200, 404] },
    ]);
    let receivedUrl;
    ctx.options.fetch = (url) => {
      receivedUrl = String(url);
      return Promise.resolve({
        status: 404,
        headers: new Headers({ 'content-type': 'text/html' }),
        async json() { return null; },
        async text() { return 'Not Found'; },
      });
    };
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.severity, 'low');
    assert.equal(f.confidence, 'suspected');
    assert.equal(f.findingType, 'environmental');
  });

  it('keeps a never-observed 404 on a public GET as a confirmed bug', async () => {
    const ctx = ctxWithEndpoints([
      { method: 'GET', path: '/api/real-endpoint', expectedStatus: 200 },
    ]);
    ctx.options.fetch = makeMockFetch([
      { url: '/api/real-endpoint', method: 'GET', status: 404, body: 'Not Found' },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.severity, 'medium');
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.findingType, 'bug');
  });

  it('sends the query string recorded from the crawl (replay fidelity)', async () => {
    const ctx = ctxWithEndpoints([
      { method: 'GET', path: '/i/lib/nls/localeElements.js', expectedStatus: 200, queryParams: { lang: 'en' } },
    ]);
    let receivedUrl = '';
    ctx.options.fetch = (url) => {
      receivedUrl = String(url);
      return Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() { return ({ ok: true }); },
        async text() { return '{"ok":true}'; },
      });
    };
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 0);
    assert.ok(receivedUrl.includes('lang=en'), `expected query in URL: ${receivedUrl}`);
  });
});

describe('apiContract WAF-challenge classification', () => {
  function ctxWithEndpoints(endpoints) {
    const ctx = baseCtx();
    ctx.plan.apiEndpoints = endpoints;
    return ctx;
  }

  it('downgrades a Cloudflare-challenge 403 to suspected/environmental', async () => {
    const ctx = ctxWithEndpoints([
      { method: 'GET', path: '/platform/plugin/tab/renderer/', expectedStatus: 200 },
    ]);
    const cfBody = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>cf-ray: 8f3a</body></html>';
    ctx.options.fetch = makeMockFetch([
      { url: '/platform/plugin/tab/renderer/', method: 'GET', status: 403, body: cfBody },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.severity, 'low');
    assert.equal(f.confidence, 'suspected');
    assert.equal(f.findingType, 'environmental');
    assert.ok(f.description.includes('WAF'));
  });

  it('keeps a plain 403 without a challenge body as a confirmed bug', async () => {
    const ctx = ctxWithEndpoints([
      { method: 'GET', path: '/api/gated', expectedStatus: 200 },
    ]);
    ctx.options.fetch = makeMockFetch([
      { url: '/api/gated', method: 'GET', status: 403, body: 'Forbidden' },
    ]);
    const result = await apiContract(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.severity, 'medium');
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.findingType, 'bug');
  });
});
