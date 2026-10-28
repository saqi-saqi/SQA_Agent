import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fuzzExecutor, {
  generators,
  generateInputs,
  isAcceptableOutcome,
  fuzzApiField,
} from '../src/executors/fuzz.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── generators ──────────────────────────────────────────────────────

describe('generators', () => {
  it('empty returns empty string', () => {
    assert.equal(generators.empty(), '');
  });

  it('oversize returns 10000 chars', () => {
    assert.equal(generators.oversize().length, 10000);
  });

  it('unicode returns non-ASCII string', () => {
    const v = generators.unicode();
    assert.ok(/[^\x00-\x7F]/.test(v));
  });

  it('sql returns array of payloads', () => {
    const v = generators.sql();
    assert.ok(Array.isArray(v));
    assert.ok(v.length >= 3);
    assert.ok(v.some(p => /OR.*1.*1/i.test(p)));
  });

  it('xss returns array of payloads', () => {
    const v = generators.xss();
    assert.ok(Array.isArray(v));
    assert.ok(v.some(p => /<script>/i.test(p)));
  });

  it('path returns array of traversal strings', () => {
    const v = generators.path();
    assert.ok(v.some(p => /\.\./.test(p)));
  });

  it('numeric-overflow returns string of large number', () => {
    const v = generators['numeric-overflow']();
    assert.ok(Number(v) > Number.MAX_SAFE_INTEGER);
  });

  it('negative returns -1', () => {
    assert.equal(generators.negative(), '-1');
  });

  it('null-byte contains \\0', () => {
    const v = generators['null-byte']();
    assert.ok(v.includes('\0'));
  });

  it('random returns 10-char alphanumeric', () => {
    const v = generators.random();
    assert.equal(v.length, 10);
    assert.ok(/^[a-z0-9]+$/i.test(v));
  });
});

// ─── generateInputs ──────────────────────────────────────────────────

describe('generateInputs', () => {
  it('expands multi-value generators (sql/xss/path)', () => {
    const target = { generators: ['sql', 'xss'], iterations: 100 };
    const inputs = generateInputs(target);
    // Each multi-value generator should expand
    const sqlInputs = inputs.filter(i => i.generator.startsWith('sql#'));
    const xssInputs = inputs.filter(i => i.generator.startsWith('xss#'));
    assert.ok(sqlInputs.length >= 3);
    assert.ok(xssInputs.length >= 3);
  });

  it('single-value generators get a single entry', () => {
    const target = { generators: ['empty', 'oversize'], iterations: 100 };
    const inputs = generateInputs(target);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].generator, 'empty');
    assert.equal(inputs[1].generator, 'oversize');
  });

  it('caps total inputs to iterations', () => {
    const target = { generators: ['sql', 'xss', 'path'], iterations: 3 };
    const inputs = generateInputs(target);
    assert.equal(inputs.length, 3);
  });

  it('skips unknown generator names', () => {
    const target = { generators: ['unknown-gen', 'empty'], iterations: 10 };
    const inputs = generateInputs(target);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].generator, 'empty');
  });

  it('returns empty array for empty generators', () => {
    const target = { generators: [], iterations: 10 };
    assert.equal(generateInputs(target).length, 0);
  });
});

// ─── isAcceptableOutcome ────────────────────────────────────────────

describe('isAcceptableOutcome', () => {
  it('no-5xx: accepts 4xx', () => {
    assert.equal(isAcceptableOutcome(400, false, 'no-5xx'), true);
    assert.equal(isAcceptableOutcome(404, false, 'no-5xx'), true);
  });

  it('no-5xx: rejects 5xx', () => {
    assert.equal(isAcceptableOutcome(500, false, 'no-5xx'), false);
    assert.equal(isAcceptableOutcome(503, false, 'no-5xx'), false);
  });

  it('any-2xx-or-4xx: accepts 2xx and 4xx, rejects 5xx', () => {
    assert.equal(isAcceptableOutcome(200, false, 'any-2xx-or-4xx'), true);
    assert.equal(isAcceptableOutcome(404, false, 'any-2xx-or-4xx'), true);
    assert.equal(isAcceptableOutcome(500, false, 'any-2xx-or-4xx'), false);
    assert.equal(isAcceptableOutcome(302, false, 'any-2xx-or-4xx'), false);  // redirects
  });

  it('no-crash: rejects when threw=true', () => {
    assert.equal(isAcceptableOutcome(null, true, 'no-crash'), false);
    assert.equal(isAcceptableOutcome(200, false, 'no-crash'), true);
  });
});

