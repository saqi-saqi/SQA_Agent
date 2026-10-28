/**
 * integrations/githubAdapter.js — GitHub Issues adapter.
 *
 * Uses GitHub's REST API to search for existing issues, create new ones,
 * and update them with comments when findings re-occur.
 *
 * Auth: GITHUB_TOKEN env var (Personal Access Token with `repo` scope)
 *       or per-adapter token passed via constructor.
 *
 * Required: GitHub repo in "owner/name" format.
 *
 * Rate limits: GitHub allows 5000 req/hour for authenticated requests.
 * Each finding = 1 search + 1 create-or-update, so ~5000 findings/hour
 * before throttling. For larger runs, batch + retry-on-202.
 */

const GITHUB_API = 'https://api.github.com';

const DEFAULT_HEADERS = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'sqa-agent/1.0',
};

export class GitHubAdapter {
  /**
   * @param {object} options
   * @param {string} options.repo        — 'owner/name'
   * @param {string} [options.token]     — defaults to process.env.GITHUB_TOKEN
   * @param {object} [options.fetch]     — defaults to global fetch
   */
  constructor({ repo, token, fetch: fetchImpl } = {}) {
    if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
      throw new Error('GitHubAdapter requires repo in "owner/name" format');
    }
    this.repo = repo;
    this.token = token || process.env.GITHUB_TOKEN;
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.fetch) {
      throw new Error('No fetch implementation available');
    }
  }

  async _api(method, path, body) {
    if (!this.token) {
      throw new Error('GITHUB_TOKEN not set. Set it in env or pass to constructor.');
    }
    const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;
    if (res.status >= 400) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(`GitHub API ${res.status}: ${errBody.message || res.statusText}`);
      err.status = res.status;
      err.body = errBody;
      throw err;
    }

    // 3xx redirects are followed by fetch automatically; we shouldn't see them.
    if (res.status === 201 || res.status === 200) {
      return res.json();
    }
    return null;
  }

  /**
   * Search for an existing open issue by signature.
   * Uses GitHub's search API: label:sqa-agent + signature in body.
   */
  async search({ ruleId, signature }) {
    if (!signature) return null;
    // GitHub search syntax: is:issue is:open repo:owner/name "signature"
    // The signature is unique enough; we don't need to escape it for search.
    const q = `is:issue is:open repo:${this.repo} in:body "${signature}"`;

    try {
      const data = await this._api('GET', `/search/issues?q=${encodeURIComponent(q)}`);
      if (data.total_count === 0) return null;
      // Return the first match
      return this._normalizeIssue(data.items[0]);
    } catch (err) {
      if (err.status === 422 || err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Create a new GitHub issue.
   */
  async create({ title, body, labels, severity, signature }) {
    // Inject signature into the body (hidden HTML comment) so we can search for it later
    const signedBody = `<!-- sqa-signature: ${signature} -->\n\n${body}`;

    const data = await this._api('POST', `/repos/${this.repo}/issues`, {
      title,
      body: signedBody,
      labels,
    });

    return this._normalizeIssue(data);
  }

  /**
   * Update an existing issue — add a comment + optionally update labels.
   */
  async update(issue, { labels, comment }) {
    if (comment) {
      await this._api('POST', `/repos/${this.repo}/issues/${issue.id}/comments`, {
        body: comment,
      });
    }

    if (labels && !arraysEqual(labels, issue.labels)) {
      const data = await this._api('PATCH', `/repos/${this.repo}/issues/${issue.id}`, {
        labels,
      });
      return this._normalizeIssue(data);
    }

    return issue;
  }

  /**
   * Close an issue. Uses the close API + optional reason.
   */
  async close(issue, { reason = 'completed' } = {}) {
    const data = await this._api('PATCH', `/repos/${this.repo}/issues/${issue.id}`, {
      state: 'closed',
      state_reason: reason === 'not_planned' ? 'not_planned' : 'completed',
    });
    return this._normalizeIssue(data);
  }

  /**
   * List all open issues with the sqa-agent label.
   * Used by the "close resolved" feature.
   */
  async listOpen() {
    const q = `is:issue is:open repo:${this.repo} label:sqa-agent`;
    const data = await this._api('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=100`);
    return data.items.map(this._normalizeIssue);
  }

  _normalizeIssue(raw) {
    return {
      id: raw.number,
      url: raw.html_url,
      state: raw.state,
      title: raw.title,
      labels: (raw.labels || []).map(l => l.name),
      // Internal: extract the signature from the body for matching
      _signature: extractSignatureFromBody(raw.body || ''),
    };
  }
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function extractSignatureFromBody(body) {
  const m = body.match(/<!-- sqa-signature: ([^ ]+) -->/);
  return m ? m[1] : null;
}

export { extractSignatureFromBody };
