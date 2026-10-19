/**
 * Field catalogue of the GitHub source adapter (Spec §6, §17), including the
 * per-source GitHub Projects (v2) fields `project.<name>` (WI-14).
 */
import { LINKED_ITEM_FIELDS, OPERATORS_BY_TYPE, type FieldDefinition, type FieldType } from '../../core/index.js';

const STRING_OPS = OPERATORS_BY_TYPE.string;
const NUMBER_OPS = OPERATORS_BY_TYPE.number;
const BOOLEAN_OPS = OPERATORS_BY_TYPE.boolean;
const DATE_OPS = OPERATORS_BY_TYPE.date;
const LIST_OPS = OPERATORS_BY_TYPE['string[]'];

/** Names of the expensive dependency fields (resolved lazily via one API round trip). */
export const DEPENDENCY_FIELDS = [
  'dependencies.blocked_by_total',
  'dependencies.blocked_by_open',
  'dependencies.blocked',
  'dependencies.status',
] as const;

/**
 * Names of the expensive linked-branch/PR fields (WI-21), resolved together by
 * ONE GraphQL query per item. `work_pr_url` is the link target of `work_pr` in views.
 */
export const LINKED_FIELDS = LINKED_ITEM_FIELDS;

/** All fields provided by the GitHub adapter. */
export const GITHUB_FIELD_DEFINITIONS: readonly FieldDefinition[] = Object.freeze([
  { name: 'number', type: 'number', description: 'Issue/PR number', link: 'url', operators: NUMBER_OPS },
  { name: 'title', type: 'string', description: 'Title', link: 'url', operators: STRING_OPS },
  {
    name: 'state',
    type: 'string',
    description: 'open | closed',
    operators: STRING_OPS,
    pushdown: ['equals', 'in'],
  },
  {
    name: 'labels',
    type: 'string[]',
    description: 'Label names (compared case-insensitively, like GitHub)',
    operators: LIST_OPS,
    pushdown: ['contains'],
    caseInsensitive: true,
  },
  { name: 'assignees', type: 'string[]', description: 'Assignee logins', operators: LIST_OPS },
  { name: 'author', type: 'string', description: 'Login of the author', operators: STRING_OPS },
  { name: 'is_pull_request', type: 'boolean', description: 'True for pull requests', operators: BOOLEAN_OPS },
  { name: 'created_at', type: 'date', description: 'Creation time', operators: DATE_OPS },
  { name: 'updated_at', type: 'date', description: 'Last update time', operators: DATE_OPS },
  { name: 'url', type: 'string', description: 'Web URL', operators: STRING_OPS },
  { name: 'repository', type: 'string', description: 'owner/name', operators: STRING_OPS },
  {
    name: 'state_reason',
    type: 'string',
    description: 'Why the issue was closed/reopened (completed, not_planned, reopened, duplicate, …); null if not set',
    operators: STRING_OPS,
  },
  { name: 'milestone', type: 'string', description: 'Milestone title; null without milestone', operators: STRING_OPS },
  { name: 'issue_type', type: 'string', description: 'Issue type name (e.g. Bug, Feature, Task); null without type', operators: STRING_OPS },
  {
    name: 'dependencies.blocked_by_total',
    type: 'number',
    description: 'Number of issues blocking this one (native "blocked by", incl. cross-repo)',
    operators: NUMBER_OPS,
    expensive: true,
  },
  {
    name: 'dependencies.blocked_by_open',
    type: 'number',
    description: 'Number of OPEN issues blocking this one; unknown without access',
    operators: NUMBER_OPS,
    expensive: true,
  },
  {
    name: 'dependencies.blocked',
    type: 'boolean',
    description: 'True if at least one blocker is open; unknown without access',
    operators: BOOLEAN_OPS,
    expensive: true,
  },
  {
    name: 'dependencies.status',
    type: 'string',
    description: '"ok" if dependencies were fully resolved, otherwise "unknown"',
    operators: STRING_OPS,
    expensive: true,
  },
  {
    name: 'linked_branches',
    type: 'string[]',
    description: 'Branches of the same repository linked under "Development" (issues; [] for PRs)',
    operators: LIST_OPS,
    expensive: true,
  },
  {
    name: 'closing_prs',
    type: 'object[]',
    description:
      'PRs of the same repository that close the issue: { number, state (open|merged|closed), head_ref, is_draft, url }; ' +
      'open first, then merged, then closed, each by number ([] for PRs)',
    operators: [],
    expensive: true,
    filterHint: 'use "work_pr" (e.g. { field: work_pr, operator: not_equals, value: null }) or "work_branch" instead',
  },
  {
    name: 'work_branch',
    type: 'string',
    description: 'Work branch: first linked branch, else head_ref of the first open, then of the first merged closing PR; PRs: own head_ref; null if none',
    operators: STRING_OPS,
    expensive: true,
  },
  {
    name: 'work_pr',
    type: 'number',
    description: 'Number of the first open closing PR; PRs: own number while open; null if none',
    link: 'work_pr_url',
    operators: NUMBER_OPS,
    expensive: true,
  },
  {
    name: 'work_pr_url',
    type: 'string',
    description: 'URL of the work_pr PR; null if none',
    operators: STRING_OPS,
    expensive: true,
  },
] satisfies FieldDefinition[]);

/** Prefix of GitHub Projects (v2) fields: `project.<name>`. */
export const PROJECT_FIELD_PREFIX = 'project.';

/** Kinds of project fields that can be declared in `sources.yaml` (`project.fields`). */
export const PROJECT_FIELD_KINDS = ['single_select', 'text', 'number', 'date', 'iteration'] as const;

/** Kind of a declared project field. */
export type ProjectFieldKind = (typeof PROJECT_FIELD_KINDS)[number];

/** Field type per project field kind (single select: option name, iteration: iteration title). */
export const PROJECT_FIELD_TYPES: Readonly<Record<ProjectFieldKind, FieldType>> = {
  single_select: 'string',
  text: 'string',
  iteration: 'string',
  number: 'number',
  date: 'date',
};

/** GitHub `ProjectV2FieldType` (`dataType`) expected per kind. */
export const PROJECT_FIELD_DATA_TYPES: Readonly<Record<ProjectFieldKind, string>> = {
  single_select: 'SINGLE_SELECT',
  text: 'TEXT',
  iteration: 'ITERATION',
  number: 'NUMBER',
  date: 'DATE',
};

/** Field definition of the declared project field `name` (full field name `project.<name>`). */
export function projectFieldDefinition(name: string, kind: ProjectFieldKind): FieldDefinition {
  const type = PROJECT_FIELD_TYPES[kind];
  return {
    name: `${PROJECT_FIELD_PREFIX}${name}`,
    type,
    description: `GitHub Projects field "${name}" (${kind}); null if empty or the item is not in the project`,
    operators: OPERATORS_BY_TYPE[type],
  };
}

/** Field definitions of all declared project fields (in declaration order). */
export function projectFieldDefinitions(fields: Readonly<Record<string, ProjectFieldKind>>): FieldDefinition[] {
  return Object.entries(fields).map(([name, kind]) => projectFieldDefinition(name, kind));
}
