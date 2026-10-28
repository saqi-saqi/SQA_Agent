import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePath,
  fallbackEndpoints,
  inferApiEndpoints,
} from '../src/explorer/apiInferrer.js';
import { MockProvider, setDefaultProvider } from '../src/explorer/llmProvider.js';

describe('normalizePath', () => {
  it('replaces numeric segments with :id', () => {
    assert.equal(normalizePath('/users/123'), '/users/:id');
    assert.equal(normalizePath('/users/123/posts/456'), '/users/:id/posts/:id');
  });

  it('replaces UUIDs with :id', () => {
    assert.equal(
      normalizePath('/items/550e8400-e29b-41d4-a716-446655440000'),
      '/items/:id'
    );
  });

  it('replaces long alphanumeric slugs with :slug', () => {
    assert.equal(normalizePath('/posts/a1b2c3d4e5f6g7h8'), '/posts/:slug');
  });

  it('preserves short paths', () => {
    assert.equal(normalizePath('/api/users'), '/api/users');
    assert.equal(normalizePath('/'), '/');
    assert.equal(normalizePath('/login'), '/login');
  });

  it('preserves known words (no digits)', () => {
    assert.equal(normalizePath('/api/users/admin'), '/api/users/admin');
  });
});

describe('fallbackEndpoints', () => {
  it('groups by (method, normalized path)', () => {
    const calls = [
      { method: 'GET', url: 'https://example.com/users/1', status: 200 },
      { method: 'GET', url: 'https://example.com/users/2', status: 200 },
      { method: 'GET', url: 'https://example.com/users/3', status: 200 },
    ];
    const eps = fallbackEndpoints(calls);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].method, 'GET');
    assert.equal(eps[0].path, '/users/:id');
    assert.ok(eps[0].description.includes('observed 3x'));
  });

  it('uses 2xx status as expectedStatus when available', () => {
    const calls = [
      { method: 'POST', url: 'https://x.com/login', status: 401 },
      { method: 'POST', url: 'https://x.com/login', status: 200 },
    ];
    const eps = fallbackEndpoints(calls);
    assert.equal(eps[0].expectedStatus, 200);
  });

  it('skips invalid URLs', () => {
    const calls = [
      { method: 'GET', url: 'not-a-url', status: 200 },
      { method: 'GET', url: 'https://x.com/ok', status: 200 },
    ];
    const eps = fallbackEndpoints(calls);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].path, '/ok');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(fallbackEndpoints([]), []);
    assert.deepEqual(fallbackEndpoints(null), []);
  });
});

describe('inferApiEndpoints with MockProvider', () => {
  afterEach(() => {
    setDefaultProvider(new MockProvider({}));
  });

  it('uses LLM response when valid', async () => {
    const mockResponse = {
      endpoints: [
        {
          method: 'GET',
          path: '/api/users/:id',
          expectedStatus: 200,
          description: 'Fetch user by ID',
          requestSchema: null,
          responseSchema: { type: 'object' },
          pathParams: { id: 'sample' },
        },
      ],
    };
    setDefaultProvider(new MockProvider({ 'Infer API endpoint': mockResponse }));

    const pages = [{
      url: 'https://example.com',
      apiCalls: [
        { method: 'GET', url: 'https://example.com/api/users/123', status: 200 },
      ],
    }];

    const result = await inferApiEndpoints({ pages, siteOrigin: 'https://example.com' });
    assert.equal(result.endpoints.length, 1);
    assert.equal(result.endpoints[0].method, 'GET');
    assert.equal(result.endpoints[0].path, '/api/users/:id');
    assert.equal(result.endpoints[0].description, 'Fetch user by ID');
  });

  it('drops invalid LLM-suggested endpoints', async () => {
    const mockResponse = {
      endpoints: [
        // Valid
        { method: 'GET', path: '/ok', expectedStatus: 200 },
        // Invalid method
        { method: 'CONNECT', path: '/bad' },
        // Invalid path (empty)
        { method: 'GET', path: '' },
      ],
    };
    setDefaultProvider(new MockProvider({ 'Infer API endpoint': mockResponse }));

    const pages = [{
      url: 'https://example.com',
      apiCalls: [{ method: 'GET', url: 'https://example.com/ok', status: 200 }],
    }];

    const result = await inferApiEndpoints({ pages, siteOrigin: 'https://example.com' });
    assert.equal(result.endpoints.length, 1);
    assert.equal(result.endpoints[0].path, '/ok');
    assert.ok(result.warnings.length >= 2);  // both invalid endpoints warned
  });

  it('falls back to heuristics when LLM produces zero valid endpoints', async () => {
    setDefaultProvider(new MockProvider({}));

    const pages = [{
      url: 'https://example.com',
      apiCalls: [
        { method: 'GET', url: 'https://example.com/users/1', status: 200 },
        { method: 'POST', url: 'https://example.com/login', status: 200 },
      ],
    }];

    const result = await inferApiEndpoints({ pages, siteOrigin: 'https://example.com' });
    assert.ok(result.endpoints.length >= 2);
    assert.ok(result.warnings.some(w => /falling back/i.test(w)));
  });

  it('returns empty endpoints when no apiCalls were captured', async () => {
    const pages = [{ url: 'https://example.com', apiCalls: [] }];
    const result = await inferApiEndpoints({ pages, siteOrigin: 'https://example.com' });
    assert.equal(result.endpoints.length, 0);
    assert.equal(result.warnings.length, 0);
  });
});
