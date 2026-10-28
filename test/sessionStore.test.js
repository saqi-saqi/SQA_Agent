import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, looksLikeLoginUrl } from '../src/services/sessionStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-sessions-'));
}

const sampleState = {
  cookies: [
    { name: 'sessionid', value: 'SECRET-VALUE-123', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true },
    { name: 'csrftoken', value: 'abc', domain: 'app.example.com', path: '/', expires: 9999999999 },
  ],
  origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'theme', value: 'dark' }] }],
};

describe('SessionStore', () => {
  let store;
  let dir;

  beforeEach(() => {
    dir = tmpDir();
    store = new SessionStore({ dataDir: dir, secret: 'test-secret-passphrase' });
  });

  it('round-trips a storageState through encryption', async () => {
    await store.saveSession('m1', sampleState);
    const loaded = await store.loadSession('m1');
    assert.deepEqual(loaded, sampleState);
  });

  it('never stores cookie values in plaintext on disk', async () => {
    await store.saveSession('m1', sampleState);
    const raw = fs.readFileSync(path.join(dir, 'sessions', 'm1.session'), 'utf-8');
    assert.ok(!raw.includes('SECRET-VALUE-123'), 'plaintext cookie value leaked to disk!');
  });

  it('returns null when no session exists', async () => {
    assert.equal(await store.loadSession('nope'), null);
    assert.equal(await store.hasSession('nope'), false);
  });

  it('deletes sessions', async () => {
    await store.saveSession('m1', sampleState);
    assert.equal(await store.deleteSession('m1'), true);
    assert.equal(await store.hasSession('m1'), false);
    assert.equal(await store.deleteSession('m1'), false);
  });

  it('fails to decrypt a session saved with a different key', async () => {
    await store.saveSession('m1', sampleState);
    const otherStore = new SessionStore({ dataDir: dir, secret: 'a-different-secret' });
    await assert.rejects(() => otherStore.loadSession('m1'));
  });

  it('rejects invalid monitor ids (path traversal guard)', async () => {
    await assert.rejects(() => store.saveSession('../evil', sampleState));
  });

  it('rejects invalid storageState', async () => {
    await assert.rejects(() => store.saveSession('m1', { cookies: 'not-an-array' }));
  });

  it('exposes non-sensitive metadata only', async () => {
    await store.saveSession('m1', sampleState);
    const meta = await store.getSessionMeta('m1');
    assert.equal(meta.exists, true);
    assert.equal(meta.cookieCount, 2);
    assert.equal(meta.originCount, 1);
    assert.ok(!JSON.stringify(meta).includes('SECRET-VALUE-123'), 'metadata leaked cookie values');
  });

  it('works with an auto-generated key file when no secret is set', async () => {
    const store2 = new SessionStore({ dataDir: dir });
    await store2.saveSession('m2', sampleState);
    const loaded = await store2.loadSession('m2');
    assert.equal(loaded.cookies[0].name, 'sessionid');
    assert.ok(fs.existsSync(path.join(dir, '.session.key')));
  });

  it('builds a Cookie header for the matching host only', async () => {
    const header = store.cookieHeaderFor('app.example.com', sampleState);
    assert.ok(header.includes('sessionid=SECRET-VALUE-123'));
    assert.ok(header.includes('csrftoken=abc'));

    const wrongHost = store.cookieHeaderFor('other.com', sampleState);
    assert.equal(wrongHost, null);
  });
});

describe('looksLikeLoginUrl', () => {
  it('detects login paths', () => {
    assert.equal(looksLikeLoginUrl('https://app.com/login'), true);
    assert.equal(looksLikeLoginUrl('https://app.com/account/signin'), true);
    assert.equal(looksLikeLoginUrl('https://app.com/sso?redirect=x'), true);
  });

  it('detects login-page titles', () => {
    assert.equal(looksLikeLoginUrl('https://app.com/home', 'Sign in to your account'), true);
    assert.equal(looksLikeLoginUrl('', 'Login Page'), true);
  });

  it('does not flag normal pages', () => {
    assert.equal(looksLikeLoginUrl('https://app.com/dashboard'), false);
    assert.equal(looksLikeLoginUrl('https://app.com/blog/authors'), false);
    assert.equal(looksLikeLoginUrl('https://app.com/', 'Welcome to the blog'), false);
  });
});
