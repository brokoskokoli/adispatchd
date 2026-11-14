/**
 * One item file of a `git_files` source (WI-40): Markdown with YAML
 * frontmatter, optionally ending with a comment section.
 *
 * ```markdown
 * ---
 * id: 42
 * title: Fix the login
 * status: todo
 * labels: [bug]
 * ---
 * Description …
 *
 * ## Log
 *
 * ### 2026-11-14T10:00:00Z — coordinator
 * Started.
 *
 * <!-- adispatchd:run-…:on_start.0 -->
 * ```
 *
 * Edits are local: frontmatter changes rewrite only the frontmatter (through
 * the `yaml` Document API, which keeps key order, comments and scalar styles),
 * comments are only appended at the end. Everything else stays byte-for-byte,
 * so git merges concurrent edits of the body cleanly.
 */
import { isMap, isSeq, isScalar, parseDocument, YAMLMap, YAMLSeq, type Document } from 'yaml';
import type { FieldUpdateValue } from '../../core/index.js';

/** File name of an item: number prefix, optional `-<slug>`, `.md`. */
export const ITEM_FILE_PATTERN = /^(\d{1,9})(?:-[^/\\]*)?\.md$/;

/** Default heading of the comment section. */
export const DEFAULT_COMMENTS_HEADING = '## Log';

/** Largest item file that is read (bytes); larger files are skipped as malformed. */
export const MAX_ITEM_FILE_BYTES = 1024 * 1024;

/** A malformed item file (the message names the problem, never the content). */
export class ItemFileError extends Error {}

/** One entry of the comment section. */
export interface CommentEntry {
  /** Time as written in the entry header. */
  at: string;
  author: string;
  text: string;
  /** Idempotency marker (last line `<!-- adispatchd:… -->`), `null` if none. */
  marker: string | null;
}

/** Parsed content of an item file. */
export interface ParsedItemFile {
  /** Frontmatter as plain data (a mapping; `{}` if empty). */
  data: Record<string, unknown>;
  /** Markdown after the frontmatter without the comment section (trailing whitespace removed). */
  body: string;
  comments: CommentEntry[];
}

