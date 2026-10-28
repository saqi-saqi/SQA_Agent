/**
 * executorRegistry.js — pluggable executor interface.
 *
 * An "executor" is a named function that consumes a slice of a TestPlan
 * and emits findings. Existing check_* modules (links, console, network,
 * accessibility, seo, performance, workflows) will be wrapped as legacy
 * executors so the runManager doesn't change.
 *
 * Executor signature (async):
 *
 *   async function myExecutor(ctx) -> { findings: Finding[], stats?: object }
 *
 * ctx shape:
 *   {
 *     plan:        TestPlan,                 // approved plan
 *     pages:       PageResult[],             // from crawler
 *     context:     BrowserContext,           // Playwright (for live executors)
 *     createFinding: (opts) => Finding,
 *     onEvent:     (msg) => void,            // SSE progress
 *     signal:      AbortSignal,
 *     screenshotsDir: string,
 *     runId:       string,
 *     options:     { ... per-executor config }
 *   }
 *
 * Phase 0 ships the registry + helpers. Phase 1+ wires concrete executors.
 */

const registry = new Map();

/**
 * Register an executor.
 * @param {string} name — unique key (e.g. 'e2e', 'api-contract', 'visual', 'fuzz')
 * @param {(ctx) => Promise<{findings: object[], stats?: object}>} fn
 * @param {object} [meta] — optional metadata (description, version)
 */
export function registerExecutor(name, fn, meta = {}) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Executor name must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new Error(`Executor "${name}" must be a function`);
  }
  if (registry.has(name)) {
    throw new Error(`Executor "${name}" already registered`);
  }
  registry.set(name, { fn, meta: { version: '1.0.0', ...meta } });
}

/** Get an executor by name. Returns undefined if missing. */
export function getExecutor(name) {
  return registry.get(name)?.fn;
}

/** Get executor metadata. */
export function getExecutorMeta(name) {
  return registry.get(name)?.meta;
}

/** List registered executors with metadata. */
export function listExecutors() {
  return Array.from(registry.entries()).map(([name, entry]) => ({
    name,
    ...entry.meta,
  }));
}

/** True if an executor is registered. */
export function hasExecutor(name) {
  return registry.has(name);
}

/** Remove an executor (mainly for tests). */
export function unregisterExecutor(name) {
  return registry.delete(name);
}

/** Clear all executors (mainly for tests). */
export function clearExecutors() {
  registry.clear();
}

/**
 * Run a single executor by name.
 * @param {string} name
 * @param {object} ctx
 * @returns {Promise<{findings: object[], stats?: object}>}
 */
export async function runExecutor(name, ctx) {
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(`Unknown executor: "${name}". Did you forget to register it?`);
  }
  // Defensive — every executor must return { findings } or be a no-op
  const result = await entry.fn(ctx);
  if (!result || !Array.isArray(result.findings)) {
    throw new Error(`Executor "${name}" did not return { findings: [] }`);
  }
  return result;
}

/**
 * Run all executors listed in a TestPlan (plan.executors) sequentially.
 * Honors an abort signal. Returns aggregated findings + per-executor stats.
 *
 * @param {object} ctx — must include `plan` and `signal`
 * @returns {Promise<{ findings: object[], stats: { name: string, durationMs: number, findingCount: number, error?: string }[] }>}
 */
export async function runAllExecutors(ctx) {
  const { plan, signal } = ctx;
  const names = (plan?.executors) || [];

  const allFindings = [];
  const stats = [];

  for (const name of names) {
    if (signal?.aborted) {
      stats.push({ name, durationMs: 0, findingCount: 0, error: 'aborted' });
      break;
    }
    const start = Date.now();
    try {
      const result = await runExecutor(name, { ...ctx, signal });
      allFindings.push(...result.findings);
      stats.push({
        name,
        durationMs: Date.now() - start,
        findingCount: result.findings.length,
        ...(result.stats ? { stats: result.stats } : {}),
      });
    } catch (err) {
      stats.push({
        name,
        durationMs: Date.now() - start,
        findingCount: 0,
        error: err.message,
      });
      // Don't abort the whole run on one executor failure — record + continue.
    }
  }

  return { findings: allFindings, stats };
}

/**
 * Wrap an existing legacy check_* function as an executor.
 *
 * Legacy check signature:
 *   async function checkFoo(pages, createFinding, onEvent, screenshotsDir, runId, signal)
 *
 * Returns an executor fn that adapts ctx → legacy call.
 */
export function wrapLegacyCheck(name, legacyFn) {
  const executor = async (ctx) => {
    const findings = await legacyFn(
      ctx.pages,
      ctx.createFinding,
      ctx.onEvent,
      ctx.screenshotsDir,
      ctx.runId,
      ctx.signal,
      ...(Object.values(ctx.options || {})),  // passes any extra args
    );
    return { findings: findings || [] };
  };
  registerExecutor(name, executor, { legacy: true });
  return executor;
}
