# Agent Dispatch Daemon (`adispatchd`)

[![CI](https://github.com/brokoskokoli/adispatchd/actions/workflows/ci.yml/badge.svg)](https://github.com/brokoskokoli/adispatchd/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/adispatchd)](https://www.npmjs.com/package/adispatchd)
[![Node](https://img.shields.io/node/v/adispatchd)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/github/license/brokoskokoli/adispatchd)](LICENSE)

**English** · [Deutsch](README.de.md) · [Website](https://brokoskokoli.github.io/adispatchd/)

**Turn GitHub issues into runs of your shell scripts and AI agents – declaratively, observably, on your own machine.**

`adispatchd` is a small, configuration-driven daemon. It finds tasks in GitHub issues and pull requests (including
GitHub Projects fields), picks them by filters and priorities, checks start conditions, runs independent shell or
container workflows in their own workspaces, supervises and logs every run, updates labels, project fields and
comments when a run starts or ends, and shows everything in a small web UI with live updates.

## Why

Running coding or review agents against an issue tracker usually ends up as a pile of cron jobs and glue scripts:
who picks which issue, what happens when an agent crashes, how do labels get reset, where are the logs?
`adispatchd` moves those decisions into a few YAML files and keeps your workers simple:

- **GitHub stays the source of truth.** There is no separate ticket store; SQLite only holds runs, locks, events,
  retry blocks and action journals.
- **Workers are plain programs.** Anything that can read environment variables and exit with a status code can be a
  worker – a shell script, a CLI agent, a container.
- **Failures are first-class.** Technical errors (crash, timeout, cancel) are kept apart from business results
  ("needs a maintainer"), each with its own hook.

## Features

- **GitHub issues and PRs as task source** – filter on labels, state, milestone, issue type, native dependencies
  ("blocked by"), the issue's work branch and PR (`work_branch`, `work_pr`, `closing_prs`) and **GitHub Projects
  fields** (status, priority, custom fields). Missing access yields `unknown` instead of a wrong start.
- **Declarative filters and named filters** – `all`/`any`/`not` trees with operators `equals`, `not_equals`,
  `contains`, `in`, `greater_than`, `less_than`; define a filter once in `filters/<id>.yaml` and reuse it in
  workflows and views.
- **Priorities** – workflow priority first, then item priority rules; global, per-workflow and per-source limits.
- **Visible start conditions** – shell checks (`conditions`, `shell_filter`) get optional names; the UI shows each
  check with its last result (ok / not now / check error, time, cache hit, first stderr line) and per planning step
  how many items passed the item checks.
- **Dashboard info tiles** – `dashboard.yaml` defines small scripts (text, number or percent with warn/critical
  thresholds) that the daemon runs in the background on a cache schedule – e.g. disk usage, open PRs, credits.
- **Your own dashboard layout** – since 0.8.0 `dashboard.yaml` can arrange the dashboard: rows of columns with relative
  widths, titles, any widget several times, **views as widgets** (pick sections, row limit, own refresh interval, item
  panel) and **tabs** (also nested; inactive tabs load nothing, the selected tab is part of the URL). Without a layout
  the dashboard looks as before.
- **Triggers** – `source` (polling GitHub), `schedule` (cron with time zone) or `manual` (UI/API, with typed
  parameters; since 0.7.0 selection lists filled at start time from the repository's **branches or tags** or from
  your own script, `options_from`).
- **Multi-source workflows** – one workflow can serve several repositories (`sources: [...]`), with per-repository
  variables such as `{source.vars.base_branch}`.
- **Lifecycle hooks** – `on_start`, `on_success`, `on_failure`, `on_crash`, `on_start_error`, `on_timeout`,
  `on_cancel`, plus **`on_result.<outcome>`** for named business outcomes, a catch-all **`on_error`** for all
  technical ends and (0.6.0) **`on_retry_block`/`on_retry_unblock`** when a retry block is created or removed (e.g.
  label the item `agent-blocked`, call a script).
- **Actions** – `source.update` (add/remove labels, set **GitHub Projects fields**, adding the item to the project
  if needed), `source.comment`, and `shell` hooks; idempotent (read before write) with journal and retries.
- **Shell or container workers** – `execute.type: shell` runs a command without a shell in its own process group;
  `execute.type: container` runs a throw-away Docker or Podman container with fixed mounts, resource limits and
  `--cap-drop ALL`.
- **Token files for long runs** – short-lived GitHub App tokens as environment variable or as a file
  (`delivery: file` → `<NAME>_FILE`) that the daemon renews atomically before expiry and deletes after the run.
- **Keep files** – `execute.keep` copies transcripts and logs (glob patterns) to `runs/<run-id>/kept/` before the
  workspace is cleaned up; download them in the UI or via the API.
- **Web UI with live updates** – workflows, runs, live output, events, kept files and views (read-only tables across
  repositories; sorted by your own value order such as pipeline stages, several sort keys, sections with headings),
  streamed via Server-Sent Events; plus a JSON HTTP API. Optional toolbar links to other local tools
  (e.g. the [claude-inspect](https://github.com/brokoskokoli/claude_inspect) dashboard), opened in a new tab or embedded
  (`ui.external_links`).
- **Artifacts** – a workflow lists files or folders in `execute.artifacts`; after the run they are stored as immutable
  artifacts (no symlinks, size-limited, secrets redacted), listed on the **Artifacts** page with file tree, download
  (folders as `.zip`) and delete. Artifacts are also the items of the source `type: artifacts`: another workflow
  processes them automatically – exactly once per artifact via the built-in fields `consumed_by` / `attempted_by` – or by a manual start,
  and sees a read-only copy below `inputs/` (`{item.path}`). Chains such as *produce → process* need no pipeline engine
  (`retention.artifacts`, API `/api/v1/artifacts`; since 0.10.0).
- **Item history** – since 0.9.0 one page per issue/PR shows its way through the workflows: the current state (read
  fresh from GitHub), the **path** of all runs with their results and a filterable **timeline** of run starts and
  ends, hook chains with what each action changed (labels added/removed, project field `old → new`, comment link,
  exit status), retry blocks and UI actions; optionally merged with the issue's GitHub timeline (external changes
  marked, own changes not shown twice). Linked from runs, the dashboard run widgets, the item panel, the Blocked
  page and views (field `history`).
- **Server resources** – a compact strip at the top of the dashboard (CPU with a 15-minute sparkline, memory, the
  fullest disk, load and the busiest process groups, own runs first); the **Resources** tab shows CPU over time stacked
  by the daemon, each run (click through to the run), hooks/checks and the busiest foreign processes, plus memory and
  disk charts and a value table. Sampled in memory (`monitoring` in `config.yaml`), only command names are shown, never
  arguments.
- **Optional login** – `auth.mode: password` (built-in users, scrypt hashes, session cookie) or `trusted_header`
  (identity from Tailscale Serve, oauth2-proxy, …), roles `viewer` / `operator` / `admin` per endpoint, audit of every
  write; the CLI keeps working through a local control token.
- **Act as a GitHub App from the UI** – admins can comment on an issue/PR, add or remove labels and set project fields
  as a configured identity (`ui_actions: true` in `identities.yaml`), with a confirmation dialog and an audit log (kept
  365 days by default, `retention.ui_actions`); requires a login, never available to the CLI control token.
- **Dry-run** – `adispatch workflow dry-run <id>` shows which items would start and why the others would not,
  without starting anything.
- **Hub for several projects** (since 0.10.0) – `adispatch hub start` runs several independent workspaces (each a complete
  instance with its own config, database and port) as child processes with crash restart, under **one shared limit** for
  automatic runs. One web page lists all workspaces (state, running runs, blocked items, slot usage, server resources);
  each workspace UI is served below `/w/<id>/` on the same port, with one login and roles for all. One systemd unit
  (`service install --hub`) instead of one per project; an existing single instance moves in without copying any data.
- **Robust operations** – retry blocks, action retries, cancel/timeout per process group, drain, crash recovery,
  atomic config reload, and a `systemd` service installer.

## How it works

```mermaid
flowchart LR
  GH[("GitHub<br/>issues · PRs · Projects")] -->|poll| F["filters &<br/>priorities"]
  CR["cron / manual"] --> C
  F --> C["conditions<br/>& limits"]
  C --> W["worker<br/>shell or container"]
  W -->|exit code +<br/>result.json| H["lifecycle hooks<br/>on_success · on_result · on_error …"]
  H -->|labels · fields · comments| GH
  W -. logs · events .-> UI["web UI / API<br/>(live via SSE)"]
```

1. On every planning step the daemon polls each source, evaluates the workflow filter and sorts candidates by
   priority.
2. Start conditions (shell checks, limits, locks, retry blocks) decide whether a run may start.
3. The worker gets a workspace, a context file and – if declared – a token; its exit code and optional result file
   decide which hook runs.
4. Hooks update labels, project fields and comments on the item, so the next workflow (for example a reviewer) can
   pick it up.

## Quickstart

Requirements: Linux (production, systemd) or macOS (local), **Node.js ≥ 22.13** (24 LTS recommended; SQLite comes
from `node:sqlite`, no native add-on). Windows is not supported.

```bash
npm install -g adispatchd            # or try it without installing: npx adispatchd --help

adispatch init  --config-dir ./config --data-dir ./data   # sample configuration + scripts
adispatch start --config-dir ./config --data-dir ./data   # foreground, Ctrl-C = drain
```

Open the web UI at <http://127.0.0.1:8787/> and start the **hello** workflow (manual, no GitHub needed) under
*Workflows* – or via the API:

```bash
curl -X POST -H 'X-Adispatch-Request: 1' -H 'Content-Type: application/json' \
     -d '{"parameters":{"name":"Ada"}}' http://127.0.0.1:8787/api/v1/workflows/hello/start
```

Logs end up in `data/logs/<run-id>/`, context and result in `data/runs/<run-id>/`. To connect GitHub, create a
GitHub App per role (permissions: Issues read/write, Pull requests write, Metadata read), put its IDs into
`identities.yaml`, the repository into `sources.yaml`, export the private key
(`export GITHUB_CODER_PRIVATE_KEY="$(cat key.pem)"`), set `enabled: true` in `workflows/coder.yaml` and run
`adispatch config reload --config-dir ./config`.

For services, always install a **fixed version** globally (`npm install -g adispatchd@0.10.0`), not `npx`.

### Several projects: the hub

```bash
adispatch hub init     --config-dir ./hub --data-dir ./hub-data --workspace coder --workspace docs
adispatch hub validate --config-dir ./hub --data-dir ./hub-data
adispatch hub start    --config-dir ./hub --data-dir ./hub-data   # overview at http://127.0.0.1:8090/, workspaces at /w/<id>/
adispatch hub status   --data-dir ./hub-data
```

`hub.yaml` lists the workspaces and the shared `hub.max_concurrent`; every workspace keeps its own configuration. On a
Linux server run the hub as a single systemd service
(`sudo adispatch service install --hub --dry-run --config-dir /etc/adispatchd-hub --data-dir /var/lib/adispatchd-hub/hub`),
and move an existing single instance in by listing its unchanged config and data directories with a new port – see
[operations → hub](docs/operations.md#hub-mehrere-workspaces-auf-einem-server-seit-0100). All workspaces run as the same
service user; use containers (`user`) or separate hubs for projects that must not see each other.

## Example workflow

A coder workflow that takes issues labelled `ready-for-coding` whose project status is `Todo` or `Ready`, moves them
across the board and returns them to the queue on any technical error:

```yaml
# sources.yaml
sources:
  app:
    type: github
    owner: example
    repository: app
    identity: maintainer
    project:
      number: 3                      # https://github.com/orgs/example/projects/3
      fields: { Status: single_select, Priority: single_select }
```

```yaml
# workflows/coder.yaml
id: coder
priority: 50                         # workflow priority comes before item priority
max_concurrent: 2
identity: coder                      # GitHub App used for labels, fields and comments
trigger: { type: source, source: app }   # or { type: schedule, cron: '0 3 * * *' } / { type: manual }
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: project.Status, operator: in, value: [Todo, Ready] }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
item_priority:
  rules:
    - when: { field: project.Priority, operator: in, value: [P0, P1] }
      value: 100
conditions:
  workflow: [ { name: Credits available, type: shell, command: scripts/check-credits.sh, cache: 60s } ]
execute:
  type: shell
  command: scripts/coder.sh          # relative to the config dir; no shell, args as a list
  args: ['{item.url}']
  secrets:
    GH_TOKEN: { identity: coder, delivery: file }   # renewed token file in $GH_TOKEN_FILE
  timeout: { max_duration: 6h, idle_timeout: 45m }
  keep: ['.agent/transcript.jsonl']  # saved to runs/<run-id>/kept/ before cleanup
retry: { max_technical_failures: 3 }
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
    project: { Status: In Progress }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
    project: { Status: Review }
  - type: source.comment
    message: 'Done (run {run.id}): {result.message}'
on_failure:
  - type: source.update
    labels: { add: [needs-maintainer], remove: [coding] }
on_result:                           # named outcome from the result file
  needs_split:
    - type: source.comment
      message: 'Too big, please split: {result.message}'
    - type: source.update
      labels: { add: [needs-maintainer], remove: [coding] }
on_error:                            # crashed, start_error, timed_out, cancelled
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
    project: { Status: Ready }
```

Check it offline with `adispatch config validate --config-dir ./config` (errors with file:line) and preview the
selection with `adispatch workflow dry-run coder`. Setting project fields on an organisation project needs the App
permission *Organization → Projects: Read and write*. More complete examples (coder/reviewer pair, cron, manual
parameters, webhooks, multiple repositories, containers) are in the
[configuration reference §7](docs/configuration-reference.md#7-vollständige-beispiele).

## Worker protocol in brief

Details: [docs/worker-protocol.md](docs/worker-protocol.md).

- **Input:** a minimal environment (`PATH`, `HOME`, …) plus `execute.env`, declared secrets (`GH_TOKEN`, or
  `GH_TOKEN_FILE` with `delivery: file`) and `ADISPATCH_RUN_ID`, `ADISPATCH_WORKFLOW_ID`, `ADISPATCH_SOURCE_*`,
  `ADISPATCH_WORKSPACE`, `ADISPATCH_CONTEXT_FILE` (JSON context), `ADISPATCH_RESULT_FILE`. The daemon's own
  environment is not inherited.
- **Exit code = technical status:** `0` is ok, anything else is `crashed` (counts towards the retry block).
- **Business result** only via the result file (write it atomically):
  `{"schema_version":1,"result":"failure","message":"Requirements unclear"}` with `exit 0` runs `on_failure` – not a
  technical error. Without a file, exit 0 means `success`. An optional `"outcome": "needs_split"` selects
  `on_result.needs_split` instead of `on_success`/`on_failure`.
- **Events:** lines like `@@ADISPATCH_EVENT {"type":"status","message":"Running tests"}` on stdout/stderr show up in
  the UI (informational only).
- **Cancel/timeout:** SIGTERM to the process group, SIGKILL after `cancel_grace` (30 s); containers are stopped with
  `<engine> stop`.

## CLI

| Command | Purpose |
|---|---|
| `init --config-dir D --data-dir D [--port P]` | create the directory layout and a commented sample configuration |
| `start --config-dir D --data-dir D [--host H] [--port P]` | run in the foreground; SIGTERM/SIGINT = drain, then cancel-all |
| `status`, `pause`, `resume` | show state / pause and resume automatic starts |
| `drain [--wait]`, `cancel-all [--wait]` | no new runs and finish active ones / cancel all runs, then stop |
| `config validate`, `config reload` | offline validation with file:line / atomic reload of a running instance |
| `workflow dry-run <id> [--json] [--local]` | candidate selection without starting anything |
| `auth hash-password` | scrypt hash of a password for `auth.users[].password_hash_env` (prompt without echo or stdin) |
| `service install\|status\|uninstall [--dry-run]` | systemd service (Linux); with `--hub` the unit of a hub |
| `hub init\|validate\|start` | create / validate `hub.yaml` and its workspaces / run the hub in the foreground (SIGTERM = drain all) |
| `hub status\|pause\|resume`, `hub drain-all\|stop-all [--wait]`, `hub workspace start\|stop\|restart\|drain <id>` | control the running hub (local control socket) |

## Documentation

> Detailed documentation is in German.

| Document | Content |
|---|---|
| [Configuration reference](docs/configuration-reference.md) | every file, field, default, filter, placeholder and the evaluation flow; examples are tested against the real loader |
| [Worker protocol](docs/worker-protocol.md) | environment, context and result files, events, token files, containers |
| [Operations](docs/operations.md) | systemd, hub (several workspaces, migration), updates, backups, recovery, reverse proxy, container permissions |
| [HTTP API / SSE](docs/api.md) | endpoints and live events |
| [Cron semantics](docs/cron-semantics.md) | schedules, time zones, missed slots, DST |
| [Changelog](CHANGELOG.md) | release notes |
| [Project status](docs/status.md) | test coverage and what is still open |
| [German README](README.de.md) | full overview incl. configuration layout, security and operations |

## Security notes

- **Login is optional (since 0.4.0).** Without `auth` (`mode: none`) there is no login: the API binds to
  `127.0.0.1` by default; for remote access use an **authenticating** reverse proxy, VPN or Tailscale and list its host
  names in `server.allowed_hosts` (DNS rebinding protection). With `auth.mode: password` or `trusted_header` every
  endpoint requires a role (`viewer`, `operator`, `admin`); see [operations → login](docs/operations.md#anmeldung-web-ui-und-api-seit-040)
  for Tailscale Serve, oauth2-proxy and the password mode behind an HTTPS proxy (`adispatch auth hash-password`).
  Mutating requests need the header `X-Adispatch-Request: 1`; there is no CORS.
  The dashboard and the Resources tab show the command names of all processes on the server (never their arguments) – one more reason to
  expose the UI only behind authentication (or set `monitoring.enabled: false`).
- **Scripts and YAML are trusted code** running with the service's permissions – there is no sandbox. Write access
  to the config dir equals code execution.
- Workers and shell actions only receive explicitly declared secrets; secrets never end up in YAML (private keys only
  via environment variables), context/result files, API responses or logs (redaction in process logs is best effort).
  The only exception is the token file with `delivery: file` (`0600`, outside the workspace, deleted after the run).
- **No isolation between runs of the same service:** `0700`/`0600` only protects against other system users. All
  workers run as the same service user and can read token files and, on Linux, the environment
  (`/proc/<pid>/environ`) of parallel runs. Run high- and low-privilege workflows in separate instances under
  separate users or in containers (WI-19); the same holds for the workspaces of a hub. With `execute.type: container` a worker only sees its own mounts; access
  to the Docker daemon is equivalent to root.

## Status and roadmap

Version 0.10.0. All planned work items are implemented and covered by an automated test suite (CI on Node 22 and 24).
Manual verification against real GitHub repositories and systemd on Linux is still pending – see
[docs/status.md](docs/status.md) for what is open before production use, and [CHANGELOG.md](CHANGELOG.md) for
release notes.

## Development

```bash
npm install
npm run check        # tsc --noEmit && vitest run
npm run test:pack    # npm pack → install → init → start → drain → update
npm run dev -- start --config-dir ./config --data-dir ./data   # without build (tsx)
```

## License

[MIT](LICENSE) © 2026 brokoskokoli
