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

/** All built-in migrations, in order. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(V1_DDL);
    },
  },
];