// ─── fuzzApiField ───────────────────────────────────────────────────

describe('fuzzApiField', () => {
  let ctx;
  beforeEach(() => {
    ctx = {
      plan: {
        targetUrl: 'https://api.example.com',
        apiEndpoints: [
          {
            method: 'POST',
            path: '/login',
            body: { email: 'test@example.com', password: 'secret' },
          },
        ],
      },
      options: {},
    };
  });

  it('sends mutated field value in request body', async () => {
    let capturedBody;
    ctx.options.fetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { status: 200, headers: new Headers() };
    };

    const target = { apiEndpointRef: '/login', field: 'email' };
    const result = await fuzzApiField(target, 'INJECTED-VALUE', ctx);

    assert.equal(capturedBody.email, 'INJECTED-VALUE');
    assert.equal(capturedBody.password, 'secret');  // unchanged
    assert.equal(result.threw, false);
  });

  it('returns threw=true on fetch error', async () => {
    ctx.options.fetch = async () => { throw new Error('boom'); };
    const target = { apiEndpointRef: '/login', field: 'email' };
    const result = await fuzzApiField(target, 'x', ctx);
    assert.equal(result.threw, true);
    assert.match(result.error, /boom/);
  });

  it('throws when endpoint not found', async () => {
    ctx.options.fetch = async () => ({ status: 200, headers: new Headers() });
    const target = { apiEndpointRef: '/nonexistent', field: 'email' };
    await assert.rejects(
      () => fuzzApiField(target, 'x', ctx),
      /unknown endpoint/i,
    );
  });

  it('skips GET endpoints (no body to fuzz)', async () => {
    ctx.plan.apiEndpoints = [{ method: 'GET', path: '/users' }];
    const target = { apiEndpointRef: '/users', field: 'id' };
    const result = await fuzzApiField(target, '1', ctx);
    assert.equal(result.skipped, true);
  });
});

// ─── executor end-to-end ────────────────────────────────────────────

describe('fuzzExecutor end-to-end', () => {
  let ctx;
  beforeEach(() => {
    ctx = {
      plan: {
        targetUrl: 'https://api.example.com',
        apiEndpoints: [],
        fuzzTargets: [],
      },
      options: {},
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
  });

  it('emits finding when fuzz causes 5xx', async () => {
    ctx.plan.apiEndpoints = [{
      method: 'POST',
      path: '/login',
      body: { email: 'test@example.com', password: 'x' },
    }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login',
      field: 'email',
      generators: ['empty', 'oversize'],
      iterations: 5,
      expectStatus: 'no-5xx',
    }];
    ctx.options.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      // Return 500 for oversize input
      if (body.email && body.email.length > 1000) {
        return { status: 500, headers: new Headers() };
      }
      return { status: 200, headers: new Headers() };
    };

    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'high');
    assert.equal(result.findings[0].ruleId, 'fuzz-failure');
    assert.match(result.findings[0].title, /oversize/);
  });

  it('does NOT emit findings when all fuzz responses are acceptable', async () => {
    ctx.plan.apiEndpoints = [{
      method: 'POST',
      path: '/login',
      body: { email: 'x' },
    }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login',
      field: 'email',
      generators: ['empty'],
      iterations: 1,
      expectStatus: 'no-5xx',
    }];
    ctx.options.fetch = async () => ({ status: 400, headers: new Headers() });

    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
  });

  it('handles empty fuzz targets (no-op)', async () => {
    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.targetsRun, 0);
  });

  it('skips form-based fuzz targets when no Playwright context', async () => {
    ctx.plan.fuzzTargets = [{
      pageUrl: 'https://example.com/form',
      formSelector: 'form',
      fieldSelector: 'input',
      generators: ['empty'],
      iterations: 1,
    }];
    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
  });

  it('respects abort signal', async () => {
    ctx.signal = { aborted: true, addEventListener: () => {} };
    ctx.plan.apiEndpoints = [{ method: 'POST', path: '/x', body: {} }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/x',
      field: 'x',
      generators: ['empty'],
      iterations: 5,
    }];
    ctx.options.fetch = async () => ({ status: 200, headers: new Headers() });
    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
  });
});
