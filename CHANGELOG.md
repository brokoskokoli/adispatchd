# Changelog

Alle nennenswerten Änderungen an `adispatchd` (Agent Dispatch Daemon). Format nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach [Semantic Versioning](https://semver.org/lang/de/).

## [0.3.1] – unveröffentlicht

### Hinzugefügt

- **Externe Tools in der Toolbar (`ui.external_links`):** Weitere lokale Werkzeuge – z. B. das Dashboard
  [claude-inspect](https://github.com/brokoskokoli/claude_inspect) – erscheinen als Eintrag in der Navigation der
  Weboberfläche: `embed: false` (Default) öffnet sie in einem neuen Tab, `embed: true` zeigt sie auf einer eigenen Seite
  `#/tools/<id>` in einem `iframe` (Sandbox, kein Referrer) mit „Open in new tab“ und Hinweis, falls nichts erscheint.
  Schlüssel `id`, `label` (1–40 Zeichen), `url` (absolut, `http`/`https`, ohne Zugangsdaten), `enabled`, `embed`;
  die URLs aktiver Einträge sieht jeder, der UI/API erreicht – Token-ähnliche Query-Parameter (`t`, `token`, …) ergeben
  deshalb eine Warnung; `embed: true` verlangt einen in der CSP ausdrückbaren Host (Hostname/IPv4). Deaktivierte Einträge
  erscheinen nirgends in API/UI. Kein Proxy – der Browser spricht das Tool
  direkt an. `GET /api/v1/config` liefert die aktiven Einträge als `externalLinks`. Betrieb neben adispatchd (lokal
  und auf dem Server hinter dem Reverse Proxy): `docs/operations.md`.

### Geändert

- Die Content-Security-Policy der Weboberfläche kommt als HTTP-Header statt als `<meta>`-Tag (Inhalt unverändert) und
  erlaubt `frame-src` genau für die Origins der aktivierten eingebetteten Tools; ein Reload der Konfiguration wirkt sofort
  für neu geladene Seiten.

## [0.3.0] – 2026-10-19

### Hinzugefügt

- **Container-Executor (`execute.type: container`):** Der Worker läuft in einem Wegwerf-Container
  (`<engine> run --rm --init` im Vordergrund, `docker` oder `podman`; Default über den neuen Abschnitt
  `container: { engine: docker }` in `config.yaml`). Schlüssel `image` (Pflicht), `command` (Templates), `workdir`,
  `mounts` (`source` absolut/relativ zum config-dir oder `{workspace.path}`, `target`, `mode: ro|rw`), `resources`
  (`memory`, `cpus`, `pids`), `user` (Default: UID/GID des Dienstes; Podman zusätzlich `--userns keep-id`), `network`
  (`default`/`none`/Name), `pull` (`never`/`missing`/`always`); `env`, `secrets` (inkl. `delivery: file`), `timeout`,
  `cancel_grace`, `keep` wie bei `shell`. Immer `--cap-drop ALL --security-opt no-new-privileges`, Name
  `adispatch-<run-id>`, Labels `adispatch.run`/`adispatch.workflow`/`adispatch.instance` (Hash des data-dir).
  Workspace (automatisch unter `/work`, wenn nicht gemountet), Kontextdatei (`/adispatch/context.json`, read-only),
  Ausgabeverzeichnis (`/adispatch/out/`, Ergebnisdatei `/adispatch/out/result.json`) und Token-Dateien
  (`/adispatch/secrets/`, read-only) werden gemountet; `ADISPATCH_*` zeigen auf die Container-Pfade. Werte von `env`
  und `secrets` gehen als `-e NAME` über die Umgebung des Engine-Prozesses, nie über die Kommandozeile.
  Logs, Events, Timeouts, Ergebnisdatei (auch `on_result`) und Klassifikation wie bei `shell`. Cancel/Timeout stoppen
  den Container (`<engine> stop -t <cancel_grace>`); die Recovery stoppt nach einem Neustart alle Container dieser
  Instanz (Event `recovery.container_stopped`; Engine nicht erreichbar → `recovery_pending`). Validierung: Mount-Quellen
  existieren, Ziele absolut/normalisiert/eindeutig/nicht unter `/adispatch`, Formate von `resources`/`user`/`network`.
  Beim Daemon-Start wird das Engine-Binary geprüft (Warnung). `workflow dry-run` (CLI, API, UI) und die
  Workflow-Ansicht zeigen den Engine-Aufruf (Secrets nur mit Namen); das Run-Kommando ist der Engine-Aufruf.
  Vor dem Start abgelehnt (`start_error`): Symlinks in `{workspace.path}/<pfad>`-Quellen und Mounts, die das data-dir
  enthalten oder darin liegen. Nach jedem Ende `rm -f`, nach einem Abbruch zusätzlich Suche nach spät angelegten
  Containern des Runs. Variablen, die die Engine-CLI steuern (Proxy, `LD_*`, `GODEBUG`, `DOCKER_*` …), gehen nie über
  die Engine-Umgebung; als Secret-Name sind sie verboten. Beim Reload wird das Binary einer neu verwendeten Engine
  geprüft (Warnung). `GET /api/v1/runs/:id` zeigt die Ergebnisdatei auch bei Container-Runs.
- **Ergebnisdatei ohne Symlinks lesen (alle Executors):** `lstat`, `O_NOFOLLOW|O_NONBLOCK`, `fstat` auf dem Handle,
  aufgelöster Pfad im erwarteten Verzeichnis – ein Worker kann so keine Host-Datei oder die Ergebnisdatei eines anderen
  Runs unterschieben; Fehler zu ungültigem JSON nennen nur noch die Position (vorher Teile des Inhalts). Gilt auch für
  Kontext- und Ergebnisdatei in `GET /api/v1/runs/:id`.
- **Benannte Ergebnisse (`on_result`):** Die Ergebnisdatei kann zusätzlich zu `result` ein `outcome` liefern
  (Format der Konfigurations-IDs, z. B. `"outcome": "needs_maintainer"`). Ist `on_result.<outcome>` im Workflow
  konfiguriert, läuft genau diese Kette **statt** `on_success`/`on_failure`; sonst bleibt alles wie bisher (ein
  `outcome` ohne Eintrag ergibt eine Warnung am Run, ein `outcome` im falschen Format wird mit Warnung ignoriert).
  `result` steuert weiter Statistik und Retry-Zähler. Neu: Platzhalter `{result.outcome}`, View-Feld
  `run.last_outcome`, `outcome` im Kontext von `shell`-Actions.
- **Sammel-Hook `on_error`:** läuft für `crashed`, `start_error`, `timed_out` und `cancelled`, wenn der jeweilige
  spezifische Hook nicht definiert ist (eine leere Liste zählt als definiert) – nie beides. Die Validierung warnt,
  wenn alle vier spezifischen Hooks definiert sind und `on_error` daher nie läuft.
- Der gewählte Abschluss-Hook und das `outcome` werden am Run gespeichert (Schema-Migration v3) und in API
  (`resultOutcome`, `completionHook`), SSE (`run.status` mit `outcome`/`hook`, Event `run.outcome_warning`) und UI
  (Badge „outcome: …“, Run-Detail) angezeigt; die Recovery setzt nach einem Neustart genau diesen Hook fort.
- `workflow dry-run` (CLI, API, UI) zeigt die `on_result`-Schlüssel und je technischem Ausgang den Hook, der liefe.
- Unbekannte Schlüssel in YAML-Dateien bekommen einen „did you mean …“-Vorschlag; ungültige Schlüssel von Maps
  (z. B. `on_result`) werden mit Grund gemeldet.
- **Projektfelder setzen:** `source.update` hat neben `labels` einen optionalen Block `project` (Feldname aus
  `project.fields` der Trigger-Source → Wert), z. B. `project: { Status: In Progress }` in `on_start` und
  `{ Status: Review }` in `on_success`. Werte je Art: Optionsname (`single_select`), Iterationstitel (`iteration`,
  auch abgeschlossene), Text, Zahl, Datum `YYYY-MM-DD`; `null` leert das Feld. Die Werte werden beim Laden geprüft
  (nicht deklarierte Felder mit „did you mean …“, falscher Werttyp, Source ohne `project`, leerer Block).
- Ausführung im GitHub-Adapter: erst Labels, dann Projektfelder; Metadaten (Feld-IDs, Optionen, Iterationen) und das
  Projekt-Item werden per GraphQL gelesen, gleiche Werte übersprungen, fehlende Items mit `addProjectV2ItemById`
  hinzugefügt, sonst `updateProjectV2ItemFieldValue` bzw. `clearProjectV2ItemFieldValue` – Werte nur als
  GraphQL-Variablen. Unbekannte/mehrdeutige Optionen, fehlende Felder oder falsche Arten sind nicht wiederholbare
  Fehler (Meldung listet die vorhandenen Optionen); Rate-Limits und transiente Fehler laufen über
  `lifecycle.action_retry`.
- Das Action-Journal enthält `applied.projectFields` (und `projectItemAdded`); die Run-Events in der Weboberfläche
  fassen geänderte Labels und Projektfelder zusammen.
- Beispiele: `examples/config/workflows/reviewer-project-b.yaml` setzt den Status, Coder-Workflows in `init` und
  `examples/config` enthalten ein auskommentiertes `project:`-Beispiel; Konfigurationsreferenz §3.4.11, §7.7, §8.
- **Dateien vor dem Workspace-Cleanup sichern (`execute.keep`):** relative Glob-Muster (`*`, `?`, `**`) für Dateien,
  die der Daemon nach dem Abschluss-Hook und vor dem Cleanup bei jedem Endstatus nach `data-dir/runs/<run-id>/kept/`
  kopiert (mit relativer Struktur). `execute.keep_max_size` begrenzt die Summe pro Run (Default `100MB`); zu große
  Dateien werden übersprungen. Symlinks werden nie verfolgt, nur reguläre Dateien kopiert, aufgelöste Pfade gegen den
  Workspace geprüft; Muster mit `..` oder absolute Muster sind Validierungsfehler. Secrets werden beim Kopieren
  redigiert (best effort, wie Logs); das Limit zählt die geschriebenen Bytes. Ergebnis (kopiert, übersprungen mit
  Grund, Muster ohne Treffer bzw. wegen der Grenze nicht durchsucht) als Run-Event `run.kept_files`. Die Dateien werden mit dem Run von der Retention gelöscht.
- API: `GET /api/v1/runs/:id/kept` (Liste mit Pfad und Größe) und `GET /api/v1/runs/:id/kept/<pfad>` (Download als
  Attachment mit sicherer Pfadauflösung); Run-Detail mit Zusammenfassung `kept`, Workflows mit `execute.keep`/
  `keepMaxSizeBytes`. UI: Reiter **Files** am Run mit Download-Links, Workflow-Detail zeigt die Muster; der Dry-Run
  nennt sie unter `notes`.
- **Token-Dateien für lange Runs** (`execute.secrets.<NAME>.delivery: file`): Der Daemon schreibt das Token nach
  `data-dir/runs/<run-id>/secrets/<NAME>` (Verzeichnis `0700`, Datei `0600`, außerhalb des Workspaces) und übergibt
  den Pfad als `<NAME>_FILE` (`<NAME>` selbst wird nicht gesetzt). Solange der Worker läuft, wird die Datei
  spätestens 10 Minuten vor Ablauf atomar ersetzt (temporäre Datei + `rename`); Identities ohne Ablauf
  (`github_token`) werden einmal geschrieben. Fehler beim Erneuern werden ohne Token geloggt und mit Backoff
  wiederholt. Nach Run-Ende (jeder Endstatus) und bei der Recovery nach einem Neustart wird die Datei gelöscht;
  die Retention räumt Reste. Jedes ausgegebene Token wird vorher beim Redactor registriert. Default bleibt
  `delivery: env` (bisheriges Verhalten). Mit der GitHub CLI: `GH_TOKEN=$(cat "$GH_TOKEN_FILE") gh …`.
- **Secrets für Shell-Actions:** `shell`-Actions in Hooks haben dasselbe Feld `secrets` wie `execute` (`env` oder
  `file`; Datei in einem action-eigenen Verzeichnis, während langer Actions erneuert, danach gelöscht). Redaction
  gilt auch für das Action-Log.
- Validierung: `delivery` ∈ {`env`, `file`} (mit „did you mean …“), `<NAME>_FILE` darf weder in `env` noch als
  anderer Secret-Name vorkommen, Identities müssen existieren (jetzt mit Vorschlag bei Tippfehlern).
- API/UI und `workflow dry-run` (CLI/API/UI) zeigen alle deklarierten Secrets von `execute` und `shell`-Actions mit
  Identity und Übergabeart (`secrets`, `execute.secretDelivery`) – nie Werte.
- Hinweis zur Isolation: `0700`/`0600` schützt Token-Dateien vor anderen Systembenutzern, nicht vor anderen Runs desselben
  Dienstes; für getrennte Berechtigungen getrennte Instanzen/Benutzer oder Container verwenden.
- **Ein Workflow für mehrere Sources:** `trigger: { type: source, sources: [project_a, project_b] }` als Alternative zu
  `source: <id>` (nicht leer, eindeutig, gleicher Adaptertyp). Der Planer fragt jede Source ab; Kandidaten aller
  Sources konkurrieren nach Item-Priorität, bei Gleichstand gilt die Reihenfolge der Liste. Locks, Retry-Blocks und
  Historie bleiben pro Item-Schlüssel `<source>:<nr>`; `max_concurrent` gilt für den Workflow insgesamt, neu ist
  `max_concurrent_per_source` (Entscheidung `source_limit`). Fällt eine Source aus, laufen die anderen weiter.
  `project.*` in Filter, `item_priority` und `source.update.project` nur, wenn alle Sources das Feld mit gleicher Art
  deklarieren.
- **Source-Variablen:** `sources.<id>.vars` (Name → String) und der Platzhalter `{source.vars.<name>}` überall, wo
  `{source.*}` erlaubt ist (auch bei einer Source); fehlt die Variable in einer Source des Workflows, nennt die
  Validierung diese Sources.
- Dry-Run, Planungsdiagnose, API und Weboberfläche zeigen alle Sources: `trigger.sources`,
  `maxConcurrentPerSource`, je Source gepollte Items, Pushdown und Fehler (`sources[]` neben den bisherigen Feldern
  `sourceId`, `polled`, `pushdown`, `error`), `capacity.perSource`; Textausgabe mit einer Zeile je Source.
- Manuelle Starts akzeptieren `<source>:<nr>` als Item-Referenz; bei mehreren Sources wird die Source aus URL bzw.
  Präfix abgeleitet, eine mehrdeutige Referenz (`#7`) wird mit Hinweis abgelehnt. Konfigurationsreferenz §3.2,
  §3.4.2, §5, §6, §7.9, §8.
- **Verknüpfte Branches und PRs als Item-Felder (GitHub):** neue teure Felder `linked_branches` (unter „Development“
  verlinkte Branches), `closing_prs` (PRs, die das Issue schließen: `{ number, state, head_ref, is_draft, url }`,
  offen → gemergt → geschlossen), abgeleitet `work_branch` und `work_pr` sowie `work_pr_url` (Link-Ziel in Views).
  Für Pull-Request-Items: eigener Branch und eigene Nummer, solange offen. Eine GraphQL-Abfrage pro Item für alle
  Felder, nur Variablen; jeder Fehler, Teilfehler, mehr als 20 Treffer oder ein Rate-Limit macht alle Felder
  `unknown` (fail closed, Rate-Limit-Pause wie bei Projektfeldern).
- Neuer Feldtyp `object[]` (`closing_prs`): ohne Filter-Operatoren (Validierungsfehler mit Hinweis auf `work_pr`), in
  Views als `#12 open, #9 merged` mit Link je PR; Views können nicht danach sortieren.
- Platzhalter `{item.work_branch}` und `{item.work_pr}` in `execute` und Actions: direkt vor dem Rendern frisch
  gelesen (beim Run-Start bzw. je Action-Versuch). Unbekannt → `start_error` vor `on_start` bzw. wiederholbarer
  Action-Fehler – nie ein leerer String; bekannt leer (`null`) → leerer String. Verwendet ein Workflow die Felder
  (Platzhalter in `execute` oder Feld in `filter`/`item_priority`), stehen sie in `source.attributes` der
  Kontextdatei; Run-Event `run.linked_resolved`. Konfigurationsreferenz §4.7.2, §5.3, §7.10, §8; Live-Test T27.

### Geändert

- In der normalisierten Konfiguration (Snapshots, `GET /api/v1/workflows/:id` → `hooks`) fehlen nicht angegebene
  technische Hooks (`on_crash`, `on_start_error`, `on_cancel`, `on_timeout`) und `on_error` jetzt, statt als `[]`
  zu erscheinen; `on_result.<outcome>`-Ketten erscheinen dort als eigene Einträge. Bestehende Konfigurationen und
  Runs verhalten sich unverändert.
- Beispiel `examples/config/workflows/reviewer-project-b.yaml` zeigt `on_result` und `on_error`.
- **Datenbank-Schema v3** (Migration beim ersten Start, vorher automatisches Backup unter `backups/`). Das Upgrade
  ist nur in eine Richtung möglich: 0.2.x lehnt eine v3-Datenbank ab. Zurück auf 0.2.x nur durch Wiederherstellen
  des Backups von vor der Migration (Runs danach fehlen dann in der Historie), siehe `docs/operations.md` „Update“.
- `source.update.labels` ist optional, wenn `project` gesetzt ist; die Meldung ohne beides lautet jetzt
  `"source.update" must add or remove at least one label or set a project field`.
- Ein ausdrücklich gesetztes `project.identity` der Source schreibt auch die Projektfelder; ohne schreibt die
  Identity der Action (Workflow → Source). Schreibrechte: App **Organization → Projects: Read and write**,
  klassischer PAT mit Scope `project` (statt `read:project`) plus `repo`.
- Worker-Protokoll: Die Regel „Shell-Actions bekommen keine Secrets“ gilt nur noch, solange die Action keine
  `secrets` deklariert.

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

[0.3.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brokoskokoli/adispatchd/releases/tag/v0.1.0
