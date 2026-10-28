import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFindingFactory } from '../src/services/findingFactory.js';

describe('findingFactory', () => {
  let createFinding;

  beforeEach(() => {
    createFinding = createFindingFactory();
  });

  it('assigns category-prefixed IDs', () => {
    const a = createFinding({ title: 't', severity: 'low', category: 'links', pageUrl: 'https://x.com' });
    const b = createFinding({ title: 't', severity: 'low', category: 'accessibility', pageUrl: 'https://x.com' });
    const c = createFinding({ title: 't', severity: 'low', category: 'network', pageUrl: 'https://x.com' });
    const d = createFinding({ title: 't', severity: 'low', category: 'seo', pageUrl: 'https://x.com' });
    const e = createFinding({ title: 't', severity: 'low', category: 'console', pageUrl: 'https://x.com' });
    const f = createFinding({ title: 't', severity: 'low', category: 'performance', pageUrl: 'https://x.com' });
    assert.equal(a.id, 'LINK-001');
    assert.equal(b.id, 'A11Y-001');
    assert.equal(c.id, 'NET-001');
    assert.equal(d.id, 'SEO-001');
    assert.equal(e.id, 'JS-001');
    assert.equal(f.id, 'PERF-001');
  });

  it('uses GEN prefix for unknown categories', () => {
    const f = createFinding({ title: 't', severity: 'low', category: 'whatever', pageUrl: 'https://x.com' });
    assert.equal(f.id, 'GEN-001');
  });

  it('increments counter per category independently', () => {
    createFinding({ title: 't', severity: 'low', category: 'links', pageUrl: 'https://x.com' });
    createFinding({ title: 't', severity: 'low', category: 'links', pageUrl: 'https://x.com' });
    createFinding({ title: 't', severity: 'low', category: 'accessibility', pageUrl: 'https://x.com' });
    const links3 = createFinding({ title: 't', severity: 'low', category: 'links', pageUrl: 'https://x.com' });
    assert.equal(links3.id, 'LINK-003');
  });

  it('pads IDs to 3 digits', () => {
    let last;
    for (let i = 0; i < 12; i++) {
      last = createFinding({ title: 't', severity: 'low', category: 'links', pageUrl: 'https://x.com' });
    }
    assert.equal(last.id, 'LINK-012');
  });

  it('applies sensible defaults', () => {
    const f = createFinding({ title: 'Missing alt', category: 'accessibility', pageUrl: 'https://x.com' });
    assert.equal(f.severity, 'info');
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.findingType, 'bug');
    assert.equal(f.origin, null);
    assert.equal(f.ruleId, null);
    assert.equal(f.description, '');
    assert.equal(f.evidence, '');
    assert.equal(f.screenshot, null);
    assert.deepEqual(f.reproSteps, []);
    assert.equal(f.suggestedFix, '');
    assert.equal(f.occurrences, 1);
    assert.deepEqual(f.affectedPages, ['https://x.com']);
    assert.equal(f.affectedElements, null);
  });

  it('honors explicit occurrences + affectedPages (dedup pattern)', () => {
    const f = createFinding({
      title: 'Missing alt text on images',
      severity: 'medium',
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      ruleId: 'image-alt',
      pageUrl: 'https://x.com/a',
      occurrences: 12,
      affectedPages: ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'],
      affectedElements: 12,
    });
    assert.equal(f.occurrences, 12);
    assert.equal(f.affectedPages.length, 3);
    assert.equal(f.affectedElements, 12);
  });

  it('does NOT default affectedPages to [pageUrl] when explicitly empty', () => {
    const f = createFinding({
      title: 't', category: 'links', pageUrl: 'https://x.com', affectedPages: [],
    });
    // Note: factory uses `affectedPages || (pageUrl ? [pageUrl] : [])`
    // [] is truthy in JS, so empty array is preserved — expected behavior
    assert.deepEqual(f.affectedPages, []);
  });

  it('falls back to [pageUrl] only when affectedPages is undefined', () => {
    const withUrl = createFinding({ title: 't', category: 'links', pageUrl: 'https://x.com' });
    const noUrl = createFinding({ title: 't', category: 'links' });
    assert.deepEqual(withUrl.affectedPages, ['https://x.com']);
    assert.deepEqual(noUrl.affectedPages, []);
  });

  it('preserves all optional fields', () => {
    const f = createFinding({
      title: 'Broken link',
      severity: 'high',
      confidence: 'high',
      category: 'links',
      findingType: 'bug',
      origin: 'first-party',
      ruleId: 'broken-link',
      pageUrl: 'https://x.com/p',
      description: 'Anchor points to 404',
      evidence: 'HTTP 404 on /missing',
      screenshot: '/screenshots/abc.png',
      reproSteps: ['Open /p', 'Click anchor', 'Observe 404'],
      suggestedFix: 'Update href to /existing',
    });
    assert.equal(f.description, 'Anchor points to 404');
    assert.equal(f.evidence, 'HTTP 404 on /missing');
    assert.equal(f.screenshot, '/screenshots/abc.png');
    assert.equal(f.reproSteps.length, 3);
    assert.equal(f.suggestedFix, 'Update href to /existing');
  });
});
