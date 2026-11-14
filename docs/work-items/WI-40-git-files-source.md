# WI-40 – Source `git_files`: Issues als Markdown-Dateien in einem Git-Repository

**Herkunft:** Wunsch des Maintainers (14. November 2026) · **Abhängig von:** `main` (0.10.1) · **Branch:** `wi-40-git-files-source` · **Zielversion:** 0.11.0 (neue Source-Art → Minor; kein DB-Schema-Wechsel)

Status: vom Maintainer in der Richtung freigegeben; Details hier vom Orchestrator präzisiert.

## Problem

Ein Projekt möchte seinen Issue-Tracker als Dateien in einem (privaten) Repository führen statt in GitHub Issues:
eine Markdown-Datei mit YAML-Frontmatter je Item, von Menschen und Agenten mit normalen Git-Werkzeugen bearbeitbar,
versioniert, reviewbar, offline lesbar. adispatchd soll solche Items genauso planen, filtern, priorisieren, anzeigen
und per Lifecycle-Actions fortschreiben können wie GitHub-Issues.

## Leitidee: eine weitere Source-Art, keine Sonderwege

Eine neue Source `type: git_files` implementiert das bestehende `SourceAdapter`-Interface. Filter, `item_priority`,
Views, Platzhalter, Locks, Retry-Blocks, Item-Verlauf und das Action-Journal funktionieren unverändert. Der Daemon
hält einen eigenen Klon unter dem Datenverzeichnis (`<data-dir>/sources/<source-id>/`), der nur ein Spiegel ist: vor
jedem Lesen/Schreiben `fetch` + `reset --hard origin/<branch>`, lokale Änderungen gibt es nur innerhalb einer
Schreiboperation bis zum Push.

## Konfiguration (`sources.yaml`)

```yaml
sources:
  issues:
    type: git_files
    repository: https://github.com/acme/app-meta.git   # URL oder lokaler Pfad (absolut oder relativ zum Config-Ordner)
    branch: main                     # Default main
    path: issues                     # Ordner im Repo, Default issues; Dateien NNNN-<slug>.md (oder NNNN.md)
    identity: coordinator            # optional: Token dieser Identity für fetch/push (github_app oder github_token)
    commit_author: { name: adispatchd, email: adispatchd@example.invalid }   # Default wie hier
    closed_when: { status: [done, closed] }   # Default; Feld → Werte, ein Treffer genügt → state closed
    comments_heading: "## Log"       # Überschrift des Kommentar-Abschnitts am Dateiende, Default "## Log"
    fields:                          # weitere Frontmatter-Schlüssel mit Typ (für Filter/Views/Sortierung)
      priority: number
    web_url: https://github.com/acme/app-meta/blob/{ref}/{path}   # optional; Default für github.com-URLs abgeleitet
    vars: { ... }
```

## Entscheidungen

1. **Feldkatalog.** Fest eingebaute Felder: `number` und `id` (Nummer aus Frontmatter `id`, sonst aus dem Dateinamen),
   `title`, `state` (`open`/`closed` aus `closed_when`), `status`, `labels` (Groß-/Kleinschreibung egal), `milestone`,
   `blocked_by` (Liste von IDs derselben Source), `branch`, `pr`, `spec`, `files`, `created_at` (Frontmatter
   `created`/`created_at`), `body` (Markdown ohne Kommentar-Abschnitt), `comments` (`object[]`: `at`, `author`,
   `text`), `path` (Datei relativ zum Repo), `url`, `dependencies.blocked_by_total|blocked_by_open|blocked|status`,
   `work_branch` (= `branch`), `work_pr` (= `pr`, Zahl), `work_pr_url` (wenn `pr` eine URL ist). **Weitere
   Frontmatter-Schlüssel** werden unter `fields:` mit Typ (`string`, `number`, `boolean`, `date`, `string[]`)
   deklariert, damit die Konfigurationsprüfung offline Feldnamen, Operatoren und Werttypen prüfen kann (wie
   `project.fields` bei GitHub). Nicht deklarierte Schlüssel stehen trotzdem als eigene Attribute in `context.json` (`source.attributes`; Skalare und Listen von Strings wörtlich, sonst JSON-Text), sind aber nicht filterbar.
   Ein Wert, der nicht zum Typ passt, ist für dieses Item **unbekannt** (fail closed).
