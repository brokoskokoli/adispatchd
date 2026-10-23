# HTTP-API und SSE (v1)

Implementierung: `src/api/` (WI-10). Spec §15, §16, §17, §18, §21.

- Basis: `http://<server.host>:<server.port>` (Default `127.0.0.1:8787`), API unter `/api/v1`, JSON (UTF-8).
- **Anmeldung** (seit 0.4.0, WI-26): `auth.mode` in `config.yaml` – `none` (Default, keine Anmeldung wie bisher: nur auf
  Loopback binden oder hinter einem authentifizierenden Reverse Proxy/VPN betreiben; bei Nicht-Loopback-Bind wird beim
  Start gewarnt), `password` (eingebaute Benutzer, Session-Cookie) oder `trusted_header` (Identität vom vorgeschalteten
  Proxy). Jeder Endpunkt hat eine **Mindestrolle** (`viewer` < `operator` < `admin`), siehe
  [Anmeldung und Rollen](#anmeldung-und-rollen-seit-040-wi-26).
- Antworten von `/api/*`, `/health`, `/ready` tragen `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. Es werden **nie CORS-Header** gesendet.
- Die statische Web-UI (alle anderen Pfade) trägt dieselben Header plus die **Content-Security-Policy** als HTTP-Header:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`,
  ergänzt um `frame-src <origin> …` genau für die aktivierten `ui.external_links` mit `embed: true` (seit 0.4.0, WI-25;
  aus der aktiven Konfiguration, nach einem Reload sofort; ohne solche Einträge kein `frame-src`).
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

## Anmeldung und Rollen (seit 0.4.0, WI-26)

Konfiguration: [configuration-reference.md](configuration-reference.md) §3.1 (`auth`); Betrieb (Tailscale Serve,
oauth2-proxy, HTTPS-Proxy, Hash erzeugen): [operations.md](operations.md). Mit `auth.mode: none` (Default) gilt nichts aus
diesem Abschnitt außer `GET /api/v1/auth/me`; alle Endpunkte verhalten sich wie vor 0.4.0.

**Reihenfolge der Prüfungen** je Request: Host-/Origin-Allowlist → CSRF (mutierend) → Anmeldung → Mindestrolle der Route.

| Fall | Antwort |
|---|---|
| Route verlangt eine Rolle, keine gültige Anmeldung | `401 authentication_required` |
| Rolle zu niedrig | `403 forbidden` mit `details: {requiredRole, role}` |
| `trusted_header`: Header von einer Gegenstelle außerhalb `trusted_proxies` | `401 untrusted_proxy` (auch wenn der Header stimmt) |
| `trusted_header`: Header leer, mehrfach oder mit Leer-/Steuerzeichen bzw. Komma | `401 invalid_identity_header` |
| `trusted_header`: Login nicht in `auth.trusted_header.users` | `403 login_not_allowed` |
| Steuer-Token nicht von Loopback / falsch | `401 control_token_not_local` / `401 invalid_control_token` |
| Steuer-Token auf einer Route, die die CLI nicht braucht | `403 control_token_not_allowed` |
| `trusted_header` mit `proxy_secret_env`: `X-Adispatch-Proxy-Secret` fehlt/falsch (oder Variable fehlt) | `401 invalid_proxy_secret` |

- **`auth.read_requires_login: false`:** `GET`/`HEAD` (inkl. SSE) gehen ohne Anmeldung mit der Rolle `viewer`; jede
  schreibende Anfrage braucht eine Anmeldung.
- **Unbekannte API-Pfade** (`/api/…` ohne Route) verlangen wie `viewer`-Routen eine Anmeldung (`401` statt `404`, kein
  Ausprobieren von Routen ohne Anmeldung); andere unbekannte Pfade gehören zur statischen UI (`404`).
- **`/health`, `/ready`** bleiben ohne Anmeldung (Monitoring); `/ready` liefert dann nur `{"ready": bool}` (Status 200/503
  unverändert), die einzelnen `checks` nur angemeldet.
- **Die statische UI** (HTML/JS/CSS, enthält keine Daten) ist ohne Anmeldung abrufbar, damit die Login-Seite lädt.
- **SSE** (`/api/v1/events`) verlangt `viewer` wie jede Leseroute; eine geöffnete Verbindung wird beim Logout und beim
  Ablauf der Session geschlossen (der Reconnect scheitert dann mit `401`).

### Auth-Endpunkte

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| POST | `/api/v1/auth/login` | `{"name","password"}` (CSRF-Header wie jeder POST) | `200 {"user":{"name","role","via":"password"},"expiresAt"}` + `Set-Cookie: adispatch_session=…; Path=/; Max-Age=…; HttpOnly; SameSite=Strict` bzw. über HTTPS `__Host-adispatch_session=…; …; Secure`; `401 invalid_credentials` (gleiche Antwort für unbekannte Benutzer und falsche Passwörter); `429 too_many_attempts` mit `Retry-After`; `400 login_not_available` außerhalb von `mode: password` |
| POST | `/api/v1/auth/logout` | – | `200 {"ok":true}`, beendet die Session (beide Cookie-Namen gelöscht, offene SSE-Verbindungen der Session geschlossen) |
| GET | `/api/v1/auth/me` | – | `{"mode","readRequiresLogin","user":{"name","role","via"}\|null,"role","expiresAt","error"}` – `role` = wirksame Rolle (`mode: none` → `admin`; anonym mit `read_requires_login: false` → `viewer`; sonst `null`), `error` = Grund, warum die Anfrage abgewiesen würde (z. B. `login_not_allowed`), `via` ∈ `password`, `trusted_header`, `control_token` |

**Sessions** (`mode: password`): 32 zufällige Bytes (`randomBytes`), im Speicher (ein Neustart meldet alle ab), gültig für
`auth.session_ttl` ab Anmeldung (kein Verlängern). Die Rolle wird bei jeder Anfrage aus der aktiven Konfiguration gelesen –
nach einem Reload gilt die neue Rolle sofort, ein entfernter Benutzer ist sofort abgemeldet. `Secure` wird gesetzt, wenn die
Anfrage per HTTPS kam: eigene TLS-Verbindung oder `X-Forwarded-Proto: https` von einer Gegenstelle in `auth.trusted_proxies`;
das Cookie heißt dann `__Host-adispatch_session` (kann von keinem anderen Host und keiner HTTP-Seite gesetzt werden).
Doppelte Cookies: `__Host-` gewinnt; wird `adispatch_session` mehrfach mit verschiedenen Werten gesendet (Cookie-Tossing),
gilt die Anfrage als nicht angemeldet.

**Login-Schutz:** Passwortvergleich mit scrypt (`node:crypto`) und `timingSafeEqual`; ein unbekannter Benutzer kostet
dieselbe scrypt-Berechnung (Dummy-Hash) – keine Unterscheidung „unbekannt“/„falsch“, weder in Antwort noch in Laufzeit.
Nach jedem Fehlschlag 1 s Verzögerung. Grenzen je Fenster von 15 Minuten: 5 Fehlversuche je (Benutzername, Client-IP),
50 je Benutzername über alle IPs, 20 je Client-IP (IPv6 je /64) – auch für nicht existierende Namen. Ein Angreifer sperrt
damit nur sich selbst: der richtige Benutzer meldet sich von einer IP ohne Fehlversuche weiter an (bis zur höheren
Grenze je Name). Höchstens 8 gleichzeitige Prüfungen. Einträge, die gerade sperren, werden nie aus dem Speicher verdrängt.
Client-IP ist die TCP-Gegenstelle bzw. – wenn diese in `auth.trusted_proxies` steht – der letzte Eintrag von
`X-Forwarded-For`.

**Steuer-Token** (CLI, alle Modi außer `none`): Der Daemon schreibt bei jedem Start einen neuen zufälligen Token (32 Bytes,
base64url) nach dem Start des HTTP-Servers atomar nach `<data-dir>/control.token` (Modus `0600`, JSON
`{"token","port","pid"}`) und löscht ihn beim Beenden. Die CLI sendet ihn als `X-Adispatch-Control-Token` – nur an
Loopback-URLs **mit dem Port aus der Datei** (`via: control_token`, Name `control-token`); der Daemon akzeptiert ihn nur,
wenn die TCP-Gegenstelle Loopback ist (`127.0.0.0/8`, `::1`). Der Token gilt nur als Rolle `operator` und **nur** auf den Routen, die die CLI-Steuerbefehle aufrufen (Spalte
„Steuer-Token“ der Tabelle unten: Status, Pause/Resume, Drain/Cancel-All, Config-Reload, Dry-Run); auf allen anderen
Routen → `403 control_token_not_allowed`. Grund: Worker und Shell-Actions laufen als derselbe Dienstbenutzer und **können
die Datei lesen** – jedes Skript kann damit diese Operator-Aktionen auslösen (Skripte sind vertrauenswürdiger
Konfigurationscode, Spec §20.2), aber nichts darüber hinaus.

**`via`** des Aufrufers (`password`, `trusted_header`, `control_token`, `anonymous`) steht in `GET /api/v1/auth/me` und im
Audit. Künftige sensible Routen (WI-27) verlangen eine interaktive Anmeldung (`password` oder `trusted_header`;
`isInteractive()` in `src/api/auth.ts`) und – bei `trusted_header` – einen nicht lokal fälschbaren Proxy
(`isIdentityForgeableLocally()` in `src/config/auth.ts`, siehe [operations.md](operations.md#anmeldung-web-ui-und-api-seit-040)).

**Audit:** Jede schreibende Anfrage eines angemeldeten Benutzers steht im Daemon-Log (`api write` mit `actor`, `role`,
`via`, `method`, `route`, `path`, `status`; nie Bodies oder Passwörter). Schreibende Aktionen an einem Run (manueller Start,
Abbruch, Recovery-Retry, Action-Retry/-Skip) erzeugen zusätzlich das Run-Event `audit.user_action`
(`{action: start|cancel|recovery_retry|action_retry|action_skip, actor, role, via, …}`), sichtbar in den Events des Runs;
beim Abbruch ohne eigenen Grund lautet `reason` „cancelled via API by <Benutzer>“. Beim Entfernen eines Blocks wird der
angemeldete Benutzer als `clearedBy` gespeichert (ein mitgesendetes `clearedBy` wird dann ignoriert).

### Mindestrolle je Endpunkt

`public` = ohne Anmeldung. `HEAD` gilt wie `GET`. „Steuer-Token: ja“ = der CLI-Steuer-Token wird dort akzeptiert (als
`operator`), sonst `403 control_token_not_allowed`. Die Tabelle wird von `src/api/roles.test.ts` gegen die registrierten
Routen geprüft; eine neue Route ohne Eintrag in `src/api/roles.ts` lässt sich nicht registrieren.

| Endpunkt | Mindestrolle | Steuer-Token |
|---|---|---|
| `GET /health` | public | – |
| `GET /ready` | public | – |
| `POST /api/v1/auth/login` | public | – |
| `POST /api/v1/auth/logout` | public | – |
| `GET /api/v1/auth/me` | public | – |
| `GET /api/v1/status` | viewer | ja |
| `POST /api/v1/scheduler/pause` | operator | ja |
| `POST /api/v1/scheduler/resume` | operator | ja |
| `PATCH /api/v1/scheduler/runtime` | operator | – |
| `POST /api/v1/shutdown/drain` | operator | ja |
| `POST /api/v1/shutdown/cancel-all` | operator | ja |
| `GET /api/v1/workflows` | viewer | – |
| `GET /api/v1/workflows/:id` | viewer | – |
| `PATCH /api/v1/workflows/:id/runtime` | operator | – |
| `POST /api/v1/workflows/:id/start` | operator | – |
| `POST /api/v1/workflows/:id/dry-run` | viewer | ja |
| `GET /api/v1/workflows/:id/parameters/:name/options` | viewer | – |
| `GET /api/v1/runs` | viewer | – |
| `GET /api/v1/runs/:id` | viewer | – |
| `GET /api/v1/runs/:id/events` | viewer | – |
| `GET /api/v1/runs/:id/logs` | viewer | – |
| `GET /api/v1/runs/:id/kept` | viewer | – |
| `GET /api/v1/runs/:id/kept/*` | viewer | – |
| `POST /api/v1/runs/:id/cancel` | operator | – |
| `POST /api/v1/runs/:id/recovery/retry` | operator | – |
| `GET /api/v1/blocks` | viewer | – |
| `POST /api/v1/blocks/:id/clear` | operator | – |
| `GET /api/v1/actions/failed` | viewer | – |
| `POST /api/v1/actions/:id/retry` | operator | – |
| `POST /api/v1/actions/:id/skip` | operator | – |
| `GET /api/v1/views` | viewer | – |
| `GET /api/v1/views/:id` | viewer | – |
| `GET /api/v1/views/:id/items` | viewer | – |
| `GET /api/v1/config` | viewer | – |
| `GET /api/v1/config/files` | viewer | – |
| `POST /api/v1/config/validate` | viewer | – |
| `POST /api/v1/config/reload` | operator | ja |
| `GET /api/v1/dashboard/info` | viewer | – |
| `POST /api/v1/dashboard/info/:id/refresh` | operator | – |
| `GET /api/v1/notifications` | viewer | – |
| `POST /api/v1/notifications/:id/retry` | operator | – |
| `GET /api/v1/items/resolve` | admin | – |
| `GET /api/v1/items/:source/:item` | admin | – |
| `POST /api/v1/items/:source/:item/comment` | admin | – |
| `POST /api/v1/items/:source/:item/labels` | admin | – |
| `POST /api/v1/items/:source/:item/project` | admin | – |
| `GET /api/v1/ui-actions` | admin | – |
| `GET /api/v1/system/metrics` | viewer | – |
| `GET /api/v1/events` | viewer | – |
| `GET /*` | public | – |

`POST …/dry-run` und `POST /config/validate` ändern nichts und brauchen daher nur `viewer` (aber eine Anmeldung, auch mit
`read_requires_login: false`). `GET …/parameters/:name/options` braucht `viewer`, bei Optionen aus einem Skript
(`options_from.command`, WI-31) zusätzlich `operator` (sonst `403 forbidden`), damit `viewer` keine Skripte auslösen kann;
mit `auth.mode: none` wie bisher ohne Einschränkung. `admin` umfasst alles von `operator`; die `admin`-Endpunkte sind die [UI-Aktionen](#ui-aktionen-als-identity-seit-040-wi-27)
(`/items/…` zusätzlich nur mit echter Anmeldung, nie mit dem Steuer-Token).

## Fehlerform

```json
{ "error": { "code": "lock_conflict", "message": "Workflow 'coder' already has an active run …", "details": { "holderRunId": "run-…" } } }
```

| HTTP | Codes (Auswahl) |
|---|---|
| 400 | `invalid_request` (Schema-Validierung, `details.issues`), `invalid_json`, `manual_item_required`, `manual_item_not_supported`, `manual_item_invalid_ref`, `invalid_parameters` (`details.errors`), `lifecycle_not_skippable`, `validation_error`, `comment_contains_secret`, `comment_too_long`, `label_not_found`, `project_not_configured`, `invalid_project_fields`, `ambiguous_item_ref` (WI-27) |
| 401 | `authentication_required`, `invalid_credentials`, `untrusted_proxy`, `invalid_proxy_secret`, `invalid_identity_header`, `control_token_not_local`, `invalid_control_token` (WI-26) |
| 403 | CSRF-/Origin-Codes (s. o.), `forbidden` (Rolle zu niedrig), `login_not_allowed`, `control_token_not_allowed` (WI-26), `ui_actions_disabled`, `user_login_required`, `identity_not_allowed` (WI-27) |
| 421 | `host_not_allowed` (Host-Allowlist) |
| 404 | `not_found`, `config_unknown_workflow`, `manual_item_not_found`, `view_not_found`, `source_not_found`, `item_not_found`, `github_not_found` (WI-27) |
| 409 | `lock_conflict`, `run_not_active`, `run_not_cancellable`, `run_not_controlled`, `run_not_recovery_pending`, `run_already_started`, `lifecycle_busy`, `lifecycle_not_retryable`, `invalid_transition`, `duplicate_comment` (WI-27), `block_run_active`, `unblock_run_active` (WI-30) |
| 422 | `config_invalid` (Reload abgelehnt; aktive Konfiguration bleibt), `github_rejected` (WI-27) |
| 429 | `too_many_attempts` (Login, WI-26), `rate_limited` (Info-Refresh), `ui_actions_throttled`, `github_rate_limited` (WI-27) |
| 502 | `source_unavailable`, `parameter_options_unavailable` (WI-31, `details: {parameter, error: {code, message}}`), `github_forbidden`, `github_auth_failed`, `github_unavailable`, `github_outcome_unknown` (WI-27) |
| 503 | `run_controller_not_ready` (Recovery läuft), `run_controller_not_accepting` / `scheduler_not_accepting` (Drain/Shutdown), `not_ready` (Auswahllisten-Dienst nicht verfügbar, `GET …/parameters/:name/options`, WI-31) |
| 500 | `kill_failed`, `internal_error` |

## Endpunkte

### Health / Status

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/health` | `200 {"status":"ok","time":"…"}` sobald HTTP läuft |
| GET | `/ready` | `200` / `503` `{"ready":bool,"checks":{"database","recovery","scheduler","shuttingDown"}}` (mit `auth.mode` ≠ `none` ohne Anmeldung nur `{"ready":bool}`) (kein eigener Config-Check: ohne gültige Konfiguration startet die Instanz nicht, ein gescheiterter Reload behält die aktive) – `ready` erst nach abgeschlossener Recovery und gestartetem Scheduler, `false` während Shutdown |
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
| GET | `/api/v1/workflows/:id/parameters/:name/options?refresh=true` | – | `200 ParameterOptions` (seit 0.7.0, WI-31, siehe unten); `404 unknown_parameter`, `400 parameter_has_no_options` (kein `enum`), `503 not_ready` (Dienst für Auswahllisten nicht verfügbar) |
| POST | `/api/v1/workflows/:id/dry-run` | – | `200` DryRunResult (WI-09; Shell-Prüfungen `not_evaluated`; je Kandidat optional `projectFields`: `project.*` → `{known, value}` bzw. `{known: false, reason}`, WI-14; `hooks: {onResult: [...], technical: {crashed, start_error, timed_out, cancelled → Hook}}`, WI-17; seit 0.3.0 `secrets` wie beim Workflow, WI-18; `source.sources` je Source, `capacity.perSource`, WI-20; je Kandidat optional `linkedFields` für `linked_branches` … `work_pr_url`, wenn der Workflow sie verwendet, WI-21; bei `execute.type: container` `container: {engine, image, command, args}` = Engine-Aufruf mit unaufgelösten Templates und `<run-id>`, Secrets nur als `-e NAME`, WI-19) |

`Workflow`: `id, name, file, enabled, priority, maxConcurrent` (effektiv), `configured {enabled, priority, maxConcurrent}`,
`overrides`, `trigger`, `identity`, `activeRuns`, `activeBlocks`, `parameters {name: {type, required, default, description, values?, optionsFrom?, allowCustom?}}` (bei `enum` seit 0.7.0: `optionsFrom` = `null`, `{type: "github", github: "branches"|"tags", source, limit, timeoutMs, cacheMs}` oder `{type: "command", command, secrets: [Namen], timeoutMs, cacheMs}` – ohne `args`; `allowCustom`, WI-31),
`execute {type, command, args, workingDirectory, timeout, secrets: [Namen], secretDelivery: {Name: env|file}, keep: [Muster], keepMaxSizeBytes, container?}` (seit 0.3.0 `secretDelivery`; nie Werte; bei `type: container` sind `command`/`args` der Engine-Aufruf mit `<run-id>`/`<data-dir>` und `container = {engine, image, command, workdir, mounts, resources, user, network, pull}`, WI-19), `secrets` (seit 0.3.0: alle deklarierten Secrets von `execute` und `shell`-Actions als `[{where, name, identity, delivery, variable}]`, nie Werte), `hasFilter`, `hasShellFilter`,
`conditions` (seit 0.4.0, siehe unten; vorher nur Anzahlen), `maxTechnicalFailures`, `cron` (Schedule: `nextSlot`, `lastFiring`, …), `lastPlanning`.

**`ParameterOptions` (seit 0.7.0, WI-31)** – Auswahlliste eines `enum`-Parameters für das Startformular:

```json
{ "options": [{ "value": "main", "label": "main" }, { "value": "web-1", "label": "Web 1 (prod)" }],
  "fetchedAt": "2026-10-23T12:00:00.000Z", "cached": false, "allowCustom": false }
```

- Mit `options_from` werden die Optionen zur Laufzeit geholt (GitHub-Branches/-Tags mit der Identity der Source bzw.
  Ausgabe des Skripts) und `cache` lang im Speicher gehalten (nur Erfolge); `refresh=true` umgeht den Cache – aber nur
  für Rollen, die starten dürfen (`operator`; mit `auth.mode: none` alle), `viewer` erhalten das gecachte Ergebnis.
  Gleichzeitige Abrufe desselben Parameters werden zusammengelegt; ein Parameter wird höchstens alle 2 s (Skript) bzw.
  alle `max(30 s, cache)` (GitHub, schont das Rate-Limit der Installation) neu geholt – schnellere Anfragen (auch mit
  `refresh`) erhalten das letzte Ergebnis mit `cached: true`.
- Statische `values` kommen unverändert zurück (`fetchedAt: null`).
- Fehler beim Abruf ergeben **200** mit `options: []` und `error: {code, message}`; `code` ist `source_unavailable`,
  `source_error`, `rate_limited`, `timeout`, `aborted` (Shutdown), `command_failed` oder `invalid_output`, `message` kurz und ohne Secrets
  (bei Skripten Exit-Code und erste stderr-Zeile).
- `POST …/start` prüft Werte von `options_from`-Parametern ohne `allow_custom` gegen die aktuelle Liste (Cache erlaubt):
  Wert nicht enthalten → `400 invalid_parameters` (`details.errors: [{parameter, message: "\"x\" is not one of the
  current options"}]`), Liste nicht abrufbar → `502 parameter_options_unavailable`, kein Start.

**`conditions` (seit 0.4.0, WI-24)** – Definition und letzter Status aller Shell-Prüfungen (nur im Speicher; ein Reload
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

Manueller Start umgeht Filter/Conditions/Limits/Blocks/Pause, nicht den aktiven Lock (`409 lock_conflict`). Ab 0.6.0:
Start ohne Item, während der Lifecycle-Run (Trigger `unblock`) eines aufgehobenen Workflow-Blocks noch `on_retry_unblock`
ausführt → `409 unblock_run_active` (Meldung nennt den Run).

### Runs

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/runs?workflow=&status=running,completed&trigger=source\|schedule\|manual\|unblock&item=<itemKey>&result=success\|failure&active=true\|false&before=<ISO>&limit=50&offset=0` | `{"runs":[RunSummary],"total","limit","offset"}` (neueste zuerst, `limit ≤ 500`) |
| GET | `/api/v1/runs/:id` | RunDetail |
| GET | `/api/v1/runs/:id/events?after=<sequence>&limit=1000` | `{"events":[RunEvent],"hasMore","nextAfter"}` |
| GET | `/api/v1/runs/:id/logs?stream=stdout\|stderr&offset=<byte>&limit=<bytes>` bzw. `&tail=<bytes>` | LogPage |
| GET | `/api/v1/runs/:id/kept` | KeptListing – gesicherte Dateien (`execute.keep`, WI-22) |
| GET | `/api/v1/runs/:id/kept/<pfad>` | Download einer gesicherten Datei (`<pfad>` relativ zu `kept/`, Segmente URL-kodiert); `400 invalid_path`, `404 not_found` |
| POST | `/api/v1/runs/:id/cancel` `{"reason"?}` | `202 {"runId","status":"cancelling","run"}`; `409` wenn beendet/nicht abbrechbar (auch Lifecycle-Runs mit Trigger `unblock`) |
| POST | `/api/v1/runs/:id/recovery/retry` `{"assumeGone"?: bool}` | `202` – Recovery eines `recovery_pending`-Runs erneut versuchen (`assumeGone: true` = Operator bestätigt, Prozess ist weg); `409 run_not_recovery_pending` |

`RunSummary`:
```json
{ "id": "run-20261016T…-ab12cd34", "workflowId": "coder", "workflowName": "Coder", "triggerType": "source",
  "sourceId": "project_a", "sourceItemKey": "project_a:7", "sourceUrl": "https://github.com/…/issues/7",
  "scheduledFor": null, "identity": "coder", "status": "completed", "active": false,
  "outcome": "success|failure|technical_error|cancelled|active", "finalStatus": "completed",
  "businessResult": "success", "finalReason": "exit code 0", "resultMessage": "PR opened", "statusMessage": "phase 2",
  "resultOutcome": "approved", "completionHook": "on_result.approved", "retryBlockHook": false,
  "exitCode": 0, "lifecycleStatus": "succeeded", "lifecycleFailed": false,
  "createdAt": "…", "startedAt": "…", "finishedAt": "…", "durationMs": 12345 }
```
`outcome` trennt eindeutig fachliches `failure` (Ergebnisdatei) von technischem Fehler (`crashed|start_error|timed_out`)
und `cancelled`; `lifecycleFailed` zeigt separat „Lifecycle failed“ (Spec §21). `resultOutcome` ist das benannte
Ergebnis aus der Ergebnisdatei (`outcome`, ab 0.3.0; `null` ohne bzw. bei technischem Fehler) – eigener Name, weil
`outcome` die UI-Klassifikation ist. `completionHook` ist der beim Übergang nach `finalizing` gewählte Abschluss-Hook
(z. B. `on_success`, `on_result.approved`, `on_error`; `null`, wenn kein Hook läuft oder bei Runs vor 0.3.0).
`retryBlockHook` (ab 0.6.0): der Run hat einen Retry-Block erzeugt, und `on_retry_block` läuft nach dem Abschluss-Hook.
`triggerType` ist `source`, `schedule`, `manual` oder (ab 0.6.0) `unblock` – Lifecycle-Run, der beim Aufheben eines
Retry-Blocks nur `on_retry_unblock` ausführt (kein Worker, kein Workspace; `completed` + `success`/`failure` je nach
Kette; nicht abbrechbar).

`RunDetail` = RunSummary + `lockKey, parameters, command {command, args}, workingDirectory, workspacePath, pid,
result` (geparste Ergebnisdatei), `error` (technische Diagnose), `input` (`context.json`, Worker-Input; max. 1 MiB) /
`inputError`, `resultFile` / `resultFileError` (Rohdatei), `actions` (Journal inkl. `attemptsDetail`), `events` (max. 500,
`eventsTruncated`), `logs {stdout:{size, truncated}, stderr:{…}}`, `block` (aktiver Block des Scopes), `retryBlock`
(ab 0.6.0: bei Trigger `unblock` der aufgehobene Block, sonst der von diesem Run erzeugte Block oder `null`),
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
| POST | `/api/v1/blocks/:id/clear` `{"clearedBy"?}` | `200 {"block","runId"}` – neue Zählperiode, Historie bleibt; `runId` = Lifecycle-Run von `on_retry_unblock` (ab 0.6.0) oder `null`; `409 block_run_active` |
| GET | `/api/v1/actions/failed` | `{"actions":[Action + attemptsDetail, run: RunSummary, busy]}` |
| POST | `/api/v1/actions/:id/retry` | `202 {"accepted":true,"action"}` – frische Versuchsrunde, Kette läuft weiter (Hintergrund); `409 lifecycle_busy` / `lifecycle_not_retryable` |
| POST | `/api/v1/actions/:id/skip` | `202` – Action überspringen, Kette läuft weiter; `400 lifecycle_not_skippable` |

`Block`: `id, workflowId, workflowName, itemKey (null = Workflow-Scope), reason, runId, failureCount, generation, createdAt,
clearedAt, clearedBy, lastStatus, clearedRunId, active, affectedRunIds, sourceUrl`. `lastStatus` (ab 0.6.0) = technischer
Endstatus des erzeugenden Runs; `clearedRunId` = Lifecycle-Run (Trigger `unblock`) des Aufhebens oder `null`.

Aufheben (ab 0.6.0): Definiert der Workflow (aktuell geladene Konfiguration) ein nicht leeres `on_retry_unblock`,
legt `clear` in derselben Transaktion einen Lifecycle-Run an (Trigger `unblock`), der nur diese Kette ausführt und
bis zu ihrem Ende das Lock für `(Workflow, Item)` hält – erst danach plant der Scheduler das Item wieder.
`clearedBy` ist mit Anmeldung immer der angemeldete Benutzer, sonst der mitgeschickte Name (UI: `ui`, Default `api`);
er erscheint als `{block.cleared_by}`. Läuft für `(Workflow, Item)` gerade ein Run, antwortet `clear` dann mit
`409 block_run_active` und ändert nichts; ohne Hook bleibt `clear` wie bisher auch bei laufendem Run möglich.
Bereits aufgehobene Blocks: `200` mit `runId: null` (idempotent). Während Recovery/Drain: `503`.

### Views

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/views` | `{"views":[{id, title, file, sources, columns, sort, filter, groupByFirst, sections, exclusive, hideEmptySections}]}` |
| GET | `/api/v1/views/:id` | View-Definition; `sort` ist seit 0.5.0 **immer eine Liste** `[{field, direction, order}]` (`order`: Liste oder `null`; `[]` = unsortiert), `sections` = `null` oder `[{title, rest, filter, fields, sort}]` (`fields` = Spalten wie `columns`, `sort` = wirksame Sortierung) |
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
Seit 0.5.0 (WI-28):
- `warnings` (immer vorhanden, Liste von Texten): z. B. `order`-Werte eines `single_select`-Projektfelds, die das
  Projekt einer Source nicht als Option kennt.
- `group_by_first`: View ohne Abschnitte → zusätzlich `"groupBy": {"field","label"}`, jede Zeile hat `group`
  (Wert des ersten Sortierschlüssels als Text, `null` = leer/unbekannt); ohne Gruppierung fehlen beide Schlüssel.
- Views **mit Abschnitten**: `rows` ist `[]`, `columns` = Default-Spalten der View, `filterUnknown` zählt nur den
  View-Filter, `truncated` = irgendein Abschnitt gekürzt; dazu `hideEmptySections` und
  ```json
  "sections": [ { "title": "Review", "rest": false, "fields": [ …wie columns… ],
                  "sort": [ { "field": "updated_at", "direction": "desc", "order": null } ],
                  "rows": [ …wie rows… ], "counts": { "rows": 2, "filterUnknown": 0, "truncated": false },
                  "groupBy": null } ]
  ```
  Reihenfolge wie konfiguriert, leere Abschnitte sind enthalten (`hideEmptySections` wertet die UI aus);
  max. 2 000 Zeilen je Abschnitt. Ohne Abschnitte ist das Format unverändert.

Run-Felder: `run.last_id`, `run.last_workflow`, `run.last_status`, `run.last_result`, `run.last_result.message`,
`run.last_status_message`, `run.last_started_at`, `run.last_finished_at` (letzter Run des Items nach Erstellzeit, workflowübergreifend).

### Konfiguration

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/config` | `{"config": LoadedConfig (Webhook-URLs redigiert), "overrides", "externalLinks"}`; `config.filters` listet die benannten Filter (`{id, file, description, filter}`, Filter expandiert); `externalLinks` = nur die aktivierten `ui.external_links` in Konfigurationsreihenfolge als `[{"id","label","url","embed"}]` mit **vollständiger** URL (seit 0.4.0, WI-25; die UI baut daraus die Toolbar-Einträge – sichtbar für jeden, der die API erreicht); `config.global.ui.externalLinks` enthält ebenfalls nur aktive Einträge, Query-String und Fragment der URL als `[REDACTED]` |
| GET | `/api/v1/config/files` | `{"files":[{"file":"workflows/coder.yaml","content":"…"}]}` – YAML read-only (Top-Level-Dateien inkl. `dashboard.yaml`, `workflows/`, `views/`, `filters/`), **strukturell redigiert** (unabhängig vom geladenen Stand): Werte von `url`-Keys, alles unter `headers`/`headers_env`, jeder String-Wert mit `http(s)://` auf Schema+Host gekürzt (z. B. Webhook-Literale in `env:`), Keys wie `*token`, `*secret`, `password`, … sowie Pfad/Query von URLs in Kommentaren → `[REDACTED]`. Nicht parsebare Dateien werden nicht roh ausgeliefert (`content: null`, `error` mit Zeilennummer) |
| POST | `/api/v1/config/validate` | `{"ok", "errors":[ConfigIssue], "warnings", "hash"?}` – prüft Dateien, aktiviert nichts |
| POST | `/api/v1/config/reload` | `200 {"ok":true,"version","hash","changed","diff","resetOverrides","warnings"}` / `422 config_invalid` (`details.errors`) – atomar, bei Fehler bleibt die aktive Konfiguration |

### System-Ressourcen (seit 0.4.0)

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/system/metrics?since=<ISO>&range=<Dauer>&points=<n>` | `{"enabled", "intervalMs", "retentionMs", "bucketMs", "samples":[Sample]}` – Messpunkte des Ressourcen-Monitors (älteste zuerst). `since`: nur jüngere; `range` (z. B. `15m`, `1h`, `3600000ms`): nur die letzte Zeitspanne (mit `since`: der spätere Beginn gilt). `points` (10–2000, Default 600): höchstens so viele Punkte – bei mehr Messpunkten Mittelwerte je Zeitfenster (`bucketMs`; sonst `null`; benannte fremde Gruppen je Fenster auf 6 begrenzt, Rest in „Others“). `enabled: false` (`monitoring.enabled: false`) → `samples: []`. Schreibgeschützt, Host-/Origin-Regeln wie alle GET-Endpunkte; ungültige Parameter → `400 invalid_request` |

Sample:
```json
{"at":"2026-10-19T10:00:30.000Z",
 "cpu":{"totalPercent":46.2,"cores":8,"load":[2.1,1.8,1.5]},
 "memory":{"totalBytes":17179869184,"availableBytes":6442450944},
 "disks":[{"path":"/var/lib/adispatchd","freeBytes":52613349376,"totalBytes":214748364800}],
 "processes":[
   {"kind":"daemon","label":"adispatchd","cpuPercent":0.6,"rssBytes":96944128,"count":1},
   {"kind":"run","label":"coder · 1a2b3c4d · project_a:12","runId":"run-…-1a2b3c4d","workflowId":"coder","itemKey":"project_a:12","cpuPercent":98.0,"rssBytes":412000000,"count":4},
   {"kind":"hooks","label":"adispatchd (hooks/checks)","cpuPercent":1.5,"rssBytes":8000000,"count":2},
   {"kind":"other","label":"node ×3","name":"node","cpuPercent":37.2,"rssBytes":300000000,"count":3},
   {"kind":"rest","label":"Others","cpuPercent":120.6,"rssBytes":6937321472,"count":728}]}
```
- `cpu.totalPercent`: Auslastung aller Kerne seit der vorigen Messung (0–100). `processes[].cpuPercent`: 100 = ein Kern
  (Rate der CPU-Zeit aus `ps`, unter Linux über mindestens 60 s); im Diagramm ÷ `cores`. Der Rest bis `totalPercent` ist „System / unattributed“.
- `kind`: `daemon` (eigene PID), `run` (Prozessgruppe/Prozessbaum des Workers; Container-Runs zusätzlich `<engine> stats`),
  `hooks` (andere Kindprozesse des Daemons: Shell-Actions, Conditions), `other` (fremde Prozesse, nach Namen gruppiert, die
  `monitoring.top_processes` größten über `min_cpu_percent`), `rest` (übrige fremde Prozesse).
- Nur Befehlsnamen (`ucomm`, an der ersten Leerstelle abgeschnitten, gekürzt), **nie Argumente**. Konnte die Prozessliste nicht gelesen werden, ist
  `processes` leer. Werte liegen nur im Speicher (gehen beim Neustart verloren).
### Dashboard-Infos (seit 0.4.0, WI-24)

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

### UI-Aktionen als Identity (seit 0.4.0, WI-27)

![Item-Panel der Web-UI](https://raw.githubusercontent.com/brokoskokoli/adispatchd/main/docs/screenshots/item-panel.png)

Ein angemeldeter Benutzer mit Rolle `admin` kommentiert ein Issue/PR, setzt/entfernt Labels oder ändert Projektfelder
**als eine konfigurierte Identity** (z. B. eine GitHub App) – nicht als er selbst. Voraussetzungen, alle serverseitig
geprüft (in dieser Reihenfolge nach Host/CSRF/Rolle):

1. `auth.mode` ≠ `none`, sonst `403 ui_actions_disabled`.
2. Echte Anmeldung (`via` `password` oder `trusted_header`). Der lokale **Steuer-Token** der CLI wird abgewiesen
   (`403 user_login_required`): Worker laufen als derselbe Dienstbenutzer und könnten ihn lesen.
3. Die Identity hat in `identities.yaml` `ui_actions: true`, sonst `403 identity_not_allowed`.
4. Die Source existiert (`404 source_not_found`) und das Item gehört zu ihr: `:item` ist die Nummer (ohne führende Nullen),
   das Item wird frisch gelesen; fremde/verschobene Items → `404 item_not_found`.

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| GET | `/api/v1/items/resolve?ref=` | – | `{"source","item"}` für eine URL, `owner/repo#nr` oder `<source>:<nr>`; eine bloße Nummer passt bei mehreren Sources nicht (`400 ambiguous_item_ref`) |
| GET | `/api/v1/items/:source/:item` | – | `{source, itemId, key, url, type, repository, title, state, labels, project: {owner, number, fields:[{name, kind, known, value, reason, choices, problem}], error} \| null, availableLabels \| null, labelsError, identities:[{id, type}], recentActions:[…]}` – `choices` = Optionen (single_select) bzw. Iterationen (iteration) aus den Projektmetadaten; `identities` = nur die freigeschalteten |
| POST | `/api/v1/items/:source/:item/comment` | `{"identity","body"}` (Markdown, 1–65 536 Zeichen, gemessen am gesendeten Text) | `{"comment":{"id","url"},"action":{…}}` |
| POST | `/api/v1/items/:source/:item/labels` | `{"identity","add":[],"remove":[],"create":false}` (je ≤ 50 Namen à ≤ 50 Zeichen) | `{"changed","applied":{labelsAdded, labelsRemoved},"action"}`; ein Name in `add`, den das Repository nicht kennt → `400 label_not_found` (`details.labels`), außer mit `create: true` (GitHub legt das Label dann an) |
| POST | `/api/v1/items/:source/:item/project` | `{"identity","fields":{"Status":"Review","Notes":null}}` | `{"changed","applied":{projectFields, projectItemAdded?},"action"}` |
| GET | `/api/v1/ui-actions?source=&item=<key>&limit=&offset=` | – | `{"enabled","identities","actions":[…],"total","limit","offset"}` (neueste zuerst); mit `auth.mode: none` `403 ui_actions_disabled` |

- **Kommentare werden nie still verändert.** Sieht der Text nach einem Secret aus, antwortet die API
  `400 comment_contains_secret` (Meldung und `details.findings` nennen nur Art und Anzahl, nie den Wert) und sendet nichts.
  Erkannt werden – **best effort**, keine Garantie – dem Daemon bekannte Werte (Installation-Tokens, Keys, Token-Identities)
  sowie die Formate GitHub-Token (`ghp_…`, `gho_…`, `github_pat_…`, …), Anthropic-Key (`sk-ant-…`), AWS-Access-Key-ID
  (`AKIA…`), Slack-Token (`xox?-…`) und PEM-Private-Keys (schon die `BEGIN`-Zeile). Die UI warnt schon beim Tippen.
- **HTML-Kommentare** werden wie bei Orchestrator-Kommentaren entschärft (`<!--` → `&lt;!--`): ein UI-Kommentar kann keinen
  Idempotenz-Marker (`<!-- adispatchd:… -->`) vortäuschen. Die 65 536 Zeichen gelten für den so gesendeten Text
  (`400 comment_too_long`).
- **Kein Doppelpost:** gesendet ohne Marker und **nie automatisch wiederholt** – auch nicht nach Rate-Limit oder Timeout.
  Derselbe Text desselben Benutzers am selben Item innerhalb von 60 s → `409 duplicate_comment` (nach einem eindeutigen
  Fehlschlag sofort wieder erlaubt). Nach einem Fehler, bei dem der Kommentar angekommen sein kann, antwortet die API
  `502 github_outcome_unknown`; vor einem erneuten Senden auf GitHub nachsehen.
- **Rate-Limit je Benutzer:** höchstens 20 Aktionen (Kommentar, Labels, Projektfelder) und 60 Item-Abrufe
  (`GET /items/…`, Resolve) pro Minute, sonst `429 ui_actions_throttled` mit `Retry-After`.
- **Labels** und **Projektfelder** nutzen den `source.update`-Pfad: erst lesen, dann nur Abweichendes schreiben
  (wiederholbar, idempotent). Projektfelder werden gegen `project.fields` der Source geprüft (`400 project_not_configured`,
  `400 invalid_project_fields` mit `details.problems`), Optionen/Iterationen wie bei `source.update` aufgelöst (unbekannte
  Option → `422 github_rejected`), `null` leert ein Feld. Geschrieben wird **genau mit der gewählten Identity**, auch wenn
  die Source ein `project.identity` hat.
- **GitHub-Fehler:** `502 github_forbidden` (App-Rechte fehlen, Unterhaltung gesperrt), `502 github_auth_failed`,
  `404 github_not_found`, `429 github_rate_limited` (mit `Retry-After`), `502 github_unavailable`, `422 github_rejected`.
  GitHubs 401/403 werden bewusst nicht als 401/403 weitergereicht.
- **Audit** (Tabelle `ui_actions`, Schema v4): jede Aktion ab Schritt 3, auch fehlgeschlagene – `id, createdAt, actor,
  actorVia, identity, sourceId, itemId, itemKey, itemUrl, kind (comment|labels|project), result
  (succeeded|failed|unknown), errorCode, errorMessage, commentId, commentUrl, details` (Labels bzw. Feldwerte; bei
  Kommentaren nur die Länge, **nie der Text**; Labelnamen und Feldwerte maskiert wie Secrets). Aufbewahrung:
  `retention.ui_actions` (Default 365 Tage), unabhängig vom Ergebnis. Zusätzlich die Log-Zeilen `api write` und `ui action`.
  Scheitert nur das Protokollieren nach einer erfolgreichen Änderung auf GitHub, antwortet die API trotzdem 2xx mit
  `"action": null, "auditWarning": "…"` (und loggt den Fehler) – nie 500 für eine ausgeführte Aktion.

### Notifications

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/api/v1/notifications?state=pending\|delivered\|failed&limit=&offset=` | `{"notifications":[{id, eventType, payload, deliveryState, attempts, lastError, nextAttemptAt, createdAt, deliveredAt, deliveries:[{channelId, state, attempts, lastError, lastStatus, nextAttemptAt, deliveredAt}]}], "counts"}` |
| POST | `/api/v1/notifications/:id/retry` | `202 {"notification","requeued"}` – fehlgeschlagene Zustellungen erneut einreihen |

Webhook-Body (JSON-POST, Timeout 10 s, bis zu 6 Versuche mit Backoff 5 s/30 s/2 min/10 min/30 min, 4xx außer 408/429 nicht wiederholt):
`{"source":"adispatchd","id":1,"event":"retry_block_created","createdAt":"…","text":"[adispatchd] …","payload":{…}}`
(`text` macht ihn Slack-kompatibel). Ereignisse: `retry_block_created`, `lifecycle_action_failed`, `recovery_failed`
und ab 0.6.0 optional `retry_block_cleared` (Payload `blockId, workflowId, itemKey, failureCount, clearedAt, clearedBy,
runId`; nur, wenn in `notifications.on` eingetragen).

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
| `run.event` | ja | RunEvent `{id, runId, sequence, timestamp, origin: worker\|orchestrator, type, payload}`; `type` u. a. `run.status` (`{from,to,target?,outcome?,hook?,blockId?}`; `outcome`/`hook` beim Übergang nach `finalizing`), `run.outcome_warning` (`{code: invalid_outcome|unmatched_outcome, message, outcome?, hook?}`), Worker-`status`/`progress`/…, `diagnostic.*`, `lifecycle.action`, `lifecycle.chain`, `run.spawn`, `run.cancel_requested`, `recovery.*`, `run.kept_files`, `workspace.cleanup`, `audit.user_action` (WI-26) |
| `run.output` | nein | `{runId, stream: stdout\|stderr, data, at}` (Live-Log, redigiert; per REST nachladen) |
| `run.action` | nein | Action-Journal-Eintrag nach Änderung |
| `block.created` / `block.cleared` | nein | Block |
| `system.status` | nein | `{ready, paused, draining, stopping, activeRuns}` |
| `system.ready` | nein | `{ready:true}` nach Recovery |
| `notification` | nein | Notification inkl. `deliveries` (bei Anlage und jedem Zustellversuch) |
| `config.reloaded` | nein | `{version, hash, changed, diff, resetOverrides}` |
| `retention.finished` | nein | `{finishedAt, deletedRuns, errors}` |
| `system.metrics` | nein | neuester Messpunkt des Ressourcen-Monitors (Sample wie bei `GET /api/v1/system/metrics`), je Intervall; nicht bei `?run=` |
| `workflow.conditions` | nein | `{workflowId}` – der letzte Status einer Workflow-Condition oder die Item-Check-Zusammenfassung hat sich geändert (seit 0.4.0); Details per `GET /api/v1/workflows/:id` |
| `dashboard.info` | nein | `InfoTile` nach jeder Änderung (Abruf gestartet/fertig, Wert, Status; seit 0.4.0) |

- **Reconnect:** `EventSource` sendet `Last-Event-ID` automatisch; alternativ `?lastEventId=`. Verpasste persistente
  Events werden aus SQLite nachgeliefert (max. 5000, sonst `stream.reset`), danach live – ohne Lücken/Duplikate.
  Nicht persistente Events gehen bei einem Abbruch verloren → Zustand per REST nachladen.
- `?run=<id>`: nur Events dieses Runs (plus `system.status`).
- Heartbeat-Kommentar `: heartbeat …` alle 15 s; `retry: 3000`.
- Langsame Clients: mehr als 1 MiB ungesendete Daten → Verbindung wird getrennt (Client reconnectet mit `Last-Event-ID`);
  die Logerfassung wird nie blockiert.
