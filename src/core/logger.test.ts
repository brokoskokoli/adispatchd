import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { ConsoleLogger, MemoryLogger, REDACTED, SecretRedactor } from './logger.js';

describe('logger', () => {
  it('writes JSON lines with bindings and respects the level', () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger({ level: 'info', clock: new FakeClock('2026-10-16T00:00:00Z'), sink: (l) => lines.push(l) });
    logger.debug('hidden');
    logger.child({ component: 'scheduler' }).info('polled', { items: 3 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: '2026-10-16T00:00:00.000Z',
      level: 'info',
      msg: 'polled',
      component: 'scheduler',
      items: 3,
    });
  });

  it('redacts registered secrets and secret-looking keys', () => {
    const redactor = new SecretRedactor();
    redactor.add('ghs_supersecrettoken');
    redactor.add('abc'); // too short, ignored
    const lines: string[] = [];
    const logger = new ConsoleLogger({ redact: redactor.asRedactor, sink: (l) => lines.push(l) });
    logger.error('request failed with ghs_supersecrettoken', {
      headers: { authorization: 'Bearer x', accept: 'json' },
      privateKey: '-----BEGIN-----',
      err: new Error('token ghs_supersecrettoken rejected'),
    });
    const line = lines[0] as string;
    expect(line).not.toContain('ghs_supersecrettoken');
    expect(line).not.toContain('Bearer x');
    expect(line).not.toContain('BEGIN');
    const rec = JSON.parse(line);
    expect(rec.msg).toBe(`request failed with ${REDACTED}`);
    expect(rec.headers).toEqual({ authorization: REDACTED, accept: 'json' });
    expect(rec.err.message).toBe(`token ${REDACTED} rejected`);
    expect(redactor.size).toBe(1);
  });

  it('MemoryLogger captures redacted records across children', () => {
    const redactor = new SecretRedactor();
    redactor.add('s3cr3t-value');
    const logger = new MemoryLogger(redactor.asRedactor);
    logger.child({ run: 'r1' }).warn('leak s3cr3t-value', { detail: 's3cr3t-value' });
    expect(logger.records).toEqual([{ level: 'warn', msg: `leak ${REDACTED}`, fields: { run: 'r1', detail: REDACTED } }]);
  });
});
