/**
 * Source adapter `git_files` (WI-40): items are Markdown files with YAML
 * frontmatter in a git repository (`<path>/NNNN-<slug>.md`, one item per file).
 *
 * The adapter keeps its own clone (a mirror: fetch + hard reset before every
 * read and write). Reads fetch at most once per `minFetchIntervalMs`
 * (concurrent readers share it) and parse all files; malformed files are
 * skipped with a warning (once per file and problem), never failing the
 * listing. Every write is one commit plus a push; a rejected push is resolved
 * by fetching, resetting and applying the change again (idempotent: labels and
 * fields only if still needed, a comment only if its marker is missing), with
 * a bounded number of attempts.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GIT_FILES_SOURCE_TYPE,
  SourceError,
  isFilterAll,
  isFilterPredicate,
  itemHistoryRoute,
  noopLogger,
  sourceItemKey,
  type Clock,
  type CommentRef,
  type CredentialProvider,
  type FieldDefinition,
  type FieldObject,
  type FieldResolution,
  type FieldUpdateValue,
  type FieldValue,
  type FilterNode,
  type FilterPredicate,
  type IdentityRef,
  type ListCandidatesOptions,
  type Logger,
  type SourceAdapter,
  type SourceAdapterDeps,
  type SourceAdapterFactory,
  type SourceItem,
  type SourceUpdate,
  type SourceUpdateApplied,
  type SourceUpdateOptions,
  type SourceUpdateResult,
} from '../../core/index.js';
import {
  appendComment,
  editFrontmatter,
  ITEM_FILE_PATTERN,
  ItemFileError,
  MAX_ITEM_FILE_BYTES,
  parseItemFile,
  renderNewItemFile,
  slugify,
  type CommentEntry,
} from './document.js';
import {
  GIT_FILES_BUILTIN_FIELDS,
  GIT_FILES_FIELD_DEFINITIONS,
  gitFilesDeclaredFieldDefinitions,
  gitFilesUpdateValue,
  gitFilesValueProblem,
  gitFilesWritableType,
  type GitFilesFieldType,
} from './fields.js';
import { GitClone, GitCommandError, type GitExec } from './git.js';
import { KeyedSerializer } from './lock.js';

/** Item kind reported as {@link SourceItem.type}. */
export const GIT_FILES_ITEM_TYPE = 'issue';

/** Default minimal interval between two fetches for reads. */
export const GIT_FILES_MIN_FETCH_INTERVAL_MS = 5_000;

/** Default attempts of a write when the push is rejected (concurrent commits). */
export const GIT_FILES_MAX_PUSH_ATTEMPTS = 5;

/** Default commit author. */
export const GIT_FILES_DEFAULT_AUTHOR = Object.freeze({ name: 'adispatchd', email: 'adispatchd@users.noreply.invalid' });

/** Validated configuration of one `git_files` source (as handed to the factory). */
export interface GitFilesAdapterConfig {
  /** Remote URL or absolute path (never with credentials). */
  repository: string;
  branch: string;
  /** Folder of the item files relative to the repository root (`''` = root, POSIX separators). */
  path: string;
  /** Identity whose token is used for fetch/push; `null` = no credentials. */
  identity: string | null;
  commitAuthor: { name: string; email: string };
  /** Frontmatter key → values (case-insensitive); one match closes the item. */
  closedWhen: Readonly<Record<string, readonly string[]>>;
  commentsHeading: string;
  /** Declared frontmatter keys → type. */
  fields: Readonly<Record<string, GitFilesFieldType>>;
  /** Web URL template with `{ref}` and `{path}`, or `null`. */
  webUrl: string | null;
  /** Human-readable location (`{source.repository}`). */
  location: string;
}

/** Options of the adapter that are not part of the YAML configuration. */
export interface GitFilesAdapterOptions {
  /** Directory of this source's clone (e.g. `<data-dir>/sources/<source-id>`). */
  cloneDir: string;
  /** Shared serializer (one per process); default: an own one. */
  locks?: KeyedSerializer;
  minFetchIntervalMs?: number;
  maxPushAttempts?: number;
  exec?: GitExec;
  env?: Readonly<Record<string, string | undefined>>;
  redact?: (text: string) => string;
}

/** A parsed, valid item file. */
interface Entry {
  id: number;
  /** Path relative to the repository root (POSIX). */
  file: string;
  abs: string;
  text: string;
  data: Record<string, unknown>;
  body: string;
  comments: CommentEntry[];
}

