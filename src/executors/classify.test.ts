import { describe, expect, it } from 'vitest';
import type { ExecutionOutcome, ResultFileStatus } from '../core/index.js';
import { classifyOutcome } from './classify.js';

const valid = (result: 'success' | 'failure'): ResultFileStatus => ({
  state: 'valid',
  result: { schema_version: 1, result, message: `m-${result}` },
});
const missing: ResultFileStatus = { state: 'missing' };
const invalid: ResultFileStatus = { state: 'invalid', error: 'result file is not valid JSON' };
const ALL_FILES: ResultFileStatus[] = [valid('success'), valid('failure'), missing, invalid];

function outcome(overrides: Partial<ExecutionOutcome>): ExecutionOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    resultFile: missing,
    startedAt: new Date(0),
    finishedAt: new Date(1),
    logs: { stdoutBytes: 0, stderrBytes: 0, truncated: false },
    ...overrides,
  };
}

describe('classifyOutcome (Spec §8.2 table)', () => {
  it('exit 0 + result success → completed/success', () => {
    const c = classifyOutcome(outcome({ resultFile: valid('success') }));
    expect(c).toMatchObject({ status: 'completed', businessResult: 'success' });
    expect(c.result?.message).toBe('m-success');
  });

  it('exit 0 + result failure → completed/failure', () => {
    const c = classifyOutcome(outcome({ resultFile: valid('failure') }));
    expect(c).toMatchObject({ status: 'completed', businessResult: 'failure' });
    expect(c.result?.result).toBe('failure');
  });

  it('exit 0 + no result file → completed/implicit success', () => {
    expect(classifyOutcome(outcome({ resultFile: missing }))).toEqual({
      status: 'completed',
      businessResult: 'success',
      reason: 'exit code 0, no result file',
      result: null,
    });
  });

  it('exit 0 + invalid result file → crashed (protocol error)', () => {
    const c = classifyOutcome(outcome({ resultFile: invalid }));
    expect(c).toMatchObject({ status: 'crashed', businessResult: null, result: null });
    expect(c.reason).toContain('protocol error');
  });

  it.each([1, 2, 127, 255])('exit %i + any result file → crashed, result file never overrides', (code) => {
    for (const resultFile of ALL_FILES) {
      const c = classifyOutcome(outcome({ exitCode: code, resultFile }));
      expect(c).toEqual({ status: 'crashed', businessResult: null, reason: `exit code ${code}`, result: null });
    }
  });

  it('terminated by signal (not cancel/timeout) + any result file → crashed', () => {
    for (const resultFile of ALL_FILES) {
      const c = classifyOutcome(outcome({ exitCode: null, signal: 'SIGKILL', resultFile }));
      expect(c).toMatchObject({ status: 'crashed', businessResult: null, result: null });
      expect(c.reason).toContain('SIGKILL');
    }
  });

  it('spawn error → start_error', () => {
    const c = classifyOutcome(
      outcome({ exitCode: null, spawnError: { code: 'ENOENT', message: 'spawn /x ENOENT' } }),
    );
    expect(c).toMatchObject({ status: 'start_error', businessResult: null, result: null });
    expect(c.reason).toContain('ENOENT');
  });

  it('timeout + any exit/signal/result file → timed_out', () => {
    for (const resultFile of ALL_FILES) {
      for (const end of [{ exitCode: null, signal: 'SIGTERM' as const }, { exitCode: 0, signal: null }, { exitCode: 143, signal: null }]) {
        expect(classifyOutcome(outcome({ ...end, timedOut: 'max_duration', resultFile }))).toMatchObject({
          status: 'timed_out',
          businessResult: null,
          reason: 'max duration exceeded',
        });
        expect(classifyOutcome(outcome({ ...end, timedOut: 'idle', resultFile }))).toMatchObject({
          status: 'timed_out',
          reason: 'idle timeout exceeded',
        });
      }
    }
  });

  it('controlled cancel + any exit/signal/result file → cancelled', () => {
    for (const resultFile of ALL_FILES) {
      for (const end of [{ exitCode: null, signal: 'SIGKILL' as const }, { exitCode: 0, signal: null }, { exitCode: 1, signal: null }]) {
        expect(classifyOutcome(outcome({ ...end, cancelled: true, resultFile }))).toEqual({
          status: 'cancelled',
          businessResult: null,
          reason: 'cancelled',
          result: null,
        });
      }
    }
  });

  it('no exit code and no signal → crashed', () => {
    expect(classifyOutcome(outcome({ exitCode: null })).status).toBe('crashed');
  });

  it('only completed outcomes carry a business result', () => {
    for (const resultFile of ALL_FILES) {
      for (const o of [
        outcome({ exitCode: 3, resultFile }),
        outcome({ exitCode: null, signal: 'SIGSEGV', resultFile }),
        outcome({ cancelled: true, resultFile }),
        outcome({ timedOut: 'idle', resultFile }),
      ]) {
        const c = classifyOutcome(o);
        expect(c.businessResult).toBeNull();
        expect(c.result).toBeNull();
      }
    }
  });
});
