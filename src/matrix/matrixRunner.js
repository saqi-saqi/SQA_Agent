/**
 * matrix/matrixRunner.js — run executors across the execution matrix.
 *
 * For each MatrixCell:
 *   1. Get a BrowserContext from BrowserPool (browser, viewport, role)
 *   2. Build a per-cell executor context with the right plan slice
 *   3. Run each executor in cell.executors via runExecutor()
 *   4. Tag findings with cell metadata (browser, viewport, role)
 *   5. Aggregate + dedup findings across cells
 *
 * Dedup strategy: findings with the same ruleId + pageUrl are merged —
 * occurrences + affectedPages are unioned; severity kept at the worst.
 *
 * Concurrency: `runMatrix()` runs cells sequentially by default. Pass
 * `options.concurrency` (e.g. 2 or 4) to run multiple cells in parallel via
 * `runMatrixConcurrently()`. Browser-bound cells are gated by the
 * BrowserPool's internal limit (one context per browser at a time by default).
 */

import { runExecutor, hasExecutor } from '../services/executorRegistry.js';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function worstSeverity(a, b) {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Build a per-cell executor context.
 * The plan is sliced so each executor sees only the rows it needs.
 * (Executors that don't care about viewport/role see the same plan.)
 */
function buildCellContext(cell, baseCtx) {
  const cellCtx = {
    ...baseCtx,
    plan: baseCtx.plan,  // executors read plan.* arrays themselves
    options: { ...baseCtx.options },
    // Cell-specific metadata — executors can read this for tagging
    matrixCell: {
      browser: cell.browser,
      viewport: cell.viewport,
      role: cell.role,
      cellId: cell.id,
    },
  };

  // Provide a wrapped createFinding that tags findings with cell metadata
  const innerCreateFinding = baseCtx.createFinding;
  cellCtx.createFinding = (opts) => {
    const finding = innerCreateFinding(opts);
    finding.matrixCell = cellCtx.matrixCell;
    // Add cell info to affectedPages if not already there
    const cellTag = `[${cell.browser || 'no-browser'}|${cell.viewport?.name || 'n/a'}|${cell.role}]`;
    if (finding.pageUrl && !finding.pageUrl.includes(cellTag)) {
      // We don't modify pageUrl — that should stay clean. Add as separate field.
      finding.context = cellTag;
    }
    return finding;
  };

  return cellCtx;
}

/**
 * Run a single matrix cell — execute each of cell.executors in turn.
 * Returns { findings, stats }.
 */
async function runCell(cell, baseCtx) {
  let context = null;
  const cellFindings = [];
  const cellStats = { cellId: cell.id, executors: [] };

  try {
    if (cell.needsBrowser && baseCtx.browserPool) {
      context = await baseCtx.browserPool.createContext({
        browserName: cell.browser,
        viewport: cell.viewport,
        role: cell.role,
      });
    }

    const cellCtx = buildCellContext(cell, baseCtx);
    if (context) cellCtx.context = context;

    for (const executorName of cell.executors) {
      if (baseCtx.signal?.aborted) {
        cellStats.executors.push({ name: executorName, status: 'aborted' });
        break;
      }
      if (!hasExecutor(executorName)) {
        cellStats.executors.push({ name: executorName, status: 'missing' });
        continue;
      }

      const start = Date.now();
      try {
        const result = await runExecutor(executorName, cellCtx);
        cellFindings.push(...(result.findings || []));
        cellStats.executors.push({
          name: executorName,
          status: 'ok',
          durationMs: Date.now() - start,
          findingCount: (result.findings || []).length,
        });
      } catch (err) {
        cellStats.executors.push({
          name: executorName,
          status: 'error',
          error: err.message,
          durationMs: Date.now() - start,
        });
      }
    }
  } finally {
    if (context && baseCtx.browserPool) {
      await baseCtx.browserPool.releaseContext(context);
    }
  }

  return { findings: cellFindings, stats: cellStats };
}

/**
 * Dedup findings across cells. Same ruleId + pageUrl → merge into one finding.
 * - occurrences: sum across cells
 * - affectedPages: union
 * - severity: worst
 * - matrixCells: list of cell IDs where observed
 */
function dedupFindings(findings) {
  const merged = new Map();

  for (const finding of findings) {
    const key = `${finding.ruleId || 'gen'}::${finding.pageUrl || ''}`;
    if (!merged.has(key)) {
      merged.set(key, {
        ...finding,
        occurrences: finding.occurrences || 1,
        affectedPages: new Set(finding.affectedPages || (finding.pageUrl ? [finding.pageUrl] : [])),
        matrixCells: new Set(finding.matrixCell?.cellId ? [finding.matrixCell.cellId] : []),
      });
    } else {
      const existing = merged.get(key);
      existing.occurrences += finding.occurrences || 1;
      for (const p of (finding.affectedPages || [])) existing.affectedPages.add(p);
      if (finding.pageUrl) existing.affectedPages.add(finding.pageUrl);
      if (finding.matrixCell?.cellId) existing.matrixCells.add(finding.matrixCell.cellId);
      existing.severity = worstSeverity(existing.severity, finding.severity);
      // Don't lose non-empty evidence/description
      if (!existing.description && finding.description) existing.description = finding.description;
      if (!existing.evidence && finding.evidence) existing.evidence = finding.evidence;
    }
  }

  // Convert Sets to arrays for serialization
  return Array.from(merged.values()).map(f => ({
    ...f,
    affectedPages: Array.from(f.affectedPages),
    matrixCells: Array.from(f.matrixCells),
  }));
}

/**
 * Main matrix runner entry.
 *
 * @param {object} input
 * @param {object} input.plan       — approved TestPlan
 * @param {Array}  [input.cells]    — pre-computed matrix (else computed from plan)
 * @param {object} input.browserPool — BrowserPool instance (or null for no-browser tests)
 * @param {object} input.createFinding — finding factory
 * @param {object} input.onEvent   — SSE progress
 * @param {object} [input.signal]  — AbortSignal
 * @param {object} [input.options] — { concurrency, dedup, screenshotsDir, runId, roles }
 * @returns {Promise<{ findings, stats }>}
 *
 * Concurrency:
 *   • options.concurrency = 1 (default): run cells sequentially via runCell()
 *   • options.concurrency > 1: run cells in parallel via runMatrixConcurrently()
 */
export async function runMatrix({
  plan,
  cells,
  browserPool,
  createFinding,
  onEvent,
  signal,
  options = {},
}) {
  const { dedup = true, concurrency = 1 } = options;

  if (!cells) {
    const { planMatrix } = await import('./matrixPlanner.js');
    cells = planMatrix(plan);
  }

  onEvent?.(`Running matrix of ${cells.length} cells (concurrency=${concurrency})`);

  const baseCtx = {
    plan,
    browserPool,
    createFinding,
    onEvent,
    signal,
    options: {},
    screenshotsDir: options.screenshotsDir || '/tmp/screenshots',
    runId: options.runId || `run_${Date.now()}`,
  };

  const matrixStart = Date.now();
  let allFindings = [];
  const allStats = {
    totalCells: cells.length,
    completedCells: 0,
    failedCells: 0,
    cells: [],
    totalDurationMs: 0,
    concurrency,
  };

  if (concurrency > 1) {
    const result = await runMatrixConcurrently(cells, baseCtx, concurrency, signal, onEvent);
    allFindings = result.findings;
    allStats.cells = result.cellStats;
    // A cell "succeeded" if it ran without throwing (even if some inner executors errored).
    // A cell "failed" if runCell itself threw (rare — usually executor errors are caught inside).
    allStats.completedCells = result.cellStats.filter(c => c.status !== 'error' && c.status !== 'aborted').length;
    allStats.failedCells = result.cellStats.filter(c => c.status === 'error').length;
  } else {
    for (const cell of cells) {
      if (signal?.aborted) {
        allStats.cells.push({ cellId: cell.id, status: 'aborted' });
        break;
      }
      onEvent?.(`Matrix cell: ${cell.id}`);
      try {
        const { findings, stats } = await runCell(cell, baseCtx);
        allFindings.push(...findings);
        allStats.completedCells++;
        allStats.cells.push(stats);
      } catch (err) {
        allStats.failedCells++;
        allStats.cells.push({ cellId: cell.id, status: 'error', error: err.message });
      }
    }
  }

  allStats.totalDurationMs = Date.now() - matrixStart;

  // Dedup across cells
  const finalFindings = dedup ? dedupFindings(allFindings) : allFindings;

  onEvent?.(`Matrix complete: ${finalFindings.length} findings across ${allStats.completedCells} cells`);

  return { findings: finalFindings, stats: allStats };
}

/**
 * Run matrix cells with limited parallelism.
 *
 * Uses a worker-pool pattern: pull cells off the queue, dispatch up to
 * `concurrency` cells in parallel, refill as workers complete.
 *
 * Browser-bound cells naturally serialize per browser via BrowserPool
 * (one context per browser at a time), but no-browser cells can fully
 * parallelize. Recommended concurrency: 2-4 for browser-heavy matrices,
 * higher for no-browser-heavy matrices.
 */
async function runMatrixConcurrently(cells, baseCtx, concurrency, signal, onEvent) {
  const queue = [...cells];
  const workers = [];
  const allFindings = [];
  const cellStats = [];

  async function worker(workerId) {
    while (queue.length > 0) {
      if (signal?.aborted) break;

      const cell = queue.shift();
      if (!cell) break;

      onEvent?.(`[worker ${workerId}] Cell: ${cell.id}`);

      try {
        const { findings, stats } = await runCell(cell, baseCtx);
        allFindings.push(...findings);
        cellStats.push(stats);
      } catch (err) {
        cellStats.push({ cellId: cell.id, status: 'error', error: err.message });
      }
    }
  }

  // Spawn N workers
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);

  return { findings: allFindings, cellStats };
}
