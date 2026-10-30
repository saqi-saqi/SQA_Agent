import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from '../fixtures/site/server.js';
import { runMatrix } from '../../src/matrix/matrixRunner.js';
import { BrowserPool } from '../../src/matrix/browserPool.js';
import { clearExecutors } from '../../src/services/executorRegistry.js';
import { registerAllExecutors } from '../../src/executors/index.js';
import { registerLegacyChecks } from '../../src/checks/index.js';
import { createFindingFactory } from '../../src/services/findingFactory.js';
import { calculateScore, summarizeFindings } from '../../src/services/scoring.js';
import { generateHtmlReport, generateJsonReport } from '../../src/services/report.js';
import { validateReport } from '../../src/reporting/invariants.js';
import { capturePerfMetrics } from '../../src/executors/perf.js';
import { dedupFindings } from '../../src/matrix/matrixRunner.js';

describe('Golden Fixture Report Tests (Ground Truth Verification)', () => {
  let fixture = null;
  let browserPool = null;
  const originalTimeout = process.env.SQA_PAGE_TIMEOUT_MS;

  before(async () => {
    // Tighten page timeout for fixture tests so page-timeout fails fast (~1.5s instead of 30s)
    process.env.SQA_PAGE_TIMEOUT_MS = '1500';

    fixture = await startFixtureServer(0);
    browserPool = new BrowserPool();
    registerAllExecutors();
    registerLegacyChecks();
  });

  after(async () => {
    if (originalTimeout !== undefined) {
      process.env.SQA_PAGE_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.SQA_PAGE_TIMEOUT_MS;
    }
    if (browserPool) await browserPool.shutdown().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
    clearExecutors();
  });

  it('runs a full TestFlow scan against the fixture and EXACTLY matches EXPECTED.md', async () => {
    const baseUrl = fixture.url;

    // Build plan matching EXPECTED.md
    const plan = {
      schemaVersion: 1,
      targetUrl: `${baseUrl}/`,
      pages: [
        { url: `${baseUrl}/page-a11y-fail.html`, title: 'A11y Fail 1' },
        { url: `${baseUrl}/page-a11y-fail-2.html`, title: 'A11y Fail 2' },
        { url: `${baseUrl}/page-ok.html`, title: 'Clean Page' },
        { url: `${baseUrl}/page-heavy.html`, title: 'Heavy Page' },
        { url: `${baseUrl}/page-cwv.html`, title: 'CWV Page' },
        { url: `${baseUrl}/page-timeout.html`, title: 'Timeout Page' },
      ],
      apiEndpoints: [
        { method: 'GET', path: '/api/always-400', expectedStatus: 200 },
        { method: 'GET', path: '/api/needs-session', expectedStatus: 200, requiresSession: true },
      ],
      perfBudgets: [
        { metric: 'pageSizeBytes', threshold: 3000000, severity: 'medium' },
      ],
      a11yRules: [
        { rule: 'image-alt', level: 'A' },
      ],
      flows: [],
      fuzzTargets: [],
      visualBaselines: [],
      browsers: ['chromium'],
      viewports: [{ name: 'desktop', width: 1280, height: 720 }],
      executors: ['accessibility-deep', 'perf', 'api-contract'],
    };

    const createFinding = createFindingFactory();
    const matrixResult = await runMatrix({
      plan,
      browserPool,
      createFinding,
      onEvent: () => {},
      options: { dedup: true },
    });

    const pagesAttempted = plan.pages.length;
    const failedUrls = new Set((matrixResult.coverageFailures || []).map(f => f.pageUrl));
    const pagesScanned = Math.max(0, pagesAttempted - failedUrls.size);
    const coverageRatio = pagesAttempted > 0 ? pagesScanned / pagesAttempted : 1.0;

    const scoreOpts = {
      pagesAttempted,
      pagesScanned,
      coverageRatio,
      excludeUnauthenticated: true,
    };

    const score = calculateScore(matrixResult.findings, scoreOpts);
    const summary = summarizeFindings(matrixResult.findings, pagesAttempted, scoreOpts);

    const run = {
      runId: 'golden_fixture_run_001',
      url: `${baseUrl}/`,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      findings: matrixResult.findings,
      coverageFailures: matrixResult.coverageFailures,
      coverage: { pagesAttempted, pagesScanned, coverageRatio },
      score,
      summary,
      pages: plan.pages,
      options: { maxPages: pagesAttempted },
    };

    // 1. Verify coverage percentage: 5 scanned out of 6 attempted = 83.3%
    assert.equal(pagesAttempted, 6);
    assert.equal(pagesScanned, 5);
    assert.ok(Math.abs(coverageRatio - (5 / 6)) < 0.01, `Expected ~83.3% coverage, got ${coverageRatio}`);

    // 2. Verify Confirmed bugs count matches EXPECTED.md:
    // 2 a11y image-alt bugs + 1 always-400 API contract bug = 3 confirmed bugs
    assert.equal(summary.confirmedBugs, 3, 'Confirmed bugs count must be exactly 3');

    // 3. Verify Suspected / Needs verification count matches EXPECTED.md:
    // 1 unauthenticated API replay on /api/needs-session = 1 suspected
    assert.equal(summary.unauthenticatedProbes, 1, 'Suspected unauthenticated probes must be exactly 1');

    // 4. Verify Coverage failures count matches EXPECTED.md:
    // 1 page timeout on /page-timeout.html = 1 coverage failure
    assert.equal(summary.coverageFailures, 1, 'Coverage failures must be exactly 1');

    // 5. Total headline findings count in summary:
    // 4 content findings (3 bugs + 1 perf-budget-pageSizeBytes warning)
    assert.equal(summary.totalFindings, 4, 'Total content findings must be 4');

    // 6. Arithmetic Invariant (The YouTube bug catcher):
    // Confirmed bugs + other content findings + Suspected + Coverage-failures = Total findings shown
    const confirmedFindingsCount = summary.totalFindings; // 4 content findings (all confirmed bugs/warnings)
    const suspectedCount = summary.unauthenticatedProbes; // 1
    const coverageFailuresCount = summary.coverageFailures; // 1
    const totalFindingsShown = confirmedFindingsCount + suspectedCount + coverageFailuresCount;
    assert.equal(totalFindingsShown, 6, 'Total findings shown across all sections must sum to 6');
    assert.equal(
      confirmedFindingsCount + suspectedCount + coverageFailuresCount,
      matrixResult.findings.length,
      'Confirmed + Suspected + Coverage-failures must sum to total displayed findings'
    );

    // 7. Verify JSON and HTML reports format correctly
    const jsonStr = generateJsonReport(run);
    const jsonReport = JSON.parse(jsonStr);
    assert.equal(jsonReport.coverage.pagesAttempted, 6);
    assert.equal(jsonReport.coverage.pagesScanned, 5);
    assert.equal(jsonReport.coverageFailures.length, 1);
    assert.equal(jsonReport.unauthenticatedProbes.length, 1);
    assert.equal(jsonReport.summary.confirmedBugs, 3);

    const htmlReport = generateHtmlReport(run);
    assert.match(htmlReport, /Scan Coverage \(1 page\(s\) failed to load\)/);
    assert.match(htmlReport, /Needs manual verification \(1 unauthenticated probe results?\)/);
    assert.match(htmlReport, /5\/6 pages scanned/);

    // 8. Invariant validation must pass cleanly without error
    const validation = validateReport(run, { throwOnError: true });
    assert.equal(validation.valid, true);
  });

  it('asserts identical a11y violations on page-a11y-fail.html and page-a11y-fail-2.html are NOT merged across pages', async () => {
    const baseUrl = fixture.url;
    const plan = {
      schemaVersion: 1,
      targetUrl: `${baseUrl}/`,
      pages: [
        { url: `${baseUrl}/page-a11y-fail.html`, title: 'A11y Fail 1' },
        { url: `${baseUrl}/page-a11y-fail-2.html`, title: 'A11y Fail 2' },
      ],
      apiEndpoints: [],
      perfBudgets: [],
      a11yRules: [{ rule: 'image-alt', level: 'A' }],
      flows: [],
      fuzzTargets: [],
      visualBaselines: [],
      browsers: ['chromium'],
      viewports: [{ name: 'desktop', width: 1280, height: 720 }],
      executors: ['accessibility-deep'],
    };

    const createFinding = createFindingFactory();
    const result = await runMatrix({
      plan,
      browserPool,
      createFinding,
      options: { dedup: true },
    });

    const a11yFindings = result.findings.filter(f => f.ruleId === 'axe-image-alt');
    assert.equal(a11yFindings.length, 2, 'Identical violation on different pages must produce 2 distinct findings');

    const urls = a11yFindings.map(f => f.pageUrl);
    assert.ok(urls.some(u => u.includes('page-a11y-fail.html')), 'Must include page-a11y-fail.html');
    assert.ok(urls.some(u => u.includes('page-a11y-fail-2.html')), 'Must include page-a11y-fail-2.html');
  });

  it('asserts running the SAME scan twice in a row on the SAME page produces a non-duplicated result (determinism check)', async () => {
    const baseUrl = fixture.url;
    const pageUrl = `${baseUrl}/page-a11y-fail.html`;

    const createFinding = createFindingFactory();
    // Simulate two findings from different matrix runs or cells for the exact same page and selector
    const f1 = createFinding({
      title: 'a11y: Images must have alternate text (image-alt)',
      severity: 'critical',
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      ruleId: 'axe-image-alt',
      pageUrl,
      selector: '#violating-hero-img',
      occurrences: 1,
      matrixCell: { cellId: 'chromium:desktop:anon' },
    });

    const f2 = createFinding({
      title: 'a11y: Images must have alternate text (image-alt)',
      severity: 'critical',
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      ruleId: 'axe-image-alt',
      pageUrl,
      selector: '#violating-hero-img',
      occurrences: 1,
      matrixCell: { cellId: 'chromium:mobile:anon' },
    });

    const merged = dedupFindings([f1, f2]);
    assert.equal(merged.length, 1, 'Duplicate findings on the same page must merge into exactly 1');
    assert.equal(merged[0].occurrences, 2, 'Occurrences must be summed to 2');
    assert.equal(merged[0].pageUrl, pageUrl);
  });

  it('asserts page-ok.html alone produces zero findings and a 100 score', async () => {
    const baseUrl = fixture.url;
    const plan = {
      schemaVersion: 1,
      targetUrl: `${baseUrl}/`,
      pages: [
        { url: `${baseUrl}/page-ok.html`, title: 'Clean Page' },
      ],
      apiEndpoints: [],
      perfBudgets: [
        { metric: 'pageSizeBytes', threshold: 3000000, severity: 'medium' },
      ],
      a11yRules: [{ rule: 'image-alt', level: 'A' }],
      flows: [],
      fuzzTargets: [],
      visualBaselines: [],
      browsers: ['chromium'],
      viewports: [{ name: 'desktop', width: 1280, height: 720 }],
      executors: ['accessibility-deep', 'perf'],
    };

    const createFinding = createFindingFactory();
    const result = await runMatrix({
      plan,
      browserPool,
      createFinding,
      options: { dedup: true },
    });

    assert.equal(result.findings.length, 0, 'Clean page must produce 0 findings');
    const score = calculateScore(result.findings, { pagesAttempted: 1, pagesScanned: 1, coverageRatio: 1.0 });
    assert.equal(score, 100, 'Clean page must produce a perfect 100 score');
  });

  it('asserts page-timeout.html produces exactly one coverage-failure entry, not one per executor', async () => {
    const baseUrl = fixture.url;
    const plan = {
      schemaVersion: 1,
      targetUrl: `${baseUrl}/`,
      pages: [
        { url: `${baseUrl}/page-timeout.html`, title: 'Timeout Page' },
      ],
      apiEndpoints: [],
      perfBudgets: [
        { metric: 'pageSizeBytes', threshold: 3000000, severity: 'medium' },
      ],
      a11yRules: [{ rule: 'image-alt', level: 'A' }],
      flows: [],
      fuzzTargets: [],
      visualBaselines: [],
      browsers: ['chromium'],
      viewports: [{ name: 'desktop', width: 1280, height: 720 }],
      executors: ['accessibility-deep', 'perf'], // multiple executors touch the timed-out page
    };

    const createFinding = createFindingFactory();
    const result = await runMatrix({
      plan,
      browserPool,
      createFinding,
      options: { dedup: true },
    });

    assert.equal(result.coverageFailures.length, 1, 'Must produce exactly 1 coverage failure entry');
    const cov = result.coverageFailures[0];
    assert.equal(cov.ruleId, 'page-load-failure');
    assert.equal(cov.category, 'Scan Coverage');
    assert.equal(cov.findingType, 'coverage-failure');
    assert.ok(cov.blockedExecutors.includes('accessibility-deep'));
  });

  it('asserts always-400 endpoint is CONFIRMED bug and needs-session endpoint is SUSPECTED', async () => {
    const baseUrl = fixture.url;
    const plan = {
      schemaVersion: 1,
      targetUrl: `${baseUrl}/`,
      pages: [],
      apiEndpoints: [
        { method: 'GET', path: '/api/always-400', expectedStatus: 200 },
        { method: 'GET', path: '/api/needs-session', expectedStatus: 200, requiresSession: true },
      ],
      perfBudgets: [],
      a11yRules: [],
      flows: [],
      fuzzTargets: [],
      visualBaselines: [],
      browsers: [],
      viewports: [],
      executors: ['api-contract'],
    };

    const createFinding = createFindingFactory();
    const result = await runMatrix({
      plan,
      browserPool: null,
      createFinding,
      options: { dedup: true },
    });

    const always400Finding = result.findings.find(f => f.pageUrl?.includes('/api/always-400'));
    assert.ok(always400Finding, 'Finding for always-400 must exist');
    assert.equal(always400Finding.confidence, 'confirmed', 'always-400 must be CONFIRMED');
    assert.equal(always400Finding.findingType, 'bug', 'always-400 must be categorized as a bug');
    assert.equal(always400Finding.unauthenticated, false, 'always-400 must NOT be marked unauthenticated');

    const needsSessionFinding = result.findings.find(f => f.pageUrl?.includes('/api/needs-session'));
    assert.ok(needsSessionFinding, 'Finding for needs-session must exist');
    assert.equal(needsSessionFinding.confidence, 'suspected', 'needs-session must be SUSPECTED');
    assert.equal(needsSessionFinding.findingType, 'environmental', 'needs-session must be categorized as environmental');
    assert.equal(needsSessionFinding.unauthenticated, true, 'needs-session must be marked unauthenticated: true');
  });

  it('asserts every Core Web Vital on page-cwv.html is a real measured number (> 0), never a bare 0', async () => {
    const baseUrl = fixture.url;
    const ctx = await browserPool.createContext({
      browserName: 'chromium',
      viewport: { width: 1280, height: 720 },
      role: 'anon',
    });

    const page = await ctx.newPage();
    try {
      const { metrics } = await capturePerfMetrics(page, `${baseUrl}/page-cwv.html`, { settleMs: 1200 });

      // Core Web Vitals checks
      assert.ok(typeof metrics.LCP === 'number' && metrics.LCP > 0, `LCP must be > 0, got ${metrics.LCP}`);
      assert.ok(typeof metrics.FCP === 'number' && metrics.FCP > 0, `FCP must be > 0, got ${metrics.FCP}`);
      assert.ok(typeof metrics.TTFB === 'number' && metrics.TTFB > 0, `TTFB must be > 0, got ${metrics.TTFB}`);
      assert.ok(typeof metrics.CLS === 'number' && metrics.CLS >= 0, `CLS must be >= 0, got ${metrics.CLS}`);
      assert.ok(typeof metrics.TBT === 'number' && metrics.TBT >= 0, `TBT must be >= 0, got ${metrics.TBT}`);

      // Crucial: none of the "always measured" fields may be a bare 0
      assert.notEqual(metrics.LCP, 0, 'LCP cannot be bare 0');
      assert.notEqual(metrics.FCP, 0, 'FCP cannot be bare 0');
      assert.notEqual(metrics.TTFB, 0, 'TTFB cannot be bare 0');
    } finally {
      await page.close().catch(() => {});
      await browserPool.releaseContext(ctx);
    }
  });
});
