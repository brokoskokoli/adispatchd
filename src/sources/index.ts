/**
 * Component `sources` – public API (WI-06).
 * Other components import from this module only. Test doubles live in
 * `src/sources/github/testing/` (not part of the build).
 */
export * from './github/index.js';
export * from './artifacts/index.js';
