# WI-32 – Dashboard frei anordnen (`dashboard.yaml` → `layout`), Views als Widgets

**Herkunft:** Wunsch des Maintainers (26. Oktober 2026) · **Abhängig von:** `main` (0.7.0) · **Branch:** `wi-32-dashboard-layout` · **Zielversion:** 0.8.0

## Problem

Das Dashboard ist fest verdrahtet (`src/ui/client/pages/dashboard.ts`): Ressourcenleiste, Info-Kacheln, dann ein
Raster mit „Scheduler“, „Capacity“, „Attention“, „Active runs“, „Recently finished“. `dashboard.yaml` kennt nur die
Info-Kacheln (`info`, §3.7). Gewünscht: In `dashboard.yaml` festlegen, **was** in **welcher Anordnung** (Reihen,
Spalten) erscheint, und zusätzlich **Views** (inkl. ihrer Abschnitte) als Bausteine einbinden. Ohne Angabe sieht das
Dashboard genau aus wie heute.

## Konfiguration

Neuer optionaler Top-Level-Schlüssel `layout` in `dashboard.yaml`. Fehlt er (oder fehlt die Datei), gilt das
**Standard-Layout**, das dem heutigen Dashboard entspricht:

```yaml
# Standard-Layout (entspricht 0.7.0); so auch in der Referenz dokumentiert
layout:
  - row: [resources]
  - row: [info]                      # nur sichtbar, wenn Info-Kacheln definiert sind
  - row: [scheduler, capacity, attention]
  - row: [active_runs]
  - row: [recent_runs]
```

Beispiel mit eigenen Anordnungen und Views:

```yaml
info:
  - { id: data-disk, type: percent, command: scripts/info/data-disk.sh }
  - { id: open-prs, type: number, command: scripts/info/open-prs.sh }

layout:
  - row: [resources]
  - row:
      - column: [scheduler, attention]          # Spalte: Widgets untereinander
        width: 1
      - column:
          - { widget: view, view: pipeline-board, sections: [Wartet auf Review, In Arbeit], limit: 15 }
        width: 3                                # relative Breite
  - row:
      - { widget: info, ids: [open-prs] }
      - { widget: recent_runs, limit: 5, title: Zuletzt fertig }
  - title: Projekte                             # optionale Überschrift über der Reihe
    row:
      - { widget: view, view: needs-maintainer }
      - { widget: active_runs, workflows: [coder, reviewer] }
```

**Struktur:**
- `layout`: Liste von **Reihen** (1–30). Eine Reihe ist `{ row: [Element …], title?: String }`.
- Ein **Element** einer Reihe ist entweder ein **Widget** oder eine **Spalte** `{ column: [Widget …], width?: 1–12 }`.
  Ein Widget direkt in der Reihe ist eine Spalte mit genau diesem Widget; es darf ebenfalls `width` tragen. Default
  `width: 1`; die Breiten einer Reihe werden relativ verteilt (CSS-Grid `fr`). Höchstens 6 Spalten je Reihe.
  Auf schmalen Bildschirmen (< 900 px) stehen alle Spalten untereinander.
- Ein **Widget** ist ein Name (String) oder ein Objekt `{ widget: <Name>, title?, …Optionen }`.

**Widgets:**

| Name | Inhalt (wie heute) | Optionen |
|---|---|---|
| `resources` | kompakte Ressourcenleiste (WI-29), Klick → Reiter „Resources“ | – |
| `resources_full` | große Ressourcenansicht wie im Reiter „Resources“ (Verlauf, Prozesse) | – |
| `info` | Info-Kacheln aus `info` | `ids`: Liste von Kachel-IDs (Default: alle, in Dateireihenfolge) |
| `scheduler` | Zustand, Pause/Resume, Drain, Cancel All | – |
| `capacity` | Kapazität, Limit-Override, Auslastung je Workflow | – |
| `attention` | Retry-Blocks, gescheiterte Actions/Notifications | – |
| `active_runs` | laufende Runs | `limit` (1–100, Default 100), `workflows` (Liste Workflow-IDs) |
| `recent_runs` | zuletzt beendete Runs | `limit` (1–50, Default 10), `workflows` |
| `view` | eine View (§3.5) mit voller Funktion: Abschnitte, Sortierung, Gruppen, Spalten, Klick öffnet das Item-Panel mit allen Aktionen (WI-27), Link „Ganze View öffnen“ | `view` (Pflicht, View-ID), `sections` (Liste von Abschnitts-Titeln; Default: alle), `limit` (Zeilen je Abschnitt bzw. Tabelle, 1–200, Default 50, „mehr …“-Link), `refresh` (Dauer, ≥ 15s, Default 60s) |

