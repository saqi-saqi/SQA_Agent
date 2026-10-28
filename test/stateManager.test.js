import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthFlow, resolveAuthRoles } from '../src/matrix/stateManager.js';

describe('isAuthFlow', () => {
  it('flags flows named "Login" or "Sign In"', () => {
    assert.equal(isAuthFlow({ name: 'Login' }), true);
    assert.equal(isAuthFlow({ name: 'Sign In' }), true);
    assert.equal(isAuthFlow({ name: 'Authenticate' }), true);
  });

  it('flags flows tagged with auth:*', () => {
    assert.equal(isAuthFlow({ name: 'X', tags: ['auth'] }), true);
    assert.equal(isAuthFlow({ name: 'X', tags: ['login'] }), true);
  });

  it('does NOT flag non-auth flows', () => {
    assert.equal(isAuthFlow({ name: 'Browse Products' }), false);
    assert.equal(isAuthFlow({ name: 'Add to Cart' }), false);
    assert.equal(isAuthFlow({}), false);
    assert.equal(isAuthFlow(null), false);
  });

  it('is case-insensitive on flow name', () => {
    assert.equal(isAuthFlow({ name: 'login' }), true);
    assert.equal(isAuthFlow({ name: 'LOGIN' }), true);
    assert.equal(isAuthFlow({ name: 'sign in' }), true);
  });
});

describe('resolveAuthRoles', () => {
  it('always includes "anon" role', () => {
    const roles = resolveAuthRoles({ flows: [] });
    assert.ok('anon' in roles);
    assert.equal(roles.anon.flow, null);
  });

  it('maps "Login" flow to "user" role', () => {
    const flow = { name: 'Login', startUrl: 'https://x.com/login', steps: [] };
    const roles = resolveAuthRoles({ flows: [flow] });
    assert.ok('user' in roles);
    assert.equal(roles.user.flow, flow);
  });

  it('maps "Admin Login" flow to "admin" role', () => {
    const flow = { name: 'Admin Login', startUrl: 'https://x.com/admin', steps: [] };
    const roles = resolveAuthRoles({ flows: [flow] });
    assert.ok('admin' in roles);
    assert.equal(roles.admin.flow, flow);
  });

  it('maps "auth:editor" tag to "editor" role', () => {
    const flow = { name: 'Editor Flow', tags: ['auth:editor'], startUrl: 'https://x.com', steps: [] };
    const roles = resolveAuthRoles({ flows: [flow] });
    assert.ok('editor' in roles);
  });

  it('handles multiple roles from multiple flows', () => {
    const flows = [
      { name: 'Login', startUrl: 'https://x.com/login', steps: [] },
      { name: 'Admin Login', startUrl: 'https://x.com/admin', steps: [] },
      { name: 'Browse', startUrl: 'https://x.com', steps: [] },
    ];
    const roles = resolveAuthRoles({ flows });
    assert.ok('anon' in roles);
    assert.ok('user' in roles);
    assert.ok('admin' in roles);
    assert.ok(!('Browse' in roles));
  });

  it('handles null/undefined plan', () => {
    const roles = resolveAuthRoles(null);
    assert.ok('anon' in roles);
  });
});
