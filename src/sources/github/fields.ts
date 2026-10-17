/**
 * Field catalogue of the GitHub source adapter (Spec §6, §17).
 */
import { OPERATORS_BY_TYPE, type FieldDefinition } from '../../core/index.js';

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
] satisfies FieldDefinition[]);
