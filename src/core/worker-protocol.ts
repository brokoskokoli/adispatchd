/**
 * Worker protocol contract (Spec §9): environment variable names, context
 * file, result file schema and event line format. Shared by the executor
 * (writes context, parses result/events), lifecycle (shell actions), API and UI.
 */
import { z } from 'zod';
import { CONFIG_ID_PATTERN } from './ids.js';
import type { TriggerType } from './types.js';

/** Current `schema_version` of context and result files. */
export const WORKER_PROTOCOL_VERSION = 1;

/** Environment variables provided to every worker (Spec §9.1). */
export const ADISPATCH_ENV = {
  RUN_ID: 'ADISPATCH_RUN_ID',
  WORKFLOW_ID: 'ADISPATCH_WORKFLOW_ID',
  /** Only for source-bound runs. */
  SOURCE_TYPE: 'ADISPATCH_SOURCE_TYPE',
  /** Only for source-bound runs. */
  SOURCE_ID: 'ADISPATCH_SOURCE_ID',
  /** Only for source-bound runs. */
  SOURCE_ITEM_ID: 'ADISPATCH_SOURCE_ITEM_ID',
  /** Only for source-bound runs. */
  SOURCE_URL: 'ADISPATCH_SOURCE_URL',
  CONTEXT_FILE: 'ADISPATCH_CONTEXT_FILE',
  RESULT_FILE: 'ADISPATCH_RESULT_FILE',
  WORKSPACE: 'ADISPATCH_WORKSPACE',
} as const;

/** Content of `context.json` (Spec §9.1). Never contains secrets. */
export interface WorkerContext {
  schema_version: typeof WORKER_PROTOCOL_VERSION;
  run: {
    id: string;
    trigger: TriggerType;
    /** ISO-8601 */
    started_at: string;
    /** Cron slot (ISO-8601) for schedule-triggered runs. */
    scheduled_for?: string;
  };
  workflow: { id: string; name?: string };
  /** Absent for schedule/manual workflows without an item. */
  source?: {
    id: string;
    type: string;
    item_id: string;
    item_key: string;
    url: string;
    /** Cheap item fields at start time (e.g. title, labels). */
    attributes: Record<string, unknown>;
  };
  /** Validated manual-start parameters. */
  parameters: Record<string, string | number | boolean>;
  workspace: { path: string };
}

/** Maximum accepted size of a result file in bytes. */
export const MAX_RESULT_FILE_BYTES = 1024 * 1024;

/** Artifact reference in a worker result. */
export const workerArtifactSchema = z
  .object({
    type: z.string().min(1).max(64),
    name: z.string().max(500).optional(),
    url: z.string().max(4096).optional(),
  })
  .loose();

/** Schema of the result file `ADISPATCH_RESULT_FILE` (Spec §9.2). */
export const workerResultSchema = z.object({
  schema_version: z.literal(WORKER_PROTOCOL_VERSION),
  result: z.enum(['success', 'failure']),
  message: z.string().max(10_000).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.array(workerArtifactSchema).max(100).optional(),
  /**
   * Named business outcome (WI-17), e.g. `approved`; selects the hook
   * `on_result.<outcome>`. Values not in config-ID format are dropped by
   * {@link parseWorkerResult} with a warning (never a protocol error).
   */
  outcome: z.string().regex(CONFIG_ID_PATTERN).optional(),
});

/** Validated worker result. */
export type WorkerResult = z.infer<typeof workerResultSchema>;

/** Artifact entry of a {@link WorkerResult}. */
export type WorkerArtifact = z.infer<typeof workerArtifactSchema>;

/**
 * Parse and validate result-file content. Returns a discriminated result
 * instead of throwing; any problem means a technical protocol error (Spec §8.2 rule 4).
 */
export function parseWorkerResult(
  content: string,
): { ok: true; result: WorkerResult; warnings: string[] } | { ok: false; error: string } {
  if (Buffer.byteLength(content, 'utf8') > MAX_RESULT_FILE_BYTES) {
    return { ok: false, error: `result file exceeds ${MAX_RESULT_FILE_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    return { ok: false, error: `result file is not valid JSON: ${(err as Error).message}` };
  }
  const warnings: string[] = [];
  json = dropInvalidOutcome(json, warnings);
  const parsed = workerResultSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `result file does not match schema: ${issues}` };
  }
  return { ok: true, result: parsed.data, warnings };
}

/**
 * An `outcome` that is not a config ID is ignored (WI-17): the rest of the
 * result is evaluated normally and the run gets a warning.
 */
function dropInvalidOutcome(json: unknown, warnings: string[]): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json) || !Object.hasOwn(json, 'outcome')) return json;
  const { outcome, ...rest } = json as Record<string, unknown>;
  if (typeof outcome === 'string' && CONFIG_ID_PATTERN.test(outcome)) return json;
  warnings.push(
    `outcome ignored: expected an ID (letters, digits, "_" and "-", starting with a letter or digit, max. 64), got ${previewValue(outcome)}`,
  );
  return rest;
}

/** Short description of an untrusted JSON value; never serializes more than a bounded prefix. */
function previewValue(value: unknown, max = 80): string {
  if (typeof value === 'string') {
    return value.length > max ? `${JSON.stringify(value.slice(0, max))}…` : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `an array (${value.length} entries)`;
  if (typeof value === 'object' && value !== null) return 'an object';
  return String(value);
}

/** Reserved line prefix for structured worker events (Spec §9.3). */
export const ADISPATCH_EVENT_PREFIX = '@@ADISPATCH_EVENT ';

/** Maximum accepted length of one event line's JSON payload. */
export const MAX_EVENT_LINE_BYTES = 64 * 1024;

/** Minimal schema of an event payload: an object with a string `type`. */
export const workerEventPayloadSchema = z
  .object({
    type: z.string().min(1).max(64),
  })
  .loose();
