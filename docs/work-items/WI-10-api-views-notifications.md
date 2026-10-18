# WI-10 – HTTP-API, SSE, Views, Notifications, Retention, App-Bootstrap

**Spec:** §15, §17, §18, §21 · **Abhängig von:** 09 · **Branch:** `wi-10-api` · **Verzeichnisse:** `src/api/`, `src/views/`, `src/notifications/`, `src/app.ts`

## Umfang
1. **App-Bootstrap** `src/app.ts`: `createApp({configDir, dataDir})` verdrahtet Instanz-Lock → DB/Migration → Config → Adapter/Identities → Executor → Lifecycle → RunController (Recovery) → Scheduler → Retention → Notifications → HTTP. Sauberes `stop()`. SIGTERM/SIGINT-Handling (Drain mit Timeout, dann Cancel-All).
2. **Fastify-API** unter `/api/v1` – alle Endpunkte aus §15 inkl. `/health`, `/ready`. Validierung von Request-Bodies (zod), konsistente Fehlerform `{error:{code,message,details?}}`, 409 bei Lock-Konflikt. Logs-Endpunkt mit Offset/Limit pro Stream (stdout/stderr), Tail-Modus; nie ganze 100-MB-Datei. Run-Details inkl. Input-JSON, Result-JSON, Actions, Events. Keine Secrets in Antworten.
3. **Sicherheit**: Default-Bind `127.0.0.1`; Warnung im Log bei Nicht-Loopback-Bind; CSRF-Schutz für mutierende Requests (z. B. Pflicht-Header `X-Adispatch-Request: 1` + Content-Type JSON + Origin/Host-Prüfung), kein permissives CORS.
4. **SSE** `/api/v1/events` (optional `?run=<id>`): Events mit `id`, `type`, Zeit, Payload; `Last-Event-ID` → verpasste persistente Events aus DB nachliefern; Heartbeat; langsame Clients bekommen begrenzten Puffer und werden getrennt statt Logerfassung zu blockieren. Log-Chunks live (nicht persistent – UI lädt per REST nach).
5. **Views** (`src/views/`): Items aus mehreren Sources gleichen Typs laden, deklarativ filtern (WI-04-Evaluator, keine Shell), Spalten inkl. `run.last_workflow`, `run.last_status`, `run.last_result.message`, `run.last_finished_at` per Item-Key aus DB anreichern, Sortierung, Link-Spalten, kurzer Cache (z. B. 30 s), fehlende Felder leer.
6. **Notifications** (`src/notifications/`): Events `retry_block_created`, `lifecycle_action_failed`, `recovery_failed` → Persistenz (`notifications`) → asynchrone Zustellung an Webhook-Kanäle (JSON-POST, Timeout, Retries mit Backoff), Zustellstatus speichern, URLs/Header redigiert in Logs/API. Darf Orchestrierung nie blockieren.
7. **Retention** (`src/runs/retention.ts` oder `src/persistence`): periodisch (`cleanup_interval`) Logs/Run-Dateien/Workspaces/DB-Zeilen gemäß Kategorien löschen; Schutzregeln (WI-03).
8. API-Tests mit `fastify.inject`; ein E2E-Test: App mit Beispiel-Config + Fake-GitHub + Shell-Skript startet, Run läuft durch, SSE liefert Events, Reconnect mit `Last-Event-ID`.

## Acceptance Criteria
- [ ] Alle Endpunkte aus §15 existieren und sind getestet (mind. Happy-Path + ein Fehlerfall).
- [ ] SSE-Reconnect liefert verpasste Events (Test).
- [ ] Szenario 10: View kombiniert zwei Repos, zeigt letzten Run/Result + Link (Test).
- [ ] Notification-Webhook-Ausfall blockiert keinen Run; Zustellversuche gespeichert (Test).
- [ ] Mutierende Requests ohne CSRF-Header werden abgelehnt (Test).
- [ ] `/ready` erst nach Recovery true (Test).
- [ ] Retention löscht alte erfolgreiche Runs, schont offene Blocks/aktive Runs (Test).
