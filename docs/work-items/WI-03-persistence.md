# WI-03 – Persistenz: SQLite, Migrationen, Repositories, Instanz-Lock

**Spec:** §12, §11, §21, §4 · **Abhängig von:** 01 · **Branch:** `wi-03-persistence` · **Verzeichnis:** `src/persistence/`

## Umfang
1. `openDatabase(dataDir)` mit `node:sqlite` (`DatabaseSync`), `PRAGMA foreign_keys=ON`, WAL, `busy_timeout`.
2. Versionierte Migrationen (`schema_migrations`); **vor** Anwendung neuer Migrationen Backup nach `data-dir/backups/orchestrator-<version>-<ts>.sqlite` (nur wenn DB bereits existiert und Migrationen ausstehen).
3. DDL für alle Tabellen aus §12 inkl. Indizes und Fremdschlüssel; zusätzlich `runs.lifecycle_status`, `runs.status_message` (letzte Event-Statusmeldung), `runs.identity`, `runs.command`, `runs.result_json`, `runs.error_json`, `runs.block_generation`; `run_logs_meta` o. ä. für Log-Trunkierungs-/Schreibfehler-Ereignisse (oder als `run_events` Typ `system`). `blocks` mit `generation`; `failure_counters` oder Ableitung aus Runs (Zählung aufeinanderfolgender technischer Fehler pro `(workflow_id, item_key)` seit letztem Erfolg/Entblockung – Design im Handoff begründen).
4. Repositories (synchron, klar typisiert):
   - `RunRepository`: `reserve(...)` **atomar** in einer Transaktion: Lock prüfen+anlegen (Unique `(workflow_id, lock_key)`), Run mit `reserved` anlegen; schlägt fehl, wenn aktiver Lock existiert. Transitionen mit erlaubter Zustandsmaschine (§8.1) – ungültige Transition = Fehler. `finish(...)` setzt Endstatus, Ergebnis, gibt Lock frei. Abfragen: aktive Runs, Historie mit Paging/Filter, `countActive(workflowId?)`, letzter Run je Item (für Views `run.last_*`).
   - `EventRepository`: `append(runId, type, payload)` mit monotoner `sequence` pro Run und globaler Event-ID (für SSE `Last-Event-ID`), `listSince(globalId)`, `listForRun`.
   - `ActionRepository`: Action-Journal anlegen (alle Actions eines Hooks mit Ordinal, `pending`), Statuswechsel, Versuche (`action_attempts`), `external_key`, `listFailed()`.
   - `BlockRepository`: `create`, `clear(id)` (setzt `cleared_at`, erhöht Generation → neue Zählperiode), `activeFor(workflowId, itemKey|null)`, `listActive()`; Technischer-Fehler-Zähler (`consecutiveTechnicalFailures(workflowId, itemKey)`).
   - `NotificationRepository`, `CronFiringRepository` (Unique `(workflow_id, scheduled_for)`).
5. Lock-Schlüssel für sourcefreie Runs: Cron → `cron:<scheduled_for>` bzw. Workflow-Scope; Manual ohne Item → eindeutiger Schlüssel pro Run (kein Lock-Konflikt) – Semantik im Handoff dokumentieren.
6. **Instanz-Lock** pro data-dir (§21): exklusive Sperre, die bei Prozessende automatisch fällt (z. B. Lockfile mit PID + Startidentität + Prüfung, oder `O_EXCL` + Stale-Erkennung, die nie zwei Instanzen zulässt). Ansatz begründen, Tests für „zweite Instanz wird abgelehnt“ und „stale Lock nach totem Prozess wird übernommen“.
7. Retention-Abfragen (Kandidaten zum Löschen nach Kategorie/Alter, Schutz für aktive Runs, offene Blocks, unfertige Aktionsketten) – nur Datenzugriff; Ausführung in WI-10.

## Acceptance Criteria
- [ ] Migration auf leerer DB und erneuter Start idempotent; Backup bei ausstehender Migration (Test mit künstlicher Migration v2).
- [ ] Zweiter `reserve` für gleichen `(workflow, item)` schlägt fehl, solange erster aktiv; nach `finish` wieder möglich (Test).
- [ ] Unterschiedliche Workflows dürfen dasselbe Item gleichzeitig reservieren (Test).
- [ ] Ungültige Statusübergänge werden abgelehnt (Test).
- [ ] Zähler technischer Fehler: `failure` und `cancelled` zählen nicht, Erfolg/Entblockung setzt zurück (Test).
- [ ] Event-IDs global monoton, `listSince` liefert verpasste Events (Test).
- [ ] Instanz-Lock-Tests grün.
- [ ] Retention-Abfragen schützen aktive Runs/offene Blocks/unfertige Ketten (Test).
