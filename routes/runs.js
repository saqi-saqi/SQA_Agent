/**
 * routes/runs.js — Express router for SQA Agent runs.
 *
 * Supports both execution paths side-by-side:
 *   • Matrix path: createRunWithMatrix({ url, options }) — full browser x viewport x role matrix
 *   • Legacy path: createRun(url, options) — v1 check_* sequential execution
 *
 * Wire into any Express app:
 *   import runsRouter from './routes/runs.js';
 *   app.use('/api/runs', runsRouter);
 */
import { Router } from 'express';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import {
  createRun,
  createRunWithMatrix,
  getRun,
  listRuns,
  addSSEClient,
} from '../src/services/runManager.js';
import { generateHtmlReport, generateJsonReport } from '../src/services/report.js';
import { registerAllExecutors } from '../src/executors/index.js';
import { registerLegacyChecks } from '../src/checks/index.js';

// Auto-register built-in executors and legacy check wrappers
registerAllExecutors();
registerLegacyChecks();

// ─── workflow step schema (matches existing check/workflows.js contract) ──

const WorkflowStep = z.union([
  z.object({
    action: z.enum(['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'hover', 'focus']),
    selector: z.string().min(1),
    value: z.string().optional(),
    timeoutMs: z.number().int().positive().max(30000).optional(),
  }).strict(),
  z.object({
    action: z.literal('press'),
    selector: z.string().min(1),
    value: z.string().min(1), // key to press
  }).strict(),
  z.object({
    action: z.literal('wait'),
    selector: z.string().min(1).optional(),
    ms: z.number().int().positive().max(10000).optional(),
    state: z.enum(['visible', 'hidden', 'attached', 'detached', 'stable']).optional(),
  }).strict(),
  z.object({
    action: z.literal('assertVisible'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().max(30000).optional(),
  }).strict(),
  z.object({
    action: z.literal('assertHidden'),
    selector: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal('assertText'),
    selector: z.string().min(1),
    equals: z.string().optional(),
    contains: z.string().optional(),
  }).strict().refine(d => d.equals != null || d.contains != null, {
    message: 'assertText requires equals or contains',
  }),
  z.object({
    action: z.literal('assertUrl'),
    url: z.string().optional(),
    urlMatches: z.string().optional(),
    urlContains: z.string().optional(),
  }).strict().refine(d => d.url || d.urlMatches || d.urlContains, {
    message: 'assertUrl requires url, urlMatches, or urlContains',
  }),
  z.object({
    action: z.literal('assertStatus'),
    status: z.number().int().min(100).max(599),
  }).strict(),
]);

export const Workflow = z.object({
  name: z.string().min(1),
  startUrl: z.string().url(),
  steps: z.array(WorkflowStep).min(1),
  auth: z.object({
    type: z.enum(['cookie', 'bearer', 'basic', 'none']),
    secretRef: z.string().optional(),
  }).optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(5).default(2),
    backoffMs: z.number().int().positive().max(10000).default(500),
  }).default({}),
}).strict();

// ─── createRun body schema ────────────────────────────────────────────

export const createRunSchema = z.object({
  url: z.string().url(),
  mode: z.enum(['matrix', 'legacy']).optional().default('matrix'),
  options: z.object({
    maxPages: z.number().int().min(1).max(100).optional(),
    maxDepth: z.number().int().min(0).max(5).optional(),
    checks: z.array(z.string()).default([]),
    workflows: z.array(Workflow).default([]),
    browsers: z.array(z.string()).optional(),
    viewports: z.array(z.object({ width: z.number(), height: z.number() })).optional(),
    executors: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
    dedup: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
    testPlanId: z.string().optional(),
  }).default({}),
});

// ─── Express router ───────────────────────────────────────────────────

const router = Router();

router.post('/', async (req, res) => {
  try {
    const validated = createRunSchema.parse(req.body);
    const { url, options, mode } = validated;

    let runId;
    if (mode === 'legacy') {
      runId = await createRun(url, options);
    } else {
      runId = await createRunWithMatrix({ url, options });
    }

    res.status(202).json({ runId, mode });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    if (err.message && (
      err.message.includes('not allowed') ||
      err.message.includes('private') ||
      err.message.includes('Private') ||
      err.message.includes('DNS resolution') ||
      err.message.includes('Invalid URL')
    )) {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const runs = await listRuns();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/events', async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (run.events) {
      for (const event of run.events) {
        const data = JSON.stringify({ type: 'progress', message: event.message, timestamp: event.timestamp });
        res.write(`data: ${data}\n\n`);
      }
    }

    if (run.status === 'completed' || run.status === 'failed') {
      res.write(`data: ${JSON.stringify({ type: 'progress', message: '__DONE__', timestamp: run.completedAt })}\n\n`);
    } else {
      addSSEClient(req.params.id, res);
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/report.html', async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'completed') return res.status(400).json({ error: 'Run not completed' });

    const html = generateHtmlReport(run);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/report.json', async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const json = generateJsonReport(run);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.json"`);
    res.send(json);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/screenshots/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const screenshotsDir = path.join(process.cwd(), 'data', 'screenshots');
    const screenshotPath = path.join(screenshotsDir, filename);
    if (fs.existsSync(screenshotPath)) {
      res.sendFile(screenshotPath);
    } else {
      res.status(404).json({ error: 'Screenshot not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
