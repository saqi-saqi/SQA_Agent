import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import e2eExecutor, { runStep, runFlow } from '../src/executors/e2e.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── MockPage + MockLocator ────────────────────────────────────────

class MockLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }
  async click() { this.page._calls.push(['click', this.selector]); }
  async fill(value) { this.page._calls.push(['fill', this.selector, value]); this.page._filled[this.selector] = value; }
  async selectOption(value) { this.page._calls.push(['selectOption', this.selector, value]); }
  async check() { this.page._calls.push(['check', this.selector]); }
  async uncheck() { this.page._calls.push(['uncheck', this.selector]); }
  async hover() { this.page._calls.push(['hover', this.selector]); }
  async focus() { this.page._calls.push(['focus', this.selector]); }
  async press(key) { this.page._calls.push(['press', this.selector, key]); }
  async setInputFiles(filePath) { this.page._calls.push(['setInputFiles', this.selector, filePath]); }
  async waitFor({ state }) { this.page._calls.push(['waitFor', this.selector, state]); }
  async textContent() {
    this.page._calls.push(['textContent', this.selector]);
    return this.page._textContent[this.selector] ?? 'mock-text';
  }
}

class MockPage {
  constructor(opts = {}) {
    this._calls = [];
    this._filled = {};
    this._textContent = opts.textContent || {};
    this._gotoResult = opts.gotoResult || {};
    this._url = opts.url || 'https://example.com';
    this.lastStatus = opts.lastStatus ?? null;
    this.viewport = null;
  }
  locator(selector) { return new MockLocator(this, selector); }
  async goto(url) { this._calls.push(['goto', url]); this._url = url; this.lastStatus = this._gotoResult[url] ?? 200; }
  url() { return this._url; }
  async waitForTimeout(ms) { this._calls.push(['waitForTimeout', ms]); }
  async setViewportSize(size) { this.viewport = size; }
  async close() { this._calls.push(['close']); }
  async screenshot() { this._calls.push(['screenshot']); return Buffer.from('fake'); }
}

// ─── runStep ───────────────────────────────────────────────────────

