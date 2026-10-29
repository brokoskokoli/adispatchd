# Changelog

Alle nennenswerten Änderungen an `adispatchd` (Agent Dispatch Daemon). Format nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

### Hinzugefügt

- **Artefakte** (WI-35): Workflows erzeugen Dateien oder Ordner, die run-übergreifend sichtbar sind und andere Workflows
  als Eingabe verarbeiten – ohne Pipeline-Engine.
  - `execute.artifacts` (`name` mit Platzhaltern, `type`, `path`, `required`) und `artifacts_max_size` (Default 100MB):
    nach dem Abschluss-Hook und vor dem Workspace-Cleanup gespeichert unter `data-dir/artifacts/<id>/`, nur bei Runs,
    die `completed` enden; Sicherheitsregeln wie `execute.keep` (keine Symlinks, nur reguläre Dateien, Größenlimit,
    Secret-Redaktion). Fehlender Pfad = Warnung im Event `run.artifacts`, mit `required: true` ein technischer Fehler
    (Run `crashed`).
  - Neue Source `type: artifacts` (jedes Artefakt ist ein Item; keine Identity): Auto-Trigger mit Filter, manueller
    Start, Views, Item-Verlauf. Eingebautes Feld `consumed_by` (Workflows, die das Artefakt mit Erfolg verarbeitet
    haben) verhindert erneutes Verarbeiten, `attempted_by` (Run abgeschlossen, auch bei fachlichem `failure`) ist der Retry-Schutz; die Konfigurationsprüfung warnt, wenn ein Artefakt-Workflow keinen Filter darauf hat; weitere Felder `id`, `name`, `type`, `kind`, `file_name`, `size`,
    `file_count`, `created_at`, `workflow`, `run_id`, `parent`, `url`.
  - Eingabe: schreibgeschützte Kopie unter `<workspace>/inputs/<Name>`, Platzhalter `{item.path}`, `{item.name}`,
    `{item.type}` und `source.input` in `context.json`; Löschen ist gesperrt, solange ein aktiver Run das Artefakt nutzt.
  - API: `GET /api/v1/artifacts`, `…/:id`, `…/:id/files/<pfad>`, `…/:id/download` (Datei oder `.zip` ohne neue
    Dependency), `POST …/:id/start`, `DELETE …/:id` (`409 artifact_in_use`); Rollen viewer/operator/admin; SSE
    `artifact.created`/`artifact.deleted`; Run-Detail `artifacts`.
  - UI: Seite „Artifacts“ (Liste, Filter, Dateibaum, Download, Löschen, „Workflow starten…“), Verlinkung vom Run.
  - `retention.artifacts` (Default `never`); Beispiel-Kette `make-report` → `summarize-report` in `examples/config`.

### Geändert

- **DB-Schema v7** (Migration mit Backup, Einbahnstraße): Tabelle `artifacts`. `workspace`-Cleanup und Retention
  stellen die Schreibrechte der Artefakt-Eingabe (`inputs/`) vor dem Löschen wieder her.

## [0.9.1] – 2026-10-27

### Geändert

- **Dashboard-Widgets `active_runs` und `recent_runs` verlinken den Item-Verlauf** (WI-34): hinter dem Item steht
  „history“ wie in der Run-Liste; `recent_runs` hat dafür eine neue Spalte „Item“.

## [0.9.0] – 2026-10-26

### Hinzugefügt

- **Item-Verlauf (`#/items/<source>/<id>`).** Eine Seite je Issue/PR zeigt den Weg durch die Workflows: aktueller Stand
  (frisch von GitHub gelesen: Titel, Typ, Zustand, Labels, Projektfelder, Arbeits-Branch/-PR, aktiver Run, aktive
  Retry-Blocks), den **Pfad** aller Runs als Kette mit Ergebnis-Badges und eine **Zeitleiste** (neueste oben,
  umschaltbar, Filter je Eintragsart, „Load older entries“) mit Run-Start (Trigger, Benutzer, Parameter), Run-Ende,
  Hook-Ketten mit der **Wirkung** jeder Action (Labels +/−, Projektfeld `alt → neu`, Kommentar-Link, Exit-Status),
  Retry-Block entstanden/aufgehoben und UI-Aktionen. Optional „Show GitHub events“: die Issue-Timeline (Labels,
  Schließen/Öffnen, Zuweisung, Umbenennen, Verweise) ohne Doppelungen eigener Änderungen, externe als „external“
  markiert, 60 s gecacht. Hinweis, wenn die Aufbewahrung ältere Runs gelöscht hat. Lesbar ab Rolle `viewer`. Links
  aus Run-Detail, Item-Panel, Blocked-Seite und Run-Liste.
