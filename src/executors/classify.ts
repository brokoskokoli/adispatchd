/**
 * Result classification of a main worker execution (Spec §8.2).
 *
 * Binding rules (docs/conventions.md: §8.2 wins over §24.2):
 * - A non-zero exit code is ALWAYS a technical failure (`crashed`), whatever
 *   the result file says.
 * - A business `failure` is only ever derived from a valid result file with
 *   `result: "failure"` after exit code 0.
 */
import type { ExecutionOutcome, OutcomeClassification } from '../core/index.js';

/**
 * Classify the raw facts of an execution into the final run outcome,
 * exactly following the table in Spec §8.2. Pure function.
 *
 * Precedence (first match wins):
 * 1. spawn error → `start_error`
 * 2. controlled cancel → `cancelled`
 * 3. timeout → `timed_out`
 * 4. terminated by a signal → `crashed`
 * 5. exit code ≠ 0 → `crashed` (result file ignored)
 * 6. exit code 0 + valid result file → `completed` with its `success`/`failure`
 * 7. exit code 0 + no result file → `completed` / implicit `success`
 * 8. exit code 0 + invalid/unreadable result file → `crashed` (protocol error)
 */
export function classifyOutcome(outcome: ExecutionOutcome): OutcomeClassification {
  if (outcome.spawnError) {
    const code = outcome.spawnError.code ? ` (${outcome.spawnError.code})` : '';
    return technical('start_error', `worker could not be started${code}: ${outcome.spawnError.message}`);
  }
  if (outcome.cancelled) {
    return technical('cancelled', 'cancelled');
  }
  if (outcome.timedOut !== false) {
    return technical('timed_out', outcome.timedOut === 'idle' ? 'idle timeout exceeded' : 'max duration exceeded');
  }
  if (outcome.signal !== null) {
    return technical('crashed', `terminated by signal ${outcome.signal}`);
  }
  if (outcome.exitCode === null) {
    return technical('crashed', 'process ended without exit code');
  }
  if (outcome.exitCode !== 0) {
    return technical('crashed', `exit code ${outcome.exitCode}`);
  }
  switch (outcome.resultFile.state) {
    case 'valid': {
      const result = outcome.resultFile.result;
      return {
        status: 'completed',
        businessResult: result.result,
        reason: result.result === 'success' ? 'exit code 0, result success' : 'exit code 0, result failure',
        result,
      };
    }
    case 'missing':
      return { status: 'completed', businessResult: 'success', reason: 'exit code 0, no result file', result: null };
    case 'invalid':
      return technical('crashed', `protocol error: ${outcome.resultFile.error}`);
  }
}

function technical(status: 'crashed' | 'start_error' | 'timed_out' | 'cancelled', reason: string): OutcomeClassification {
  return { status, businessResult: null, reason, result: null };
}