describe('runStep', () => {
  let page;
  beforeEach(() => {
    page = new MockPage();
  });

  it('navigate calls page.goto with the URL', async () => {
    await runStep({ action: 'navigate', selector: 'https://example.com' }, page);
    assert.deepEqual(page._calls[0], ['goto', 'https://example.com']);
  });

  it('click calls locator.click', async () => {
    await runStep({ action: 'click', selector: '#btn' }, page);
    assert.deepEqual(page._calls[0], ['click', '#btn']);
  });

  it('fill calls locator.fill with value', async () => {
    await runStep({ action: 'fill', selector: '#input', value: 'hello' }, page);
    assert.deepEqual(page._calls[0], ['fill', '#input', 'hello']);
    assert.equal(page._filled['#input'], 'hello');
  });

  it('fill with no value defaults to empty string', async () => {
    await runStep({ action: 'fill', selector: '#input' }, page);
    assert.equal(page._filled['#input'], '');
  });

  it('select calls locator.selectOption', async () => {
    await runStep({ action: 'select', selector: '#dropdown', value: 'opt1' }, page);
    assert.deepEqual(page._calls[0], ['selectOption', '#dropdown', 'opt1']);
  });

  it('check + uncheck + hover + focus all dispatch', async () => {
    await runStep({ action: 'check', selector: '#c' }, page);
    await runStep({ action: 'uncheck', selector: '#c' }, page);
    await runStep({ action: 'hover', selector: '#h' }, page);
    await runStep({ action: 'focus', selector: '#f' }, page);
    assert.deepEqual(page._calls[0], ['check', '#c']);
    assert.deepEqual(page._calls[1], ['uncheck', '#c']);
    assert.deepEqual(page._calls[2], ['hover', '#h']);
    assert.deepEqual(page._calls[3], ['focus', '#f']);
  });

  it('press calls locator.press with key', async () => {
    await runStep({ action: 'press', selector: '#input', value: 'Enter' }, page);
    assert.deepEqual(page._calls[0], ['press', '#input', 'Enter']);
  });

  it('upload calls setInputFiles', async () => {
    await runStep({ action: 'upload', selector: '#file', value: '/path/to/file' }, page);
    assert.deepEqual(page._calls[0], ['setInputFiles', '#file', '/path/to/file']);
  });

  it('wait with ms calls waitForTimeout', async () => {
    await runStep({ action: 'wait', ms: 500 }, page);
    assert.deepEqual(page._calls[0], ['waitForTimeout', 500]);
  });

  it('wait with selector calls locator.waitFor visible', async () => {
    await runStep({ action: 'wait', selector: '#el', state: 'visible' }, page);
    assert.deepEqual(page._calls[0], ['waitFor', '#el', 'visible']);
  });

  it('assertVisible calls locator.waitFor visible', async () => {
    await runStep({ action: 'assertVisible', selector: '#el' }, page);
    assert.deepEqual(page._calls[0], ['waitFor', '#el', 'visible']);
  });

  it('assertHidden calls locator.waitFor hidden', async () => {
    await runStep({ action: 'assertHidden', selector: '#el' }, page);
    assert.deepEqual(page._calls[0], ['waitFor', '#el', 'hidden']);
  });

  it('assertText with equals passes when text matches', async () => {
    page._textContent['h1'] = 'Welcome';
    await runStep({ action: 'assertText', selector: 'h1', equals: 'Welcome' }, page);
    // No throw
    assert.deepEqual(page._calls[0], ['textContent', 'h1']);
  });

  it('assertText with equals throws when text does not match', async () => {
    page._textContent['h1'] = 'Wrong';
    await assert.rejects(
      () => runStep({ action: 'assertText', selector: 'h1', equals: 'Welcome' }, page),
      /assertText failed/i,
    );
  });

  it('assertText with contains passes when text contains substring', async () => {
    page._textContent['h1'] = 'Welcome to the app';
    await runStep({ action: 'assertText', selector: 'h1', contains: 'Welcome' }, page);
  });

  it('assertText with contains throws when text lacks substring', async () => {
    page._textContent['h1'] = 'About Us';
    await assert.rejects(
      () => runStep({ action: 'assertText', selector: 'h1', contains: 'Welcome' }, page),
      /does not contain/i,
    );
  });

  it('assertUrl with url passes when URL matches', async () => {
    page._url = 'https://example.com/dashboard';
    await runStep({ action: 'assertUrl', url: 'https://example.com/dashboard' }, page);
  });

  it('assertUrl with url throws on mismatch', async () => {
    page._url = 'https://example.com/wrong';
    await assert.rejects(
      () => runStep({ action: 'assertUrl', url: 'https://example.com/dashboard' }, page),
      /assertUrl failed/i,
    );
  });

  it('assertUrl with urlContains passes when substring matches', async () => {
    page._url = 'https://example.com/users/42/profile';
    await runStep({ action: 'assertUrl', urlContains: '/users/' }, page);
  });

  it('assertUrl with urlMatches uses regex', async () => {
    page._url = 'https://example.com/posts/123';
    await runStep({ action: 'assertUrl', urlMatches: '/posts/\\d+' }, page);
  });

  it('assertStatus checks page.lastStatus', async () => {
    page.lastStatus = 200;
    await runStep({ action: 'assertStatus', status: 200 }, page);
  });

  it('assertStatus throws when lastStatus is null', async () => {
    page.lastStatus = null;
    await assert.rejects(
      () => runStep({ action: 'assertStatus', status: 200 }, page),
      /lastStatus to be tracked/i,
    );
  });

  it('throws on unknown action', async () => {
    await assert.rejects(
      () => runStep({ action: 'teleport' }, page),
      /Unknown flow step action/i,
    );
  });
});

