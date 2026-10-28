/**
 * executors/index.js — register all built-in executors.
 *
 * Usage:
 *   import { registerAllExecutors } from './src/executors/index.js';
 *   registerAllExecutors();
 *   // Now 'api-contract', 'security', 'fuzz', 'e2e', 'accessibility-deep',
 *   // 'perf', 'visual' are all available via executorRegistry.
 *
 * Or register individually:
 *   import apiContract from './src/executors/apiContract.js';
 *   registerExecutor('api-contract', apiContract);
 */
import { registerExecutor, hasExecutor } from '../services/executorRegistry.js';
import apiContract from './apiContract.js';
import security from './security.js';
import fuzz from './fuzz.js';
import e2e from './e2e.js';
import a11yDeep from './a11yDeep.js';
import perf from './perf.js';
import visual from './visual.js';

const REGISTRATIONS = [
  ['api-contract',       apiContract,  { description: 'Probe API endpoints + verify status + schema shape' }],
  ['security',           security,     { description: 'Security headers, mixed content, cookie audit' }],
  ['fuzz',               fuzz,         { description: 'Input mutation + boundary testing' }],
  ['e2e',                e2e,          { description: 'Playwright flow runner' }],
  ['accessibility-deep', a11yDeep,     { description: 'axe-core accessibility audit' }],
  ['perf',               perf,         { description: 'CDP performance metrics (LCP/CLS/TBT)' }],
  ['visual',             visual,       { description: 'Visual regression via screenshot pixel-diff' }],
];

export function registerAllExecutors() {
  for (const [name, fn, meta] of REGISTRATIONS) {
    if (!hasExecutor(name)) {
      registerExecutor(name, fn, meta);
    }
  }
}

export {
  apiContract,
  security,
  fuzz,
  e2e,
  a11yDeep,
  perf,
  visual,
  REGISTRATIONS,
};
