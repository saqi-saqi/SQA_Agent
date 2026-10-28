/**
 * matrix/browserPool.js — manage Playwright browsers + contexts across matrix runs.
 *
 * Goal: launch one Browser per browser type (chromium/firefox/webkit),
 * spawn fresh BrowserContexts per (viewport × role), apply auth state
 * from StateManager. Closes everything on shutdown.
 *
 * Without a pool, the matrix would launch dozens of browser processes —
 * slow + memory-hungry. With the pool, each browser launches once.
 */

import { chromium, firefox, webkit } from 'playwright';

const BROWSER_LAUNCHERS = {
  chromium,
  firefox,
  webkit,
};

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class BrowserPool {
  constructor({ stateManager, options = {} } = {}) {
    this.stateManager = stateManager;
    this.options = options;
    this.browsers = new Map();        // browserName → Browser
    this.contexts = [];                // tracking for shutdown
    this.launching = new Map();        // browserName → Promise<Browser> (de-dupe concurrent launches)
  }

  /**
   * Get-or-launch a Playwright Browser for the given browser type.
   * Concurrent calls for the same browser share a single launch.
   */
  async getBrowser(browserName) {
    const launcher = BROWSER_LAUNCHERS[browserName];
    if (!launcher) {
      throw new Error(`Unknown browser: ${browserName}. Supported: ${Object.keys(BROWSER_LAUNCHERS).join(', ')}`);
    }

    if (this.browsers.has(browserName)) {
      return this.browsers.get(browserName);
    }

    // De-dupe concurrent launches
    if (this.launching.has(browserName)) {
      return this.launching.get(browserName);
    }

    const launchPromise = (async () => {
      const browser = await launcher.launch({
        args: LAUNCH_ARGS,
        headless: this.options.headless !== false,
      });
      this.browsers.set(browserName, browser);
      this.launching.delete(browserName);
      return browser;
    })();

    this.launching.set(browserName, launchPromise);
    return launchPromise;
  }

  /**
   * Create a fresh BrowserContext configured for a specific
   * (browser, viewport, role) combination.
   *
   * Applies auth state from StateManager if available.
   */
  async createContext({ browserName, viewport, role = 'anon' }) {
    const browser = await this.getBrowser(browserName);

    const context = await browser.newContext({
      viewport: viewport || { width: 1280, height: 720 },
      userAgent: this.options.userAgent || DEFAULT_USER_AGENT,
      locale: 'en-US',
      ignoreHTTPSErrors: this.options.ignoreHTTPSErrors || false,
      // The agent injects its own tooling (axe-core) into scanned pages;
      // hardened sites' CSP/Trusted-Types would otherwise block that.
      bypassCSP: true,
      // Recorded "login once" session — applied to every matrix cell when a
      // monitor has a recorded session.
      ...(this.options.storageState ? { storageState: this.options.storageState } : {}),
    });

    this.contexts.push(context);

    // Apply auth state if we have a snapshot for this (role, browser)
    if (this.stateManager) {
      await this.stateManager.applyTo(context, role, browserName);
    }

    return context;
  }

  /**
   * Close a single context (called by executors when done with a matrix cell).
   */
  async releaseContext(context) {
    const idx = this.contexts.indexOf(context);
    if (idx >= 0) this.contexts.splice(idx, 1);
    await context.close().catch(() => {});
  }

  /**
   * Close everything — browsers + contexts.
   * Safe to call multiple times.
   */
  async shutdown() {
    // Close contexts first (faster, doesn't block on browsers)
    await Promise.allSettled(
      this.contexts.splice(0).map(c => c.close())
    );

    // Then browsers
    const browsers = Array.from(this.browsers.values());
    this.browsers.clear();
    await Promise.allSettled(browsers.map(b => b.close()));

    this.launching.clear();
  }

  /**
   * List currently-open contexts (for stats / debugging).
   */
  stats() {
    return {
      browsers: Array.from(this.browsers.keys()),
      openContexts: this.contexts.length,
      launching: Array.from(this.launching.keys()),
    };
  }
}
