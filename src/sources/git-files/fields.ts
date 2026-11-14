/**
 * Field catalogue of the `git_files` source (WI-40): built-in fields read from
 * the frontmatter or derived from it, plus the frontmatter keys declared in
 * `sources.yaml` (`fields: { <key>: <type> }`).
 */
import { OPERATORS_BY_TYPE, type FieldDefinition, type FieldType, type FieldUpdateValue } from '../../core/index.js';

const STRING_OPS = OPERATORS_BY_TYPE.string;
const NUMBER_OPS = OPERATORS_BY_TYPE.number;
const BOOLEAN_OPS = OPERATORS_BY_TYPE.boolean;
const DATE_OPS = OPERATORS_BY_TYPE.date;
const LIST_OPS = OPERATORS_BY_TYPE['string[]'];

/** Types a frontmatter key can be declared with (`fields:` in `sources.yaml`). */
export const GIT_FILES_DECLARABLE_TYPES = ['string', 'number', 'boolean', 'date', 'string[]'] as const;

/** Declared type of a frontmatter key. */
export type GitFilesFieldType = (typeof GIT_FILES_DECLARABLE_TYPES)[number];

/** Pattern of a declarable frontmatter key (usable as field name in filters and views). */
export const GIT_FILES_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** Dependency fields, derived from `blocked_by` and the state of the referenced items. */
export const GIT_FILES_DEPENDENCY_FIELDS = [
  'dependencies.blocked_by_total',
  'dependencies.blocked_by_open',
  'dependencies.blocked',
  'dependencies.status',
] as const;

/** Built-in fields of a `git_files` item. All are cheap (the files are local). */
export const GIT_FILES_FIELD_DEFINITIONS: readonly FieldDefinition[] = Object.freeze([
  { name: 'number', type: 'number', description: 'Item number (frontmatter `id`, else the number prefix of the file name)', link: 'url', operators: NUMBER_OPS },
  { name: 'id', type: 'number', description: 'Same as number', operators: NUMBER_OPS },
  { name: 'title', type: 'string', description: 'Frontmatter `title`', link: 'url', operators: STRING_OPS },
  {
    name: 'state',
    type: 'string',
    description: 'open | closed, derived from `closed_when` of the source',
    operators: STRING_OPS,
    pushdown: ['equals', 'in'],
  },
  { name: 'status', type: 'string', description: 'Frontmatter `status`; null if absent', operators: STRING_OPS },
  { name: 'labels', type: 'string[]', description: 'Frontmatter `labels` (compared case-insensitively)', operators: LIST_OPS, caseInsensitive: true },
  { name: 'milestone', type: 'string', description: 'Frontmatter `milestone`; null if absent', operators: STRING_OPS },
  { name: 'blocked_by', type: 'string[]', description: 'Frontmatter `blocked_by`: numbers of items of the same source blocking this one', operators: LIST_OPS },
  { name: 'branch', type: 'string', description: 'Frontmatter `branch`; null if absent', operators: STRING_OPS },
  { name: 'pr', type: 'number', description: 'Frontmatter `pr` (number, `#123` or a PR URL); null if absent', operators: NUMBER_OPS },
  { name: 'spec', type: 'string', description: 'Frontmatter `spec`; null if absent', operators: STRING_OPS },
  { name: 'files', type: 'string[]', description: 'Frontmatter `files`', operators: LIST_OPS },
  { name: 'created_at', type: 'date', description: 'Frontmatter `created_at` or `created`; null if absent', operators: DATE_OPS },
  { name: 'body', type: 'string', description: 'Markdown after the frontmatter, without the comment section', operators: STRING_OPS },
  {
    name: 'comments',
    type: 'object[]',
    description: 'Entries of the comment section: { at, author, text }, oldest first',
    operators: [],
    filterHint: 'it lists the comment entries; filter on "body" or a frontmatter field instead',
  },
  { name: 'path', type: 'string', description: 'Path of the file relative to the repository root', operators: STRING_OPS },
  { name: 'url', type: 'string', description: 'Web URL of the file (web_url of the source), else the item history page', operators: STRING_OPS },
  { name: 'dependencies.blocked_by_total', type: 'number', description: 'Number of entries in blocked_by', operators: NUMBER_OPS },
  {
    name: 'dependencies.blocked_by_open',
    type: 'number',
    description: 'Number of blockers that are not closed; unknown if a blocker is not a valid item of the source',
    operators: NUMBER_OPS,
  },
  { name: 'dependencies.blocked', type: 'boolean', description: 'True if at least one blocker is open; unknown like blocked_by_open', operators: BOOLEAN_OPS },
  { name: 'dependencies.status', type: 'string', description: '"ok" if every blocker was found, otherwise "unknown"', operators: STRING_OPS },
  { name: 'work_branch', type: 'string', description: 'Same as branch', operators: STRING_OPS },
  { name: 'work_pr', type: 'number', description: 'Same as pr', link: 'work_pr_url', operators: NUMBER_OPS },
  { name: 'work_pr_url', type: 'string', description: 'The PR URL if `pr` is given as URL; null otherwise', operators: STRING_OPS },
] satisfies FieldDefinition[]);

