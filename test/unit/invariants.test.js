import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport } from '../../src/reporting/invariants.js';

describe('Unit Tests: validateReport Invariant Checks', () => {
  const validReport = {
    runId: 'valid_run_001',
    score: 85,
    coverage: {
      pagesAttempted: 5,
      pagesScanned: 5,
      coverageRatio: 1.0,
    },
    findings: [
      {
        id: 'A11Y-001',
        title: 'Missing alt',
        severity: 'critical',
        confidence: 'confirmed',
        category: 'accessibility',
        findingType: 'bug',
        ruleId: 'axe-image-alt',
        selector: '#img1',
        pageUrl: 'https://example.com/p1',
      },
      {
        id: 'NET-001',
        title: '500 Server Error',
        severity: 'high',
        confidence: 'confirmed',
        category: 'network',
        findingType: 'bug',
        ruleId: 'api-status-mismatch',
        selector: '',
        pageUrl: 'https://example.com/api',
      },
      {
        id: 'NET-002',
        title: 'Needs session',
        severity: 'low',
        confidence: 'suspected',
        category: 'network',
        findingType: 'environmental',
        ruleId: 'api-status-mismatch',
        selector: '',
        pageUrl: 'https://example.com/session-api',
        unauthenticated: true,
      },
      {
        id: 'COV-001',
        title: 'Page timeout',
        severity: 'info',
        confidence: 'high',
        category: 'Scan Coverage',
        findingType: 'coverage-failure',
        ruleId: 'page-load-failure',
        selector: '',
        pageUrl: 'https://example.com/timeout',
      },
    ],
    summary: {
      confirmedBugs: 2,
      unauthenticatedProbes: 1,
      coverageFailures: 1,
      totalFindingsShown: 4,
    },
  };

  it('passes on a valid, structurally consistent report', () => {
    const result = validateReport(validReport, { throwOnError: true });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('catches Confirmed-bugs counter mismatch (YouTube bug regression)', () => {
    // Deliberately corrupt confirmedBugs counter
    const brokenReport = {
      ...validReport,
      summary: {
        ...validReport.summary,
        confirmedBugs: 5, // actual is 2!
      },
    };

    assert.throws(
      () => validateReport(brokenReport, { throwOnError: true }),
      /Confirmed-bugs counter mismatch/
    );

    const check = validateReport(brokenReport, { throwOnError: false });
    assert.equal(check.valid, false);
    assert.ok(check.errors.some(e => e.includes('Confirmed-bugs counter mismatch')));
  });

  it('catches Findings sum mismatch (Confirmed + Suspected + Coverage !== total shown)', () => {
    const brokenReport = {
      ...validReport,
      summary: {
        ...validReport.summary,
        totalFindingsShown: 10, // actual sum is 2 + 1 + 1 = 4!
      },
    };

    const check = validateReport(brokenReport, { throwOnError: false });
    assert.equal(check.valid, false);
    assert.ok(check.errors.some(e => e.includes('Findings sum mismatch')));
  });

  it('catches Quality label violation when coverage is <80% but verdict carries top Excellent label', () => {
    const brokenReport = {
      ...validReport,
      score: 95, // Score 95 would normally be Excellent
      coverage: {
        pagesAttempted: 10,
        pagesScanned: 6,
        coverageRatio: 0.6, // 60% coverage
      },
      // verdict label should be capped, not Excellent
      verdict: { label: 'Excellent' },
    };

    const check = validateReport(brokenReport, { coverageThreshold: 0.8, throwOnError: false });
    assert.equal(check.valid, false);
    assert.ok(check.errors.some(e => e.includes('Quality label violation')));
  });

  it('catches silent-zero metric violation when always-measured metric is bare 0 without explicit flag', () => {
    const brokenReport = {
      ...validReport,
      findings: [
        {
          id: 'PERF-001',
          title: 'Perf issue',
          ruleId: 'perf-lcp',
          selector: 'main',
          pageUrl: 'https://example.com/',
          metrics: {
            LCP: 0, // Bare 0 without measured: false!
            FCP: 120,
            TTFB: 30,
          },
        },
      ],
    };

    const check = validateReport(brokenReport, { throwOnError: false });
    assert.equal(check.valid, false);
    assert.ok(check.errors.some(e => e.includes('Silent-zero metric violation') && e.includes('LCP')));
  });

  it('allows 0 in metrics if explicit measured:false flag is provided or for legitimately zeroable metrics like CLS', () => {
    const validWithFlagsReport = {
      ...validReport,
      findings: [
        {
          id: 'PERF-001',
          title: 'Perf issue',
          ruleId: 'perf-lcp',
          selector: 'main',
          pageUrl: 'https://example.com/',
          metrics: {
            LCP: 0,
            CLS: 0, // CLS = 0 is legitimate
            FCP: 120,
            TTFB: 30,
            measured: { LCP: false, CLS: true, FCP: true, TTFB: true }, // Explicit flag
          },
        },
      ],
      summary: {
        confirmedBugs: 0,
        unauthenticatedProbes: 0,
        coverageFailures: 0,
        totalFindingsShown: 0,
      },
    };

    const check = validateReport(validWithFlagsReport, { throwOnError: false });
    assert.equal(check.valid, true);
    assert.equal(check.errors.length, 0);
  });

  it('catches duplicate findings sharing identical (ruleId, selector, url) within same report', () => {
    const brokenReport = {
      ...validReport,
      findings: [
        {
          id: 'A11Y-001',
          ruleId: 'axe-image-alt',
          selector: 'img#hero',
          pageUrl: 'https://example.com/about',
          confidence: 'confirmed',
          findingType: 'bug',
        },
        {
          id: 'A11Y-002', // Duplicate!
          ruleId: 'axe-image-alt',
          selector: 'img#hero',
          pageUrl: 'https://example.com/about',
          confidence: 'confirmed',
          findingType: 'bug',
        },
      ],
      summary: {
        confirmedBugs: 2,
        unauthenticatedProbes: 0,
        coverageFailures: 0,
        totalFindingsShown: 2,
      },
    };

    const check = validateReport(brokenReport, { throwOnError: false });
    assert.equal(check.valid, false);
    assert.ok(check.errors.some(e => e.includes('Duplicate finding violation')));
  });
});