interface Split {
  /** Text before the frontmatter content (`---\n`). */
  open: string;
  frontmatter: string;
  /** Closing line incl. its line break. */
  close: string;
  rest: string;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

function split(text: string): Split {
  const open = OPEN.exec(text);
  if (!open) throw new ItemFileError('the file does not start with a frontmatter block ("---")');
  const after = text.slice(open[0].length);
  // An empty frontmatter: the closing line follows immediately.
  const close = CLOSE.exec(after);
  if (!close) throw new ItemFileError('the frontmatter block is not closed ("---")');
  return {
    open: open[0],
    frontmatter: after.slice(0, close.index),
    close: close[0],
    rest: after.slice(close.index + close[0].length),
  };
}

function parseFrontmatter(frontmatter: string): Document.Parsed {
  const doc = parseDocument(frontmatter, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new ItemFileError(`invalid YAML in the frontmatter: ${(first?.message ?? 'parse error').split('\n')[0]}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) throw new ItemFileError('the frontmatter is not a mapping (key: value)');
  return doc;
}

/** Entry header `### <time> — <author>` (also `-` or `–` as separator). */
const ENTRY_HEADER = /^### (\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+)?(?:Z|[+-]\d{2}:?\d{2})?) [—–-] (.+?)\s*$/;
const MARKER_LINE = /^<!-- (adispatchd:[A-Za-z0-9_.:-]+) -->$/;

function headingIndex(lines: readonly string[], heading: string): number {
  return lines.findIndex((l) => l.trimEnd() === heading);
}

/** Parse an item file. Throws {@link ItemFileError} when it is malformed. */
export function parseItemFile(text: string, commentsHeading: string = DEFAULT_COMMENTS_HEADING): ParsedItemFile {
  const parts = split(text);
  const doc = parseFrontmatter(parts.frontmatter);
  const data = (doc.toJS({ maxAliasCount: 50 }) ?? {}) as Record<string, unknown>;
  const lines = parts.rest.split(/\r?\n/);
  const at = headingIndex(lines, commentsHeading);
  const body = (at < 0 ? lines : lines.slice(0, at)).join('\n').replace(/\s+$/, '');
  return { data, body, comments: at < 0 ? [] : parseEntries(lines.slice(at + 1)) };
}

function parseEntries(lines: readonly string[]): CommentEntry[] {
  const entries: CommentEntry[] = [];
  let current: { at: string; author: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    const textLines = text.split('\n');
    const last = textLines[textLines.length - 1]?.trim() ?? '';
    const marker = MARKER_LINE.exec(last)?.[1] ?? null;
    entries.push({
      at: current.at,
      author: current.author,
      text: (marker ? textLines.slice(0, -1).join('\n') : text).trim().replace(/^\\(?=### )/gm, ''),
      marker,
    });
  };
  for (const line of lines) {
    const header = ENTRY_HEADER.exec(line);
    if (header) {
      flush();
      current = { at: header[1] as string, author: header[2] as string, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return entries;
}

// ---------------------------------------------------------------------------
// Edits

/** Changes to the frontmatter. */
export interface FrontmatterEdit {
  labels?: { add: readonly string[]; remove: readonly string[] };
  /** Key → value; `null` removes the key. */
  fields?: Readonly<Record<string, FieldUpdateValue>>;
}

/** Result of {@link editFrontmatter}. */
export interface FrontmatterEditResult {
  /** New file text; equal to the input when nothing changed. */
  text: string;
  labelsAdded: string[];
  labelsRemoved: string[];
  /** Changed keys → new value / old value (`null` = absent). */
  fields: Record<string, FieldUpdateValue>;
  fieldsPrevious: Record<string, FieldUpdateValue>;
}

function labelList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
  return typeof value === 'string' || typeof value === 'number' ? [String(value)] : [];
}

function plain(value: unknown): FieldUpdateValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function sameValue(a: FieldUpdateValue, b: FieldUpdateValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * Apply `edit` to the frontmatter of `text`. Only what differs is changed
 * (labels case-insensitively; a label in both lists is added). The text after
 * the frontmatter is kept unchanged.
 */
export function editFrontmatter(text: string, edit: FrontmatterEdit): FrontmatterEditResult {
  const parts = split(text);
  const doc = parseFrontmatter(parts.frontmatter);
  if (doc.contents === null) doc.contents = new YAMLMap() as unknown as typeof doc.contents;
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  const result: FrontmatterEditResult = { text, labelsAdded: [], labelsRemoved: [], fields: {}, fieldsPrevious: {} };

  if (edit.labels && (edit.labels.add.length > 0 || edit.labels.remove.length > 0)) {
    const current = labelList(data.labels);
    const lower = new Set(current.map((l) => l.toLowerCase()));
    const addLower = new Set(edit.labels.add.map((l) => l.toLowerCase()));
    const toAdd: string[] = [];
    for (const label of edit.labels.add) {
      if (label === '' || lower.has(label.toLowerCase())) continue;
      lower.add(label.toLowerCase());
      toAdd.push(label);
    }
    const removeLower = new Set(edit.labels.remove.map((l) => l.toLowerCase()).filter((l) => !addLower.has(l)));
    const toRemove = current.filter((l) => removeLower.has(l.toLowerCase()));
    if (toAdd.length > 0 || toRemove.length > 0) {
      const node = doc.get('labels', true);
      if (isSeq(node)) {
        // Edit the existing sequence in place: keeps flow/block style and comments of the other entries.
        const seq = node as YAMLSeq;
        seq.items = seq.items.filter((item) => {
          const v = isScalar(item) ? item.value : item;
          return !(typeof v === 'string' || typeof v === 'number') || !removeLower.has(String(v).toLowerCase());
        });
        for (const label of toAdd) seq.items.push(doc.createNode(label));
      } else {
        const next = [...current.filter((l) => !removeLower.has(l.toLowerCase())), ...toAdd];
        const seq = doc.createNode(next) as YAMLSeq;
        seq.flow = true;
        doc.set('labels', seq);
      }
      result.labelsAdded = toAdd;
      result.labelsRemoved = toRemove;
    }
  }

  for (const [key, value] of Object.entries(edit.fields ?? {})) {
    const has = Object.hasOwn(data, key);
    const previous = has ? plain(data[key]) : null;
    if (value === null) {
      if (!has) continue;
      doc.delete(key);
    } else {
      if (has && sameValue(previous, value)) continue;
      const node = doc.createNode(Array.isArray(value) ? [...value] : value);
      if (isSeq(node)) node.flow = true;
      const existing = doc.get(key, true);
      // Keep a comment that trails the old value on the same line.
      if (existing && typeof existing === 'object' && 'comment' in existing && isScalar(node)) node.comment = (existing as { comment?: string | null }).comment ?? null;
      doc.set(key, node);
    }
    result.fields[key] = value;
    result.fieldsPrevious[key] = previous;
  }

  const changed = result.labelsAdded.length > 0 || result.labelsRemoved.length > 0 || Object.keys(result.fields).length > 0;
  if (!changed) return result;
  let frontmatter = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (parts.frontmatter.includes('\r\n')) frontmatter = frontmatter.replace(/\r?\n/g, '\r\n');
  result.text = `${parts.open}${frontmatter}${parts.close}${parts.rest}`;
  return result;
}

/** A new comment entry for {@link appendComment}. */
export interface NewCommentEntry {
  heading: string;
  /** ISO time (seconds precision). */
  at: string;
  author: string;
  text: string;
  /** Marker without `<!-- -->`, e.g. `adispatchd:run-…:on_start.0`. */
  marker: string;
}

/** Make an author name safe for the one-line entry header. */
export function entryAuthor(name: string): string {
  const clean = name.replace(/[\r\n\t]+/g, ' ').replace(/<!--/g, '').trim();
  return clean === '' ? 'adispatchd' : clean.slice(0, 100);
}

/**
 * Append a comment entry at the end of the file (creating the comment
 * section if it is missing). Lines of the text that look like an entry header
 * are escaped (`\### …`) so that the text cannot split itself into entries;
 * HTML comment openers are neutralised (no forged markers).
 */
export function appendComment(text: string, entry: NewCommentEntry): string {
  if (!MARKER_LINE.test(`<!-- ${entry.marker} -->`)) throw new ItemFileError('invalid comment marker');
  const parts = split(text);
  const lines = parts.rest.split(/\r?\n/);
  let out = text.replace(/[ \t]*$/, '');
  if (!out.endsWith('\n')) out += '\n';
  if (headingIndex(lines, entry.heading) < 0) out += `\n${entry.heading}\n`;
  const body = entry.text
    .replace(/<!--/g, '&lt;!--')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => (ENTRY_HEADER.test(l) ? `\\${l}` : l))
    .join('\n')
    .trim();
  out += `\n### ${entry.at} — ${entryAuthor(entry.author)}\n\n${body === '' ? '(empty)' : body}\n\n<!-- ${entry.marker} -->\n`;
  return out;
}

/** Text of a new item file (frontmatter in the given key order, then the body). */
export function renderNewItemFile(frontmatter: Readonly<Record<string, unknown>>, body: string): string {
  const doc = parseDocument('{}');
  const map = new YAMLMap();
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    const node = doc.createNode(value);
    if (isSeq(node)) node.flow = true;
    map.set(doc.createNode(key), node);
  }
  doc.contents = map as unknown as typeof doc.contents;
  const trimmed = body.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return `---\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}---\n${trimmed === '' ? '' : `\n${trimmed}\n`}`;
}

/** Slug for a file name from a title (`Fix the login!` → `fix-the-login`). */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug === '' ? 'item' : slug;
}
