/**
 * matrix/index.js — public API for the matrix module.
 *
 * Usage:
 *   import { runMatrix, BrowserPool, StateManager } from './src/matrix/index.js';
 *
 *   const stateMgr = new StateManager({ runStep });
 *   const pool = new BrowserPool({ stateManager: stateMgr });
 *   await stateMgr.prime({ plan, browser, viewport });
 *   const { findings, stats } = await runMatrix({ plan, browserPool: pool, createFinding, onEvent });
 *   await pool.shutdown();
 */
import { runStep } from '../executors/e2e.js';
export { runStep } from '../executors/e2e.js';

import { StateManager, captureAuthState, isAuthFlow, resolveAuthRoles } from './stateManager.js';
export { StateManager, captureAuthState, isAuthFlow, resolveAuthRoles };
export { BrowserPool } from './browserPool.js';
export { planMatrix, summarizeMatrix, filterMatrix } from './matrixPlanner.js';
export { runMatrix } from './matrixRunner.js';
export { FlakyTracker, detectFlakyFromRuns, buildRunSummary } from './flakyTracker.js';
export {
  buildInputMatrix,
  estimateMatrixSize,
  groupByForm,
  generatorsForType,
  valuesForGenerator,
} from './inputMatrix.js';

/**
 * Convenience: build a StateManager wired with the e2e runStep.
 */
export function createStateManager(opts = {}) {
  return new StateManager({ runStep, ...opts });
}
