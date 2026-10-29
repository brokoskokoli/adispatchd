# WI-35 – Artefakte: Workflows erzeugen Dateien/Ordner, Artefakt-Ansicht, Artefakte als Workflow-Eingabe

**Herkunft:** Wunsch des Maintainers (29. Oktober 2026) · **Abhängig von:** `main` (0.9.1) · **Branch:** `wi-35-artifacts` · **Zielversion:** 0.10.0 (DB-Schema v7)

## Problem

Workflows können Dateien nur per `execute.keep` (WI-22) am Run sichern. Es gibt keine run-übergreifende Sicht darauf,
kein Löschen und vor allem keine Möglichkeit, das Ergebnis eines Workflows als Eingabe eines anderen zu verwenden.
Aufeinanderfolgende Schritte gibt es nur über externe Items (Leitprinzip 3), eine Pipeline-Engine ist ausdrücklich
nicht gewünscht.

## Leitidee: Artefakte sind eine Source

Ein **Artefakt** ist eine Datei **oder ein Ordner** (der Ordner ist die „Gruppe“). Artefakte werden als neue Source
`type: artifacts` modelliert, jedes Artefakt ist ein Item. Dadurch bleibt das Modell unverändert:

| Wunsch | Umsetzung mit vorhandener Mechanik |
|---|---|
| Pipeline startet automatisch, wenn ein Artefakt entsteht | `trigger: { type: source, source: artifacts }` mit Filter |
| Pipeline manuell auf einem Artefakt starten | Item-Start (`POST /api/v1/workflows/:id/start` mit `item`) |
| Übersicht der Artefakte | View/Seite mit Filtern und Sortierung |
| Kein erneutes Verarbeiten | eingebautes Feld `consumed_by` (Entscheidung 2) |

Die Artefakt-Metadaten liegen in SQLite (interner Zustand wie Runs, keine zweite Aufgaben-Datenbank), die Inhalte unter
`data-dir/artifacts/<artifact-id>/`.

## Entscheidungen (mit dem Maintainer abgestimmt)

1. **Ausgabe deklarativ in YAML**, nicht über `result.json`:
   ```yaml
   execute:
     artifacts:
       - name: report            # Anzeigename, Platzhalter erlaubt
         type: report            # frei wählbarer Typ zum Filtern
         path: out/report.pdf    # Datei oder Ordner, relativ zum Workspace
   ```
   Eingesammelt wird nach dem Abschluss-Hook und vor dem Cleanup, mit der Sicherheitslogik von `execute.keep`
   (keine Symlinks, nur reguläre Dateien, Pfad nicht absolut/`..`, Größenlimit, Secret-Redaktion). Fehlt der Pfad,
   ist das ein Warn-Event, kein Fehlschlag (Option `required: true` macht es zum technischen Fehler).
2. **Dedupe über eingebautes Feld `consumed_by`**: Liste der Workflow-IDs, die das Artefakt mit Erfolg verarbeitet
   haben (Run `completed`, Ergebnis `success`). Filter z. B. `not: { contains: { consumed_by: summarize } }`.
3. **Ordner-Download als `.zip`** (eigener kleiner Writer, keine neue Dependency; Dateien einzeln als Datei).

## Umfang

- **Config:** `sources.yaml` `type: artifacts` (höchstens eine Source dieses Typs); `execute.artifacts` (Liste);
  `retention.artifacts` (Default `never`, Dauer erlaubt); Platzhalter `{item.path}`, `{item.name}`, `{item.type}`.
- **Artefakt-Felder (Filter, Views, Platzhalter):** `id`, `name`, `type`, `kind` (`file`|`folder`), `size`,
  `file_count`, `created_at`, `workflow` (Erzeuger), `run_id`, `parent` (Eltern-Artefakt, falls der Erzeuger-Run
  selbst ein Artefakt als Eingabe hatte), `consumed_by`.
- **Eingabe:** Läuft ein Workflow auf einem Artefakt-Item, wird es schreibgeschützt nach `inputs/<name>` in den
  Workspace kopiert; Pfad in `context.json` und `{item.path}`. Verfügbar während des Runs gesperrt gegen Löschen.
- **Persistenz:** Tabelle `artifacts`, Migration v7 mit Backup; Artefakte sind unveränderlich.
- **API:**

  | Methode | Pfad | Rolle |
  |---|---|---|
  | GET | `/api/v1/artifacts` (Filter `type`, `workflow`, `kind`, `q`, Paging) | viewer |
  | GET | `/api/v1/artifacts/:id` (Metadaten, Dateibaum bei Ordnern) | viewer |
  | GET | `/api/v1/artifacts/:id/files/<pfad>` | viewer |
  | GET | `/api/v1/artifacts/:id/download` (Datei oder `.zip`) | viewer |
  | POST | `/api/v1/artifacts/:id/start` `{workflow, parameters?}` | operator |
  | DELETE | `/api/v1/artifacts/:id` (409 solange ein aktiver Run es nutzt) | admin |

  Download/Pfadauflösung wie `kept` (WI-22): Traversal-Schutz, `Content-Disposition: attachment`, CSP-Sandbox.
- **UI:** Seite „Artifacts“ (Liste, Filter, Ordneransicht als Dateibaum, Herunterladen, Löschen, „Workflow starten…“
  mit Liste passender Workflows), Verlinkung vom Run (erzeugte Artefakte) und umgekehrt (Erzeuger-Run, Folge-Runs).
- **SSE:** `artifact.created`, `artifact.deleted`.
- **Doku:** Referenz (neuer Abschnitt), `api.md`, Spec-Nachtrag 0.10.0, CHANGELOG, `status.md`, README EN/DE,
  Website-Feature-Liste, `examples/config` (Beispiel-Kette erzeugen → verarbeiten), `init`-Vorlage (auskommentiert).

## Nicht Teil davon

Upload von Artefakten über die UI, Versionierung, Artefakt-Tags, Pipeline-Editor.

## Offene Detailfragen für den Coder-Agenten (im Handoff festhalten)

- Wie das Item-Panel/der Item-Verlauf (WI-33) für Artefakt-Items aussieht (nur lesende Teile, keine GitHub-Aktionen).
- Zeitpunkt von `consumed_by`: nach Abschluss des Runs, nicht beim Start.
- Verhalten beim Löschen eines Artefakts, das Eltern von weiteren ist (Eltern-Verweis bleibt als Text erhalten).

## Acceptance Criteria

- [ ] Workflow mit `execute.artifacts` legt Datei- und Ordner-Artefakte an; fehlender Pfad → Warn-Event bzw. mit `required` Fehler.
- [ ] Pfad-Traversal, Symlinks, Größenlimit und Secret-Redaktion wie bei `keep` getestet.
- [ ] Source `artifacts`: Auto-Trigger mit Filter startet genau einmal je Artefakt und Workflow (`consumed_by`).
- [ ] Manueller Start auf einem Artefakt und auf einem Ordner-Artefakt (Eingabe unter `inputs/`, schreibgeschützt).
- [ ] Liste, Detail, Dateibaum, Download (Datei und `.zip`) und Löschen (inkl. 409 bei aktiver Nutzung) per API und UI; Rollen geprüft.
- [ ] Retention löscht Artefakte nach `retention.artifacts`; Migration v7 mit Backup getestet.
- [ ] Doku-Test (`reference-doc.test.ts`) grün, alle Beispiele laden; alle in CLAUDE.md genannten Dokumente nachgezogen.
- [ ] `npm run check` und `npm run test:pack` grün.
