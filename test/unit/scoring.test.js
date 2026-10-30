import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScore, summarizeFindings } from '../../src/services/scoring.js';
import { verdict } from '../../src/services/report.js';

describe('Unit Tests: Scoring Logic (No Browser)', () => {
  it('cannot produce a score or verdict label above Excellent when coverage is below 80%, regardless of zero defects', () => {
    // 10 attempted, only 7 scanned = 70% coverage. 0 findings found on the scanned pages.
    const score = calculateScore([], { pagesAttempted: 10, pagesScanned: 7, coverageRatio: 0.7 });

    // Raw score is 100, but coverage ratio 0.7 scales score down to 70
    assert.equal(score, 70, 'Score must be scaled down by coverage ratio (100 * 0.7 = 70)');

    const v = verdict(score, 0.7);
    assert.notEqual(v.label, 'Excellent', 'Verdict label must NOT be Excellent when coverage is < 80%');
    assert.equal(v.label, 'Needs work', 'Score 70 with 70% coverage carries Needs work verdict');

    // Edge case: Even if a hypothetical score calculation produced 95 with 75% coverage
    const vCapped = verdict(95, 0.75);
    assert.notEqual(vCapped.label, 'Excellent', 'Verdict label must cap below Excellent when coverage < 80%');
    assert.equal(vCapped.label, 'Incomplete (Good)');
  });

  it('excludes SUSPECTED findings from score calculation by default', () => {
    const findings = [
      {
        id: 'NET-001',
        title: 'API POST /api/rest returned unexpected status',
        severity: 'high',
        confidence: 'suspected',
        category: 'network',
        findingType: 'environmental',
        ruleId: 'api-status-mismatch',
        pageUrl: 'https://example.com/api',
        unauthenticated: true,
      },
    ];

    // Default excludeUnauthenticated = true
    const defaultScore = calculateScore(findings, { pagesAttempted: 1, pagesScanned: 1 });
    assert.equal(defaultScore, 100, 'Score should remain 100 when suspected unauthenticated probe is excluded');

    // Present in summary as unauthenticated probe
    const summary = summarizeFindings(findings, 1);
    assert.equal(summary.unauthenticatedProbes, 1, 'Suspected probe must be recorded in unauthenticatedProbes');
    assert.equal(summary.totalFindings, 0, 'Suspected probe must not penalize headline totalFindings count');
  });

  it('includes SUSPECTED findings in score deductions when aggressive mode is explicitly requested', () => {
    const findings = [
      {
        id: 'NET-001',
        title: 'API POST /api/rest returned unexpected status',
        severity: 'high',
        confidence: 'suspected',
        category: 'network',
        findingType: 'environmental',
        ruleId: 'api-status-mismatch',
        pageUrl: 'https://example.com/api',
        unauthenticated: true,
      },
    ];

    const aggressiveScore = calculateScore(findings, {
      pagesAttempted: 1,
      pagesScanned: 1,
      excludeUnauthenticated: false,
    });

    assert.ok(aggressiveScore < 100, `Aggressive mode should penalize score, got ${aggressiveScore}`);
  });

  it('correctly applies severity and origin deductions for confirmed content findings', () => {
    // 1 Critical first-party bug (-15 deduction)
    const firstParty = [
      { severity: 'critical', confidence: 'confirmed', findingType: 'bug', origin: 'first-party' },
    ];
    assert.equal(calculateScore(firstParty), 85);

    // 1 Critical third-party bug (0.2 multiplier: 15 * 0.2 = 3 deduction)
    const thirdParty = [
      { severity: 'critical', confidence: 'confirmed', findingType: 'bug', origin: 'third-party' },
    ];
    assert.equal(calculateScore(thirdParty), 97);
  });
});