- `title` überschreibt die Überschrift eines Widgets (1–80 Zeichen); ohne `title` die heutige Überschrift bzw. der
  `name` der View.
- Hinweise (Drain läuft, nicht bereit, ungeschützte Bindung) erscheinen **immer** oben, unabhängig vom Layout.
- Jedes Widget darf mehrfach vorkommen (z. B. zwei Views, `info` mit verschiedenen `ids`).
- `scheduler`, `capacity`, `attention`, `active_runs` und `recent_runs` aus dem Layout weglassen ist erlaubt (die
  Funktionen bleiben über die anderen Seiten erreichbar).

**Validierung (beim Laden, `config validate`, Reload wie §3.7):** unbekannte Schlüssel/Widgets mit „did you mean …“;
`view` existiert; `sections` nur bei Views mit Abschnitten und jeder Titel existiert; `info.ids` existieren;
`workflows` existieren; Grenzen oben; leere `row`/`column` sind Fehler. Warnungen: `info` im Layout ohne Kacheln;
`resources`/`resources_full` bei `monitoring.enabled: false`.

## API

- `GET /api/v1/dashboard` (neu) → `{ layout: [...] }` normalisiert (Strings zu Objekten, Defaults ausgefüllt,
  `width` gesetzt). Bei fehlendem `layout` das Standard-Layout. Rolle viewer.
- View-Widgets nutzen den bestehenden View-Endpunkt (`GET /api/v1/views/:id`), ggf. erweitert um `sections` (Filter
  auf Abschnitts-Titel) und `limit` – serverseitig, damit nicht alles übertragen wird. Gleiche Caches und
  GitHub-Kosten wie die View-Seite; mehrere Widgets mit derselben View teilen sich die Abfrage im Client.
- `active_runs`/`recent_runs` mit `workflows`: bestehender Runs-Endpunkt, Filter nach Workflows (falls nötig ergänzen).

## UI

- Das Dashboard rendert das Layout aus `GET /api/v1/dashboard`. Die bestehenden Bereiche werden zu Widget-Funktionen
  umgebaut (kein doppelter Code); Verhalten, Live-Updates (SSE), Refresh-Intervalle und Rollen bleiben gleich.
- Die View-Darstellung aus `views.ts` wird so herausgelöst, dass Seite und Widget denselben Code nutzen (inkl.
  Abschnitte, Gruppenzeilen, Item-Panel).
- Nach einem Config-Reload lädt das Dashboard das Layout neu.
- Ein Widget mit Fehler (z. B. View nicht ladbar) zeigt den Fehler nur in seiner Karte.
- Helles und dunkles Theme, schmale Bildschirme.

## Doku

`docs/configuration-reference.md` §3.7 (Layout, Widgets, Standard-Layout, Beispiele, die der Doku-Test validiert,
Fehlerbeispiele), `docs/api.md`, Spec-Nachtrag WI-32, `CHANGELOG.md` (Unreleased), `docs/status.md`, README EN/DE,
Website-Feature-Liste, `examples/config/dashboard.yaml` mit einem Layout inkl. View-Widget, `init`-Vorlage
(auskommentiertes Layout), `docs/handoff/WI-32.md`. Screenshot `docs/screenshots/dashboard-layout.png` (generische
Beispieldaten). Keine lokalen Pfade, keine privaten Projektnamen.

## Acceptance Criteria

