import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  IssueTrackerPublisher,
  findingSignature,
  buildIssueBody,
  groupFindingsBySignature,
  labelsForFinding,
} from '../src/integrations/issueTracker.js';
import { GitHubAdapter, extractSignatureFromBody } from '../src/integrations/githubAdapter.js';
import { JiraAdapter, extractJiraSignature } from '../src/integrations/jiraAdapter.js';

// ─── findingSignature ────────────────────────────────────────────────

describe('findingSignature', () => {
  it('combines ruleId + cleaned pageUrl', () => {
    const sig = findingSignature({
      ruleId: 'broken-link',
      pageUrl: 'https://example.com/page?utm_source=x',
    });
    // Query strings should be stripped (utm_source is tracked)
    assert.equal(sig, 'broken-link::https://example.com/page');
  });

  it('handles findings without ruleId', () => {
    const sig = findingSignature({ pageUrl: 'https://example.com' });
    assert.equal(sig, 'unknown::https://example.com/');
  });

  it('handles findings without pageUrl', () => {
    const sig = findingSignature({ ruleId: 'global' });
    assert.equal(sig, 'global::');
  });

  it('produces same signature for same ruleId + same path', () => {
    const a = findingSignature({ ruleId: 'r', pageUrl: 'https://example.com/x' });
    const b = findingSignature({ ruleId: 'r', pageUrl: 'https://example.com/x' });
    assert.equal(a, b);
  });

  it('produces different signature when ruleId differs', () => {
    const a = findingSignature({ ruleId: 'r1', pageUrl: 'https://example.com' });
    const b = findingSignature({ ruleId: 'r2', pageUrl: 'https://example.com' });
    assert.notEqual(a, b);
  });
});

// ─── buildIssueBody ───────────────────────────────────────────────────

describe('buildIssueBody', () => {
  const sampleFinding = {
    title: 'Broken login link',
    severity: 'high',
    confidence: 'confirmed',
    category: 'links',
    ruleId: 'broken-link-001',
    origin: 'first-party',
    pageUrl: 'https://example.com/login',
    description: 'Login button 404s',
    evidence: 'HTTP 404 on /auth/login',
    suggestedFix: 'Update the href to /login',
    occurrences: 3,
    affectedPages: ['https://example.com/login', 'https://example.com/signup'],
    reproSteps: ['Open /', 'Click Login', 'Observe 404'],
  };

  it('includes the finding title as a header', () => {
    const body = buildIssueBody(sampleFinding);
    assert.match(body, /### Broken login link/);
  });

  it('includes the description', () => {
    const body = buildIssueBody(sampleFinding);
    assert.match(body, /Login button 404s/);
  });

  it('includes the details section with severity, confidence, rule ID', () => {
    const body = buildIssueBody(sampleFinding);
    assert.match(body, /\*\*Severity:\*\* high/);
    assert.match(body, /\*\*Confidence:\*\* confirmed/);
    assert.match(body, /\*\*Rule ID:\*\* `broken-link-001`/);
  });

  it('includes evidence in a code block', () => {
    const body = buildIssueBody(sampleFinding);
    assert.match(body, /```\nHTTP 404 on \/auth\/login\n```/);
  });

  it('includes repro steps as a numbered list', () => {
    const body = buildIssueBody(sampleFinding);
    assert.match(body, /1\. Open \//);
    assert.match(body, /2\. Click Login/);
    assert.match(body, /3\. Observe 404/);
  });

  it('includes suggested fix', () => {
    const body = buildIssueBody(sampleFinding);
    assert.match(body, /#### Suggested Fix/);
    assert.match(body, /Update the href to \/login/);
  });

  it('includes run context when provided', () => {
    const body = buildIssueBody(sampleFinding, { runId: 'run_123', url: 'https://example.com' });
    assert.match(body, /\*\*Run ID:\*\* `run_123`/);
    assert.match(body, /\*\*Target:\*\* https:\/\/example.com/);
  });

  it('includes the sqa-agent footer', () => {
    const body = buildIssueBody(sampleFinding);
    assert.match(body, /auto-filed by SQA Agent/);
  });

  it('handles minimal finding', () => {
    const body = buildIssueBody({ title: 'X', severity: 'low', category: 'general' });
    assert.match(body, /### X/);
    assert.match(body, /\*\*Severity:\*\* low/);
  });
});

// ─── groupFindingsBySignature ────────────────────────────────────────

describe('groupFindingsBySignature', () => {
  it('groups findings with same signature', () => {
    const findings = [
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'high', occurrences: 1 },
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'medium', occurrences: 1 },
      { ruleId: 'r', pageUrl: 'https://example.com/b', severity: 'low', occurrences: 1 },
    ];
    const groups = groupFindingsBySignature(findings);
    assert.equal(groups.size, 2);  // /a and /b are different signatures
  });

  it('keeps the most severe finding as representative', () => {
    const findings = [
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'medium', occurrences: 1 },
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'critical', occurrences: 1 },
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'high', occurrences: 1 },
    ];
    const groups = groupFindingsBySignature(findings);
    const group = groups.values().next().value;
    assert.equal(group.finding.severity, 'critical');
  });

  it('sums occurrences across same-signature findings', () => {
    const findings = [
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'high', occurrences: 3 },
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'high', occurrences: 5 },
    ];
    const groups = groupFindingsBySignature(findings);
    const group = groups.values().next().value;
    assert.equal(group.allOccurrences, 8);
  });

  it('handles empty input', () => {
    const groups = groupFindingsBySignature([]);
    assert.equal(groups.size, 0);
  });
});

