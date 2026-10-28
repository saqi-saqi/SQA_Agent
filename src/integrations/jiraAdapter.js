/**
 * integrations/jiraAdapter.js — Jira adapter for issue tracking.
 *
 * Uses Jira Cloud REST API v3 (https://developer.atlassian.com/cloud/jira/platform/rest/v3/).
 * Auth: email + API token via Basic auth.
 *
 * Required env:
 *   JIRA_BASE_URL — e.g. https://your-domain.atlassian.net
 *   JIRA_EMAIL    — your Atlassian account email
 *   JIRA_API_TOKEN — API token from https://id.atlassian.com/manage-profile/security/api-tokens
 *
 * Or pass via constructor.
 */

const SEVERITY_TO_PRIORITY = {
  critical: '1',  // Highest
  high:     '2',
  medium:   '3',
  low:      '4',
  info:     '5',  // Lowest
};

export class JiraAdapter {
  /**
   * @param {object} options
   * @param {string} options.baseUrl     — Jira Cloud base URL
   * @param {string} options.email
   * @param {string} options.apiToken
   * @param {string} options.projectKey   — e.g. 'SQA'
   * @param {object} [options.fetch]
   */
  constructor({ baseUrl, email, apiToken, projectKey, fetch: fetchImpl } = {}) {
    if (!baseUrl) throw new Error('JiraAdapter requires baseUrl');
    if (!email) throw new Error('JiraAdapter requires email');
    if (!apiToken) throw new Error('JiraAdapter requires apiToken');
    if (!projectKey) throw new Error('JiraAdapter requires projectKey');

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.email = email;
    this.apiToken = apiToken;
    this.projectKey = projectKey;
    this.fetch = fetchImpl || globalThis.fetch;
    if (!this.fetch) throw new Error('No fetch implementation available');

    // Pre-encode Basic auth header
    this._authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  async _api(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        'Authorization': this._authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;
    if (res.status >= 400) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(`Jira API ${res.status}: ${errBody.errorMessages?.join('; ') || res.statusText}`);
      err.status = res.status;
      err.body = errBody;
      throw err;
    }

    return res.json();
  }

  /**
   * Search for an existing open Jira issue by signature.
   * Uses JQL: project = SQA AND signature ~ "ruleId::url" AND statusCategory != Done
   */
  async search({ ruleId, signature }) {
    if (!signature) return null;
    const jql = `project = ${this.projectKey} AND statusCategory != Done AND description ~ "${signature}" ORDER BY created DESC`;

    try {
      const data = await this._api('POST', '/rest/api/3/search', {
        jql,
        maxResults: 1,
        fields: ['summary', 'status', 'description', 'priority', 'labels'],
      });

      if (!data.issues || data.issues.length === 0) return null;
      return this._normalizeIssue(data.issues[0]);
    } catch (err) {
      if (err.status === 400) return null;  // bad JQL or no results
      throw err;
    }
  }

  /**
   * Create a new Jira issue.
   */
  async create({ title, body, labels, severity, signature }) {
    const signedBody = `{panel:title=SQA Signature|borderStyle=dashed}\n${signature}\n{panel}\n\n${body}`;

    const data = await this._api('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: this.projectKey },
        summary: title,
        description: signedBody,
        labels: labels || [],
        priority: { id: SEVERITY_TO_PRIORITY[severity] || SEVERITY_TO_PRIORITY.medium },
        issuetype: { name: 'Bug' },
      },
    });

    // Fetch the full issue to get a normalized shape
    const full = await this._api('GET', `/rest/api/3/issue/${data.key}`);
    return this._normalizeIssue(full);
  }

  /**
   * Update an existing Jira issue — add a comment + optionally update labels.
   */
  async update(issue, { labels, comment }) {
    if (comment) {
      await this._api('POST', `/rest/api/3/issue/${issue.id}/comment`, {
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] },
      });
    }

    if (labels) {
      await this._api('PUT', `/rest/api/3/issue/${issue.id}`, {
        fields: { labels },
      });
    }

    return issue;
  }

  /**
   * Close a Jira issue — transition to "Done" status.
   */
  async close(issue, { reason = 'completed' } = {}) {
    // Get available transitions for this issue
    const transitionsRes = await this._api('GET', `/rest/api/3/issue/${issue.id}/transitions`);

    const doneTransition = transitionsRes.transitions?.find(t =>
      /^done|closed|resolved$/i.test(t.name) || t.to?.statusCategory?.key === 'done'
    );

    if (!doneTransition) {
      throw new Error(`No "Done" transition available for issue ${issue.id}`);
    }

    await this._api('POST', `/rest/api/3/issue/${issue.id}/transitions`, {
      transition: { id: doneTransition.id },
    });

    return { ...issue, state: 'closed' };
  }

  /**
   * List all open issues in this project with the sqa-agent label.
   */
  async listOpen() {
    const jql = `project = ${this.projectKey} AND statusCategory != Done AND labels = "sqa-agent" ORDER BY created DESC`;
    const data = await this._api('POST', '/rest/api/3/search', {
      jql,
      maxResults: 100,
      fields: ['summary', 'status', 'description', 'priority', 'labels'],
    });

    return (data.issues || []).map(this._normalizeIssue);
  }

  _normalizeIssue(raw) {
    return {
      id: raw.key,  // e.g. 'SQA-123'
      url: `${this.baseUrl}/browse/${raw.key}`,
      state: raw.fields?.status?.statusCategory?.key === 'done' ? 'closed' : 'open',
      title: raw.fields?.summary,
      labels: raw.fields?.labels || [],
      _signature: extractJiraSignature(raw.fields?.description || ''),
    };
  }
}

function extractJiraSignature(description) {
  if (!description) return null;
  // Description comes back as Atlassian Document Format (ADF) JSON in v3.
  // For simplicity, we regex-match the signature from the rendered panel.
  // Real implementation should walk the ADF tree.
  if (typeof description === 'string') {
    const m = description.match(/SQA Signature[^{]*\n([^\n]+)/);
    return m ? m[1].trim() : null;
  }
  // ADF object — try to extract from content
  try {
    const text = JSON.stringify(description);
    const m = text.match(/ruleId::[^"]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

export { extractJiraSignature };
