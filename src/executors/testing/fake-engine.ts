/**
 * Fake container engine for tests (WI-19): an executable script that records
 * every call (argv + environment) and simulates the docker/podman CLI:
 *
 * - `run`: parses `--name`, `--label`, `--mount type=bind,source=…,target=…`,
 *   `--workdir`, `-e NAME[=value]` and runs the container command **on the
 *   host** with the container environment, translating container paths in
 *   env values, the workdir and the arguments to the mount sources (so the
 *   worker writes the result file into the mounted output directory). Its
 *   exit code is the command's (143/137 after a signal, like docker).
 * - `stop -t <s> <name>`: SIGTERM to the command, SIGKILL after `s` seconds.
 * - `ps -a --filter label=k=v --format {{.Names}}`, `rm -f <name>`, `--version`.
 *
 * Not part of the build output.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContainerEngineClient } from '../container-engine.js';

/** One recorded engine invocation. */
export interface FakeEngineCall {
  argv: string[];
  env: Record<string, string>;
}

const SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const STATE = __STATE__;
const dir = path.join(STATE, 'containers');
fs.mkdirSync(dir, { recursive: true });
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(STATE, 'calls.jsonl'), JSON.stringify({ argv, env: process.env }) + '\n');
const sub = argv[0];
const file = (name) => path.join(dir, encodeURIComponent(name) + '.json');
const read = (name) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failMode = () => { try { return fs.readFileSync(path.join(STATE, 'fail'), 'utf8').trim(); } catch { return ''; } };

