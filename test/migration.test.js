import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { migrateJsonToSqlite } from '../scripts/migrate-json-to-sqlite.js';
import { getDatabase, closeDatabase } from '../src/storage/db.js';
import { getRun } from '../src/storage/runStore.js';
import { SqliteMonitorStore } from '../src/storage/monitorStore.js';

describe('JSON to SQLite Migration', () => {
  let tmpDir;
  let dbPath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'testflow-mig-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
  });

  afterEach(async () => {
    closeDatabase();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('migrates legacy run files, monitors, and flaky history into SQLite', async () => {
    // 1. Create simulated legacy run JSON
    const legacyRun = {
      runId: 'run_legacy_101',
      url: 'https://mysite.com',
      status: 'completed',
      score: 90,
      startedAt: '2026-01-01T12:00:00Z',
      findings: [{ ruleId: 'broken-link', severity: 'high', confidence: 'confirmed' }],
      summary: { totalFindings: 1 },
    };
    await fs.writeFile(path.join(tmpDir, 'run_legacy_101.json'), JSON.stringify(legacyRun));

    // 2. Create simulated monitors.json
    const legacyMonitors = [
      {
        id: 'client-site',
        label: 'Client Site',
        url: 'https://client.com',
        intervalHours: 24,
        enabled: true,
      },
    ];
    await fs.writeFile(path.join(tmpDir, 'monitors.json'), JSON.stringify(legacyMonitors));

    // 3. Create simulated flaky-history.json
    const legacyFlaky = {
      runs: [
        {
          runId: 'run_flaky_1',
          url: 'https://client.com',
          startedAt: '2026-01-01T00:00:00Z',
          status: 'completed',
          ruleIds: ['rule-1'],
        },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'flaky-history.json'), JSON.stringify(legacyFlaky));

    // 4. Run migration with archiving enabled
    const res = await migrateJsonToSqlite({
      dataDir: tmpDir,
      dbPath,
      archive: true,
      log: () => {}, // silent
    });

    assert.equal(res.migratedRuns, 1);
    assert.equal(res.migratedMonitors, 1);
    assert.equal(res.migratedFlaky, 1);

    // 5. Verify database contents
    const db = getDatabase(dbPath);
    const run = getRun('run_legacy_101', db);
    assert.ok(run);
    assert.equal(run.url, 'https://mysite.com');
    assert.equal(run.score, 90);

    const monitorStore = new SqliteMonitorStore({ db });
    const monitor = await monitorStore.get('client-site');
    assert.ok(monitor);
    assert.equal(monitor.label, 'Client Site');

    closeDatabase(db);

    // 6. Verify archiving moved the file
    const archiveFiles = await fs.readdir(path.join(tmpDir, 'archive_json'));
    assert.ok(archiveFiles.includes('run_legacy_101.json'));
  });
});
