import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateHtmlReport, generateJsonReport, verdict } from '../src/services/report.js';

const sampleRun = {
  runId: 'run_test_123',
  url: 'https://example.com',
  status: 'completed',
  startedAt: '2025-01-01T00:00:00.000Z',
  completedAt: '2025-01-01T00:01:00.000Z',
  options: { maxPages: 5, maxDepth: 2, checks: ['links'], workflows: [] },
  score: 78,
  summary: {
    totalPages: 2,
    totalFindings: 2,
    totalOccurrences: 3,
    bySeverity: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
    byCategory: { links: 2 },
    byConfidence: { confirmed: 2, high: 0, medium: 0, low: 0 },
    byFindingType: { bug: 2, warning: 0, recommendation: 0, informational: 0, environmental: 0 },
    byOrigin: { 'first-party': 2, 'third-party': 0, unknown: 0 },
    confirmedBugs: 2,
    observationCount: 0,
    recommendationCount: 0,
  },
  pages: [
    {
      url: 'https://example.com/',
      status: 200,
      title: 'Home',
      loadTime: 412,
      forms: 1,
      buttons: 3,
      inputs: 2,
      meta: { metaDescription: 'demo', h1: 'Welcome', viewport: 'device-width' },
      apiCalls: [
        {
          method: 'GET',
          url: 'https://api.example.com/users',
          status: 200,
          requestHeaders: { authorization: 'Bearer SECRET_TOKEN' },
          responseHeaders: { 'content-type': 'application/json' },
          requestBody: null,
          responseBody: { users: [{ id: 1 }] },
          responseContentType: 'application/json',
          initiator: 'main-frame',
          timestamp: '2025-01-01T00:00:01.000Z',
        },
        {
          method: 'POST',
          url: 'https://api.example.com/login',
          status: 401,
          requestHeaders: { 'content-type': 'application/json' },
          responseHeaders: { 'set-cookie': 'session=SECRET' },
          requestBody: { email: 'x@y.com' },
          responseBody: { error: 'invalid' },
          responseContentType: 'application/json',
          initiator: 'main-frame',
          timestamp: '2025-01-01T00:00:02.000Z',
        },
      ],
    },
  ],
  findings: [
    {
      id: 'LINK-001',
      title: 'Broken link',
      severity: 'high',
      confidence: 'confirmed',
      category: 'links',
      findingType: 'bug',
      origin: 'first-party',
      ruleId: 'broken-link',
      pageUrl: 'https://example.com/',
      description: 'Returns 404',
      evidence: 'HTTP 404 on /missing',
      suggestedFix: 'Update href',
      occurrences: 1,
      affectedPages: ['https://example.com/'],
      affectedElements: 1,
      reproSteps: ['Open /', 'Click link'],
      screenshot: null,
    },
    {
      id: 'LINK-002',
      title: 'Broken anchor',
      severity: 'medium',
      confidence: 'confirmed',
      category: 'links',
      findingType: 'bug',
      origin: 'first-party',
      ruleId: 'broken-link',
      pageUrl: 'https://example.com/about',
      description: 'Returns 500',
      evidence: 'HTTP 500',
      suggestedFix: 'Fix backend',
      occurrences: 2,
      affectedPages: ['https://example.com/about', 'https://example.com/team'],
      affectedElements: 2,
      reproSteps: [],
      screenshot: null,
    },
  ],
  workflowResults: [],
  error: null,
};

