import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePixelDiff } from '../src/executors/visual.js';

// Helper: build an RGBA pixel buffer of N pixels with the given color
function pixelBuffer(count, [r, g, b, a = 255]) {
  const buf = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

describe('computePixelDiff', () => {
  it('returns 0 diff for identical buffers', () => {
    const a = pixelBuffer(100, [0, 0, 0]);
    const b = pixelBuffer(100, [0, 0, 0]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 0);
    assert.equal(result.diffPixelCount, 0);
  });

  it('returns ~1 diff for completely different colors', () => {
    const a = pixelBuffer(100, [0, 0, 0]);
    const b = pixelBuffer(100, [255, 255, 255]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 1);
    assert.equal(result.diffPixelCount, 100);
  });

  it('returns diff:1 when buffer lengths differ', () => {
    const a = pixelBuffer(100, [0, 0, 0]);
    const b = pixelBuffer(50, [0, 0, 0]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 1);
    assert.equal(result.diffPixelCount, -1);
  });

  it('returns diff:1 when either buffer is null', () => {
    const a = pixelBuffer(10, [0, 0, 0]);
    assert.equal(computePixelDiff(null, a).diffRatio, 1);
    assert.equal(computePixelDiff(a, null).diffRatio, 1);
    assert.equal(computePixelDiff(null, null).diffRatio, 1);
  });

  it('does NOT flag small luminance differences (within tolerance)', () => {
    const a = pixelBuffer(10, [100, 100, 100]);
    const b = pixelBuffer(10, [110, 110, 110]);  // delta=10, within tolerance of 30
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 0);
  });

  it('flags luminance differences above tolerance', () => {
    const a = pixelBuffer(10, [100, 100, 100]);
    const b = pixelBuffer(10, [200, 200, 200]);  // delta=100, exceeds tolerance of 30
    const result = computePixelDiff(a, b);
    assert.equal(result.diffRatio, 1);
    assert.equal(result.diffPixelCount, 10);
  });

  it('handles partial differences', () => {
    // 5 black + 5 white vs 10 black = 5 diff pixels
    const a = Buffer.concat([pixelBuffer(5, [0, 0, 0]), pixelBuffer(5, [255, 255, 255])]);
    const b = pixelBuffer(10, [0, 0, 0]);
    const result = computePixelDiff(a, b);
    assert.equal(result.diffPixelCount, 5);
    assert.equal(result.diffRatio, 0.5);
  });
});
