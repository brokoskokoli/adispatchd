/**
 * Spec §22.2 scenario 12 (as far as possible locally): an update of the code
 * keeps config-dir and data-dir (runs, events, logs), migrates the database
 * with a backup first and the restarted instance works. The package-level
 * variant (npm pack + install + start) lives in pack.test.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryLogger, isTerminalStatus } from '../core/index.js';
import { loadConfig, snapshotWorkflow } from '../config/index.js';
import { MIGRATIONS, openPersistence, schemaVersion } from '../persistence/index.js';
import { createApp, type App } from '../app.js';
import { initDirectories } from './init.js';
import { initTemplates } from './init-templates.js';

const roots: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.shutdown({ mode: 'cancel', cancelTimeoutMs: 2_000 }).catch(() => undefined);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function hashDir(dir: string): string {
  const h = createHash('sha256');
  for (const f of initTemplates().map((t) => t.path).sort()) h.update(f).update(readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

describe('update keeps data and migrates with backup (scenario 12)', () => {
  it('migrates an old database with a backup, keeps runs/logs/config and starts normally', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orch-update-'));
    roots.push(root);
    const { configDir, dataDir } = await initDirectories({ configDir: path.join(root, 'config'), dataDir: path.join(root, 'data') });
    const configHash = hashDir(configDir);

    // "Old version": schema v1 only, one historical run with an event and log files.
    const loaded = await loadConfig(configDir, { dataDir });
    if (!loaded.ok) throw new Error('init config invalid');
    const v1 = MIGRATIONS.filter((m) => m.version === 1);
    expect(MIGRATIONS.length).toBeGreaterThan(1); // there is something to migrate
    const old = openPersistence(dataDir, { migrations: v1 });
    const oldRun = old.runs.reserve({ workflowId: 'hello', triggerType: 'manual', configSnapshot: snapshotWorkflow(loaded.config, 'hello') });
    old.events.append(oldRun.id, 'test.marker', { from: 'old version' });
    old.close();
    const logDir = path.join(dataDir, 'logs', oldRun.id);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, 'stdout.log'), 'output of the old version\n');

    // "New version" starts on the same directories.
    const logger = new MemoryLogger();
    const app = await createApp({ configDir, dataDir, port: 0, logger, retentionInitialDelayMs: 3_600_000 });
    apps.push(app);
    await app.start();
    await app.ready;

    // Backup of the v1 database was written before migrating and contains the old run.
    const backups = readdirSync(path.join(dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^orchestrator-1-\d{8}T\d{9}Z\.sqlite$/);
    const backup = new DatabaseSync(path.join(dataDir, 'backups', backups[0] ?? ''), { readOnly: true });
    try {
      expect(schemaVersion(backup)).toBe(1);
      expect(backup.prepare('SELECT id FROM runs').all()).toEqual([{ id: oldRun.id }]);
    } finally {
      backup.close();
    }
    expect(schemaVersion(app.persistence.db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    expect(logger.records.some((e) => e.msg === 'database migrated')).toBe(true);

    // History survived (the never-started reserved run is cancelled by recovery, but kept).
    const run = app.persistence.runs.get(oldRun.id);
    expect(run?.workflowId).toBe('hello');
    expect(app.persistence.events.listForRun(oldRun.id).some((e) => e.type === 'test.marker')).toBe(true);
    const logs = await app.http.inject({ method: 'GET', url: `/api/v1/runs/${oldRun.id}/logs?stream=stdout` });
    expect(logs.json()).toMatchObject({ data: 'output of the old version\n' });
    expect(hashDir(configDir)).toBe(configHash);

    // The updated instance works: run the example workflow end to end.
    const started = await app.http.inject({
      method: 'POST',
      url: '/api/v1/workflows/hello/start',
      headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      payload: JSON.stringify({ parameters: { name: 'update' } }),
    });
    expect(started.statusCode).toBe(202);
    const id = started.json().run.id as string;
    const end = Date.now() + 15_000;
    let finished = app.persistence.runs.get(id);
    while (!(finished && isTerminalStatus(finished.status) && finished.lifecycleStatus !== 'running') && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 25));
      finished = app.persistence.runs.get(id);
    }
    expect(finished).toMatchObject({ status: 'completed', businessResult: 'success', lifecycleStatus: 'succeeded' });
    expect(readFileSync(path.join(dataDir, 'logs', id, 'stdout.log'), 'utf8')).toContain('Hello, update!');

    const stopped = await app.shutdown();
    expect(stopped.exitCode).toBe(0);
    // A second start does not migrate (and back up) again.
    const again = await createApp({ configDir, dataDir, port: 0, logger: new MemoryLogger(), retentionInitialDelayMs: 3_600_000 });
    apps.push(again);
    expect(readdirSync(path.join(dataDir, 'backups'))).toHaveLength(1);
    expect(again.persistence.runs.get(oldRun.id)).toBeDefined();
  }, 40_000);
});