- **View-Feld `history`:** Link-Spalte „History →“ auf den Item-Verlauf, in Views, Abschnitten und
  Dashboard-View-Widgets (nicht filter- oder sortierbar). Referenz §3.5, §4.8.
- **API:** `GET /api/v1/items/:source/:item/history` (`limit`, `before`, `refresh`) und
  `GET /api/v1/items/:source/:item/github-events` (`refresh`); Run-Detail-Actions enthalten `effect`.

### Geändert

- **DB-Schema v6** (Migration mit Backup, Einbahnstraße): `run_actions.effect_json` speichert die Wirkung jeder Action
  strukturiert (bei `source.update` auch den alten Wert geänderter Projektfelder; nie Kommentartexte oder Secrets),
  Index `blocks_item`, Tabelle `item_history_gaps`. Ältere Journal-Einträge erscheinen mit der vorhandenen
  Zusammenfassung.
- Das Item-Panel der UI-Aktionen liegt jetzt unter `#/items/<source>/<id>/act`; `#/items/<source>/<id>` öffnet den
  Item-Verlauf (mit Link zum Panel).

## [0.8.0] – 2026-10-26

### Hinzugefügt

- **Dashboard frei anordnen (`dashboard.yaml` → `layout`).** Reihen aus Spalten aus Widgets mit relativer Breite
  (`width`), optionalen Überschriften für Reihen und Widgets (`title`) und mehrfach verwendbaren Widgets:
  `resources`, `resources_full`, `info` (`ids`), `scheduler`, `capacity`, `attention`, `active_runs`/`recent_runs`
  (`limit`, `workflows`). Ohne `layout` sieht das Dashboard aus wie bisher. Referenz §3.7.1; Beispiel
  `examples/config/dashboard.yaml`.
- **Views als Dashboard-Widgets (`widget: view`).** Mit Abschnitten, Auswahl per `sections`, `limit` je Tabelle („N more
  …“), eigenem `refresh`-Intervall, Gruppenzeilen, Sortierung im Browser, Item-Panel und Link zur View; mehrere Widgets
  derselben View teilen sich eine Abfrage. Die View-Seite und das Widget nutzen denselben Renderer.
- **Reiter auf dem Dashboard (`widget: tabs`).** Bis zu 12 Reiter mit eigenem Layout, Unter-Reiter bis Tiefe 3,
  `default`; inaktive Reiter laden nichts. Der gewählte Reiter steht im URL-Hash (`#/?tab=projekte/a`, teilbar,
  Zurück-Knopf) und wird im Browser gemerkt; Tastaturbedienung (←/→, Pos1/Ende).
- **API:** `GET /api/v1/dashboard` (normalisiertes Layout); `GET /api/v1/views/:id/items` mit `sections` (wiederholbar)
  und `limit`; `GET /api/v1/runs?workflow=` nimmt eine kommagetrennte Liste.

## [0.7.0] – 2026-10-23

### Hinzugefügt

- **Auswahllisten zur Laufzeit für Parameter manueller Starts (`options_from`).** Ein `enum`-Parameter kann seine
  Werte statt aus festen `values` aus GitHub (`github: branches|tags` einer Source, gelesen mit deren Identity;
  Branches mit Default-Branch zuerst, Tags neueste zuerst, `limit` bis 500) oder aus einem eigenen Skript beziehen
  (`command`, `args`, `secrets`, `timeout`, `cache`; eine Option pro Zeile oder JSON-Liste mit `value`/`label`).
  Optional `allow_custom` (auch für statische `values`): Werte außerhalb der Liste erlaubt. Beim Start prüft der Server
  gegen die aktuelle Liste (400 `invalid_parameters`, 502 `parameter_options_unavailable`, wenn sie nicht abrufbar
  ist). Automatische Workflows erhalten wie bisher nur den `default` (Pflicht bei `options_from`). Referenz §3.4.7;
  Beispiel `examples/config/workflows/release.yaml`.
