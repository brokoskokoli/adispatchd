import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_LOG_PAGE_BYTES, readLogPage } from './logs.js';

describe('readLogPage', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orch-logs-'));
    file = path.join(dir, 'stdout.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('pages by byte offset and reports eof', async () => {
    writeFileSync(file, 'abcdefghij');
    const p1 = await readLogPage(file, 'stdout', { offset: 0, limit: 4 });
    expect(p1).toMatchObject({ offset: 0, length: 4, nextOffset: 4, size: 10, eof: false, exists: true, data: 'abcd' });
    const p2 = await readLogPage(file, 'stdout', { offset: p1.nextOffset, limit: 100 });
    expect(p2).toMatchObject({ data: 'efghij', nextOffset: 10, eof: true });
    const p3 = await readLogPage(file, 'stdout', { offset: 10 });
    expect(p3).toMatchObject({ length: 0, data: '', eof: true });
  });

  it('tails the end of the file and never reads more than the max page size', async () => {
    writeFileSync(file, 'x'.repeat(MAX_LOG_PAGE_BYTES + 10) + 'END');
    const tail = await readLogPage(file, 'stdout', { tail: 3 });
    expect(tail.data).toBe('END');
    expect(tail.eof).toBe(true);
    const big = await readLogPage(file, 'stdout', { offset: 0, limit: 10 * MAX_LOG_PAGE_BYTES });
    expect(big.length).toBe(MAX_LOG_PAGE_BYTES);
  });

  it('cuts pages at UTF-8 character boundaries', async () => {
    writeFileSync(file, 'aä€😀z'); // 1 + 2 + 3 + 4 + 1 bytes
    const p1 = await readLogPage(file, 'stdout', { offset: 0, limit: 4 }); // 'a', 'ä', first byte of '€'
    expect(p1.data).toBe('aä');
    expect(p1.nextOffset).toBe(3);
    const p2 = await readLogPage(file, 'stdout', { offset: p1.nextOffset, limit: 5 });
    expect(p2.data).toBe('€');
    const tail = await readLogPage(file, 'stdout', { tail: 3 }); // starts inside '😀'
    expect(tail.data).toBe('z');
    expect(tail.offset).toBe(10);
  });

  it('reports missing files without error', async () => {
    expect(await readLogPage(path.join(dir, 'nope.log'), 'stderr')).toMatchObject({ exists: false, size: 0, data: '', eof: true });
  });
});
