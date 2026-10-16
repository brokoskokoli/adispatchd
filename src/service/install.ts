/**
 * `service install | status | uninstall` (Spec §4, §14, §20.1): plans as
 * plain data (pure, testable, printable with `--dry-run`) plus an executor
 * that applies a plan through an injectable {@link SystemRunner}.
 *
 * Install never touches the contents of config-dir/data-dir beyond ownership
 * and permissions, never overwrites an existing environment file and never
 * deletes anything on uninstall except the unit file.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, errorMessage } from '../core/index.js';
import { renderSystemdUnit, type UnitOptions } from './unit.js';

/** Error of the service commands (`code` = `service_*`). */
export class ServiceError extends OrchestratorError {}

/** One step of a plan. */
export type ServiceStep =
  | { kind: 'exec'; description: string; argv: string[]; /** failure is reported but does not abort */ optional?: boolean }
  | { kind: 'write'; description: string; path: string; content: string; mode: number }
  | { kind: 'remove'; description: string; path: string };

/** A plan plus notes for the operator. */
export interface ServicePlan {
  steps: ServiceStep[];
  /** Hints printed before/after (e.g. missing user in a dry run). */
  notes: string[];
}

/** Input of {@link planInstall}. */
export interface InstallPlanInput {
  unit: UnitOptions;
  /** Directory of unit files (default `/etc/systemd/system`). */
  unitDir: string;
  /** Create the service user if it does not exist. */
  createUser: boolean;
  /** Whether the user exists (determined by the caller). */
  userExists: boolean;
  /** Whether the environment file exists already (it is never overwritten). */
  envFileExists: boolean;
  /** `systemctl enable --now` instead of only `enable`. */
  startNow: boolean;
  /** Dry run: report a missing user as a note instead of failing. */
  dryRun: boolean;
}

/** Path of the unit file. */
export function unitFilePath(unitDir: string, unitName: string): string {
  return path.join(unitDir, `${unitName}.service`);
}

/** Template of a new environment file (no secrets, only placeholders). */
export function environmentFileTemplate(unitName: string): string {
  return [
    `# Environment of the ${unitName} service (loaded via EnvironmentFile=).`,
    '# Keep this file at mode 0640, owner root, group = service group. Never commit it.',
    '# GitHub App private keys referenced by identities.yaml (private_key_env), PEM with \\n escapes or quoted:',
    '# GITHUB_MAINTAINER_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----"',
    '# Webhook URLs/headers referenced by notifications.channels (url_env / headers_env):',
    '# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...',
    '',
  ].join('\n');
}

/** Plan `service install`. Throws {@link ServiceError} if the user is missing and `createUser` is false (not in dry runs). */
export function planInstall(input: InstallPlanInput): ServicePlan {
  const { unit } = input;
  const content = renderSystemdUnit(unit);
  const steps: ServiceStep[] = [];
  const notes: string[] = [];
  const owner = `${unit.user}:${unit.group}`;

  if (!input.userExists) {
    if (input.createUser) {
      steps.push({
        kind: 'exec',
        description: `create system user ${unit.user}`,
        argv: [
          'useradd',
          '--system',
          ...(unit.group === unit.user ? ['--user-group'] : ['--gid', unit.group]),
          '--home-dir',
          unit.dataDir,
          '--no-create-home',
          '--shell',
          '/usr/sbin/nologin',
          unit.user,
        ],
      });
    } else {
      const hint =
        `user "${unit.user}" does not exist – rerun with --create-user or create it yourself: ` +
        `useradd --system --user-group --home-dir ${unit.dataDir} --no-create-home --shell /usr/sbin/nologin ${unit.user}`;
      if (!input.dryRun) throw new ServiceError('service_user_missing', hint);
      notes.push(hint);
    }
  }

  steps.push(
    {
      kind: 'exec',
      description: `create data dir ${unit.dataDir} (owner ${owner}, 0750)`,
      argv: ['install', '-d', '-m', '0750', '-o', unit.user, '-g', unit.group, unit.dataDir],
    },
    {
      kind: 'exec',
      description: `data dir owned by the service user (database, logs, runs, workspaces)`,
      argv: ['chown', '-R', owner, unit.dataDir],
    },
    {
      kind: 'exec',
      description: `config dir owned by root, readable by group ${unit.group} (the service cannot modify its own configuration/scripts)`,
      argv: ['chown', '-R', `root:${unit.group}`, unit.configDir],
    },
    {
      kind: 'exec',
      description: 'config dir permissions: dirs 0750, files 0640 (executable scripts keep their x bit for the group)',
      argv: ['chmod', '-R', 'u=rwX,g=rX,o=', unit.configDir],
    },
  );

  if (unit.envFile !== null) {
    if (!input.envFileExists) {
      steps.push({
        kind: 'write',
        description: `create environment file template ${unit.envFile}`,
        path: unit.envFile,
        content: environmentFileTemplate(unit.unitName),
        mode: 0o640,
      });
    } else {
      notes.push(`environment file ${unit.envFile} exists and is kept unchanged (only owner/mode are set)`);
    }
    steps.push(
      { kind: 'exec', description: `environment file owned by root:${unit.group}`, argv: ['chown', `root:${unit.group}`, unit.envFile] },
      { kind: 'exec', description: 'environment file mode 0640', argv: ['chmod', '0640', unit.envFile] },
    );
  }

  const file = unitFilePath(input.unitDir, unit.unitName);
  steps.push(
    { kind: 'write', description: `write unit file ${file}`, path: file, content, mode: 0o644 },
    { kind: 'exec', description: 'reload systemd units', argv: ['systemctl', 'daemon-reload'] },
    {
      kind: 'exec',
      description: input.startNow ? `enable and start ${unit.unitName}` : `enable ${unit.unitName} (start at boot)`,
      argv: ['systemctl', 'enable', ...(input.startNow ? ['--now'] : []), `${unit.unitName}.service`],
    },
  );
  if (!input.startNow) notes.push(`start the service with: systemctl start ${unit.unitName}`);
  return { steps, notes };
}

