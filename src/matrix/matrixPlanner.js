/**
 * matrix/matrixPlanner.js — expand a TestPlan into an execution matrix.
 *
 * Given:
 *   plan.browsers     = ['chromium', 'firefox']
 *   plan.viewports    = [{ name: 'desktop', ... }, { name: 'mobile', ... }]
 *   roles resolved    = ['anon', 'user', 'admin']
 *
 * Produces a list of MatrixCells — one per (browser, viewport, role)
 * combination — each tagged with the executors that should run in it.
 *
 * Executor → cell mapping rules (sensible defaults; overridable via plan):
 *   • api-contract, security, fuzz : no browser needed → run once per role
 *       (different roles see different API surfaces)
 *   • e2e                            : browser + role needed, viewport-independent
 *       (flows target user interactions, not layouts)
 *   • accessibility-deep, perf, visual : browser + viewport + role all needed
 *       (these check layout-dependent issues)
 *
 * The matrix is "full" per the user's "check each and every thing" requirement
 * — every (browser, viewport, role) combination is exercised.
 */

const NO_BROWSER_EXECUTORS = new Set(['api-contract', 'security', 'fuzz']);
const BROWSER_VIEWPORT_EXECUTORS = new Set(['accessibility-deep', 'perf', 'visual']);
const BROWSER_ONLY_EXECUTORS = new Set(['e2e']);

/**
 * Build the execution matrix for a plan.
 *
 * @param {object} plan          — TestPlan with browsers[], viewports[], executors[]
 * @param {string[]} [roles]    — ['anon', 'user', 'admin'] (defaults to ['anon'] + roles from plan.flows)
 * @returns {Array<MatrixCell>}
 *
 * MatrixCell shape:
 *   {
 *     id:         string,          // 'chromium:desktop:user'
 *     browser:    string,
 *     viewport:   object | null,   // null = no browser context
 *     role:       string,
 *     executors:  string[],         // which executors to run in this cell
 *     needsBrowser: boolean,
 *   }
 */
export function planMatrix(plan, roles = null) {
  if (!plan) throw new Error('planMatrix requires a plan');

  const browsers = plan.browsers?.length ? plan.browsers : ['chromium'];
  const viewports = plan.viewports?.length ? plan.viewports : [{ width: 1280, height: 720, name: 'desktop' }];
  const executors = plan.executors?.length ? plan.executors : [];

  // Resolve roles: anon is always present; pull others from auth flows
  const finalRoles = roles || resolveDefaultRoles(plan);

  const cells = [];

  // 1. No-browser executors — run once per role, regardless of browser/viewport
  const noBrowserExecs = executors.filter(e => NO_BROWSER_EXECUTORS.has(e));
  if (noBrowserExecs.length > 0) {
    for (const role of finalRoles) {
      cells.push({
        id: `no-browser::${role}`,
        browser: null,
        viewport: null,
        role,
        executors: noBrowserExecs,
        needsBrowser: false,
      });
    }
  }

  // 2. Browser-only executors — run once per (browser, role), viewport-independent
  const browserOnlyExecs = executors.filter(e => BROWSER_ONLY_EXECUTORS.has(e));
  if (browserOnlyExecs.length > 0) {
    for (const browser of browsers) {
      for (const role of finalRoles) {
        cells.push({
          id: `${browser}::${role}`,
          browser,
          viewport: viewports[0],  // first viewport as default
          role,
          executors: browserOnlyExecs,
          needsBrowser: true,
        });
      }
    }
  }

  // 3. Browser+viewport executors — full matrix
  const fullMatrixExecs = executors.filter(e => BROWSER_VIEWPORT_EXECUTORS.has(e));
  if (fullMatrixExecs.length > 0) {
    for (const browser of browsers) {
      for (const viewport of viewports) {
        for (const role of finalRoles) {
          cells.push({
            id: `${browser}:${viewport.name || 'default'}:${role}`,
            browser,
            viewport,
            role,
            executors: fullMatrixExecs,
            needsBrowser: true,
          });
        }
      }
    }
  }

  return cells;
}

/**
 * Determine the default roles to use: 'anon' is always present.
 * If the plan has auth flows, add their roles too.
 */
function resolveDefaultRoles(plan) {
  const roles = new Set(['anon']);
  for (const flow of plan.flows || []) {
    if (/^(login|signin|authenticate)$/i.test(flow.name || '')) {
      roles.add('user');
    }
    if (/admin/i.test(flow.name || '')) {
      roles.add('admin');
    }
    const roleTag = flow.tags?.find(t => t.startsWith('auth:'));
    if (roleTag) roles.add(roleTag.slice(5));
  }
  return Array.from(roles);
}

/**
 * Summarize a matrix for human review / logging.
 */
export function summarizeMatrix(cells) {
  const summary = {
    totalCells: cells.length,
    byBrowser: {},
    byViewport: {},
    byRole: {},
    byExecutor: {},
    browserCells: cells.filter(c => c.needsBrowser).length,
    noBrowserCells: cells.filter(c => !c.needsBrowser).length,
  };

  for (const cell of cells) {
    if (cell.browser) {
      summary.byBrowser[cell.browser] = (summary.byBrowser[cell.browser] || 0) + 1;
    }
    const vpName = cell.viewport?.name || 'n/a';
    summary.byViewport[vpName] = (summary.byViewport[vpName] || 0) + 1;
    summary.byRole[cell.role] = (summary.byRole[cell.role] || 0) + 1;

    for (const exec of cell.executors) {
      summary.byExecutor[exec] = (summary.byExecutor[exec] || 0) + 1;
    }
  }

  return summary;
}

/**
 * Filter the matrix — useful when the user wants to run only a subset.
 * Returns a new array of cells.
 *
 * Example: filterMatrix(cells, { browsers: ['chromium'], roles: ['user'] })
 */
export function filterMatrix(cells, filter = {}) {
  return cells.filter(cell => {
    if (filter.browsers?.length && cell.browser && !filter.browsers.includes(cell.browser)) {
      return false;
    }
    if (filter.viewports?.length) {
      const vpName = cell.viewport?.name;
      if (vpName && !filter.viewports.includes(vpName)) return false;
    }
    if (filter.roles?.length && !filter.roles.includes(cell.role)) {
      return false;
    }
    if (filter.executors?.length) {
      if (!cell.executors.some(e => filter.executors.includes(e))) return false;
    }
    return true;
  });
}
