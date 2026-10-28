/**
 * matrix/stateManager.js — resolve + persist authentication state.
 *
 * In Phase 3, an "execution matrix" runs the same plan across multiple
 * (browser × viewport × role) combinations. Roles need different auth
 * states — e.g. "anon" needs no session, "user" needs a logged-in
 * cookie, "admin" needs elevated claims.
 *
 * StateManager:
 *   1. Reads plan.flows[] for flows tagged as auth (e.g. name === 'Login')
 *   2. Executes each auth flow once per (browser, role) pair, capturing
 *      the resulting cookies + localStorage into a StateSnapshot
 *   3. Returns snapshots that BrowserPool can apply to new contexts
 *      without re-running the login flow each time
 *
 * StateSnapshot shape:
 *   {
 *     role:       string,
 *     browser:    'chromium' | 'firefox' | 'webkit',
 *     cookies:    Array<PlaywrightCookie>,
 *     origins:    Array<{ origin, localStorage: Array<{name, value}> }>,
 *     capturedAt: ISO timestamp,
 *     expiresAt:  ISO timestamp | null,
 *   }
 */

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;  // 30 min

/**
 * Heuristic: a flow is an auth flow if its name matches /login|signin|auth/i
 * OR it has tags starting with 'auth' (e.g. 'auth', 'auth:admin', 'auth:editor').
 */
export function isAuthFlow(flow) {
  if (!flow) return false;
  if (flow.tags?.some(t => /^(auth|login|signin)/i.test(t))) return true;
  // Use unanchored match so 'Admin Login', 'User Sign In', 'Authenticate As Editor' all match
  return /(login|signin|sign[\s-]?in|authenticate|auth)/i.test(flow.name || '');
}

/**
 * Identify the auth flows + their target roles from a plan.
 * Returns a map: role -> { flow, loginUrl }
 *
 * Convention:
 *   • Flow named "Login" or tagged "auth:login" → role 'user'
 *   • Flow named "Admin Login" or tagged "auth:admin" → role 'admin'
 *   • A flow tagged "auth:<role>" maps to that role
 *   • If no auth flows, return { anon: null } — the anonymous role
 */
export function resolveAuthRoles(plan) {
  const roles = { anon: { flow: null, loginUrl: null } };

  for (const flow of plan?.flows || []) {
    if (!isAuthFlow(flow)) continue;

    let role = 'user';
    // Look for explicit role tag: 'auth:admin', 'auth:user', 'auth:editor'
    const roleTag = flow.tags?.find(t => t.startsWith('auth:'));
    if (roleTag) {
      role = roleTag.slice(5);
    } else if (/admin/i.test(flow.name)) {
      role = 'admin';
    }

    roles[role] = {
      flow,
      loginUrl: flow.startUrl,
    };
  }

  return roles;
}

/**
 * Capture authentication state by running the login flow in a fresh context.
 *
 * @param {object} options
 * @param {object} options.browser       — Playwright Browser instance
 * @param {object} options.flow          — flow with auth steps
 * @param {object} options.viewport      — { width, height }
 * @param {object} options.runStep       — step runner from executors/e2e.js
 * @param {object} [options.signal]
 * @returns {Promise<{ cookies, origins }>}
 */
