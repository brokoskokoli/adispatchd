# WI-36 – Hub-API und Übersicht: Workspaces, Verwaltung, Durchreichen der Workspace-UIs

**Herkunft:** Wunsch des Maintainers (29. Oktober 2026) · **Abhängig von:** WI-35 · **Branch:** `wi-36-hub-api-ui` · **Zielversion:** 0.10.0

## Entscheidungen

- Der Hub reicht die UI und API jedes Workspaces unter **einem gemeinsamen Port** durch: `/w/<workspace-id>/…`
  (HTTP und SSE) auf den loopback-Port des Kindes. Die Workspace-Instanzen sind von außen nicht direkt erreichbar.
- Anmeldung (Passwort / Proxy-Header, Rollen, Audit) liegt im **Hub**; Workspace-Instanzen laufen hinter dem Hub mit
  einem vom Hub eingesetzten, nicht fälschbaren Vertrauenskanal (kein offener Zugriff von außen auf ihre Ports).
  Die konkrete Umsetzung (Header-Weitergabe oder internes Token) legt das Work-Item fest und dokumentiert sie.

## Umfang

1. **Hub-API** (`/api/v1/hub/…`, gleiche Auth-Regeln und Rollen wie WI-26; Lesen ab `viewer`, Steuern ab `operator`):
   - `GET /hub/status`: Gesamtlimit, belegte Slots, Pause-Zustand, Hub-Version, Serverressourcen (Daten wie WI-23).
   - `GET /hub/workspaces`: je Workspace Zustand, Port, Version, laufende Runs, Queue/blockiert, letzte Fehler, Slots.
   - `POST /hub/workspaces/:id/start|stop|restart|drain`, `POST /hub/stop-all|drain-all|pause|resume`.
   - SSE-Strom `hub.*` für Zustandsänderungen und Slot-Belegung.
2. **Reverse-Proxy-Pfad** `/w/<id>/…`: Streaming, SSE und WebSocket-freie UI; Host-/Origin-/CSP-Regeln beachten
   (`allowed_hosts`, CSP-Header aus WI-25), Basis-Pfad in der UI (relative Pfade bzw. Basis-URL), keine
   Header-Injektion von außen, Pfad-Traversal ausgeschlossen. Nicht laufender Workspace → klare 503-Seite.
3. **Übersicht-UI** (Startseite des Hubs): Kachel je Workspace (Zustand, laufende Runs / Queue / Fehler, Slot-Anteil),
   Gesamtleiste „Slots n/m“, Serverressourcen, Schaltflächen für Start/Stop/Drain je Workspace sowie „Alle drainen“,
   „Alle stoppen“, „Pausieren“ (mit Bestätigung, nur mit passender Rolle sichtbar). Klick auf einen Workspace öffnet
   dessen UI unter `/w/<id>/`; eine Kopfzeile bzw. ein Link führt zurück zur Übersicht. Hell/Dunkel, schmal, barrierearm wie die übrige UI.
4. **Audit:** Verwaltungsaktionen des Hubs landen in der Audit-Tabelle des Hubs (wer, was, wann).

## Doku

`docs/api.md` (Hub-Endpunkte), Konfigurationsreferenz, Spec-Nachtrag, CHANGELOG, `docs/status.md`, `docs/handoff/WI-36.md`.

## Acceptance Criteria

- [ ] API-Tests für alle Endpunkte inkl. Rollenprüfung und Auth-Modi; Verwaltungsaktionen auditiert.
- [ ] Durchreichen: UI, API und SSE eines Workspaces funktionieren unter `/w/<id>/` (auch hinter zusätzlichem Reverse-Proxy-Präfix); direkter Zugriff auf das Kind von außen ist nicht möglich bzw. dokumentiert eingeschränkt.
- [ ] Ungültige/fremde Pfade, `..`, falsche Hosts und fehlende Rechte werden abgewiesen; ein Workspace kann nicht auf andere zugreifen.
- [ ] Übersicht zeigt Zustand und Zahlen korrekt, aktualisiert live, „alle drainen/stoppen/pausieren“ funktionieren end-to-end mit zwei Kindprozessen.
- [ ] Im Browser geprüft (eigene Hub-Instanz, hell/dunkel, schmal); `npm run check` grün.
