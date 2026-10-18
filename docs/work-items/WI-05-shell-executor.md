# WI-05 – Shell-Executor, Worker-Protokoll, Prozess-Supervision

**Spec:** §8.2, §8.3, §9, §13, §20 · **Abhängig von:** 01 · **Branch:** `wi-05-shell-executor` · **Verzeichnis:** `src/executors/`

## Umfang
1. **Spawn** mit eigener Prozessgruppe (`detached: true`), Argumentliste, `cwd` = Workspace, **Minimal-Env** (`PATH`, `HOME`, `LANG`, `TZ`, `USER`/`LOGNAME`, `TMPDIR`) + deklarierte `env` + `ADISPATCH_*` (§9.1) + aufgelöste Secrets; keine Vererbung der Controller-Env. Spawnfehler → `start_error`.
2. **Workspace** anlegen (über `resolveWithin`), `context.json` (§9.1, ohne Secrets) schreiben, `ADISPATCH_RESULT_FILE`-Pfad unter `data-dir/runs/<run-id>/result.json`.
3. **Logs**: stdout/stderr getrennt als Dateien `logs/<run-id>/{stdout,stderr}.log`, unverändert; Größenlimit pro Run (§5.1) → danach nicht mehr schreiben, aber Trunkierungsereignis melden; Schreibfehler als Fehlerereignis melden statt Vollständigkeit zu behaupten (§12). Backpressure: Logerfassung darf nicht von Konsumenten (SSE) blockiert werden – Listener asynchron/entkoppelt.
4. **Event-Parser**: Zeilen mit Präfix `@@ADISPATCH_EVENT ` → JSON parsen, Schema `{type: string, ...}`, Größenlimit; gültige Events via Callback; ungültige → Parser-Warnung; Rohzeile bleibt im Log. Zeilenpuffer über Chunk-Grenzen; stdout und stderr.
5. **Best-effort Secret-Redaction** in persistierten Logs für bekannte Secret-Werte (Grenzen dokumentieren, §24.8).
6. **Ergebnis-Klassifikation** exakt nach Tabelle §8.2 als reine Funktion `classifyOutcome(...)`: Exit 0 + gültig success/failure; Exit 0 ohne Datei → success; Exit 0 + ungültig → `crashed` (Protokollfehler); ≠0 → `crashed`; Signal → `crashed` außer Cancel/Timeout; Spawnfehler → `start_error`; Timeout → `timed_out`; Cancel → `cancelled`. Result-JSON-Schema (§9.2, `schema_version: 1`, `result`, `message?`, `details?`, `artifacts?`) mit Größenlimit.
7. **Timeouts**: `max_duration`, `idle_timeout` (Reset bei jeder Ausgabe/Event) → SIGTERM an Gruppe, nach Grace SIGKILL.
8. **Cancel**: SIGTERM an Gruppe → Grace → SIGKILL → Prozessende abwarten/bestätigen; erst dann Outcome liefern. Wenn Beenden misslingt → Outcome nicht als beendet melden (Fehler/Status „kill_failed“).
9. **Prozess-Startidentität** (§13): Linux `/proc/<pid>/stat` Feld 22 (starttime) + Boot-ID; macOS via `ps -o lstart= -p <pid>`. Funktionen `getStartIdentity(pid)`, `isSameProcess(pid, identity)`, `killProcessGroupIfSame(pgid, identity, signal)` – bei unsicherer Identität **niemals** signalisieren.
10. Implementiert das `Executor`-Interface aus `src/core`.

## Acceptance Criteria
- [ ] Alle Zeilen der Tabelle §8.2 als Unit-Tests von `classifyOutcome` und als Prozess-Tests mit echten Shell-Skripten.
- [ ] Child-Prozesse (`sleep` im Hintergrund in der Gruppe) werden bei Cancel und Timeout mit beendet (Test).
- [ ] Idle-Timeout greift; Ausgabe setzt ihn zurück (Test, kurze Zeiten).
- [ ] Worker sieht keine Controller-Env-Variable, die nicht deklariert ist (Test).
- [ ] Event-Zeilen über Chunk-Grenzen korrekt; ungültige Events erzeugen Warnung (Test).
- [ ] Log-Limit: Trunkierungsereignis, kein stilles Überschreiben (Test).
- [ ] Startidentität: anderer Prozess mit gleicher PID (simuliert) wird nicht getötet (Test via Identitätsabweichung).
- [ ] Läuft auf macOS und Linux (plattformspezifische Teile gekapselt).