- **API:** `GET /api/v1/workflows/:id/parameters/:name/options` (`refresh=true`; Skript-Optionen nur ab Rolle
  `operator`); die Workflow-Ansicht enthält je `enum` `optionsFrom` (ohne Skript-Argumente) und `allowCustom`.
- **UI:** Das Startformular lädt die Listen beim Öffnen – Auswahlfeld mit Suche (ab 16 Optionen), „Reload“, Lade- und
  Fehlerzustand, Hinweis bei fehlendem Default; mit `allow_custom` Eingabefeld mit Vorschlägen.

## [0.6.0] – 2026-10-22

### Hinzugefügt

- **Hooks beim Entstehen und Aufheben eines Retry-Blocks (`on_retry_block`, `on_retry_unblock`).** Beide optional,
  mit denselben Actions wie die übrigen Hooks (Labels/Projektfelder, Kommentar, Skript). `on_retry_block` läuft im
  Run, der den Block gerade erzeugt hat, **nach** dessen Abschluss-Hook (`on_crash` & Co.) – auch wenn dieser
  gescheitert ist und auch bei `start_error` ohne Hooks; Recovery setzt die Kette fort. `on_retry_unblock` läuft
  beim Aufheben („Remove Block“, `POST /api/v1/blocks/:id/clear`) in einem neuen **Lifecycle-Run** mit Trigger
  `unblock` (kein Worker, kein Workspace): Er hält das Lock für Workflow + Item, bis die Kette fertig ist, zählt nicht
  als technischer Fehler und nicht zu den Limits, endet als `completed` + `success`/`failure` und erscheint in UI/API
  wie jeder Run (Retry/Skip, Recovery). Läuft für Workflow + Item gerade ein Run, wird das Aufheben mit nicht leerem
  `on_retry_unblock` mit `409 block_run_active` abgelehnt; bei Blocks ohne Item scheitern manuelle Starts ohne Item
  während der Kette mit `409 unblock_run_active`. Neue Platzhalter `{block.id}`, `{block.failures}`,
  `{block.created_at}`, `{block.last_status}`, in `on_retry_unblock` zusätzlich `{block.cleared_at}`,
  `{block.cleared_by}`. Workflows ohne Item: nur `shell`. Referenz §3.4.10, §5, §6.4; Beispiel
  `examples/config/workflows/coder-project-a.yaml`.
- **Benachrichtigung `retry_block_cleared`** (optional, nicht im Default von `notifications.on`).
- **API/UI:** `clear` antwortet mit `runId` des Lifecycle-Runs (oder `null`); Blocks enthalten `lastStatus` und
  `clearedRunId`, Runs `retryBlockHook`, das Run-Detail `retryBlock`; `GET /api/v1/runs?trigger=unblock`. Die UI
  zeigt Lifecycle-Runs mit Badge „unblock“ und nach „Remove Block“ einen Link auf den Run.

### Geändert

- **DB-Schema v5** (automatische Migration mit Backup unter `data-dir/backups/`): `runs.trigger_type` erlaubt
  `unblock`, neue Spalten `runs.retry_block_hook`, `blocks.last_status`, `blocks.cleared_run_id`; `run_actions.hook`
  erlaubt die beiden neuen Hooks. Bestehende Blocks bleiben gültig. Ein Downgrade auf 0.5.x ist nicht vorgesehen
  (0.5.x lehnt v5 ab; zurück nur über das Backup vor der Migration).

## [0.5.0] – 2026-10-20

### Hinzugefügt

- **Views: eigene Wertereihenfolge, mehrere Sortierschlüssel, Abschnitte.** `sort` darf eine Liste von 1–5
  Schlüsseln sein (ein einzelnes Objekt bleibt gültig); je Schlüssel sortiert `order: [open, coding, review, …]` nach
  der Position des Werts (nur `string`-Felder, z. B. `project.Status`): nicht gelistete Werte danach, leere zuletzt,
  `direction: desc` kehrt die Liste um. Werte, die ein `single_select`-Projektfeld nicht kennt, erscheinen als Warnung
  im View-Ergebnis. `group_by_first: true` zeigt eine Gruppenzeile je Wert. Mit `sections` zeigt eine View mehrere
  Tabellen mit Überschrift und Zeilenzahl (eigener `filter` oder `rest: true`, optional eigene `sort`/`fields`;
  `exclusive`, `hide_empty_sections`); die Sources werden dabei nur einmal gelesen. UI: „Default order“ stellt nach
  einem Spaltenklick die konfigurierte Sortierung wieder her, Sprungmarken ab vier Abschnitten. Beispiel:
  `examples/config/views/pipeline.yaml`; Referenz §3.5.1, §3.5.2.