/** All item files of the current clone state. */
interface ParsedState {
  byId: Map<number, Entry>;
  /** IDs used by more than one file (all of them skipped). */
  ambiguous: Set<number>;
  /** Highest number in use (also by malformed files), for new items. */
  maxNumber: number;
  problems: Array<{ file: string; problem: string }>;
}

/** Fresh item to create (`adispatch source create-item`). */
export interface NewGitFilesItem {
  title: string;
  body?: string;
  labels?: readonly string[];
  /** Frontmatter keys → values (validated against the writable fields). */
  fields?: Readonly<Record<string, FieldUpdateValue>>;
}

/** Result of {@link GitFilesSourceAdapter.createItem}. */
export interface CreatedGitFilesItem {
  itemId: string;
  file: string;
  commit: string;
  url: string;
}

/** Adapter of one `git_files` source. */
export class GitFilesSourceAdapter implements SourceAdapter {
  readonly type = GIT_FILES_SOURCE_TYPE;
  readonly repository: string;
  private readonly clone: GitClone;
  private readonly locks: KeyedSerializer;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly credentials: CredentialProvider;
  private readonly definitions: readonly FieldDefinition[];
  private readonly minFetchIntervalMs: number;
  private readonly maxPushAttempts: number;
  private lastFetchAt: number | null = null;
  private parsed: ParsedState | null = null;
  /** Problems already logged (file + problem), so a broken file warns once, not on every poll. */
  private readonly reported = new Set<string>();

  constructor(
    readonly sourceId: string,
    private readonly config: GitFilesAdapterConfig,
    deps: SourceAdapterDeps,
    private readonly options: GitFilesAdapterOptions,
  ) {
    this.repository = config.location;
    this.logger = (deps.logger ?? noopLogger).child({ component: 'source', sourceId });
    this.clock = deps.clock;
    this.credentials = deps.credentials;
    this.locks = options.locks ?? new KeyedSerializer();
    this.minFetchIntervalMs = options.minFetchIntervalMs ?? GIT_FILES_MIN_FETCH_INTERVAL_MS;
    this.maxPushAttempts = options.maxPushAttempts ?? GIT_FILES_MAX_PUSH_ATTEMPTS;
    this.definitions = Object.freeze([...GIT_FILES_FIELD_DEFINITIONS, ...gitFilesDeclaredFieldDefinitions(config.fields)]);
    this.clone = new GitClone({
      dir: options.cloneDir,
      remote: config.repository,
      branch: config.branch,
      token: async () => (config.identity ? (await this.credentials.getToken(config.identity)).token : null),
      ...(options.exec ? { exec: options.exec } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.redact ? { redact: options.redact } : {}),
    });
  }

  fieldDefinitions(): readonly FieldDefinition[] {
    return this.definitions;
  }

  /** Problems of the last parse (malformed files), for diagnostics and tests. */
  async problems(): Promise<Array<{ file: string; problem: string }>> {
    return (await this.read()).problems;
  }

  async listCandidates(options: ListCandidatesOptions = {}): Promise<SourceItem[]> {
    const states = listedStates(options.filter);
    const state = await this.read();
    return [...state.byId.values()]
      .sort((a, b) => a.id - b.id)
      .map((e) => this.toItem(e, state))
      .filter((item) => states.has(item.fields.state as string));
  }

  async getItem(itemId: string): Promise<SourceItem | null> {
    const id = itemNumber(itemId);
    if (id === null) return null;
    const state = await this.read();
    const entry = state.byId.get(id);
    return entry ? this.toItem(entry, state) : null;
  }

