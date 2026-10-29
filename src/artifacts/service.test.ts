/** `ArtifactService` (WI-35): collecting, serving, input staging, deleting, retention and orphans. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, type ArtifactRecord } from '../core/index.js';
import { openTestPersistence } from '../persistence/testing/helpers.js';
import type { Persistence } from '../persistence/index.js';
import { reserveSource } from '../persistence/testing/helpers.js';
import { ArtifactError, ArtifactService, makeTreeWritable } from './index.js';

async function readAll(stream: AsyncGenerator<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Independent minimal ZIP reader (central directory + inflate) to verify the writer. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(offset)).toBe(0x04034b50);
    const localName = buf.readUInt16LE(offset + 26);
    const localExtra = buf.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localName + localExtra;
    expect(method).toBe(8);
    const data = inflateRawSync(buf.subarray(dataStart, dataStart + csize));
    expect(data.length).toBe(usize);
    // data descriptor follows the data
    expect(buf.readUInt32LE(dataStart + csize)).toBe(0x08074b50);
    expect(buf.readUInt32LE(dataStart + csize + 4)).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('ArtifactService (WI-35)', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanupDb: () => void;
  let tmp: string;
  let dataDir: string;
  let ws: string;
  let created: ArtifactRecord[];
  let deleted: ArtifactRecord[];
  let service: ArtifactService;

  beforeEach(() => {
    ({ p, clock, cleanup: cleanupDb } = openTestPersistence());
    tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-art-svc-'));
    dataDir = path.join(tmp, 'data');
    ws = path.join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    created = [];
    deleted = [];
    service = new ArtifactService({
      repositories: p,
      dataDir,
      clock,
      onCreated: (a) => created.push(a),
      onDeleted: (a) => deleted.push(a),
    });
  });
  afterEach(() => {
    cleanupDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  const put = (rel: string, content: string | Buffer): void => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  };
  const base = { runId: 'run-1', workflowId: 'make', workspace: '', maxBytes: 1_000_000, renderName: (t: string) => t, parentId: null, secrets: [] as string[] };
  const collect = (specs: Array<{ name: string; type: string; path: string; required?: boolean }>, over: Partial<Parameters<ArtifactService['collect']>[0]> = {}) =>
    service.collect({ ...base, workspace: ws, specs: specs.map((s) => ({ required: false, ...s })), ...over });

  it('stores a file and a folder artifact, inserts rows, notifies and lists the files', async () => {
    put('out/report.pdf', 'pdf-bytes');
    put('out/site/index.html', '<h1>x</h1>');
    put('out/site/css/app.css', 'body{}');
    const report = await collect([
      { name: 'Report', type: 'report', path: 'out/report.pdf' },
      { name: 'Site', type: 'site', path: 'out/site' },
    ]);
    expect(report.warnings).toEqual([]);
    expect(report.created.map((c) => [c.name, c.kind, c.size, c.fileCount])).toEqual([
      ['Report', 'file', 9, 1],
      ['Site', 'folder', 16, 2],
    ]);
    expect(report.message).toBe('2 artifact(s) stored, 25 bytes');
    expect(created.map((a) => a.id)).toEqual(report.created.map((c) => c.id));
    const [file, folder] = created as [ArtifactRecord, ArtifactRecord];
    expect(p.artifacts.get(file.id)).toMatchObject({ workflowId: 'make', runId: 'run-1', ordinal: 0, fileName: 'report.pdf', parentId: null });
    expect(readFileSync(path.join(dataDir, 'artifacts', file.id, 'content'), 'utf8')).toBe('pdf-bytes');
    expect(await service.listFiles(file)).toEqual({ files: [{ path: 'report.pdf', size: 9 }], truncated: false });
    expect((await service.listFiles(folder)).files).toEqual([
      { path: 'css/app.css', size: 6 },
      { path: 'index.html', size: 10 },
    ]);
    expect(readdirSync(path.join(dataDir, 'artifacts')).sort()).toEqual([file.id, folder.id].sort());
  });

  it('is idempotent per run and position (resumed finalization)', async () => {
    put('a.txt', 'a');
    const first = await collect([{ name: 'A', type: 't', path: 'a.txt' }]);
    const second = await collect([{ name: 'A', type: 't', path: 'a.txt' }]);
    expect(second.created.map((c) => c.id)).toEqual(first.created.map((c) => c.id));
    expect(p.artifacts.list()).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it('turns problems into warnings: missing path, symlink, size limit, bad name, empty folder', async () => {
    put('ok.txt', 'ok');
    put('big.bin', 'x'.repeat(40));
    writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
    symlinkSync(path.join(tmp, 'secret.txt'), path.join(ws, 'link.txt'));
    mkdirSync(path.join(ws, 'empty'));
    const report = await collect(
      [
        { name: 'Missing', type: 't', path: 'nope.txt' },
        { name: 'Link', type: 't', path: 'link.txt' },
        { name: 'Big', type: 't', path: 'big.bin' },
        { name: 'Ok', type: 't', path: 'ok.txt' },
        { name: 'Boom', type: 't', path: 'ok.txt' },
        { name: 'Empty', type: 't', path: 'empty' },
        { name: '   ', type: 't', path: 'ok.txt' },
      ],
      { maxBytes: 30, renderName: (t) => { if (t === 'Boom') throw new Error('no value for placeholder'); return t; } },
    );
    expect(report.created.map((c) => c.name)).toEqual(['Ok']);
    expect(report.warnings.map((w) => [w.index, w.reason])).toEqual([
      [0, 'missing'],
      [1, 'symlink'],
      [2, 'size_limit'],
      [4, 'invalid_name'],
      [5, 'empty'],
      [6, 'invalid_name'],
    ]);
    expect(report.message).toMatch(/1 artifact\(s\) stored, 2 bytes; 6 not stored/);
    expect(readdirSync(path.join(dataDir, 'artifacts'))).toHaveLength(1); // no leftovers of the failed ones
  });

  it('shares the size budget between the artifacts of a call', async () => {
    put('a.bin', 'x'.repeat(20));
    put('b.bin', 'y'.repeat(20));
    const report = await collect([{ name: 'A', type: 't', path: 'a.bin' }, { name: 'B', type: 't', path: 'b.bin' }], { maxBytes: 30 });
    expect(report.created.map((c) => c.name)).toEqual(['A']);
    expect(report.warnings).toMatchObject([{ index: 1, reason: 'size_limit' }]);
  });

  it('truncates long names, redacts secrets and records the parent', async () => {
    put('log.txt', 'token=ghs_ABCDEFGH1234');
    const report = await collect([{ name: 'n'.repeat(300), type: 't', path: 'log.txt' }], { secrets: ['ghs_ABCDEFGH1234'], parentId: 'art-parent' });
    expect(report.created[0]?.name).toHaveLength(200);
    const record = created[0] as ArtifactRecord;
    expect(record.parentId).toBe('art-parent');
    expect(readFileSync(path.join(dataDir, 'artifacts', record.id, 'content'), 'utf8')).toBe('token=[REDACTED]');
  });

  it('serves files safely: traversal, symlinks and wrong names are refused', async () => {
    put('res/a.txt', 'aaa');
    put('res/sub/b.txt', 'bb');
    put('one.txt', '1');
    await collect([{ name: 'Res', type: 't', path: 'res' }, { name: 'One', type: 't', path: 'one.txt' }]);
    const [folder, file] = created as [ArtifactRecord, ArtifactRecord];
    const opened = await service.openFile(folder, ['sub', 'b.txt']);
    expect(opened).toMatchObject({ size: 2, name: 'b.txt' });
    await opened.handle.close();
    await (await service.openFile(file, ['one.txt'])).handle.close();
    const notFound = { code: 'artifact_file_not_found' };
    await expect(service.openFile(file, ['other.txt'])).rejects.toMatchObject(notFound);
    await expect(service.openFile(file, ['one.txt', 'x'])).rejects.toMatchObject(notFound);
    await expect(service.openFile(folder, ['sub'])).rejects.toMatchObject(notFound); // a directory
    await expect(service.openFile(folder, ['nope'])).rejects.toMatchObject(notFound);
    // A planted symlink inside the store is never followed.
    const content = path.join(dataDir, 'artifacts', folder.id, 'content');
    writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
    symlinkSync(path.join(tmp, 'secret.txt'), path.join(content, 'evil.txt'));
    symlinkSync(tmp, path.join(content, 'evildir'));
    await expect(service.openFile(folder, ['evil.txt'])).rejects.toMatchObject(notFound);
    await expect(service.openFile(folder, ['evildir', 'secret.txt'])).rejects.toMatchObject(notFound);
    expect((await service.listFiles(folder)).files.map((f) => f.path)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('writes a valid .zip of a folder (verified by an independent reader and by unzip)', async () => {
    const big = Buffer.from('lorem ipsum '.repeat(20_000));
    put('res/a.txt', 'aaa');
    put('res/sub/ümlaut ß.txt', 'bb');
    put('res/empty.txt', '');
    put('res/big.txt', big);
    await collect([{ name: 'Res', type: 't', path: 'res' }]);
    const folder = created[0] as ArtifactRecord;
    const zip = await service.openZip(folder);
    expect(zip.fileName).toBe('res.zip');
    const buf = await readAll(zip.stream);
    const entries = readZip(buf);
    expect([...entries.keys()].sort()).toEqual(['a.txt', 'big.txt', 'empty.txt', 'sub/ümlaut ß.txt']);
    expect(entries.get('a.txt')?.toString()).toBe('aaa');
    expect(entries.get('empty.txt')?.length).toBe(0);
    expect(entries.get('big.txt')?.equals(big)).toBe(true);
    expect(buf.length).toBeLessThan(big.length); // deflated
    // Independent check with unzip, if installed.
    const file = path.join(tmp, 'res.zip');
    writeFileSync(file, buf);
    const probe = spawnSync('unzip', ['-tq', file], { encoding: 'utf8' });
    if (!probe.error) {
      expect(probe.status).toBe(0);
      const target = path.join(tmp, 'unzipped');
      execFileSync('unzip', ['-q', file, '-d', target]);
      expect(readFileSync(path.join(target, 'a.txt'), 'utf8')).toBe('aaa');
      expect(readFileSync(path.join(target, 'sub', 'ümlaut ß.txt'), 'utf8')).toBe('bb');
      expect(readFileSync(path.join(target, 'big.txt')).equals(big)).toBe(true);
    }
  });

  it('refuses a .zip that would need ZIP64', async () => {
    put('res/a.txt', 'a');
    await collect([{ name: 'Res', type: 't', path: 'res' }]);
    const folder = created[0] as ArtifactRecord;
    p.db.prepare('UPDATE artifacts SET file_count = 1 WHERE id = ?').run(folder.id);
    const content = path.join(dataDir, 'artifacts', folder.id, 'content');
    // Fake a huge file by truncating (sparse) beyond the limit.
    const huge = path.join(content, 'huge.bin');
    writeFileSync(huge, '');
    truncateSync(huge, 0xffffffff);
    await expect(service.openZip(folder)).rejects.toMatchObject({ code: 'artifact_too_large' });
  });

  describe('input', () => {
    it('stages a file and a folder read-only below inputs/<name> and replaces an earlier input', async () => {
      put('out/report.pdf', 'pdf');
      put('res/a.txt', 'a');
      put('res/sub/b.txt', 'b');
      await collect([{ name: 'Weekly report', type: 't', path: 'out/report.pdf' }, { name: 'Res', type: 't', path: 'res' }]);
      const [file, folder] = created as [ArtifactRecord, ArtifactRecord];
      const target = path.join(tmp, 'run-ws');
      mkdirSync(target);
      const filePath = await service.stageInput(file.id, target);
      expect(filePath).toBe(path.join(target, 'inputs', 'Weekly_report.pdf'));
      expect(readFileSync(filePath, 'utf8')).toBe('pdf');
      expect(statSync(filePath).mode & 0o777).toBe(0o444);
      const folderPath = await service.stageInput(folder.id, target);
      expect(folderPath).toBe(path.join(target, 'inputs', 'Res'));
      expect(readFileSync(path.join(folderPath, 'sub', 'b.txt'), 'utf8')).toBe('b');
      expect(statSync(path.join(folderPath, 'sub')).mode & 0o777).toBe(0o555);
      expect(statSync(path.join(target, 'inputs')).mode & 0o777).toBe(0o555);
      // The input cannot be changed by accident.
      if (process.getuid?.() !== 0) {
        expect(() => writeFileSync(filePath, 'changed')).toThrow(/EACCES/);
        expect(() => writeFileSync(path.join(folderPath, 'new.txt'), 'x')).toThrow(/EACCES/);
        expect(() => rmSync(path.join(folderPath, 'a.txt'))).toThrow(/EACCES/);
        expect(() => rmSync(target, { recursive: true })).toThrow();
      }
      // Staging again (same workspace, e.g. a fixed working_directory) replaces it.
      await service.stageInput(file.id, target);
      expect(readFileSync(filePath, 'utf8')).toBe('pdf');
      await makeTreeWritable(target);
      rmSync(target, { recursive: true });
      expect(existsSync(target)).toBe(false);
    });

    it('refuses unknown artifacts and a blocked inputs entry', async () => {
      await expect(service.stageInput('art-20261029T100000000Z-aaaaaaaa', ws)).rejects.toMatchObject({ code: 'artifact_not_found' });
      await expect(service.stageInput('../x', ws)).rejects.toBeInstanceOf(ArtifactError);
      put('a.txt', 'a');
      await collect([{ name: 'A', type: 't', path: 'a.txt' }]);
      const target = path.join(tmp, 'blocked-ws');
      mkdirSync(target);
      writeFileSync(path.join(target, 'inputs'), 'i am a file');
      await expect(service.stageInput((created[0] as ArtifactRecord).id, target)).rejects.toMatchObject({ code: 'artifact_input_blocked' });
    });
  });

  describe('deleting', () => {
    it('deletes row and files and notifies; unknown ids are 404-like', async () => {
      put('a.txt', 'a');
      await collect([{ name: 'A', type: 't', path: 'a.txt' }]);
      const record = created[0] as ArtifactRecord;
      await service.delete(record.id);
      expect(p.artifacts.get(record.id)).toBeNull();
      expect(existsSync(path.join(dataDir, 'artifacts', record.id))).toBe(false);
      expect(deleted.map((a) => a.id)).toEqual([record.id]);
      await expect(service.delete(record.id)).rejects.toMatchObject({ code: 'artifact_not_found' });
      await expect(service.delete('../../etc')).rejects.toMatchObject({ code: 'artifact_not_found' });
    });

    it('refuses to delete an artifact that an active run uses (409) until the run is done', async () => {
      put('a.txt', 'a');
      await collect([{ name: 'A', type: 't', path: 'a.txt' }]);
      const record = created[0] as ArtifactRecord;
      const run = reserveSource(p, 'summarize', `artifacts:${record.id}`);
      await expect(service.delete(record.id)).rejects.toMatchObject({ code: 'artifact_in_use', details: { runIds: [run.id] } });
      expect(p.artifacts.get(record.id)).not.toBeNull();
      expect(existsSync(path.join(dataDir, 'artifacts', record.id, 'content'))).toBe(true);
      expect(deleted).toEqual([]);
      p.runs.transition(run.id, 'starting');
      p.runs.transition(run.id, 'running');
      p.runs.beginFinalization(run.id, { status: 'completed', businessResult: 'success', reason: 'ok' });
      p.runs.finish(run.id);
      await service.delete(record.id);
      expect(p.artifacts.get(record.id)).toBeNull();
    });

    it('keeps the parent reference as text after the parent was deleted', async () => {
      put('a.txt', 'a');
      await collect([{ name: 'Parent', type: 't', path: 'a.txt' }]);
      const parent = created[0] as ArtifactRecord;
      await collect([{ name: 'Child', type: 't', path: 'a.txt' }], { runId: 'run-2', parentId: parent.id });
      await service.delete(parent.id);
      expect(p.artifacts.get((created[1] as ArtifactRecord).id)?.parentId).toBe(parent.id);
    });
  });

  describe('retention', () => {
    it('expires artifacts older than the cut-off and skips those in use', async () => {
      put('a.txt', 'a');
      await collect([{ name: 'Old', type: 't', path: 'a.txt' }], { runId: 'run-old' });
      await collect([{ name: 'Busy', type: 't', path: 'a.txt' }], { runId: 'run-busy' });
      clock.advance(10 * 86_400_000);
      await collect([{ name: 'New', type: 't', path: 'a.txt' }], { runId: 'run-new' });
      const [old, busy] = created as [ArtifactRecord, ArtifactRecord];
      reserveSource(p, 'summarize', `artifacts:${busy.id}`);
      const res = await service.expire(new Date(clock.now().getTime() - 5 * 86_400_000));
      expect(res).toEqual({ deleted: 1, errors: [] });
      expect(p.artifacts.get(old.id)).toBeNull();
      expect(p.artifacts.list().map((a) => a.name).sort()).toEqual(['Busy', 'New']);
    });

    it('removes orphaned directories (no row) after the minimum age, keeps young ones and known artifacts', async () => {
      put('a.txt', 'a');
      await collect([{ name: 'A', type: 't', path: 'a.txt' }]);
      const known = created[0] as ArtifactRecord;
      const dir = path.join(dataDir, 'artifacts');
      const orphan = path.join(dir, 'art-20260101T000000000Z-deadbeef');
      const tmpOrphan = path.join(dir, 'art-20260101T000000000Z-feedface.tmp');
      const young = path.join(dir, 'art-20260102T000000000Z-cafebabe');
      const foreign = path.join(dir, 'not-an-artifact');
      for (const d of [orphan, tmpOrphan, young, foreign]) mkdirSync(path.join(d, 'content'), { recursive: true });
      const old = new Date(clock.now().getTime() - 3 * 86_400_000);
      for (const d of [orphan, tmpOrphan, foreign]) utimesSync(d, old, old);
      // The clock of the test is fake; make "young" really young relative to it.
      utimesSync(young, clock.now(), clock.now());
      utimesSync(path.join(dir, known.id), old, old);
      expect(await service.sweepOrphans()).toBe(2);
      expect(readdirSync(dir).sort()).toEqual([known.id, 'not-an-artifact', path.basename(young)].sort());
    });
  });

  it('exposes the catalogue to the source adapter (list/get; invalid ids are unknown)', async () => {
    put('a.txt', 'a');
    await collect([{ name: 'A', type: 't', path: 'a.txt' }]);
    const record = created[0] as ArtifactRecord;
    expect(service.list().map((a) => a.id)).toEqual([record.id]);
    expect(service.get(record.id)?.name).toBe('A');
    expect(service.get('../etc')).toBeNull();
    expect(() => service.require('art-20261029T100000000Z-aaaaaaaa')).toThrow(/not found/);
  });

  it('makeTreeWritable restores write permission on locked directories without following symlinks', async () => {
    const dir = path.join(tmp, 'locked');
    mkdirSync(path.join(dir, 'a'), { recursive: true });
    writeFileSync(path.join(dir, 'a', 'f'), 'x');
    const other = path.join(tmp, 'other');
    mkdirSync(other);
    chmodSync(other, 0o555);
    symlinkSync(other, path.join(dir, 'link'));
    chmodSync(path.join(dir, 'a'), 0o555);
    chmodSync(dir, 0o555);
    await makeTreeWritable(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(dir, 'a')).mode & 0o777).toBe(0o755);
    expect(statSync(other).mode & 0o777).toBe(0o555); // behind a symlink: untouched
    chmodSync(other, 0o755);
  });
});
