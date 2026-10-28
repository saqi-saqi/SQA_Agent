/**
 * scripts/migrate-json-to-sqlite.js
 *
 * Migrates existing data/*.json files (runs, monitors, flaky history) into
 * the SQLite database so no historical data is lost during the storage migration.
 *
 * Usage:
 *   node scripts/migrate-json-to-sqlite.js [--data-dir ./data] [--archive]
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, closeDatabase } from '../src/storage/db.js';
import { saveRun } from '../src/storage/runStore.js';
import { SqliteMonitorStore } from '../src/storage/monitorStore.js';
import { SqliteFlakyStore } from '../src/storage/flakyStore.js';

export async function migrateJsonToSqlite({
  dataDir = path.join(process.cwd(), 'data'),
  dbPath = null,
  db: externalDb = null,
  archive = false,
  log = console.log,
} = {}) {
  log(`Starting migration from JSON files in ${dataDir}...`);

  const shouldClose = !externalDb;
  const db = externalDb || getDatabase(dbPath || path.join(dataDir, 'testflow.sqlite'));
  const monitorStore = new SqliteMonitorStore({ db });
  const flakyStore = new SqliteFlakyStore({ db });

  let migratedRuns = 0;
  let skippedRuns = 0;
  let migratedMonitors = 0;
  let migratedFlaky = 0;

  // ─── 1. Migrate Run JSON Files ─────────────────────────────────────────
  if (existsSync(dataDir)) {
    const files = await fs.readdir(dataDir);
    const runFiles = files.filter(f => f.startsWith('run_') && f.endsWith('.json'));

    log(`Found ${runFiles.length} run JSON file(s).`);

    for (const file of runFiles) {
      const filePath = path.join(dataDir, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const run = JSON.parse(content);
        if (run && run.runId) {
          saveRun(run, db);
          migratedRuns++;

          // Also record into flaky history if completed
          if (run.status === 'completed') {
            await flakyStore.recordRun(run);
            migratedFlaky++;
          }
        } else {
          skippedRuns++;
        }
      } catch (err) {
        log(`Warning: Failed to parse ${file}: ${err.message}`);
        skippedRuns++;
      }
    }

    // ─── 2. Migrate Monitors JSON ─────────────────────────────────────────
    const monitorsFile = path.join(dataDir, 'monitors.json');
    if (existsSync(monitorsFile)) {
      try {
        const content = await fs.readFile(monitorsFile, 'utf-8');
        const monitors = JSON.parse(content);
        if (Array.isArray(monitors)) {
          for (const m of monitors) {
            const existing = await monitorStore.get(m.id);
            if (!existing) {
              await monitorStore.add(m);
              migratedMonitors++;
            }
          }
        }
      } catch (err) {
        log(`Warning: Failed to migrate monitors: ${err.message}`);
      }
    }

    // ─── 3. Migrate flaky-history.json (if separate) ─────────────────────
    const flakyFile = path.join(dataDir, 'flaky-history.json');
    if (existsSync(flakyFile)) {
      try {
        const content = await fs.readFile(flakyFile, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data.runs)) {
          for (const r of data.runs) {
            const summary = {
              runId: r.runId,
              url: r.url,
              startedAt: r.startedAt,
              status: r.status,
              ruleIds: new Set(r.ruleIds || []),
            };
            const stmt = db.prepare(`
              INSERT INTO flaky_history (run_id, url, started_at, status, rule_ids_json)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(run_id) DO NOTHING
            `);
            stmt.run(
              summary.runId,
              summary.url,
              summary.startedAt || new Date().toISOString(),
              summary.status || 'completed',
              JSON.stringify(Array.from(summary.ruleIds))
            );
          }
        }
      } catch (err) {
        log(`Warning: Failed to migrate flaky-history.json: ${err.message}`);
      }
    }

    // ─── 4. Optional Archive of Old JSON Files ────────────────────────────
    if (archive && runFiles.length > 0) {
      const archiveDir = path.join(dataDir, 'archive_json');
      await fs.mkdir(archiveDir, { recursive: true });
      for (const file of runFiles) {
        const src = path.join(dataDir, file);
        const dest = path.join(archiveDir, file);
        await fs.rename(src, dest);
      }
      log(`Archived ${runFiles.length} JSON files to ${archiveDir}`);
    }
  }

  log(`Migration complete:`);
  log(`  - Runs migrated: ${migratedRuns} (skipped: ${skippedRuns})`);
  log(`  - Monitors migrated: ${migratedMonitors}`);
  log(`  - Flaky records created: ${migratedFlaky}`);

  if (shouldClose) {
    closeDatabase(db);
  }

  return { migratedRuns, skippedRuns, migratedMonitors, migratedFlaky };
}

// Run directly from CLI if invoked as main
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const archive = args.includes('--archive');
  const dataDirIdx = args.indexOf('--data-dir');
  const dataDir = dataDirIdx !== -1 && args[dataDirIdx + 1] ? args[dataDirIdx + 1] : undefined;

  migrateJsonToSqlite({ dataDir, archive })
    .then(() => {
      closeDatabase();
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