2. **Abhängigkeiten.** `blocked_by_open` zählt Blocker, die nicht `closed` sind. Ist ein Blocker unbekannt (keine
   Datei, ungültige Datei, doppelte ID), sind `blocked_by_open` und `blocked` **unbekannt** und `status` ist `unknown`
   (fail closed, wie bei GitHub ohne Zugriff). Alle Felder sind billig (die Dateien liegen lokal), nichts ist „expensive“.
3. **Listing.** Wie GitHub: ohne Selektor nur offene Items; `state` (oben im Filter, `equals`/`in`) wählt geschlossene aus.
4. **Lesen.** Höchstens ein `fetch` je Mindestabstand (5 s; gleichzeitige Leser teilen sich einen), danach werden alle
   Dateien geparst. Ungültige Dateien (kein/fehlerhaftes Frontmatter, ID ungültig, Dateiname und `id` widersprechen,
   doppelte ID, Symlink, zu groß) werden übersprungen und einmal je Datei-Stand als Warnung geloggt; der Planer stürzt
   nie. Andere `.md`-Dateien ohne Nummernpräfix (z. B. `README.md`) werden still ignoriert.
5. **Schreiben.** `source.update` bekommt für diese Source `fields: { status: coding }` (Wert `null` entfernt den
   Schlüssel) zusätzlich zu `labels: { add, remove }`; `project:` ist nur bei `github`, `fields:` nur bei `git_files`
   erlaubt (Konfigurationsprüfung, auch Typprüfung gegen den Katalog; abgeleitete Felder sind nicht schreibbar).
   `source.comment` hängt einen Eintrag am Dateiende unter `comments_heading` an (Abschnitt wird angelegt, falls er
   fehlt): Kopfzeile `### <ISO-Zeit> — <Identity>`, Text, Marker `<!-- adispatchd:… -->` als letzte Zeile. Frontmatter-
   Änderungen fassen nur das Frontmatter an (Reihenfolge und YAML-Kommentare bleiben über die Document-API von `yaml`
   erhalten), Kommentare nur das Dateiende – der Rest der Datei bleibt bytegleich, so mergt Git nebenläufige
   Body-Änderungen von Menschen sauber.
6. **Commit und Push.** Jede Action = ein Commit mit klarer Nachricht (`<source> #<id>: <Änderung>` plus Trailer
   `Adispatchd-Run`/`Adispatchd-Action`/`Adispatchd-Identity`) und ein Push. Abgelehnter Push: fetch, `reset --hard`
   auf den neuen Stand, Änderung **neu anwenden** (idempotent: Labels/Felder nur, wenn noch nötig; Kommentar nur,
   wenn sein Marker fehlt), erneut pushen; höchstens 5 Versuche, dann `SourceError` `transient` (das Action-Journal
   wiederholt nach seiner Policy). Alle Git-Operationen eines Klons laufen nacheinander (Sperre je Klon, auch über
   Konfigurations-Reloads hinweg). Kommentar-ID = SHA des Commits; `findCommentByMarker` findet den Eintrag am Marker.
7. **Identity.** Transport (fetch/push) immer mit der Source-Identity (eine Klon-Konfiguration, ein Recht); die
   Action-Identity erscheint als Autor im Kommentarkopf und im Commit-Trailer. Ohne `identity` (lokaler Pfad, ssh mit
   Agent) keine Zugangsdaten; Autor ist dann `commit_author.name`.
8. **Zugangsdaten.** Token nur in der Umgebung des Git-Kindprozesses (`ADISPATCH_GIT_TOKEN`), gelesen von einem
   Inline-Credential-Helper (`-c credential.helper=…`, enthält kein Geheimnis); nie in URL, Klon-Konfiguration, Logs
   oder Fehlermeldungen (zusätzlich redigiert). Git läuft mit minimaler Umgebung ohne System-/Benutzer-Git-Konfiguration,
   ohne Hooks und ohne Terminal-Prompt.
9. **UI-Aktionen.** Kommentar und Labels aus dem Item-Panel laufen über denselben Schreibpfad (`postUserComment`,
   `applyUpdate`, `listLabels` = alle in der Source verwendeten Labels). Das Setzen von Frontmatter-Feldern aus der UI
   (analog Projektfelder) ist **Folgearbeit** (eigene Route und Panel-Erweiterung).
