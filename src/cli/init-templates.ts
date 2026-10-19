/**
 * Files created by `init` (Spec §4): a commented, valid example configuration
 * that starts without any GitHub credentials. Only the manual `hello`
 * workflow is enabled; the GitHub coder workflow and the nightly schedule are
 * disabled examples to copy from. The named filter `needs-maintainer` is
 * shared by the coder workflow and the view. Kept as code (not as package files) so the
 * installed package needs no asset lookup.
 */

/** A file to create, relative to config-dir. */
export interface TemplateFile {
  path: string;
  content: string;
  /** File mode (scripts are executable). */
  mode: number;
}

const CONFIG_YAML = (port: number): string => `# config.yaml – global settings (Spec §5.1). All keys are optional; shown values are the defaults
# unless noted. Validate after every change:  adispatch config validate --config-dir <dir>
# Apply changes to a running instance:          adispatch config reload --config-dir <dir>

server:
  # The HTTP API/UI has NO authentication (V1). Keep it on loopback. To expose it, put an
  # AUTHENTICATING reverse proxy / VPN / Tailscale in front (see docs/operations.md).
  host: 127.0.0.1
  port: ${port}
  # Extra host names accepted in the Host/Origin header (DNS-rebinding protection), e.g. the
  # public name of the authenticating reverse proxy: [orchestrator.example.com]
  # ("name" = any port, "name:port" = only that port). Loopback names are always accepted.
  allowed_hosts: []

scheduler:
  polling_interval: 30s   # how often sources are polled
  max_concurrent: 5       # global limit for automatic starts (manual starts count, but are not limited)

workspace:
  # One workspace per run under base_dir/<workflow>/<run> (default: <data-dir>/workspaces).
  # Relative paths are relative to this config dir.
  # base_dir: /var/lib/adispatchd/workspaces
  cleanup: on_success     # always | on_success | never

lifecycle:
  action_retry:           # default retry of lifecycle actions (source.update/comment, shell)
    max_attempts: 3
    delay: 30s

retention:
  completed_runs: 30d     # successful runs
  failed_runs: 90d        # failed, crashed, cancelled ... runs
  blocked_runs: never     # runs that led to a retry block
  max_log_size_per_run: 100MB
  cleanup_interval: 24h

notifications:
  # Central orchestrator notifications (Spec §18). Secrets come from environment variables:
  # channels:
  #   - type: webhook
  #     url_env: SLACK_WEBHOOK_URL
  #     headers_env: { Authorization: WEBHOOK_AUTH_HEADER }
  on: [retry_block_created, lifecycle_action_failed, recovery_failed]
`;

const SOURCES_YAML = `# sources.yaml – external task sources (Spec §5.2). V1: GitHub issues/PRs.
# Each source uses an identity from identities.yaml for read access.
# The source ID is part of every run's item key (<source>:<number>) – renaming it detaches the run history.
sources:
  project_a:
    type: github
    owner: example          # GitHub owner/organisation
    repository: project-a
    identity: maintainer
    # Optional: fields of a GitHub Projects (v2) board, usable as project.<name> in filters,
    # item_priority and views (e.g. project.Status in [Todo, Ready]) and settable by source.update.
    # Org projects need the app permission "Organization → Projects: Read" ("Read and write" to set
    # fields); user-owned projects need a github_token identity.
    # project:
    #   owner: example        # user/org login of the project (default: owner above)
    #   number: 3             # from the project URL …/projects/3
    #   identity: maintainer  # reads the project (default: identity above); if set, also writes it
    #   fields:               # name as in the project (matched case-insensitively) → kind
    #     Status: single_select
    #     Priority: single_select
    #     Estimate: number    # kinds: single_select, text, number, date, iteration
`;

const IDENTITIES_YAML = `# identities.yaml – GitHub App identities, one per role (Spec §5.3).
# The private key is NEVER stored here: private_key_env names an environment variable that holds
# the PEM (real line breaks or "\\n" escapes). Under systemd put it into the EnvironmentFile
# (default /etc/default/adispatchd, mode 0640).
# Minimal app permissions: Issues read/write, Pull requests write (labels/comments on PRs), Metadata read.
identities:
  maintainer:
    type: github_app
    app_id: 100001
    installation_id: 200001
    private_key_env: GITHUB_MAINTAINER_PRIVATE_KEY
  coder:
    type: github_app
    app_id: 100002
    installation_id: 200002
    private_key_env: GITHUB_CODER_PRIVATE_KEY
  # A token identity, needed to read user-owned GitHub Projects: recommended is a classic personal access
  # token of the project owner with read:project (plus repo for private repositories) – it must also be able
  # to read the repository's issues/PRs. To set project fields (source.update → project) use the scope
  # project instead of read:project. Fine-grained tokens are unverified for user-owned projects.
  # token_env names the environment variable holding the token.
  # project_reader:
  #   type: github_token
  #   token_env: GITHUB_PROJECT_TOKEN
`;

