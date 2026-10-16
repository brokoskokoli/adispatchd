#!/usr/bin/env node
// Build the web UI (WI-11): copy the static files of src/ui/public and compile
// the browser TypeScript (src/ui/client + src/ui/shared) with tsc into <out>/js.
//
// Usage: node scripts/build-ui.mjs [outDir]   (default: dist/ui/public)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'ui', 'public'));
const publicDir = path.join(root, 'src', 'ui', 'public');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
cpSync(publicDir, outDir, { recursive: true });

const require = createRequire(import.meta.url);
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
const res = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.ui.json'), '--outDir', path.join(outDir, 'js')], {
  cwd: root,
  stdio: 'inherit',
});
if (res.status !== 0) {
  console.error('build-ui: tsc failed');
  process.exit(res.status ?? 1);
}