10. **Items aus Skripten anlegen.** `adispatch source create-item <source> --title … [--body-file …] [--field k=v …]
    [--label …]` im Config-Ordner: arbeitet in einem temporären Klon (kein Konflikt mit dem Klon des laufenden Daemons),
    nimmt die nächste freie Nummer (höchste vorhandene + 1, auch über ungültige Dateien hinweg), Dateiname
    `NNNN-<slug>.md` (4 Stellen, mehr bei Bedarf), dieselbe Commit/Push-Logik; bei Push-Konflikt neu nummerieren.
11. **Kontext.** `context.json` enthält wie bei jeder Source die billigen Felder in `attributes`, hier also auch `body`
    und `comments` (bei GitHub nicht enthalten – dort liest der Worker selbst).

## Umfang

- `src/sources/git-files/`: Parser (Frontmatter, Kommentar-Abschnitt), Editor (Frontmatter-Edits, Anhängen),
  Git-Runner (Zugangsdaten, Sperre, Retry), Adapter, Feldkatalog; Registrierung in `SourceRegistry`.
- Config: Schema, Normalisierung, Validierung (Pfade, `fields`-Deklaration, `closed_when`, `source.update.fields`
  vs. `project`, Typprüfung), Feldkatalog mit deklarierten Feldern für Workflows und Views, Listing-Selektor `state`.
- CLI `adispatch source create-item`.
- Doku: Referenz (Abschnitt mit validiertem Beispiel), Spec-Nachtrag, CHANGELOG (0.11.0), Status, README EN/DE,
  Website-Feature-Liste, `examples/config` (auskommentiert/optional), `init`-Vorlage (auskommentiert), Handoff.
- Tests: Unit (Parser, Editor, Feldwerte, Validierung, Credential-Umgebung) und E2E mit lokalem Bare-Repo als Remote
  (Planung, Filter, Abhängigkeiten, Kommentar + Update + Konflikt mit nebenläufigem Push, `create-item`).

## Nicht Teil davon

UI-Route für Frontmatter-Felder, Platzhalter in `fields`-Werten, Unterordner, Anhänge, Umbenennen von Dateien,
Verlauf aus der Git-Historie im Item-Verlauf (`listItemEvents`), Webhooks statt Polling.

## Acceptance Criteria

1. Eine `git_files`-Source mit lokalem Bare-Repo als Remote liefert offene Items mit allen eingebauten Feldern;
   deklarierte Felder sind filter-, sortier- und anzeigbar; `state`-Selektor listet geschlossene Items.
2. `dependencies.blocked_by_open` zählt offene Blocker; unbekannte Blocker machen es unbekannt (Filter `equals 0` greift nicht).
3. Ungültige Dateien werden mit Warnung übersprungen; der Planer liefert die übrigen Items.
4. `source.update` mit `labels` und `fields` ändert nur das Frontmatter (Body bytegleich), idempotent (zweiter Lauf
   ohne Commit); `source.comment` hängt einen Eintrag mit Marker an; Wiederholung nach Unklarheit findet ihn
   (`findCommentByMarker`) statt doppelt zu posten.
5. Ein abgelehnter Push (nebenläufiger Commit im Remote) wird durch fetch + Neuanwendung gelöst; beide Änderungen
   sind danach im Remote.
6. Token erscheint weder in der Remote-URL noch in `.git/config` des Klons noch in Logs/Fehlermeldungen.
7. Konfigurationsprüfung: `fields:` bei `github`, `project:` bei `git_files`, unbekannte/abgeleitete/typfalsche
   Felder in `source.update.fields`, ungültige `fields`-Deklarationen und unsicheres `path` sind Fehler.
8. `{item.number}`, `{item.title}`, `{item.work_branch}`, `{item.work_pr}` funktionieren; `context.json` enthält
   `body` und `comments`.
9. UI-Kommentar und UI-Labels funktionieren für die Source; `adispatch source create-item` legt eine Datei mit der
   nächsten freien Nummer an und pusht sie.
10. `npm run check` grün; Referenzbeispiel wird vom Doku-Test geladen; Datenschutz-Grep leer.
