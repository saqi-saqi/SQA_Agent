import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasSessionHeaders, fallbackEndpoints, normalizePath } from '../src/explorer/apiInferrer.js';
import { TestPlan, arrayElementSchema } from '../src/services/testPlan.js';

const endpointSchema = arrayElementSchema(TestPlan.shape.apiEndpoints);

describe('hasSessionHeaders', () => {
  it('detects a cookie header (value redacted, name preserved)', () => {
    assert.equal(hasSessionHeaders({ cookie: '[REDACTED]' }), true);
  });

  it('detects an authorization header regardless of case', () => {
    assert.equal(hasSessionHeaders({ Authorization: '[REDACTED]' }), true);
    assert.equal(hasSessionHeaders({ 'AUTHORIZATION': 'x' }), true);
  });

  it('detects api-key style headers', () => {
    assert.equal(hasSessionHeaders({ 'x-api-key': '[REDACTED]' }), true);
    assert.equal(hasSessionHeaders({ 'X-Auth-Token': '[REDACTED]' }), true);
  });

  it('returns false for ordinary headers', () => {
    assert.equal(hasSessionHeaders({ 'content-type': 'application/json', 'accept': '*/*' }), false);
  });

  it('returns false for empty/missing headers', () => {
    assert.equal(hasSessionHeaders({}), false);
    assert.equal(hasSessionHeaders(undefined), false);
  });
});

describe('fallbackEndpoints session stamping', () => {
  it('marks endpoints whose captured calls carried session credentials', () => {
    const endpoints = fallbackEndpoints([
      {
        method: 'GET',
        url: 'https://site.com/api/session-data',
        status: 200,
        requestHeaders: { cookie: '[REDACTED]' },
      },
      {
        method: 'GET',
        url: 'https://site.com/api/public-data',
        status: 200,
        requestHeaders: { 'content-type': 'application/json' },
      },
    ]);
    const byPath = Object.fromEntries(endpoints.map(e => [e.path, e]));
    assert.equal(byPath['/api/session-data'].requiresSession, true);
    assert.equal(byPath['/api/public-data'].requiresSession, false);
  });

  it('marks an endpoint session-gated if ANY observed call used credentials', () => {
    const endpoints = fallbackEndpoints([
      {
        method: 'POST',
        url: 'https://site.com/api/save',
        status: 200,
        requestHeaders: { 'content-type': 'application/json' },
      },
      {
        method: 'POST',
        url: 'https://site.com/api/save',
        status: 200,
        requestHeaders: { 'content-type': 'application/json', authorization: '[REDACTED]' },
      },
    ]);
    assert.equal(endpoints[0].requiresSession, true);
  });
});

describe('ApiEndpoint schema accepts requiresSession', () => {
  const valid = {
    method: 'GET',
    path: '/api/users/:id',
    expectedStatus: 200,
    requiresSession: true,
  };

  it('parses an endpoint with requiresSession', () => {
    const parsed = endpointSchema.safeParse(valid);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.requiresSession, true);
  });

  it('parses without requiresSession (optional)', () => {
    const { requiresSession, ...without } = valid;
    const parsed = endpointSchema.safeParse(without);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.requiresSession, undefined);
  });

  it('still rejects unknown keys (strict schema)', () => {
    const parsed = endpointSchema.safeParse({ ...valid, evilField: true });
    assert.equal(parsed.success, false);
  });
});

describe('normalizePath (existing behavior guard)', () => {
  it('still normalizes numeric segments', () => {
    assert.equal(normalizePath('/users/123/posts/456'), '/users/:id/posts/:id');
  });
});

// ─── replay fidelity: query params + observedStatuses ────────────────

