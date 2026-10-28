/**
 * executors/e2e.js — Playwright-driven flow runner.
 *
 * Consumes: plan.flows[]
 * Produces: findings when a flow's assertions fail or a step throws
 *
 * The step dispatcher (`runStep`) is the unit-testable core: it accepts a
 * `page` object with the standard Playwright Locator API and dispatches
 * each step action. Tests inject a MockPage that records calls and
 * controls assertion outcomes.
 *
 * The full executor wraps runFlow in retries (per flow.retry) and emits
 * findings on failure.
 */

const STEP_TIMEOUT_DEFAULT_MS = 5000;

// ─── step dispatcher ─────────────────────────────────────────────────

/**
 * Run a single flow step against a Playwright-like page.
 *
 * @param {object} step  — { action, selector, value, ... }
 * @param {object} page  — Playwright Page (or mock)
 * @returns {Promise<void>} — throws on assertion failure or step error
 */
export async function runStep(step, page) {
  const selector = step.selector;
  const timeout = step.timeoutMs || STEP_TIMEOUT_DEFAULT_MS;

  switch (step.action) {
    case 'navigate': {
      const url = step.value || selector;
      if (!url) throw new Error('navigate requires a url (in value or selector)');
      await page.goto(url, { timeout });
      return;
    }
    case 'click': {
      await page.locator(selector).click({ timeout });
      return;
    }
    case 'fill': {
      await page.locator(selector).fill(step.value ?? '', { timeout });
      return;
    }
    case 'select': {
      await page.locator(selector).selectOption(step.value ?? '', { timeout });
      return;
    }
    case 'check': {
      await page.locator(selector).check({ timeout });
      return;
    }
    case 'uncheck': {
      await page.locator(selector).uncheck({ timeout });
      return;
    }
    case 'hover': {
      await page.locator(selector).hover({ timeout });
      return;
    }
    case 'focus': {
      await page.locator(selector).focus({ timeout });
      return;
    }
    case 'press': {
      // step.value is the key to press (e.g. 'Enter')
      await page.locator(selector).press(step.value, { timeout });
      return;
    }
    case 'upload': {
      // step.value is a file path
      await page.locator(selector).setInputFiles(step.value, { timeout });
      return;
    }
    case 'wait': {
      if (step.ms) {
        await page.waitForTimeout(step.ms);
      } else if (selector) {
        await page.locator(selector).waitFor({ state: step.state || 'visible', timeout });
      } else {
        // Bare wait — default 1s
        await page.waitForTimeout(1000);
      }
      return;
    }
    case 'assertVisible': {
      await page.locator(selector).waitFor({ state: 'visible', timeout });
      return;
    }
    case 'assertHidden': {
      await page.locator(selector).waitFor({ state: 'hidden', timeout });
      return;
    }
    case 'assertText': {
      const text = await page.locator(selector).textContent({ timeout });
      if (step.equals != null && text !== step.equals) {
        throw new Error(`assertText failed: expected "${step.equals}" but got "${text}"`);
      }
      if (step.contains != null && !String(text).includes(step.contains)) {
        throw new Error(`assertText failed: text "${text}" does not contain "${step.contains}"`);
      }
      return;
    }
    case 'assertUrl': {
      const currentUrl = page.url();
      if (step.url && currentUrl !== step.url) {
        throw new Error(`assertUrl failed: expected "${step.url}" but got "${currentUrl}"`);
      }
      if (step.urlMatches) {
        const re = new RegExp(step.urlMatches);
        if (!re.test(currentUrl)) {
          throw new Error(`assertUrl failed: "${currentUrl}" does not match /${step.urlMatches}/`);
        }
      }
      if (step.urlContains && !currentUrl.includes(step.urlContains)) {
        throw new Error(`assertUrl failed: "${currentUrl}" does not contain "${step.urlContains}"`);
      }
      return;
    }
    case 'assertStatus': {
      // status assertion requires capturing the navigation response — caller
      // should wire up a response listener. For now, throw if page.lastStatus
      // doesn't match (mock pages can set this).
      const lastStatus = page.lastStatus;
      if (lastStatus == null) {
        throw new Error('assertStatus requires page.lastStatus to be tracked — not supported in this context');
      }
      if (lastStatus !== step.status) {
        throw new Error(`assertStatus failed: expected ${step.status} but got ${lastStatus}`);
      }
      return;
    }
    default: {
      throw new Error(`Unknown flow step action: ${step.action}`);
    }
  }
}

// ─── flow runner with retry ──────────────────────────────────────────

