# HTTP-API und SSE (v1)

Implementierung: `src/api/` (WI-10). Spec §15, §16, §17, §18, §21.

- Basis: `http://<server.host>:<server.port>` (Default `127.0.0.1:8787`), API unter `/api/v1`, JSON (UTF-8).
- **Keine Anmeldung** in V1: nur auf Loopback binden oder hinter einem authentifizierenden Reverse Proxy/VPN betreiben.
  Bei Nicht-Loopback-Bind wird beim Start gewarnt (Log + CLI).
- Antworten von `/api/*`, `/health`, `/ready` tragen `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. Es werden **nie CORS-Header** gesendet.
- Antworten enthalten keine Secrets (Identities nur als ID, Webhook-URLs redigiert, Fehlertexte redigiert).
  Strings aus Events/Results/Logs/Titeln sind **untrusted** – die UI rendert sie nur als Text.

## Host-/Origin-Allowlist (DNS-Rebinding), alle Requests

Für **jeden** Request (inkl. `GET`, SSE, statische UI, unbekannte Routen) muss der `Host`-Header einen erlaubten Namen tragen,
sonst `421 host_not_allowed`:

- immer: `localhost`, `127.0.0.1`, `[::1]` (beliebiger Port),
- bei Bind auf eine konkrete Nicht-Loopback-Adresse zusätzlich diese Adresse,
- alle Einträge aus `server.allowed_hosts` in `config.yaml` (`name` = beliebiger Port, `name:port` = nur dieser Port;
  ein `Host` ohne Port passt auch auf `name:80` und `name:443`), z. B.
  den öffentlichen Namen eines authentifizierenden Reverse Proxys:

```yaml
server:
  host: 127.0.0.1
  port: 8787
  allowed_hosts: [orchestrator.example.com]
```

Sendet der Browser einen `Origin`, muss er **exakt** dem angefragten Host inkl. Port entsprechen (ein `Host` ohne Port
entspricht dem Default-Port des Origin-Schemas, z. B. hinter einem TLS-Proxy) – sonst `403 origin_not_allowed`, auch bei `GET`
(z. B. `Origin: http://localhost:3000` bei `Host: 127.0.0.1:8787`);
`Origin: null` wird abgelehnt. Damit scheitert ein DNS-Rebinding-Angriff (`Host`/`Origin` = Angreifer-Domain), auch wenn der
Angreifer den CSRF-Header setzen kann.

## CSRF-Schutz (mutierende Requests)

Für `POST`, `PATCH`, `PUT`, `DELETE` gilt:

| Regel | Fehler |
|---|---|
| Header `X-Adispatch-Request: 1` ist Pflicht | `403 csrf_header_missing` |
| `Sec-Fetch-Site: cross-site` wird abgelehnt | `403 cross_site_request` |
| `Origin` muss auf einen erlaubten Host zeigen (s. o.; oder in `allowedOrigins` der App stehen) | `403 origin_not_allowed` |
| Body nur als `application/json` (leerer Body erlaubt) | `415 unsupported_media_type` |
| `OPTIONS` (CORS-Preflight) | `405 method_not_allowed` |

Beispiel: `curl -X POST -H 'X-Adispatch-Request: 1' http://127.0.0.1:8787/api/v1/scheduler/pause`

## Fehlerform

```json
{ "error": { "code": "lock_conflict", "message": "Workflow 'coder' already has an active run …", "details": { "holderRunId": "run-…" } } }
```

| HTTP | Codes (Auswahl) |
|---|---|
| 400 | `invalid_request` (Schema-Validierung, `details.issues`), `invalid_json`, `manual_item_required`, `manual_item_not_supported`, `manual_item_invalid_ref`, `invalid_parameters` (`details.errors`), `lifecycle_not_skippable`, `validation_error` |
| 403 | CSRF-/Origin-Codes (s. o.) |
| 421 | `host_not_allowed` (Host-Allowlist) |
| 404 | `not_found`, `config_unknown_workflow`, `manual_item_not_found`, `view_not_found` |
| 409 | `lock_conflict`, `run_not_active`, `run_not_cancellable`, `run_not_controlled`, `run_not_recovery_pending`, `run_already_started`, `lifecycle_busy`, `lifecycle_not_retryable`, `invalid_transition` |
| 422 | `config_invalid` (Reload abgelehnt; aktive Konfiguration bleibt) |
| 502 | `source_unavailable` |
| 503 | `run_controller_not_ready` (Recovery läuft), `run_controller_not_accepting` / `scheduler_not_accepting` (Drain/Shutdown) |
| 500 | `kill_failed`, `internal_error` |