- [ ] Ohne `layout` sieht das Dashboard aus wie in 0.7.0 (gleiche Bereiche, gleiche Reihenfolge).
- [ ] Schema/Validierung inkl. aller Fehler- und Warnfälle oben; Reload übernimmt Änderungen.
- [ ] Reihen, Spalten, `width`, `title`, mehrfach verwendete Widgets; schmale Bildschirme untereinander.
- [ ] View-Widget mit voller Funktion (Abschnitte, Auswahl per `sections`, `limit`, Item-Panel mit Aktionen, Link zur
      View), Fehler nur im Widget, `refresh`.
- [ ] `info` mit `ids`, `active_runs`/`recent_runs` mit `limit`/`workflows`.
- [ ] Rollen unverändert (viewer sieht, operator steuert).
- [ ] Im Browser geprüft (eigene Instanz, Standard-Layout und Beispiel-Layout, hell/dunkel, schmal).
- [ ] `examples/config` und `init` validieren; Doku-Test grün; `npm run check` und `npm run test:pack` grün.

## Erweiterung: Container-Widget `tabs` (Maintainer, 26. Oktober 2026)

Neues Container-Widget `tabs`, überall erlaubt, wo ein Widget stehen darf (direkt in einer Reihe, in einer Spalte,
in einem anderen Tab → Unter-Tabs):

```yaml
layout:
  - row: [resources]
  - row:
      - widget: tabs
        tabs:
          - title: Pipeline
            layout:                     # gleiche Reihen/Spalten/Widget-Struktur wie das oberste layout
              - row: [{ widget: view, view: pipeline-board }]
          - title: Runs
            layout:
              - row: [active_runs, recent_runs]
          - title: Projekte
            layout:
              - row:
                  - widget: tabs        # Unter-Tabs
                    tabs:
                      - { title: A, layout: [ { row: [ { widget: view, view: needs-maintainer } ] } ] }
                      - { title: B, layout: [ { row: [ attention ] } ] }
      - column: [scheduler]
```

Regeln:
- `tabs`: 1–12 Einträge; `title` Pflicht (1–40 Zeichen, eindeutig im Tabs-Widget); optional `id` (Konfigurations-ID,
  Default: Slug des Titels) für URL/Zustand; `layout` Pflicht (gleiches Schema, rekursiv). Optional `default` am
  Widget = `id` des anfangs offenen Tabs (Default: erster).
- Verschachtelungstiefe der Tabs höchstens 3; Gesamtzahl der Widgets begrenzt (100).
- Lazy: Widgets in inaktiven Tabs werden nicht gerendert, laden nichts und pollen/abonnieren nichts (GitHub-Kosten
  von View-Widgets); Umschalten montiert sie, Verlassen gibt sie frei.
- Der gewählte Tab je Tabs-Widget steht im URL-Hash (teilbar, Zurück-Knopf), z. B. Query-Parameter auf `#/` mit
  einem Pfad aus Tab-IDs; optional je Betrachter in `localStorage` gemerkt (in try/catch).
- Tastaturbedienbare Tab-Leiste (ARIA `tablist`/`tab`/`tabpanel`, Pfeiltasten), hell/dunkel, schmale Bildschirme
  (Tab-Leiste scrollt horizontal).
- Validierungsfehler tragen den Pfad (z. B. `layout[1].row[0].tabs[2].layout[0]…`).
- Doku/Beispiele/Screenshot wie für den Rest von WI-32.

Zusätzliche Acceptance Criteria:

- [ ] `tabs` in Reihe, Spalte und als Unter-Tab; Grenzen (1–12 Tabs, Titel 1–40 und eindeutig, `id`/Slug, `default`,
      Tiefe ≤ 3, ≤ 100 Widgets) werden mit Pfad gemeldet.
- [ ] Inaktive Tabs laden nichts (kein Request, kein Polling); Umschalten montiert/gibt frei.
- [ ] Gewählte Tabs im URL-Hash (teilbar, Zurück-Knopf) und per `localStorage` gemerkt; ARIA-Tabs mit Pfeiltasten;
      schmale Bildschirme mit horizontal scrollender Tab-Leiste.
