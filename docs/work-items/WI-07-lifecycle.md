# WI-07 – Lifecycle-Aktionen, Action-Journal, Retries

**Spec:** §10, §18 · **Abhängig von:** 03, 05, 06 · **Branch:** `wi-07-lifecycle` · **Verzeichnis:** `src/lifecycle/`

## Umfang
1. `LifecycleEngine.runHook(run, hookName, snapshot, context)`: legt Journal für alle Actions des Hooks an (stabile ID, Ordinal, `action_config_json`), führt sequenziell aus.
2. Action-Typen: `source.update`, `source.comment` (Platzhalter-Interpolation `text`-Modus mit Run/Result-Kontext, Marker für Idempotenz), `shell` (über Shell-Check-/Executor-Infrastruktur, Minimal-Env, Run-/Result-Kontext als JSON-Datei, Timeout). Identity-Auflösung: Action → Workflow → Source.
3. Retry pro Action: Default aus `lifecycle.action_retry` (3 Versuche, 30 s), Override pro Action; jeder Versuch in `action_attempts` (Zeit, Fehler, externe Referenz). Delay über Clock/Timer-Abstraktion (testbar ohne echtes Warten).
4. Nach erschöpften Versuchen: Action `failed`; ohne `continue_on_error` stoppt die Kette (restliche bleiben `pending`), Run-`lifecycle_status = failed`, Notification-Event `lifecycle_action_failed` auslösen (Interface/Callback; Zustellung in WI-10). Mit `continue_on_error` → weiter.
5. **Idempotenz vor Wiederholung**: Für `source.comment` vor jedem erneuten Versuch `findCommentByMarker`; gefunden → `succeeded` mit `external_key`. Bei unklarem Ausgang (Timeout/Netzfehler nach Senden) diesen Weg nutzen.
6. **Manueller Retry** (`retryAction(actionId)`) und **Fortsetzung der Kette** ab der fehlgeschlagenen Position; bereits `succeeded` Actions werden nie erneut ausgeführt; Haupt-Worker wird nicht neu gestartet.
7. **Recovery-Unterstützung**: `resumeIncomplete(run)` setzt `running`-Actions nach Neustart in einen sicheren Zustand (Comment: Marker-Abgleich; Update: Neu-Lesen + idempotent erneut) und setzt die Kette fort.
8. Hook-Ausführung nutzt immer den **Konfigurationssnapshot des Runs** (§12, §19), nicht die aktuelle Config.

## Acceptance Criteria
- [ ] Szenario 6: Kommentar scheitert vorübergehend → wird wiederholt, Worker läuft nicht erneut; endgültiger Fehler stoppt Kette, manueller Retry setzt fort (Test mit Fake-GitHub).
- [ ] `continue_on_error` lässt nachfolgende Actions laufen (Test).
- [ ] Neustart-Simulation: `succeeded` Actions werden nicht wiederholt; `running` Comment mit vorhandenem Marker wird nicht dupliziert (Test).
- [ ] Shell-Action bekommt Result-Kontext, aber keine Controller-Env (Test).
- [ ] Platzhalter `{result.message}` etc. korrekt, unbekannte abgelehnt (bereits durch Config-Validierung, hier Laufzeit-Test).