## Endpunkte

### Health / Status

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/health` | `200 {"status":"ok","time":"…"}` sobald HTTP läuft |
| GET | `/ready` | `200` / `503` `{"ready":bool,"checks":{"database","recovery","scheduler","shuttingDown"}}` (kein eigener Config-Check: ohne gültige Konfiguration startet die Instanz nicht, ein gescheiterter Reload behält die aktive) – `ready` erst nach abgeschlossener Recovery und gestartetem Scheduler, `false` während Shutdown |
| GET | `/api/v1/status` | Scheduler-Zustand, Limits, Auslastung, Zähler (s. u.) |

```json
{
  "version": "0.3.0", "startedAt": "…", "time": "…",
  "readiness": { "ready": true, "checks": { … } },
  "scheduler": { "state": "running|paused|draining|stopping|recovering", "ready": true, "paused": false, "draining": false,
                 "stopping": false, "pollingIntervalMs": 30000,
                 "lastPlanningStep": { "startedAt": "…", "finishedAt": "…", "skipped": null, "startedRunIds": [] } },
  "limits": { "maxConcurrent": 5, "configuredMaxConcurrent": 5, "override": null },
  "usage": { "activeRuns": 2, "supervisedRuns": 2, "recoveryPending": 0, "byWorkflow": { "coder": { "active": 2, "max": 2 } } },
  "counts": { "activeBlocks": 1, "failedActions": 0, "notifications": { "pending": 0, "delivered": 3, "failed": 1 } },
  "config": { "version": 2, "hash": "…", "loadedAt": "…", "configDir": "/etc/adispatchd" },
  "server": { "host": "127.0.0.1", "port": 8787, "loopback": true },
  "sse": { "clients": 1 },
  "retention": { "lastRunAt": "…", "deletedRuns": { "successful": 3, "failed": 0, "blocked": 0 }, "errors": 0 }
}
```

### Scheduler / Shutdown

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| POST | `/api/v1/scheduler/pause` | – | `200` Status (nur automatische Starts pausiert) |
| POST | `/api/v1/scheduler/resume` | – | `200` Status; sofortiger Planungsschritt |
| PATCH | `/api/v1/scheduler/runtime` | `{"maxConcurrent": 3}` bzw. `null` = YAML-Wert | `200` Status |
| POST | `/api/v1/shutdown/drain` | – | `202 {"accepted":true,"mode":"drain","activeRuns":[…]}` – keine neuen Runs, aktive laufen zu Ende, dann Prozessende (Exit 0) |
| POST | `/api/v1/shutdown/cancel-all` | `{"reason"?}` | `202` – alle Runs abbrechen (`on_cancel` bzw. `on_error`, wenn `on_cancel` nicht definiert ist), dann stoppen. Ein Cancel-All während eines Drains eskaliert ihn |

### Workflows

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| GET | `/api/v1/workflows` | – | `{"workflows":[Workflow], "overrides":{"global":{},"workflows":{}}}` |
| GET | `/api/v1/workflows/:id` | – | Workflow + `diagnosis` (letzte Planungsdiagnose), `filter`, `hooks` |
| PATCH | `/api/v1/workflows/:id/runtime` | `{"enabled"?: bool\|null, "priority"?: number\|null, "maxConcurrent"?: int≥1\|null}` (`null` = Override entfernen) | `200` Workflow |
| POST | `/api/v1/workflows/:id/start` | `{"item"?: "https://github.com/o/r/issues/7" \| "#7" \| "7" \| "repo_a:7", "parameters"?: {…}}` | `202 {"run": RunSummary}` |
| POST | `/api/v1/workflows/:id/dry-run` | – | `200` DryRunResult (WI-09; Shell-Prüfungen `not_evaluated`; je Kandidat optional `projectFields`: `project.*` → `{known, value}` bzw. `{known: false, reason}`, WI-14; `hooks: {onResult: [...], technical: {crashed, start_error, timed_out, cancelled → Hook}}`, WI-17; seit 0.3.0 `secrets` wie beim Workflow, WI-18; `source.sources` je Source, `capacity.perSource`, WI-20; je Kandidat optional `linkedFields` für `linked_branches` … `work_pr_url`, wenn der Workflow sie verwendet, WI-21; bei `execute.type: container` `container: {engine, image, command, args}` = Engine-Aufruf mit unaufgelösten Templates und `<run-id>`, Secrets nur als `-e NAME`, WI-19) |

`Workflow`: `id, name, file, enabled, priority, maxConcurrent` (effektiv), `configured {enabled, priority, maxConcurrent}`,
`overrides`, `trigger`, `identity`, `activeRuns`, `activeBlocks`, `parameters {name: {type, required, default, description, values?}}`,
`execute {type, command, args, workingDirectory, timeout, secrets: [Namen], secretDelivery: {Name: env|file}, keep: [Muster], keepMaxSizeBytes, container?}` (seit 0.3.0 `secretDelivery`; nie Werte; bei `type: container` sind `command`/`args` der Engine-Aufruf mit `<run-id>`/`<data-dir>` und `container = {engine, image, command, workdir, mounts, resources, user, network, pull}`, WI-19), `secrets` (seit 0.3.0: alle deklarierten Secrets von `execute` und `shell`-Actions als `[{where, name, identity, delivery, variable}]`, nie Werte), `hasFilter`, `hasShellFilter`,
`conditions` (seit 0.3.1, siehe unten; vorher nur Anzahlen), `maxTechnicalFailures`, `cron` (Schedule: `nextSlot`, `lastFiring`, …), `lastPlanning`.

**`conditions` (seit 0.3.1, WI-24)** – Definition und letzter Status aller Shell-Prüfungen (nur im Speicher; ein Reload
verwirft den Status geänderter/entfernter Workflows; nach einem Neustart `last: null`):

```json
{
  "workflow": [{
    "index": 0, "name": "Credits verfügbar", "label": "Credits verfügbar",
    "command": "/etc/adispatchd/scripts/check-credits.sh", "displayCommand": "scripts/check-credits.sh",
    "args": [], "timeoutMs": 15000, "cacheMs": 60000,
    "last": { "status": "ok", "checkedAt": "…", "ranAt": "…", "durationMs": 12, "cached": true,
              "exitCode": 0, "error": null, "stderr": null }
  }],
  "item": [{ "index": 0, "name": null, "label": "scripts/check-item.sh {item.number}", "command": "…",
             "displayCommand": "scripts/check-item.sh", "args": ["{item.number}"],
             "timeoutMs": 30000, "last": { "at": "…", "items": 3, "ok": 2, "notNow": 1, "error": 0, "notEvaluated": 0 } }],
  "shellFilter": { "name": null, "label": "…", "command": "…", "displayCommand": "…", "timeoutMs": 30000,
                   "last": { "at": "…", "items": 4, "ok": 3, "notNow": 1, "error": 0, "notEvaluated": 0 } }
}
```

- `command` = aufgelöster (absoluter) Pfad bzw. Programmname; `displayCommand` = relativ zum config-dir, wenn das
  Skript darin liegt, sonst wie `command`. `label` = `name`, sonst `displayCommand` + `args`, auf 80 Zeichen gekürzt.
  Auch Ablehnungsgründe (`workflow condition 0 "Name" (scripts/check.sh) is false`) zeigen den relativen Pfad.
- `last.error` und `last.stderr` werden bereinigt (ANSI-Escapes, Steuer- und Bidi-Zeichen entfernt), dann redigiert,
  dann gekürzt.
- `last.status` (Workflow-Conditions): `ok` (Exit 0), `not_now` (Exit 1), `error` (Exit ≥ 2, Timeout, Signal,
  Startfehler, Template-Fehler; Detail in `error`), `skipped` (nicht ausgeführt, weil eine frühere Condition
  entschieden hat); `last: null` = seit Start/Reload nie ausgewertet. `checkedAt` = Auswertung durch Planung bzw.
  Cron-Slot, `ranAt` = Start der Ausführung (bei `cached: true` älter). `stderr` = erste nicht-leere stderr-Zeile,
  gekürzt; `error` und `stderr` sind redigiert.
- Item-Conditions und `shellFilter`: `last` = Zusammenfassung des letzten Planungsschritts (`items` = Items, deren
  Item-Conditions bzw. Shell-Filter ausgeführt wurden; Zählung je Ergebnis); kein Einzelstatus pro Item.
- Die Planungsdiagnose und das DryRunResult enthalten in jedem `CheckDiagnosis` zusätzlich `name`, wenn konfiguriert.

Mehrere Sources (WI-20): `trigger` enthält dann zusätzlich `sources: [<id>, …]` (`source` = erste Source, wie bisher);
`maxConcurrentPerSource` (`null` = nicht konfiguriert); `lastPlanning.sources: [{sourceId, status, error, polled}]` (auch
bei einer Source, ein Eintrag; `lastPlanning.status` ist `source_error`, sobald eine Source ausfiel, `error` fasst die
Meldungen zusammen). Die Planungsdiagnose (`diagnosis`) und das DryRunResult (`source`) behalten `sourceId` (erste
Source), `polled` (Summe), `pushdown` und `error` und haben zusätzlich `sources: [{sourceId, status, error, polled,
pushdown}]`; neuer Kandidaten-Status `source_limit` (`max_concurrent_per_source` erreicht). Manueller Start: `item` darf
`<source>:<nr>` sein; bei mehreren Sources wird die Source aus URL bzw. Präfix abgeleitet, sonst `400
manual_item_invalid_ref` mit Hinweis.

Manueller Start umgeht Filter/Conditions/Limits/Blocks/Pause, nicht den aktiven Lock (`409 lock_conflict`).

### Runs

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/runs?workflow=&status=running,completed&trigger=source\|schedule\|manual&item=<itemKey>&result=success\|failure&active=true\|false&before=<ISO>&limit=50&offset=0` | `{"runs":[RunSummary],"total","limit","offset"}` (neueste zuerst, `limit ≤ 500`) |
| GET | `/api/v1/runs/:id` | RunDetail |
| GET | `/api/v1/runs/:id/events?after=<sequence>&limit=1000` | `{"events":[RunEvent],"hasMore","nextAfter"}` |
| GET | `/api/v1/runs/:id/logs?stream=stdout\|stderr&offset=<byte>&limit=<bytes>` bzw. `&tail=<bytes>` | LogPage |
| GET | `/api/v1/runs/:id/kept` | KeptListing – gesicherte Dateien (`execute.keep`, WI-22) |
| GET | `/api/v1/runs/:id/kept/<pfad>` | Download einer gesicherten Datei (`<pfad>` relativ zu `kept/`, Segmente URL-kodiert); `400 invalid_path`, `404 not_found` |
| POST | `/api/v1/runs/:id/cancel` `{"reason"?}` | `202 {"runId","status":"cancelling","run"}`; `409` wenn beendet/nicht abbrechbar |
| POST | `/api/v1/runs/:id/recovery/retry` `{"assumeGone"?: bool}` | `202` – Recovery eines `recovery_pending`-Runs erneut versuchen (`assumeGone: true` = Operator bestätigt, Prozess ist weg); `409 run_not_recovery_pending` |

