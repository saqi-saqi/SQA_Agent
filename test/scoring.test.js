import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScore, summarizeFindings } from '../src/services/scoring.js';
import { verdict } from '../src/services/report.js';

describe('calculateScore', () => {
  it('returns 100 for no findings', () => {
    assert.equal(calculateScore([]), 100);
    assert.equal(calculateScore(null), 100);
    assert.equal(calculateScore(undefined), 100);
  });

  it('deducts 15 for a single confirmed critical bug', () => {
    const findings = [{ severity: 'critical', confidence: 'confirmed', findingType: 'bug', origin: 'first-party' }];
    assert.equal(calculateScore(findings), 85);
  });

  it('deducts less for high-confidence vs confirmed', () => {
    const confirmed = [{ severity: 'critical', confidence: 'confirmed', findingType: 'bug' }];
    const high = [{ severity: 'critical', confidence: 'high', findingType: 'bug' }];
    assert.equal(calculateScore(confirmed), 85);    // 15 * 1.0
    assert.equal(calculateScore(high), 89.5);       // 15 * 0.7
  });

  it('deducts 0 for low-confidence findings', () => {
    const findings = [{ severity: 'critical', confidence: 'low', findingType: 'bug' }];
    assert.equal(calculateScore(findings), 100);
  });

  it('applies findingType multiplier (recommendation = 0.1x)', () => {
    const findings = [{ severity: 'high', confidence: 'confirmed', findingType: 'recommendation' }];
    // base 8 * conf 1.0 * type 0.1 = 0.8 deduction
    assert.equal(calculateScore(findings), 99.2);
  });

  it('applies 0.2x multiplier for third-party origin', () => {
    const first = [{ severity: 'high', confidence: 'confirmed', findingType: 'bug', origin: 'first-party' }];
    const third = [{ severity: 'high', confidence: 'confirmed', findingType: 'bug', origin: 'third-party' }];
    assert.equal(calculateScore(first), 92);     // 100 - 8
    assert.equal(calculateScore(third), 98.4);    // 100 - 8*0.2
  });

  it('treats unknown origin as first-party (1.0x)', () => {
    const findings = [{ severity: 'high', confidence: 'confirmed', findingType: 'bug', origin: null }];
    assert.equal(calculateScore(findings), 92);
  });

  it('clamps at 0 when deductions exceed 100', () => {
    const findings = Array(10).fill({ severity: 'critical', confidence: 'confirmed', findingType: 'bug' });
    // 10 * 15 = 150 deduction
    assert.equal(calculateScore(findings), 0);
  });

  it('clamps at 100 (negative deduction)', () => {
    const findings = [{ severity: 'info', confidence: 'confirmed', findingType: 'informational' }];
    assert.equal(calculateScore(findings), 100);
  });

  it('sums multiple findings of mixed severity', () => {
    const findings = [
      { severity: 'critical', confidence: 'confirmed', findingType: 'bug' },   // -15
      { severity: 'high',     confidence: 'confirmed', findingType: 'bug' },   // -8
      { severity: 'medium',   confidence: 'high',     findingType: 'bug' },   // -4*0.7 = -2.8
    ];
    // 100 - 25.8 = 74.2
    assert.equal(calculateScore(findings), 74.2);
  });

  it('handles legacy confidence aliases', () => {
    const probable = [{ severity: 'high', confidence: 'probable', findingType: 'bug' }];
    const suspected = [{ severity: 'high', confidence: 'suspected', findingType: 'bug' }];
    assert.equal(calculateScore(probable), 94.4);   // 8 * 0.7 = 5.6
    assert.equal(calculateScore(suspected), 97.6);   // 8 * 0.3 = 2.4
  });
});

