import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TestPlan,
  parseTestPlan,
  validateTestPlan,
  transitionStatus,
  createDraftPlan,
} from '../src/services/testPlan.js';

describe('TestPlan schema', () => {
  const minimal = {
    schemaVersion: 1,
    id: 'plan_001',
    targetUrl: 'https://example.com',
  };

  it('parses a minimal draft plan with defaults', () => {
    const plan = parseTestPlan(minimal);
    assert.equal(plan.status, 'draft');
    assert.equal(plan.generatedBy, 'sqa-agent-explorer');
    assert.deepEqual(plan.pages, []);
    assert.deepEqual(plan.flows, []);
    assert.deepEqual(plan.apiEndpoints, []);
    assert.deepEqual(plan.fuzzTargets, []);
    assert.deepEqual(plan.a11yRules, []);
    assert.deepEqual(plan.perfBudgets, []);
    assert.deepEqual(plan.visualBaselines, []);
    assert.deepEqual(plan.viewports, []);
    assert.deepEqual(plan.browsers, ['chromium']);
  });

  it('rejects unknown schemaVersion', () => {
    const bad = { ...minimal, schemaVersion: 99 };
    const r = validateTestPlan(bad);
    assert.equal(r.ok, false);
    assert.ok(r.error.some(e => /schemaVersion/.test(e.path)));
  });

  it('rejects bad URL', () => {
    const bad = { ...minimal, targetUrl: 'not-a-url' };
    assert.throws(() => parseTestPlan(bad), /invalid/i);
  });

  it('rejects unknown top-level field (strict mode)', () => {
    const bad = { ...minimal, bogus: true };
    assert.throws(() => parseTestPlan(bad), /unrecognized/i);
  });
});

describe('TestPlan validateTestPlan', () => {
  it('returns ok:true and parsed plan for valid input', () => {
    const r = validateTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
    });
    assert.equal(r.ok, true);
    assert.equal(r.plan.status, 'draft');
  });

  it('returns ok:false with path-tagged errors for invalid input', () => {
    const r = validateTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'bad',
      pages: [{ url: 'also-bad' }],
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.length >= 1);
    assert.ok(r.error[0].path && r.error[0].message && r.error[0].code);
  });
});

describe('TestPlan page assertions', () => {
  it('accepts a page with expected elements and viewport', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      pages: [{
        url: 'https://example.com/login',
        label: 'login',
        expectedStatus: 200,
        expectedElements: [{ selector: 'form', state: 'visible' }],
        forbiddenText: ['error'],
        viewport: { width: 1280, height: 720, name: 'desktop' },
      }],
    });
    assert.equal(plan.pages[0].expectedElements[0].state, 'visible');
    assert.equal(plan.pages[0].viewport.name, 'desktop');
  });

  it('rejects element assertion with invalid state', () => {
    assert.throws(() => parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      pages: [{
        url: 'https://example.com',
        expectedElements: [{ selector: 'form', state: 'kinda-visible' }],
      }],
    }), /invalid/i);
  });
});

describe('TestPlan flows', () => {
  const baseFlow = {
    name: 'Login',
    startUrl: 'https://example.com/login',
    steps: [{ action: 'assertVisible', selector: 'main' }],
  };

  it('accepts a flow with click + assertVisible + assertUrl', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      flows: [{
        ...baseFlow,
        steps: [
          { action: 'click', selector: '#login-btn' },
          { action: 'assertVisible', selector: '.dashboard' },
          { action: 'assertUrl', urlContains: '/dashboard' },
        ],
      }],
    });
    assert.equal(plan.flows[0].steps.length, 3);
  });

  it('rejects click without selector', () => {
    assert.throws(() => parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      flows: [{ ...baseFlow, steps: [{ action: 'click' }] }],
    }));
  });

  it('rejects assertUrl without url/urlMatches/urlContains', () => {
    assert.throws(() => parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      flows: [{ ...baseFlow, steps: [{ action: 'assertUrl' }] }],
    }));
  });

  it('applies default retry policy', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      flows: [baseFlow],
    });
    assert.equal(plan.flows[0].retry.maxAttempts, 2);
    assert.equal(plan.flows[0].retry.backoffMs, 500);
  });
});