describe('fallbackEndpoints replay fidelity', () => {
  it('preserves the query string from the 2xx observation', () => {
    const endpoints = fallbackEndpoints([
      // browser saw BOTH a 200 (with query) and a 404 (without) — the 2xx
      // URL with its query must win so the replay reproduces it
      { method: 'GET', url: 'https://s.com/i/lib/nls/localeElements.js', status: 404, requestHeaders: {} },
      { method: 'GET', url: 'https://s.com/i/lib/nls/localeElements.js?lang=en&v=11.0.0', status: 200, requestHeaders: {} },
    ]);
    assert.equal(endpoints.length, 1);
    assert.deepEqual(endpoints[0].queryParams, { lang: 'en', v: '11.0.0' });
    assert.equal(endpoints[0].expectedStatus, 200);
  });

  it('stamps observedStatuses with every status the browser saw', () => {
    const endpoints = fallbackEndpoints([
      { method: 'GET', url: 'https://s.com/api/x', status: 200, requestHeaders: {} },
      { method: 'GET', url: 'https://s.com/api/x', status: 404, requestHeaders: {} },
    ]);
    assert.equal(endpoints[0].observedStatuses.includes(200), true);
    assert.equal(endpoints[0].observedStatuses.includes(404), true);
  });

  it('falls back to the only observed URL when no 2xx exists', () => {
    const endpoints = fallbackEndpoints([
      { method: 'GET', url: 'https://s.com/x?keep=1', status: 404, requestHeaders: {} },
    ]);
    assert.deepEqual(endpoints[0].queryParams, { keep: '1' });
  });

  it('caps query params at 8', () => {
    const q = Array.from({ length: 12 }, (_, i) => `p${i}=v`).join('&');
    const endpoints = fallbackEndpoints([
      { method: 'GET', url: `https://s.com/x?${q}`, status: 200, requestHeaders: {} },
    ]);
    assert.ok(Object.keys(endpoints[0].queryParams).length <= 8);
  });
});

// ─── third-party (cross-origin) call filtering ───────────────────────

describe('inferApiEndpoints same-origin filter', () => {
  it('excludes third-party widget calls and keeps same-origin ones', async () => {
    const { inferApiEndpoints } = await import('../src/explorer/apiInferrer.js');
    const pages = [{
      apiCalls: [
        // third-party Facebook plugin call (the qau.edu.pk case)
        { method: 'GET', url: 'https://www.facebook.com/platform/plugin/tab/renderer/?key=timeline', status: 200, requestHeaders: {} },
        // the site's own API
        { method: 'GET', url: 'https://qau.edu.pk/wp-json/wp/v2/posts', status: 200, requestHeaders: {} },
      ],
    }];
    const { endpoints, warnings } = await inferApiEndpoints({
      pages,
      siteOrigin: 'https://qau.edu.pk',
      llmOpts: { provider: { name: 'mock', chat: async () => ({ ok: false, error: 'no llm' }) } },
    });
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].path, '/wp-json/wp/v2/posts');
    assert.ok(warnings.some(w => w.includes('third-party')), 'expected a third-party warning');
  });

  it('returns no endpoints when every call is third-party', async () => {
    const { inferApiEndpoints } = await import('../src/explorer/apiInferrer.js');
    const pages = [{
      apiCalls: [
        { method: 'GET', url: 'https://www.facebook.com/platform/plugin/tab/renderer/', status: 200, requestHeaders: {} },
        { method: 'GET', url: 'https://www.google-analytics.com/collect', status: 200, requestHeaders: {} },
      ],
    }];
    const { endpoints, warnings } = await inferApiEndpoints({
      pages,
      siteOrigin: 'https://qau.edu.pk',
    });
    assert.equal(endpoints.length, 0);
    assert.ok(warnings.some(w => w.includes('nothing same-origin')));
  });

  it('does not filter when siteOrigin is missing (backwards compat)', async () => {
    const { inferApiEndpoints } = await import('../src/explorer/apiInferrer.js');
    const pages = [{
      apiCalls: [
        { method: 'GET', url: 'https://other.com/api/x', status: 200, requestHeaders: {} },
      ],
    }];
    const { endpoints } = await inferApiEndpoints({ pages, llmOpts: { provider: { chat: async () => ({ ok: false, error: 'no llm' }) } } });
    assert.equal(endpoints.length, 1);
  });
});
