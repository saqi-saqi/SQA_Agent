/**
 * checks/index.js — Register qagent legacy checks as SQA executors.
 *
 * Each check module has a slightly different signature. This file adapts
 * each one to the executor ctx interface via wrapLegacyCheck() or custom
 * registration so they participate in matrix runs alongside the built-in
 * Phase-1 executors (api-contract, security, fuzz, e2e, visual, perf, a11y-deep).
 *
 * Usage:
 *   import { registerLegacyChecks } from './src/checks/index.js';
 *   registerLegacyChecks();
 */
import { registerExecutor, hasExecutor } from '../services/executorRegistry.js';
import { checkLinks } from '../services/checks/links.js';
import { checkConsole } from '../services/checks/console.js';
import { checkNetwork } from '../services/checks/network.js';
import { checkAccessibility } from '../services/checks/accessibility.js';
import { checkSeo } from '../services/checks/seo.js';
import { checkPerformance } from '../services/checks/performance.js';
import { checkWorkflows } from '../services/checks/workflows.js';

/**
 * Adapt each legacy check to the executor ctx interface.
 *
 * Legacy signatures vary:
 *   checkLinks(pages, createFinding, onEvent, signal, siteOrigin)
 *   checkConsole(pages, createFinding, onEvent, siteOrigin)
 *   checkNetwork(pages, createFinding, onEvent, siteOrigin)
 *   checkAccessibility(pages, createFinding, onEvent, screenshotsDir, runId, signal)
 *   checkSeo(pages, createFinding, onEvent, screenshotsDir, runId, signal)
 *   checkPerformance(pages, createFinding, onEvent, screenshotsDir, runId, signal)
 *   checkWorkflows(context, workflows, createFinding, onEvent, screenshotsDir, runId, signal)
 */

const LEGACY_CHECKS = [
  {
    name: 'legacy-links',
    description: 'Broken link checker (HEAD/GET with retry)',
    fn: async (ctx) => {
      const findings = await checkLinks(
        ctx.pages, ctx.createFinding, ctx.onEvent,
        ctx.signal, ctx.siteOrigin,
      );
      return { findings: findings || [] };
    },
  },
  {
    name: 'legacy-console',
    description: 'Console error/exception analysis',
    fn: async (ctx) => {
      const findings = await checkConsole(
        ctx.pages, ctx.createFinding, ctx.onEvent,
        ctx.siteOrigin,
      );
      return { findings: findings || [] };
    },
  },
  {
    name: 'legacy-network',
    description: 'Network failure classification',
    fn: async (ctx) => {
      const findings = await checkNetwork(
        ctx.pages, ctx.createFinding, ctx.onEvent,
        ctx.siteOrigin,
      );
      return { findings: findings || [] };
    },
  },
  {
    name: 'legacy-accessibility',
    description: 'axe-core accessibility audit',
    fn: async (ctx) => {
      const findings = await checkAccessibility(
        ctx.pages, ctx.createFinding, ctx.onEvent,
        ctx.screenshotsDir, ctx.runId, ctx.signal,
      );
      return { findings: findings || [] };
    },
  },
  {
    name: 'legacy-seo',
    description: 'SEO and quality checks',
    fn: async (ctx) => {
      const findings = await checkSeo(
        ctx.pages, ctx.createFinding, ctx.onEvent,
        ctx.screenshotsDir, ctx.runId, ctx.signal,
      );
      return { findings: findings || [] };
    },
  },
  {
    name: 'legacy-performance',
    description: 'Performance metrics and large resource detection',
    fn: async (ctx) => {
      const findings = await checkPerformance(
        ctx.pages, ctx.createFinding, ctx.onEvent,
        ctx.screenshotsDir, ctx.runId, ctx.signal,
      );
      return { findings: findings || [] };
    },
  },
  {
    name: 'legacy-workflows',
    description: 'User-authored Playwright workflow assertions',
    fn: async (ctx) => {
      // Workflows need a BrowserContext and workflow definitions
      if (!ctx.context || !ctx.options?.workflows?.length) {
        return { findings: [] };
      }
      const result = await checkWorkflows(
        ctx.context, ctx.options.workflows, ctx.createFinding,
        ctx.onEvent, ctx.screenshotsDir, ctx.runId, ctx.signal,
      );
      return { findings: result.findings || [], stats: { results: result.results } };
    },
  },
];

/**
 * Register all legacy checks as executors.
 * Safe to call multiple times — skips already-registered names.
 */
export function registerLegacyChecks() {
  for (const { name, description, fn } of LEGACY_CHECKS) {
    if (!hasExecutor(name)) {
      registerExecutor(name, fn, { description, legacy: true, version: '1.0.0' });
    }
  }
}

export { LEGACY_CHECKS };