// ─── labelsForFinding ────────────────────────────────────────────────

describe('labelsForFinding', () => {
  it('includes severity label, category label, origin label, and sqa-agent', () => {
    const labels = labelsForFinding({
      severity: 'high',
      category: 'links',
      origin: 'first-party',
    });
    assert.ok(labels.includes('P1-high'));
    assert.ok(labels.includes('category:links'));
    assert.ok(labels.includes('origin:first-party'));
    assert.ok(labels.includes('sqa-agent'));
  });

  it('includes extraLabels from options', () => {
    const labels = labelsForFinding(
      { severity: 'medium', category: 'network' },
      { extraLabels: ['production', 'regression'] }
    );
    assert.ok(labels.includes('production'));
    assert.ok(labels.includes('regression'));
  });

  it('deduplicates labels', () => {
    const labels = labelsForFinding(
      { severity: 'high', category: 'links' },
      { extraLabels: ['sqa-agent', 'links'] }
    );
    const sqaCount = labels.filter(l => l === 'sqa-agent').length;
    assert.equal(sqaCount, 1);
  });

  it('handles missing severity', () => {
    const labels = labelsForFinding({ category: 'links' });
    assert.ok(labels.includes('sqa-agent'));
    assert.ok(labels.includes('category:links'));
  });
});

// ─── IssueTrackerPublisher ───────────────────────────────────────────

describe('IssueTrackerPublisher', () => {
  // Mock adapter — records calls + returns canned responses
  function makeMockAdapter(opts = {}) {
    const calls = { search: [], create: [], update: [], close: [] };
    return {
      name: 'mock',
      calls,
      search: async ({ ruleId, signature }) => {
        calls.search.push({ ruleId, signature });
        return opts.existingIssue || null;
      },
      create: async ({ title, body, labels, severity, signature }) => {
        calls.create.push({ title, body, labels, severity, signature });
        return { id: 'ISSUE-' + (calls.create.length), url: 'mock://issue/' + calls.create.length, state: 'open', title, labels };
      },
      update: async (issue, { labels, comment }) => {
        calls.update.push({ issue, labels, comment });
        return issue;
      },
      close: async (issue, { reason }) => {
        calls.close.push({ issue, reason });
        return { ...issue, state: 'closed' };
      },
    };
  }

  it('files new issues when no existing match', async () => {
    const adapter = makeMockAdapter();
    const publisher = new IssueTrackerPublisher({ adapter });

    const findings = [
      { ruleId: 'r1', pageUrl: 'https://example.com', severity: 'high', title: 'Bug 1', category: 'links' },
      { ruleId: 'r2', pageUrl: 'https://example.com', severity: 'medium', title: 'Bug 2', category: 'network' },
    ];

    const result = await publisher.publish(findings, { runId: 'run_test' });
    assert.equal(result.filed, 2);
    assert.equal(result.updated, 0);
    assert.equal(adapter.calls.create.length, 2);
  });

  it('updates existing issues when match found', async () => {
    const adapter = makeMockAdapter({
      existingIssue: { id: 'ISSUE-42', url: 'mock://issue/42', state: 'open', title: 'Existing bug', labels: ['sqa-agent'] },
    });
    const publisher = new IssueTrackerPublisher({ adapter });

    const findings = [
      { ruleId: 'r1', pageUrl: 'https://example.com', severity: 'high', title: 'Bug 1', category: 'links', occurrences: 2 },
    ];

    const result = await publisher.publish(findings, { runId: 'run_test' });
    assert.equal(result.filed, 0);
    assert.equal(result.updated, 1);
    assert.equal(adapter.calls.update.length, 1);
    assert.match(adapter.calls.update[0].comment, /Re-occurred/);
  });

  it('skips findings below minSeverity', async () => {
    const adapter = makeMockAdapter();
    const publisher = new IssueTrackerPublisher({
      adapter,
      options: { minSeverity: 'high' },
    });

    const findings = [
      { ruleId: 'r1', pageUrl: 'https://example.com', severity: 'critical', title: 'Bug 1', category: 'links' },
      { ruleId: 'r2', pageUrl: 'https://example.com', severity: 'medium', title: 'Bug 2', category: 'network' },
      { ruleId: 'r3', pageUrl: 'https://example.com', severity: 'low', title: 'Bug 3', category: 'network' },
    ];

    const result = await publisher.publish(findings);
    assert.equal(result.filed, 1);  // only critical
  });

  it('groups findings by signature before publishing', async () => {
    const adapter = makeMockAdapter();
    const publisher = new IssueTrackerPublisher({ adapter });

    // 3 findings, all same signature → should file 1 issue
    const findings = [
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'high', title: 'Bug 1', category: 'links', occurrences: 1 },
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'medium', title: 'Bug 2', category: 'links', occurrences: 1 },
      { ruleId: 'r', pageUrl: 'https://example.com/a', severity: 'low', title: 'Bug 3', category: 'links', occurrences: 1 },
    ];

    const result = await publisher.publish(findings);
    assert.equal(result.filed, 1);  // grouped
  });

  it('records errors per finding', async () => {
    const adapter = makeMockAdapter();
    adapter.search = async () => { throw new Error('API down'); };
    const publisher = new IssueTrackerPublisher({ adapter });

    const findings = [
      { ruleId: 'r1', pageUrl: 'https://example.com', severity: 'high', title: 'Bug 1', category: 'links' },
    ];

    const result = await publisher.publish(findings);
    assert.equal(result.filed, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /API down/);
  });

  it('dry-run mode skips all API calls', async () => {
    const adapter = makeMockAdapter();
    const publisher = new IssueTrackerPublisher({
      adapter,
      options: { dryRun: true },
    });

    const findings = [
      { ruleId: 'r1', pageUrl: 'https://example.com', severity: 'high', title: 'Bug 1', category: 'links' },
    ];

    const result = await publisher.publish(findings);
    assert.equal(result.filed, 1);  // counted but not actually filed
    assert.equal(adapter.calls.search.length, 0);
    assert.equal(adapter.calls.create.length, 0);
  });

  it('rejects adapter missing required methods', () => {
    assert.throws(
      () => new IssueTrackerPublisher({ adapter: { search: () => {} } }),
      /must implement search, create, update/i,
    );
  });

  it('rejects null adapter', () => {
    assert.throws(
      () => new IssueTrackerPublisher({}),
      /requires an adapter/i,
    );
  });

  it('returns empty stats for empty findings', async () => {
    const adapter = makeMockAdapter();
    const publisher = new IssueTrackerPublisher({ adapter });
    const result = await publisher.publish([]);
    assert.equal(result.filed, 0);
    assert.equal(result.updated, 0);
  });
});

