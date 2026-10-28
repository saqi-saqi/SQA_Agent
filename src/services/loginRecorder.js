/**
 * services/loginRecorder.js — "record-once login" capture.
 *
 * Launches a HEADED Chromium the user can interact with. A floating banner
 * is injected into every page: the user logs into the target site manually
 * (their own credentials, their own 2FA), then clicks "✅ Save session".
 * The context's storageState (cookies + localStorage) is captured and
 * handed to the caller, which persists it via SessionStore.
 *
 * One recording at a time. Hard time limit (default 5 min) auto-cancels.
 * The chromium dependency is injectable for tests.
 */
import { chromium } from 'playwright';

const BANNER_INIT_SCRIPT = `
(() => {
  window.__sqaRecorder = window.__sqaRecorder || { action: null };
  const mount = () => {
    if (document.getElementById('__sqa-recorder-bar')) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    const bar = document.createElement('div');
    bar.id = '__sqa-recorder-bar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:12px 16px;background:#0b1020;color:#eef1ff;font:600 14px system-ui,sans-serif;box-shadow:0 -4px 16px rgba(0,0,0,.45);';
    const label = document.createElement('span');
    label.textContent = '🔒 SQA Agent — recording your login. When you are logged in, click Save.';
    const save = document.createElement('button');
    save.textContent = '✅ Save session';
    save.style.cssText = 'padding:8px 18px;border:0;border-radius:8px;background:#16a34a;color:#fff;font:700 14px system-ui,sans-serif;cursor:pointer;';
    save.onclick = () => { window.__sqaRecorder.action = 'save'; };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:8px 14px;border:0;border-radius:8px;background:#374151;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;';
    cancel.onclick = () => { window.__sqaRecorder.action = 'cancel'; };
    bar.appendChild(label);
    bar.appendChild(save);
    bar.appendChild(cancel);
    root.appendChild(bar);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  document.addEventListener('DOMContentLoaded', mount);
})();`;

export class LoginRecorder {
  /**
   * @param {object} deps
   * @param {object} [deps.chromium]        — Playwright chromium (injectable)
   * @param {number} [deps.maxDurationMs]   — hard recording time limit
   * @param {number} [deps.pollMs]          — banner action poll interval
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ chromium: chromiumDep = chromium, maxDurationMs = 5 * 60 * 1000, pollMs = 700, log = () => {} } = {}) {
    this.chromium = chromiumDep;
    this.maxDurationMs = maxDurationMs;
    this.pollMs = pollMs;
    this.log = log;
    this.active = false;
  }

  /** True while a recording is in progress. */
  isActive() {
    return this.active;
  }

  /**
   * Start recording a login for a monitor.
   * @returns {Promise<{started: true, monitorId: string}>}
   * @throws when a recording is already in progress
   */
  async start({ monitorId, url, onDone }) {
    if (this.active) {
      throw new Error(`A login recording is already in progress (monitor: ${this.monitorId})`);
    }
    if (!monitorId || !url) throw new Error('start() requires monitorId and url');
    if (typeof onDone !== 'function') throw new Error('start() requires an onDone callback');

    this.active = true;
    this.monitorId = monitorId;
    this.startedAt = Date.now();
    this._done = onDone;

    try {
      this.browser = await this.chromium.launch({ headless: false });
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
      });
      await this.context.addInitScript(BANNER_INIT_SCRIPT);
      this.page = await this.context.newPage();
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      this.log(`Login recording started for monitor ${monitorId} → ${url}`);
    } catch (err) {
      this.active = false;
      await this._closeBrowser().catch(() => {});
      throw new Error(`Could not open the recording browser: ${err.message}`);
    }

    // Hard time limit — never leave a browser (and a live login) open forever
    this._timeout = setTimeout(() => {
      this._finish({ ok: false, reason: 'timeout', message: 'Recording timed out after 5 minutes — nothing was saved. Your login was NOT stored.' });
    }, this.maxDurationMs);

    this._poll = setInterval(() => this._checkBanner().catch(() => {}), this.pollMs);
    return { started: true, monitorId };
  }

  async _checkBanner() {
    if (!this.active || !this.context) return;
    const pages = this.context.pages();
    this.currentUrl = pages.length ? pages[pages.length - 1].url() : undefined;

    for (const page of pages) {
      let action = null;
      try {
        action = await page.evaluate(() => window.__sqaRecorder?.action || null);
      } catch { /* navigating / cross-origin — try next page */ }
      if (action === 'save') {
        await this._finishWithSave();
        return;
      }
      if (action === 'cancel') {
        this._finish({ ok: false, reason: 'user-cancel', message: 'Recording cancelled — nothing was saved.' });
        return;
      }
    }
  }

  async _finishWithSave() {
    try {
      const state = await this.context.storageState();
      this._finish({ ok: true, state });
    } catch (err) {
      this._finish({ ok: false, reason: 'capture-failed', message: `Could not capture the session: ${err.message}` });
    }
  }

  /** User-initiated cancel from the dashboard. */
  async cancel(reason = 'user-cancel') {
    if (!this.active) return { ok: false, message: 'No recording in progress' };
    this._finish({ ok: false, reason, message: 'Recording cancelled — nothing was saved.' });
    return { ok: true };
  }

  _finish(result) {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this._timeout);
    clearInterval(this._poll);
    const done = this._done;
    const monitorId = this.monitorId;
    this._closeBrowser().finally(() => {
      if (typeof done === 'function') done({ monitorId, ...result });
    });
  }

  async _closeBrowser() {
    clearTimeout(this._timeout);
    clearInterval(this._poll);
    try { await this.context?.close(); } catch { /* already closed */ }
    try { await this.browser?.close(); } catch { /* already closed */ }
    this.context = null;
    this.browser = null;
  }

  /** Non-sensitive status for the dashboard. */
  getStatus() {
    return {
      active: this.active,
      monitorId: this.monitorId || null,
      currentUrl: this.currentUrl || null,
      startedAt: this.active ? new Date(this.startedAt).toISOString() : null,
      elapsedMs: this.active ? Date.now() - this.startedAt : 0,
    };
  }
}
