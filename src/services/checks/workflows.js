import path from 'node:path';

const ACTION_LABELS = {
  click: 'Click', fill: 'Fill', assertText: 'Assert text', assertVisible: 'Assert visible', assertUrl: 'Assert URL', waitFor: 'Wait for'
};

/** Executes user-authored, black-box workflow assertions on an isolated page. */
export async function checkWorkflows(context, workflows, createFinding, onEvent, screenshotDir, runId, signal) {
  const findings = [];
  const results = [];
  for (const workflow of workflows || []) {
    if (signal?.aborted) break;
    const page = await context.newPage();
    let currentStep = null;
    const startedAt = Date.now();
    try {
      onEvent?.(`Running workflow: ${workflow.name}`);
      await page.goto(workflow.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (let index = 0; index < workflow.steps.length; index++) {
        if (signal?.aborted) break;
        currentStep = workflow.steps[index];
        const locator = currentStep.selector ? page.locator(currentStep.selector) : null;
        switch (currentStep.action) {
          case 'click': await locator.click({ timeout: currentStep.timeoutMs || 10000 }); break;
          case 'fill': await locator.fill(currentStep.value || '', { timeout: currentStep.timeoutMs || 10000 }); break;
          case 'assertText': await locator.filter({ hasText: currentStep.value || '' }).first().waitFor({ state: 'visible', timeout: currentStep.timeoutMs || 10000 }); break;
          case 'assertVisible': await locator.waitFor({ state: 'visible', timeout: currentStep.timeoutMs || 10000 }); break;
          case 'assertUrl': await page.waitForURL(currentStep.value, { timeout: currentStep.timeoutMs || 10000 }); break;
          case 'waitFor': await page.waitForTimeout(Math.min(Number(currentStep.timeoutMs || 500), 5000)); break;
          default: throw new Error(`Unsupported workflow action: ${currentStep.action}`);
        }
      }
      results.push({
        name: workflow.name, status: 'passed', startUrl: workflow.startUrl, finalUrl: page.url(),
        durationMs: Date.now() - startedAt,
        // Values may contain credentials; persisted reports intentionally retain
        // action metadata only.
        steps: workflow.steps.map(step => ({ action: step.action, selector: step.selector || null }))
      });
    } catch (error) {
      const screenshotName = `workflow-${runId}-${findings.length}.png`;
      let screenshot = null;
      try {
        await page.screenshot({ path: path.join(screenshotDir, screenshotName), fullPage: false, timeout: 3000 });
        screenshot = `/screenshots/${screenshotName}`;
      } catch { /* evidence remains limited to observed step error */ }
      const stepNumber = Math.max(1, workflow.steps.indexOf(currentStep) + 1);
      findings.push(createFinding({
        title: `Workflow failed: ${workflow.name}`,
        severity: 'high', confidence: 'confirmed', category: 'workflow', findingType: 'bug', origin: 'first-party',
        ruleId: `workflow-${workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`,
        pageUrl: page.url() || workflow.startUrl,
        description: `The workflow assertion failed at step ${stepNumber}: ${ACTION_LABELS[currentStep?.action] || 'Action'}.`,
        evidence: [`Workflow: ${workflow.name}`, `Start URL: ${workflow.startUrl}`, `Observed URL: ${page.url()}`, `Step ${stepNumber}: ${JSON.stringify(currentStep)}`, `Playwright error: ${error.message}`].join('\n'),
        screenshot,
        reproSteps: [`Open ${workflow.startUrl}`, ...workflow.steps.slice(0, stepNumber).map((step, i) => `${i + 1}. ${ACTION_LABELS[step.action] || step.action}${step.selector ? ` ${step.selector}` : ''}${step.value ? ` (${step.value})` : ''}`)],
        suggestedFix: 'Inspect the failing workflow step and the attached browser evidence; confirm the intended UI state and selector before changing application behavior.'
      }));
      results.push({ name: workflow.name, status: 'failed', startUrl: workflow.startUrl, finalUrl: page.url(), durationMs: Date.now() - startedAt, failedStep: Math.max(1, workflow.steps.indexOf(currentStep) + 1) });
    } finally {
      await page.close().catch(() => {});
    }
  }
  return { findings, results };
}