// ─── GitHubAdapter ────────────────────────────────────────────────────

describe('GitHubAdapter', () => {
  function makeMockFetch(routes) {
    return async (url, opts = {}) => {
      const method = opts.method || 'GET';
      const match = routes.find(r => r.url.test(url) && (!r.method || r.method === method));
      if (!match) throw new Error(`Mock fetch: no route for ${method} ${url}`);
      if (match.throw) throw new Error(match.throw);
      const status = match.status || 200;
      const headers = new Headers({ 'content-type': 'application/json' });
      const body = match.body ? JSON.stringify(match.body) : null;
      return {
        status,
        headers,
        async json() { return match.body || {}; },
        async text() { return body || ''; },
      };
    };
  }

  it('requires repo in owner/name format', () => {
    assert.throws(() => new GitHubAdapter({}), /owner\/name/i);
    assert.throws(() => new GitHubAdapter({ repo: 'bad' }), /owner\/name/i);
    assert.doesNotThrow(() => new GitHubAdapter({ repo: 'foo/bar' }));
  });

  it('create calls POST /repos/{repo}/issues with signed body', async () => {
    const calls = [];
    const fetch = async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      return {
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return {
            number: 42,
            html_url: 'https://github.com/foo/bar/issues/42',
            state: 'open',
            title: 'Test',
            labels: [{ name: 'sqa-agent' }],
            body: opts.body ? JSON.parse(opts.body).body : '',
          };
        },
      };
    };

    const adapter = new GitHubAdapter({ repo: 'foo/bar', token: 'TEST', fetch });
    const issue = await adapter.create({
      title: '[SQA] Test bug',
      body: 'Body text',
      labels: ['sqa-agent', 'P1-high'],
      severity: 'high',
      signature: 'sig-123',
    });

    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/repos\/foo\/bar\/issues$/);
    assert.match(calls[0].body.body, /<!-- sqa-signature: sig-123 -->/);
    assert.equal(issue.id, 42);
    assert.equal(issue.url, 'https://github.com/foo/bar/issues/42');
  });

  it('search uses GitHub search API', async () => {
    let capturedUrl;
    const fetch = async (url) => {
      capturedUrl = url;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return {
            total_count: 1,
            items: [{
              number: 99,
              html_url: 'https://github.com/foo/bar/issues/99',
              state: 'open',
              title: 'Existing bug',
              labels: [{ name: 'sqa-agent' }],
              body: '<!-- sqa-signature: ruleId::https://example.com -->\n\nBody',
            }],
          };
        },
      };
    };

    const adapter = new GitHubAdapter({ repo: 'foo/bar', token: 'TEST', fetch });
    const issue = await adapter.search({ ruleId: 'ruleId', signature: 'ruleId::https://example.com' });

    assert.ok(issue);
    assert.equal(issue.id, 99);
    assert.equal(issue._signature, 'ruleId::https://example.com');
    assert.match(capturedUrl, /\/search\/issues/);
  });

  it('search returns null when no matches', async () => {
    const fetch = async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() { return { total_count: 0, items: [] }; },
    });

    const adapter = new GitHubAdapter({ repo: 'foo/bar', token: 'TEST', fetch });
    const issue = await adapter.search({ signature: 'unknown' });
    assert.equal(issue, null);
  });

  it('extractSignatureFromBody pulls the hidden comment out', () => {
    const sig = extractSignatureFromBody('<!-- sqa-signature: ruleId::https://example.com -->\n\nBody');
    assert.equal(sig, 'ruleId::https://example.com');
  });

  it('extractSignatureFromBody returns null when not present', () => {
    assert.equal(extractSignatureFromBody('plain text body'), null);
    assert.equal(extractSignatureFromBody(''), null);
  });

  it('throws when token is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    const adapter = new GitHubAdapter({ repo: 'foo/bar', token: undefined, fetch: async () => ({}) });
    await assert.rejects(
      () => adapter.create({ title: 'X', body: 'Y', labels: [], signature: 'sig' }),
      /GITHUB_TOKEN not set/i,
    );
  });
});