  /** `42`, `#42`, `0042`, a file name/path (`issues/0042-x.md`) or a web URL of the file. */
  parseItemRef(ref: string): string | null {
    const trimmed = ref.trim();
    const bare = /^#?(\d{1,9})$/.exec(trimmed);
    if (bare) return normalizeNumber(bare[1] as string);
    const withoutQuery = trimmed.replace(/[?#].*$/, '');
    const base = withoutQuery.split('/').pop() ?? '';
    const file = ITEM_FILE_PATTERN.exec(safeDecode(base) ?? '');
    if (!file) return null;
    const dir = withoutQuery.slice(0, withoutQuery.length - base.length).replace(/\/+$/, '');
    // A path must end with the configured folder (or be just the file name).
    if (dir !== '' && this.config.path !== '' && !dir.endsWith(`/${this.config.path}`) && dir !== this.config.path) return null;
    return normalizeNumber(file[1] as string);
  }

  async resolveFields(item: SourceItem, fields: readonly string[]): Promise<Record<string, FieldResolution>> {
    const fresh = item.sourceId === this.sourceId ? await this.getItem(item.itemId) : null;
    const out: Record<string, FieldResolution> = {};
    for (const name of fields) {
      if (!fresh) out[name] = { known: false, reason: `item ${item.key} is no longer a valid item of source "${this.sourceId}"` };
      else if (fresh.unknownFields && Object.hasOwn(fresh.unknownFields, name)) out[name] = { known: false, reason: fresh.unknownFields[name] as string };
      else if (Object.hasOwn(fresh.fields, name)) out[name] = { known: true, value: fresh.fields[name] as FieldValue };
      else out[name] = { known: false, reason: `unknown field "${name}" for source type ${GIT_FILES_SOURCE_TYPE}` };
    }
    return out;
  }

  async applyUpdate(item: SourceItem, update: SourceUpdate, identity: IdentityRef, options: SourceUpdateOptions = {}): Promise<SourceUpdateResult> {
    const id = this.ownNumber(item);
    if (update.project && Object.keys(update.project).length > 0) {
      throw new SourceError('invalid', `Source "${this.sourceId}" (git_files) has no GitHub project; set frontmatter fields with "fields"`, { retryable: false });
    }
    const fields = this.checkFields(update.fields ?? {});
    const labels = { add: [...(update.labels?.add ?? [])], remove: [...(update.labels?.remove ?? [])] };
    const outcome = await this.write(id, { identity, ...(options.origin ? { origin: options.origin } : {}) }, (entry) => {
      const result = editFrontmatter(entry.text, { labels, fields });
      const applied: SourceUpdateApplied = {};
      if (result.labelsAdded.length > 0) applied.labelsAdded = result.labelsAdded;
      if (result.labelsRemoved.length > 0) applied.labelsRemoved = result.labelsRemoved;
      if (Object.keys(result.fields).length > 0) {
        applied.fields = result.fields;
        applied.fieldsPrevious = result.fieldsPrevious;
      }
      return { text: result.text === entry.text ? null : result.text, value: applied, summary: updateSummary(applied) };
    });
    const changed = Object.keys(outcome.value).length > 0 && outcome.commit !== null;
    if (changed) this.logger.info('Applied item update', { item: item.key, commit: outcome.commit, ...outcome.value });
    return { changed, ...(changed ? { applied: outcome.value } : {}) };
  }

  async postComment(item: SourceItem, body: string, marker: string, identity: IdentityRef): Promise<CommentRef> {
    return this.comment(item, body, marker, identity, parseMarkerOrigin(marker));
  }

  /** UI comment (WI-27): carries an own random marker, so that a re-application after a rejected push never duplicates it. */
  async postUserComment(item: SourceItem, body: string, identity: IdentityRef): Promise<CommentRef> {
    const marker = `adispatchd:ui-${randomBytes(8).toString('hex')}`;
    try {
      const ref = await this.comment(item, body, marker, identity, {});
      this.logger.info('Posted UI comment', { item: item.key, identity, commentId: ref.id });
      return ref;
    } catch (err) {
      // Never retried automatically (UI contract).
      if (err instanceof SourceError && err.retryable) {
        throw new SourceError(err.kind, err.message, { retryable: false, outcomeUnknown: err.outcomeUnknown, cause: err });
      }
      throw err;
    }
  }

  async findCommentByMarker(item: SourceItem, marker: string): Promise<CommentRef | null> {
    const id = this.ownNumber(item);
    return this.locks.run(this.clone.dir, async () => {
      await this.syncLocked(true);
      const entry = (await this.parsedLocked()).byId.get(id);
      if (!entry || !entry.comments.some((c) => c.marker === marker)) return null;
      return this.commentRef(entry.file, (await this.clone.commitAdding(marker, entry.file)) ?? marker);
    });
  }

  /** Labels used by any item of the source (UI suggestions; adding a new one needs `create: true`). */
  async listLabels(): Promise<string[]> {
    const state = await this.read();
    const seen = new Map<string, string>();
    for (const entry of state.byId.values()) {
      for (const label of labelValues(entry.data.labels) ?? []) if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Create a new item file with the next free number (highest number in use
   * + 1) and push it; a rejected push renumbers on the fresh state.
   */
  async createItem(input: NewGitFilesItem, identity: IdentityRef | null = null): Promise<CreatedGitFilesItem> {
    const title = input.title.replace(/[\r\n]+/g, ' ').trim();
    if (title === '') throw new SourceError('invalid', 'The title must not be empty', { retryable: false });
    const fields = this.checkFields(input.fields ?? {});
    delete fields.title;
    return this.locks.run(this.clone.dir, async () => {
      for (let attempt = 1; attempt <= this.maxPushAttempts; attempt++) {
        await this.syncLocked(true);
        const state = await this.parsedLocked();
        const id = state.maxNumber + 1;
        const file = posixJoin(this.config.path, `${String(id).padStart(4, '0')}-${slugify(title)}.md`);
        const abs = this.absolute(file);
        const frontmatter: Record<string, unknown> = { id, title };
        for (const [key, value] of Object.entries(fields)) if (value !== null) frontmatter[key] = value;
        const labels = [...new Set((input.labels ?? []).map((l) => l.trim()).filter((l) => l !== ''))];
        if (labels.length > 0) frontmatter.labels = labels;
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, renderNewItemFile(frontmatter, input.body ?? ''), { flag: 'wx' });
        const commit = await this.clone.commit([file], this.message(id, `create "${truncate(title, 80)}"`, { identity }), this.config.commitAuthor);
        const failed = await this.clone.push();
        if (!failed) {
          this.markPushed();
          this.logger.info('Created item', { item: sourceItemKey(this.sourceId, String(id)), file, commit });
          return { itemId: String(id), file, commit, url: this.fileUrl(file, this.config.branch) ?? itemHistoryRoute(this.sourceId, String(id)) };
        }
        if (failed.failure !== 'rejected') throw pushError(failed.error, true);
        this.logger.info('Push rejected (concurrent commit); retrying with a fresh state', { attempt });
      }
      throw new SourceError('transient', `Creating the item failed: the push was rejected ${this.maxPushAttempts} times (concurrent commits)`);
    });
  }

  // ---------------------------------------------------------------------------

  private async comment(item: SourceItem, body: string, marker: string, identity: IdentityRef, origin: { runId?: string; actionId?: string }): Promise<CommentRef> {
    const id = this.ownNumber(item);
    const author = identity === '' ? this.config.commitAuthor.name : identity;
    const outcome = await this.write(id, { identity, origin }, (entry) => {
      if (entry.comments.some((c) => c.marker === marker)) return { text: null, value: true, summary: 'comment' };
      const text = appendComment(entry.text, { heading: this.config.commentsHeading, at: isoSeconds(this.clock.now()), author, text: body, marker });
      return { text, value: false, summary: `comment by ${author}` };
    });
    if (outcome.commit) return this.commentRef(outcome.file, outcome.commit);
    // Already there (e.g. an earlier push went through although it reported an error): find its commit.
    return this.locks.run(this.clone.dir, async () => this.commentRef(outcome.file, (await this.clone.commitAdding(marker, outcome.file)) ?? marker));
  }

  private commentRef(file: string, id: string): CommentRef {
    const url = /^[0-9a-f]{40,64}$/.test(id) ? this.fileUrl(file, id) : null;
    return { id, ...(url ? { url } : {}) };
  }

  /**
   * One write = fetch + reset, edit, commit, push; repeated on a rejected
   * push. `edit` returns the new text (`null` = nothing to change) and a value
   * for the caller; it runs again on every attempt on the fresh file.
   */
  private async write<T>(
    id: number,
    meta: { identity: IdentityRef | null; origin?: { runId?: string; actionId?: string } },
    edit: (entry: Entry) => { text: string | null; value: T; summary: string },
  ): Promise<{ value: T; commit: string | null; file: string }> {
    return this.locks.run(this.clone.dir, async () => {
      for (let attempt = 1; attempt <= this.maxPushAttempts; attempt++) {
        await this.syncLocked(true);
        const state = await this.parsedLocked();
        if (state.ambiguous.has(id)) {
          throw new SourceError('invalid', `Item #${id} of source "${this.sourceId}" exists in several files; fix the repository first`, { retryable: false });
        }
        const entry = state.byId.get(id);
        if (!entry) throw new SourceError('not_found', `Item #${id} not found (or malformed) in source "${this.sourceId}"`, { retryable: false });
        let result: { text: string | null; value: T; summary: string };
        try {
          result = edit(entry);
        } catch (err) {
          if (err instanceof ItemFileError) throw new SourceError('invalid', `Item file ${entry.file}: ${err.message}`, { retryable: false });
          throw err;
        }
        if (result.text === null) return { value: result.value, commit: null, file: entry.file };
        await writeFile(entry.abs, result.text);
        const commit = await this.clone.commit([entry.file], this.message(id, result.summary, meta), this.config.commitAuthor);
        const failed = await this.clone.push();
        if (!failed) {
          this.markPushed();
          return { value: result.value, commit, file: entry.file };
        }
        if (failed.failure !== 'rejected') throw pushError(failed.error, true);
        this.logger.info('Push rejected (concurrent commit); applying the change again on the fresh state', { item: `#${id}`, attempt });
      }
      throw new SourceError('transient', `Writing item #${id} failed: the push was rejected ${this.maxPushAttempts} times (concurrent commits)`);
    });
  }

  private message(id: number, summary: string, meta: { identity: IdentityRef | null; origin?: { runId?: string; actionId?: string } }): string {
    const trailers = [
      meta.origin?.runId ? `Adispatchd-Run: ${oneLine(meta.origin.runId)}` : null,
      meta.origin?.actionId ? `Adispatchd-Action: ${oneLine(meta.origin.actionId)}` : null,
      meta.identity ? `Adispatchd-Identity: ${oneLine(meta.identity)}` : null,
    ].filter((t): t is string => t !== null);
    return `${this.sourceId} #${id}: ${truncate(oneLine(summary), 200)}${trailers.length > 0 ? `\n\n${trailers.join('\n')}` : ''}`;
  }

  /** After a successful push the clone equals the remote: no fetch needed, but the files changed. */
  private markPushed(): void {
    this.parsed = null;
    this.lastFetchAt = this.clock.now().getTime();
  }

  /** Current state for reads (fetch only when the last one is older than the interval). */
  private read(): Promise<ParsedState> {
    return this.locks.run(this.clone.dir, async () => {
      await this.syncLocked(false);
      return this.parsedLocked();
    });
  }

  private async syncLocked(force: boolean): Promise<void> {
    const now = this.clock.now().getTime();
    if (!force && this.lastFetchAt !== null && now - this.lastFetchAt < this.minFetchIntervalMs) return;
    try {
      await this.clone.sync();
    } catch (err) {
      this.lastFetchAt = null;
      if (err instanceof SourceError && err.kind === 'auth' && this.config.identity) this.credentials.invalidate?.(this.config.identity);
      if (err instanceof GitCommandError) throw new SourceError('transient', `Updating the clone failed: ${err.message}`);
      throw err;
    }
    this.lastFetchAt = now;
    this.parsed = null;
  }

  private async parsedLocked(): Promise<ParsedState> {
    if (this.parsed) return this.parsed;
    const state: ParsedState = { byId: new Map(), ambiguous: new Set(), maxNumber: 0, problems: [] };
    const problem = (file: string, message: string): void => {
      state.problems.push({ file, problem: message });
      const key = `${file}\u0000${message}`;
      if (this.reported.has(key)) return;
      if (this.reported.size > 10_000) this.reported.clear();
      this.reported.add(key);
      this.logger.warn('Skipping malformed item file', { file, problem: message });
    };
    const dir = this.absolute(this.config.path);
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      problem(this.config.path === '' ? '.' : this.config.path, 'the item folder does not exist in the repository (no items)');
      this.parsed = state;
      return state;
    }
    const byId = new Map<number, Entry[]>();
    for (const name of names) {
      const match = ITEM_FILE_PATTERN.exec(name);
      if (!match) continue;
      const file = posixJoin(this.config.path, name);
      const fromName = Number(match[1]);
      state.maxNumber = Math.max(state.maxNumber, fromName);
      const abs = path.join(dir, name);
      const info = await lstat(abs);
      if (!info.isFile()) {
        problem(file, 'not a regular file (symbolic links and folders are not read)');
        continue;
      }
      if (info.size > MAX_ITEM_FILE_BYTES) {
        problem(file, `larger than ${MAX_ITEM_FILE_BYTES} bytes`);
        continue;
      }
      const text = await readFile(abs, 'utf8');
      let parsed;
      try {
        parsed = parseItemFile(text, this.config.commentsHeading);
      } catch (err) {
        problem(file, err instanceof ItemFileError ? err.message : `unreadable: ${String(err)}`);
        continue;
      }
      let id = fromName;
      if (Object.hasOwn(parsed.data, 'id')) {
        const declared = intValue(parsed.data.id);
        if (declared === null) {
          problem(file, 'frontmatter "id" is not a positive whole number');
          continue;
        }
        if (declared !== fromName) {
          problem(file, `frontmatter "id" (${declared}) differs from the number in the file name (${fromName})`);
          continue;
        }
        id = declared;
      }
      if (id <= 0) {
        problem(file, 'the item number must be positive');
        continue;
      }
      const list = byId.get(id) ?? [];
      list.push({ id, file, abs, text, data: parsed.data, body: parsed.body, comments: parsed.comments });
      byId.set(id, list);
    }
    for (const [id, entries] of byId) {
      if (entries.length === 1) {
        state.byId.set(id, entries[0] as Entry);
        continue;
      }
      state.ambiguous.add(id);
      for (const e of entries) problem(e.file, `item number ${id} is used by ${entries.length} files (${entries.map((x) => x.file).join(', ')})`);
    }
    this.parsed = state;
    return state;
  }

  private toItem(entry: Entry, state: ParsedState): SourceItem {
    const itemId = String(entry.id);
    const data = entry.data;
    const unknown: Record<string, string> = {};
    const fields: Record<string, FieldValue> = {};
    const bad = (name: string, what: string): void => {
      unknown[name] = `frontmatter "${name}" in ${entry.file} is not ${what}`;
    };
    const take = <T extends FieldValue>(name: string, key: string, conv: (v: unknown) => T | undefined, what: string): T | undefined => {
      const value = conv(data[key]);
      if (value === undefined) bad(name, what);
      else fields[name] = value;
      return value;
    };

    // Free frontmatter keys first; built-in and declared fields override them below.
    for (const [key, value] of Object.entries(data)) {
      if (GIT_FILES_BUILTIN_FIELDS.has(key) || key.includes('.')) continue;
      fields[key] = freeValue(value);
    }

    const url = this.fileUrl(entry.file, this.config.branch) ?? itemHistoryRoute(this.sourceId, itemId);
    fields.number = entry.id;
    fields.id = entry.id;
    take('title', 'title', stringValue, 'a string');
    if (fields.title === null || fields.title === undefined) fields.title = '';
    fields.state = this.isClosed(data) ? 'closed' : 'open';
    take('status', 'status', stringValue, 'a string');
    take('labels', 'labels', labelValues, 'a list of strings');
    take('milestone', 'milestone', stringValue, 'a string');
    const blockers = take('blocked_by', 'blocked_by', blockerValues, 'a list of item numbers');
    const branch = take('branch', 'branch', stringValue, 'a string');
    const pr = prValue(data.pr);
    if (pr === undefined) {
      bad('pr', 'a PR number, "#123" or a PR URL');
      for (const n of ['work_pr', 'work_pr_url']) unknown[n] = unknown.pr as string;
    } else {
      fields.pr = pr.number;
      fields.work_pr = pr.number;
      fields.work_pr_url = pr.url;
    }
    take('spec', 'spec', stringValue, 'a string');
    take('files', 'files', listValue, 'a list of strings');
    const created = dateValue(data.created_at ?? data.created);
    if (created === undefined) unknown.created_at = `frontmatter "created_at"/"created" in ${entry.file} is not an ISO-8601 date`;
    else fields.created_at = created;
    fields.body = entry.body;
    fields.comments = entry.comments.map((c): FieldObject => ({ at: c.at, author: c.author, text: c.text }));
    fields.path = entry.file;
    fields.url = url;
    if (branch === undefined) unknown.work_branch = unknown.branch as string;
    else fields.work_branch = branch;

    // Dependencies (fail closed: an unknown blocker makes the open count unknown).
    if (blockers === undefined) {
      for (const n of ['dependencies.blocked_by_total', 'dependencies.blocked_by_open', 'dependencies.blocked']) unknown[n] = unknown.blocked_by as string;
      fields['dependencies.status'] = 'unknown';
    } else {
      fields['dependencies.blocked_by_total'] = blockers.length;
      const missing = blockers.filter((b) => state.ambiguous.has(Number(b)) || !state.byId.has(Number(b)));
      if (missing.length > 0) {
        const reason = `blocker ${missing.map((m) => `#${m}`).join(', ')} is not a valid item of source "${this.sourceId}"`;
        unknown['dependencies.blocked_by_open'] = reason;
        unknown['dependencies.blocked'] = reason;
        fields['dependencies.status'] = 'unknown';
      } else {
        const open = blockers.filter((b) => {
          const blocker = state.byId.get(Number(b));
          return blocker !== undefined && !this.isClosed(blocker.data);
        }).length;
        fields['dependencies.blocked_by_open'] = open;
        fields['dependencies.blocked'] = open > 0;
        fields['dependencies.status'] = 'ok';
      }
    }

    // Declared frontmatter keys.
    for (const [name, type] of Object.entries(this.config.fields)) {
      const value = typedValue(type, data[name]);
      if (value === undefined) {
        bad(name, type === 'string[]' ? 'a list of strings' : `a ${type}`);
        delete fields[name];
      } else {
        fields[name] = value;
      }
    }
    for (const name of Object.keys(unknown)) delete fields[name];

    return {
      sourceId: this.sourceId,
      itemId,
      key: sourceItemKey(this.sourceId, itemId),
      url,
      type: GIT_FILES_ITEM_TYPE,
      ...(typeof fields.created_at === 'string' ? { createdAt: fields.created_at } : {}),
      fields,
      ...(Object.keys(unknown).length > 0 ? { unknownFields: unknown } : {}),
    };
  }

  private isClosed(data: Record<string, unknown>): boolean {
    for (const [key, values] of Object.entries(this.config.closedWhen)) {
      const wanted = new Set(values.map((v) => v.toLowerCase()));
      const raw = data[key];
      const actual = Array.isArray(raw) ? raw : [raw];
      if (actual.some((v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && wanted.has(String(v).toLowerCase()))) return true;
    }
    return false;
  }

  /** Validate and normalise `fields` of an update / new item. */
  private checkFields(fields: Readonly<Record<string, FieldUpdateValue>>): Record<string, FieldUpdateValue> {
    const out: Record<string, FieldUpdateValue> = {};
    const problems: string[] = [];
    for (const [name, value] of Object.entries(fields)) {
      const type = gitFilesWritableType(name, this.config.fields);
      if (!type) {
        problems.push(`"${name}" cannot be set (not a writable frontmatter field of source "${this.sourceId}"; declare it under "fields" or use "labels")`);
        continue;
      }
      const problem = gitFilesValueProblem(type, value);
      if (problem) problems.push(`"${name}": ${problem}`);
      else out[name] = gitFilesUpdateValue(type, value);
    }
    if (problems.length > 0) throw new SourceError('invalid', `Invalid fields: ${problems.join('; ')}`, { retryable: false });
    return out;
  }

  private ownNumber(item: SourceItem): number {
    const id = item.sourceId === this.sourceId ? itemNumber(item.itemId) : null;
    if (id === null) throw new SourceError('invalid', `Item ${item.key} does not belong to source "${this.sourceId}"`, { retryable: false });
    return id;
  }

  private absolute(rel: string): string {
    return rel === '' ? this.clone.dir : path.join(this.clone.dir, ...rel.split('/'));
  }

  private fileUrl(file: string, ref: string): string | null {
    if (!this.config.webUrl) return null;
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    return this.config.webUrl.replaceAll('{ref}', encodeURIComponent(ref)).replaceAll('{path}', encoded);
  }
}

// ---------------------------------------------------------------------------
// Value conversion (undefined = invalid → unknown field, fail closed)

function stringValue(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function listValue(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : [v];
  if (!items.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) return undefined;
  return items.map(String);
}

function labelValues(v: unknown): string[] | undefined {
  const list = listValue(v);
  return list?.map((l) => l.trim()).filter((l) => l !== '');
}

function intValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^#?\d{1,9}$/.test(v.trim())) {
    const n = Number(v.trim().replace(/^#/, ''));
    return n > 0 ? n : null;
  }
  return null;
}

function blockerValues(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of items) {
    const n = intValue(x);
    if (n === null) return undefined;
    if (!out.includes(String(n))) out.push(String(n));
  }
  return out;
}

function prValue(v: unknown): { number: number | null; url: string | null } | undefined {
  if (v === undefined || v === null || v === '') return { number: null, url: null };
  const n = intValue(v);
  if (n !== null) return { number: n, url: null };
  if (typeof v === 'string' && /^https?:\/\/\S+\/(\d{1,9})\/?$/.test(v.trim())) {
    const url = v.trim();
    return { number: Number(/\/(\d{1,9})\/?$/.exec(url)?.[1]), url };
  }
  return undefined;
}

function dateValue(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'string' && gitFilesValueProblem('date', v) === undefined) return v;
  return undefined;
}

function typedValue(type: GitFilesFieldType, v: unknown): FieldValue | undefined {
  switch (type) {
    case 'string':
      return stringValue(v);
    case 'number':
      if (v === undefined || v === null) return null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return undefined;
    case 'boolean':
      if (v === undefined || v === null) return null;
      return typeof v === 'boolean' ? v : undefined;
    case 'date':
      return dateValue(v);
    case 'string[]':
      return listValue(v);
  }
}

/** Value of an undeclared key (context attributes only): scalars and string lists as is, everything else as JSON. */
function freeValue(v: unknown): FieldValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------

/** States the listing returns for a filter: top-level `state equals|in`, default open. */
export function listedStates(filter: FilterNode | undefined): Set<string> {
  const states = new Set(['open']);
  if (!filter) return states;
  const conjuncts: FilterPredicate[] = isFilterPredicate(filter) ? [filter] : isFilterAll(filter) ? filter.all.filter(isFilterPredicate) : [];
  for (const p of conjuncts) {
    if (p.field !== 'state') continue;
    const values = (Array.isArray(p.value) ? p.value : [p.value]).filter((v): v is string => v === 'open' || v === 'closed');
    if ((p.operator === 'equals' || p.operator === 'in') && values.length > 0) return new Set(values);
  }
  return states;
}

function itemNumber(itemId: string): number | null {
  if (!/^[1-9]\d{0,8}$/.test(itemId)) return null;
  return Number(itemId);
}

function normalizeNumber(digits: string): string | null {
  const n = Number(digits);
  return Number.isInteger(n) && n > 0 ? String(n) : null;
}

function posixJoin(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeValue(v: FieldUpdateValue): string {
  if (v === null) return '(removed)';
  return Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
}

function updateSummary(applied: SourceUpdateApplied): string {
  const parts: string[] = [];
  const labels = [...(applied.labelsAdded ?? []).map((l) => `+${l}`), ...(applied.labelsRemoved ?? []).map((l) => `-${l}`)];
  if (labels.length > 0) parts.push(`labels ${labels.join(' ')}`);
  for (const [name, to] of Object.entries(applied.fields ?? {})) {
    const from = applied.fieldsPrevious?.[name];
    parts.push(`${name}: ${from === undefined || from === null ? '' : `${describeValue(from)} → `}${describeValue(to)}`);
  }
  return parts.length > 0 ? parts.join('; ') : 'update';
}

/** Run and action of a lifecycle comment marker (`adispatchd:<run>:<action>`). */
function parseMarkerOrigin(marker: string): { runId?: string; actionId?: string } {
  const m = /^adispatchd:([^:]+):(.+)$/.exec(marker);
  return m ? { runId: m[1] as string, actionId: m[2] as string } : {};
}

function pushError(err: GitCommandError, outcomeUnknown: boolean): SourceError {
  const text = err.stderr;
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|403|401/i.test(text)) {
    return new SourceError('auth', `The repository rejected the push credentials: ${err.message}`, { retryable: false });
  }
  if (/protected branch|pre-receive hook declined|GH006|GH013/i.test(text)) {
    return new SourceError('forbidden', `The repository refused the push: ${err.message}`, { retryable: false });
  }
  return new SourceError('transient', `Pushing failed: ${err.message}`, { outcomeUnknown });
}

/** Factory registered under type `git_files` (clone directory, locks and environment injected). */
export function createGitFilesSourceFactory(options: {
  /** Directory that holds one clone per source (`<dir>/<source-id>`). */
  clonesDir: string;
  locks?: KeyedSerializer;
  minFetchIntervalMs?: number;
  maxPushAttempts?: number;
  exec?: GitExec;
  env?: Readonly<Record<string, string | undefined>>;
  redact?: (text: string) => string;
}): SourceAdapterFactory<GitFilesAdapterConfig> {
  const locks = options.locks ?? new KeyedSerializer();
  return {
    type: GIT_FILES_SOURCE_TYPE,
    create: (sourceId, config, deps) =>
      new GitFilesSourceAdapter(sourceId, config, deps, {
        cloneDir: path.join(options.clonesDir, sourceId),
        locks,
        ...(options.minFetchIntervalMs !== undefined ? { minFetchIntervalMs: options.minFetchIntervalMs } : {}),
        ...(options.maxPushAttempts !== undefined ? { maxPushAttempts: options.maxPushAttempts } : {}),
        ...(options.exec ? { exec: options.exec } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.redact ? { redact: options.redact } : {}),
      }),
  };
}
