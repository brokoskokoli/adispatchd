/** Field catalogue of the artifacts source (WI-35). */
import { OPERATORS_BY_TYPE, type FieldDefinition } from '../../core/index.js';

const STRING_OPS = OPERATORS_BY_TYPE.string;

/** All fields of an artifact item (filters, views, `context.json` attributes). */
export const ARTIFACT_FIELD_DEFINITIONS: readonly FieldDefinition[] = Object.freeze([
  { name: 'id', type: 'string', description: 'Artifact ID', operators: STRING_OPS },
  { name: 'name', type: 'string', description: 'Display name', link: 'url', operators: STRING_OPS },
  { name: 'type', type: 'string', description: 'Type (execute.artifacts[].type)', operators: STRING_OPS },
  { name: 'kind', type: 'string', description: 'file | folder', operators: STRING_OPS },
  { name: 'file_name', type: 'string', description: 'Base name of the collected file or folder', operators: STRING_OPS },
  { name: 'size', type: 'number', description: 'Total size in bytes', operators: OPERATORS_BY_TYPE.number },
  { name: 'file_count', type: 'number', description: 'Number of files (1 for a file)', operators: OPERATORS_BY_TYPE.number },
  { name: 'created_at', type: 'date', description: 'Creation time', operators: OPERATORS_BY_TYPE.date },
  { name: 'workflow', type: 'string', description: 'ID of the producing workflow', operators: STRING_OPS },
  { name: 'run_id', type: 'string', description: 'ID of the producing run', operators: STRING_OPS },
  { name: 'parent', type: 'string', description: 'ID of the artifact the producing run had as input; null if none', operators: STRING_OPS },
  {
    name: 'consumed_by',
    type: 'string[]',
    description: 'IDs of the workflows that processed the artifact successfully (run completed with result success)',
    operators: OPERATORS_BY_TYPE['string[]'],
  },
  {
    name: 'attempted_by',
    type: 'string[]',
    description: 'IDs of the workflows whose run on the artifact completed, with result success or failure (retry protection)',
    operators: OPERATORS_BY_TYPE['string[]'],
  },
  { name: 'url', type: 'string', description: 'UI link of the artifact', operators: STRING_OPS },
] satisfies FieldDefinition[]);
