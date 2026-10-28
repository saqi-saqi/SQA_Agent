import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunSchema } from '../routes/runs.js';

const base = { url: 'https://example.com', options: { workflows: [{ name: 'Search', startUrl: 'https://example.com', steps: [{ action: 'assertVisible', selector: 'main' }] }] } };

describe('workflow request validation', () => {
  it('accepts a bounded, explicit browser assertion workflow', () => {
    assert.equal(createRunSchema.parse(base).options.workflows[0].name, 'Search');
  });

  it('rejects selector actions without a selector', () => {
    const invalid = structuredClone(base);
    invalid.options.workflows[0].steps = [{ action: 'click' }];
    assert.throws(() => createRunSchema.parse(invalid));
  });

  it('rejects assertions without the value they need', () => {
    const invalid = structuredClone(base);
    invalid.options.workflows[0].steps = [{ action: 'assertUrl' }];
    assert.throws(() => createRunSchema.parse(invalid));
  });
});
