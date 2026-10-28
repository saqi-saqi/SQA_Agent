/**
 * explorer/index.js — orchestrator.
 *
 * Pipeline:
 *   crawl result (pages)
 *     → inferA11yRules / inferPerfBudgets / inferViewports  (heuristic, parallel)
 *     → inferFlows                  (LLM)
 *     → inferApiEndpoints           (LLM, uses apiCalls captured by crawler)
 *     → inferFuzzTargets            (heuristic, depends on flows + endpoints)
 *     → inferVisualBaselines        (heuristic, depends on viewports)
 *     → assemble TestPlan (status: proposed)
 *     → optional: ask LLM for a human-readable summary + risk prioritization
 *
 * The returned plan is ready for human approval. Approving it transitions
 * the plan to 'approved' via transitionStatus(); the run manager then
 * picks it up and runs executors against it.
 */
import { randomUUID } from 'node:crypto';
import { TestPlan, transitionStatus } from '../services/testPlan.js';
import { inferFlows } from './flowInferrer.js';
import { inferApiEndpoints } from './apiInferrer.js';
import { inferFuzzTargets } from './fuzzInferrer.js';
import { inferA11yRules } from './a11yInferrer.js';
import { inferPerfBudgets } from './perfInferrer.js';
import { inferVisualBaselines, inferViewports } from './visualInferrer.js';
import { chatJson, getDefaultProvider } from './llmProvider.js';
import { pageSummaryPrompt, riskPrioritizationPrompt } from './prompts.js';

/**
 * Build a proposed TestPlan from a crawl result.
 *
 * @param {object} input
 * @param {Array}  input.pages        - crawler.js output (must include apiCalls)
 * @param {string} input.targetUrl     - the URL the crawl started from
 * @param {string} input.siteOrigin    - origin (e.g. https://example.com)
 * @param {object} [input.llmOpts]     - passed to chatJson (e.g. { provider })
 * @param {object} [input.options]     - extra knobs (summary, riskPriority)
 * @returns {Promise<{ plan: object, warnings: string[], rawLlm: object }>}
 */
export async function buildTestPlan({ pages, targetUrl, siteOrigin, llmOpts = {}, options = {} }) {
  if (!pages || pages.length === 0) {
    throw new Error('Cannot build a test plan from an empty crawl');
  }
  if (!targetUrl) {
    throw new Error('targetUrl is required');
  }

  const warnings = [];
  const rawLlm = {};

  // ─── heuristic inferrers (parallel) ────────────────────────────────
  const viewports = inferViewports({ pages });

  const [a11yRules, perfBudgets, visualBaselines] = await Promise.all([
    Promise.resolve(inferA11yRules({ pages })),
    Promise.resolve(inferPerfBudgets({ pages })),
    Promise.resolve(inferVisualBaselines({ pages, viewports })),
  ]);

  // ─── LLM-driven inferrers (sequential, both depend on pages) ───────
  const flowResult = await inferFlows({ pages, llmOpts });
  const flows = flowResult.flows || [];
  if (flowResult.warnings) warnings.push(...flowResult.warnings);
  rawLlm.flows = flowResult.raw || null;

  const apiResult = await inferApiEndpoints({ pages, siteOrigin, llmOpts });
  const endpoints = apiResult.endpoints || [];
  if (apiResult.warnings) warnings.push(...apiResult.warnings);
  rawLlm.api = apiResult.raw || null;

  // ─── derived (depends on flows + endpoints) ────────────────────────
  const fuzzTargets = inferFuzzTargets({ pages, endpoints });

  // ─── assemble plan ─────────────────────────────────────────────────
  const planId = `plan_${Date.now()}_${randomUUID().slice(0, 8)}`;

  // Optional: human-readable summary from LLM
  let notes = '';
  const provider = llmOpts.provider || getDefaultProvider();

  if (options.summary !== false) {
    const { system, user } = pageSummaryPrompt({ pages });
    // Plain-text response (not JSON) — call provider.chat directly with json:false
    const summaryRes = await provider.chat({ system, user, json: false, temperature: 0.2 }).catch(() => null);
    if (summaryRes?.ok && summaryRes.content) {
      notes = summaryRes.content;
      rawLlm.summary = notes;
    } else {
      warnings.push('Summary generation failed — leaving notes empty.');
    }
  }

  // Optional: risk prioritization
  if (options.riskPriority !== false && (flows.length || endpoints.length || fuzzTargets.length)) {
    const { system, user } = riskPrioritizationPrompt({ flows, endpoints, fuzzTargets });
    const riskRes = await provider.chat({ system, user, json: false, temperature: 0.2 }).catch(() => null);
    if (riskRes?.ok && riskRes.content) {
      const riskText = riskRes.content;
      rawLlm.risk = riskText;
      notes = notes
        ? `${notes}\n\n## Risk Prioritization\n\n${riskText}`
        : `## Risk Prioritization\n\n${riskText}`;
    }
  }

  // ─── assemble + validate ───────────────────────────────────────────
  const rawPlan = {
    schemaVersion: 1,
    id: planId,
    targetUrl,
    generatedAt: new Date().toISOString(),
    generatedBy: 'sqa-agent-explorer',
    status: 'proposed',
    notes,
    pages: pages.map(p => ({
      url: p.url,
      label: p.title || undefined,
      expectedStatus: p.status || undefined,
      expectedTitle: p.title || undefined,
      viewport: viewports[0],
      expectedElements: [],
      forbiddenText: [],
    })),
    flows,
    apiEndpoints: endpoints,
    fuzzTargets,
    a11yRules,
    perfBudgets,
    visualBaselines,
    viewports,
    browsers: ['chromium'],
    executors: [
      'e2e',
      'api-contract',
      'fuzz',
      'accessibility-deep',
      'perf',
      'visual',
    ],
  };

  // Final validation — this is the safety net. If anything slipped past
  // the per-section validators, this throws.
  const validated = TestPlan.parse(rawPlan);

  return {
    plan: validated,
    warnings,
    rawLlm,
  };
}

/**
 * Approve a proposed plan — convenience wrapper around transitionStatus.
 * Returns a plan with status 'approved' (immutable update).
 */
export function approvePlan(plan) {
  return transitionStatus(plan, 'approved');
}

/**
 * Reject a proposed plan — useful in the approval UI.
 * Keeps the plan in 'draft' state (caller can decide whether to delete).
 */
export function rejectPlan(plan, reason = '') {
  return {
    ...plan,
    status: 'draft',
    notes: plan.notes
      ? `${plan.notes}\n\n[Rejected: ${reason}]`
      : `[Rejected: ${reason}]`,
  };
}

/**
 * Inspect a plan — returns a human-readable brief for the approval UI.
 * No LLM call; pure derivation.
 */
export function summarizePlan(plan) {
  return {
    id: plan.id,
    status: plan.status,
    targetUrl: plan.targetUrl,
    counts: {
      pages: plan.pages.length,
      flows: plan.flows.length,
      apiEndpoints: plan.apiEndpoints.length,
      fuzzTargets: plan.fuzzTargets.length,
      a11yRules: plan.a11yRules.length,
      perfBudgets: plan.perfBudgets.length,
      visualBaselines: plan.visualBaselines.length,
      viewports: plan.viewports.length,
      browsers: plan.browsers.length,
      executors: plan.executors.length,
    },
    flowNames: plan.flows.map(f => f.name),
    endpointBriefs: plan.apiEndpoints.map(e => `${e.method} ${e.path}`),
    notes: plan.notes,
  };
}
