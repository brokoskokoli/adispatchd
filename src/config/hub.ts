/**
 * `hub.yaml` (WI-35): configuration of a hub that runs several workspaces
 * (complete, unchanged dispatcher instances) as child processes under one
 * shared run limit.
 *
 * The file lives in the hub's own config dir and is validated as strictly as
 * the other files: unknown keys are errors, IDs/ports/paths must be unique,
 * data dirs must not be nested. Relative paths are resolved against the hub
 * config dir. The configuration of the workspaces themselves is checked by
 * `adispatch hub validate` (see the CLI), not by this loader.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { toAbsolutePath, isWithin } from '../core/index.js';
import { IssueCollector } from './issues.js';
import { finish, parseWith, readYaml, type ParsedFile } from './loader.js';
import type { AuthConfig, ConfigIssue } from './model.js';
import { normalizeAuth } from './normalize.js';
import { authSchema, DEFAULTS } from './schemas.js';
import { validateAuthSection } from './validate.js';

/** File name of the hub configuration inside the hub config dir. */
export const HUB_FILE = 'hub.yaml';

/** Pattern of workspace IDs (lower case letters, digits and hyphens). */
export const WORKSPACE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** Default `hub.max_concurrent`. */
export const DEFAULT_HUB_MAX_CONCURRENT = DEFAULTS.globalMaxConcurrent;
/** Default `hub.server.port` (overview page, hub API and workspace pass-through, WI-36). */
export const DEFAULT_HUB_PORT = 8090;

/** `auth:` without a section: no login (as in config.yaml). */
export const NO_AUTH_CONFIG: AuthConfig = Object.freeze(normalizeAuth(authSchema.parse({}))) as AuthConfig;

const nonEmpty = z.string().trim().min(1, 'Must not be empty');
const port = z.number().int('Must be an integer').min(1, 'Must be between 1 and 65535').max(65535, 'Must be between 1 and 65535');