- **API (Views):** Definitionen enthalten zusätzlich `sections`, `exclusive`, `hideEmptySections`, `groupByFirst`;
  View-Ergebnisse haben `warnings` und bei Abschnitten `sections: [{ title, rows, counts, sort, fields, … }]`.

### Geändert

- **Inkompatible API-Änderung (Views):** `GET /api/v1/views` und `/views/:id` liefern `sort` jetzt **immer als Liste**
  (`[{field, direction, order}]`, `[]` = unsortiert; vorher ein Objekt oder `null`). Bei Views **mit Abschnitten** ist
  `rows` im Ergebnis von `/views/:id/items` leer (`[]`), die Zeilen stehen in `sections[].rows`. Views ohne
  Abschnitte liefern ihre Zeilen unverändert.

- **Dashboard: kompakte Ressourcenleiste statt großer Server-Sektion.** Oben im Dashboard (vor den Info-Kacheln und den
  Scheduler-Karten) zeigt eine schmale Leiste CPU gesamt mit Verlauf der letzten 15 Minuten, RAM belegt/gesamt, die am
  stärksten belegte Platte, Load und eine Zeile mit den größten Prozessgruppen (eigene Runs zuerst); live per SSE
  `system.metrics`, ein Klick öffnet den neuen Reiter **Resources** (`#/resources`) mit den bisherigen Diagrammen
  (CPU gestapelt, RAM, Platte), Legende, Zeitraumwahl und Wertetabelle. Bei `monitoring.enabled: false` zeigt die Leiste
  einen kurzen Hinweis. Sichtbar ab Rolle `viewer`.

## [0.4.0] – 2026-10-19

### Hinzugefügt

- **Anmeldung für Weboberfläche und API (`auth` in `config.yaml`):** `mode: none` (Default, Verhalten wie bisher),
  `password` (eingebaute Benutzer; Passwort nur als scrypt-Hash in einer Umgebungsvariablen, erzeugt mit dem neuen
  Befehl `adispatch auth hash-password`; Login-Seite, Session-Cookie `HttpOnly; SameSite=Strict`, `Secure` über HTTPS,
  Sessions im Speicher mit `session_ttl`, Rate-Limit je IP und Benutzer, keine Benutzer-Enumeration) oder
  `trusted_header` (Identität vom vorgeschalteten Proxy wie Tailscale Serve oder oauth2-proxy, nur von
  `trusted_proxies`). Rollen `viewer`, `operator`, `admin` mit einer Mindestrolle je Endpunkt (Tabelle in
  `docs/api.md`); `read_requires_login: false` erlaubt Lesen ohne Anmeldung. Neue Endpunkte `POST /api/v1/auth/login`,
  `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`. Die UI zeigt Benutzer, Rolle und „Log out“ und deaktiviert
  Schaltflächen ohne passende Rolle. CLI-Steuerbefehle arbeiten über einen lokalen Steuer-Token
  (`<data-dir>/control.token`, `0600`, nur über Loopback und den Port der Instanz, Rolle `operator` nur für die Routen der
  CLI-Befehle – Worker können ihn lesen). Optional `auth.trusted_header.proxy_secret_env` (Geheimnis des Proxys in
  `X-Adispatch-Proxy-Secret`); ohne es und mit einem Loopback-Proxy (Tailscale Serve) ist die Identität lokal fälschbar
  (Warnung beim Start). Audit: schreibende Aktionen stehen mit Benutzer im Dienstlog,
  Run-Aktionen zusätzlich als Run-Event `audit.user_action`. Einrichtung: `docs/operations.md`.

