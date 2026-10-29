/** Errors of hub operations; `status` is the HTTP status used by the control socket. */
import { OrchestratorError } from '../core/index.js';

export class HubError extends OrchestratorError {
  constructor(
    code: 'unknown_workspace' | 'invalid_state' | 'shutting_down' | 'not_found' | 'bad_request',
    message: string,
    readonly status: number,
  ) {
    super(code, message);
  }
}
