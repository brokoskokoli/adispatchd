/**
 * Versioned schema migrations (Spec §12). Migrations are append-only: never
 * edit a released migration, add a new version instead.
 */
import type { DatabaseSync } from 'node:sqlite';

/** One schema migration. Applied in its own transaction together with its `schema_migrations` row. */
export interface Migration {
  /** Strictly increasing, starting at 1. */
  version: number;
  /** Short identifier for diagnostics. */
  name: string;
  /** Apply the migration. Runs inside a transaction; must not COMMIT/ROLLBACK itself. */
  up(db: DatabaseSync): void;
  /**
   * Run with `PRAGMA foreign_keys = OFF` (SQLite's procedure for rebuilding a
   * referenced table: dropping it would otherwise cascade). The runner checks
   * `PRAGMA foreign_key_check` before committing and re-enables foreign keys.
   */
  disableForeignKeys?: boolean;
}

const ACTIVE_STATUS_SQL = `('reserved','starting','running','cancelling','finalizing','recovery_pending')`;

const V1_DDL = `
CREATE TABLE runs (
  id                      TEXT PRIMARY KEY,
  workflow_id             TEXT NOT NULL,
  trigger_type            TEXT NOT NULL CHECK (trigger_type IN ('source','schedule','manual')),
  source_id               TEXT,
  source_item_key         TEXT,
  source_url              TEXT,
  lock_key                TEXT NOT NULL,
  scheduled_for           TEXT,
  config_snapshot         TEXT NOT NULL,
  parameters_json         TEXT,
  identity                TEXT,
  command                 TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('reserved','starting','running','cancelling','finalizing',
                            'completed','crashed','start_error','timed_out','cancelled','recovery_pending')),
  final_status            TEXT CHECK (final_status IN ('completed','crashed','start_error','timed_out','cancelled')),
  business_result         TEXT CHECK (business_result IN ('success','failure')),
  final_reason            TEXT,
  exit_code               INTEGER,
  pid                     INTEGER,
  process_start_identity  TEXT,
  workspace_path          TEXT,
  status_message          TEXT,
  result_json             TEXT,
  error_json              TEXT,
  lifecycle_status        TEXT CHECK (lifecycle_status IN ('pending','running','succeeded','failed')),
  block_generation        INTEGER,
  counted_technical_failure INTEGER NOT NULL DEFAULT 0 CHECK (counted_technical_failure IN (0,1)),
  created_at              TEXT NOT NULL,
  started_at              TEXT,
  finalizing_at           TEXT,
  finished_at             TEXT,
  updated_at              TEXT NOT NULL
);
CREATE INDEX runs_workflow_created ON runs (workflow_id, created_at DESC);
CREATE INDEX runs_item_created ON runs (source_item_key, created_at DESC);
CREATE INDEX runs_status ON runs (status);
CREATE INDEX runs_finished ON runs (finished_at);
CREATE INDEX runs_created ON runs (created_at DESC);
-- Second line of defence besides the locks table: at most one active run per (workflow, lock key).
CREATE UNIQUE INDEX runs_active_lock ON runs (workflow_id, lock_key) WHERE status IN ${ACTIVE_STATUS_SQL};

CREATE TABLE locks (
  workflow_id      TEXT NOT NULL,
  lock_key         TEXT NOT NULL,
  run_id           TEXT NOT NULL UNIQUE REFERENCES runs (id) ON DELETE RESTRICT,
  source_item_key  TEXT,
  acquired_at      TEXT NOT NULL,
  PRIMARY KEY (workflow_id, lock_key)
);

CREATE TABLE run_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL,
  timestamp     TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('worker','orchestrator')),
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE TABLE run_actions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  hook                TEXT NOT NULL CHECK (hook IN ('on_start','on_success','on_failure','on_crash','on_start_error','on_cancel','on_timeout')),
  ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
  action_type         TEXT NOT NULL,
  action_name         TEXT,
  action_config_json  TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  external_key        TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error_json     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (run_id, hook, ordinal)
);
CREATE INDEX run_actions_status ON run_actions (status);

CREATE TABLE action_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_action_id  INTEGER NOT NULL REFERENCES run_actions (id) ON DELETE CASCADE,
  attempt        INTEGER NOT NULL CHECK (attempt >= 1),
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  outcome        TEXT CHECK (outcome IN ('succeeded','failed')),
  error_json     TEXT,
  external_key   TEXT,
  UNIQUE (run_action_id, attempt)
);

CREATE TABLE failure_counters (
  workflow_id   TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  consecutive   INTEGER NOT NULL DEFAULT 0 CHECK (consecutive >= 0),
  generation    INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workflow_id, scope_key)
);

CREATE TABLE blocks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id       TEXT NOT NULL,
  source_item_key   TEXT,
  reason            TEXT NOT NULL,
  run_id            TEXT REFERENCES runs (id) ON DELETE SET NULL,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  generation        INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  cleared_at        TEXT,
  cleared_by        TEXT
);
CREATE UNIQUE INDEX blocks_one_active ON blocks (workflow_id, COALESCE(source_item_key, '')) WHERE cleared_at IS NULL;
CREATE INDEX blocks_key ON blocks (workflow_id, source_item_key);

CREATE TABLE notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type       TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  delivery_state   TEXT NOT NULL CHECK (delivery_state IN ('pending','delivered','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  delivered_at     TEXT
);
CREATE INDEX notifications_pending ON notifications (delivery_state, next_attempt_at);
CREATE INDEX notifications_created ON notifications (created_at);

CREATE TABLE cron_firings (
  workflow_id    TEXT NOT NULL,
  scheduled_for  TEXT NOT NULL,
  run_id         TEXT REFERENCES runs (id) ON DELETE SET NULL,
  decision       TEXT NOT NULL,
  reason         TEXT,
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (workflow_id, scheduled_for)
);
CREATE INDEX cron_firings_recorded ON cron_firings (recorded_at);
`;

