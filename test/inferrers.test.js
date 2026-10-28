import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferA11yRules } from '../src/explorer/a11yInferrer.js';
import { inferPerfBudgets } from '../src/explorer/perfInferrer.js';
import { inferVisualBaselines, inferViewports } from '../src/explorer/visualInferrer.js';
import { inferFuzzTargets } from '../src/explorer/fuzzInferrer.js';

const samplePages = [
  {
    url: 'https://example.com/',
    title: 'Home',
    forms: 1,
    buttons: 3,
    inputs: 2,
    meta: { viewport: 'width=device-width, initial-scale=1' },
    imageDetails: [{ src: 'logo.png', alt: 'Logo' }],
    loadTime: 1200,
    apiCalls: [
      { method: 'GET', url: 'https://api.example.com/users/123', status: 200 },
      { method: 'POST', url: 'https://api.example.com/login', status: 200,
        requestBody: { email: 'a@b.com', password: 'x' } },
    ],
  },
  {
    url: 'https://example.com/about',
    title: 'About',
    forms: 0,
    buttons: 1,
    inputs: 0,
    meta: { viewport: 'width=device-width, initial-scale=1' },
    imageDetails: [],
    loadTime: 800,
    apiCalls: [],
  },
];

describe('a11yInferrer', () => {
  it('returns a non-empty list of axe-core rules', () => {
    const rules = inferA11yRules({ pages: samplePages });
    assert.ok(rules.length >= 15);
    assert.ok(rules.every(r => r.rule && r.level));
  });

  it('includes color-contrast + image-alt when images are present', () => {
    const rules = inferA11yRules({ pages: samplePages });
    const ruleNames = rules.map(r => r.rule);
    assert.ok(ruleNames.includes('color-contrast'));
    assert.ok(ruleNames.includes('image-alt'));
  });

  it('keeps label rule when forms are present', () => {
    const rules = inferA11yRules({ pages: samplePages });
    assert.ok(rules.some(r => r.rule === 'label'));
  });

  it('drops label rule when no forms are present anywhere', () => {
    const pages = [{ ...samplePages[0], forms: 0, inputs: 0 }];
    const rules = inferA11yRules({ pages });
    assert.ok(!rules.some(r => r.rule === 'label'));
  });

  it('drops image-alt rule when no images are present', () => {
    const pages = [{ ...samplePages[0], imageDetails: [] }];
    const rules = inferA11yRules({ pages });
    assert.ok(!rules.some(r => r.rule === 'image-alt'));
  });

  it('all rules have valid severity levels', () => {
    const rules = inferA11yRules({ pages: samplePages });
    const validLevels = ['minor', 'moderate', 'serious', 'critical'];
    assert.ok(rules.every(r => validLevels.includes(r.level)));
  });

  it('handles empty pages input', () => {
    const rules = inferA11yRules({ pages: [] });
    // Default rules minus image-alt + label (no images/forms)
    assert.ok(rules.length > 0);
    assert.ok(!rules.some(r => r.rule === 'image-alt'));
    assert.ok(!rules.some(r => r.rule === 'label'));
  });

  it('handles null pages input', () => {
    const rules = inferA11yRules({ pages: null });
    assert.ok(rules.length > 0);
  });
});

describe('perfInferrer', () => {
  it('returns Core Web Vitals budgets by default', () => {
    const budgets = inferPerfBudgets({ pages: samplePages });
    const metrics = budgets.map(b => b.metric);
    assert.ok(metrics.includes('LCP'));
    assert.ok(metrics.includes('CLS'));
    assert.ok(metrics.includes('TBT'));
    assert.ok(metrics.includes('FCP'));
    assert.ok(metrics.includes('TTFB'));
  });

  it('sets sensible thresholds (LCP <= 2500)', () => {
    const budgets = inferPerfBudgets({ pages: samplePages });
    const lcp = budgets.find(b => b.metric === 'LCP');
    assert.ok(lcp.threshold <= 2500);
  });

  it('escalates TBT severity to high when a slow page is observed', () => {
    const slowPages = [{ ...samplePages[0], loadTime: 8000 }];
    const budgets = inferPerfBudgets({ pages: slowPages });
    const tbt = budgets.find(b => b.metric === 'TBT');
    assert.equal(tbt.severity, 'high');
  });

  it('keeps TBT at medium when pages are fast', () => {
    const fastPages = [{ ...samplePages[0], loadTime: 200 }];
    const budgets = inferPerfBudgets({ pages: fastPages });
    const tbt = budgets.find(b => b.metric === 'TBT');
    assert.equal(tbt.severity, 'medium');
  });

  it('handles empty pages', () => {
    const budgets = inferPerfBudgets({ pages: [] });
    assert.ok(budgets.length >= 5);  // defaults still apply
  });

  it('all budgets have valid severity', () => {
    const budgets = inferPerfBudgets({ pages: samplePages });
    const validSev = ['critical', 'high', 'medium', 'low', 'info'];
    assert.ok(budgets.every(b => validSev.includes(b.severity)));
  });
});