- **In der UI als Identity handeln:** Administratoren können auf ein Issue/PR als eine konfigurierte Identity (z. B. die
  `maintainer`-App) antworten, Labels setzen/entfernen und Projektfelder ändern – neues Item-Panel (aus Run-Detail,
  View-Zeilen und der Seite „UI Actions“ mit Suche nach URL/`owner/repo#nr`) mit Bestätigungsdialog vor jedem Senden.
  Freischaltung je Identity mit `ui_actions: true` in `identities.yaml` (Default aus); nur mit Anmeldung (`auth.mode` ≠
  `none`, sonst Warnung bei `config validate`), nur für echte Benutzer (nie mit dem Steuer-Token); bei lokal
  fälschbarem `trusted_header` (ein Loopback-Eintrag in `trusted_proxies` ohne `proxy_secret_env`) ist
  `ui_actions: true` ein Konfigurationsfehler. Kommentare, die nach einem Secret aussehen, werden abgelehnt (nie still
  verändert, best effort); HTML-Kommentare werden entschärft; Kommentare werden nie automatisch wiederholt, ein
  identischer Kommentar innerhalb von 60 s wird abgewiesen. Labels/Projektfelder idempotent über den
  `source.update`-Pfad; neue Labels nur nach ausdrücklicher Bestätigung (`create: true`). Je Benutzer höchstens 20
  Aktionen und 60 Item-Abrufe pro Minute. Neue Endpunkte `GET /api/v1/items/resolve`, `GET /api/v1/items/:source/:item`,
  `POST …/comment`, `…/labels`, `…/project`, `GET /api/v1/ui-actions` (Rolle `admin`). Jede Aktion wird protokolliert
  (neue Tabelle `ui_actions`, Datenbank-Schema v4, Migration automatisch beim Start; Kommentar-URL, nie der Text;
  Aufbewahrung `retention.ui_actions`, Default 365 Tage).

- **Server-Ressourcen im Dashboard:** neuer Bereich „Server“ mit gestapeltem CPU-Diagramm über die Zeit (Daemon, jeder
  aktive Run mit stabiler Farbe je Workflow und Link zum Run, Hooks/Checks des Daemons, die größten fremden Prozesse
  nach Namen, „Others“ und der nicht zuordenbare Rest bis zur Gesamtauslastung; Skala 0–100 % der Gesamtkapazität),
  Diagrammen für RAM (belegt/verfügbar) und freien Plattenplatz (data-dir und – falls anderes Dateisystem –
  `workspace.base_dir`), aktuellen Werten (CPU, Load, RAM, Platte) als Zahlen und Tabelle, Tooltip je Zeitpunkt,
  Zeitraum-Auswahl und Live-Aktualisierung per SSE. Eigenes SVG-Rendering ohne Bibliotheken, Hell/Dunkel.
- **Messung:** CPU aus den `os.cpus()`-Zeiten, RAM über `MemAvailable` (Linux) bzw. `vm_stat` (macOS), Platte über
  `statfs`, Prozesse unter Linux aus `/proc/<pid>/stat` (CPU- und Startzeit in Clock-Ticks), sonst über eine
  `ps`-Ausführung je Intervall (`execFile`, Timeout, Ausgabe begrenzt); Namen aus `comm`/`ucomm`, nicht dem
  umschreibbaren `argv[0]` oder der Kommandozeile; CPU je Prozess als Rate der CPU-Zeit, Prozesse über PID und Startzeit
  erkannt (Namenswechsel wie `exec` behalten die Reihe; mit Linux-`ps` als Fallback über bis zu 60 s gemittelt). API mit serverseitigem Downsampling (`range`,
  `points`, Default höchstens 600 Punkte). Zuordnung zu Runs über Prozessgruppe/Prozessbaum, bei
  Container-Runs zusätzlich `<engine> stats`. **Nur Befehlsnamen, nie Argumente.** Messungen laufen nie parallel;
  Fehler (z. B. fehlendes `ps`) werden gedrosselt geloggt und lassen den Teilwert leer. Werte nur im Speicher
  (Ringpuffer, gehen beim Neustart verloren).
- **Konfiguration `monitoring`** in `config.yaml` (alles optional): `enabled` (`true`), `interval` (Default
  `scheduler.polling_interval`, 5 s … 60 s), `retention` (`6h`, 10 … 5 000 Intervalle), `top_processes` (`5`),
  `min_cpu_percent` (`2`). Die Konfigurationsseite zeigt die Werte.
