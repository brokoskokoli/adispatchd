import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { OrchestratorError } from './errors.js';
import { ConsoleLogger, isSecretKey, MemoryLogger, REDACTED, redactValue, SecretRedactor } from './logger.js';

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

  it('anchors secret key detection at segment boundaries', () => {
    for (const key of ['password', 'passwd', 'GH_TOKEN', 'accessToken', 'access_token', 'x-api-key', 'apiKey',
      'privateKey', 'private_key', 'client_secret', 'Authorization', 'credentials', 'cookie', 'db.pass']) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['passed', 'bypass', 'tokens_used', 'tokenExpiresAt', 'secretary', 'keyboard', 'cookies_enabled']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('renders shared references repeatedly and only marks real cycles', () => {
    const shared = { a: 1 };
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(redactValue({ first: shared, second: shared, list: [shared, shared] })).toEqual({
      first: { a: 1 },
      second: { a: 1 },
      list: [{ a: 1 }, { a: 1 }],
    });
    expect(redactValue(cyclic)).toEqual({ name: 'x', self: '[Circular]' });
  });

  it('includes redacted OrchestratorError details', () => {
    const redactor = new SecretRedactor();
    redactor.add('topsecretvalue');
    const err = new OrchestratorError('x_failed', 'failed', { details: { url: 'https://h/?q=topsecretvalue', token: 'abc' } });
    expect(redactValue(err, redactor.asRedactor)).toMatchObject({
      name: 'OrchestratorError',
      code: 'x_failed',
      details: { url: `https://h/?q=${REDACTED}`, token: REDACTED },
    });
  });

  it('MemoryLogger captures redacted records across children', () => {
    const redactor = new SecretRedactor();
    redactor.add('s3cr3t-value');
    const logger = new MemoryLogger(redactor.asRedactor);
    logger.child({ run: 'r1' }).warn('leak s3cr3t-value', { detail: 's3cr3t-value' });
    expect(logger.records).toEqual([{ level: 'warn', msg: `leak ${REDACTED}`, fields: { run: 'r1', detail: REDACTED } }]);
  });
});