export async function captureAuthState({ browser, flow, viewport, runStep, signal }) {
  if (!browser) throw new Error('captureAuthState requires a Playwright browser');
  if (!flow) throw new Error('captureAuthState requires a flow');

  const context = await browser.newContext({
    viewport: viewport || { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    if (signal?.aborted) throw new Error('Aborted before login');

    // Navigate to startUrl
    await page.goto(flow.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Run each step via the e2e step dispatcher
    for (const step of flow.steps) {
      if (signal?.aborted) break;
      await runStep(step, page);
    }

    // Capture cookies + localStorage
    const cookies = await context.cookies();
    const origins = [];
    for (const cookie of cookies) {
      // Group by origin
      const origin = new URL(cookie.url || `https://${cookie.domain.replace(/^\./, '')}`).origin;
      let originEntry = origins.find(o => o.origin === origin);
      if (!originEntry) {
        originEntry = { origin, localStorage: [] };
        origins.push(originEntry);
      }
    }

    // Capture localStorage from each origin visited
    try {
      const lsEntries = await page.evaluate(() => {
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
          const name = localStorage.key(i);
          entries.push({ name, value: localStorage.getItem(name) });
        }
        return entries;
      });
      if (lsEntries.length > 0) {
        const origin = new URL(page.url()).origin;
        let originEntry = origins.find(o => o.origin === origin);
        if (!originEntry) {
          originEntry = { origin, localStorage: [] };
          origins.push(originEntry);
        }
        originEntry.localStorage = lsEntries;
      }
    } catch {
      // localStorage may not be accessible on some pages
    }

    return { cookies, origins };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/**
 * StateManager — caches auth state per (role, browser, viewport).
 *
 * Usage:
 *   const mgr = new StateManager({ runStep });
 *   await mgr.prime({ plan, browser, viewport });
 *   const snapshot = mgr.getSnapshot('user', 'chromium');
 *   // Apply to a new context:
 *   await newContext.addCookies(snapshot.cookies);
 */
export class StateManager {
  constructor({ runStep, ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
    if (!runStep) throw new Error('StateManager requires runStep');
    this.runStep = runStep;
    this.ttlMs = ttlMs;
    this.snapshots = new Map();  // key: `${role}:${browser}` → snapshot
  }

  /**
   * Resolve + capture auth state for every (role, browser) pair.
   * Skips the 'anon' role — no auth needed.
   */
  async prime({ plan, browser, browserName = 'chromium', viewport, signal }) {
    const roles = resolveAuthRoles(plan);
    const warnings = [];

    for (const [role, info] of Object.entries(roles)) {
      if (role === 'anon' || !info.flow) continue;

      const key = `${role}:${browserName}`;
      if (this.snapshots.has(key)) continue;  // already primed

      try {
        const { cookies, origins } = await captureAuthState({
          browser, flow: info.flow, viewport, runStep: this.runStep, signal,
        });
        this.snapshots.set(key, {
          role, browser: browserName, cookies, origins,
          capturedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
        });
      } catch (err) {
        warnings.push(`Failed to prime role "${role}" on ${browserName}: ${err.message}`);
      }
    }

    return { warnings };
  }

  /**
   * Get a cached snapshot. Returns null if not primed or expired.
   */
  getSnapshot(role, browserName) {
    const key = `${role}:${browserName}`;
    const snap = this.snapshots.get(key);
    if (!snap) return null;
    if (snap.expiresAt && new Date(snap.expiresAt).getTime() < Date.now()) {
      this.snapshots.delete(key);
      return null;
    }
    return snap;
  }

  /**
   * Apply a snapshot to a fresh BrowserContext.
   * No-op if no snapshot exists (anonymous role).
   */
  async applyTo(context, role, browserName) {
    const snap = this.getSnapshot(role, browserName);
    if (!snap) return false;

    if (snap.cookies?.length) {
      await context.addCookies(snap.cookies);
    }
    if (snap.origins?.length) {
      await context.addInitScript((origins) => {
        for (const { origin, localStorage: entries } of origins) {
          if (!entries?.length) continue;
          if (window.location.origin === origin) {
            for (const { name, value } of entries) {
              try { localStorage.setItem(name, value); } catch {}
            }
          }
        }
      }, snap.origins);
    }
    return true;
  }

  clear() {
    this.snapshots.clear();
  }

  listSnapshots() {
    return Array.from(this.snapshots.entries()).map(([key, snap]) => ({
      key,
      role: snap.role,
      browser: snap.browser,
      cookieCount: snap.cookies?.length || 0,
      originCount: snap.origins?.length || 0,
      capturedAt: snap.capturedAt,
      expiresAt: snap.expiresAt,
    }));
  }
}