describe('visualInferrer — inferViewports', () => {
  it('returns desktop + mobile viewports when responsive meta is present', () => {
    const vps = inferViewports({ pages: samplePages });
    assert.equal(vps.length, 2);
    const names = vps.map(v => v.name);
    assert.ok(names.includes('desktop'));
    assert.ok(names.includes('mobile'));
  });

  it('returns only desktop when no responsive meta', () => {
    const pages = [{ ...samplePages[0], meta: { viewport: null } }];
    const vps = inferViewports({ pages });
    assert.equal(vps.length, 1);
    assert.equal(vps[0].name, 'desktop');
  });

  it('mobile viewport has isMobile + hasTouch flags', () => {
    const vps = inferViewports({ pages: samplePages });
    const mobile = vps.find(v => v.name === 'mobile');
    assert.equal(mobile.isMobile, true);
    assert.equal(mobile.hasTouch, true);
  });
});

describe('visualInferrer — inferVisualBaselines', () => {
  it('creates one baseline per page × viewport', () => {
    const vps = inferViewports({ pages: samplePages });
    const baselines = inferVisualBaselines({ pages: samplePages, viewports: vps });
    // 2 pages × 2 viewports = 4 baselines
    assert.equal(baselines.length, 4);
  });

  it('uses default 1% threshold', () => {
    const baselines = inferVisualBaselines({ pages: samplePages });
    assert.equal(baselines[0].threshold, 0.01);
  });

  it('defaults maskSelectors to empty array', () => {
    const baselines = inferVisualBaselines({ pages: samplePages });
    assert.deepEqual(baselines[0].maskSelectors, []);
  });

  it('handles empty pages', () => {
    const baselines = inferVisualBaselines({ pages: [] });
    assert.equal(baselines.length, 0);
  });
});

describe('fuzzInferrer', () => {
  it('creates a per-page fuzz target when inputs are present', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    // Only the first page has inputs (2 inputs)
    assert.ok(targets.length >= 1);
    const homeTarget = targets.find(t => t.pageUrl === 'https://example.com/');
    assert.ok(homeTarget);
    assert.equal(homeTarget.formSelector, 'form');
    assert.equal(homeTarget.fieldSelector, 'input, textarea, select');
  });

  it('skips pages with zero inputs', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    // /about has 0 inputs — should NOT be in targets
    assert.ok(!targets.some(t => t.pageUrl === 'https://example.com/about'));
  });

  it('creates per-field API fuzz targets when endpoints have requestSchemas', () => {
    const endpoints = [
      {
        method: 'POST',
        path: '/api/login',
        requestSchema: { email: 'string', password: 'string' },
      },
      {
        method: 'GET',
        path: '/api/users',
        requestSchema: null,
      },
    ];
    const targets = inferFuzzTargets({ pages: [], endpoints });
    // /api/login has 2 fields → 2 targets. /api/users has no body → 0.
    assert.equal(targets.length, 2);
    assert.ok(targets.every(t => t.apiEndpointRef === '/api/login'));
    assert.ok(targets.some(t => t.field === 'email'));
    assert.ok(targets.some(t => t.field === 'password'));
  });

  it('uses default generators (empty, oversize, unicode, sql, xss)', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    assert.deepEqual(targets[0].generators, ['empty', 'oversize', 'unicode', 'sql', 'xss']);
  });

  it('caps iterations at a reasonable number (≤ 50)', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    assert.ok(targets.every(t => t.iterations <= 50));
  });
});