// ─── runFlow ───────────────────────────────────────────────────────

describe('runFlow', () => {
  it('runs all steps + returns ok:true when no failures', async () => {
    const page = new MockPage({ textContent: { 'h1': 'Welcome' } });
    const flow = {
      name: 'Login',
      startUrl: 'https://example.com/login',
      steps: [
        { action: 'fill', selector: 'input[name="email"]', value: 'test@example.com' },
        { action: 'click', selector: 'button[type="submit"]' },
        { action: 'assertText', selector: 'h1', contains: 'Welcome' },
      ],
    };
    const result = await runFlow(flow, page);
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
  });

  it('retries on failure + returns ok:false after maxAttempts', async () => {
    const page = new MockPage({ textContent: { 'h1': 'Wrong' } });
    const flow = {
      name: 'Login',
      startUrl: 'https://example.com/login',
      steps: [
        { action: 'assertText', selector: 'h1', contains: 'Welcome' },  // fails
      ],
      retry: { maxAttempts: 2, backoffMs: 1 },
    };
    const result = await runFlow(flow, page);
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.match(result.lastError.message, /does not contain/i);
  });

  it('eventually succeeds on retry', async () => {
    let attemptCount = 0;
    const page = new MockPage();
    // Override textContent to flip after first attempt
    const original = page._textContent;
    page._textContent = new Proxy({}, {
      get(_, key) {
        if (key === 'h1') {
          attemptCount++;
          return attemptCount >= 2 ? 'Welcome' : 'Wrong';
        }
        return original[key];
      },
    });

    const flow = {
      name: 'Flaky',
      startUrl: 'https://example.com',
      steps: [
        { action: 'assertText', selector: 'h1', contains: 'Welcome' },
      ],
      retry: { maxAttempts: 3, backoffMs: 1 },
    };
    const result = await runFlow(flow, page);
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  });
});

// ─── e2eExecutor (no-context path) ──────────────────────────────────

describe('e2eExecutor no-context path', () => {
  it('returns skipped result when no Playwright context', async () => {
    const ctx = {
      plan: { flows: [{ name: 'Test', startUrl: 'https://x.com', steps: [] }] },
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.skipped, true);
    assert.equal(result.stats.reason, 'no-browser-context');
  });
});

// ─── e2eExecutor with mock context ─────────────────────────────────

describe('e2eExecutor with mock context', () => {
  it('runs flows + emits findings on failure', async () => {
    class MockContext {
      async newPage() {
        return new MockPage({ textContent: { 'h1': 'Wrong Text' } });
      }
    }
    const ctx = {
      plan: {
        targetUrl: 'https://example.com',
        viewports: [{ width: 1280, height: 720 }],
        flows: [{
          name: 'Login',
          startUrl: 'https://example.com/login',
          steps: [
            { action: 'assertText', selector: 'h1', contains: 'Welcome' },
          ],
          retry: { maxAttempts: 1, backoffMs: 1 },
        }],
      },
      context: new MockContext(),
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.stats.ran, 1);
    assert.equal(result.stats.failed, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'e2e-flow-failure');
    assert.match(result.findings[0].title, /Login/);
  });

  it('passes when all flows succeed', async () => {
    class MockContext {
      async newPage() {
        return new MockPage({ textContent: { 'h1': 'Welcome' } });
      }
    }
    const ctx = {
      plan: {
        targetUrl: 'https://example.com',
        viewports: [{ width: 1280, height: 720 }],
        flows: [{
          name: 'Login',
          startUrl: 'https://example.com/login',
          steps: [
            { action: 'assertText', selector: 'h1', contains: 'Welcome' },
          ],
          retry: { maxAttempts: 1, backoffMs: 1 },
        }],
      },
      context: new MockContext(),
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.stats.ran, 1);
    assert.equal(result.stats.passed, 1);
    assert.equal(result.findings.length, 0);
  });
});
