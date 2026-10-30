import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFindings } from '../../src/services/scoring.js';

describe('Unit Tests: Aggregation Logic (No Browser)', () => {
  it('Bug regression (YouTube): produces Confirmed-bugs count matching ONLY genuine CONFIRMED bugs', () => {
    const findings = [
      // 1. Confirmed Bug
      {
        id: 'A11Y-001',
        title: 'Broken link',
        severity: 'high',
        confidence: 'confirmed',
        category: 'accessibility',
        findingType: 'bug',
        ruleId: 'axe-image-alt',
        pageUrl: 'https://example.com/page-1',
        occurrences: 1,
      },
      // 2. Another Confirmed Bug
      {
        id: 'NET-001',
        title: 'API POST 500 error',
        severity: 'critical',
        confidence: 'confirmed',
        category: 'network',
        findingType: 'bug',
        ruleId: 'api-status-mismatch',
        pageUrl: 'https://example.com/api',
        occurrences: 1,
      },
      // 3. Suspected unauthenticated probe (environmental, confidence: suspected)
      {
        id: 'NET-002',
        title: 'API GET /profile 401 Unauthorized',
        severity: 'low',
        confidence: 'suspected',
        category: 'network',
        findingType: 'environmental',
        ruleId: 'api-status-mismatch',
        pageUrl: 'https://example.com/api/profile',
        unauthenticated: true,
        occurrences: 1,
      },
      // 4. Coverage Failure (infrastructure issue, not a content defect)
      {
        id: 'COV-001',
        title: 'Page load failed: timeout',
        severity: 'info',
        confidence: 'high',
        category: 'Scan Coverage',
        findingType: 'coverage-failure',
        ruleId: 'page-load-failure',
        pageUrl: 'https://example.com/timeout',
        occurrences: 1,
      },
      // 5. Confirmed Warning (not a bug)
      {
        id: 'PERF-001',
        title: 'Slow page load',
        severity: 'medium',
        confidence: 'confirmed',
        category: 'performance',
        findingType: 'warning',
        ruleId: 'slow-page-load',
        pageUrl: 'https://example.com/slow',
        occurrences: 1,
      },
    ];

    const summary = summarizeFindings(findings, 3);

    // Confirmed bugs counter MUST match only items 1 and 2 (confirmed + bug)
    assert.equal(
      summary.confirmedBugs,
      2,
      'confirmedBugs must equal 2 (only confirmed bug findings, excluding suspected, coverage failures, and warnings)'
    );

    // Suspected probes counter MUST match item 3
    assert.equal(summary.unauthenticatedProbes, 1, 'unauthenticatedProbes must equal 1');

    // Coverage failures counter MUST match item 4
    assert.equal(summary.coverageFailures, 1, 'coverageFailures must equal 1');

    // Total content findings: items 1, 2, 5 (confirmed bugs + warnings)
    assert.equal(summary.totalFindings, 3, 'totalFindings headline must only include genuine content findings (3)');

    // Occurrence count for warnings
    assert.equal(summary.observationCount, 1, 'observationCount must match warnings (1)');

    // Mathematical identity: Confirmed bugs (2) + other content findings (1) + Suspected (1) + Coverage-failures (1) = 5
    const totalFindingsShown = summary.totalFindings + summary.unauthenticatedProbes + summary.coverageFailures;
    assert.equal(totalFindingsShown, findings.length, 'Sum of all categories must equal total findings fed into aggregator');
  });

  it('aggregates severities, categories, and confidences correctly across mixed finding list', () => {
    const findings = [
      { severity: 'critical', confidence: 'confirmed', category: 'network', findingType: 'bug' },
      { severity: 'high', confidence: 'confirmed', category: 'accessibility', findingType: 'bug' },
      { severity: 'low', confidence: 'suspected', category: 'network', findingType: 'environmental', unauthenticated: true },
      { severity: 'info', confidence: 'high', category: 'Scan Coverage', findingType: 'coverage-failure', ruleId: 'page-load-failure' },
    ];

    const summary = summarizeFindings(findings, 2);

    assert.equal(summary.bySeverity.critical, 1);
    assert.equal(summary.bySeverity.high, 1);
    assert.equal(summary.bySeverity.low, 1);
    assert.equal(summary.bySeverity.info, 1);

    assert.equal(summary.byCategory.network, 2);
    assert.equal(summary.byCategory.accessibility, 1);
    assert.equal(summary.byCategory['Scan Coverage'], 1);
  });

  it('returns clean baseline summary for empty findings list', () => {
    const summary = summarizeFindings([], 5);

    assert.equal(summary.totalPages, 5);
    assert.equal(summary.totalFindings, 0);
    assert.equal(summary.confirmedBugs, 0);
    assert.equal(summary.coverageFailures, 0);
    assert.equal(summary.unauthenticatedProbes, 0);
    assert.equal(summary.score, 100);
  });
});
