/**
 * flowInferrer.js — propose user flows from crawled pages.
 *
 * Strategy:
 *   1. Filter pages down to ones with forms, buttons, or notable API calls.
 *   2. Send the structured summary to the LLM via flowInferencePrompt.
 *   3. Parse the JSON response; normalize to TestPlan Flow[] shape.
 *   4. Drop any flow that fails Zod validation against the Flow schema —
 *      the LLM is allowed to be imperfect; we silently discard bad output
 *      rather than poisoning the plan.
 */
import { chatJson } from './llmProvider.js';
import { flowInferencePrompt } from './prompts.js';
import { TestPlan, arrayElementSchema } from '../services/testPlan.js';

const FlowSchema = arrayElementSchema(TestPlan.shape.flows);

export async function inferFlows({ pages, llmOpts = {} }) {
  if (!pages || pages.length === 0) return [];

  // Only consider pages that have something testable
  const interesting = pages.filter(p =>
    (p.forms && p.forms > 0) ||
    (p.buttons && p.buttons > 0) ||
    (p.inputs && p.inputs > 0) ||
    (p.apiCalls && p.apiCalls.length > 0)
  );

  if (interesting.length === 0) return [];

  const { system, user } = flowInferencePrompt({ pages: interesting });
  const result = await chatJson({ system, user, temperature: 0.3 }, llmOpts);

  if (!result.ok) {
    return {
      flows: [],
      warnings: [`Flow inference failed: ${result.error}`],
    };
  }

  const rawFlows = Array.isArray(result.data?.flows) ? result.data.flows : [];

  // Validate + normalize each flow. Drop invalid ones silently.
  const flows = [];
  const warnings = [];
  for (const raw of rawFlows) {
    const parsed = FlowSchema.safeParse(raw);
    if (parsed.success) {
      flows.push(parsed.data);
    } else {
      const issues = parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      warnings.push(`Dropped invalid flow "${raw?.name || 'unnamed'}": ${issues}`);
    }
  }

  return { flows, warnings };
}
