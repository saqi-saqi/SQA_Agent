import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { startFixtureServer } from '../fixtures/site/server.js';
import { runAxeOnPage, axeResultsToFindings } from '../../src/executors/a11yDeep.js';
import { computeCompliance, AXE_RULE_WCAG_MAP } from '../../src/services/compliance.js';
import { createFindingFactory } from '../../src/services/findingFactory.js';

describe('Differential Tests: Raw axe-core vs TestFlow WCAG Layer (axeDiff)', () => {
  let fixture = null;
  let browser = null;

  before(async () => {
    fixture = await startFixtureServer(0);
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
  });

  const testPages = [
    { name: 'page-a11y-fail.html', expectedViolationCount: 1, expectedRules: ['image-alt'] },
    { name: 'page-a11y-fail-2.html', expectedViolationCount: 1, expectedRules: ['image-alt'] },
    { name: 'page-ok.html', expectedViolationCount: 0, expectedRules: [] },
  ];

  for (const { name, expectedViolationCount, expectedRules } of testPages) {
    it(`diffs raw axe-core against TestFlow WCAG layer on ${name} without dropping or recategorizing violations`, async () => {
      const pageUrl = `${fixture.url}/${name}`;
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(pageUrl, { waitUntil: 'load' });

        // 1. Run raw axe-core directly via @axe-core/playwright
        const rawResults = await new AxeBuilder({ page }).analyze();
        const rawViolations = rawResults.violations || [];
        const rawRuleIds = rawViolations.map(v => v.id).sort();

        // Verify raw axe meets expectations
        assert.equal(
          rawViolations.length,
          expectedViolationCount,
          `Raw axe-core expected ${expectedViolationCount} violation(s) on ${name}, got ${rawViolations.length}`
        );
        assert.deepEqual(rawRuleIds, expectedRules.slice().sort());

        // 2. Separately run TestFlow's own accessibility layer against the same page
        const tfRawResults = await runAxeOnPage(page, []);
        const createFinding = createFindingFactory();
        const tfFindings = axeResultsToFindings(tfRawResults, pageUrl, createFinding);
        const compliance = computeCompliance({ findings: tfFindings });

        const tfRuleIds = tfFindings
          .map(f => f.ruleId.replace(/^axe-/, ''))
          .sort();

        // 3. Differential assertion: TestFlow must NOT drop any violation reported by raw axe-core
        const droppedRules = rawRuleIds.filter(ruleId => !tfRuleIds.includes(ruleId));
        assert.equal(
          droppedRules.length,
          0,
          `TestFlow silently dropped axe-core violation(s): [${droppedRules.join(', ')}] on ${name}`
        );

        // 4. TestFlow must not fabricate phantom violations not reported by raw axe-core
        const extraRules = tfRuleIds.filter(ruleId => !rawRuleIds.includes(ruleId));
        assert.equal(
          extraRules.length,
          0,
          `TestFlow reported phantom violation(s) not in raw axe-core: [${extraRules.join(', ')}] on ${name}`
        );

        // 5. Verify rule-to-WCAG compliance layer fidelity
        if (expectedRules.length > 0) {
          for (const ruleId of expectedRules) {
            const mapping = AXE_RULE_WCAG_MAP[ruleId];
            assert.ok(mapping, `Rule '${ruleId}' must be registered in AXE_RULE_WCAG_MAP`);

            if (mapping.criterion) {
              const criterionRecord = compliance.criteria.find(c => c.criterion === mapping.criterion);
              assert.ok(criterionRecord, `WCAG criterion ${mapping.criterion} must be tracked in compliance`);
              assert.equal(criterionRecord.status, 'fail', `WCAG criterion ${mapping.criterion} must be marked 'fail'`);
              assert.ok(
                criterionRecord.occurrences > 0,
                `WCAG criterion ${mapping.criterion} must record >0 occurrences`
              );
            }
          }
        } else {
          // Clean page: 100% conformance, no blockers
          assert.equal(compliance.conformancePct, 100);
          assert.equal(compliance.blockers.length, 0);
          assert.equal(compliance.violatedCount, 0);
        }
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    });
  }

  it('fails loudly if a simulated compliance mapping silently drops a raw axe violation', () => {
    const rawViolations = [{ id: 'image-alt', impact: 'critical' }];
    const fakeTestFlowFindings = []; // Simulated buggy mapper dropping the finding

    const rawRules = rawViolations.map(v => v.id);
    const tfRules = fakeTestFlowFindings.map(f => f.ruleId);

    const dropped = rawRules.filter(r => !tfRules.includes(r));
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0], 'image-alt');
  });
});