async function main() {
  if (failMode() === 'all' || failMode() === sub) { process.stderr.write('Cannot connect to the fake engine daemon\n'); process.exit(1); }
  if (sub === '--version') { process.stdout.write('Fake engine version 1.0\n'); return 0; }
  if (sub === 'ps') {
    const fi = argv.indexOf('--filter');
    const want = fi >= 0 ? argv[fi + 1].replace(/^label=/, '') : null;
    for (const f of fs.readdirSync(dir)) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!want || c.labels.includes(want)) process.stdout.write(c.name + '\n');
    }
    return 0;
  }
  if (sub === 'stop' || sub === 'rm') {
    const name = argv[argv.length - 1];
    const c = read(name);
    if (!c) { process.stderr.write('Error response from daemon: No such container: ' + name + '\n'); return 1; }
    if (sub === 'stop') {
      const ti = argv.indexOf('-t');
      const seconds = ti >= 0 ? Number(argv[ti + 1]) : 10;
      if (alive(c.pid)) { try { process.kill(c.pid, 'SIGTERM'); } catch {} }
      const until = Date.now() + seconds * 1000;
      while (alive(c.pid) && Date.now() < until) await sleep(20);
      if (alive(c.pid)) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
      while (alive(c.pid)) await sleep(20);
      // A stopped --rm container disappears; others stay until "rm".
      if (c.rm) fs.rmSync(file(name), { force: true });
      process.stdout.write(name + '\n');
      return 0;
    }
    if (alive(c.pid)) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(file(name), { force: true });
    process.stdout.write(name + '\n');
    return 0;
  }
  if (sub === 'run') {
    let i = 1;
    const opts = { name: '', labels: [], mounts: [], env: [], workdir: null, rm: false };
    const withValue = new Set(['--name', '--label', '--mount', '--workdir', '-w', '-e', '--cap-drop', '--security-opt', '--user', '--userns', '--network', '--memory', '--cpus', '--pids-limit', '--pull']);
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--rm') { opts.rm = true; continue; }
      if (a === '--init') continue;
      if (!withValue.has(a)) break;
      const v = argv[++i];
      if (a === '--name') opts.name = v;
      else if (a === '--label') opts.labels.push(v);
      else if (a === '--mount') {
        const m = Object.fromEntries(v.split(',').map((kv) => { const j = kv.indexOf('='); return j < 0 ? [kv, 'true'] : [kv.slice(0, j), kv.slice(j + 1)]; }));
        opts.mounts.push({ source: m.source, target: m.target, readonly: m.readonly === 'true' });
      } else if (a === '-e') opts.env.push(v);
      else if (a === '--workdir' || a === '-w') opts.workdir = v;
    }
    const image = argv[i];
    const command = argv.slice(i + 1);
    if (read(opts.name)) { process.stderr.write('Conflict. The container name "' + opts.name + '" is already in use\n'); return 125; }
    if (image === 'fake/missing') { process.stderr.write('Unable to find image ' + image + '\n'); return 125; }
    if (image === 'fake/slow-pull') {
      // The "daemon" creates the container late, independent of this CLI process (cancel-during-pull race).
      const json = JSON.stringify({ name: opts.name, labels: opts.labels, pid: '__PID__', rm: false }).replace('"__PID__"', '__PID__');
      const creator = spawn('sh', ['-c', 'sleep 0.3; printf "%s" "$1" | sed "s/__PID__/$$/" > "$2"; exec sleep 60', 'sh', json, file(opts.name)], { detached: true, stdio: 'ignore' });
      creator.unref();
      fs.appendFileSync(path.join(STATE, 'late-pids'), creator.pid + '\n');
      for (;;) await sleep(1000);
    }
    const mounts = [...opts.mounts].sort((a, b) => b.target.length - a.target.length);
    const toHost = (p) => {
      for (const m of mounts) {
        if (p === m.target) return m.source;
        if (p.startsWith(m.target + '/')) return m.source + p.slice(m.target.length);
      }
      return p;
    };
    const translate = (s) => s.replace(/(^|[\s=:])(\/[^\s:]*)/g, (all, pre, p) => pre + toHost(p));
    const env = { PATH: process.env.PATH };
    for (const e of opts.env) {
      const j = e.indexOf('=');
      if (j < 0) { if (e in process.env) env[e] = translate(process.env[e]); }
      else env[e.slice(0, j)] = translate(e.slice(j + 1));
    }
    if (command.length === 0) { process.stderr.write('no command\n'); return 125; }
    // Register the container before its command can print anything (a real engine creates it before starting it).
    fs.writeFileSync(file(opts.name), JSON.stringify({ name: opts.name, labels: opts.labels, pid: null, rm: opts.rm }));
    const child = spawn(command[0], command.slice(1).map(translate), { cwd: toHost(opts.workdir || '/'), env, stdio: 'inherit' });
    fs.writeFileSync(file(opts.name), JSON.stringify({ name: opts.name, labels: opts.labels, pid: child.pid, rm: opts.rm }));
    const code = await new Promise((resolve) => {
      child.on('error', (err) => { process.stderr.write(String(err) + '\n'); resolve(err.code === 'EACCES' ? 126 : 127); });
      child.on('exit', (c, sig) => resolve(sig ? 128 + ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }[sig] || 1) : c));
    });
    if (opts.rm) fs.rmSync(file(opts.name), { force: true });
    return code;
  }
  process.stderr.write('fake engine: unsupported command ' + sub + '\n');
  return 2;
}
main().then((code) => process.exit(code), (err) => { process.stderr.write(String(err) + '\n'); process.exit(3); });
`;

/** A fake engine installation in a temp dir. */
export interface FakeEngine {
  /** Directory containing the executables `docker` and `podman`. */
  binDir: string;
  /** Path of the fake `docker`. */
  docker: string;
  /** State directory (calls, containers). */
  stateDir: string;
  /** Client using the fake binaries. */
  client(options?: { commandTimeoutMs?: number }): ContainerEngineClient;
  /** All recorded calls, in order. */
  calls(): Promise<FakeEngineCall[]>;
  /** Names of the simulated, existing containers. */
  containers(): Promise<string[]>;
  /** Make the next calls fail ("daemon unreachable"): `all`, a sub-command (`ps`, `stop`, …) or `''` to heal. */
  fail(mode: string): Promise<void>;
  /**
   * Simulate a container left over by a previous daemon process: a detached
   * `sleep` registered under `name` with the given labels.
   */
  orphan(name: string, labels: readonly string[]): Promise<ChildProcess>;
  cleanup(): Promise<void>;
}

/** Install a fake engine (`docker` and `podman`) in a new temp dir. */
export async function createFakeEngine(): Promise<FakeEngine> {
  const root = await mkdtemp(path.join(tmpdir(), 'adispatch-fake-engine-'));
  const binDir = path.join(root, 'bin');
  const stateDir = path.join(root, 'state');
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(stateDir, 'containers'), { recursive: true });
  const script = `#!${process.execPath}\n${SCRIPT.replace('__STATE__', JSON.stringify(stateDir))}`;
  const docker = path.join(binDir, 'docker');
  for (const name of ['docker', 'podman']) {
    const file = path.join(binDir, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  const orphans: ChildProcess[] = [];
  return {
    binDir,
    docker,
    stateDir,
    client: (options = {}) =>
      new ContainerEngineClient({ binaries: { docker, podman: path.join(binDir, 'podman') }, ...options }),
    async calls() {
      const text = await readFile(path.join(stateDir, 'calls.jsonl'), 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as FakeEngineCall);
    },
    async containers() {
      const files = await readdir(path.join(stateDir, 'containers'));
      return files.map((f) => decodeURIComponent(f.replace(/\.json$/, ''))).sort();
    },
    async fail(mode) {
      await writeFile(path.join(stateDir, 'fail'), mode);
    },
    async orphan(name, labels) {
      const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      child.unref();
      orphans.push(child);
      await writeFile(
        path.join(stateDir, 'containers', `${encodeURIComponent(name)}.json`),
        JSON.stringify({ name, labels, pid: child.pid, rm: false }),
      );
      return child;
    },
    async cleanup() {
      for (const child of orphans) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      const late = await readFile(path.join(stateDir, 'late-pids'), 'utf8').catch(() => '');
      for (const pid of late.split('\n').filter((l) => l !== '')) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