/** Names of the built-in fields. */
export const GIT_FILES_BUILTIN_FIELDS: ReadonlySet<string> = new Set(GIT_FILES_FIELD_DEFINITIONS.map((d) => d.name));

/**
 * Built-in fields that `source.update.fields` may set: they are frontmatter
 * keys of their own (everything else is derived, or `labels`, which has its own
 * `labels: { add, remove }`). `created_at` is written as `created_at`.
 */
export const GIT_FILES_WRITABLE_BUILTINS: Readonly<Record<string, GitFilesFieldType>> = Object.freeze({
  title: 'string',
  status: 'string',
  milestone: 'string',
  blocked_by: 'string[]',
  branch: 'string',
  pr: 'number',
  spec: 'string',
  files: 'string[]',
  created_at: 'date',
});

/** Field definition of a declared frontmatter key. */
export function gitFilesDeclaredFieldDefinition(name: string, type: GitFilesFieldType): FieldDefinition {
  const fieldType: FieldType = type;
  return { name, type: fieldType, description: `Frontmatter "${name}" (${type}); null if absent`, operators: OPERATORS_BY_TYPE[fieldType] };
}

/** Field definitions of all declared frontmatter keys (in declaration order). */
export function gitFilesDeclaredFieldDefinitions(fields: Readonly<Record<string, GitFilesFieldType>>): FieldDefinition[] {
  return Object.entries(fields).map(([name, type]) => gitFilesDeclaredFieldDefinition(name, type));
}

/** Type of a writable frontmatter key (`source.update.fields`), or `undefined` if it cannot be set. */
export function gitFilesWritableType(name: string, declared: Readonly<Record<string, GitFilesFieldType>>): GitFilesFieldType | undefined {
  if (Object.hasOwn(GIT_FILES_WRITABLE_BUILTINS, name)) return GIT_FILES_WRITABLE_BUILTINS[name];
  if (Object.hasOwn(declared, name)) return declared[name];
  return undefined;
}

/** Problem with a value for a frontmatter key of `type` (`null` always allowed = remove), or `undefined`. */
export function gitFilesValueProblem(type: GitFilesFieldType, value: unknown): string | undefined {
  if (value === null) return undefined;
  switch (type) {
    case 'string':
      return typeof value === 'string' || typeof value === 'number' ? undefined : 'expected a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'expected a number';
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'expected true or false';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'expected an ISO-8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM])';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number') ? undefined : 'expected a list of strings';
  }
}

/** Problem with a value for the writable field `name` of `type` (adds the rules of `blocked_by`), or `undefined`. */
export function gitFilesFieldValueProblem(name: string, type: GitFilesFieldType, value: unknown): string | undefined {
  const problem = gitFilesValueProblem(type, value);
  if (problem) return problem;
  if (name === 'blocked_by' && Array.isArray(value) && !value.every((v) => /^#?\d{1,9}$/.test(String(v).trim()) && Number(String(v).trim().replace(/^#/, '')) > 0)) {
    return 'expected a list of item numbers (e.g. [12, 15])';
  }
  return undefined;
}

/** Normalize a valid update value for writing (numbers in string fields stay as written). */
export function gitFilesUpdateValue(type: GitFilesFieldType, value: FieldUpdateValue): FieldUpdateValue {
  if (type === 'string[]' && Array.isArray(value)) return value.map((v) => String(v));
  return value;
}