`RunSummary`:
```json
{ "id": "run-20261016T…-ab12cd34", "workflowId": "coder", "workflowName": "Coder", "triggerType": "source",
  "sourceId": "project_a", "sourceItemKey": "project_a:7", "sourceUrl": "https://github.com/…/issues/7",
  "scheduledFor": null, "identity": "coder", "status": "completed", "active": false,
  "outcome": "success|failure|technical_error|cancelled|active", "finalStatus": "completed",
  "businessResult": "success", "finalReason": "exit code 0", "resultMessage": "PR opened", "statusMessage": "phase 2",
  "resultOutcome": "approved", "completionHook": "on_result.approved",
  "exitCode": 0, "lifecycleStatus": "succeeded", "lifecycleFailed": false,
  "createdAt": "…", "startedAt": "…", "finishedAt": "…", "durationMs": 12345 }
```
`outcome` trennt eindeutig fachliches `failure` (Ergebnisdatei) von technischem Fehler (`crashed|start_error|timed_out`)
und `cancelled`; `lifecycleFailed` zeigt separat „Lifecycle failed“ (Spec §21). `resultOutcome` ist das benannte
Ergebnis aus der Ergebnisdatei (`outcome`, ab 0.3.0; `null` ohne bzw. bei technischem Fehler) – eigener Name, weil
`outcome` die UI-Klassifikation ist. `completionHook` ist der beim Übergang nach `finalizing` gewählte Abschluss-Hook
(z. B. `on_success`, `on_result.approved`, `on_error`; `null`, wenn kein Hook läuft oder bei Runs vor 0.3.0).

