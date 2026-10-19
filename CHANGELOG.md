# Changelog

Alle nennenswerten Änderungen an `adispatchd` (Agent Dispatch Daemon). Format nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach [Semantic Versioning](https://semver.org/lang/de/).

## [0.2.0] – 2026-10-19

### Hinzugefügt

- **Filter auf GitHub-Projects-Felder:** Eine GitHub-Source kann in `sources.yaml` ein Projekt (v2) mit den
  gewünschten Feldern deklarieren (`project: { owner, number, identity, fields: { Status: single_select, … } }`).
  Die Felder stehen als `project.<Name>` in `filter`, `item_priority` und Views (`fields`, `sort`, `link`) zur
  Verfügung; Arten `single_select`, `text`, `iteration` (→ string), `number`, `date`. „A oder B“ per
  `project.Status in [Todo, Ready]`. Gelesen wird per GraphQL im selben Planungsschritt (Feldnamen nur als
  Variablen); fehlender Zugriff, fehlende Felder oder Fehler machen nur die `project.*`-Felder `unknown`
  (fail closed), das Listing scheitert nie.
- **Neue Issue-Felder:** `state_reason`, `milestone` (Titel) und `issue_type` (Name des Issue-Typs).
- **Identity-Typ `github_token`** (`token_env`): langlebiger Token, z. B. für user-eigene Projekte, die
  GitHub-App-Installationstoken nicht lesen können. Wird beim Start gelesen und redigiert; `project.identity`
  wählt die Identity für Projekt-Abfragen. Kommentar-Marker werden bei Token-Identities über den Login des
  Token-Users erkannt.
- Offline-Validierung kennt `project.*` je Source (Workflows: Trigger-Source; Views: nur gemeinsame Felder gleicher
  Art) mit „did you mean …“-Vorschlägen; `project.identity` muss existieren.
- `workflow dry-run` (CLI, API, UI) zeigt je Kandidat die Werte bzw. Unknown-Gründe der `project.*`-Felder.
- Beispiele: `examples/config/workflows/reviewer-project-b.yaml`, Konfigurationsreferenz §7.7; `init` legt
  auskommentierte `project`- und `github_token`-Blöcke an.
- **Benannte, wiederverwendbare Filter** (`filters/<id>.yaml`): einmal definieren, in Workflows und Views per
  Kurzform `filter: <id>` oder per Referenzknoten `{ use: <id> }` an beliebiger Stelle im Filterbaum verwenden
  (auch in `item_priority` und in anderen benannten Filtern). Referenzen werden beim Laden eingesetzt; Pushdown und
  `state`-Regel gelten für die Position nach dem Einsetzen. Unbekannte IDs (mit „did you mean …“), Zyklen und
  Ketten tiefer als 16 Ebenen sind Fehler; Feldfehler werden am Verwendungsort mit dem Pfad im benannten Filter
  gemeldet; unbenutzte Filter ergeben eine Warnung. Ein expandierter Filter hat höchstens 10 000 Knoten. Änderungen wirken nach `config reload` auf alle Verwender.
- `workflow dry-run` zeigt den ausgewerteten (expandierten) Filter (`source.filter`, Zeile `filter:`);
  `GET /api/v1/config` listet die benannten Filter, `GET /api/v1/config/files` und die UI zeigen `filters/`.
- `init` und `examples/config` enthalten den benannten Filter `needs-maintainer`, den Coder-Workflow und View
  gemeinsam nutzen; `config validate` nennt die Zahl der benannten Filter.

### Geändert

- Beispiel-Coder (`init`: `workflows/coder.yaml`, `examples/config/workflows/coder-project-a.yaml`) startet keine
  Items mit Label `needs-maintainer` mehr (`- not: { use: needs-maintainer }`): wer ein Item an den Coder
  zurückgibt, muss `needs-maintainer` entfernen. Bestehende Konfigurationen ändert `init` nicht.
- `SourceItem` hat ein optionales `unknownFields` (Feld → Grund) für billige Felder, die die Source nicht ermitteln
  konnte.
- Die App-Berechtigung **Organization → Projects: Read** wird für Projektfelder org-eigener Projekte benötigt;
  für user-eigene Projekte empfohlen: klassischer PAT mit `read:project` (+ `repo` bei privaten Repositories).
- Vor `on_start` bricht die erneute Filterprüfung den Run auch ab, wenn ein billiges Feld (z. B. `project.*`) auf dem
  frisch gelesenen Item nicht ermittelt werden konnte (fail closed).

## [0.1.0] – 2026-10-19

Erste veröffentlichte Version.

### Hinzugefügt

- Konfigurationsgetriebener Orchestrator für Shell-Workflows mit Source- (GitHub Issues/PRs), Cron- und manuellem
  Trigger, globalen und workflowbezogenen Limits, Workflow- und Item-Prioritäten.
- Deklarative Filter (dreiwertige Logik, Pushdown, teure Felder wie native „blocked by“-Abhängigkeiten),
  `shell_filter` und Conditions.
- Runs in eigenen Workspaces mit Worker-Protokoll (Kontext-/Ergebnisdatei, Events), Timeouts, Cancel per
  Prozessgruppe, Retry-Blocks, Crash-Recovery und Drain.
- Lifecycle-Hooks mit `source.update` (Labels), `source.comment` (idempotent über Marker) und `shell`-Actions mit
  Retries und Journal.
- GitHub-App-Identitäten (JWT, Installation-Tokens, Redaction), SQLite-Persistenz über `node:sqlite`.
- HTTP-API mit SSE, Weboberfläche, Views über mehrere Repositories, Webhook-Benachrichtigungen, Retention.
- CLI `adispatch` (`init`, `start`, `status`, `pause`/`resume`, `drain`, `cancel-all`, `config validate|reload`,
  `workflow dry-run`, `service install|status|uninstall` für systemd).

[0.2.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brokoskokoli/adispatchd/releases/tag/v0.1.0
