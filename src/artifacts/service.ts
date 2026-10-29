/**
 * Artifact service (WI-35): collects the artifacts a run declares
 * (`execute.artifacts`), serves them (listing, files, `.zip`), stages them as
 * read-only input of a run and deletes them (explicitly or by retention).
 *
 * Storage: `data-dir/artifacts/<id>/content` (a file or a folder); metadata
 * in the `artifacts` table. A new artifact is copied to `<id>.tmp/`, renamed to
 * `<id>/` and only then inserted; directories without a row (crash in between)
 * are removed by {@link ArtifactService.sweepOrphans}. Artifacts are immutable.
 */
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ARTIFACT_NAME_MAX_LENGTH,
  ARTIFACT_ID_PATTERN,
  artifactInputName,
  createArtifactId,
  dataPaths,
  errorMessage,
  noopLogger,
  systemClock,
  type ArtifactCatalog,
  type ArtifactRecord,
  type Clock,
  type Logger,
} from '../core/index.js';
import type { ArtifactOutputConfig } from '../config/index.js';
import type { ArtifactPage, ArtifactQuery, Repositories } from '../persistence/index.js';
import { collectArtifact, inspectArtifactPath, type CollectFailure, type CollectSkip } from './collect.js';
import { ArtifactError } from './errors.js';
import { listArtifactFiles, openArtifactFile, type ArtifactFile, type OpenedArtifactFile } from './files.js';
import { stageArtifactInput } from './input.js';
import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, zipStream, type ZipEntry } from './zip.js';

/** Directories in `artifacts/` without a row are removed only after this age. */
const DEFAULT_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

/** Options of {@link ArtifactService}. */
export interface ArtifactServiceOptions {
  repositories: Pick<Repositories, 'artifacts' | 'transaction' | 'afterCommit'>;
  dataDir: string;
  clock?: Clock;
  logger?: Logger;
  /** Called after a new artifact was stored (SSE `artifact.created`). Must not throw. */
  onCreated?: (artifact: ArtifactRecord) => void;
  /** Called after an artifact was deleted (SSE `artifact.deleted`). Must not throw. */
  onDeleted?: (artifact: ArtifactRecord) => void;
  /** Min. age of orphaned directories before they are removed (default 24 h). */
  orphanMinAgeMs?: number;
}

/** Input of {@link ArtifactService.collect}. */
export interface CollectInput {
  runId: string;
  workflowId: string;
  /** Absolute workspace directory of the run. */
  workspace: string;
  specs: readonly ArtifactOutputConfig[];
  /** Max. total bytes of all artifacts of this call. */
  maxBytes: number;
  /** Renders a display-name template; may throw. */
  renderName: (template: string) => string;
  /** Artifact the producing run had as input. */
  parentId: string | null;
  /** Secret values redacted while copying. */
  secrets: readonly string[];
  /** Test hook, see {@link CollectOptions.beforeCopy}. */
  beforeCopy?: (relPath: string) => void | Promise<void>;
}

/** A declared artifact that was not stored. */
export interface CollectWarning {
  /** Position in `execute.artifacts`. */
  index: number;
  name: string;
  path: string;
  reason: CollectFailure | 'invalid_name';
  message: string;
}

/** Summary of {@link ArtifactService.collect} (payload of the `run.artifacts` event). */
export interface CollectionReport {
  /** Human readable summary. */
  message: string;
  created: Array<Pick<ArtifactRecord, 'id' | 'name' | 'type' | 'kind' | 'size' | 'fileCount'> & { index: number; skippedCount: number; skipped: CollectSkip[] }>;
  warnings: CollectWarning[];
  /** Total bytes of the stored artifacts. */
  bytes: number;
}

/** Result of {@link ArtifactService.openZip}. */
export interface ArtifactZip {
  stream: AsyncGenerator<Buffer>;
  /** Download name (`<folder>.zip`). */
  fileName: string;
}

/** See module docs. */
export class ArtifactService implements ArtifactCatalog {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly repo: Repositories['artifacts'];

  constructor(private readonly options: ArtifactServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = (options.logger ?? noopLogger).child({ component: 'artifacts' });
    this.repo = options.repositories.artifacts;
  }

  // --- Catalogue ---------------------------------------------------------

  list(): ArtifactRecord[] {
    return this.repo.list();
  }

  get(id: string): ArtifactRecord | null {
    return ARTIFACT_ID_PATTERN.test(id) ? this.repo.get(id) : null;
  }

  query(query?: ArtifactQuery): ArtifactPage {
    return this.repo.query(query);
  }

  /** @throws ArtifactError `artifact_not_found` */
  require(id: string): ArtifactRecord {
    const record = this.get(id);
    if (!record) throw new ArtifactError('artifact_not_found', `Artifact '${id}' not found`);
    return record;
  }