const HELLO_YAML = `# workflows/hello.yaml – a manual workflow that runs without any external source.
# Start it in the web UI (Workflows → hello → Start) or via the API:
#   curl -X POST -H 'X-Adispatch-Request: 1' -H 'Content-Type: application/json' \\
#        -d '{"parameters":{"name":"Ada"}}' http://127.0.0.1:8787/api/v1/workflows/hello/start
id: hello
name: Hello World
trigger: { type: manual }
parameters:
  name:
    type: string
    default: world
    description: Whom to greet
execute:
  type: shell
  # Relative paths are resolved against the config dir. Arguments are passed as a list (no shell).
  command: scripts/hello.sh
  args: ['{parameters.name}']
  timeout:
    max_duration: 10m       # total runtime (default: unlimited)
    idle_timeout: 5m        # time without output (default: unlimited)
on_success:
  - type: shell             # lifecycle shell action; gets run + result context (ADISPATCH_CONTEXT_FILE)
    command: scripts/notify.sh
    args: ['{workflow.id}', '{run.id}', '{result.message}']
    timeout: 30s
`;

const CODER_YAML = `# workflows/coder.yaml – GitHub-driven agent workflow (Spec §5.4). DISABLED example:
# configure sources.yaml/identities.yaml, provide the private keys, then set enabled: true.
id: coder
name: Coder – Project A
enabled: false
priority: 50                # workflow priority (higher first) before item priority
max_concurrent: 2
identity: coder             # default identity for writes (labels, comments)

trigger:
  type: source
  source: project_a

filter:                     # declarative filter (all/any/not; equals, contains, in, greater_than, ...)
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
    # With a project in sources.yaml: "A or B" via "in", e.g.
    # - { field: project.Status, operator: in, value: [Todo, Ready] }
    # Named filter (filters/needs-maintainer.yaml), shared with the view: skip items waiting for the maintainer.
    - not: { use: needs-maintainer }

item_priority:
  rules:
    - when: { field: labels, operator: contains, value: 'priority:high' }
      value: 50
  default: 0

conditions:
  workflow:                 # exit 0 = ok, 1 = not now, >=2 = check error (unknown → no start)
    - type: shell
      command: scripts/check-credits.sh
      timeout: 15s
      cache: 60s

execute:
  type: shell
  command: scripts/coder.sh
  working_directory: '{workspace.base_dir}/{workflow.id}/{run.id}'
  env:
    NODE_ENV: production
  secrets:
    GH_TOKEN: { identity: coder }   # short-lived installation token, only for this worker
  timeout:
    max_duration: 6h
    idle_timeout: 45m
  cancel_grace: 30s         # SIGTERM → SIGKILL of the worker's process group

retry:
  max_technical_failures: 3 # consecutive crashes/timeouts/start errors → retry block (remove in UI)

on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
    # With a project in sources.yaml, project fields can be set too (after the labels; null clears):
    # project: { Status: In Progress }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
  - type: source.comment
    message: 'Completed: {result.message}'
    continue_on_error: true
on_failure:                 # business failure: valid result file with "result": "failure"
  - type: source.update
    labels: { add: [needs-maintainer], remove: [coding] }
  - type: source.comment
    message: 'Needs maintainer: {result.message}'
on_crash:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_start_error:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_timeout:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_cancel:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
`;

const NIGHTLY_YAML = `# workflows/nightly-maintenance.yaml – time-triggered workflow (Spec §5.5). DISABLED example.
# Missed slots (downtime, limits, failing conditions) are skipped, never caught up (docs/cron-semantics.md).
id: nightly-maintenance
name: Nightly Maintenance
enabled: false
priority: 20
trigger:
  type: schedule
  cron: '0 3 * * *'
  timezone: Europe/Berlin   # default UTC
execute:
  type: shell
  command: scripts/maintenance.sh
`;

const VIEW_YAML = `# views/needs-maintainer.yaml – read-only table over one or more sources (Spec §17).
# Needs working source credentials; otherwise the view shows a per-source error.
id: needs-maintainer
title: Needs Maintainer
sources: [project_a]
filter: needs-maintainer    # named filter, see filters/needs-maintainer.yaml
fields:
  - { field: repository, label: Repository }
  - { field: number, label: Issue }
  - { field: title, label: Title, link: url }
  - { field: run.last_workflow, label: Last agent }
  - { field: run.last_result.message, label: Result }
  - { field: updated_at, label: Updated }
sort: { field: updated_at, direction: desc }
`;