// ─── JiraAdapter ─────────────────────────────────────────────────────

describe('JiraAdapter', () => {
  it('requires all credentials', () => {
    assert.throws(() => new JiraAdapter({}), /baseUrl/i);
    assert.throws(() => new JiraAdapter({ baseUrl: 'https://x.atlassian.net' }), /email/i);
    assert.throws(() => new JiraAdapter({ baseUrl: 'https://x.atlassian.net', email: 'a@b.com' }), /apiToken/i);
    assert.throws(() => new JiraAdapter({
      baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 'tok',
    }), /projectKey/i);
    assert.doesNotThrow(() => new JiraAdapter({
      baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA',
    }));
  });

  it('strips trailing slash from baseUrl', () => {
    const adapter = new JiraAdapter({
      baseUrl: 'https://x.atlassian.net/', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA',
    });
    assert.equal(adapter.baseUrl, 'https://x.atlassian.net');
  });

  it('create calls POST /rest/api/3/issue with project + issuetype', async () => {
    const calls = [];
    const fetch = async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      if (/\/rest\/api\/3\/issue$/.test(url) && opts.method === 'POST') {
        return {
          status: 201,
          headers: new Headers({ 'content-type': 'application/json' }),
          async json() { return { key: 'SQA-1' }; },
        };
      }
      // GET /rest/api/3/issue/{key}
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return {
            key: 'SQA-1',
            fields: {
              summary: 'Test bug',
              status: { statusCategory: { key: 'indeterminate' } },
              labels: ['sqa-agent'],
              description: 'panel content',
            },
          };
        },
      };
    };

    const adapter = new JiraAdapter({
      baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA', fetch,
    });
    const issue = await adapter.create({
      title: 'Test bug',
      body: 'Body',
      labels: ['sqa-agent'],
      severity: 'high',
      signature: 'sig-123',
    });

    assert.equal(issue.id, 'SQA-1');
    assert.equal(issue.url, 'https://x.atlassian.net/browse/SQA-1');
    assert.equal(calls[0].body.fields.project.key, 'SQA');
    assert.equal(calls[0].body.fields.issuetype.name, 'Bug');
    assert.equal(calls[0].body.fields.priority.id, '2');  // high → '2'
  });

  it('search returns null when no results', async () => {
    const fetch = async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() { return { issues: [] }; },
    });
    const adapter = new JiraAdapter({
      baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 'tok', projectKey: 'SQA', fetch,
    });
    const issue = await adapter.search({ signature: 'unknown' });
    assert.equal(issue, null);
  });

  it('extractJiraSignature pulls signature from string description', () => {
    const sig = extractJiraSignature('SQA Signature\nruleId::https://example.com');
    assert.equal(sig, 'ruleId::https://example.com');
  });

  it('extractJiraSignature returns null on empty', () => {
    assert.equal(extractJiraSignature(''), null);
    assert.equal(extractJiraSignature(null), null);
  });
});