`RunDetail` = RunSummary + `lockKey, parameters, command {command, args}, workingDirectory, workspacePath, pid,
result` (geparste Ergebnisdatei), `error` (technische Diagnose), `input` (`context.json`, Worker-Input; max. 1 MiB) /
`inputError`, `resultFile` / `resultFileError` (Rohdatei), `actions` (Journal inkl. `attemptsDetail`), `events` (max. 500,
`eventsTruncated`), `logs {stdout:{size, truncated}, stderr:{…}}`, `block` (aktiver Block des Scopes),
`kept` (`{files, bytes, skippedCount, message, error}` aus dem Event `run.kept_files`, sonst `null`), `supervised`,
`blockGeneration, countedTechnicalFailure, configVersion, configHash, finalizingAt, updatedAt`.

`LogPage`: `{"runId","active","stream","offset","length","nextOffset","size","eof","exists","data"}` – Seiten max. 1 MiB
(Default 64 KiB), geschnitten an UTF-8-Zeichengrenzen; `tail=N` liefert die letzten N Bytes. Folgeseite: `offset=nextOffset`.
Für Live-Logs `run.output` per SSE nutzen und bei Reconnect ab `size` nachladen.

`KeptListing` (Dateien unter `data-dir/runs/<run-id>/kept/`, sortiert, höchstens 10 000):
```json
{ "runId": "run-…", "files": [{ "path": ".agent/gate/unit.log", "size": 1234 }], "totalBytes": 1234, "truncated": false,
  "report": { "message": "kept 1 file(s), 1234 bytes; 1 skipped (size_limit)", "patterns": [".agent/gate/*.log"],
              "maxBytes": 104857600, "files": 1, "bytes": 1234, "unmatched": [], "notSearched": [],
              "skipped": [{ "path": ".agent/gate/huge.log", "reason": "size_limit", "size": 209715200 }],
              "skippedCount": 1, "walkLimitReached": false } }
```
`report` ist die Payload des Run-Events `run.kept_files`. `report: null` heißt: Für diesen Run wurde (noch) kein
Sicherungsschritt ausgeführt – der Workflow hat kein `execute.keep`, der Run hatte keinen Workspace oder ist noch nicht
bis zum Cleanup gekommen. Ein ausgeführter Schritt ohne Treffer liefert dagegen einen `report` mit `files: 0`.
`bytes`/`size` sind die **geschriebenen** Bytes (nach dem Redigieren), `size` in `skipped` die Größe der Quelldatei.
Gründe in `skipped[].reason`: `size_limit`, `symlink`, `directory` (Muster benennt ein Verzeichnis; Hinweis in
`message`), `not_regular_file`, `outside_workspace`, `changed` (Datei nach der Suche ersetzt), `file_limit`, `error`.
`unmatched` = Muster ohne Treffer, `notSearched` = Wildcard-Muster, die wegen der Grenze für Verzeichniseinträge nicht
(vollständig) durchsucht wurden (`walkLimitReached: true`). `alreadyPresent: true` nach einer fortgesetzten
Finalisierung, `error` bei einem grundsätzlichen Problem (z. B. Workspace fehlt; dann ist nichts gesichert).

