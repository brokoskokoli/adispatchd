/**
 * Component `ui` – public API (WI-11). The browser code lives in
 * `src/ui/client` + `src/ui/shared` and is compiled by `tsconfig.ui.json`;
 * `npm run build` writes the complete static UI to `dist/ui/public`.
 * Other components import from this module only.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Entry module of the built UI, relative to the UI directory. */
export const UI_ENTRY = 'js/client/app.js';

/** True if `dir` contains a complete built UI (index.html + compiled entry). */
export function isUiDir(dir: string): boolean {
  return existsSync(path.join(dir, 'index.html')) && existsSync(path.join(dir, UI_ENTRY));
}

/**
 * Locate the built web UI:
 * 1. `<this module>/public` – `dist/ui/public` when running from `dist/`;
 * 2. `<repo>/dist/ui/public` – when running from sources (`tsx src/cli/main.ts`)
 *    after `npm run build` / `npm run build:ui`.
 * Returns `null` if no built UI exists (the API then runs without UI).
 */
export function resolveUiDir(moduleUrl: string = import.meta.url): string | null {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [path.join(here, 'public'), path.resolve(here, '..', '..', 'dist', 'ui', 'public')];
  return candidates.find(isUiDir) ?? null;
}