/**
 * v2 (WI-10): delivery state per notification channel. `notifications.delivery_state`
 * / `attempts` / `last_error` become the aggregate over the channel deliveries.
 */
const V2_DDL = `
CREATE TABLE notification_deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id  INTEGER NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending','delivered','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  last_status      INTEGER,
  next_attempt_at  TEXT,
  delivered_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (notification_id, channel_id)
);
CREATE INDEX notification_deliveries_due ON notification_deliveries (state, next_attempt_at);
`;

/**
 * v3 (WI-17): named outcomes and the persisted completion hook on runs;
 * `run_actions.hook` additionally accepts `on_error` and `on_result.<outcome>`
 * (table rebuild, SQLite cannot alter CHECK constraints).
 */
const V3_DDL = `
ALTER TABLE runs ADD COLUMN outcome TEXT;
ALTER TABLE runs ADD COLUMN completion_hook TEXT;

CREATE TABLE run_actions_v3 (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  hook                TEXT NOT NULL CHECK (
                        hook IN ('on_start','on_success','on_failure','on_crash','on_start_error','on_cancel','on_timeout','on_error')
                        OR hook GLOB 'on_result.?*'),
  ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
  action_type         TEXT NOT NULL,
  action_name         TEXT,
  action_config_json  TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  external_key        TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error_json     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (run_id, hook, ordinal)
);
INSERT INTO run_actions_v3 (id, run_id, hook, ordinal, action_type, action_name, action_config_json, status, external_key,
                            attempts, last_error_json, created_at, updated_at)
  SELECT id, run_id, hook, ordinal, action_type, action_name, action_config_json, status, external_key,
         attempts, last_error_json, created_at, updated_at FROM run_actions;
DROP TABLE run_actions;
ALTER TABLE run_actions_v3 RENAME TO run_actions;
CREATE INDEX run_actions_status ON run_actions (status);
`;

/**
 * v4 (WI-27): audit of actions taken in the web UI as a configured identity
 * (comments, labels, project fields). Never stores comment texts, tokens or
 * request bodies – only who, as whom, where, what kind, the outcome and (for
 * comments) the comment URL.
 */
const V4_DDL = `
CREATE TABLE ui_actions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  actor          TEXT NOT NULL,
  actor_via      TEXT NOT NULL,
  identity       TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  item_key       TEXT NOT NULL,
  item_url       TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('comment','labels','project')),
  result         TEXT NOT NULL CHECK (result IN ('succeeded','failed','unknown')),
  error_code     TEXT,
  error_message  TEXT,
  comment_id     TEXT,
  comment_url    TEXT,
  details_json   TEXT
);
CREATE INDEX ui_actions_created ON ui_actions (created_at);
CREATE INDEX ui_actions_item ON ui_actions (item_key, created_at);
`;

/**
 * v5 (WI-30): retry-block hooks. `runs.trigger_type` additionally accepts
 * `unblock` (lifecycle run of a removed block) and `runs.retry_block_hook`
 * marks runs whose finalization appends `on_retry_block` (both need a rebuild
 * of `runs`: SQLite cannot alter CHECK constraints); `run_actions.hook`
 * accepts `on_retry_block`/`on_retry_unblock`; blocks remember the final
 * status of the run that created them and the lifecycle run of their removal.
 */
