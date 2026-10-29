/** Test doubles for the hub (excluded from the build with the other `testing/` directories). */
import type { ChildHandle, SpawnSpec, WorkspaceSpawner } from '../spawner.js';

/** A child process driven by the test. */
export class FakeChild implements ChildHandle {
  readonly signals: NodeJS.Signals[] = [];
  alive = true;
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null, error?: string) => void> = [];
  private outputListeners: Array<(stream: 'stdout' | 'stderr', chunk: string) => void> = [];
  /** Signals that terminate the process by themselves (like an unhandled SIGKILL). */
  killedBy = new Set<NodeJS.Signals>(['SIGKILL']);

  constructor(
    readonly spec: SpawnSpec,
    readonly pid: number,
  ) {}

  kill(signal: NodeJS.Signals): boolean {
    if (!this.alive) return false;
    this.signals.push(signal);
    if (this.killedBy.has(signal)) this.exit(null, signal);
    return true;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null, error?: string) => void): void {
    this.exitListeners.push(listener);
  }

  onOutput(listener: (stream: 'stdout' | 'stderr', chunk: string) => void): void {
    this.outputListeners.push(listener);
  }

  emit(stream: 'stdout' | 'stderr', chunk: string): void {
    for (const l of this.outputListeners) l(stream, chunk);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null, error?: string): void {
    if (!this.alive) return;
    this.alive = false;
    for (const l of this.exitListeners) l(code, signal, error);
  }
}

/** Spawner that records every started child. */
export class FakeSpawner implements WorkspaceSpawner {
  readonly children: FakeChild[] = [];
  private nextPid = 1000;
  /** Make the next spawn fail (e.g. ENOENT). */
  failNext: Error | null = null;

  spawn(spec: SpawnSpec): FakeChild {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const child = new FakeChild(spec, this.nextPid++);
    this.children.push(child);
    return child;
  }

  /** Children of a workspace, oldest first. */
  of(id: string): FakeChild[] {
    return this.children.filter((c) => c.spec.workspaceId === id);
  }

  /** Newest child of a workspace. */
  last(id: string): FakeChild {
    const c = this.of(id).at(-1);
    if (!c) throw new Error(`no child for ${id}`);
    return c;
  }
}
