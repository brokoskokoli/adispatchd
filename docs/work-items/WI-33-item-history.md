# WI-33 – Item-Verlauf: Weg eines Source-Items durch die Workflows

**Herkunft:** Wunsch des Maintainers (26. Oktober 2026) · **Abhängig von:** `main` (0.8.0) · **Branch:** `wi-33-item-history` · **Zielversion:** 0.9.0

## Problem

Zu einem Issue/PR gibt es keine Gesamtsicht, welche Workflows es durchlaufen hat, mit welchen Ergebnissen und
welchen Änderungen (Labels, Projektfelder, Kommentare) adispatchd dabei vorgenommen hat. Die Daten liegen größtenteils
vor: Runs je Item-Schlüssel, Action-Journal (`run_actions`) inkl. Wirkungs-Zusammenfassung, Retry-Blocks, UI-Aktionen
(`ui_actions`, WI-27).

## Seite „Item-Verlauf“

Route `#/items/<source>/<id>` (Item-Schlüssel `<source>:<id>`), Rolle viewer.

1. **Kopf – aktueller Stand** (frisch gelesen über die Source, wie das Item-Panel): Titel (Link), Typ, Zustand,
   Labels, deklarierte Projektfelder, `work_branch`/`work_pr` sofern konfiguriert; aktiver Run (Link), aktive
   Retry-Blocks (Link auf „Blocked“). Item nicht lesbar → Hinweis, die Historie wird trotzdem gezeigt.
2. **Pfad** – kompakte Kette aller Runs des Items in zeitlicher Reihenfolge: Workflow-Name + Ergebnis-Badge
   (`success`/`failure`/`outcome`/technischer Status/laufend), je Element ein Link auf den Run. Lange Ketten werden
   umbrochen; bei > 50 Runs die letzten 50 mit „ältere …“.
3. **Zeitleiste** (neueste oben, umschaltbar), Einträge:
   - Run reserviert/gestartet: Workflow, Trigger (`source`/`schedule`/`manual` mit Benutzer/`unblock`), Parameter.
   - Run beendet: technischer Status, `result`, `outcome`, Meldung, Dauer.
   - Hook-Kette: Name (`on_start`, `on_success`, `on_result.<outcome>`, `on_error`, `on_retry_block`,
     `on_retry_unblock`, …) und je Action Typ, ID, Status (ok/fehlgeschlagen/übersprungen, Versuche) und **Wirkung**:
     `source.update` → hinzugefügte/entfernte Labels, Projektfeld `Name: alt → neu` (alt, soweit bekannt);
     `source.comment` → „Kommentar geschrieben“ (+ Link, falls bekannt; kein Volltext nötig); `shell` → Exit-Status.
   - Retry-Block entstanden / aufgehoben (von wem, Lifecycle-Run-Link).
   - UI-Aktion (WI-27): Benutzer, Identity, Wirkung.
   - Filter: Checkboxen je Eintragsart.
4. **Externe Ereignisse (optional):** Schalter „GitHub-Ereignisse einblenden“ lädt die Issue-Timeline über die
   Source-Identity (REST `issues/{n}/timeline`, Paginierung bis z. B. 300 Ereignisse): `labeled`/`unlabeled`,
   `closed`/`reopened`, `assigned`, `renamed`, `cross-referenced`/`connected` (verknüpfte PRs), mit Akteur. Ereignisse,
   deren Akteur die eigene App-/Token-Identität ist und die zeitlich zu einer eigenen Action passen, werden **nicht**
   doppelt gezeigt (zusammenführen oder ausblenden); alle anderen sind als „extern“ markiert. Projektfeld-Änderungen
   liefert diese API nicht – Hinweis in der UI. Nur beim Einschalten abgefragt, gecacht (z. B. 60 s), Fehler nur in
   diesem Teil.
5. **Aufbewahrung:** Sind für das Item Runs/Journale durch `retention` gelöscht (oder gibt es Hinweise darauf), zeigt
   die Seite „Ältere Einträge wurden gemäß Aufbewahrung gelöscht“. Planungsentscheidungen (Filter, Limits) werden
   nicht je Item gespeichert und erscheinen nicht (dokumentieren).

## Daten

- Wirkung der Actions: prüfen, was `run_actions` heute speichert. Fehlt eine strukturierte Wirkung (Labels vorher/
  nachher, Projektfeld alt/neu, Kommentar-URL), wird sie ab jetzt strukturiert gespeichert (DB-Schema v6, Migration
  mit Backup wie bei v3–v5; ältere Einträge zeigen die vorhandene Text-Zusammenfassung). Keine Secrets, keine
  Kommentar-Volltexte nötig.
- Abfrage effizient über den Item-Schlüssel (Index prüfen/ergänzen).

## API

- `GET /api/v1/items/:source/:id/history?limit=&before=` → `{ item: {...aktueller Stand | error}, runs: [...Pfad],
  entries: [...Zeitleiste], truncated, retentionGap }` (Paginierung der Zeitleiste).
- `GET /api/v1/items/:source/:id/github-events` → externe Ereignisse (viewer; gedrosselt, Cache).
- `docs/api.md`.

## Views und Verlinkung

- Neues View-Feld `history` (Typ Link, Wert = UI-Route des Verlaufs; Spalte „Verlauf →“), nutzbar in `fields`
  (auch in Abschnitten und Dashboard-View-Widgets), nicht sortier-/filterbar (Validierungsfehler mit Hinweis).
- Links auf den Verlauf: Run-Detailseite (beim Item), Item-Panel (WI-27), Blocked-Seite, Runs-Liste (Item-Spalte
  optional).

## Doku

Referenz (§3.5 `fields`, §4.8 Feld `history`), `docs/api.md`, Spec-Nachtrag WI-33, `CHANGELOG.md` (Unreleased),
`docs/status.md`, README EN/DE und Website-Feature-Liste, `examples/config` (View mit `history`), `init`-Vorlage,
`docs/handoff/WI-33.md`, Screenshot `docs/screenshots/item-history.png` (generische Daten). Keine lokalen Pfade,
keine privaten Projektnamen.

## Acceptance Criteria

- [ ] Seite mit Kopf, Pfad und Zeitleiste für ein Item mit mehreren Runs, Hooks, `on_result`, Block/Unblock und
      UI-Aktion (E2E gegen Fake-GitHub).
- [ ] Wirkung von `source.update` (Labels, Projektfelder alt → neu) und `source.comment` sichtbar; Migration (falls
      nötig) mit Backup, alte Einträge weiter lesbar.
- [ ] Externe GitHub-Ereignisse optional, ohne Doppelungen eigener Änderungen, Fehler isoliert, gecacht.
- [ ] View-Feld `history` in Views, Abschnitten und Dashboard-Widgets; Validierung (nicht sortier-/filterbar).
- [ ] Links von Run-Detail, Item-Panel, Blocked-Seite.
- [ ] Aufbewahrungs-Hinweis; Paginierung; leeres Item (keine Runs) sinnvoll dargestellt.
- [ ] Rollen (viewer liest), Texte nur als Text (XSS), keine Secrets.
- [ ] Im Browser geprüft (eigene Instanz, hell/dunkel, schmal).
- [ ] `examples/config` und `init` validieren; Doku-Test grün; `npm run check` und `npm run test:pack` grün.