- **API:** `GET /api/v1/system/metrics?since=<ISO>` und SSE-Event `system.metrics`.
- **Conditions sichtbar (WI-24):** Shell-Prüfungen in `conditions.workflow[]`, `conditions.item[]` und `shell_filter`
  haben ein optionales Feld `name` (1–80 Zeichen; abwärtskompatibel). Workflows → Workflow-Detail (Bereich
  „Conditions“) und kompakt die Workflow-Liste zeigen jede Prüfung mit Anzeigename (sonst `command` + `args`, gekürzt),
  Timeout, Cache und dem letzten Status: Workflow-Conditions grün = ok, rot = nicht jetzt, gelb = Prüffehler, grau =
  nicht ausgewertet/nie geprüft – mit Zeitpunkt, Dauer, Cache-Treffer, Exit-Code und erster stderr-Zeile (redigiert);
  Item-Conditions und `shell_filter` als Zusammenfassung des letzten Planungsschritts (ok / nicht jetzt / Fehler).
  Der Scheduler hält den Status im Speicher und verwirft ihn beim Reload für geänderte Workflows. Dry-Run (CLI, API,
  UI) und Ablehnungsgründe nennen den Anzeigenamen. SSE-Event `workflow.conditions` bei Statusänderungen.
- **Info-Kacheln im Dashboard (WI-24):** neue optionale Datei `dashboard.yaml` mit `info: [{id, title, type: text |
  number | percent, command, args, env, timeout, cache, unit, warn_above, critical_above, warn_below,
  critical_below}]`. Der Daemon führt die Skripte nur im Hintergrund aus (beim Start, nach Ablauf von `cache`, nach
  Reload für neue/geänderte Kacheln), nie durch einen Seitenaufruf; höchstens eine Ausführung je Kachel und zwei
  insgesamt; Mechanik wie Conditions (keine Shell, Minimalumgebung + `env`, Timeout mit Prozessgruppen-Kill,
  Ausgabelimit, Arbeitsverzeichnis config-dir). Wert = erste stdout-Zeile; Fehler zeigen eine kurze Meldung (`exit code 2: …`) und behalten
  den letzten gültigen Wert; Werte, Meldungen und stderr-Zeilen werden von ANSI-/Steuer-/Bidi-Zeichen bereinigt,
  redigiert und erst dann gekürzt; `nextAttemptAt` zeigt den nächsten (Wiederholungs-)Abruf. Dashboard-Bereich „Information“ mit Wert, Einheit, Prozentbalken,
  Farbe nach Schwellwerten, Zeitpunkt und gedrosseltem „Refresh“-Knopf. API `GET /api/v1/dashboard/info`,
  `POST /api/v1/dashboard/info/:id/refresh` (CSRF-/Host-/Origin-Schutz, 429 bei Drosselung), SSE `dashboard.info`.
  Validierung beim Laden und bei `config reload` (Schema mit „did you mean …“, eindeutige IDs, Schwellwerte nur bei
  `number`/`percent`, `cache` ≥ 10 s, `timeout` ≤ 5 min und ≤ `cache`, Skript existiert); Teil des Konfigurations-Hashs und der Dateiliste.
  `init` und `examples/config` legen eine Kachel „Plattenbelegung des data-dir“ an.
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

- **Datenbank-Schema v4** (Migration beim ersten Start, vorher automatisches Backup unter `backups/`). Einbahnstraße:
  0.3.x startet mit einer v4-DB nicht mehr; zurück nur über das Backup (siehe `docs/operations.md`, Rollback).
- `GET /api/v1/workflows[/:id]`: `conditions` enthält jetzt die Definitionen samt letztem Status
  (`{workflow: [...], item: [...], shellFilter}`) statt nur der Anzahlen (`{workflow: <n>, item: <n>}`); die Anzahl
  ist die Länge der Listen.
- Die Content-Security-Policy der Weboberfläche kommt als HTTP-Header statt als `<meta>`-Tag (Inhalt unverändert) und
  erlaubt `frame-src` genau für die Origins der aktivierten eingebetteten Tools; ein Reload der Konfiguration wirkt sofort
  für neu geladene Seiten.

### Hinweis

- Die UI zeigt die Befehlsnamen fremder Prozesse des Servers – UI nur hinter Authentifizierung freigeben oder
  `monitoring.enabled: false` setzen.

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

[0.9.1]: https://github.com/brokoskokoli/adispatchd/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/brokoskokoli/adispatchd/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brokoskokoli/adispatchd/releases/tag/v0.1.0
