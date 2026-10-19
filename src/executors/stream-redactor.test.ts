import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, StreamRedactor } from './stream-redactor.js';

function run(redactor: StreamRedactor, chunks: (string | Buffer)[]): string {
  const out: Buffer[] = [];
  for (const c of chunks) out.push(redactor.push(typeof c === 'string' ? Buffer.from(c) : c));
  out.push(redactor.flush());
  return Buffer.concat(out).toString('utf8');
}

describe('StreamRedactor', () => {
  it('passes data through unchanged without secrets', () => {
    const r = new StreamRedactor([]);
    const buf = Buffer.from([0xff, 0xfe, 0x41]);
    expect(r.active).toBe(false);
    expect(r.push(buf)).toBe(buf);
  });

  it('redacts a secret inside one chunk', () => {
    expect(run(new StreamRedactor(['s3cr3t-value']), ['token=s3cr3t-value done\n'])).toBe(
      `token=${REDACTION_MARKER} done\n`,
    );
  });

  it('redacts a secret split across chunk boundaries', () => {
    const secret = 'ghs_abcdefghijklmnop';
    for (let cut1 = 1; cut1 < secret.length; cut1 += 3) {
      const r = new StreamRedactor([secret]);
      const text = `x ${secret} y`;
      const a = text.slice(0, 2 + cut1);
      const b = text.slice(2 + cut1, 2 + cut1 + 2);
      const c = text.slice(2 + cut1 + 2);
      expect(run(r, [a, b, c])).toBe(`x ${REDACTION_MARKER} y`);
    }
  });

  it('only withholds a tail that can start a secret', () => {
    const r = new StreamRedactor(['abcdef']);
    expect(r.push(Buffer.from('hello xyz')).toString()).toBe('hello xyz');
    expect(r.push(Buffer.from('hello abc')).toString()).toBe('hello ');
    expect(r.push(Buffer.from('dXf')).toString()).toBe('abcdXf');
    expect(r.flush().toString()).toBe('');
  });

  it('flushes a withheld partial secret at the end', () => {
    const r = new StreamRedactor(['abcdef']);
    expect(run(r, ['end: abc'])).toBe('end: abc');
  });

  it('redacts multi-byte secrets and keeps other bytes untouched', () => {
    const secret = 'pässwörd-ü';
    const r = new StreamRedactor([secret]);
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from(`a ${secret} b`)]);
    const half = 5;
    const out = Buffer.concat([r.push(raw.subarray(0, half)), r.push(raw.subarray(half)), r.flush()]);
    expect(out[0]).toBe(0xff);
    expect(out.subarray(1).toString()).toBe(`a ${REDACTION_MARKER} b`);
  });

  it('redacts the \\n-escaped form of multi-line secrets', () => {
    const pem = '-----BEGIN KEY-----\nAAAA\n-----END KEY-----';
    const out = run(new StreamRedactor([pem]), [`a ${pem.replace(/\n/g, '\\n')} b ${pem}`]);
    expect(out).toBe(`a ${REDACTION_MARKER} b ${REDACTION_MARKER}`);
  });

  it('ignores very short secrets', () => {
    expect(new StreamRedactor(['abc']).active).toBe(false);
  });

  it('prefers the longest secret', () => {
    expect(run(new StreamRedactor(['abcd', 'abcdefgh']), ['abcdefgh abcd'])).toBe(
      `${REDACTION_MARKER} ${REDACTION_MARKER}`,
    );
  });

  it('redacts secrets registered later (renewed tokens, WI-18)', () => {
    const r = new StreamRedactor(['first-token']);
    expect(r.push(Buffer.from('a first-token b ')).toString()).toBe(`a ${REDACTION_MARKER} b `);
    r.add('second-token');
    r.add('second-token'); // duplicates are ignored
    r.add('xy'); // too short
    expect(run(r, ['c second-token d first-token xy'])).toBe(`c ${REDACTION_MARKER} d ${REDACTION_MARKER} xy`);
  });
});
