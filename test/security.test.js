import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import securityExecutor, { analyzeCookie, detectMixedContent } from '../src/executors/security.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── mock fetch helper ───────────────────────────────────────────────

function makeMockFetch(routes) {
  return async (url) => {
    const u = typeof url === 'string' ? url : url.toString();
    const match = routes.find(r => u.includes(r.url));
    if (!match) throw new Error(`No mock for ${u}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(match.headers || {})) headers.set(k, v);
    if (match.cookies) {
      // Headers polyfill: simulate set-cookie via raw set
      const setCookie = headers.setRaw ? headers.setRaw : (k, v) => headers.set(k, v);
      for (const c of match.cookies) {
        headers.append('set-cookie', c);
      }
      // Some implementations need getSetCookie(); mock it on the Headers instance
      headers.getSetCookie = () => match.cookies;
    } else {
      headers.getSetCookie = () => [];
    }
    return { status: match.status || 200, headers };
  };
}

const baseCtx = (overrides = {}) => ({
  plan: { targetUrl: 'https://example.com', pages: [] },
  createFinding: createFindingFactory(),
  onEvent: () => {},
  signal: undefined,
  options: {},
  ...overrides,
});

// ─── analyzeCookie ──────────────────────────────────────────────────

describe('analyzeCookie', () => {
  it('flags HTTPS cookie missing Secure flag', () => {
    const issues = analyzeCookie('session=abc123; Path=/', 'https://example.com');
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-secure'));
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-httponly'));
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-samesite'));
  });

  it('does NOT flag missing Secure over HTTP', () => {
    const issues = analyzeCookie('session=abc123; Path=/', 'http://example.com');
    assert.ok(!issues.some(i => i.ruleId === 'cookie-no-secure'));
  });

  it('passes when all attributes present (HTTPS)', () => {
    const issues = analyzeCookie(
      'session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax',
      'https://example.com'
    );
    assert.equal(issues.length, 0);
  });

  it('flags SameSite=None without Secure', () => {
    const issues = analyzeCookie(
      'tracking=xyz; SameSite=None',
      'https://example.com'
    );
    assert.ok(issues.some(i => i.ruleId === 'cookie-samesite-none-insecure'));
  });

  it('passes SameSite=None with Secure', () => {
    const issues = analyzeCookie(
      'tracking=xyz; SameSite=None; Secure',
      'https://example.com'
    );
    assert.ok(!issues.some(i => i.ruleId === 'cookie-samesite-none-insecure'));
  });

  it('handles malformed cookie string', () => {
    const issues = analyzeCookie('just-a-name', 'https://example.com');
    // Should still flag missing attributes
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-httponly'));
  });
});

// ─── detectMixedContent ─────────────────────────────────────────────

describe('detectMixedContent', () => {
  it('flags HTTP apiCalls on HTTPS page as active mixed content', () => {
    const issues = detectMixedContent({
      url: 'https://example.com/secure',
      apiCalls: [
        { method: 'GET', url: 'http://insecure.example.com/data' },
        { method: 'GET', url: 'https://api.example.com/ok' },
      ],
      imageDetails: [],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].ruleId, 'mixed-content-active');
    assert.equal(issues[0].severity, 'high');
  });

  it('flags HTTP image src on HTTPS page as passive mixed content', () => {
    const issues = detectMixedContent({
      url: 'https://example.com/secure',
      apiCalls: [],
      imageDetails: [
        { src: 'http://insecure.example.com/logo.png' },
        { src: 'https://cdn.example.com/icon.png' },
      ],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].ruleId, 'mixed-content-passive');
    assert.equal(issues[0].severity, 'medium');
  });

  it('returns no issues for HTTP page (mixed content only applies to HTTPS)', () => {
    const issues = detectMixedContent({
      url: 'http://example.com/insecure',
      apiCalls: [{ method: 'GET', url: 'http://other.com/data' }],
      imageDetails: [{ src: 'http://other.com/img.png' }],
    });
    assert.equal(issues.length, 0);
  });

  it('returns no issues for clean HTTPS page', () => {
    const issues = detectMixedContent({
      url: 'https://example.com',
      apiCalls: [{ method: 'GET', url: 'https://api.example.com/data' }],
      imageDetails: [{ src: 'https://cdn.example.com/img.png' }],
    });
    assert.equal(issues.length, 0);
  });

  it('handles page without apiCalls or imageDetails', () => {
    const issues = detectMixedContent({ url: 'https://example.com' });
    assert.equal(issues.length, 0);
  });
});

// ─── executor end-to-end ────────────────────────────────────────────

describe('security executor', () => {
  let ctx;

  beforeEach(() => {
    ctx = baseCtx();
  });

  it('flags missing security headers', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: 'https://example.com', headers: {} },
    ]);
    ctx.plan.pages = [{ url: 'https://example.com' }];

    const result = await securityExecutor(ctx);
    // Missing: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
    // Permissions-Policy, COOP, CORP
    assert.ok(result.findings.length >= 6);
    const ruleIds = result.findings.map(f => f.ruleId);
    assert.ok(ruleIds.includes('header-content-security-policy'));
    assert.ok(ruleIds.includes('header-strict-transport-security'));
    assert.ok(ruleIds.includes('header-x-content-type-options'));
  });

  it('passes when all security headers are present', async () => {
    ctx.options.fetch = makeMockFetch([
      {
        url: 'https://example.com',
        headers: {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000; includeSubDomains',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'strict-origin-when-cross-origin',
          'permissions-policy': 'camera=()',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-site',
        },
      },
    ]);
    ctx.plan.pages = [{ url: 'https://example.com' }];

    const result = await securityExecutor(ctx);
    const headerFindings = result.findings.filter(f => f.ruleId.startsWith('header-'));
    assert.equal(headerFindings.length, 0);
  });

  it('skips HSTS check on HTTP pages', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: 'http://example.com', headers: {} },
    ]);
    ctx.plan.pages = [{ url: 'http://example.com' }];

    const result = await securityExecutor(ctx);
    assert.ok(!result.findings.some(f => f.ruleId === 'header-strict-transport-security'));
  });

  it('emits cookie findings when cookies lack attributes', async () => {
    ctx.options.fetch = makeMockFetch([
      {
        url: 'https://example.com',
        headers: {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'permissions-policy': 'camera=()',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-site',
        },
        cookies: ['session=abc; Path=/'],
      },
    ]);
    ctx.plan.pages = [{ url: 'https://example.com' }];

    const result = await securityExecutor(ctx);
    const cookieFindings = result.findings.filter(f => f.ruleId.startsWith('cookie-'));
    assert.ok(cookieFindings.length >= 2);
  });

  it('includes mixed content findings from crawler data', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: 'https://example.com', headers: {
        'content-security-policy': "default-src 'self'",
        'strict-transport-security': 'max-age=31536000',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'camera=()',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-site',
      } },
    ]);
    ctx.plan.pages = [{
      url: 'https://example.com',
      apiCalls: [{ method: 'GET', url: 'http://insecure.com/data' }],
      imageDetails: [],
    }];

    const result = await securityExecutor(ctx);
    assert.ok(result.findings.some(f => f.ruleId === 'mixed-content-active'));
  });

  it('deduplicates URLs across pages + viewports', async () => {
    let callCount = 0;
    ctx.options.fetch = async () => { callCount++; return { status: 200, headers: new Headers() }; };
    ctx.plan.pages = [
      { url: 'https://example.com' },
      { url: 'https://example.com' },  // same URL, different viewport
      { url: 'https://example.com/about' },
    ];

    await securityExecutor(ctx);
    assert.equal(callCount, 2);  // dedup
  });

  it('handles fetch failure gracefully (skip page)', async () => {
    ctx.options.fetch = async () => { throw new Error('ECONNREFUSED'); };
    ctx.plan.pages = [{ url: 'https://down.example.com' }];

    const result = await securityExecutor(ctx);
    // Should not throw, just produce no header findings
    assert.equal(result.findings.length, 0);
  });
});
