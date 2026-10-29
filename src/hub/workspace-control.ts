/**
 * How the hub talks to a workspace instance over its loopback HTTP port
 * (WI-36): readiness probe (`/health`) and the control API (`drain`,
 * `cancel-all`), authenticated with the instance's local control token
 * (`<data-dir>/control.token`, the same mechanism the CLI uses).
 */
import type { FetchLike } from '../core/index.js';
import { CONTROL_TOKEN_HEADER, controlTokenPath, readControlToken } from '../api/index.js';
import type { WorkspaceControl, WorkspaceProbe } from './supervisor.js';

const CSRF_HEADER_NAME = 'x-adispatch-request';

/** `GET /health` on the workspace's port answers with 200. */
export function httpWorkspaceProbe(fetchFn: FetchLike = (input, init) => fetch(input, init), timeoutMs = 2_000): WorkspaceProbe {
  return async (workspace) => {
    const res = await fetchFn(`http://127.0.0.1:${workspace.port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200;
  };
}

/** `POST /api/v1/shutdown/<action>` with the control token; `false` if the instance cannot be reached or refuses. */
export function httpWorkspaceControl(fetchFn: FetchLike = (input, init) => fetch(input, init), timeoutMs = 5_000): WorkspaceControl {
  return async (workspace, action) => {
    const token = readControlToken(controlTokenPath(workspace.dataDir));
    // The token file names the port of the instance it belongs to: never send it anywhere else.
    if (!token || token.port !== workspace.port) return false;
    const res = await fetchFn(`http://127.0.0.1:${workspace.port}/api/v1/shutdown/${action}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        [CSRF_HEADER_NAME]: '1',
        [CONTROL_TOKEN_HEADER]: token.token,
      },
      body: JSON.stringify(action === 'cancel-all' ? { reason: 'stopped by the hub' } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status >= 200 && res.status < 300;
  };
}