const V5_DDL = `
CREATE TABLE runs_v5 (
  id                      TEXT PRIMARY KEY,
  workflow_id             TEXT NOT NULL,
  trigger_type            TEXT NOT NULL CHECK (trigger_type IN ('source','schedule','manual','unblock')),
  source_id               TEXT,
  source_item_key         TEXT,
  source_url              TEXT,
  lock_key                TEXT NOT NULL,
  scheduled_for           TEXT,
  config_snapshot         TEXT NOT NULL,
  parameters_json         TEXT,
  identity                TEXT,
  command                 TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('reserved','starting','running','cancelling','finalizing',
                            'completed','crashed','start_error','timed_out','cancelled','recovery_pending')),
  final_status            TEXT CHECK (final_status IN ('completed','crashed','start_error','timed_out','cancelled')),
  business_result         TEXT CHECK (business_result IN ('success','failure')),
  final_reason            TEXT,
  exit_code               INTEGER,
  pid                     INTEGER,
  process_start_identity  TEXT,
  workspace_path          TEXT,
  status_message          TEXT,
  result_json             TEXT,
  error_json              TEXT,
  lifecycle_status        TEXT CHECK (lifecycle_status IN ('pending','running','succeeded','failed')),
  block_generation        INTEGER,
  counted_technical_failure INTEGER NOT NULL DEFAULT 0 CHECK (counted_technical_failure IN (0,1)),
  created_at              TEXT NOT NULL,
  started_at              TEXT,
  finalizing_at           TEXT,
  finished_at             TEXT,
  updated_at              TEXT NOT NULL,
  outcome                 TEXT,
  completion_hook         TEXT,
  retry_block_hook        INTEGER NOT NULL DEFAULT 0 CHECK (retry_block_hook IN (0,1))
);
INSERT INTO runs_v5 (id, workflow_id, trigger_type, source_id, source_item_key, source_url, lock_key, scheduled_for,
                     config_snapshot, parameters_json, identity, command, status, final_status, business_result,
                     final_reason, exit_code, pid, process_start_identity, workspace_path, status_message, result_json,
                     error_json, lifecycle_status, block_generation, counted_technical_failure, created_at, started_at,
                     finalizing_at, finished_at, updated_at, outcome, completion_hook)
  SELECT id, workflow_id, trigger_type, source_id, source_item_key, source_url, lock_key, scheduled_for,
         config_snapshot, parameters_json, identity, command, status, final_status, business_result,
         final_reason, exit_code, pid, process_start_identity, workspace_path, status_message, result_json,
         error_json, lifecycle_status, block_generation, counted_technical_failure, created_at, started_at,
         finalizing_at, finished_at, updated_at, outcome, completion_hook FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v5 RENAME TO runs;
CREATE INDEX runs_workflow_created ON runs (workflow_id, created_at DESC);
CREATE INDEX runs_item_created ON runs (source_item_key, created_at DESC);
CREATE INDEX runs_status ON runs (status);
CREATE INDEX runs_finished ON runs (finished_at);
CREATE INDEX runs_created ON runs (created_at DESC);
CREATE UNIQUE INDEX runs_active_lock ON runs (workflow_id, lock_key) WHERE status IN ${ACTIVE_STATUS_SQL};

CREATE TABLE run_actions_v5 (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  hook                TEXT NOT NULL CHECK (
                        hook IN ('on_start','on_success','on_failure','on_crash','on_start_error','on_cancel','on_timeout','on_error',
                                 'on_retry_block','on_retry_unblock')
                        OR hook GLOB 'on_result.?*'),
  ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
  action_type         TEXT NOT NULL,
  action_name         TEXT,
  action_config_json  TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  external_key        TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error_json     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (run_id, hook, ordinal)
);
INSERT INTO run_actions_v5 (id, run_id, hook, ordinal, action_type, action_name, action_config_json, status, external_key,
                            attempts, last_error_json, created_at, updated_at)
  SELECT id, run_id, hook, ordinal, action_type, action_name, action_config_json, status, external_key,
         attempts, last_error_json, created_at, updated_at FROM run_actions;
DROP TABLE run_actions;
ALTER TABLE run_actions_v5 RENAME TO run_actions;
CREATE INDEX run_actions_status ON run_actions (status);

ALTER TABLE blocks ADD COLUMN last_status TEXT;
ALTER TABLE blocks ADD COLUMN cleared_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL;
UPDATE blocks SET last_status = (SELECT final_status FROM runs WHERE runs.id = blocks.run_id) WHERE run_id IS NOT NULL;
`;

/** All built-in migrations, in order. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(V1_DDL);
    },
  },
  {
    version: 2,
    name: 'notification_deliveries',
    up(db) {
      db.exec(V2_DDL);
    },
  },
  {
    version: 3,
    name: 'run_outcomes',
    disableForeignKeys: true,
    up(db) {
      db.exec(V3_DDL);
    },
  },
  {
    version: 4,
    name: 'ui_actions',
    up(db) {
      db.exec(V4_DDL);
    },
  },
  {
    version: 5,
    name: 'retry_block_hooks',
    disableForeignKeys: true,
    up(db) {
      db.exec(V5_DDL);
    },
  },
];
