import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../dashboard/server.js';

function fakeReq(headers = {}) {
  return { headers };
}

function fakeUrl(pathname, search = '') {
  return new URL(`http://localhost:8080${pathname}${search}`);
}

describe('isAuthorized', () => {
  const TOKEN = 'secret-key-123';

  it('is open when no token is configured', () => {
    assert.equal(isAuthorized(fakeReq(), fakeUrl('/api/runs'), ''), true);
  });

  it('accepts a matching Bearer header', () => {
    const req = fakeReq({ authorization: `Bearer ${TOKEN}` });
    assert.equal(isAuthorized(req, fakeUrl('/api/runs'), TOKEN), true);
  });

  it('accepts a matching ?token= query param', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/api/runs?token=' + TOKEN), TOKEN), true);
  });

  it('rejects a wrong Bearer header', () => {
    const req = fakeReq({ authorization: 'Bearer wrong' });
    assert.equal(isAuthorized(req, fakeUrl('/api/runs'), TOKEN), false);
  });

  it('rejects a wrong query param', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/api/runs?token=wrong'), TOKEN), false);
  });

  it('rejects missing credentials', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/api/runs'), TOKEN), false);
  });

  it('always allows /health', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/health'), TOKEN), true);
  });

  it('allows static assets (non-/api paths)', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/app.js'), TOKEN), true);
    assert.equal(isAuthorized(req, fakeUrl('/'), TOKEN), true);
  });
});