describe('generateJsonReport', () => {
  it('emits schemaVersion 1 and run metadata', () => {
    const json = generateJsonReport(sampleRun);
    const r = JSON.parse(json);
    assert.equal(r.schemaVersion, 1);
    assert.equal(r.runId, 'run_test_123');
    assert.equal(r.url, 'https://example.com');
    assert.equal(r.status, 'completed');
    assert.equal(r.score, 78);
  });

  it('propagates summary counts verbatim', () => {
    const r = JSON.parse(generateJsonReport(sampleRun));
    assert.equal(r.summary.totalPages, 2);
    assert.equal(r.summary.totalFindings, 2);
    assert.equal(r.summary.bySeverity.high, 1);
    assert.equal(r.summary.confirmedBugs, 2);
  });

  it('preserves apiCalls per page with redacted headers', () => {
    const r = JSON.parse(generateJsonReport(sampleRun));
    const calls = r.pages[0].apiCalls;
    assert.equal(calls.length, 2);

    // Bearer token must be redacted
    assert.equal(calls[0].requestHeaders.authorization, '[REDACTED]');
    // Set-cookie must be redacted
    assert.equal(calls[1].responseHeaders['set-cookie'], '[REDACTED]');
    // Method + status preserved
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].status, 200);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].status, 401);
    // Response bodies preserved (parsed as JSON)
    assert.deepEqual(calls[0].responseBody, { users: [{ id: 1 }] });
  });

  it('emits all finding fields', () => {
    const r = JSON.parse(generateJsonReport(sampleRun));
    assert.equal(r.findings.length, 2);
    const f = r.findings[0];
    assert.equal(f.id, 'LINK-001');
    assert.equal(f.title, 'Broken link');
    assert.equal(f.severity, 'high');
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.category, 'links');
    assert.equal(f.findingType, 'bug');
    assert.equal(f.origin, 'first-party');
    assert.equal(f.ruleId, 'broken-link');
    assert.equal(f.occurrences, 1);
    assert.equal(f.affectedPages.length, 1);
    assert.equal(f.reproSteps.length, 2);
  });

  it('handles a run with no findings / no apiCalls gracefully', () => {
    const empty = { ...sampleRun, findings: [], pages: [], summary: null };
    const r = JSON.parse(generateJsonReport(empty));
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.pages, []);
    // Summary defaults to zeros
    assert.equal(r.summary.totalFindings, 0);
    assert.equal(r.summary.bySeverity.critical, 0);
  });

  it('output is valid JSON (parses cleanly)', () => {
    const json = generateJsonReport(sampleRun);
    assert.doesNotThrow(() => JSON.parse(json));
  });
});

describe('generateHtmlReport (regression)', () => {
  it('still renders HTML with score circle and findings', () => {
    const html = generateHtmlReport(sampleRun);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /Website Quality.*Accessibility Report/);
    assert.match(html, /<circle/);
    assert.match(html, /Broken link/);
    assert.match(html, /Broken anchor/);
    assert.match(html, /78/);  // score
  });

  it('Bug 2 & 3 regression: report HTML and JSON segregate coverage failures and unauthenticated probes', () => {
    const runWithIssues = {
      ...sampleRun,
      summary: null,
      score: 54.3,
      coverage: { pagesAttempted: 5, pagesScanned: 3, coverageRatio: 0.6 },
      coverageFailures: [
        {
          id: 'COV-001',
          title: 'Page load failed: https://example.com/degrees',
          category: 'Scan Coverage',
          findingType: 'coverage-failure',
          ruleId: 'page-load-failure',
          pageUrl: 'https://example.com/degrees',
          description: 'page.goto: Timeout 30000ms exceeded.',
          blockedExecutors: ['accessibility-deep', 'perf'],
        },
      ],
      findings: [
        {
          id: 'LINK-001',
          title: 'Broken link',
          severity: 'high',
          confidence: 'confirmed',
          category: 'links',
          findingType: 'bug',
          pageUrl: 'https://example.com/',
          occurrences: 1,
        },
        {
          id: 'NET-001',
          title: 'API POST /api/replay returned 400',
          severity: 'low',
          confidence: 'suspected',
          category: 'network',
          findingType: 'environmental',
          ruleId: 'api-status-mismatch',
          pageUrl: 'https://example.com/api',
          unauthenticated: true,
          description: 'Probe replayed anonymously - requires session or CSRF token.',
        },
      ],
    };

    const html = generateHtmlReport(runWithIssues);
    // Check coverage failure section
    assert.match(html, /Scan Coverage/);
    assert.match(html, /Timeout 30000ms exceeded/);
    assert.match(html, /accessibility-deep, perf/);

    // Check unauthenticated probe section
    assert.match(html, /Needs manual verification/);
    assert.match(html, /requires session or CSRF token/);

    // Check coverage line displayed directly next to score
    assert.match(html, /3\/5 pages scanned \(60% coverage\)/);

    // Check JSON report
    const json = JSON.parse(generateJsonReport(runWithIssues));
    assert.equal(json.coverage.coverageRatio, 0.6);
    assert.equal(json.coverageFailures.length, 1);
    assert.equal(json.unauthenticatedProbes.length, 1);
    assert.equal(json.summary.totalFindings, 1, 'Only genuine content findings in totalFindings');
  });

  it('Scoring regression: verdict caps label below Excellent when coverage is below 80%', () => {
    // 95 score with 70% coverage
    const v = verdict(95, 0.7);
    assert.notEqual(v.label, 'Excellent');
    assert.equal(v.label, 'Incomplete (Good)');

    // 95 score with 90% coverage
    const vHigh = verdict(95, 0.9);
    assert.equal(vHigh.label, 'Excellent');
  });
});
