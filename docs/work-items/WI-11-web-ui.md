# WI-11 – Weboberfläche

**Spec:** §16 · **Abhängig von:** 10 · **Branch:** `wi-11-web-ui` · **Verzeichnis:** `src/ui/` (Quellen), Auslieferung über `@fastify/static`

## Umfang
1. Kleine SPA ohne schweres Framework und ohne Build-Kette außer `tsc` (Vanilla TS/ES-Module oder Preact via ESM ohne Bundler – im Handoff begründen); statische Dateien unter `src/ui/public/`, werden in `dist` kopiert.
2. Seiten gemäß §16: Dashboard (Scheduler-Status, Limit/Auslastung, Pause/Resume, Drain, Cancel All mit Bestätigung im UI, aktive Runs + letzte Statusmeldung), Runs (Liste aktiv/historisch, Detail mit allen Feldern aus §16, Logs mit Paging/Tail, Events, Actions, Cancel), Workflows (Status, Prio, Limits, Verbrauch, manueller Start mit Source-URL + Parameterformular aus Schema, Dry-Run-Anzeige mit `unknown/not evaluated`, Runtime-Overrides), Blocked (Remove Block, klar abgegrenzt von GitHub-„blocked by“), Failed Actions (Retry), Views (Untermenü + „All Views“, Spaltensortierung im Browser), Configuration/System (YAML read-only, Validierung, Reload, Notifications-Fehlzustellungen).
3. Live-Updates per SSE mit Reconnect + Nachladen per REST; alle Steuerbefehle per HTTP mit CSRF-Header.
4. **Alle** untrusted Strings (Events, Results, Logs, Titel) nur über `textContent`/Escape rendern (XSS, §20.5); Links nur `http(s)`.
5. Eindeutige Darstellung: fachliches `failure` vs. technisches `crashed` vs. `lifecycle failed` (§21).
6. Kein Browser-`alert/confirm` – eigene Bestätigungsdialoge.

## Acceptance Criteria
- [ ] Alle Seiten erreichbar, funktionieren gegen laufende App mit Beispiel-Config (manuell + per Browser-Test geprüft, Screenshots im Handoff optional).
- [ ] XSS-Test: Event-Message `<img src=x onerror=...>` wird als Text dargestellt.
- [ ] Logs werden seitenweise geladen; große Logs blockieren UI nicht.
- [ ] SSE-Reconnect aktualisiert Ansicht ohne Reload.