Secrets werden beim Kopieren redigiert – best effort, wie Logs (gleiche byteweise Ersetzung wie stdout/stderr; Marker
`[REDACTED]`); die ausgelieferten Dateien enthalten also bereits den redigierten Inhalt.

Download: Der Pfad wird segmentweise geprüft (keine leeren, `.`/`..`-Segmente, kein `\`, kein NUL), jede Komponente
darf kein Symlink sein, der aufgelöste Pfad muss unter `kept/` liegen, und nur reguläre Dateien werden ausgeliefert –
sonst `400 invalid_path` bzw. `404 not_found`. Antwort immer mit `Content-Disposition: attachment` (ASCII-Name plus
`filename*=UTF-8''…` nach RFC 5987), `Content-Length`, `X-Content-Type-Options: nosniff` und
`Content-Security-Policy: sandbox`. `Content-Type` nach Endung: `.log`/`.txt`/`.diff`/`.patch` → `text/plain`,
`.json` → `application/json`, `.jsonl`/`.ndjson` → `application/x-ndjson`, `.md` → `text/markdown`, `.csv` →
`text/csv`, `.xml` → `application/xml`, `.yaml`/`.yml` → `application/yaml` (Textarten mit `charset=utf-8`), dazu
`.gz`, `.zip`, `.tar`, `.png`, `.jpg`, `.pdf`; alles andere, insbesondere HTML/SVG/JS, als `application/octet-stream`.

### Blocks / Failed Actions

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/blocks?workflow=` | `{"blocks":[Block]}` – nur aktive interne Retry-Blocks (nicht GitHub-„blocked by“) |
| POST | `/api/v1/blocks/:id/clear` `{"clearedBy"?}` | `200 {"block"}` – neue Zählperiode, Historie bleibt |
| GET | `/api/v1/actions/failed` | `{"actions":[Action + attemptsDetail, run: RunSummary, busy]}` |
| POST | `/api/v1/actions/:id/retry` | `202 {"accepted":true,"action"}` – frische Versuchsrunde, Kette läuft weiter (Hintergrund); `409 lifecycle_busy` / `lifecycle_not_retryable` |
| POST | `/api/v1/actions/:id/skip` | `202` – Action überspringen, Kette läuft weiter; `400 lifecycle_not_skippable` |

`Block`: `id, workflowId, workflowName, itemKey (null = Workflow-Scope), reason, runId, failureCount, generation, createdAt,
clearedAt, clearedBy, active, affectedRunIds, sourceUrl`.

### Views

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/views` | `{"views":[{id, title, file, sources, columns, sort, filter}]}` |
| GET | `/api/v1/views/:id` | View-Definition |
| GET | `/api/v1/views/:id/items?refresh=true` | ViewItems (Cache 30 s, `refresh` umgeht ihn) |

```json
{ "view": { "id": "needs-maintainer", "title": "Needs Maintainer", "sources": ["project_a","project_b"] },
  "columns": [ { "field": "title", "label": "Titel", "link": "url", "type": "string" }, … ],
  "rows": [ { "key": "project_a:7", "sourceId": "project_a", "itemId": "7", "url": "https://…", "lastRunId": "run-…",
              "cells": [ { "value": "Fix login", "known": true, "link": "https://github.com/…/issues/7" }, … ] } ],
  "errors": [ { "sourceId": "project_b", "message": "… (redigiert)" } ], "filterUnknown": 0, "truncated": false,
  "fetchedAt": "…", "cached": false }
```
`cells` hat die Reihenfolge von `columns`. Nicht verfügbare Felder: `value: null, known: false`. Links nur `http(s)`.
Spalten vom Typ `object[]` (z. B. `closing_prs`, WI-21) liefern `value` als Liste flacher Objekte
(`[{ "number": 12, "state": "open", "head_ref": "feature/12", "is_draft": false, "url": "…" }]`); `work_pr` hat
als `link` die PR-URL (`work_pr_url`).
Run-Felder: `run.last_id`, `run.last_workflow`, `run.last_status`, `run.last_result`, `run.last_result.message`,
`run.last_status_message`, `run.last_started_at`, `run.last_finished_at` (letzter Run des Items nach Erstellzeit, workflowübergreifend).

### Konfiguration

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/config` | `{"config": LoadedConfig (Webhook-URLs redigiert), "overrides"}`; `config.filters` listet die benannten Filter (`{id, file, description, filter}`, Filter expandiert) |
| GET | `/api/v1/config/files` | `{"files":[{"file":"workflows/coder.yaml","content":"…"}]}` – YAML read-only (Top-Level-Dateien inkl. `dashboard.yaml`, `workflows/`, `views/`, `filters/`), **strukturell redigiert** (unabhängig vom geladenen Stand): Werte von `url`-Keys, alles unter `headers`/`headers_env`, jeder String-Wert mit `http(s)://` auf Schema+Host gekürzt (z. B. Webhook-Literale in `env:`), Keys wie `*token`, `*secret`, `password`, … sowie Pfad/Query von URLs in Kommentaren → `[REDACTED]`. Nicht parsebare Dateien werden nicht roh ausgeliefert (`content: null`, `error` mit Zeilennummer) |
| POST | `/api/v1/config/validate` | `{"ok", "errors":[ConfigIssue], "warnings", "hash"?}` – prüft Dateien, aktiviert nichts |
| POST | `/api/v1/config/reload` | `200 {"ok":true,"version","hash","changed","diff","resetOverrides","warnings"}` / `422 config_invalid` (`details.errors`) – atomar, bei Fehler bleibt die aktive Konfiguration |

### Dashboard-Infos (seit 0.3.1, WI-24)

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| GET | `/api/v1/dashboard/info` | – | `{"configured": bool, "file": "dashboard.yaml"\|null, "info": [InfoTile]}` – liest nur; startet **nie** ein Skript |
| POST | `/api/v1/dashboard/info/:id/refresh` | `{}` | `202 {"accepted":true,"alreadyRunning":bool,"tile":InfoTile}` – sofortiger Abruf im Hintergrund (läuft schon einer: `alreadyRunning: true`, kein zweiter Start); `404 not_found`; `429 rate_limited` mit `Retry-After` und `details.retryAfterMs` (je Kachel höchstens alle 10 s, insgesamt 20 je Minute); `503 shutting_down` während des Herunterfahrens. CSRF-Header, Host-/Origin-Regeln wie bei jedem POST |

`InfoTile`: `id, title, type (text|number|percent), value` (Zahl, Text oder `null`; der letzte gültige Wert bleibt bei
Fehlern erhalten), `unit` (`%` bei `percent`), `status` (`ok` / `warn` / `critical` nach Schwellwerten, `error` =
letzter Abruf fehlgeschlagen, `pending` = noch kein Wert), `updatedAt` (Zeit des gültigen Werts), `expiresAt`
(Ablauf des letzten gültigen Werts, `null` ohne gültigen Wert), `nextAttemptAt` (nächster Abruf im Hintergrund – nach
Erfolg = `expiresAt`, nach einem Fehler der Wiederholungszeitpunkt; `null`, solange ein Abruf läuft oder wartet),
`error?` (kurz; z. B. `exit code 2: <erste stderr-Zeile>`, `timed out after 15000ms`, `unparsable output "…"`;
bereinigt, redigiert, dann gekürzt), `stale` (Wert älter als der fehlgeschlagene Versuch),
`refreshing`, `lastAttemptAt`, `durationMs`, `thresholds {warnAbove, criticalAbove, warnBelow, criticalBelow}`.

### Notifications

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/notifications?state=pending\|delivered\|failed&limit=&offset=` | `{"notifications":[{id, eventType, payload, deliveryState, attempts, lastError, nextAttemptAt, createdAt, deliveredAt, deliveries:[{channelId, state, attempts, lastError, lastStatus, nextAttemptAt, deliveredAt}]}], "counts"}` |
| POST | `/api/v1/notifications/:id/retry` | `202 {"notification","requeued"}` – fehlgeschlagene Zustellungen erneut einreihen |

Webhook-Body (JSON-POST, Timeout 10 s, bis zu 6 Versuche mit Backoff 5 s/30 s/2 min/10 min/30 min, 4xx außer 408/429 nicht wiederholt):
`{"source":"adispatchd","id":1,"event":"retry_block_created","createdAt":"…","text":"[adispatchd] …","payload":{…}}`
(`text` macht ihn Slack-kompatibel).

## SSE: `GET /api/v1/events[?run=<runId>][&lastEventId=<id>]`

`text/event-stream`. Jede Nachricht:
```
id: 1234            ← nur bei persistenten Events (run_events.id, global streng steigend)
event: run.event
data: {"type":"run.event","time":"2026-10-16T…","id":1234,"payload":{…}}
```

| `event` | persistent / `id` | Payload |
|---|---|---|
| `stream.open` | `id` = aktuelle Basis (ohne Resume) | `{lastEventId, replayed}` |
| `stream.reset` | `id` = neueste ID | `{reason:"too_many_missed_events"\|"unknown_last_event_id", lastEventId}` – Client lädt per REST neu (auch wenn die `Last-Event-ID` größer als jede bekannte ID ist, z. B. nach Austausch des data-dir) |
| `run.event` | ja | RunEvent `{id, runId, sequence, timestamp, origin: worker\|orchestrator, type, payload}`; `type` u. a. `run.status` (`{from,to,target?,outcome?,hook?,blockId?}`; `outcome`/`hook` beim Übergang nach `finalizing`), `run.outcome_warning` (`{code: invalid_outcome|unmatched_outcome, message, outcome?, hook?}`), Worker-`status`/`progress`/…, `diagnostic.*`, `lifecycle.action`, `lifecycle.chain`, `run.spawn`, `run.cancel_requested`, `recovery.*`, `run.kept_files`, `workspace.cleanup` |
| `run.output` | nein | `{runId, stream: stdout\|stderr, data, at}` (Live-Log, redigiert; per REST nachladen) |
| `run.action` | nein | Action-Journal-Eintrag nach Änderung |
| `block.created` / `block.cleared` | nein | Block |
| `system.status` | nein | `{ready, paused, draining, stopping, activeRuns}` |
| `system.ready` | nein | `{ready:true}` nach Recovery |
| `notification` | nein | Notification inkl. `deliveries` (bei Anlage und jedem Zustellversuch) |
| `config.reloaded` | nein | `{version, hash, changed, diff, resetOverrides}` |
| `retention.finished` | nein | `{finishedAt, deletedRuns, errors}` |
| `workflow.conditions` | nein | `{workflowId}` – der letzte Status einer Workflow-Condition oder die Item-Check-Zusammenfassung hat sich geändert (seit 0.3.1); Details per `GET /api/v1/workflows/:id` |
| `dashboard.info` | nein | `InfoTile` nach jeder Änderung (Abruf gestartet/fertig, Wert, Status; seit 0.3.1) |

- **Reconnect:** `EventSource` sendet `Last-Event-ID` automatisch; alternativ `?lastEventId=`. Verpasste persistente
  Events werden aus SQLite nachgeliefert (max. 5000, sonst `stream.reset`), danach live – ohne Lücken/Duplikate.
  Nicht persistente Events gehen bei einem Abbruch verloren → Zustand per REST nachladen.
- `?run=<id>`: nur Events dieses Runs (plus `system.status`).
- Heartbeat-Kommentar `: heartbeat …` alle 15 s; `retry: 3000`.
- Langsame Clients: mehr als 1 MiB ungesendete Daten → Verbindung wird getrennt (Client reconnectet mit `Last-Event-ID`);
  die Logerfassung wird nie blockiert.
