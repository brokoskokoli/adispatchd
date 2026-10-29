/**
 * Errors of the artifacts component. All extend {@link OrchestratorError};
 * the API maps them via `code`:
 * - `artifact_not_found` – unknown artifact (HTTP 404)
 * - `artifact_file_not_found` – no such (safe, regular) file in the artifact (HTTP 404)
 * - `artifact_invalid_path` – malformed file path (HTTP 400)
 * - `artifact_in_use` – an active run uses the artifact as its item (HTTP 409)
 * - `artifact_too_large` – folder too large for a `.zip` download (HTTP 413)
 */
import { OrchestratorError } from '../core/index.js';

export class ArtifactError extends OrchestratorError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details ? { details } : {});
  }
}