/**
 * Run a single flow with retry policy. Returns { ok, attempts, lastError }.
 *
 * On step failure, retries from step 0 (not from the failing step) —
 * this matches typical E2E test behavior and catches flakiness from
 * earlier setup steps.
 */
export async function runFlow(flow, page, options = {}) {
  const retry = flow.retry || { maxAttempts: 2, backoffMs: 500 };
  const maxAttempts = retry.maxAttempts || 2;
  const backoffMs = retry.backoffMs || 500;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Start at the flow's startUrl
      await page.goto(flow.startUrl, { timeout: options.pageTimeoutMs || 30000 });

      for (const step of flow.steps) {
        await runStep(step, page);
      }
      return { ok: true, attempts: attempt, lastError: null };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  return { ok: false, attempts: maxAttempts, lastError };
}

// ─── main executor ───────────────────────────────────────────────────

/**
 * Main executor — runs every flow in plan.flows[].
 *
 * Requires ctx.context (Playwright BrowserContext). If absent, the executor
 * returns 0 findings with a warning so tests can verify the no-op path.
 */
export default async function e2eExecutor(ctx) {
  const flows = ctx.plan?.flows || [];

  if (!ctx.context) {
    ctx.onEvent?.('e2e skipped — no Playwright context available');
    return { findings: [], stats: { skipped: true, reason: 'no-browser-context' } };
  }

  const findings = [];
  const stats = { ran: 0, passed: 0, failed: 0, skipped: 0 };

  ctx.onEvent?.(`Running ${flows.length} E2E flows`);

  for (const flow of flows) {
    if (ctx.signal?.aborted) {
      stats.skipped++;
      continue;
    }

    // Pick a viewport for this flow if specified
    const viewport = flow.viewport || ctx.plan.viewports?.[0] || { width: 1280, height: 720 };

    const page = await ctx.context.newPage({ viewport });
    stats.ran++;

    try {
      const result = await runFlow(flow, page, { pageTimeoutMs: 30000 });

      if (result.ok) {
        stats.passed++;
      } else {
        stats.failed++;
        const errMsg = result.lastError?.message || String(result.lastError);
        // A locator timeout means the flow's element never appeared — the test
        // script itself couldn't run (selector drift, bot wall), which is a
        // test-authoring issue, not a confirmed site bug.
        const isSelectorTimeout = /Timeout \d+ms exceeded/i.test(errMsg) && /waiting for locator/i.test(errMsg);

        if (isSelectorTimeout) {
          findings.push(ctx.createFinding({
            title: `E2E flow could not run: ${flow.name}`,
            severity: 'medium',
            confidence: 'suspected',
            category: 'network',
            findingType: 'environmental',
            origin: 'first-party',
            ruleId: 'e2e-flow-selector-timeout',
            pageUrl: flow.startUrl,
            description: `Flow "${flow.name}" stopped after ${result.attempts} attempt(s): ${errMsg.split('\n')[0]}. The flow's selector didn't match anything on the page in time — usually selector drift or automation blocking, not a site bug.`,
            evidence: `Start URL: ${flow.startUrl}\nSteps: ${flow.steps.length}\nLast error: ${errMsg}`,
            reproSteps: [
              `Navigate to ${flow.startUrl}`,
              ...flow.steps.map((s, i) => `${i + 1}. ${s.action} ${s.selector || s.value || ''}`.trim()),
            ],
            suggestedFix: 'Update the flow selector to match the current page markup, or re-run with a corrected plan. If the element genuinely disappeared from the page, treat it as a regression.',
          }));
        } else {
          findings.push(ctx.createFinding({
            title: `E2E flow failed: ${flow.name}`,
            severity: 'high',
            confidence: 'confirmed',
            category: 'network',
            findingType: 'bug',
            origin: 'first-party',
            ruleId: 'e2e-flow-failure',
            pageUrl: flow.startUrl,
            description: `Flow "${flow.name}" failed after ${result.attempts} attempt(s): ${errMsg}`,
            evidence: `Start URL: ${flow.startUrl}\nSteps: ${flow.steps.length}\nLast error: ${result.lastError.stack || errMsg}`,
            reproSteps: [
              `Navigate to ${flow.startUrl}`,
              ...flow.steps.map((s, i) => `${i + 1}. ${s.action} ${s.selector || s.value || ''}`.trim()),
            ],
            suggestedFix: 'Investigate the failing step — likely a selector change, race condition, or genuine regression.',
          }));
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`e2e complete: ${stats.passed}/${stats.ran} passed, ${stats.failed} failed`);
  return { findings, stats };
}