/** Plan `service uninstall`: stop + disable, remove the unit file, reload. Config, data and user stay. */
export function planUninstall(input: { unitName: string; unitDir: string }): ServicePlan {
  const file = unitFilePath(input.unitDir, input.unitName);
  return {
    steps: [
      {
        kind: 'exec',
        description: `stop (SIGTERM → drain) and disable ${input.unitName}`,
        argv: ['systemctl', 'disable', '--now', `${input.unitName}.service`],
        optional: true,
      },
      { kind: 'remove', description: `remove unit file ${file}`, path: file },
      { kind: 'exec', description: 'reload systemd units', argv: ['systemctl', 'daemon-reload'] },
    ],
    notes: [
      'config dir, data dir (database, logs, workspaces) and the service user are kept; remove them manually if no longer needed',
      `for a graceful stop of long runs, run "agent-orchestrator drain --wait" before uninstalling`,
    ],
  };
}

/** Human-readable listing of a plan (for `--dry-run`). */
export function formatPlan(plan: ServicePlan): string {
  const out: string[] = [];
  plan.steps.forEach((s, i) => {
    const n = `${i + 1}.`;
    if (s.kind === 'exec') out.push(`${n} ${s.description}\n     $ ${s.argv.map(shellQuote).join(' ')}`);
    else if (s.kind === 'write') out.push(`${n} ${s.description} (mode ${s.mode.toString(8).padStart(4, '0')})`);
    else out.push(`${n} ${s.description}\n     $ rm -f ${shellQuote(s.path)}`);
  });
  return `${out.join('\n')}\n`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Result of one command. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** System side effects (injectable; tests never use the real one for install/uninstall). */
export interface SystemRunner {
  exec(argv: string[]): Promise<ExecResult>;
  writeFile(file: string, content: string, mode: number): Promise<void>;
  remove(file: string): Promise<void>;
  exists(file: string): boolean;
}

/** Real runner (`execFile`, no shell). */
export const systemRunner: SystemRunner = {
  exec: (argv) =>
    new Promise((resolve) => {
      const [cmd, ...args] = argv;
      if (!cmd) {
        resolve({ code: 127, stdout: '', stderr: 'empty command' });
        return;
      }
      execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 127;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || errorMessage(err) });
      });
    }),
  writeFile: async (file, content, mode) => {
    await writeFile(file, content, { mode });
    await chmod(file, mode);
  },
  remove: (file) => rm(file, { force: true }),
  exists: (file) => existsSync(file),
};

/** Apply a plan step by step; stops at the first failing non-optional step. */
export async function executePlan(
  plan: ServicePlan,
  runner: SystemRunner,
  log: (line: string) => void,
): Promise<{ ok: boolean; failedStep?: ServiceStep; error?: string }> {
  for (const step of plan.steps) {
    log(`- ${step.description}\n`);
    try {
      if (step.kind === 'exec') {
        const r = await runner.exec(step.argv);
        if (r.code !== 0) {
          const msg = `${step.argv.join(' ')} exited with ${r.code}: ${r.stderr.trim()}`;
          if (step.optional) {
            log(`  (ignored) ${msg}\n`);
            continue;
          }
          return { ok: false, failedStep: step, error: msg };
        }
      } else if (step.kind === 'write') {
        await runner.writeFile(step.path, step.content, step.mode);
      } else {
        await runner.remove(step.path);
      }
    } catch (err) {
      return { ok: false, failedStep: step, error: errorMessage(err) };
    }
  }
  return { ok: true };
}
