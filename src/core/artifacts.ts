/**
 * Artifacts (WI-35): files or folders that workflows produce (`execute.artifacts`)
 * and that other workflows can process as items of the source `type: artifacts`.
 *
 * Only shared types and tiny pure helpers live here; collection, storage and
 * the source adapter belong to the `artifacts` and `sources` components.
 */
import { randomBytes } from 'node:crypto';
import { systemClock, type Clock } from './clock.js';
import { keepPatternError } from './glob.js';
import { formatCompactTimestamp } from './ids.js';
import { sanitizeSegment } from './paths.js';

/** `sources.yaml` source type of artifacts (at most one source of this type). */
export const ARTIFACT_SOURCE_TYPE = 'artifacts';

/** Kinds of artifacts: a single file or a folder (the "group"). */
export const ARTIFACT_KINDS = ['file', 'folder'] as const;

/** Kind of an artifact. */
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Directory inside the workspace that receives the artifact input of a run. */
export const ARTIFACT_INPUT_DIR = 'inputs';

/** Pattern of artifact IDs produced by {@link createArtifactId}. */
export const ARTIFACT_ID_PATTERN = /^art-\d{8}T\d{9}Z-[0-9a-f]{8}$/;

/** True if `id` has the artifact ID format. */
export function isValidArtifactId(id: string): boolean {
  return ARTIFACT_ID_PATTERN.test(id);
}

/**
 * New artifact ID: `art-<YYYYMMDDTHHMMSSmmmZ>-<8 hex>`; sorts chronologically
 * and is safe as a path segment and in URLs.
 */
export function createArtifactId(options: { clock?: Clock; randomBytes?: (size: number) => Uint8Array } = {}): string {
  const clock = options.clock ?? systemClock;
  const hex = Buffer.from((options.randomBytes ?? randomBytes)(4)).toString('hex').padStart(8, '0').slice(0, 8);
  return `art-${formatCompactTimestamp(clock.now(), true)}-${hex}`;
}

/** A stored artifact (immutable once created, except `consumedBy`). */
export interface ArtifactRecord {
  id: string;
  /** Display name (rendered `execute.artifacts[].name`). */
  name: string;
  /** Free type used for filtering (`execute.artifacts[].type`). */
  type: string;
  kind: ArtifactKind;
  /** Base name of the collected file or folder (download name). */
  fileName: string;
  /** Total bytes of the stored content (after redaction). */
  size: number;
  /** Number of stored files (1 for a file). */
  fileCount: number;
  /** Producing workflow. */
  workflowId: string;
  /** Producing run (the run itself may be deleted by retention). */
  runId: string;
  /** Position in the producing workflow's `execute.artifacts` list. */
  ordinal: number;
  /** ID of the artifact the producing run had as input; kept as text after that artifact was deleted. */
  parentId: string | null;
  /** IDs of the workflows that processed the artifact successfully (run `completed` with result `success`). */
  consumedBy: string[];
  /** ISO time. */
  createdAt: string;
}

/** Read access to the artifact catalogue for the source adapter. */
export interface ArtifactCatalog {
  /** All artifacts, newest first. */
  list(): ArtifactRecord[];
  get(id: string): ArtifactRecord | null;
}

/** Name of the entry below `inputs/` for the input artifact `record` (a sanitized, single path segment). */
export function artifactInputName(record: Pick<ArtifactRecord, 'name' | 'kind' | 'fileName'>): string {
  const base = sanitizeSegment(record.name);
  if (record.kind === 'folder') return base;
  // A file keeps its extension so that tools can recognize it.
  const ext = /\.[A-Za-z0-9]{1,16}$/.exec(record.fileName)?.[0] ?? '';
  return ext !== '' && !/\.[A-Za-z0-9]{1,16}$/.test(base) ? `${base}${ext}` : base;
}

/** Item-relative path of the input in the workspace (`inputs/<name>`, `/`-separated). */
export function artifactInputRelPath(record: Pick<ArtifactRecord, 'name' | 'kind' | 'fileName'>): string {
  return `${ARTIFACT_INPUT_DIR}/${artifactInputName(record)}`;
}

/** UI route of an artifact. */
export function artifactRoute(id: string): string {
  return `#/artifacts/${encodeURIComponent(id)}`;
}

/** Max. length of a rendered artifact name. */
export const ARTIFACT_NAME_MAX_LENGTH = 200;
/** Max. length of an artifact type. */
export const ARTIFACT_TYPE_MAX_LENGTH = 64;

/**
 * Why `path` is not a valid `execute.artifacts[].path`, or `null`: a literal,
 * relative `/`-separated workspace path (no wildcards, no `..`, not absolute).
 */
export function artifactPathError(path: string): string | null {
  const error = keepPatternError(path);
  if (error) return error.replace(/^Pattern/, 'Path').replace('only files inside the workspace can be kept', 'only paths inside the workspace can be collected');
  if (/[*?]/.test(path)) return 'Path must be a literal file or folder (no "*" or "?")';
  return null;
}

/** A configured path without the leading `./`. */
export function normalizeArtifactPath(path: string): string {
  let p = path;
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/**
 * `{item.name}` / `{item.type}` / `{item.path}` of an artifact item from its
 * field values (see the artifacts source). `workspacePath` is the workspace as
 * the consumer sees it; without it there is no `path`.
 */
export function artifactTemplateItem(
  fields: Readonly<Record<string, unknown>>,
  workspacePath?: string,
): { name?: string; type?: string; path?: string } {
  const name = typeof fields.name === 'string' ? fields.name : undefined;
  const type = typeof fields.type === 'string' ? fields.type : undefined;
  const kind = fields.kind === 'folder' ? 'folder' : 'file';
  const fileName = typeof fields.file_name === 'string' ? fields.file_name : '';
  return {
    ...(name !== undefined ? { name } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(name !== undefined && workspacePath !== undefined
      ? { path: `${workspacePath.replace(/\/+$/, '')}/${artifactInputRelPath({ name, kind, fileName })}` }
      : {}),
  };
}