describe('summarizeFindings', () => {
  it('returns zero-summary for empty input', () => {
    const s = summarizeFindings([], 5);
    assert.equal(s.totalPages, 5);
    assert.equal(s.totalFindings, 0);
    assert.equal(s.totalOccurrences, 0);
    assert.equal(s.confirmedBugs, 0);
    assert.deepEqual(s.bySeverity, { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
    assert.deepEqual(s.byConfidence, { confirmed: 0, high: 0, medium: 0, low: 0 });
    assert.deepEqual(s.byOrigin, { 'first-party': 0, 'third-party': 0, unknown: 0 });
  });

  it('accepts pages array instead of count', () => {
    const s = summarizeFindings([], [{}, {}, {}, {}]);
    assert.equal(s.totalPages, 4);
  });

  it('counts findings across all dimensions', () => {
    const findings = [
      { severity: 'critical', confidence: 'confirmed', findingType: 'bug', origin: 'first-party', category: 'links', occurrences: 3 },
      { severity: 'high',     confidence: 'high',     findingType: 'bug', origin: 'third-party', category: 'network', occurrences: 1 },
      { severity: 'medium',   confidence: 'medium',   findingType: 'warning', origin: null, category: 'seo' },
      { severity: 'low',      confidence: 'low',      findingType: 'recommendation', origin: 'first-party', category: 'seo' },
      { severity: 'info',     confidence: 'confirmed', findingType: 'informational', origin: 'first-party', category: 'performance' },
    ];
    const s = summarizeFindings(findings, 10);

    assert.equal(s.totalFindings, 5);
    assert.equal(s.totalOccurrences, 3 + 1 + 1 + 1 + 1); // 7
    assert.equal(s.bySeverity.critical, 1);
    assert.equal(s.bySeverity.high, 1);
    assert.equal(s.bySeverity.medium, 1);
    assert.equal(s.bySeverity.low, 1);
    assert.equal(s.bySeverity.info, 1);
    assert.equal(s.byCategory.links, 1);
    assert.equal(s.byCategory.network, 1);
    assert.equal(s.byCategory.seo, 2);
    assert.equal(s.byConfidence.confirmed, 2);
    assert.equal(s.byConfidence.high, 1);
    assert.equal(s.byConfidence.medium, 1);
    assert.equal(s.byConfidence.low, 1);
    assert.equal(s.byFindingType.bug, 2);
    assert.equal(s.byFindingType.warning, 1);
    assert.equal(s.byFindingType.recommendation, 1);
    assert.equal(s.byFindingType.informational, 1);
    assert.equal(s.byOrigin['first-party'], 3);
    assert.equal(s.byOrigin['third-party'], 1);
    assert.equal(s.byOrigin.unknown, 1);
    assert.equal(s.confirmedBugs, 1);
    assert.equal(s.observationCount, 1);
    assert.equal(s.recommendationCount, 1);
  });

  it('counts confirmedBugs only when confidence=confirmed AND findingType=bug', () => {
    const findings = [
      { severity: 'high', confidence: 'confirmed', findingType: 'warning' },     // no
      { severity: 'high', confidence: 'high',     findingType: 'bug' },          // no (high not confirmed)
      { severity: 'high', confidence: 'confirmed', findingType: 'bug' },         // yes
    ];
    const s = summarizeFindings(findings, 1);
    assert.equal(s.confirmedBugs, 1);
  });

  it('Bug 3 regression: excludes SUSPECTED unauthenticated finding from score calculation and top-level findings count', () => {
    const findings = [
      {
        id: 'NET-001',
        title: 'API POST /api/rest/v1/eventing/infobatch returned unexpected status',
        severity: 'low',
        confidence: 'suspected',
        category: 'network',
        findingType: 'environmental',
        ruleId: 'api-status-mismatch',
        pageUrl: 'https://example.com/api',
        unauthenticated: true,
        description: 'Expected status 200 but got 400. The probe replayed a captured POST request anonymously - the endpoint may simply require a session or CSRF token.',
      },
    ];

    // Score with unauthenticated excluded (default: true)
    const score = calculateScore(findings);
    assert.equal(score, 100, 'Score should be 100 when unauthenticated finding is excluded');

    // Summary excludes from totalFindings and confirmedBugs
    const summary = summarizeFindings(findings, 1);
    assert.equal(summary.totalFindings, 0, 'Unauthenticated probe must NOT count toward headline totalFindings');
    assert.equal(summary.confirmedBugs, 0, 'Unauthenticated probe must NOT count toward confirmedBugs');
    assert.equal(summary.unauthenticatedProbes, 1, 'Should record in unauthenticatedProbes');

    // Aggressive mode: score when unauthenticated is NOT excluded
    const aggressiveScore = calculateScore(findings, { excludeUnauthenticated: false });
    assert.ok(aggressiveScore < 100, 'Score should deduct when aggressive mode is enabled');
  });

  it('Scoring regression: 60% page coverage with zero findings does NOT produce a 90+ Excellent score', () => {
    // 5 attempted, 3 scanned = 60% coverage, 0 findings on the pages that did load
    const score = calculateScore([], { pagesAttempted: 5, pagesScanned: 3 });
    assert.ok(score <= 60, `Expected score <= 60, got ${score}`);
    assert.ok(score < 90, 'Score must NOT be 90+');

    const v = verdict(score, 3 / 5);
    assert.notEqual(v.label, 'Excellent', 'Verdict label must NOT be Excellent for 60% coverage');
  });
});
