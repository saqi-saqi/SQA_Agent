/**
 * MCP integration test — end-to-end through the REAL MCP server process.
 *
 * Spawns `node src/mcp/stdio.js` as a subprocess and speaks the MCP
 * protocol over stdio (StdioClientTransport), exactly like Claude Code /
 * Cursor would. The fixture site runs on an ephemeral localhost port;
 * the MCP server process gets SQA_ALLOW_PRIVATE=true so the SSRF gate
 * admits the loopback fixture (the same opt-in a developer uses to scan
 * their local dev server).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SQA_ALLOW_PRIVATE = 'true';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../fixtures/site/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');

let fixture;
let client;

async function callJson(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return { isError: res.isError === true, body };
}

before(async () => {
  fixture = await startFixtureServer(0);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'src', 'mcp', 'stdio.js')],
    env: { ...process.env, SQA_ALLOW_PRIVATE: 'true' },
  });
  client = new Client({ name: 'integration-test', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  if (client) await client.close();
  if (fixture) await fixture.close();
});

describe('quick_check through the real MCP server process', () => {
  it('passes on the clean baseline page', async () => {
    const { isError, body } = await callJson('quick_check', { url: `${fixture.url}/page-ok.html` });
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.pass, true, JSON.stringify(body.confirmed));
    assert.equal(body.confirmedCount, 0);
    assert.equal(body.checked.a11y, true);
    assert.equal(body.coverage.pagesScanned, 1);
  }, 60000);

  it('reports the confirmed a11y bug on the failing page', async () => {
    const { isError, body } = await callJson('quick_check', { url: `${fixture.url}/page-a11y-fail.html` });
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.pass, false);
    assert.ok(body.confirmedCount >= 1, JSON.stringify(body));
    const imgAlt = body.confirmed.find(f => f.rule === 'image-alt');
    assert.ok(imgAlt, 'expected image-alt finding');
    assert.equal(imgAlt.severity, 'critical');
    assert.equal(imgAlt.confidence, 'confirmed');
    assert.ok(imgAlt.url.includes('/page-a11y-fail.html'));
    // Privacy: URL is sanitized — no query values ever leave.
    assert.doesNotMatch(imgAlt.url, /=.+/);
  }, 60000);

  it('degrades to a coverage failure when the page will not load', async () => {
    const { isError, body } = await callJson('quick_check', { url: `${fixture.url}/page-timeout.html` });
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.pass, false);
    assert.equal(body.coverage.pagesScanned, 0);
    assert.equal(body.confirmedCount, 0, 'a coverage failure is not a confirmed content bug');
  }, 60000);
});

describe('narrow checks through the real MCP server process', () => {
  it('check_accessibility finds the missing alt text', async () => {
    const { isError, body } = await callJson('check_accessibility', { url: `${fixture.url}/page-a11y-fail-2.html` });
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.pass, false);
    assert.ok(body.confirmed.some(f => f.rule === 'image-alt'));
  }, 60000);

  it('check_accessibility passes the clean page', async () => {
    const { isError, body } = await callJson('check_accessibility', { url: `${fixture.url}/page-ok.html` });
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.pass, true);
  }, 60000);

  it('check_api_contract with explicit endpoints catches /api/always-400', async () => {
    const { isError, body } = await callJson('check_api_contract', {
      url: fixture.url,
      endpoints: [{ method: 'GET', path: '/api/always-400', expectedStatus: 200 }],
    });
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.pass, false);
    assert.equal(body.probed, 1);
    const mismatch = body.confirmed.find(f => f.rule === 'api-status-mismatch');
    assert.ok(mismatch, JSON.stringify(body));
  }, 60000);

  it('check_api_contract with explicit endpoints passes a healthy endpoint', async () => {
    const { isError, body } = await callJson('check_api_contract', {
      url: fixture.url,
      endpoints: [{ method: 'GET', path: '/api/users', expectedStatus: 200 }],
    });
    assert.equal(isError, false, JSON.stringify(body));
    assert.equal(body.pass, true, JSON.stringify(body));
  }, 60000);
});

describe('full-scan tools through the real MCP server process', () => {
  it('start_full_scan returns a job_id immediately and status becomes queryable', async () => {
    const start = await callJson('start_full_scan', {
      url: `${fixture.url}/page-ok.html`,
      options: { maxPages: 1, maxDepth: 1 },
    });
    assert.equal(start.isError, false, JSON.stringify(start.body));
    assert.ok(start.body.job_id, 'must return a job_id');
    assert.equal(start.body.status, 'pending');

    // Status must be queryable right away (pending or running) — the call
    // must NOT block on the scan.
    const status = await callJson('get_scan_status', { job_id: start.body.job_id });
    assert.equal(status.isError, false, JSON.stringify(status.body));
    assert.ok(['pending', 'running', 'complete'].includes(status.body.status));
  }, 60000);
});
