# WI-41 – Drain über API, CLI, UI und Hub ohne Frist

**Herkunft:** Fehler im Betrieb (15. November 2026), Fix vom Maintainer freigegeben · **Abhängig von:** `main` (0.11.0) · **Branch:** `wi-41-unbounded-api-drain` · **Zielversion:** nächster Patch (Fehlerbehebung; kein DB-Schema-Wechsel, kein neues Format)

## Problem

Ein Drain über den Hub (`hub drain-all`, `hub workspace drain <id>`, UI „Drain all“) soll laut Code und Doku **ohne
Frist** warten, bis die aktiven Runs fertig sind (`docs/api.md`: „Drain ohne Frist“, `docs/operations.md`:
`adispatch drain --wait` „beliebig lange, ohne Timeout“). Tatsächlich bricht er nach `--drain-timeout` ab:

- Der Hub startet jeden Workspace mit `--drain-timeout …`.
- `POST /api/v1/shutdown/drain` ruft `deps.shutdown('drain')`; `createApp` setzt dann `drainTimeoutMs:
  options.drainTimeoutMs`, sobald eine Frist konfiguriert ist („without a deadline unless one was configured“). Unter
  dem Hub ist immer eine konfiguriert, ebenso bei einer Einzelinstanz unter systemd (`service install` schreibt
  `--drain-timeout` immer in die Unit).
- Beobachtet am 15. November 2026: `hub.drain-all`, danach im Workspace-Log `shutting down mode=drain
  drainTimeoutMs=600000`, zehn Minuten später `drain timeout exceeded, cancelling remaining runs`; ein laufender
  Agent-Run wurde abgebrochen.

Damit gibt es keinen Weg, eine Instanz unter systemd oder dem Hub vor einem Update geordnet leerlaufen zu lassen.

## Entscheidungen

1. **Ein angeforderter Drain hat keine Frist.** `POST /api/v1/shutdown/drain` (und damit `adispatch drain`, UI
   „Drain“, `hub workspace drain`, `hub drain-all`, Hub-UI „Drain all“) wartet ohne Frist auf die aktiven Runs.
   `--drain-timeout` gilt **nur** für den Signal-Pfad: SIGTERM/SIGINT bzw. `systemctl stop|restart`, und damit für
   `hub workspace restart` und den Hub-Shutdown (beide über SIGTERM, unverändert).
2. **Die Cancel-Phase bleibt begrenzt** (`--cancel-timeout`), wie bisher; sie tritt nach einem API-Drain nur ein, wenn
   jemand eskaliert (Cancel-All, SIGTERM).
3. **Eskalation unverändert:** Ein späterer Shutdown verschärft nur. SIGTERM während eines API-Drains setzt die Frist
   (ab dem Signal). Ein API-Drain während eines Signal-Drains verlängert dessen Frist nicht und hebt sie nicht auf
   (er bringt keine Drain-Frist mit; `minDefined` behält die bestehende) und verschärft nichts (gleiche Cancel-Frist
   wie das Signal).
4. **Der Hub killt einen Drain nicht nach Zeit.** `drain`/`drain-all` über die Steuer-API setzen keinen SIGKILL-Timer.
   Antwortet die Steuer-API eines Workspaces nicht sofort (z. B. Startphase, kurz überlastet), versucht der Hub sie
   für einen Drain einige Male erneut, bevor er – wie bisher – auf SIGTERM zurückfällt; nur dieser Rückfall ist
   (wie jeder Signal-Drain) durch `--drain-timeout` begrenzt und wird als Warnung geloggt.

## Umfang

- `src/app.ts`: API-Drain ohne `drainTimeoutMs`; Kommentar und Doku der Option `drainTimeoutMs` (nur Signal-Pfad).
- `src/hub/supervisor.ts`: Wiederholung der Steuer-API für `drain` vor dem Signal-Rückfall; kein Kill-Timer für einen
  Drain über die API.
- CLI-Hilfetexte prüfen (`--drain-timeout` nennt bereits nur SIGTERM/SIGINT).
- Doku: `docs/api.md`, `docs/operations.md`, Spec-Nachtrag (§14), `CHANGELOG.md` (Unreleased, Behoben),
  `docs/status.md`, `docs/handoff/WI-41.md`; README EN/DE nur, wenn dort etwas Falsches steht.

## Nicht Teil davon

- Eine eigene, frei wählbare Frist für den API-Drain (`--timeout` von `drain --wait` begrenzt nur das Warten der CLI).
- Änderungen am Signal-Pfad, an `TimeoutStopSec` oder an `hub workspace restart`.

## Acceptance Criteria

1. Eine Instanz mit konfiguriertem `drainTimeoutMs` (CLI `--drain-timeout`) bricht nach `POST /api/v1/shutdown/drain`
   einen Run, der länger als die Frist läuft, **nicht** ab; sie endet mit Exit 0 und Ergebnis `drained`, sobald der Run
   fertig ist (Test, vor dem Fix rot).
2. SIGTERM ohne vorherigen Drain drainiert weiterhin höchstens `--drain-timeout` lang und bricht dann ab (Test).
3. SIGTERM während eines API-Drains begrenzt ihn ab dem Signal auf `--drain-timeout` (Test).
4. Ein API-Drain während eines SIGTERM-Drains hebt dessen Frist nicht auf und verlängert sie nicht (Test).
5. Der Hub-Supervisor sendet nach einem `drain` über die Steuer-API auch weit nach Drain- + Cancel-Frist + Grace kein
   Signal an den Workspace (Test); antwortet die API zunächst nicht, wird sie für einen Drain erneut versucht, und erst
   danach fällt der Hub auf SIGTERM zurück (Test).
6. Ende-zu-Ende mit echten Prozessen: `hub drain-all` mit einem `--drain-timeout`, der kürzer ist als die Runs, lässt
   die Runs zu Ende laufen (Hub-E2E).
7. Doku (API, Betrieb, Spec-Nachtrag, CHANGELOG, Status, Handoff) beschreibt das Verhalten; `npm run check` grün.
