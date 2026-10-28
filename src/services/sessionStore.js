/**
 * services/sessionStore.js — encrypted "record-once login" sessions (Rung 3+).
 *
 * A recorded session is a Playwright storageState ({ cookies, origins })
 * captured from a real manual login. Sessions are stored PER MONITOR and
 * encrypted at rest with AES-256-GCM — they contain live credentials, so
 * plaintext must never touch the disk.
 *
 * Files:  <dataDir>/sessions/<monitorId>.session  (base64 iv.tag.ciphertext)
 * Key:    SQA_SESSION_SECRET env (any passphrase, stretched with scrypt)
 *         — or an auto-generated key persisted at <dataDir>/.session.key
 *
 * Never log session contents. Only metadata (cookie count, recordedAt) is
 * exposed to the UI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SESSION_ALGO = 'aes-256-gcm';

/** Heuristic: does this URL/title look like a login page? Used to detect
 *  expired recorded sessions (the crawler landed on login despite cookies). */
export function looksLikeLoginUrl(url = '', title = '') {
  const text = `${url} ${title}`.toLowerCase();
  // \s is a boundary because url and title are joined with a space —
  // a login path at the END of the url must still match.
  return /\/(login|signin|sign-in|log-in|auth|authenticate|session|sso)([/?#]|\s|$)/.test(text)
    || /(sign in|log in|login|sign up|register) (to |into )?your account/.test(text)
    || /(login|sign in) page/.test(text);
}

export class SessionStore {
  constructor({ dataDir = path.join(process.cwd(), 'data'), secret = process.env.SQA_SESSION_SECRET } = {}) {
    this.dir = path.join(dataDir, 'sessions');
    this.keyPath = path.join(dataDir, '.session.key');
    this._secret = secret;
  }

  /** Resolve the 32-byte key: env passphrase → scrypt, else generated key file. */
  async _getKey() {
    if (this._key) return this._key;
    if (this._secret) {
      this._key = crypto.scryptSync(this._secret, 'sqa-session-salt', 32);
      return this._key;
    }
    // Auto-generate and persist (0600 where the OS supports it)
    try {
      this._key = crypto.createHash('sha256')
        .update(await fs.readFile(this.keyPath, 'utf-8'))
        .digest();
      return this._key;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const generated = crypto.randomBytes(32).toString('hex');
      await fs.mkdir(path.dirname(this.keyPath), { recursive: true });
      await fs.writeFile(this.keyPath, generated, { mode: 0o600 });
      this._key = crypto.createHash('sha256').update(generated).digest();
      return this._key;
    }
  }

  _file(monitorId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(monitorId)) {
      throw new Error(`Invalid monitor id for session storage: ${monitorId}`);
    }
    return path.join(this.dir, `${monitorId}.session`);
  }

  /** Encrypt + persist a storageState for a monitor. Returns metadata. */
  async saveSession(monitorId, storageState) {
    if (!storageState || !Array.isArray(storageState.cookies)) {
      throw new Error('Invalid storageState — expected { cookies, origins }');
    }
    const key = await this._getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(SESSION_ALGO, key, iv);
    const plaintext = Buffer.from(JSON.stringify(storageState), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this._file(monitorId), `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`);

    const meta = this.metaFromState(storageState);
    return { ...meta, monitorId };
  }

  /** Decrypt + load a session, or null when none exists. Throws on tampering. */
  async loadSession(monitorId) {
    let raw;
    try {
      raw = await fs.readFile(this._file(monitorId), 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const [ivB64, tagB64, dataB64] = raw.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Corrupt session file');
    const key = await this._getKey();
    const decipher = crypto.createDecipheriv(SESSION_ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf-8'));
  }

  async hasSession(monitorId) {
    try {
      await fs.access(this._file(monitorId));
      return true;
    } catch {
      return false;
    }
  }

  async deleteSession(monitorId) {
    try {
      await fs.unlink(this._file(monitorId));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Non-sensitive metadata safe for the UI/logs. */
  metaFromState(storageState) {
    const cookies = storageState?.cookies || [];
    const recordedAt = (() => {
      // Prefer the newest cookie expiry-ish timestamp; fall back to now
      return new Date().toISOString();
    })();
    return {
      exists: true,
      cookieCount: cookies.length,
      originCount: storageState?.origins?.length || 0,
      domains: [...new Set(cookies.map(c => c.domain).filter(Boolean))].slice(0, 5),
      recordedAt,
    };
  }

  async getSessionMeta(monitorId) {
    if (!(await this.hasSession(monitorId))) return { exists: false };
    try {
      const state = await this.loadSession(monitorId);
      return this.metaFromState(state);
    } catch {
      return { exists: true, error: 'session file unreadable (wrong key?)' };
    }
  }

  /**
   * Build a Cookie header value for a target host from a storageState —
   * used to give API contract probes the recorded session.
   */
  cookieHeaderFor(host, storageState) {
    if (!host || !storageState?.cookies?.length) return null;
    const now = Date.now() / 1000;
    const parts = [];
    for (const c of storageState.cookies) {
      const domain = (c.domain || '').replace(/^\./, '');
      if (!domain || !(host === domain || host.endsWith(`.${domain}`))) continue;
      if (c.expires && c.expires > 0 && c.expires < now) continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.length ? parts.join('; ') : null;
  }
}