  /** `artifacts/<id>/` and the stored `content` of an artifact. */
  paths(id: string): { dir: string; content: string } {
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new ArtifactError('artifact_not_found', `Artifact '${id}' not found`);
    const dir = path.join(dataPaths(this.options.dataDir).artifactsDir, id);
    return { dir, content: path.join(dir, 'content') };
  }

  // --- Collecting --------------------------------------------------------

  /**
   * Store the declared artifacts of a finished run. Never throws for a single
   * artifact: problems end up as warnings. Idempotent per run and position
   * (a resumed finalization does not store an artifact twice).
   */
  async collect(input: CollectInput): Promise<CollectionReport> {
    const report: CollectionReport = { message: '', created: [], warnings: [], bytes: 0 };
    const artifactsDir = dataPaths(this.options.dataDir).artifactsDir;
    for (const [index, spec] of input.specs.entries()) {
      const warn = (reason: CollectWarning['reason'], message: string, name = spec.name): void => {
        report.warnings.push({ index, name, path: spec.path, reason, message });
      };
      const existing = this.repo.getByRun(input.runId, index);
      if (existing) {
        report.created.push({ id: existing.id, name: existing.name, type: existing.type, kind: existing.kind, size: existing.size, fileCount: existing.fileCount, index, skippedCount: 0, skipped: [] });
        report.bytes += existing.size;
        continue;
      }
      let name: string;
      try {
        name = input.renderName(spec.name).trim().slice(0, ARTIFACT_NAME_MAX_LENGTH);
      } catch (err) {
        warn('invalid_name', `name could not be rendered: ${errorMessage(err)}`);
        continue;
      }
      if (name === '') {
        warn('invalid_name', 'the rendered name is empty');
        continue;
      }
      const inspected = await inspectArtifactPath(input.workspace, spec.path);
      if (!inspected.ok) {
        warn(inspected.reason, inspected.message, name);
        continue;
      }
      const id = createArtifactId({ clock: this.clock });
      const finalDir = path.join(artifactsDir, id);
      const tmpDir = `${finalDir}.tmp`;
      try {
        await mkdir(tmpDir, { recursive: true, mode: 0o700 });
        const collected = await collectArtifact({
          source: inspected.source,
          dest: path.join(tmpDir, 'content'),
          maxBytes: Math.max(0, input.maxBytes - report.bytes),
          secrets: input.secrets,
          ...(input.beforeCopy ? { beforeCopy: input.beforeCopy } : {}),
        });
        if (!collected.ok) {
          await rm(tmpDir, { recursive: true, force: true });
          warn(collected.reason, collected.message, name);
          continue;
        }
        await rename(tmpDir, finalDir);
        let record: ArtifactRecord;
        try {
          record = this.options.repositories.transaction(() => {
            const inserted = this.repo.insert({
              id,
              name,
              type: spec.type,
              kind: collected.kind,
              fileName: collected.fileName,
              size: collected.size,
              fileCount: collected.fileCount,
              workflowId: input.workflowId,
              runId: input.runId,
              ordinal: index,
              parentId: input.parentId,
            });
            this.options.repositories.afterCommit(() => this.notify(() => this.options.onCreated?.(inserted)));
            return inserted;
          });
        } catch (err) {
          await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
          throw err;
        }
        report.created.push({
          id: record.id,
          name: record.name,
          type: record.type,
          kind: record.kind,
          size: record.size,
          fileCount: record.fileCount,
          index,
          skippedCount: collected.skippedCount,
          skipped: collected.skipped,
        });
        report.bytes += record.size;
      } catch (err) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        warn('error', errorMessage(err), name);
      }
    }
    report.message = summarize(report);
    return report;
  }

  // --- Reading -----------------------------------------------------------

  /** Files of an artifact (`kind: file` → one entry named like the file). */
  async listFiles(record: ArtifactRecord): Promise<{ files: ArtifactFile[]; truncated: boolean }> {
    return listArtifactFiles(this.paths(record.id).content, record.kind, record.fileName);
  }

  /** Open one file of an artifact. @throws ArtifactError `artifact_invalid_path`, `artifact_file_not_found` */
  async openFile(record: ArtifactRecord, segments: readonly string[]): Promise<OpenedArtifactFile> {
    return openArtifactFile(this.paths(record.id).content, record.kind, record.fileName, segments);
  }

  /**
   * `.zip` of a folder artifact (files in sorted order). @throws ArtifactError
   * `artifact_too_large` when the folder does not fit a ZIP without ZIP64.
   */
  async openZip(record: ArtifactRecord): Promise<ArtifactZip> {
    const { content } = this.paths(record.id);
    const listing = await listArtifactFiles(content, record.kind, record.fileName);
    const total = listing.files.reduce((sum, f) => sum + f.size, 0);
    if (listing.truncated || listing.files.length > ZIP_MAX_ENTRIES || total > ZIP_MAX_BYTES) {
      throw new ArtifactError('artifact_too_large', 'The artifact is too large for a .zip download; download its files one by one', {
        files: listing.files.length,
        bytes: total,
      });
    }
    const entries: ZipEntry[] = listing.files.map((file) => ({
      name: file.path,
      size: file.size,
      open: async () => (await openArtifactFile(content, record.kind, record.fileName, file.path.split('/'))).handle,
    }));
    return { stream: zipStream(entries, new Date(record.createdAt)), fileName: `${safeFileStem(record.fileName)}.zip` };
  }

  // --- Input -------------------------------------------------------------

  /**
   * Copy the artifact read-only to `<workspace>/inputs/<name>`; returns the
   * absolute path. @throws ArtifactError `artifact_not_found`
   */
  async stageInput(artifactId: string, workspace: string): Promise<string> {
    const record = this.require(artifactId);
    const { content } = this.paths(record.id);
    return stageArtifactInput(workspace, artifactInputName(record), content);
  }

  // --- Deleting ----------------------------------------------------------

  /**
   * Delete an artifact (row and files). @throws ArtifactError
   * `artifact_not_found`, `artifact_in_use` (an active run uses it as its item)
   */
  async delete(id: string): Promise<ArtifactRecord> {
    const record = this.options.repositories.transaction(() => {
      const current = this.require(id);
      const used = this.repo.activeRunsUsing(id);
      if (used.length > 0) {
        throw new ArtifactError('artifact_in_use', `Artifact '${id}' is in use by ${used.length === 1 ? 'run' : 'runs'} ${used.join(', ')}`, { runIds: used });
      }
      this.repo.delete(id);
      return current;
    });
    await this.removeFiles(record.id);
    this.notify(() => this.options.onDeleted?.(record));
    return record;
  }

  /** Retention: delete artifacts created before `before` (those in use are skipped). Returns the number deleted. */
  async expire(before: Date): Promise<{ deleted: number; errors: string[] }> {
    let deleted = 0;
    const errors: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      const batch = this.repo.olderThan(before, 200).filter((a) => !seen.has(a.id));
      if (batch.length === 0) break;
      for (const artifact of batch) {
        seen.add(artifact.id);
        try {
          await this.delete(artifact.id);
          deleted++;
        } catch (err) {
          if (!(err instanceof ArtifactError && (err.code === 'artifact_in_use' || err.code === 'artifact_not_found'))) errors.push(`${artifact.id}: ${errorMessage(err)}`);
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { deleted, errors };
  }

  /** Remove `artifacts/<id>[.tmp]` directories without a row that are older than the minimum age. Returns the number removed. */
  async sweepOrphans(): Promise<number> {
    const dir = dataPaths(this.options.dataDir).artifactsDir;
    const minAge = this.options.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;
    const names = await readdir(dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      const id = name.endsWith('.tmp') ? name.slice(0, -4) : name;
      if (!ARTIFACT_ID_PATTERN.test(id)) continue;
      if (!name.endsWith('.tmp') && this.repo.get(id)) continue;
      const target = path.join(dir, name);
      try {
        const st = await stat(target);
        if (this.clock.now().getTime() - st.mtimeMs < minAge) continue;
        if (!name.endsWith('.tmp') && this.repo.get(id)) continue;
        await rm(target, { recursive: true, force: true });
        removed++;
      } catch (err) {
        this.logger.warn('removing orphaned artifact directory failed', { name, error: errorMessage(err) });
      }
    }
    return removed;
  }

  private async removeFiles(id: string): Promise<void> {
    try {
      await rm(this.paths(id).dir, { recursive: true, force: true });
    } catch (err) {
      // The row is gone; the directory is an orphan that retention removes later.
      this.logger.warn('removing artifact files failed', { id, error: errorMessage(err) });
    }
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch (err) {
      this.logger.warn('artifact listener failed', { error: errorMessage(err) });
    }
  }
}

function summarize(report: CollectionReport): string {
  const parts = [`${report.created.length} artifact(s) stored, ${report.bytes} bytes`];
  if (report.warnings.length > 0) parts.push(`${report.warnings.length} not stored (${[...new Set(report.warnings.map((w) => w.reason))].join(', ')})`);
  return parts.join('; ');
}

/** A file name stem usable in `Content-Disposition` (no path separators or control characters). */
function safeFileStem(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'artifact' : cleaned;
}
