/**
 * Errors of the run controller. All extend {@link OrchestratorError}; the API
 * (WI-10) maps them via `code`.
 */
import { OrchestratorError } from '../core/index.js';

/**
 * Codes:
 * - `run_controller_not_ready` – recovery has not finished yet (HTTP 503)
 * - `run_controller_not_accepting` – draining / shutting down, no new runs (HTTP 503)
 * - `run_not_reserved` – `startRun` on a run that is not `reserved` (HTTP 409)
 * - `run_already_started` – `startRun` twice for the same run (HTTP 409)
 * - `run_not_active` – cancel of a finished run (HTTP 409)
 * - `run_not_cancellable` – cancel while `finalizing` / `recovery_pending` (HTTP 409)
 * - `run_not_controlled` – active run that this controller does not supervise (HTTP 409)
 * - `run_not_recovery_pending` – `retryRecovery` on a run that is not `recovery_pending` (HTTP 409)
 * - `kill_failed` – the process group could not be terminated (HTTP 500; run stays `cancelling`)
 */
export class RunControllerError extends OrchestratorError {
  constructor(code: string, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(code, message, {
      ...(details ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}
