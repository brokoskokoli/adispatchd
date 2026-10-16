# WI-09 – Scheduler, Trigger (Source/Cron/Manual), Dry-Run

**Spec:** §5.5, §7, §19 · **Abhängig von:** 08 · **Branch:** `wi-09-scheduler` · **Verzeichnis:** `src/scheduler/`

## Umfang
1. **Polling-Loop** (Intervall aus Config, keine Überlappung, Fehler einer Source blockiert andere nicht): Planungsschritt §7 Punkte 1–8 exakt: pollen → normalisieren (`source-id,item-id,workflow-id`) → Prioritäten → aktive Locks & Blocks ausschließen → lazy teure Filter/Shell-Filter/Conditions → Slots prüfen (global + Workflow, **inkl. manueller Runs** in der Auslastung) → atomar reservieren → `RunController.startRun`. Nicht startfähige Kandidaten überspringen, ohne niedrigere zu blockieren. Keine persistente Kandidaten-Queue.
2. Workflow-Conditions einmal pro Planungsschritt (Cache), Item-Conditions pro Kandidat. `unknown` = nicht startfähig, Diagnose speichern (letzte Planungsdiagnose pro Workflow im Speicher für GUI/API).
3. Respektiert Pause/Drain und Readiness (Recovery fertig), Runtime-Overrides (`enabled`, `priority`, Limits).
4. **Cron-Trigger** (croner, Zeitzone): pro Termin höchstens ein Run; `cron_firings` mit Unique-Key; verpasste Termine (Downtime) werden **übersprungen** und als `skipped_missed` protokolliert, nicht nachgeholt; Termin bei Limit/Condition/Block → `skipped_*`. DST-Verhalten von croner testen und in `docs/cron-semantics.md` dokumentieren (§24.7).
5. **Manueller Start** `startManual(workflowId, {itemRef?, parameters?})`: Source-Workflow braucht Item-Referenz (URL/ID → Adapter `parseItemRef` + `getItem`); Parameter validieren (WI-02); **umgeht** Filter, Conditions, Blocks, Prioritäten, Limits, **nicht** den Lock → Konflikt-Fehler (409-fähig). Zählt zur Auslastung.
6. **Dry-Run** `dryRun(workflowId)`: Source-Abfrage, deklarative Filter inkl. Dependencies, Prioritäten, Locks/Blocks, Kapazität; Shell-Filter/Conditions **nicht** ausführen → `not_evaluated`; keine Reservierung, keine Actions. Ergebnis als strukturierte Liste (für CLI/API/GUI).
7. CLI `workflow dry-run <id>` verdrahten (lokal mit Config, ohne laufenden Server).

## Acceptance Criteria
- [ ] Szenario 1: zwei parallele Coder-Runs, dritter durch Workflow-Limit verhindert (Test, Fake-GitHub + Shell-Skript mit `sleep`).
- [ ] Szenario 2: manueller Start ignoriert Filter/Conditions/Limits/Block, scheitert aber an aktivem Lock (Test).
- [ ] Szenario 3 end-to-end: Dependency-Filter verhindert Start, nach Schließen des Blockers startet nächster Poll (Test).
- [ ] Szenario 9: Cron-Termin bei vollem Limit übersprungen, kein Rückstau (Test mit FakeClock).
- [ ] Gesperrter hoch priorisierter Kandidat blockiert nicht den nächsten (Test).
- [ ] Workflow-Priorität vor Item-Priorität (Test).
- [ ] Dry-Run führt keine Shell-Skripte aus (Test mit Marker-Datei).
