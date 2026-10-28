import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrlForPrompt, toShapeOnly, flowInferencePrompt, apiInferencePrompt, pageSummaryPrompt } from '../src/explorer/prompts.js';
import { MockProvider, setDefaultProvider } from '../src/explorer/llmProvider.js';

// Fake secrets — if ANY of these appear in an LLM message, privacy is broken.
const SECRETS = {
  token: 'SECRET-JWT-TOKEN-9f8e7d6c5b4a',
  email: 'real.person@university.edu.pk',
  password: 'MY-REAL-PASSWORD-123',
  name: 'Ali Raza',
  queryToken: 'SECRET-QUERY-TOKEN',
};

describe('sanitizeUrlForPrompt', () => {
  it('keeps origin, path and param NAMES — strips values', () => {
    const out = sanitizeUrlForPrompt(`https://site.com/page?lang=ENGLISH-VALUE&token=${SECRETS.queryToken}&x=1`);
    assert.ok(out.startsWith('https://site.com/page'));
    assert.ok(out.includes('lang='), 'param names should remain');
    assert.ok(out.includes('token='), 'param names should remain');
    assert.ok(!out.includes(SECRETS.queryToken), 'query VALUES must be stripped');
    assert.ok(!out.includes('ENGLISH-VALUE'), 'query values must be stripped');
  });

  it('passes through URLs without query strings', () => {
    assert.equal(sanitizeUrlForPrompt('https://site.com/about'), 'https://site.com/about');
  });

  it('survives malformed URLs', () => {
    assert.equal(sanitizeUrlForPrompt('not-a-url'), 'not-a-url');
  });
});

describe('toShapeOnly', () => {
  it('replaces every string value with the type name', () => {
    const out = toShapeOnly({ token: SECRETS.token, email: SECRETS.email, count: 5, active: true, note: null });
    assert.deepEqual(out, { token: 'string', email: 'string', count: 'number', active: 'boolean', note: null });
  });

  it('preserves nesting and array shapes', () => {
    const out = toShapeOnly({ user: { name: SECRETS.name, marks: [95, 88] }, tags: ['a', 'b'] });
    assert.deepEqual(out, { user: { name: 'string', marks: ['number'] }, tags: ['string'] });
  });

  it('caps recursion depth and object size', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'deep-secret' } } } } } } } };
    const out = JSON.stringify(toShapeOnly(deep));
    assert.ok(!out.includes('deep-secret'));
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v']));
    assert.equal(Object.keys(toShapeOnly(wide)).length, 25);
  });
});

// ─── boundary enforcement through the real prompt builders ───────────

describe('LLM privacy boundary (prompt builders)', () => {
  it('apiInferencePrompt never contains body values', () => {
    const { user } = apiInferencePrompt({
      siteOrigin: 'https://app.com',
      apiCalls: [{
        method: 'POST',
        url: `https://app.com/api/session/refresh?token=${SECRETS.queryToken}`,
        status: 200,
        requestHeaders: { cookie: '[REDACTED]' },
        requestBody: { refreshToken: SECRETS.token },
        responseBody: { token: SECRETS.token, user: { email: SECRETS.email, name: SECRETS.name } },
        responseContentType: 'application/json',
      }],
    });
    assert.ok(user.includes('"refreshToken": "string"'), 'shape keys must remain for planning');
    assert.ok(user.includes('"user"'));
    for (const secret of Object.values(SECRETS)) {
      assert.ok(!user.includes(secret), `LEAK: ${secret} reached the LLM prompt`);
    }
  });

  it('flowInferencePrompt never contains URL query values or bodies', () => {
    const { user } = flowInferencePrompt({
      pages: [{
        url: `https://app.com/dashboard?session=${SECRETS.queryToken}`,
        title: 'Dashboard',
        meta: { h1: 'Dashboard' },
        forms: 1, buttons: 3, inputs: 2,
        links: [`https://app.com/profile?token=${SECRETS.queryToken}`],
        apiCalls: [{ method: 'GET', url: `https://app.com/api/me?token=${SECRETS.queryToken}`, status: 200 }],
      }],
    });
    assert.ok(user.includes('Dashboard'));
    for (const secret of Object.values(SECRETS)) {
      assert.ok(!user.includes(secret), `LEAK: ${secret} reached the LLM prompt`);
    }
  });

  it('pageSummaryPrompt sanitizes URLs too', () => {
    const { user } = pageSummaryPrompt({
      pages: [{ url: `https://app.com/?auth=${SECRETS.queryToken}`, title: 'Home', forms: 0, buttons: 1, inputs: 0 }],
    });
    assert.ok(!user.includes(SECRETS.queryToken));
  });
});

// ─── end-to-end: what the provider would actually transmit ────────────

describe('LLM privacy boundary (through MockProvider)', () => {
  it('the message a real provider receives contains no secrets', async () => {
    const mock = new MockProvider({});
    setDefaultProvider(mock);

    const { system, user } = apiInferencePrompt({
      siteOrigin: 'https://app.com',
      apiCalls: [{
        method: 'POST',
        url: 'https://app.com/api/login',
        status: 200,
        requestHeaders: {},
        requestBody: { email: SECRETS.email, password: SECRETS.password },
        responseBody: { token: SECRETS.token },
        responseContentType: 'application/json',
      }],
    });
    await mock.chat({ system, user, json: true });

    // The exact text a real provider would receive
    const transmitted = mock.calls.map(c => `${c.system || ''}\n${c.user || ''}`).join('\n');
    for (const secret of Object.values(SECRETS)) {
      assert.ok(!transmitted.includes(secret), `LEAK: ${secret} would be transmitted to the AI provider`);
    }
    // Shapes still present so planning works
    assert.ok(transmitted.includes('"email": "string"'));
    assert.ok(transmitted.includes('"password": "string"'));
    assert.ok(transmitted.includes('"token": "string"'));
  });
});
