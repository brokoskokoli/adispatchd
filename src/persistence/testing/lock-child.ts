/**
 * Child-process fixture for instance-lock tests. Uses the real
 * `acquireInstanceLock`. Usage: `node --import tsx lock-child.ts <dataDir> <mode>`
 * - `probe`: try once, print `locked` or `busy`, exit.
 * - `hold`: acquire, print `locked`, keep running until killed.
 * - `hold-gc` (needs `--expose-gc`): acquire, drop the handle, force GC, print `locked`, keep running.
 */
import { InstanceLockedError } from '../errors.js';
import { acquireInstanceLock } from '../instance-lock.js';

const [dataDir, mode] = process.argv.slice(2);
if (!dataDir || !mode) throw new Error('usage: lock-child.ts <dataDir> <probe|hold|hold-gc>');

function tryAcquire(dir: string): boolean {
  try {
    acquireInstanceLock(dir);
    return true;
  } catch (err) {
    if (err instanceof InstanceLockedError) return false;
    throw err;
  }
}

if (mode === 'probe') {
  process.stdout.write(tryAcquire(dataDir) ? 'locked' : 'busy');
  process.exit(0);
}

if (mode === 'hold') {
  acquireInstanceLock(dataDir);
} else if (mode === 'hold-gc') {
  (() => {
    acquireInstanceLock(dataDir); // handle intentionally dropped
  })();
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('run with --expose-gc');
  for (let i = 0; i < 5; i++) gc();
} else {
  throw new Error(`unknown mode ${mode}`);
}
process.stdout.write('locked\n');
setInterval(() => {}, 1000);
