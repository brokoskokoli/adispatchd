# WI-08 – Run-Controller, Ergebnisse, Retry-Blocks, Recovery, Shutdown

**Spec:** §8, §11, §13, §14 · **Abhängig von:** 02–07 · **Branch:** `wi-08-run-controller` · **Verzeichnis:** `src/runs/`

## Umfang
1. `RunController.startRun(request)` wobei `request` = reservierter Run (vom Scheduler oder manuell): Snapshot persistieren → bei Source-Workflows Item neu lesen (§7 Rennen) → `starting` → `on_start` → Workspace/Kontext → Executor starten (`running`, pid + Startidentität persistieren) → Events/Statusmeldung persistieren → Outcome klassifizieren → `finalizing` → passenden Hook (`on_success|on_failure|on_crash|on_start_error|on_timeout|on_cancel`) → Endstatus + `business_result` → Lock freigeben. Jede Transition persistiert vor Weiterarbeit.
   - Reihenfolge/Semantik bei `on_start`-Fehler (Kette gestoppt): Worker **nicht** starten, Run als `start_error` behandeln (Entscheidung im Handoff begründen).
2. **Technische Fehler & Blocks** (§11): bei `crashed|start_error|timed_out` Zähler erhöhen; bei Erreichen `max_technical_failures` Block **in derselben Transaktion** wie den Endstatus anlegen, dann erst Hook ausführen. Notification `retry_block_created`. `failure`/`cancelled` zählen nicht; `success` setzt zurück. `clearBlock(id)` → neue Zählperiode.
3. **Cancel** (§13): `cancelRun(id)` → `cancelling` → Executor-Cancel → nach bestätigtem Ende `on_cancel` → `cancelled`. Misslingt Beenden → nicht als beendet markieren, Fehler sichtbar.
4. **Workspace-Cleanup** nach Abschluss gemäß `workspace.cleanup` (`always|on_success|never`), nur innerhalb `base_dir`.
5. **Recovery beim Start** (§14, Variante A): vor Scheduler-Freigabe alle Runs in aktiven Zuständen laden; noch lebende Prozessgruppen mit **verifizierter Startidentität** beenden; verschwundene/beendete → `crashed` (Zähler/Block), `on_crash` ausführen; nicht identifizierbare/nicht beendbare → `recovery_pending` + Recovery-Fehler + Notification `recovery_failed`, Lock bleibt bestehen (kein Doppelstart). Unvollständige Action-Ketten via `LifecycleEngine.resumeIncomplete`. Readiness-Flag erst danach.
6. **Shutdown-Modi** (§14): `pause()/resume()` (Flag für Scheduler), `drain()` (keine neuen Starts, auf aktive Runs warten, dann Stop-Callback), `cancelAllAndShutdown()`. SIGTERM-Verhalten: Standard = Drain mit konfigurierbarem Timeout, danach Cancel-All (im Handoff mit Blick auf systemd `TimeoutStopSec` dokumentieren).
7. Event-Bus (in-process, typisiert) für Run-Transitionen, Events, Log-Chunks, Systemstatus – Konsument ist SSE in WI-10. Nicht-blockierend.

## Acceptance Criteria
- [ ] Szenario 4: `failure` → `on_failure`, Zähler unverändert (Test, Fake-GitHub + echtes Shell-Skript).
- [ ] Szenario 5: drei technische Fehler → Block; Block verhindert Reservierung durch Scheduler-API (`isBlocked`); Clear → neue Periode, Historie bleibt (Test).
- [ ] Block wird vor `on_crash` persistiert, sodass ein Hook, der das Label zurücksetzt, keinen Neustart auslöst (Test).
- [ ] Szenario 7: Cancel beendet Prozessgruppe, `on_cancel` läuft, kein Zähler (Test).
- [ ] Szenario 8: Simulierter Controller-Absturz (Run `running` in DB, Prozess lebt mit passender Identität) → Recovery tötet ihn, `on_crash`, Ready erst danach; Prozess mit falscher Identität wird nicht getötet → `recovery_pending` (Tests).
- [ ] Hooks nutzen Snapshot, auch wenn Config inzwischen geändert wurde (Test).
- [ ] Drain wartet auf aktive Runs; Pause verhindert nur neue Starts (Test).