const hubFileSchema = z.strictObject({
  hub: z
    .strictObject({
      max_concurrent: z.number().int('Must be an integer').positive('Must be greater than 0').default(DEFAULT_HUB_MAX_CONCURRENT),
      server: z
        .strictObject({
          host: nonEmpty.default(DEFAULTS.serverHost),
          port: port.default(DEFAULT_HUB_PORT),
          allowed_hosts: z
            .array(z.string().regex(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/, 'Invalid host name (expected "name" or "name:port")'))
            .default([]),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Login of the hub's web UI and API (same section as in config.yaml, WI-26; WI-36). */
  auth: authSchema.prefault({}),
  workspaces: z
    .array(
      z.strictObject({
        id: z.string().regex(WORKSPACE_ID_PATTERN, 'Invalid workspace ID (lower case letters, digits and hyphens, at most 40 characters)'),
        config_dir: nonEmpty,
        data_dir: nonEmpty,
        port,
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
});

/** One workspace of the hub. */
export interface HubWorkspaceConfig {
  id: string;
  /** Absolute config dir of the workspace instance. */
  configDir: string;
  /** Absolute data dir of the workspace instance. */
  dataDir: string;
  /** Loopback port of the workspace instance (`--port`). */
  port: number;
  /** False = known, but not started by the hub (can be started with `hub workspace start`). */
  enabled: boolean;
}

/** Normalized `hub.yaml`. */
export interface HubConfig {
  /** Absolute hub config dir. */
  configDir: string;
  /** Limit of simultaneously running runs across all workspaces. */
  maxConcurrent: number;
  /** Bind address of the hub's own HTTP server (overview, hub API, workspace pass-through; WI-36). */
  server: { host: string; port: number; allowedHosts: readonly string[] };
  /** Authentication of the hub's HTTP server (WI-36); the workspaces' own `auth` is independent of it. */
  auth: AuthConfig;
  workspaces: readonly HubWorkspaceConfig[];
}

/** Result of {@link loadHubConfig}. Warnings never prevent loading. */
export type LoadHubConfigResult =
  | { ok: true; config: HubConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

/** Options of {@link loadHubConfig}. */
export interface LoadHubConfigOptions {
  /** Data dir of the hub itself (must not overlap with workspace data dirs). */
  dataDir: string;
}

/** Load and validate `hub.yaml` in `configDir`. Never throws for config problems. */
export async function loadHubConfig(configDir: string, options: LoadHubConfigOptions): Promise<LoadHubConfigResult> {
  const dir = toAbsolutePath(configDir);
  const hubDataDir = toAbsolutePath(options.dataDir);
  const issues = new IssueCollector();
  const files = new Map<string, ParsedFile>();
  const parsed = await readYaml(dir, HUB_FILE, issues);
  if (parsed === null) issues.error(HUB_FILE, [], `${HUB_FILE} not found in ${dir} (create it with "adispatch hub init")`);
  if (parsed) files.set(HUB_FILE, parsed);
  const raw = parsed ? parseWith(hubFileSchema, parsed, HUB_FILE, issues) : undefined;
  let config: HubConfig | undefined;
  if (raw) {
    const workspaces: HubWorkspaceConfig[] = raw.workspaces.map((w) => ({
      id: w.id,
      configDir: path.resolve(dir, w.config_dir),
      dataDir: path.resolve(dir, w.data_dir),
      port: w.port,
      enabled: w.enabled,
    }));
    config = {
      configDir: dir,
      maxConcurrent: raw.hub.max_concurrent,
      server: { host: raw.hub.server.host, port: raw.hub.server.port, allowedHosts: raw.hub.server.allowed_hosts.map((h) => h.toLowerCase()) },
      auth: normalizeAuth(raw.auth),
      workspaces,
    };
    validateHub(config, hubDataDir, issues);
    validateAuthSection(config.auth, HUB_FILE, issues, 'the hub CLI works locally over the control socket');
  }
  const resolved = finish(issues, files);
  if (resolved.errors.length > 0 || !config) return { ok: false, errors: resolved.errors, warnings: resolved.warnings };
  return { ok: true, config: Object.freeze({ ...config, workspaces: Object.freeze(config.workspaces.map((w) => Object.freeze(w))) }), warnings: resolved.warnings };
}

/** Cross-checks of `hub.yaml`: uniqueness of IDs/paths/ports and nesting of data dirs. */
/** Resolve symlinks of the longest existing prefix of `p` (the rest is appended unchanged), so nesting is judged on real locations. */
function realish(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function validateHub(config: HubConfig, hubDataDirRaw: string, issues: IssueCollector): void {
  const ws = config.workspaces.map((w) => ({ ...w, configDir: realish(w.configDir), dataDir: realish(w.dataDir) }));
  const hubDataDir = realish(hubDataDirRaw);
  const first = <K extends 'id' | 'configDir' | 'dataDir' | 'port'>(key: K, label: string, yamlKey: string): void => {
    const seen = new Map<unknown, number>();
    ws.forEach((w, i) => {
      const earlier = seen.get(w[key]);
      if (earlier !== undefined) issues.error(HUB_FILE, ['workspaces', i, yamlKey], `Duplicate ${label} "${String(w[key])}" (already used by workspaces[${earlier}])`);
      else seen.set(w[key], i);
    });
  };
  first('id', 'workspace ID', 'id');
  first('configDir', 'config_dir', 'config_dir');
  first('dataDir', 'data_dir', 'data_dir');
  first('port', 'port', 'port');
  ws.forEach((w, i) => {
    if (w.port === config.server.port) {
      issues.error(HUB_FILE, ['workspaces', i, 'port'], `Port ${w.port} is also used by hub.server.port`);
    }
    if (isWithin(hubDataDir, w.dataDir) || isWithin(w.dataDir, hubDataDir)) {
      issues.error(HUB_FILE, ['workspaces', i, 'data_dir'], `data_dir "${w.dataDir}" overlaps with the hub's own data dir "${hubDataDir}"`);
    }
    if (isWithin(w.dataDir, w.configDir) || isWithin(w.configDir, w.dataDir)) {
      issues.error(HUB_FILE, ['workspaces', i, 'data_dir'], `data_dir and config_dir of workspace "${w.id}" must not be nested`);
    }
    for (let j = i + 1; j < ws.length; j++) {
      const other = ws[j] as HubWorkspaceConfig;
      if (w.dataDir !== other.dataDir && (isWithin(other.dataDir, w.dataDir) || isWithin(w.dataDir, other.dataDir))) {
        issues.error(HUB_FILE, ['workspaces', j, 'data_dir'], `data_dir "${other.dataDir}" is nested with the data_dir of workspaces[${i}] ("${w.dataDir}")`);
      }
      if (other.dataDir === w.configDir || other.configDir === w.dataDir) {
        issues.error(HUB_FILE, ['workspaces', j, 'config_dir'], `config_dir/data_dir of workspace "${other.id}" is also used by workspaces[${i}] as its data_dir/config_dir`);
      }
    }
  });
  if (ws.length === 0) issues.warning(HUB_FILE, ['workspaces'], 'No workspaces configured: the hub has nothing to start');
  if (!ws.some((w) => w.enabled) && ws.length > 0) issues.warning(HUB_FILE, ['workspaces'], 'All workspaces are disabled: the hub starts nothing');
  const host = config.server.host.replace(/^\[|\]$/g, '');
  if (!isLoopbackName(config.server.host) && isIP(host) !== 0) {
    issues.warning(HUB_FILE, ['hub', 'server', 'host'], `hub.server.host ${host} is not a loopback address: expose the hub only behind an authenticating reverse proxy or VPN`);
  }
}

function isLoopbackName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}