describe('TestPlan apiEndpoints', () => {
  it('accepts a GET endpoint with optional schema', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      apiEndpoints: [{
        method: 'GET',
        path: '/api/users/:id',
        expectedStatus: 200,
        responseSchema: { type: 'object' },
        pathParams: { id: '42' },
      }],
    });
    assert.equal(plan.apiEndpoints[0].method, 'GET');
    assert.equal(plan.apiEndpoints[0].pathParams.id, '42');
  });

  it('rejects unknown HTTP method', () => {
    assert.throws(() => parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      apiEndpoints: [{ method: 'CONNECT', path: '/x' }],
    }));
  });
});

describe('TestPlan fuzzTargets', () => {
  it('accepts a form-field fuzz target', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      fuzzTargets: [{
        pageUrl: 'https://example.com/form',
        formSelector: '#login-form',
        fieldSelector: 'input[name="email"]',
        generators: ['empty', 'oversize', 'unicode'],
        iterations: 30,
      }],
    });
    assert.equal(plan.fuzzTargets[0].generators.length, 3);
  });

  it('accepts an API-field fuzz target', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      fuzzTargets: [{
        apiEndpointRef: '/api/login',
        field: 'email',
        generators: ['sql', 'xss'],
      }],
    });
    assert.equal(plan.fuzzTargets[0].apiEndpointRef, '/api/login');
  });

  it('rejects a fuzz target missing both form and api refs', () => {
    assert.throws(() => parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      fuzzTargets: [{ generators: ['empty'] }],
    }));
  });

  it('rejects unknown generator', () => {
    assert.throws(() => parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      fuzzTargets: [{
        pageUrl: 'https://example.com',
        fieldSelector: 'input',
        generators: ['unknown-gen'],
      }],
    }));
  });

  it('caps iterations at 1000', () => {
    assert.throws(() => parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      fuzzTargets: [{
        pageUrl: 'https://example.com',
        fieldSelector: 'input',
        generators: ['empty'],
        iterations: 5000,
      }],
    }));
  });
});

describe('TestPlan perf + visual + a11y', () => {
  it('accepts perf budgets with default severity', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      perfBudgets: [
        { metric: 'LCP', threshold: 2500 },
        { metric: 'CLS', threshold: 0.1, severity: 'high' },
      ],
    });
    assert.equal(plan.perfBudgets[0].severity, 'medium');
    assert.equal(plan.perfBudgets[1].severity, 'high');
  });

  it('accepts visual baselines with maskSelectors default', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      visualBaselines: [{
        pageUrl: 'https://example.com',
        viewport: { width: 1280, height: 720 },
      }],
    });
    assert.deepEqual(plan.visualBaselines[0].maskSelectors, []);
    assert.equal(plan.visualBaselines[0].threshold, 0.01);
  });

  it('accepts a11y rules with default level', () => {
    const plan = parseTestPlan({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      a11yRules: [{ rule: 'color-contrast' }],
    });
    assert.equal(plan.a11yRules[0].level, 'serious');
  });
});

describe('TestPlan transitionStatus', () => {
  it('walks the happy path: draft → proposed → approved → executing → completed', () => {
    let plan = createDraftPlan('plan_001', 'https://example.com');
    assert.equal(plan.status, 'draft');

    plan = transitionStatus(plan, 'proposed');
    assert.equal(plan.status, 'proposed');

    plan = transitionStatus(plan, 'approved');
    assert.equal(plan.status, 'approved');

    plan = transitionStatus(plan, 'executing');
    assert.equal(plan.status, 'executing');

    plan = transitionStatus(plan, 'completed');
    assert.equal(plan.status, 'completed');
  });

  it('allows transition to failed from any post-approved state', () => {
    let plan = createDraftPlan('p', 'https://example.com');
    plan = transitionStatus(plan, 'proposed');
    plan = transitionStatus(plan, 'approved');
    plan = transitionStatus(plan, 'failed');
    assert.equal(plan.status, 'failed');
  });

  it('rejects skipping steps (e.g. draft → approved)', () => {
    const plan = createDraftPlan('p', 'https://example.com');
    assert.throws(() => transitionStatus(plan, 'approved'), /Illegal/i);
  });

  it('rejects invalid status name', () => {
    const plan = createDraftPlan('p', 'https://example.com');
    assert.throws(() => transitionStatus(plan, 'bogus'), /Invalid status/i);
  });
});

describe('createDraftPlan', () => {
  it('returns a valid minimal plan', () => {
    const plan = createDraftPlan('plan_xyz', 'https://example.com');
    assert.equal(plan.id, 'plan_xyz');
    assert.equal(plan.targetUrl, 'https://example.com');
    assert.equal(plan.status, 'draft');
    assert.deepEqual(plan.executors, []);
  });
});
