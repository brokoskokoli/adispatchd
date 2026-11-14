/**
 * `source create-item <source-id>` (WI-40): create an item file in a
 * `git_files` source from a script (e.g. a flaky-test report) with the same
 * commit/push logic as the daemon: next free number, file `NNNN-<slug>.md`,
 * one commit, push (renumbered on a concurrent commit).
 *
 * Works in a temporary clone of its own, so it never touches the clone of a
 * running daemon; credentials come from the source identity (environment
 * like the daemon) or, without identity, from nothing (local path, ssh agent).
 *
 * Exit codes: 0 = created, 1 = invalid configuration / source error, 2 = usage error.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, systemClock, type Clock, type FetchLike, type FieldUpdateValue } from '../core/index.js';
import { ConfigLoadError, ConfigManager, formatConfigIssue } from '../config/index.js';
import { GitFilesSourceAdapter, gitFilesWritableType, type GitFilesFieldType } from '../sources/index.js';
import { SourceRegistry } from '../app.js';
import type { CliIo, CreateItemCliOptions } from './program.js';

/** Injectable dependencies (tests). */
export interface SourceCreateItemDeps {
  /** HTTP client for GitHub token exchange (tests: Fake-GitHub). */
  fetch?: FetchLike;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  /** Standard input (for `--body-file -`). */
  stdin?: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse `--field key=value` by the field's type; returns an error text for bad input. */
export function parseFieldArgs(
  args: readonly string[],
  declared: Readonly<Record<string, GitFilesFieldType>>,
): { fields: Record<string, FieldUpdateValue> } | { error: string } {
  const fields: Record<string, FieldUpdateValue> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) return { error: `--field "${arg}": expected key=value` };
    const key = arg.slice(0, eq).trim();
    const raw = arg.slice(eq + 1);
    if (key === 'title') return { error: '--field "title": use --title' };
    const type = gitFilesWritableType(key, declared);
    if (!type) return { error: `--field "${key}": not a writable frontmatter field of the source (declare it under "fields" in sources.yaml)` };
    switch (type) {
      case 'number': {
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n)) return { error: `--field "${key}": expected a number` };
        fields[key] = n;
        break;
      }
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') return { error: `--field "${key}": expected true or false` };
        fields[key] = raw === 'true';
        break;
      case 'string[]':
        fields[key] = raw
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== '');
        break;
      default:
        fields[key] = raw;
    }
  }
  return { fields };
}

/** Create the `source create-item` handler. */
export function createSourceCreateItemHandler(io: Pick<CliIo, 'stdout' | 'stderr'>, deps: SourceCreateItemDeps = {}) {
  return async (sourceId: string, opts: CreateItemCliOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('source create-item: --config-dir is required\n');
      return 2;
    }
    if (!opts.title || opts.title.trim() === '') {
      io.stderr('source create-item: --title must not be empty\n');
      return 2;
    }
    if (opts.body !== undefined && opts.bodyFile !== undefined) {
      io.stderr('source create-item: use either --body or --body-file\n');
      return 2;
    }
    const clock = deps.clock ?? systemClock;
    const configDir = path.resolve(opts.configDir);
    let config: ConfigManager;
    try {
      config = await ConfigManager.create({ configDir, dataDir: path.resolve(opts.dataDir ?? 'data'), clock });
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        io.stderr(`Configuration in ${configDir} is invalid:\n${err.errors.map((i) => `  ${formatConfigIssue(i)}\n`).join('')}`);
        return 1;
      }
      throw err;
    }
    const source = config.current.sources[sourceId];
    if (!source) {
      io.stderr(`source create-item: unknown source "${sourceId}"\n`);
      return 1;
    }
    if (source.type !== 'git_files') {
      io.stderr(`source create-item: source "${sourceId}" has type ${source.type}; only git_files sources can create items\n`);
      return 1;
    }
    const parsed = parseFieldArgs(opts.field ?? [], source.fields);
    if ('error' in parsed) {
      io.stderr(`source create-item: ${parsed.error}\n`);
      return 2;
    }
    let body = opts.body ?? '';
    if (opts.bodyFile !== undefined) {
      try {
        body = opts.bodyFile === '-' ? await (deps.stdin ?? readStdin)() : await readFile(path.resolve(opts.bodyFile), 'utf8');
      } catch (err) {
        io.stderr(`source create-item: cannot read the body: ${errorMessage(err)}\n`);
        return 2;
      }
    }
    // No gitFilesDir: the registry works in a temporary clone of its own (removed below).
    const sources = new SourceRegistry(config.current, { clock, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.env ? { env: deps.env } : {}) });
    try {
      const adapter = sources.get(sourceId);
      if (!(adapter instanceof GitFilesSourceAdapter)) {
        io.stderr(`source create-item: source "${sourceId}" is not available\n`);
        return 1;
      }
      const created = await adapter.createItem(
        { title: opts.title, body, fields: parsed.fields, ...(opts.label ? { labels: opts.label } : {}) },
        opts.identity ?? source.identity,
      );
      io.stdout(
        opts.json
          ? `${JSON.stringify({ source: sourceId, item: created.itemId, file: created.file, commit: created.commit, url: created.url }, null, 2)}\n`
          : `Created ${sourceId} #${created.itemId}: ${created.file} (commit ${created.commit.slice(0, 12)})\n`,
      );
      return 0;
    } catch (err) {
      io.stderr(`source create-item: ${errorMessage(err)}\n`);
      return 1;
    } finally {
      sources.dispose();
    }
  };
}