const FILTER_YAML = `# filters/needs-maintainer.yaml – named, reusable filter (one file per filter).
# Use it as "filter: needs-maintainer" or as "{ use: needs-maintainer }" anywhere inside a filter
# (workflow filter, item_priority rules, views, other named filters), so all of them see the same items.
id: needs-maintainer
description: Items waiting for a maintainer decision
filter:
  all:
    - { field: labels, operator: contains, value: needs-maintainer }
`;

const HELLO_SH = `#!/bin/sh
# Example worker (worker protocol: docs/worker-protocol.md).
# Input:  ADISPATCH_* environment variables + JSON context file ADISPATCH_CONTEXT_FILE.
# Output: stdout/stderr (logged), optional "@@ADISPATCH_EVENT {json}" lines, optional result file ADISPATCH_RESULT_FILE.
# Exit code: 0 = technically OK (business result from the result file, default success); != 0 = crashed.
set -eu

name="\${1:-world}"
echo '@@ADISPATCH_EVENT {"type":"status","message":"Saying hello"}'
echo "Hello, \${name}!"
echo "run \${ADISPATCH_RUN_ID} of workflow \${ADISPATCH_WORKFLOW_ID} in \${ADISPATCH_WORKSPACE}"
echo '@@ADISPATCH_EVENT {"type":"progress","value":100}'

# Write the result atomically (temp file + rename). "failure" would trigger on_failure instead.
tmp="\${ADISPATCH_RESULT_FILE}.tmp"
printf '%s\\n' '{"schema_version":1,"result":"success","message":"Said hello"}' > "\${tmp}"
mv "\${tmp}" "\${ADISPATCH_RESULT_FILE}"
`;

const NOTIFY_SH = `#!/bin/sh
# Example lifecycle shell action: receives the rendered args and the run/result context
# (ADISPATCH_CONTEXT_FILE). Replace with e.g. a Slack webhook call. Exit != 0 = action failed (retried).
set -eu
echo "workflow $1, run $2 finished: $3"
`;

const CODER_SH = `#!/bin/sh
# Example coder wrapper – replace the body with your agent invocation.
# GH_TOKEN (declared under execute.secrets) authenticates the GitHub CLI as the coder app.
set -eu
echo "Working on \${ADISPATCH_SOURCE_URL:-?} (item \${ADISPATCH_SOURCE_ITEM_ID:-?}) in \${ADISPATCH_WORKSPACE}"
# git clone ... && your-agent --context "\${ADISPATCH_CONTEXT_FILE}"

# Business failure ("needs maintainer"): write a valid result file and exit 0:
#   printf '%s\\n' '{"schema_version":1,"result":"failure","message":"Requirements unclear"}' > "\${ADISPATCH_RESULT_FILE}.tmp"
#   mv "\${ADISPATCH_RESULT_FILE}.tmp" "\${ADISPATCH_RESULT_FILE}"
# Any exit code != 0 counts as a technical failure (crashed) and towards the retry block.
exit 0
`;

const CHECK_CREDITS_SH = `#!/bin/sh
# Example workflow condition: exit 0 = start allowed, 1 = not now, >= 2 = check error (unknown).
exit 0
`;

const MAINTENANCE_SH = `#!/bin/sh
set -eu
echo "nightly maintenance at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
`;

/** All files created by `init`, relative to config-dir. */
export function initTemplates(options: { port?: number } = {}): TemplateFile[] {
  const port = options.port ?? 8787;
  return [
    { path: 'config.yaml', content: CONFIG_YAML(port), mode: 0o640 },
    { path: 'sources.yaml', content: SOURCES_YAML, mode: 0o640 },
    { path: 'identities.yaml', content: IDENTITIES_YAML, mode: 0o640 },
    { path: 'workflows/hello.yaml', content: HELLO_YAML, mode: 0o640 },
    { path: 'workflows/coder.yaml', content: CODER_YAML, mode: 0o640 },
    { path: 'workflows/nightly-maintenance.yaml', content: NIGHTLY_YAML, mode: 0o640 },
    { path: 'views/needs-maintainer.yaml', content: VIEW_YAML, mode: 0o640 },
    { path: 'filters/needs-maintainer.yaml', content: FILTER_YAML, mode: 0o640 },
    { path: 'scripts/hello.sh', content: HELLO_SH, mode: 0o750 },
    { path: 'scripts/notify.sh', content: NOTIFY_SH, mode: 0o750 },
    { path: 'scripts/coder.sh', content: CODER_SH, mode: 0o750 },
    { path: 'scripts/check-credits.sh', content: CHECK_CREDITS_SH, mode: 0o750 },
    { path: 'scripts/maintenance.sh', content: MAINTENANCE_SH, mode: 0o750 },
  ];
}

/** Directories created in data-dir (Spec §4); the app creates missing ones itself as well. */
export const DATA_DIR_LAYOUT = ['logs', 'runs', 'workspaces', 'backups'] as const;
