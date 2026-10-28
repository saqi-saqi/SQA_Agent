import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginRecorder } from '../src/services/loginRecorder.js';
import { SessionStore } from '../src/services/sessionStore.js';

/** Fake Playwright chromium + browser/context/page that simulates the banner. */
function makeFakeChromium({ state, failGoto = false } = {}) {
  const calls = { launched: false, headless: null, initScripts: [], storageStateRequests: 0 };
  const fakeContext = {
    addInitScript: async (script) => { calls.initScripts.push(script); },
    newPage: async () => fakeContext._page,
    pages: () => [fakeContext._page],
    _page: {
      url: () => 'https://app.com/login',
      goto: async () => { if (failGoto) throw new Error('net down'); },
      // The recorder polls this — settable to simulate the user clicking Save
      evaluate: async () => fakeContext._action,
    },
    _action: null,
    storageState: async () => {
      calls.storageStateRequests++;
      return state || { cookies: [{ name: 'sid', value: 'v', domain: '.app.com' }], origins: [] };
    },
    close: async () => { calls.contextClosed = true; },
  };
  const fakeBrowser = {
    newContext: async () => fakeContext,
    close: async () => { calls.browserClosed = true; },
  };
  const chromium = {
    launch: async (opts) => {
      calls.launched = true;
      calls.headless = opts?.headless;
      return fakeBrowser;
    },
  };
  return { chromium, calls, fakeContext };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-recorder-'));
}

describe('LoginRecorder', () => {
  let recorder;
  let dir;
  let doneResults;

  beforeEach(() => {
    dir = tmpDir();
    doneResults = [];
  });

  it('launches a HEADED browser with the banner init script and saves on "save"', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    const started = await recorder.start({
      monitorId: 'm1',
      url: 'https://app.com/login',
      onDone: (r) => doneResults.push(r),
    });
    assert.equal(started.started, true);
    assert.equal(fake.calls.launched, true);
    assert.equal(fake.calls.headless, false, 'recorder must be headed so the user can log in');
    assert.equal(fake.calls.initScripts.length, 1);
    assert.ok(fake.calls.initScripts[0].includes('__sqaRecorder'));

    // user clicks Save in the banner (onDone fires asynchronously)
    fake.fakeContext._action = 'save';
    await recorder._checkBanner();
    for (let i = 0; i < 50 && doneResults.length === 0; i++) await new Promise(r => setTimeout(r, 10));

    assert.equal(doneResults.length, 1);
    assert.equal(doneResults[0].ok, true);
    assert.equal(doneResults[0].monitorId, 'm1');
    assert.equal(doneResults[0].state.cookies[0].name, 'sid');
    assert.equal(fake.calls.browserClosed, true);
    assert.equal(recorder.isActive(), false);
  });

  it('cancels without saving when the user clicks Cancel', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: (r) => doneResults.push(r) });
    fake.fakeContext._action = 'cancel';
    await recorder._checkBanner();
    for (let i = 0; i < 50 && doneResults.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(doneResults[0].ok, false);
    assert.equal(doneResults[0].reason, 'user-cancel');
    assert.equal(doneResults[0].state, undefined);
  });

  it('supports user-initiated cancel from the dashboard', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: (r) => doneResults.push(r) });
    const result = await recorder.cancel('user-cancel-dashboard');
    assert.equal(result.ok, true);
    for (let i = 0; i < 50 && doneResults.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(doneResults[0].reason, 'user-cancel-dashboard');
    assert.equal(recorder.isActive(), false);
  });

  it('refuses to start two recordings at once', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10000, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: () => {} });
    await assert.rejects(
      () => recorder.start({ monitorId: 'm2', url: 'https://app.com/login', onDone: () => {} }),
      /already in progress/
    );
    await recorder.cancel('cleanup');
  });

  it('end-to-end: saved recording is encrypted in the SessionStore and loadable', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    const store = new SessionStore({ dataDir: dir, secret: 'test-secret' });

    await recorder.start({
      monitorId: 'm1',
      url: 'https://app.com/login',
      onDone: (r) => doneResults.push(r),
    });
    fake.fakeContext._action = 'save';
    await recorder._checkBanner();
    await assert.doesNotReject(async () => {
      // wait for the async onDone persist path
      for (let i = 0; i < 20 && doneResults.length === 0; i++) {
        await new Promise(r => setTimeout(r, 10));
      }
    });

    await store.saveSession('m1', doneResults[0].state);
    const loaded = await store.loadSession('m1');
    assert.equal(loaded.cookies[0].domain, '.app.com');
  });
});
