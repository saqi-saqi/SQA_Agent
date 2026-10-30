/**
 * MCP schema + invariant unit tests.
 *
 * Talks to the real MCP server class over InMemoryTransport (same protocol
 * layer, no subprocess). The full-process integration test lives in
 * test/mcp/integration.test.js.
 *
 * NOTE: this file must NOT set SQA_ALLOW_PRIVATE — the SSRF parity tests
 * below require the default (private targets blocked).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.TESTFLOW_DB_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'testflow-mcp-')) + '/test.sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_DEFS } from '../../src/mcp/tools.js';
import { validateUrlSafe } from '../../src/services/ssrf.js';
import { scrubText, sanitizeError } from '../../src/mcp/redact.js';
import { saveRun } from '../../src/storage/runStore.js';

let client;

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

before(async () => {
  const server = new McpServer({ name: 'testflow-test', version: '0.0.0' });
  for (const tool of TOOL_DEFS) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
    }, tool.handler);
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

after(async () => {
  await client.close();
});

describe('MCP server surface', () => {
  it('exposes exactly the seven specified tools', async () => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), [
      'check_accessibility',
      'check_api_contract',
      'explain_finding',
      'get_scan_report',
      'get_scan_status',
      'quick_check',
      'start_full_scan',
    ]);
    for (const t of tools.tools) {
      assert.ok(t.description && t.description.length > 20, `${t.name} needs an agent-readable description`);
    }
  });
});

describe('tool input schema validation', () => {
  it('rejects quick_check without url with a clear error and no stack trace', async () => {
    const res = await call('quick_check', {});
    assert.equal(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /error/i);
    assert.doesNotMatch(text, /at .+ \(.+:\d+:\d+\)/, 'must not leak stack frames');
  });

  it('rejects start_full_scan with a session credential option', async () => {
    const res = await call('start_full_scan', {
      url: 'https://example.com',
      options: { storageState: { cookies: [{ name: 'sid', value: 'SECRET' }] } },
    });
    assert.equal(res.isError, true, 'credential-bearing options must be rejected before any scan starts');
    const text = res.content[0].text;
    // Either the zod schema rejects the unknown key (protocol error text) or
    // the handler policy does (JSON envelope) — both must name the problem
    // and neither may echo the credential material.
    assert.match(text, /storageState|credential material never crosses this interface/i,
      `unexpected error: ${text.slice(0, 200)}`);
    assert.doesNotMatch(text, /SECRET/, 'credential material must not be echoed');
    assert.doesNotMatch(text, /job_id/, 'no job may be created');
  });

  it('rejects get_scan_report with wrong verbosity enum', async () => {
    const res = await call('get_scan_report', { job_id: 'run_x', verbosity: 'everything' });
    assert.equal(res.isError, true);
  });

  it('get_scan_status on unknown job fails cleanly', async () => {
    const res = await call('get_scan_status', { job_id: 'run_does_not_exist' });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.match(body.error, /Unknown job_id/);
  });
});

describe('SSRF boundary parity (MCP path === regular scan path)', () => {
  const cases = [
    'http://192.168.1.1/',
    'http://10.0.0.5/admin',
    'http://169.254.169.254/latest/meta-data',
  ];

  for (const url of cases) {
    it(`quick_check blocks ${url} identically to validateUrlSafe`, async () => {
      const direct = await validateUrlSafe(url);
      assert.equal(direct.safe, false);

      const res = await call('quick_check', { url });
      assert.equal(res.isError, true);
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.error, direct.error, 'MCP path must reject with the same message as the scan path');
    });
  }

  it('quick_check blocks plain localhost hostnames the same way', async () => {
    const direct = await validateUrlSafe('http://localhost:9999/');
    assert.equal(direct.safe, false);
    const res = await call('quick_check', { url: 'http://localhost:9999/' });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.error, direct.error);
  });
});

describe('explain_finding', () => {
  it('explains a TestFlow rule ID', async () => {
    const res = await call('explain_finding', { rule_id: 'api-status-mismatch' });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.known, true);
    assert.ok(body.title);
    assert.ok(body.explanation);
    assert.ok(body.suggestedFix);
  });

  it('explains a common axe-core rule ID', async () => {
    const res = await call('explain_finding', { rule_id: 'image-alt' });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.known, true);
    assert.match(body.explanation, /alt/i);
  });

  it('returns known:false for unknown rule IDs — never throws', async () => {
    const res = await call('explain_finding', { rule_id: 'definitely-not-a-rule' });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.known, false);
    assert.ok(body.explanation);
  });
});

describe('get_scan_report: invariants enforced before an agent sees a report', () => {
  it('returns a consistent report for a well-formed run', async () => {
    const runId = 'mcp_ok_1';
    saveRun({
      runId,
      url: 'https://example.com/',
      status: 'completed',
      startedAt: new Date().toISOString(),
      options: { maxPages: 1 },
      pages: [{ url: 'https://example.com/' }],
      findings: [{
        id: 'NET-001', title: 'API GET /api/users returned 500', severity: 'high',
        confidence: 'confirmed', category: 'network', findingType: 'bug',
        ruleId: 'api-error', pageUrl: 'https://example.com/api/users',
        description: '500 Internal Server Error', suggestedFix: 'Fix the handler',
      }],
      score: 92,
      coverage: { pagesAttempted: 1, pagesScanned: 1, coverageRatio: 1.0 },
      summary: null,
    });

    const res = await call('get_scan_report', { job_id: runId });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    const report = JSON.parse(res.content[0].text);
    assert.equal(report.summary.confirmedBugs, 1);
    assert.equal(report.summary.totalFindingsShown, 1);
    assert.equal(report.confirmed.length, 1);
    assert.equal(report.confirmed[0].rule, 'api-error');
    assert.ok(report.confirmed[0].suggestedFix);
  });

  it('normalizes silent-zero perf metrics (no raw 0 where unmeasured)', async () => {
    const runId = 'mcp_silent_zero';
    saveRun({
      runId,
      url: 'https://example.com/',
      status: 'completed',
      startedAt: new Date().toISOString(),
      options: { maxPages: 1 },
      pages: [{ url: 'https://example.com/' }],
      findings: [{
        id: 'PERF-001', title: 'slow page', severity: 'medium',
        confidence: 'confirmed', category: 'performance', findingType: 'warning',
        ruleId: 'slow-page-load', pageUrl: 'https://example.com/',
        metrics: { LCP: 0, FCP: 0, TTFB: 0 },
      }],
      score: 90,
      coverage: { pagesAttempted: 1, pagesScanned: 1, coverageRatio: 1.0 },
      summary: null,
    });

    const res = await call('get_scan_report', { job_id: runId, verbosity: 'full' });
    const report = JSON.parse(res.content[0].text);
    const finding = report.allFindings?.find(f => f.rule === 'slow-page-load')
      ?? report.confirmed.find(f => f.rule === 'slow-page-load');
    // summary verbosity includes it via `other` (warning, not a bug)
    const target = finding || report.other.find(f => f.rule === 'slow-page-load');
    assert.ok(target, 'finding present in report');
    assert.equal(target.metrics.LCP, null, 'LCP 0 must be marked unmeasured, not raw 0');
    assert.equal(target.metrics.FCP, null);
    assert.equal(target.metrics.TTFB, null);
    assert.ok(target.metrics._unmeasured.includes('LCP'));
    assert.equal(target.metrics.measured.LCP, false);
  });

  it('withholds a report that violates the no-duplicates invariant', async () => {
    const runId = 'mcp_dupes';
    const dup = () => ({
      id: 'A11Y-001', title: 'a11y: broken', severity: 'critical',
      confidence: 'confirmed', category: 'accessibility', findingType: 'bug',
      ruleId: 'image-alt', pageUrl: 'https://example.com/',
      selector: '#violating-hero-img',
    });
    saveRun({
      runId,
      url: 'https://example.com/',
      status: 'completed',
      startedAt: new Date().toISOString(),
      options: { maxPages: 1 },
      pages: [{ url: 'https://example.com/' }],
      findings: [dup(), dup()],
      score: 85,
      coverage: { pagesAttempted: 1, pagesScanned: 1, coverageRatio: 1.0 },
      summary: null,
    });

    const res = await call('get_scan_report', { job_id: runId });
    const body = JSON.parse(res.content[0].text);
    assert.ok(body.error, 'withheld case returns the error envelope');
    assert.ok(!('confirmed' in body), 'malformed report must be withheld');
    assert.ok(Array.isArray(body.validationErrors) && body.validationErrors.length > 0);
    assert.match(body.validationErrors[0], /Duplicate finding/);
  });
});

describe('redaction layer', () => {
  it('scrubs bearer tokens, JWTs, cookies and key=value secrets', () => {
    const input = 'Authorization: Bearer abc123def456\n' +
      'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n' +
      'cookie: session=super-secret-value; other=x\n' +
      'api_key = "sk-live-abcdef123456"';
    const out = scrubText(input);
    assert.doesNotMatch(out, /abc123def456/);
    assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiIs/);
    assert.doesNotMatch(out, /super-secret-value/);
    assert.doesNotMatch(out, /sk-live-abcdef123456/);
    assert.match(out, /\[REDACTED\]/);
  });

  it('sanitizeError never returns stack frames', () => {
    const err = new Error('boom at /src/x.js:12:5');
    err.stack = 'Error: boom\n    at foo (/src/x.js:12:5)\n    at bar (/src/y.js:3:1)';
    const out = sanitizeError(err);
    assert.doesNotMatch(out, /at foo|at bar/);
    assert.doesNotMatch(out, /\n {4}at /);
  });
});
