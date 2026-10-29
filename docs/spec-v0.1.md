# Agent Dispatch Daemon (`adispatchd`) – Technische Spezifikation v0.1

> **Name:** Agent Dispatch Daemon – npm-Paket, Repository, systemd-Unit und Standardpfade `adispatchd`, CLI-Befehl `adispatch`. Ursprünglicher Arbeitsname: „Agent Orchestrator“ (`agent-orchestrator`); alle Bezeichner wurden entsprechend umbenannt (z. B. Umgebungsvariablen `ADISPATCH_*` statt `ORCH_*`, Kommentar-Marker `adispatchd:` statt `orch:`).

**Status:** Umgesetzt bis Version 0.10.0 (Artefakte: WI-35; Hub: WI-36 Kern, WI-37 API und Weboberfläche, WI-38 Betrieb; npm `adispatchd`). Ursprünglich technischer Entwurf v0.1; spätere Erweiterungen stehen als „Nachtrag 0.2.0 … 0.10.0 (WI-NN)“ an der jeweiligen Stelle, verbindliche Dateiformate in [configuration-reference.md](configuration-reference.md)  
**Ziel:** Eigenständig installierbarer, konfigurationsgetriebener Orchestrator für Shell-Prozesse und KI-Agenten  
**Technologie:** TypeScript, Node.js (unterstützte LTS-Version), SQLite, YAML, HTTP/SSE  
**Betrieb:** Linux (Produktion, systemd), macOS (lokal)  
**Stand:** 19. Oktober 2026 (Entwurf v0.1 vom 16. Oktober 2026)

> **Verbindlichkeit:** „MUSS“ bezeichnet einen für Version 1 festgelegten Funktionsumfang. „SOLL“ bezeichnet eine technische Empfehlung. Explizit als „offen“ gekennzeichnete Punkte sind vor Umsetzung zu entscheiden oder durch einen Prototyp zu validieren. Die YAML- und API-Formate sind vorgeschlagene normative Verträge für v0.1; ihre genaue Schreibweise wurde nicht einzeln vom Auftraggeber freigegeben.

## 1. Produktziel und Leitprinzipien

Der Orchestrator findet Aufgaben in austauschbaren externen Quellen, wählt sie anhand von Filtern und Prioritäten aus, prüft Startbedingungen und führt unabhängige Shell-Workflows aus. Er überwacht und protokolliert jeden Ausführungsversuch, führt deklarative oder skriptbasierte Lifecycle-Aktionen aus und zeigt Ausführung und Diagnose in einer kleinen Weboberfläche an.

1. **Source of Truth extern:** Insbesondere GitHub Issues/PRs behalten ihre fachlichen Zustände, Kommentare und Abhängigkeiten. Es gibt **keine zweite Aufgaben-Datenbank**.
2. **Runs intern persistent:** SQLite verwaltet Ausführungsstatus, Sperren, Events, Ergebnisse, technische Fehlversuche, Blocks, Lifecycle-Aktionsjournale und Systembenachrichtigungen. Große Logs werden als Dateien abgelegt.
3. **Unabhängige Workflows:** Ein Workflow hat einen Trigger, einen Executor und Lifecycle-Hooks. Er kennt keine übergeordnete Pipeline; aufeinanderfolgende Verarbeitungsschritte werden durch Änderungen am externen Item ausgelöst.
4. **Austauschbarkeit:** Sources, Filter, Actions, Identities und Executors haben interne TypeScript-Interfaces. V1 enthält einen GitHub-Adapter und einen Shell-Executor; kein externes Plugin-System.
5. **Konfiguration statt Codeänderung:** Workflows, Views und Quellen werden als YAML-Dateien gepflegt und manuell neu geladen.
6. **Einzelner Controller:** Nur eine aktive Instanz pro `data-dir`; keine verteilte Orchestrierung in v1.
7. **Rollenidentitäten:** Eine GitHub-App-Identität pro Rolle (z. B. Coder, Reviewer), nicht pro Run. Rollen können mehrere parallele Runs ausführen.

## 2. Funktionsumfang V1 und bewusste Grenzen

**V1 enthält:** GitHub Source (Issues und PRs, soweit Adapter-Feld/Action unterstützt); natives GitHub-„blocked by“ über Repo-Grenzen; Source-, Cron- und Manual-Trigger; deklarative Filter sowie Shell-Filter nur bei Workflows; Workflow- und Item-Prioritäten; Shell-Conditions; globale und workflowbezogene Parallelität; manuelle Starts mit Overrides; pro Run eigenen Workspace; Worker-Kontext und -Ergebnis als JSON; isolierte Env/Secrets; stdout/stderr und optionale strukturierte Events; Lifecycle-Hooks mit Source-Aktionen und Shell-Aktionen; Retry von Lifecycle-Aktionen; technische Fehlversuch-Limits und manuell lösbare Blocks; Live-Updates per SSE; Runs-/Blocks-/Action-GUI; konfigurierbare read-only Views über mehrere Sources mit optionalen internen Run-Feldern; zentrale Systembenachrichtigungen; Konfigurationsvalidierung und Dry-Run; `npx`/npm-CLI und systemd-Integration.

**Nicht V1:** eigener Ticketstore, grafischer Workflow-Editor, interaktive View-Filter, mehrstufige Pipeline-Engine, externe npm-Plugins, nativer Docker-Executor, Workflow-Templates, koordinierte Multiinstanzen, Job-Pause/Resume, Windows-Support, Benutzerverwaltung, Identitätspools und gemeinsame Ressourcenpools.

## 3. Grobarchitektur

```text
                 config/*.yaml
                       |
             Config Loader / Validator
                       |
      +----------------+----------------+
      |                |                |
 Source Adapters   Trigger Engine   View Engine
 (GitHub)          (poll/cron)      (read-only)
      |                |                |
      +-------> Candidate Collector     +----> HTTP API/UI
                       |
          Filter / Priority / Conditions
                       |
                    Scheduler <--- Run-/Block-Store (SQLite)
                       |
                 Run Controller
             /          |           \
      Lifecycle     Shell Executor    Event/Log Writer
        Actions         |                  |
           |         Worker          SQLite + Log Files
 Source API / Shell   (workspace)
                       |
               HTTP API + SSE -> Web UI
```

**Komponenten:** `config`, `sources`, `identities`, `filters`, `triggers`, `scheduler`, `runs`, `executors`, `lifecycle`, `persistence`, `views`, `notifications`, `api`, `ui`, `cli`.

## 4. Dateisystem, Distribution und Installation

```text
config-dir/
  config.yaml
  sources.yaml
  identities.yaml
  workflows/
    coder.yaml
    reviewer.yaml
    nightly-maintenance.yaml
  views/
    needs-maintainer.yaml
  filters/                  # Nachtrag 0.2.0 (WI-15): benannte Filter
    needs-maintainer.yaml
  dashboard.yaml            # Nachtrag 0.4.0 (WI-24): Info-Kacheln, optional
  scripts/
    coder.sh
    check-credits.sh
    info/data-disk.sh

data-dir/
  adispatchd.sqlite
  logs/<run-id>/stdout.log
  logs/<run-id>/stderr.log
  runs/<run-id>/context.json
  runs/<run-id>/result.json
  workspaces/<workflow>/<run-id>/
  backups/
```

CLI-Parameter `--config-dir` und `--data-dir` MÜSSEN sowohl für lokalen Start als auch Serviceinstallation verfügbar sein. Ein separates `workspace.base_dir` MUSS konfigurierbar sein; Vorgabe `${dataDir}/workspaces`. Pfade werden normalisiert und gegen ungewolltes Path-Traversal abgesichert. Worker-Workspaces sollen nicht automatisch bei Konfigurations-Reload gelöscht werden.

**Vorgeschlagene CLI:**

```bash
npx adispatchd init --config-dir ./config --data-dir ./data
npx adispatchd start --config-dir ./config --data-dir ./data
adispatch config validate --config-dir ./config
adispatch config reload
adispatch workflow dry-run coder
adispatch service install --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd
adispatch service status
adispatch service uninstall
```

Paketname ist `adispatchd`, der CLI-Befehl (Binary) heißt `adispatch`; systemd-Unit, Dienstbenutzer und Standardpfade heißen `adispatchd`. `npx` ist für schnellen Start vorgesehen, **nicht als `ExecStart` eines dauerhaften Dienstes**. Für systemd wird eine fest installierte npm-Version direkt gestartet; die Unit verwendet absolute Pfade und einen dedizierten Dienstbenutzer. Updates aktualisieren Code, nicht `config-dir` oder `data-dir`; DB-Migrationen sind versioniert und werden vor Anwendung gesichert. Eine laufende Installation wird vor Updates per Drain beendet. Auf `SIGTERM` muss das Verhalten mit systemd eindeutig abgestimmt werden (siehe §14).

## 5. Konfigurationsmodell (vorgeschlagenes YAML-Schema)

### 5.1 Globale Einstellungen

```yaml
server:
  host: 127.0.0.1
  port: 8787

scheduler:
  polling_interval: 30s
  max_concurrent: 5

workspace:
  base_dir: /var/lib/adispatchd/workspaces
  cleanup: on_success  # always | on_success | never

lifecycle:
  action_retry:
    max_attempts: 3
    delay: 30s

retention:
  completed_runs: 30d
  failed_runs: 90d
  blocked_runs: never
  max_log_size_per_run: 100MB
  cleanup_interval: 24h

notifications:
  # Admin-/Orchestrator-Benachrichtigung; Kanaldefinition siehe §17
  on: [retry_block_created, lifecycle_action_failed, recovery_failed]
```

Logs dürfen bei Größenlimits nicht stillschweigend überschrieben werden: Rotations-/Trunkierungsereignis speichern; stdout und stderr möglichst getrennt. Run-Metadaten können länger als Logs aufbewahrt werden. Aktive Runs, offene Blocks und unfertige Aktionsketten sind von Cleanup ausgenommen.

### 5.2 Sources

```yaml
# sources.yaml
sources:
  project_a:
    type: github
    owner: example
    repository: project-a
    identity: maintainer

  project_b:
    type: github
    owner: example
    repository: project-b
    identity: maintainer
```

Ein Source-Workflow referenziert **genau eine** Source. Mehrere Workflows können dieselbe Source nutzen. Views können mehrere Sources desselben Adaptertyps referenzieren. Die Source-Identität (`identity`) ist ein möglicher Standard für lesende API-Aufrufe; die Workflow- oder Action-Identität kann sie für schreibende Aktionen überschreiben.

### 5.3 Identities und Secrets

```yaml
# identities.yaml
identities:
  maintainer:
    type: github_app
    app_id: 100001
    installation_id: 200001
    private_key_env: GITHUB_MAINTAINER_PRIVATE_KEY
  coder:
    type: github_app
    app_id: 100002
    installation_id: 200002
    private_key_env: GITHUB_CODER_PRIVATE_KEY
  reviewer:
    type: github_app
    app_id: 100003
    installation_id: 200003
    private_key_env: GITHUB_REVIEWER_PRIVATE_KEY
```

Die Secrets liegen nicht in YAML oder Run-Kontexten. Der Credential-Provider erzeugt kurzlebige Installation Tokens. GitHub Apps sind jeweils eigene Bot-Identitäten; alle parallelen Coder verwenden denselben Coder-Bot. Berechtigungen der Apps werden minimal gehalten. Kein Token wird standardmäßig an einen Worker durchgereicht.

**Nachtrag 0.2.0 (WI-14):** Zweiter Identity-Typ `github_token` mit `token_env` (Name der Env-Variable mit einem langlebigen Token, z. B. fine-grained PAT), vor allem für user-eigene GitHub Projects, die Installation-Tokens nicht lesen können. Der Token wird beim Start gelesen und redigiert; ein Composite-Provider leitet je Identity an den Provider ihrer Art. Marker-Kommentare solcher Identities werden am Login des Token-Users erkannt (`GET /user`). Eine GitHub-Source kann zusätzlich `project: { owner, number, identity, fields }` deklarieren (Details: [configuration-reference.md](configuration-reference.md) §3.2, §3.3).

**Nachtrag 0.3.0 (WI-18):** Tokens können statt als Env-Variable als **erneuerte Token-Datei** übergeben werden (`delivery: file` → `<NAME>_FILE`), damit lange Runs keine Private Keys brauchen; auch Shell-Actions können `secrets` deklarieren (siehe §20, Nachtrag).

### 5.4 Source-Workflow

```yaml
# workflows/coder-project-a.yaml
id: coder-project-a
name: Coder – Project A
enabled: true
priority: 50
max_concurrent: 3
identity: coder

trigger:
  type: source
  source: project_a

filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }

item_priority:
  rules:
    - when: { field: labels, operator: contains, value: 'priority:critical' }
      value: 100
    - when: { field: labels, operator: contains, value: 'priority:high' }
      value: 50
  default: 0

conditions:
  workflow:
    - type: shell
      command: /etc/adispatchd/scripts/check-credits.sh
      timeout: 15s
      cache: 60s
  item: []

execute:
  type: shell
  command: /etc/adispatchd/scripts/coder.sh
  working_directory: '{workspace.base_dir}/{workflow.id}/{run.id}'
  create_directory: true
  env:
    NODE_ENV: production
  secrets:
    GH_TOKEN:
      identity: coder
  timeout:
    max_duration: 6h
    idle_timeout: 45m

retry:
  max_technical_failures: 3

on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
  - type: source.comment
    message: 'Coder started, run {run.id}.'
    identity: coder

on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
  - type: source.comment
    message: 'Completed: {result.message}'
    identity: coder
    continue_on_error: true

on_failure:
  - type: source.update
    labels: { add: [needs-maintainer], remove: [coding] }
  - type: source.comment
    message: 'Needs maintainer: {result.message}'

on_crash:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }

on_start_error:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }

on_cancel:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }

on_timeout:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
```

Der im Beispiel enthaltene `on_start`-Kommentar ist optional. `source.update` und `source.comment` müssen über den Adapter typisiert implementiert werden. Bei einem GitHub-PR können Issue-Kommentare und Code-Reviews unterschiedliche API-Aktionen sein; für V1 ist `source.comment` als allgemeiner Issue-/PR-Konversationskommentar definiert, **kein Review-Submission-Ersatz**.

**Nachtrag 0.3.0 (WI-20) – Mehrere Sources und Source-Variablen:** Statt `trigger.source` darf `trigger.sources: [<id>, …]` stehen (nicht leer, eindeutig, alle Sources existieren und haben denselben Adaptertyp; `source` und `sources` schließen sich aus). Der Planer fragt jede Source ab; die Kandidaten aller Sources konkurrieren nach Item-Priorität, bei Gleichstand entscheidet die Reihenfolge der Liste, danach die bisherigen Tie-Breaker. Lock, Retry-Block und Historie bleiben pro globalem Item-Schlüssel `<source>:<nr>`. `max_concurrent` gilt für den Workflow insgesamt, optional begrenzt `max_concurrent_per_source` je Source. Fällt eine Source beim Pollen aus, laufen die anderen weiter (Diagnose je Source in API, Dry-Run und UI). `project.*` in Filter, `item_priority` und `source.update.project` nur, wenn alle Sources das Feld mit gleicher Art deklarieren (Regel wie bei Views); Pushdown und `state`-Regel je Source. Ein Run ist an die Source seines Items gebunden (Snapshot, `{source.*}`, Actions). Neu ist außerdem `sources.<id>.vars` (Map Name → String) mit dem Platzhalter `{source.vars.<name>}` überall, wo `{source.*}` verfügbar ist (auch bei einer Source); die Variable muss in allen Sources des Workflows definiert sein. Manuelle Starts leiten die Source aus der Item-Referenz ab (URL, `owner/repo#nr`, `<source>:<nr>`), eine mehrdeutige Referenz ist ein Fehler mit Hinweis. Details: [configuration-reference.md](configuration-reference.md) §3.2, §3.4.2, §5, §6.

### 5.5 Zeit- und manuell ausgelöste Workflows

```yaml
id: nightly-maintenance
name: Nightly Maintenance
priority: 20
max_concurrent: 1
trigger:
  type: schedule
  cron: '0 3 * * *'
  timezone: Europe/Berlin
execute:
  type: shell
  command: /etc/adispatchd/scripts/maintenance.sh
  working_directory: '{workspace.base_dir}/{workflow.id}/{run.id}'
```

```yaml
id: deploy
name: Deploy
trigger: { type: manual }
parameters:
  environment:
    type: enum
    values: [staging, production]
    required: true
  version:
    type: string
    required: true
execute:
  type: shell
  command: /etc/adispatchd/scripts/deploy.sh
```

Parametertypen: `string`, `number`, `boolean`, `enum`; dazu `required` und `default`. Validierung erfolgt vor dem Start. Schedule-/Manual-Workflows haben kein Source-Item und daher keine implizite Source-URL. Für Cron gilt zunächst: versäumte oder durch Conditions/Limits verhinderte Zeitpunkte werden **übersprungen**, nicht nachgeholt; gleiche Cron-Instanzen werden nicht aufgestaut. Zeitzonen und Sommerzeitfälle müssen getestet werden.

**Nachtrag 0.4.0 (WI-24) – Namen für Prüfungen, `dashboard.yaml`:** Jede Condition (`conditions.workflow[]`, `conditions.item[]`) und der `shell_filter` haben ein optionales Feld `name` (1–80 Zeichen) als Anzeigename in UI, Dry-Run und Ablehnungsgründen; ohne `name` wird `command` + `args` (gekürzt) angezeigt. Neue optionale Datei `dashboard.yaml` im config-dir mit einer Liste `info` von Info-Kacheln: `id` (eindeutig), `title`, `type` (`text` | `number` | `percent`), `command`, `args`, `env`, `timeout` (Default 15 s), `cache` (Default 5 min, mindestens 10 s), `unit` (nur `number`), Schwellwerte `warn_above`/`critical_above` bzw. `warn_below`/`critical_below` (nur `number`/`percent`). Die Skripte sind vertrauenswürdige Konfiguration wie Conditions, laufen aber **nur im Hintergrund** (Start, Ablauf von `cache`, Reload, gedrosselter manueller Abruf) mit derselben Mechanik (keine Shell, Minimalumgebung + `env`, Timeout mit Prozessgruppen-Kill, begrenzte Ausgabe, Arbeitsverzeichnis config-dir), höchstens eine Ausführung je Kachel und zwei insgesamt. Wert = erste nicht-leere stdout-Zeile; Exit ≠ 0, Timeout oder unlesbare Ausgabe ergeben einen Fehlerzustand, der letzte gültige Wert bleibt sichtbar. Die Datei wird beim Start und bei `config reload` geladen und validiert (Schema, IDs, Schwellwerte, Skript existiert) und ist Teil des Konfigurations-Hashs. Keine Secrets in V1. Details: [configuration-reference.md](configuration-reference.md) §3.4.6, §3.7.

**Nachtrag 0.7.0 (WI-31) – Auswahllisten zur Laufzeit für Parameter:** Ein `enum`-Parameter kann statt fester `values` den Schlüssel `options_from` haben (beides zusammen ist ein Fehler): `github: branches|tags` mit `source` (Default: die einzige Trigger-Source bzw. – ohne Trigger-Source – die einzige Source der Konfiguration), `limit` (1–500, Default 100), gelesen mit der Identity der Source (§6.10; Branches: Default-Branch zuerst, dann alphabetisch; Tags: neueste zuerst), oder `command` mit `args` (nur Platzhalter der Gruppe „always“), `secrets` (wie Shell-Actions, WI-18), `timeout` (Default 10 s, ≤ 60 s) und `cache` (Default 1 min bei GitHub, 0 s bei Skripten). Das Skript läuft wie die Info-Kacheln (keine Shell, Minimalumgebung, Arbeitsverzeichnis config-dir, Prozessgruppen-Kill bei Timeout, begrenzte Ausgabe) und gibt eine Option pro Zeile oder eine JSON-Liste aus Strings/`{value, label}` aus (≤ 500 Optionen, Werte/Labels ≤ 200 Zeichen ohne Steuerzeichen). Optional `allow_custom` (auch mit statischen `values`): Werte außerhalb der Liste erlaubt. `default` wird bei `options_from`/`allow_custom` erst zur Laufzeit geprüft; automatische Workflows erhalten nur den `default` ohne Abruf, `options_from` ohne `default` ist dort ein Konfigurationsfehler. Beim manuellen Start prüft der Server Werte ohne `allow_custom` gegen die aktuelle (ggf. gecachte) Liste: nicht enthalten → 400 `invalid_parameters`, Liste nicht abrufbar → 502 `parameter_options_unavailable`. Ergebnisse (nur Erfolge) liegen `cache` lang im Speicher, gleichzeitige Abrufe werden zusammengelegt, ein Parameter wird höchstens alle 2 s (Skript) bzw. `max(30 s, cache)` (GitHub) neu geholt. API `GET /api/v1/workflows/:id/parameters/:name/options` (`refresh=true` umgeht den Cache, nur ab `operator`; Rolle `viewer`, bei Skript-Optionen `operator`); die Workflow-Ansicht beschreibt `optionsFrom` (ohne Skript-Argumente) und `allowCustom`. Das Startformular lädt die Listen beim Öffnen (Suche ab 16 Optionen, „Reload“, Lade-/Fehlerzustand; mit `allow_custom` Eingabefeld mit Vorschlägen). Item-Auswahl per Filter ist nicht Teil davon. Details: [configuration-reference.md](configuration-reference.md) §3.4.7, [api.md](api.md).

## 6. Filter und Abhängigkeiten

Eine gemeinsame deklarative Filter-AST unterstützt `all`, `any`, `not` sowie mindestens `equals`, `not_equals`, `contains`, `in`, `greater_than`, `less_than` (vergleichbare Typen). Der Adapter kann Teile der Filter an die externe API pushen; verbleibende Prädikate werden lokal ausgewertet. Für eine unbekannte/fehlgeschlagene Bedingung gilt eine **dreiwertige Semantik**: `true`, `false`, `unknown`. `unknown` ist für automatische Ausführung nicht startfähig und wird diagnostizierbar angezeigt.

**GitHub Dependencies:** Die native `blocked by`-Relation muss über die GitHub-API aufgelöst werden, einschließlich referenzierter Issues in anderen Repositories, sofern die verwendete App darauf Zugriff besitzt. Ableitbare Felder: `dependencies.blocked_by_total`, `dependencies.blocked_by_open`, `dependencies.blocked` (optional), `dependencies.status`. Eine offene Abhängigkeit verhindert einen Start **nur dann**, wenn der Workflow dies ausdrücklich filtert. Fehlender API-Zugriff ist nicht „0 offene Abhängigkeiten“. Die tatsächliche API-Verfügbarkeit, Berechtigungen und Cross-Repo-Eigenschaften sind per Integrationstest gegen GitHub zu prüfen.

**Nachtrag 0.2.0 (WI-14) – Feldkatalog:** Billige Issue-Felder `state_reason`, `milestone` (Titel), `issue_type` (Name des Issue-Typs). Dazu je Source die deklarierten GitHub-Projects-Felder `project.<Name>` (Arten `single_select`/`text`/`iteration` → string, `number`, `date`), gelesen per GraphQL im selben Planungsschritt, nicht teuer, ohne Pushdown. Item nicht im Projekt → `null`; Projekt nicht erreichbar, Feld fehlt/falsche Art, Abfragefehler → nur die betroffenen `project.*` `unknown` (Grund über `SourceItem.unknownFields`), das Listing scheitert nicht. Die Offline-Validierung kennt `project.*` je Source (Views: nur gemeinsame Felder). Details: [configuration-reference.md](configuration-reference.md) §4.7.1.

**Nachtrag 0.2.0 (WI-15) – Benannte Filter:** Filter können einmal in `filters/<id>.yaml` (`id`, optional `description`, `filter`) definiert und überall im Filterbaum per `{ use: <id> }` bzw. als Kurzform `filter: <id>` verwendet werden (Workflow-`filter`, `item_priority.rules[].when`, View-`filter`, andere benannte Filter). Referenzen werden beim Laden expandiert; Scheduler, Views, Pushdown und Dry-Run sehen nur den eingesetzten Baum (Position nach dem Einsetzen zählt). Unbekannte IDs, Zyklen und Ketten tiefer als 16 Ebenen sind Konfigurationsfehler; Feldprüfungen laufen am Verwendungsort; unbenutzte Filter ergeben eine Warnung. Details: [configuration-reference.md](configuration-reference.md) §3.6.

**Nachtrag 0.3.0 (WI-21) – Verknüpfte Branches und PRs:** Teure GitHub-Felder `linked_branches` (string[]: unter „Development“ verlinkte Branches des Repositorys), `closing_prs` (neuer Feldtyp `object[]`: `{ number, state, head_ref, is_draft, url }` der PRs des Repositorys, die das Issue schließen; offen → gemergt → geschlossen, je nach Nummer), abgeleitet `work_branch` (erster verlinkter Branch, sonst Branch des ersten offenen, dann des ersten gemergten PRs) und `work_pr` (erster offener PR) sowie `work_pr_url` als Link-Ziel in Views. Pull-Request-Items: eigener Branch (bei PRs aus einem Fork `null`), eigene Nummer solange offen; PRs aus Forks zählen bei Issues nur für `work_pr`, nicht für `work_branch`. Alle aus **einer** GraphQL-Abfrage pro Item (`linkedBranches(first: 20)`, `closedByPullRequestsReferences(first: 20, includeClosedPrs: true)`); jeder Fehler, Teilfehler, mehr Treffer als gelesen oder ein Rate-Limit macht alle unknown (Rate-Limit-Pause wie WI-14). `object[]`-Felder haben keine Operatoren (Validierungsfehler mit Hinweis auf `work_pr`), sind aber in Views und der Kontextdatei verfügbar. Platzhalter `{item.work_branch}`/`{item.work_pr}` in `execute` und Actions werden direkt vor dem Rendern frisch gelesen; unknown → `start_error` vor `on_start` (ohne Hooks) bzw. scheiternde Action, nie ein leerer String; ein bekannt leerer Wert (`null`) wird zum leeren String, in `working_directory` dagegen `start_error` vor `on_start`. Branch-Namen sind untrusted (Shell-Metazeichen möglich). Details: [configuration-reference.md](configuration-reference.md) §4.7.2, §5.3.

**Shell-Filter:** Nur für Workflows. Jeder Aufruf bekommt den einzelnen Item-Kontext; Exit `0` = passt, Exit `1` = passt nicht, Exit `>=2` = Prüffehler. Shell-Conditions verwenden dieselbe Konvention, sind aber eigenständige Startprüfungen. Die Exit-Code-Semantik gilt für diese Prüfskripte, **nicht automatisch für den Haupt-Worker**. Workflow-Conditions können gecacht werden; itembezogene nicht notwendigerweise. Timeouts sind konfigurierbar. Views führen keine Shell-Skripte aus.

## 7. Scheduler

**Priorisierung:** Zuerst absteigend nach Workflow-Priorität, danach absteigend nach Item-Priorität innerhalb desselben Workflows; als deterministischer Tie-Breaker Item-ID/Erstellungszeit. Ein `priority:high`-Item im Coder-Workflow überholt damit nicht grundsätzlich einen Review-Workflow höherer Workflow-Priorität. Starvation-Aging ist kein V1-Feature.

**Planungsschritt:**

1. Aktive Sources pollen (Vorgabe alle 30 s); passende Kandidaten per günstigen Filtern entdecken.
2. Doppelte Kandidaten normalisieren (`source-id`, `item-id`, `workflow-id`).
3. Prioritäten bestimmen und Kandidaten in deterministischer Reihenfolge betrachten.
4. Bereits aktive identische Workflow/Item-Runs und persistente Retry-Blocks ausschließen.
5. Aufwendige deklarative Filter (z. B. Dependencies), Shell-Filter und Conditions **lazy** prüfen.
6. Globale und workflowbezogene Slots prüfen; bei freien Kapazitäten Run reservieren und starten.
7. Wenn ein Kandidat nicht startfähig ist, nächsten Kandidaten prüfen; hoch priorisierte gesperrte Kandidaten dürfen den Scheduler nicht blockieren.
8. Beim nächsten Polling erneut aus der Source lesen; keine persistente Warteschlange für bloße Kandidaten.

**Nachtrag 0.10.0 (WI-36):** Unter einem Hub kommt als letztes das gemeinsame Limit `hub.max_concurrent` hinzu (Entscheidung `hub_limit`, siehe §21); der Platz wird vor der synchronen Reservierung angefragt und bei jedem Abbruch zurückgegeben.

**Concurrency:** Globales `max_concurrent` und `workflow.max_concurrent` gelten für automatische Starts. Manuelle Starts umgehen **alle** Filter, Conditions, Retry-Blocks, Prioritäten und Parallelitätslimits. Sie **dürfen nicht** den aktiven Eindeutigkeits-Lock `(workflow_id, source_item_key)` umgehen. Manuelle Runs zählen zur tatsächlichen Auslastung, sodass der Scheduler bis zum Unterschreiten der Limits keine weiteren automatischen Runs startet. Unterschiedliche Workflows dürfen dasselbe Item parallel bearbeiten.

**Rennen/Änderungen:** Vor `on_start` das externe Item bei Source-Workflows erneut lesen, um veraltete Bedingungen möglichst zu vermeiden. Die Reservierung erfolgt atomar in SQLite. Eine echte transaktionale Atomizität zwischen SQLite und GitHub ist nicht möglich; Recovery- und Aktionsjournale müssen mit Teilfehlern umgehen. Bereits laufende Runs werden durch spätere Änderungen an GitHub nicht automatisch abgebrochen.

**Cron:** Die Cron-Engine erzeugt pro Termin höchstens einen automatischen Run. Keine Queue für verpasste Termine. Termin wird verworfen, wenn zu diesem Zeitpunkt Filter/Conditions/Limits scheitern. Für wiederkehrende Workflows ohne Item wird der Ausführungs-/Blockschlüssel aus Workflow und Cron-Slot bzw. Workflow-ID gebildet.

## 8. Run-Lifecycle und Statusmodell

### 8.1 Getrennte technische Zustände und fachliche Ergebnisse

**Technischer Run-Zustand:** `reserved`, `starting`, `running`, `cancelling`, `finalizing`, `completed`, `crashed`, `start_error`, `timed_out`, `cancelled` (technische Erweiterung: `recovery_pending`).

**Fachliches Ergebnis:** `success`, `failure` oder `null` (bei technischen Abbrüchen ohne gültiges Ergebnis).

`failure` bedeutet: Der Worker hat seine Aufgabe kontrolliert beendet und meldet „fachlich nicht lösbar/Needs Maintainer“. **Dieses Ergebnis zählt nicht** als technischer Retry-Fehler. `crashed`, `start_error` und `timed_out` zählen; `cancelled` zählt nicht. Ein unkontrollierter Exit ohne gültiges fachliches Ergebnis ist technisch und soll nicht fälschlich zu `failure` werden.

### 8.2 Haupt-Worker-Ergebnisvertrag

Der Exit-Code des Haupt-Workers beschreibt ausschließlich den **technischen Erfolg oder Misserfolg der Prozessausführung**. Das fachliche Ergebnis wird unabhängig davon über die optionale JSON-Ergebnisdatei (`ADISPATCH_RESULT_FILE`) übermittelt.

Es gelten folgende verbindliche Regeln:

| Exit-Code | Ergebnisdatei | Interpretation |
|---|---|---|
| `0` | `result: success` | Technisch erfolgreich, fachlich erfolgreich |
| `0` | `result: failure` | Technisch erfolgreich, fachlich fehlgeschlagen |
| `0` | Keine Ergebnisdatei | Technisch erfolgreich, implizit fachlich erfolgreich |
| `0` | Ungültige Ergebnisdatei | Technischer Protokollfehler (`crashed`) |
| `!= 0` | Beliebig | Technischer Fehler (`crashed`), unabhängig vom Inhalt der Ergebnisdatei |
| Prozess durch Signal beendet | Beliebig | Technischer Fehler (`crashed`), sofern nicht durch Cancel oder Timeout verursacht |
| Prozess konnte nicht gestartet werden | — | `start_error` |
| Prozess überschreitet Timeout | Beliebig | `timed_out` |
| Prozess wird kontrolliert abgebrochen | Beliebig | `cancelled` |

**Verbindliche Grundsätze:**

1. Ein fachliches `failure` MUSS ausdrücklich durch eine gültige JSON-Ergebnisdatei mit `result: "failure"` gemeldet werden. Ein Exit-Code allein darf niemals als fachlicher Fehler interpretiert werden.
2. Jeder Exit-Code ungleich `0` gilt als technischer Fehler. Eine vorhandene Ergebnisdatei darf diese Interpretation nicht überschreiben.
3. Ein Exit-Code `0` ohne Ergebnisdatei gilt aus Kompatibilitätsgründen mit einfachen Shell-Skripten als impliziter fachlicher Erfolg.
4. Eine vorhandene Ergebnisdatei MUSS dem definierten JSON-Schema entsprechen. Ungültige, unvollständige oder nicht lesbare Ergebnisdateien gelten als technische Protokollfehler.
5. Technische Fehler erhöhen den technischen Retry-Zähler und unterliegen den konfigurierten Retry- und Block-Regeln. Kontrollierte Abbrüche (`cancelled`) sind davon ausgenommen.
6. Fachliche Fehler lösen `on_failure` aus, erhöhen jedoch nicht den technischen Retry-Zähler.
7. Bei technischen Fehlern wird der jeweils passende Lifecycle-Hook (`on_crash`, `on_start_error` oder `on_timeout`) ausgeführt. Bei kontrolliertem Abbruch wird `on_cancel` ausgeführt. Ein fachliches Ergebnis aus einer möglicherweise vorhandenen Ergebnisdatei wird dabei nicht als maßgebliches Ergebnis übernommen.

**Beispiel für einen fachlichen Fehler:**

Der Worker erkennt, dass eine Aufgabe aufgrund fehlender Anforderungen nicht abgeschlossen werden kann. Er schreibt:

```json
{
  "schema_version": 1,
  "result": "failure",
  "message": "OAuth-Anbieter nicht spezifiziert",
  "details": {
    "missing_information": ["OAuth provider", "Scopes"]
  }
}
```

Anschließend beendet er sich mit Exit-Code `0`.

Der Orchestrator interpretiert dies als kontrolliert abgeschlossene Prozessausführung mit fachlichem Ergebnis `failure` und führt `on_failure` aus.

**Beispiel für einen technischen Fehler:**

Ein Worker führt folgenden Befehl aus:

```bash
git clone https://github.com/example/project.git
```

Der Befehl schlägt aufgrund eines Netzwerkproblems fehl und das Skript beendet sich mit Exit-Code `1`.

Der Orchestrator interpretiert dies als technischen Fehler (`crashed`), erhöht den technischen Retry-Zähler und führt `on_crash` aus.

**Grundsatz:** Der Exit-Code bestimmt den technischen Ausführungsstatus; die Ergebnisdatei bestimmt ausschließlich bei technisch erfolgreicher Ausführung das fachliche Ergebnis.

### 8.3 Timeouts

`max_duration` misst die Gesamtlaufzeit des Workers; `idle_timeout` die Zeit seit der letzten empfangenen stdout-/stderr-Ausgabe oder eines strukturierten Events. Beide standardmäßig aus; Überschreitung beendet den Prozess und führt `on_timeout` aus. Timeout zählt zum technischen Fehlerlimit. Das Ausbleiben von Logs ist **kein Beweis für einen Hänger**.

## 9. Worker-Protokoll

Jeder Run bekommt einen **eindeutigen Workspace** (Standard mit `{workflow.id}/{run.id}`); `{run.id}` ist stabil und eindeutig. Zusätzliche Platzhalter: `{source.id}`, `{source.repository}`, `{item.number}`, `{timestamp}`. Alle interpolierten Pfadbestandteile werden sicher normalisiert/escaped. Das Verzeichnis wird vom Orchestrator erzeugt; Klonen, Git-Worktrees, Node-Installationen und gegebenenfalls Docker werden vom Skript selbst erledigt.

**Nachtrag 0.3.0 (WI-22) – Dateien sichern (`execute.keep`):** Eine Liste relativer Glob-Muster (`*`, `?`, `**`) plus optional `keep_max_size` (Größe, Default `100MB`, Summe pro Run). Nach dem Abschluss-Hook und vor dem Workspace-Cleanup kopiert der Daemon bei **jedem** Endstatus die passenden regulären Dateien mit relativer Struktur nach `data-dir/runs/<run-id>/kept/` (erst nach `kept.tmp/`, dann Rename; ein vorhandenes `kept/` wird bei fortgesetzter Finalisierung nicht überschrieben). Symlinks werden nie verfolgt, jede Datei wird mit `O_NOFOLLOW` geöffnet und über Inode und aufgelösten Pfad gegen den Workspace geprüft; Muster mit `..` oder absolute Muster sind Validierungsfehler. Secrets werden beim Kopieren redigiert – best effort, wie Logs (§20, §24.8): dieselbe byteweise Ersetzung wie für stdout/stderr mit den Secrets des Runs und den dem Daemon bekannten Tokens/Schlüsseln. Das Größenlimit zählt die geschriebenen Bytes; was es überschreitet, wird übersprungen; Treffer, Übersprungenes (mit Grund) und Muster ohne Treffer stehen im Run-Event `run.kept_files`. Die Dateien unterliegen der Run-Retention (§21). API: `GET /api/v1/runs/:id/kept` (Liste) und `GET /api/v1/runs/:id/kept/<pfad>` (Download als Attachment, sichere Pfadauflösung); UI: Run → Files. Gilt für jeden Executor, dessen Workspace auf dem Host liegt (`shell` und `container`). Details: [configuration-reference.md](configuration-reference.md) §3.4.8, [api.md](api.md).

### 9.1 Input

Umgebungsvariablen (Mindestmenge):

```text
ADISPATCH_RUN_ID=...
ADISPATCH_WORKFLOW_ID=...
ADISPATCH_SOURCE_TYPE=github          # nur wenn sourcegebunden
ADISPATCH_SOURCE_ITEM_ID=...
ADISPATCH_SOURCE_URL=...
ADISPATCH_CONTEXT_FILE=/.../context.json
ADISPATCH_RESULT_FILE=/.../result.json
ADISPATCH_WORKSPACE=/.../workspaces/coder/run-123
```

Zusätzlich steht eine JSON-Kontextdatei zur Verfügung:

```json
{
  "schema_version": 1,
  "run": { "id": "run-123", "trigger": "source", "started_at": "2026-10-16T19:00:00Z" },
  "workflow": { "id": "coder-project-a" },
  "source": {
    "id": "project_a",
    "type": "github",
    "item_id": "123",
    "url": "https://github.com/example/project-a/issues/123",
    "attributes": { "title": "Implement OAuth", "labels": ["coding"] }
  },
  "parameters": {},
  "workspace": { "path": "/var/lib/adispatchd/workspaces/coder-project-a/run-123" }
}
```

**Nachtrag 0.3.0 (WI-21):** `attributes` enthält zusätzlich `linked_branches`, `closing_prs`, `work_branch`, `work_pr`, `work_pr_url`, wenn der Workflow sie verwendet (Platzhalter in `execute` oder Feld in `filter`/`item_priority`); sie werden dann beim Start frisch gelesen.

Der Worker erhält ausschließlich eine Minimalumgebung und **ausdrücklich deklarierte** Env-Variablen/Secrets. Secrets werden nicht in Kontext-/Ergebnisdateien persistiert. Für GitHub CLI darf das für den Workflow erzeugte App-Installation-Token bei Bedarf als `GH_TOKEN` exponiert werden. Das verhindert keine Einsicht in Secrets durch den gestarteten Worker selbst; Shell-Executor sind als **vertrauenswürdige Programme mit begrenzten Rechten** zu behandeln.

### 9.2 Output

Optional schreibt der Worker atomar eine JSON-Ergebnisdatei an `ADISPATCH_RESULT_FILE` (temporäre Datei und Rename empfohlen):

```json
{
  "schema_version": 1,
  "result": "failure",
  "message": "OAuth-Anbieter nicht spezifiziert",
  "details": { "missing_information": ["OAuth provider", "Scopes"] },
  "artifacts": [
    { "type": "url", "name": "Draft PR", "url": "https://github.com/example/project-a/pull/142" }
  ]
}
```

Vorgeschlagene Limits: Ergebnisgröße begrenzen, JSON-Schema validieren, Strings in GUI escapen, sensible Felder redigieren. Ergebnisdatei ergänzt Exit-Code und Log; sie ersetzt nicht den technischen Prozessstatus.

**Nachtrag 0.3.0 (WI-17):** Optionales Feld `outcome` (benanntes Ergebnis im Format der Konfigurations-IDs, z. B. `"outcome": "needs_maintainer"`). `result` bleibt Pflicht und steuert Statistik und Retry-Zähler. Ein `outcome` im falschen Format wird ignoriert (Warnung am Run, Event `run.outcome_warning`), der Rest der Datei normal ausgewertet. Siehe §10 (Nachtrag) und [worker-protocol.md](worker-protocol.md).

### 9.3 Logs und Events

stdout und stderr werden als unveränderte Logs persistiert. Optional kann eine Zeile mit reserviertem Präfix ein Event transportieren:

```text
@@ADISPATCH_EVENT {"type":"status","message":"Tests laufen"}
@@ADISPATCH_EVENT {"type":"progress","value":60}
@@ADISPATCH_EVENT {"type":"question","message":"Welcher OAuth-Anbieter?"}
```

Events werden separat mit Run-ID und Zeitstempel in SQLite gespeichert, zudem per SSE an die GUI gesendet. Sie sind **nur informativ**, lösen keine Workflow-Transitionen aus. Ein `question`-Event startet keine automatische Rückfragefunktion. Letzte Statusmeldung kann auf Run-Karten erscheinen. Ungültige Event-Zeilen bleiben in Rohlogs und erzeugen optional einen Parser-Warnhinweis.

## 10. Lifecycle-Aktionen

Unterstützte Hooks: `on_start`, `on_success`, `on_failure`, `on_crash`, `on_start_error`, `on_cancel`, `on_timeout` (ab 0.3.0 zusätzlich `on_error`, `on_result.<outcome>`; ab 0.6.0 `on_retry_block`, `on_retry_unblock`, §11).

Aktionstypen V1:

- `source.update`: durch Adapter unterstützte Änderung am Source-Item (z. B. GitHub Labels).
  **Nachtrag 0.3.0 (WI-16):** zusätzlich `project: { <Feld>: <Wert> }` – setzt Felder des in `sources.yaml`
  deklarierten GitHub-Projekts (Option, Text, Zahl, Datum, Iteration; `null` leert). Erst Labels, dann
  Projektfelder; vorher frisch lesen und nur Abweichungen schreiben, fehlendes Item wird dem Projekt hinzugefügt.
  Schreib-Identity: `project.identity` der Source, wenn ausdrücklich gesetzt, sonst die der Action. Details:
  [Konfigurationsreferenz §3.4.11](configuration-reference.md#3411-actions).
- `source.comment`: Kommentar über Adapter, mit optionaler Action-Identity.
- `shell`: beliebiges Shell-Skript mit Run-/Result-Kontext, isolierter Umgebung und konfigurierbarem Timeout.

**Nachtrag 0.3.0 (WI-17) – benannte Ergebnisse und Sammel-Hook:**

- `on_result: { <outcome>: [Actions] }` (Workflow-Ebene, Schlüssel sind Konfigurations-IDs, leere Listen erlaubt, nur mit Ergebnisdatei – heute `execute.type: shell`). Nach `completed` läuft `on_result.<outcome>` **statt** `on_success`/`on_failure`, wenn die Ergebnisdatei dieses `outcome` liefert und der Eintrag existiert; sonst das bisherige Verhalten (ein `outcome` ohne Eintrag ergibt nur eine Warnung). Platzhalter `{result.outcome}`, View-Feld `run.last_outcome`.
- `on_error: [Actions]` läuft für `crashed`, `start_error`, `timed_out` und `cancelled`, wenn der spezifische Hook (`on_crash`, `on_start_error`, `on_timeout`, `on_cancel`) **nicht definiert** ist; eine leere Liste zählt als definiert. Nie beides. Die normalisierte Konfiguration unterscheidet deshalb „nicht angegeben“ (fehlt) von `[]`.
- Der gewählte Abschluss-Hook (`on_success`, `on_result.approved`, `on_error`, …) und das `outcome` werden mit dem Übergang nach `finalizing` persistiert (`runs.completion_hook`, `runs.outcome`, Schema v3); das Action-Journal führt die Kette unter diesem Namen. Recovery nach einem Neustart setzt genau diesen Hook fort. Runs aus älteren Versionen ohne gespeicherten Hook wählen ihn wie bisher (ihre Snapshots definieren alle Listen-Hooks).
- Dry-Run, API (`resultOutcome`, `completionHook`), SSE (`run.status` mit `outcome`/`hook`) und UI zeigen die Werte. Details: [configuration-reference.md](configuration-reference.md) §3.4.10, §6.8.

Hooks bestehen aus sequenziellen Actions. Standardmäßig wird eine fehlgeschlagene Action 3-mal (30 s Pause) versucht; danach bleibt die Kette an dieser Position stehen und wird als fehlerhaft angezeigt. `continue_on_error: true` lässt nach erschöpften Versuchen die nächsten Actions zu. Einzelne Actions können Retry-Vorgaben überschreiben. GUI unterstützt **Retry Action** und Wiederaufnahme der Kette, ohne den Haupt-Worker neu zu starten.

**Action-Journal:** Jede Action hat stabile ID/Ordinalposition und persistierte Zustände `pending`, `running`, `succeeded`, `failed`, `skipped`; jeder Versuch bekommt Zeit, Fehler und ggf. externe Referenz. Neustart darf erfolgreich bestätigte Actions nicht neu ausführen.

**Idempotenz:** Genau-einmal-Ausführung gegenüber GitHub ist ohne verteilte Transaktion nicht garantiert. `source.update` soll möglichst idempotent sein. `source.comment` enthält idealerweise eine eindeutige, unauffällige Run-/Action-Kennung, anhand derer vor Wiederholung eine bereits erfolgte Veröffentlichung gefunden werden kann. Bei unklarem Erfolg muss ein manueller Abgleich statt blindem Duplikat möglich sein. Bei Reverts nur die erwartete vorherige Änderung zurücknehmen; GitHub-Status vor dem Schreiben neu lesen, um manuelle Änderungen möglichst zu erhalten.

## 11. Retry-Blocks für technische Fehler

Ein technischer Fehler ist `crashed`, `start_error` oder `timed_out`; **fachliches** `failure` ist keiner. `cancelled` ebenfalls nicht. Standardvorschlag `max_technical_failures: 3` pro Workflow. Es zählen aufeinanderfolgende technische Fehler **derselben Workflow/Item-Kombination** seit dem letzten erfolgreichen Abschluss bzw. der letzten manuellen Entblockung. Zwischendurch erfolgte Bearbeitungen am GitHub-Issue setzen die Zählung **nicht** zurück. Fachliches `failure` löst seinen konfigurierten Hook aus und führt typischerweise zu `needs-maintainer`; es erzeugt keinen Retry-Block.

Bei Erreichen des Limits entsteht ein Datensatz `blocks(workflow_id, item_key, reason, created_at, ...)`. Für sourcefreie Cron- oder Manual-Workflows ist der Blockschlüssel workflowbezogen. Die GUI zeigt Blockursache, Quelllink, betroffene Runs und **Remove Block**. Entblocken gibt die nächste automatische Auswahl frei und startet eine neue Zählperiode; alte Runs/Logs bleiben erhalten. Manuelle Starts **umgehen Retry-Blocks**, aber nicht den aktiven Doppelstart-Lock.

**Wichtige Reihenfolge:** Beim technischen Fehler den Abschlusszustand und den Block konsistent persistieren; `on_crash`/`on_timeout` können die Source wieder auf `ready-for-coding` setzen. Der Block verhindert dann automatisch weitere Starts, selbst wenn der externe Filter wieder passt.

**Nachtrag 0.6.0 (WI-30) – Hooks beim Entstehen und Aufheben eines Retry-Blocks:**

- `on_retry_block: [Actions]` läuft im Run, dessen Übergang nach `finalizing` den Block erzeugt hat, als eigene Kette **nach** dem Abschluss-Hook (`on_crash`/`on_start_error`/`on_timeout`/`on_error`) – auch wenn dieser endgültig gescheitert ist und auch bei `start_error` ohne Hooks. Die Entscheidung wird mit `→ finalizing` am Run gespeichert (`runs.retry_block_hook`); Recovery setzt die Kette fort.
- `on_retry_unblock: [Actions]` läuft beim Aufheben (UI „Remove Block“, `POST /api/v1/blocks/:id/clear`) in einem **Lifecycle-Run**, den das Aufheben in derselben Transaktion anlegt: Trigger `unblock`, kein Worker, kein Workspace, Snapshot = beim Aufheben geladene Konfiguration. Er hält das Lock für `(Workflow, Item)` bis die Kette fertig ist (Workflow-Scope: weder Cron-Starts – `skipped_blocked`, Grund `unblock run <id> active` – noch manuelle Starts ohne Item – `409 unblock_run_active`), zählt nicht als technischer Fehler, setzt den Zähler nicht zurück, zählt nicht zu `max_concurrent` und nicht als `run.last_*` in Views. Endstatus `completed` + `success` bzw. `failure` (dann `lifecycle_action_failed`); der Block bleibt aufgehoben. Mit laufendem Run des Scopes wird das Aufheben bei nicht leerem Hook mit `409 block_run_active` abgelehnt; ohne Hook wie bisher (kein Run). Nicht abbrechbar; Retry/Skip einzelner Actions und Recovery wie bei jedem Run.
- Platzhalter `{block.id}`, `{block.failures}`, `{block.created_at}`, `{block.last_status}` in beiden Hooks, `{block.cleared_at}`, `{block.cleared_by}` nur in `on_retry_unblock` (sonst Konfigurationsfehler); `on_retry_unblock` hat kein `result.*`. Workflows ohne Item: nur `shell`.
- Neue, nicht standardmäßig aktivierte Benachrichtigung `retry_block_cleared`. Schema v5: `runs.trigger_type` erlaubt `unblock`, `runs.retry_block_hook`, `run_actions.hook` erlaubt die beiden Hooks, `blocks.last_status`, `blocks.cleared_run_id` (Migration mit Backup, kein Downgrade). Details: [configuration-reference.md](configuration-reference.md) §3.4.10, §5, §6.4.

## 12. SQLite-Datenmodell (logisches Schema)

Die Tabellen unten sind konzeptionell; DDL, Indizes, Fremdschlüssel und Migrationen sind vor Implementierung auszuarbeiten.

| Tabelle | Relevante Spalten | Zweck |
|---|---|---|
| `runs` | `id`, `workflow_id`, `trigger_type`, `source_id`, `source_item_key`, `source_url`, `config_snapshot`, `parameters_json`, `status`, `business_result`, `exit_code`, `pid`, `process_start_identity`, `workspace_path`, `started_at`, `finished_at`, `lifecycle_status`; ab 0.3.0 `outcome`, `completion_hook` (WI-17); ab 0.6.0 `retry_block_hook`, Trigger `unblock` (WI-30) | Versuche und Ausführungshistorie |
| `run_events` | `id`, `run_id`, `sequence`, `timestamp`, `type`, `payload_json` | Strukturierte Events |
| `run_actions` | `id`, `run_id`, `hook`, `ordinal`, `action_config_json`, `status`, `external_key`; ab 0.9.0 `effect_json` (WI-33) | Action-Journal |
| `action_attempts` | `id`, `run_action_id`, `attempt`, `started_at`, `finished_at`, `error_json` | Retry-/Fehlerdiagnose |
| `blocks` | `id`, `workflow_id`, `source_item_key_nullable`, `reason`, `created_at`, `cleared_at_nullable`, `generation`; ab 0.6.0 `last_status`, `cleared_run_id` (WI-30) | Persistente technische Blocks |
| `locks` | `workflow_id`, `source_item_key`, `run_id`, `acquired_at` | Aktive Reservierungen |
| `notifications` | `id`, `event_type`, `payload_json`, `delivery_state`, `attempts`, `created_at` | Systemmeldungen |
| `cron_firings` | `workflow_id`, `scheduled_for`, `run_id_nullable`, `decision` | Cron-Idempotenz und Diagnose |
| `item_history_gaps` (ab 0.9.0, WI-33) | `item_key`, `deleted_runs`, `newest_deleted_at` | Hinweis „ältere Einträge gemäß Aufbewahrung gelöscht“ im Item-Verlauf |
| `schema_migrations` | `version`, `applied_at` | Updates |

SQLite erhält Fremdschlüssel, WAL-Modus (wo sinnvoll) und atomare Transaktionen für Run-/Lock-Erstellung. Unique-Constraint für aktive `(workflow_id, source_item_key)`-Reservierungen; bei sourcefreien Runs passende Semantik nach Trigger. Historische Run-Konfigurationssnapshots sind wesentlich für Abschluss-Hooks nach Reload und Recovery. Persistenz jeder Run-Transition und jeder Action-Zustandsänderung hat Vorrang vor UI-Kosmetik.

**Hinweis:** Datenbank und Logdateien sind gemeinsam das Run-Journal. Inkonsistenzen zwischen ihnen müssen diagnostizierbar sein; bei DB-Erfolg und Dateischreibfehler ist ein Fehlerereignis zu speichern, statt einen vollständigen Log zu behaupten.

## 13. Prozess-Supervision und Cancel

Der Shell-Executor startet eine eigene Prozessgruppe und überwacht Spawn-Erfolg, Exit-Code, Signal und stdout/stderr. `Cancel` per GUI/HTTP: Run auf `cancelling` setzen, `SIGTERM` an die Gruppe, nach konfigurierbarem Grace-Timeout `SIGKILL`, Prozessende bestätigen, `on_cancel` abarbeiten und final `cancelled` setzen. Misslingt das Beenden, ist der Run **nicht** voreilig als abgeschlossen zu kennzeichnen. Andere Prozesse/Container, die ein Skript losgelöst startet, kann die Shell-Prozessgruppe unter Umständen nicht erfassen; das Skript trägt hierfür die Cleanup-Verantwortung.

**PID allein reicht nicht:** Beim erneuten Auffinden muss mindestens PID plus verlässliche Startidentität/OS-Prozesszuordnung verwendet werden. PID-Reuse darf nicht zum Töten eines fremden Prozesses führen. Für Linux sollte vor Produktionsfreigabe ein kleiner **Prozess-Supervisor-Spike** erproben, ob `systemd`-Scopes/cgroups oder ein dedizierter Wrapper für Crash-Recovery und kontrolliertes Töten erforderlich sind. Bei unsicherer Identität niemals blind eine PID terminieren.

**Nachtrag 0.3.0 (WI-19) – Container-Executor:** `execute.type: container` (Schlüssel `image`, `engine` = `docker`|`podman` mit Default aus `config.yaml` `container.engine`, `command`, `workdir`, `mounts`, `resources`, `user`, `network`, `pull`; `env`, `secrets`, `timeout`, `cancel_grace`, `keep` wie bei `shell`). Der Daemon startet `<engine> run --rm --init --name adispatch-<run-id> --cap-drop ALL --security-opt no-new-privileges …` im Vordergrund und überwacht diesen Prozess wie einen Shell-Worker (Logs, Events, Timeouts, Klassifikation nach §8.2 mit dem Exit-Code des Containers). Labels `adispatch.run`, `adispatch.workflow`, `adispatch.instance` (Hash des data-dir; Instanzen räumen sich nicht gegenseitig auf). Env nur explizit: `-e NAME`, der Wert steht in der Prozessumgebung des Engine-Aufrufs – Secrets erscheinen nie in `ps` oder im gespeicherten Kommando. Der Workspace liegt auf dem Host und wird gemountet (ohne eigenen Mount von `{workspace.path}` automatisch nach `/work`, rw). **Abweichung von „Ergebnisdatei im Workspace-Mount“:** Kontextdatei read-only unter `/adispatch/context.json`, ein leeres Ausgabeverzeichnis des Runs rw unter `/adispatch/out/` (Ergebnisdatei `/adispatch/out/result.json`, auf dem Host `runs/<run-id>/out/`), Token-Dateien read-only unter `/adispatch/secrets/`; `ADISPATCH_*` zeigen auf die Container-Pfade – so kann der Container weder die Daemon-Logs noch andere Dateien außerhalb seines Ausgabeverzeichnisses verändern. Cancel/Timeout: `<engine> stop -t <cancel_grace> <name>`, danach wird der Engine-Prozess wie ein Shell-Worker behandelt; nach jedem Ende `rm -f`, nach einem Abbruch zusätzlich Suche nach spät angelegten Containern am Label `adispatch.run`. Vor dem Start werden Symlinks in `{workspace.path}/<pfad>`-Quellen und Mounts, die das data-dir enthalten oder (außerhalb des Workspaces) darin liegen, mit `start_error` abgelehnt; Variablen, die die Engine-CLI steuern (Proxy, `LD_*`, `GODEBUG`, `DOCKER_*` …), gelangen nie in die Engine-Umgebung. Die Ergebnisdatei wird – bei allen Executors – ohne Symlinks gelesen (`O_NOFOLLOW`, Prüfung des Handles). Recovery (§14): Container dieser Instanz werden am Label gefunden und gestoppt – auch ohne aktiven Run; Runs, die als aktiv galten, enden nach der bestehenden Recovery-Semantik (i. d. R. `crashed`). Laufende Container werden **nicht übernommen** (wie beim Shell-Executor). Ist die Engine nicht erreichbar, bleibt ein betroffener Run `recovery_pending`. Validierung: `image` Pflicht, Mount-Quellen existieren (relativ zum config-dir, als Platzhalter nur `{workspace.path}`), Ziele absolut/normalisiert/eindeutig/nicht `/` und nicht unter `/adispatch`, `mode` ∈ {`ro`, `rw`}, Formate von `resources`; `on_result` ist erlaubt. Das Engine-Binary wird beim Daemon-Start geprüft (Warnung; fehlt es, endet der Run mit `start_error`), nicht beim Offline-Validate. Details: [configuration-reference.md](configuration-reference.md) §3.4.8, [worker-protocol.md](worker-protocol.md), [operations.md](operations.md).

## 14. Shutdown, Drain und Recovery

- **Pause:** verhindert neue automatische Starts; laufende Runs werden nicht verändert.
- **Drain (Standard):** keine neuen Runs, aktive Runs sauber abschließen, dann Dienst stoppen.
- **Cancel All & Shutdown:** automatische Starts stoppen, alle Runs kontrolliert abbrechen, `on_cancel` ausführen, Dienst stoppen.
- **Unerwarteter Crash:** Nach Neustart zunächst alle zuvor aktiven Runs und möglichen Prozessgruppen erfassen, noch lebende eindeutig zuordenbare Gruppen beenden (Variante A), verschwundene Runs als `crashed` behandeln, fällige Hooks und technische Retries/Blocks rekonstruieren, erst **danach** Scheduler freigeben.

**Kein Attach an verwaiste Worker in V1.** Die Recovery soll diese gezielt beenden, nicht übernehmen. Nicht zugreifbare oder nicht identifizierbare Prozesse führen zu einem sichtbaren Recovery-Fehler und dürfen keine unkontrollierten automatischen Doppelstarts auslösen.

systemd: `Restart=on-failure`, dedizierter Benutzer, feste absolute Executable, sauber abgestimmtes Stop-/Timeout-Verhalten. Ein absichtlicher GUI-Shutdown darf nicht unbeabsichtigt von systemd als crashbedingter automatischer Neustart behandelt werden. Der tatsächliche Service-Vertrag muss in Integrationstests mit `systemctl stop`, App-Absturz und Server-Reboot getestet werden. Ein sofortiger Prozess-Kill durch den Service-Manager kann keinen Drain garantieren; für geplante Abschaltungen ist ein CLI/API-Drain-Schritt vorzusehen.

## 15. HTTP-API und SSE (Entwurf)

Basis: `/api/v1`; JSON-Antworten; mutierende Requests via POST/PATCH; SSE unter `/api/v1/events` oder runbezogenem Stream. API lauscht standardmäßig **nur auf `127.0.0.1`**. Keine integrierte Anmeldung in V1: Absicherung zwingend durch Reverse Proxy/VPN/Tailscale; unsichere öffentliche Bindung ist deutlich zu warnen (**Nachtrag 0.4.0, WI-26:** optionale Anmeldung, siehe §20). CORS und CSRF-Risiken auch hinter Reverse Proxy berücksichtigen.

| Methode | Endpunkt | Funktion |
|---|---|---|
| `GET` | `/health` | HTTP-Prozess erreichbar |
| `GET` | `/ready` | DB/Scheduler/Recovery betriebsbereit |
| `GET` | `/api/v1/status` | Scheduler, Limits, Zähler |
| `POST` | `/api/v1/scheduler/pause` | Automatische Starts pausieren |
| `POST` | `/api/v1/scheduler/resume` | Fortsetzen |
| `POST` | `/api/v1/shutdown/drain` | Drain starten |
| `POST` | `/api/v1/shutdown/cancel-all` | Aktive Runs abbrechen und stoppen |
| `GET` | `/api/v1/workflows` | Workflows und Overrides |
| `PATCH` | `/api/v1/workflows/:id/runtime` | Temporäre Werte setzen |
| `POST` | `/api/v1/workflows/:id/start` | Direkter manueller Start; Source-Item bei Source-Trigger erforderlich |
| `POST` | `/api/v1/workflows/:id/dry-run` | Probeauswahl ohne Actions |
| `GET` | `/api/v1/runs` | Run-Historie |
| `GET` | `/api/v1/runs/:id` | Metadaten, Input, Output, Actions |
| `GET` | `/api/v1/runs/:id/logs` | Paginierte/offset-basierte Logs |
| `POST` | `/api/v1/runs/:id/cancel` | Einzelnen Run abbrechen |
| `GET` | `/api/v1/blocks` | Aktive interne Blocks |
| `POST` | `/api/v1/blocks/:id/clear` | Block entfernen, Zählperiode erneuern |
| `GET` | `/api/v1/actions/failed` | Fehlgeschlagene Hooks |
| `POST` | `/api/v1/actions/:id/retry` | Action erneut versuchen |
| `GET` | `/api/v1/views` | View-Definitionen |
| `GET` | `/api/v1/views/:id/items` | Aktuell abgefragte View-Daten |
| `POST` | `/api/v1/config/reload` | Atomare Konfigurationsübernahme |
| `GET` | `/api/v1/events` | SSE: Run-/Log-/System-Events |

SSE-Ereignisse tragen `id`, `type`, Zeitstempel und Payload. Nach Verbindungsabbruch muss die UI verpasste, persistent gespeicherte Ereignisse anhand von `Last-Event-ID` oder REST-Nachladen rekonstruieren. Langsame Browser dürfen nicht die Prozess-Logerfassung blockieren. Eventzugang ausschließlich über geschützte Schnittstelle.

## 16. Weboberfläche

**Navigation:** Dashboard; Runs (aktiv + historisch); Workflows; Blocked; Failed Actions; Views (bei wenigen Einträgen direkt als Untermenü, zusätzlich „All Views“); Configuration/System.

- **Dashboard:** Scheduler-Status, globales Limit und Auslastung, Pause/Resume, Drain, Cancel All, aktive Runs und letzte Agent-Statusmeldungen. **Nachtrag 0.4.0 (WI-24):** Bereich „Information“ mit den Kacheln aus `dashboard.yaml` (Titel, Wert, Einheit, Balken bei Prozent, Farbe nach Schwellwerten, Zeitpunkt, Fehlerhinweis mit veraltetem Wert, gedrosselter „Refresh“-Knopf); Werte kommen per REST (`GET /api/v1/dashboard/info`) und live per SSE (`dashboard.info`); ein Seitenaufruf startet nie ein Skript. **Nachtrag 0.8.0 (WI-32) – Dashboard frei anordnen:** `dashboard.yaml` kann unter `layout` festlegen, welche Widgets in welcher Anordnung erscheinen: Reihen (1–30, optionaler `title`) aus Elementen (1–6), ein Element ist ein Widget oder eine Spalte `{column: [...], width: 1–12}` (relative Breite, CSS-Grid `fr`; unter 900 px untereinander). Widgets: `resources`, `resources_full`, `info` (`ids`), `scheduler`, `capacity`, `attention`, `active_runs`/`recent_runs` (`limit`, `workflows`), `view` (`view`, `sections`, `limit`, `refresh` ≥ 15 s; volle View-Darstellung mit Abschnitten, Gruppen, Browser-Sortierung, Item-Panel-Link, „Open view“, gemeinsamer Renderer mit der View-Seite) und der Container `tabs` (1–12 Reiter mit `title`, optionaler `id`/Slug, eigenem `layout`; `default`; Tiefe ≤ 3). Jedes Widget optional mit `title`, mehrfach verwendbar, insgesamt ≤ 100. Ohne `layout` gilt das Standard-Layout = Dashboard 0.7.0. Hinweise (Drain, nicht bereit, ungeschützte Bindung) stehen immer oben. Inaktive Reiter werden nicht montiert (kein Request, kein Polling); der gewählte Reiter steht als Pfad aus Reiter-IDs im URL-Hash (`#/?tab=a/b`, Zurück-Knopf) und wird im `localStorage` gemerkt. Widgets derselben View teilen sich eine Abfrage (Vereinigung der Abschnitte, größtes `limit`, serverseitig gekürzt nach dem View-Cache). API: `GET /api/v1/dashboard` (normalisiertes Layout, Rolle viewer), `GET /api/v1/views/:id/items` mit `sections`/`limit`, `GET /api/v1/runs?workflow=a,b`. Prüfung beim Laden mit Pfad und „did you mean“ (Views, Abschnitte, Workflows, Info-IDs, Reiter); Warnungen für `info` ohne Kacheln und Ressourcen-Widgets bei `monitoring.enabled: false`; Reload lädt das Layout neu. Details: [configuration-reference.md](configuration-reference.md) §3.7.1, [api.md](api.md).
- **Runs:** Name, Run-ID, Workflow, Agenten-/Rollenidentität, Trigger, Start/Ende/Dauer, Arbeitsverzeichnis, Startkommando, Exit-Code, Source-URL, Input-JSON, Ergebnis-JSON, Rohlogs, Events, Lifecycle-Aktionen; bei aktiven Runs `Cancel`.
- **Workflows:** aktiv/inaktiv, Priorität, Max-Parallelität, aktueller Verbrauch, manuelle Starts (Source-URL + optionale Parameter), Dry-Run; Runtime-Overrides für `enabled`, `priority`, Limits. **Nachtrag 0.4.0 (WI-24):** Conditions sichtbar – in der Liste kompakt, im Detail mit Anzeigename, Timeout, Cache und letztem Status (Workflow-Conditions: ok / nicht jetzt / Prüffehler / nicht ausgewertet bzw. nie geprüft, mit Zeitpunkt, Dauer, Cache-Treffer und erster stderr-Zeile; Item-Conditions und `shell_filter`: Zusammenfassung des letzten Planungsschritts). Der Status liegt im Speicher des Schedulers; API-Feld `conditions` der Workflow-Ansicht, SSE `workflow.conditions`.
- **Blocked:** Blockschlüssel, Fehlversuche, Run-Links, Source-URL, Remove Block. Nicht mit GitHub-„blocked by“ oder einem GitHub-Label verwechseln.
- **Failed Actions:** Fehler, Versuche, manuelle Wiederholung.
- **Configuration:** YAML nur lesend anzeigen, Validierung, Fehler und manueller Reload. Runtime-Overrides bleiben **nicht** nach Neustart erhalten; Reload setzt betroffene Overrides auf YAML-Werte zurück.
- **Live-Updates:** SSE für Logs, strukturierte Events, Run-Zustände und Systemstatus. Alle Steuerbefehle per HTTP.

Die GUI muss bei komplexen Logs nur benötigte Bereiche laden (Paging/Tailing), keine 100-MB-Datei auf einmal in den Browser senden.

**Nachtrag 0.4.0 (WI-23) – Server-Ressourcen im Dashboard:** Bereich „Server“ mit gestapeltem CPU-Diagramm über die Zeit (Daemon, jeder Run mit stabiler Farbe je Workflow und Link zum Run-Detail, Hooks/Checks, die größten fremden Prozesse nach Namen, „Others“, Rest bis zur Gesamtauslastung als „System / unattributed“; Skala 0–100 % der Gesamtkapazität), RAM belegt/verfügbar und freier Plattenplatz je überwachtem Pfad, aktuelle Werte als Zahlen und Tabelle (Text-Alternative), Tooltip je Zeitpunkt, Zeitraum-Auswahl (begrenzt durch `monitoring.retention`), Live-Aktualisierung per SSE `system.metrics`. Eigenes SVG ohne Bibliotheken, Prozessnamen nur als Text. `monitoring.enabled: false` → Hinweis statt Diagramm. Details: [configuration-reference.md](configuration-reference.md) §3.1, [api.md](api.md).
**Nachtrag 0.4.0 (WI-25) – Externe Tools in der Toolbar:** `config.yaml` kann unter `ui.external_links` beliebige lokale Werkzeuge (z. B. ein Agenten-Dashboard wie claude-inspect) in die Navigation aufnehmen: `id` (Konfigurations-ID, eindeutig), `label` (1–40 Zeichen, nur als Text dargestellt), `url` (absolut, `http`/`https`, ohne Zugangsdaten; so, wie der **Browser** das Tool erreicht), `enabled` (Default `true`), `embed` (Default `false`). `embed: false` → Link in neuem Tab (`noopener noreferrer`, Symbol „extern“); `embed: true` → eigene Seite `#/tools/<id>` mit dem Tool in einem `iframe` (`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"`, `referrerpolicy="no-referrer"`), Kopfzeile mit „Open in new tab“ und Hinweis auf typische Ursachen, falls nichts erscheint. Die Content-Security-Policy der UI kommt seitdem als HTTP-Header (vorher `<meta>`, inhaltlich gleich) und erlaubt `frame-src` genau für die Origins der aktivierten `embed`-Einträge (nach einem Reload sofort für neu geladene Seiten). Kein Proxy: Der Browser spricht das Tool direkt an. `GET /api/v1/config` liefert die aktiven Einträge als `externalLinks`; die Konfigurationsansicht (`config.global.ui`) enthält nur aktive Einträge mit redigiertem Query-String/Fragment. Die URLs aktiver Einträge (auch Tokens darin) sieht jeder, der UI/API erreicht (gleiche Vertrauensgrenze, §20.1); Query-Parameter, die wie ein Token aussehen (`t`, `token`, …), ergeben deshalb eine Warnung. Bei `embed: true` muss der Host in der CSP ausdrückbar sein (Hostname/IPv4 aus `[a-z0-9.-]`), sonst Fehler. Empfehlung: UI und Tool mit gleichem Hostnamen und Schema öffnen (`SameSite`-Cookies im Frame). Details: [configuration-reference.md](configuration-reference.md) §3.1, [operations.md](operations.md).
**Nachtrag 0.4.0 (WI-27) – UI-Aktionen als Identity:** Neue Seite „UI Actions“ (Suche nach URL, `owner/repo#nr` oder `<source>:<nr>` und Audit-Liste) und ein Item-Panel `#/items/<source>/<nr>` (erreichbar aus Run-Detail, View-Zeilen und der Suche): Kopf mit Titel und „Open on GitHub“ (neuer Tab), Auswahl einer freigeschalteten Identity (`identities.yaml` → `ui_actions: true`), Abschnitte Kommentar (Textfeld, Vorschau als reiner Text), Labels (Chips entfernen/hinzufügen, Vorschläge aus den Repo-Labels) und Projektfelder (deklarierte Felder mit aktuellem Wert; Auswahl bei Single-Select/Iteration, Eingabe bei Text/Zahl/Datum, Leeren). Vor jedem Senden ein Bestätigungsdialog („Send as maintainer (GitHub App)?“), danach Ergebnis/Fehler und Neuladen; die letzten Aktionen am Item stehen darunter. Nur für `admin` mit echter Anmeldung; mit `auth.mode: none` ein Hinweis statt des Panels. Alles wird als Text dargestellt. API: `GET /api/v1/items/resolve`, `GET /api/v1/items/:source/:item`, `POST …/comment|labels|project`, `GET /api/v1/ui-actions` ([api.md](api.md)).
**Nachtrag 0.9.0 (WI-33) – Item-Verlauf:** Seite `#/items/<source>/<id>` (Rolle viewer; das Item-Panel aus WI-27 liegt jetzt unter `#/items/<source>/<id>/act`) mit dem Weg eines Source-Items durch die Workflows: **Kopf** mit dem aktuellen Stand (frisch über die Source gelesen: Titel als Link, Typ, Zustand, Labels, deklarierte Projektfelder, `work_branch`/`work_pr`, aktiver Run, aktive Retry-Blocks mit Link auf „Blocked“; nicht lesbar → Hinweis, die Historie erscheint trotzdem), **Pfad** (alle Runs zeitlich als Kette Workflow + Ergebnis-Badge mit Link auf den Run, umbrechend, bei mehr als 50 die letzten 50 mit „older …“) und **Zeitleiste** (neueste oben, umschaltbar, Filter je Eintragsart, „Load older entries“): Run gestartet (Trigger, Benutzer bei manuellem Start/Unblock, Parameter), Run beendet (Status, `result`, `outcome`, Meldung, Dauer), Hook-Ketten mit jeder Action (Typ, ID, Status, Versuche) und ihrer **Wirkung** (Labels +/−, Projektfeld `Name: alt → neu`, Kommentar mit Link, Exit-Status), Retry-Block entstanden/aufgehoben (von wem, Lifecycle-Run), UI-Aktionen (Benutzer, Identity, Wirkung). Optional „Show GitHub events“: die Issue-Timeline (REST `issues/{n}/timeline`, bis 300 Ereignisse, 60 s Cache) mit `labeled`/`unlabeled`, `closed`/`reopened`, `assigned`, `renamed`, `cross-referenced`/`connected` und Akteur; eigene Label-Änderungen, die zu einem Eintrag passen, erscheinen nicht doppelt, alle anderen sind als „external“ markiert; Projektfeld-Änderungen liefert die Timeline nicht (Hinweis); Fehler nur in diesem Teil. Hat die Aufbewahrung Runs des Items gelöscht, sagt die Seite das. Planungsentscheidungen werden nicht je Item gespeichert und erscheinen nicht. Daten: Schema v6 speichert die Wirkung jeder Action strukturiert (`run_actions.effect_json`, ohne Kommentartexte und Secrets; ältere Einträge zeigen die Zusammenfassung aus dem Journal), Index `blocks_item`, Tabelle `item_history_gaps`. Links von Run-Detail, Item-Panel, Blocked-Seite und Run-Liste; neues View-Feld `history` (Link-Spalte, nicht filter-/sortierbar). API: `GET /api/v1/items/:source/:item/history`, `GET /api/v1/items/:source/:item/github-events`. Details: [api.md](api.md) „Item-Verlauf“, [configuration-reference.md](configuration-reference.md) §3.5, §4.8.
**Nachtrag 0.9.1 (WI-34) – Item-Verlauf aus den Run-Widgets:** Die Dashboard-Widgets `active_runs` und `recent_runs` zeigen in der Spalte „Item“ den Link zum Item (sonst den Item-Schlüssel bzw. den Trigger) und dahinter „history“ auf `#/items/<source>/<id>` wie die Run-Liste; `recent_runs` hat dafür eine neue Spalte „Item“ nach „Workflow“. Keine API-Änderung.

**Nachtrag 0.10.0 (WI-35) – Artefakte:** Workflows können Dateien oder Ordner als **Artefakte** erzeugen, die run-übergreifend sichtbar sind und von anderen Workflows als Eingabe verarbeitet werden – ohne Pipeline-Engine (Leitprinzip 3 bleibt: aufeinanderfolgende Schritte entstehen aus Items). Ein Artefakt ist ein Item der neuen Source `type: artifacts` (höchstens eine; keine Identity, keine Credentials; Item-Schlüssel `<source>:<artifact-id>`). **Erzeugen:** `execute.artifacts` (Liste `name` mit Platzhaltern, `type` frei, `path` literal relativ zum Workspace, `required`; Limit `artifacts_max_size`, Default 100MB) – gespeichert nach dem Abschluss-Hook und vor dem Cleanup (§8) nach `data-dir/artifacts/<id>/content`, nur bei Runs, die `completed` enden, mit den Sicherheitsregeln von `execute.keep` (§9: keine Symlinks, nur reguläre Dateien, Pfad im Workspace, Größenlimit, Secret-Redaktion best effort). Ein fehlender Pfad ist eine Warnung im Event `run.artifacts`; mit `required: true` beendet der Daemon den Run beim Ende des Workers als `crashed` (technischer Fehler, zählt für Retry-Blocks, §11). **Dedupe:** die eingebauten Felder `consumed_by` (Workflow-IDs, die das Artefakt mit Erfolg verarbeitet haben: Run `completed` + `success`) und `attempted_by` (Run `completed`, Erfolg oder fachliches `failure`; Retry-Schutz), eingetragen mit dem Ende des Runs in der Transaktion, die die Sperre löst; Filter z. B. `not: { field: attempted_by, operator: contains, value: summarize }` (die Konfigurationsprüfung warnt, wenn ein Artefakt-Workflow keinen der beiden Filter hat). Beim Einsammeln werden Dateien mit mehreren Hardlinks und Namen mit `\`/Steuerzeichen übersprungen. **Eingabe:** schreibgeschützte Kopie unter `<workspace>/inputs/<Name>`, Platzhalter `{item.path}`, `{item.name}`, `{item.type}`, `source.input` in `context.json` (§9.1); solange ein aktiver Run das Artefakt nutzt, ist Löschen gesperrt. Felder: `id`, `name`, `type`, `kind` (`file`/`folder`), `file_name`, `size`, `file_count`, `created_at`, `workflow`, `run_id`, `parent` (Artefakt, das der erzeugende Run als Item hatte; bleibt als Text, wenn das Eltern-Artefakt gelöscht wird), `consumed_by`, `attempted_by`, `url`. **Daten (§12):** Tabelle `artifacts` (Schema v7, Migration mit Backup, Einbahnstraße); Artefakte sind unveränderlich; `retention.artifacts` (Default `never`). **API (§15):** `GET /api/v1/artifacts`, `…/:id` (Dateibaum), `…/:id/files/<pfad>`, `…/:id/download` (Datei oder `.zip` mit eigenem Writer ohne Abhängigkeit), `POST …/:id/start`, `DELETE …/:id` (`409` bei aktiver Nutzung); Rollen viewer/operator/admin; SSE `artifact.created`, `artifact.deleted`. **UI (§16):** Seite „Artifacts“ (Liste, Filter, Dateibaum, Download, Löschen, „Workflow starten…“), Verlinkung vom Run (erzeugte Artefakte, Eingabe-Artefakt) und zurück (Erzeuger-Run, Runs auf dem Artefakt, abgeleitete Artefakte). Nicht Teil: Upload, Versionierung, Tags, Pipeline-Editor. Details: [configuration-reference.md](configuration-reference.md) §3.2.1, §3.4.8, §4.9, [api.md](api.md) „Artefakte“, [handoff/WI-35.md](handoff/WI-35.md).

## 17. Views

Views sind **rein lesende**, statisch per YAML definierte tabellarische Ansichten. Sie dürfen mehrere Sources desselben Adaptertyps kombinieren und zur Darstellung interne Run-Metadaten über stabile Source-Item-IDs ergänzen. Kein eigener Issue-Store und keine editierbaren Tickets in der GUI.

```yaml
# views/needs-maintainer.yaml
id: needs-maintainer
title: Needs Maintainer
sources: [project_a, project_b]
filter:
  all:
    - { field: labels, operator: contains, value: needs-maintainer }
fields:
  - { field: repository, label: Repository }
  - { field: number, label: Issue }
  - { field: title, label: Titel, link: url }
  - { field: run.last_workflow, label: Letzter Agent }
  - { field: run.last_result.message, label: Ergebnis }
  - { field: updated_at, label: Aktualisiert }
sort: { field: updated_at, direction: desc }
```

Filter nur deklarativ, keine Shell-Filter, keine zusätzlichen UI-Filter/Textsuche. Spaltensortierung im Browser ist erlaubt. Daten werden beim Öffnen/Refresh aus Sources geladen; optional kurzer Cache. Source-Adapter liefern deklarierte Felddefinitionen samt Typ, optionalem Link und unterstützten Operatoren. Nicht verfügbare Spalten bleiben erkennbar leer. **Nachtrag 0.3.0 (WI-21):** Felder vom Typ `object[]` (`closing_prs`) werden als Liste dargestellt (`#12 open`, Link je Eintrag), `work_pr` verlinkt auf den PR; nach `object[]` kann nicht sortiert werden. `run.last_*` bezieht sich auf den letzten passenden, zeitlich eindeutig bestimmten Run; bei Bedarf später workflowbezogene Selektoren ergänzen. Auch bei mehreren Repositories muss die Item-ID global eindeutig sein.

**Nachtrag 0.5.0 (WI-28) – Wertereihenfolge, mehrere Sortierschlüssel, Abschnitte:** `sort` ist ein Schlüssel oder eine Liste von 1–5 Schlüsseln (Gleichstand → nächster Schlüssel, zuletzt Item-Schlüssel); je Schlüssel optional `order` (1–100 eindeutige Werte, nur `string`-Felder): gelistete Werte in Listenreihenfolge (`desc` kehrt sie um), danach nicht gelistete natürlich sortiert, leere/unbekannte immer zuletzt; Vergleich mit Groß-/Kleinschreibung. Unbekannte Optionen eines `single_select`-Projektfelds ergeben eine Warnung im View-Ergebnis. `group_by_first` zeigt eine Gruppenzeile je Wert des ersten Schlüssels (nur mit `order`). `sections` (1–20, Titel eindeutig, je Abschnitt genau `filter` oder `rest: true`, optional eigene `sort`/`fields`) teilen eine View in Tabellen mit Überschrift; die Sources werden einmal gelesen, Abschnittsfilter wirken lokal zusammen mit dem View-Filter (`state` ohne Pushdown, nicht über die View-Abfrage hinaus). `exclusive` (Default `true`): ein Item nur im ersten passenden Abschnitt; `hide_empty_sections` blendet leere aus. Die API liefert `sort` immer als Liste und bei Abschnitten `sections: [{ title, rows, counts, sort, fields }]`; Views ohne Abschnitte unverändert. Details: [configuration-reference.md](configuration-reference.md) §3.5.1, §3.5.2.

## 18. Benachrichtigungen

**Workflow-Benachrichtigungen** über `source.comment` oder `shell`-Hook (z. B. Slack-Skript). **Kritische Orchestrator-Ereignisse** erhalten ein zentrales, konfigurierbares Benachrichtigungssystem, z. B. HTTP-Webhook/Slack-Webhook als erster Kanal: Retry-Block erstellt, Lifecycle endgültig gescheitert, Recovery fehlgeschlagen; ab 0.6.0 optional Retry-Block aufgehoben (`retry_block_cleared`, nicht im Default). Zustellung und Versuche werden gespeichert, Fehlzustellungen in GUI gezeigt. Die Orchestrierung darf bei Benachrichtigungsfehler nicht hängen. Secrets in Notification-URLs/-Headers schützen und redigieren.

## 19. Konfiguration, Reload, Dry-Run

Konfigurationsänderungen werden **nur manuell** per GUI/CLI übernommen. Reload: gesamte YAML-Konfiguration einlesen → syntaktisch und gegen Schema validieren → Source-/Identity-/Workflow-/View-Referenzen validieren → nur bei Vollerfolg **atomar** aktivieren; andernfalls bisherige Konfiguration behalten. Laufende Runs und ihre Hooks verwenden den beim Start persistent festgehaltenen Konfigurationssnapshot. Runtime-Overrides sind nicht persistent und werden beim Reload für betroffene Einstellungen zurückgesetzt.

`config validate` prüft Syntax, Datentypen, referenzierte Identitäten/Sources, widersprüchliche Angaben, erlaubte Platzhalter und IDs; optional API-Capabilities separat prüfen, damit Offline-Validierung möglich bleibt.

`workflow dry-run`: Source-Abfrage, Filteranalyse (einschließlich deklarativer Dependency-Prüfung), Prioritäten, vorhandene Locks/Blocks und Kapazität anzeigen; keine Worker, keine Lifecycle-Actions und standardmäßig **keine Shell-Filter/Conditions**, da potenziell nebenwirkungsbehaftet. Ungeprüfte Regeln als `unknown / not evaluated` statt `pass` darstellen. Auch GUI bietet Dry-Run.

## 20. Sicherheit

1. Standard-Bind `127.0.0.1`; extern nur hinter authentifiziertem Proxy/VPN. `service install` richtet einen eigenen OS-Benutzer und eng begrenzte Dateirechte ein.
2. Shell-Skripte gelten als **vertrauenswürdiger Konfigurationscode** mit den OS-Rechten des Dienstes; es gibt keine Sandbox-Garantie. Schreibzugriff auf YAML/Skripte bedeutet faktisch Codeausführungsrecht.
3. Worker erben keine vollständige Controller-Umgebung. Nur minimale Standardvariablen, explizite Env-Werte, `ADISPATCH_*` und explizit beantragte Secrets/Tokens.
4. App-Schlüssel, Tokens und Secret-Dateien dürfen nicht in persistierten Kontexten, HTTP-Antworten, Debug-Logs oder strukturierten Events erscheinen; best-effort Redaction in Prozesslogs.
5. Event-/Result-/Kommentar-Strings als untrusted text behandeln (XSS vermeiden); Template-Auswertung auf feste Platzhalter begrenzen.
6. Shell-Kommandos mit Argumentlisten statt unsicherer Shell-Interpolation konstruieren, wo möglich. Bei expliziten Shell-Kommandos liegt die Verantwortung beim Konfigurationsautor.
7. Source-Updates nur mit erlaubten App-Rechten; keine automatische Berechtigungseskalation. Cross-Repo-Abhängigkeiten bei fehlenden Rechten fail-closed.
8. Externe Lifecycle-Aktionen können nicht global atomar sein: Fehlersichtbarkeit, Precondition-Checks und Idempotenzmechanismen sind Pflicht.

**Nachtrag 0.3.0 (WI-18) – Token-Dateien und Secrets für Shell-Actions:** `execute.secrets.<NAME>` erhält `delivery: env | file` (Default `env` = bisheriges Verhalten). Bei `file` schreibt der Daemon das Token in eine Datei im Run-Verzeichnis **außerhalb** des Workspaces (`data-dir/runs/<run-id>/secrets/<NAME>`, Verzeichnis 0700, Datei 0600) und übergibt nur den Pfad als `<NAME>_FILE`; `<NAME>` wird nicht gesetzt. Solange der Prozess läuft, ersetzt er die Datei atomar (temporäre Datei + `rename` im selben Verzeichnis) spätestens 10 Minuten vor Ablauf; Identities ohne Ablauf (`github_token`) werden einmal geschrieben. Fehler beim Erneuern werden ohne Token geloggt und mit Backoff wiederholt, der Run läuft weiter, bis das alte Token abläuft. Nach Run-Ende (jeder Endstatus) und bei der Recovery nach einem Neustart wird die Datei gelöscht, die Retention räumt Reste. Diese Datei ist die **einzige** Stelle, an der ein Token persistiert wird (Ausnahme zu Punkt 4); jedes ausgegebene Token wird vor dem Schreiben beim Redactor registriert (stdout/stderr, Events, Logs, Action-Logs). `shell`-Actions erhalten dasselbe Feld `secrets` (`env` oder `file`, Datei in einem action-eigenen Verzeichnis, nach dem Versuch gelöscht, bei langen Actions ebenfalls erneuert); ohne `secrets` bekommen sie weiterhin keine Tokens. Validierung: `delivery` ∈ {`env`, `file`}; `<NAME>_FILE` kollidiert weder mit `env` noch mit anderen Secret-Namen; Identities müssen existieren. **Grenze der Isolation:** Die Rechte `0700`/`0600` schützen nur vor **anderen Systembenutzern**, nicht vor anderen Runs und Actions **desselben Dienstes**: Alle Worker laufen als derselbe Dienstbenutzer, die Pfade sind vorhersagbar – ein Worker kann die Token-Datei eines parallel laufenden Runs lesen (genauso wie unter Linux dessen Umgebung über `/proc/<pid>/environ` bei `delivery: env`). Wer hoch- und niedrig-privilegierte Workflows trennen muss, betreibt getrennte Instanzen unter getrennten Benutzern oder nutzt Container (WI-19). Details: [configuration-reference.md](configuration-reference.md) §3.4.8, §3.4.11, [worker-protocol.md](worker-protocol.md).

**Nachtrag 0.4.0 (WI-26) – Anmeldung für Weboberfläche und API (ersetzt „Keine Anmeldung in V1“):** `config.yaml` erhält den optionalen Abschnitt `auth`; ohne ihn gilt `mode: none` = Verhalten wie bisher (Punkt 1 bleibt dann die einzige Absicherung). `mode: password`: eingebaute Benutzer (`auth.users[]`: `name`, `password_hash_env`, `role`), Passwort nur als scrypt-Hash (`node:crypto`, `scrypt:<N>:<r>:<p>:<salt>:<hash>`, erzeugt mit `adispatch auth hash-password`) in einer Umgebungsvariablen, nie in YAML; Vergleich in konstanter Zeit, unbekannte Benutzer kosten dieselbe scrypt-Berechnung, keine Unterscheidung „unbekannt“/„falsch“; Rate-Limit je Client-IP und je Benutzername, Verzögerung nach Fehlschlag; Sessions im Speicher (32 Zufallsbytes, Cookie `HttpOnly; SameSite=Strict; Path=/`, `Secure` über HTTPS bzw. `X-Forwarded-Proto: https` von `auth.trusted_proxies`), Gültigkeit `session_ttl` (Default 12 h), Neustart meldet alle ab; `POST /api/v1/auth/login|logout`, `GET /api/v1/auth/me`. `mode: trusted_header`: Identität aus einem Header des vorgeschalteten Proxys (Default `Tailscale-User-Login`), nur geglaubt, wenn die **TCP-Gegenstelle** (nicht `X-Forwarded-For`) in `trusted_header.trusted_proxies` liegt; fehlender Header → 401, Login nicht in `trusted_header.users` → 403; adispatchd dann an Loopback binden. **Grenze:** Mit einem Loopback-Proxy in `trusted_proxies` (Tailscale Serve) kann jeder lokale Prozess – auch jeder Worker – den Header fälschen; optional `trusted_header.proxy_secret_env` (gemeinsames Geheimnis im Header `X-Adispatch-Proxy-Secret`, konstante Zeit, fail closed) schließt das für Proxys, die einen Header setzen können; ohne Geheimnis warnt der Start, und `isIdentityForgeableLocally()` markiert die Konfiguration für sensible Funktionen (WI-27). Rollen `viewer` (lesen, Dry-Run, Validate) < `operator` (alle schreibenden Endpunkte) < `admin` (zusätzlich WI-27); jeder Endpunkt hat eine Mindestrolle (Tabelle in [api.md](api.md#mindestrolle-je-endpunkt), per Test gegen die registrierten Routen geprüft; eine Route ohne Rolle lässt sich nicht registrieren). `read_requires_login: false` erlaubt Lesen ohne Anmeldung. `/health`, `/ready` (ohne Details) und die statische UI-Hülle bleiben öffentlich; Host-/Origin-Prüfung und CSRF-Header bleiben unverändert; SSE nur angemeldet, Logout/Ablauf schließt offene Streams. CLI-Steuerbefehle nutzen einen lokalen Steuer-Token: bei jedem Start zufällig, atomar nach `<data-dir>/control.token` (0600, mit Port und PID; die CLI sendet ihn nur an diesen Port) geschrieben, gilt als `operator` nur für Loopback-Verbindungen und **nur** auf den Routen der CLI-Befehle (Status, Pause/Resume, Drain/Cancel-All, Reload, Dry-Run). Worker desselben Dienstbenutzers **können ihn lesen** und damit genau diese Aktionen auslösen – gleiche Vertrauensgrenze wie Punkt 2; alles andere (Runs starten/abbrechen, Overrides, WI-27-Aktionen) verlangt eine Anmeldung (`via` `password`/`trusted_header`). Login-Limits je (Benutzer, IP), je Benutzer und je IP (IPv6 /64); Cookie über HTTPS mit `__Host-`-Präfix. Audit: jede schreibende Anfrage eines angemeldeten Benutzers im Daemon-Log (`api write`, `actor`), Run-bezogene Aktionen zusätzlich als Run-Event `audit.user_action`, `clearedBy` eines Blocks = Benutzer. Die UI zeigt Login-Seite, Benutzer/Rolle/Logout in der Toolbar und deaktiviert Schaltflächen ohne ausreichende Rolle. Details: [configuration-reference.md](configuration-reference.md) §3.1, [operations.md](operations.md).

**Nachtrag 0.4.0 (WI-27) – Handeln als Identity aus der UI:** Ein Benutzer mit Rolle `admin` kann ein Issue/PR als eine konfigurierte Identity kommentieren, Labels ändern und Projektfelder setzen. Voraussetzungen (serverseitig): `auth.mode` ≠ `none`; echte Anmeldung (`via` `password`/`trusted_header`) – der Steuer-Token öffnet diese Routen nie, weil Worker ihn lesen können und sonst als (höher berechtigte) App posten könnten; Identity mit `ui_actions: true` (Default aus); bei `trusted_header` mit lokal fälschbarem Header (mindestens ein Loopback-Eintrag in `trusted_proxies`, kein `proxy_secret_env`; `isIdentityForgeableLocally()`) ist `ui_actions: true` ein Konfigurationsfehler; Host/Origin/CSRF wie bei jedem Schreibzugriff; je Benutzer höchstens 20 Aktionen und 60 Item-Abrufe pro Minute; das Item wird frisch gelesen und muss zur Source gehören. Ein Kommentar wird nie still verändert: Sieht er nach einem Secret aus (bekannte Werte, GitHub-/Anthropic-/AWS-/Slack-Token-Formate, PEM-Private-Key-Kopf; best effort), wird er abgelehnt; HTML-Kommentare werden wie bei Orchestrator-Kommentaren entschärft (kein gefälschter Marker); gesendet wird ohne Marker und ohne automatische Wiederholung, ein identischer Kommentar desselben Benutzers am selben Item innerhalb von 60 s wird abgewiesen. Labels und Projektfelder laufen über `applyUpdate` (erst lesen, dann schreiben, idempotent) strikt mit der gewählten Identity; nicht vorhandene Labels nur mit ausdrücklichem `create: true`. Jede Aktion – auch fehlgeschlagene – wird in der Tabelle `ui_actions` (Schema v4) protokolliert: Zeit, Benutzer, Identity, Item, Art, Ergebnis/Fehler, Kommentar-URL, nie der Kommentartext (Details maskiert); Aufbewahrung `retention.ui_actions` (Default 365 Tage). Scheitert nur das Protokollieren nach einer erfolgreichen Änderung, antwortet die API 2xx mit `auditWarning`. Die UI rendert alles als Text und fragt vor dem Senden nach.

## 21. Betrieb, Observability und Aufbewahrung

- Health: `/health`; Readiness: `/ready` (Recovery abgeschlossen, DB verfügbar, Konfiguration gültig). Optional später `/metrics`.
- Logs: pro Run stdout/stderr als Dateien; Status-/Events in SQLite; interne Fehler separat im Dienstlog; SSE als Live-Transport.
- Default-Retention-Vorschlag: erfolgreiche Runs 30 Tage, fehlgeschlagene/abgebrochene 90 Tage, offene Blocks und unvollständige Lifecycle-Ketten nicht löschen. `never` pro Kategorie möglich. Maximale Logs 100 MB/Run, Overflow klar markieren. Tägliche Cleanup-Prüfung. Gesicherte Dateien (`runs/<run-id>/kept/`, WI-22) werden mit dem Run gelöscht.
- Unterscheidung `failed` als **fachliches Ergebnis** gegenüber **technischem** `crashed` und separat `lifecycle failed` in API und UI eindeutig darstellen.
- **Nachtrag 0.4.0 (WI-23) – Ressourcen-Monitor:** Der Daemon misst im Abstand `monitoring.interval` (Default `scheduler.polling_interval`, 5 s … 60 s) CPU (`os.cpus()`-Deltas), Load, RAM (Linux `MemAvailable`, macOS free + inactive + speculative aus `vm_stat`), freien Platz von data-dir und `workspace.base_dir` (`statfs`) und einmal je Intervall die Prozessliste (Linux `/proc/<pid>/stat` – nur `comm`, nie `cmdline`; sonst bzw. als Fallback `ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,ucomm=`, `execFile` ohne Shell, Timeout, begrenzte Ausgabe). CPU je Prozess = Rate der CPU-Zeit (100 % = ein Kern), Prozess erkannt über PID und Startzeit (`/proc`: exakt in Ticks; `ps`: `etime` mit 2,5 s Toleranz); mit Linux-`ps` (1-s-Auflösung) über bis zu 60 s gemittelt. Namen aus `ucomm` (nicht `argv[0]`), an der ersten Leerstelle abgeschnitten. API mit serverseitigem Downsampling (`range`, `points`, höchstens 600 Punkte per Default). Zuordnung: eigene PID → Daemon, Prozessgruppe/Prozessbaum des Workers → Run (Container zusätzlich `<engine> stats`, unter Linux sichtbare Container-Prozesse nicht doppelt), andere Kinder des Daemons → Hooks/Checks, Rest → fremde Prozesse (Top N nach Namen, Rest „Others“). Nur Befehlsnamen, nie Argumente. Messungen laufen nie parallel; Fehler werden gedrosselt geloggt und lassen Teilwerte leer. Ringpuffer im Speicher (`monitoring.retention`, Default 6 h), geht beim Neustart verloren; `GET /api/v1/system/metrics`.
- Nur eine Instanz pro Data-Dir durch OS-weite exklusive Sperre; Stale-Lock-Erkennung darf nicht versehentlich zwei Instanzen erlauben. Mehrere getrennte Data-Dirs koordinieren sich **nicht** gegenseitig.
- **Nachtrag 0.10.0 (WI-36) – Hub: mehrere Workspaces unter einem gemeinsamen Limit.** Ein **Workspace** ist eine vollständige, unveränderte Instanz (eigenes config-dir und data-dir, eigene Workflows, Sources, Identities, Datenbank, eigener Port; kein Schema-Umbau, keine `workspace_id`). Ein **Hub** (`adispatch hub start`, eigener Prozess mit eigenem data-dir und Instanzsperre; Konfiguration `hub.yaml` im eigenen config-dir, [configuration-reference.md](configuration-reference.md) §3.9) startet jeden aktivierten Workspace als **Kindprozess** (`adispatch start --config-dir … --data-dir … --host 127.0.0.1 --port …`) unter demselben Benutzer, in eigener Prozessgruppe, und überwacht ihn: Zustände `starting|running|backoff|stopped|failed`, Neustart nach Absturz mit Backoff (1 s … 60 s; Zähler zurückgesetzt nach 60 s stabilem Lauf), Zähler und letzter Exit sichtbar, Exit 78 (Konfiguration/Instanzsperre) und nicht startbare Prozesse = `failed` ohne Neustart, Exit 0 = `stopped`; die Ausgabe der Kinder erscheint im Hub-Log mit Präfix `[<id>] `. Der Hub-Shutdown reicht SIGTERM weiter (ein Signal je Signal am Hub: Drain, dann Cancel-All, drittes = hart) und endet erst, wenn alle Kinder beendet sind. **Gesamtlimit:** `hub.max_concurrent` über alle Workspaces, ohne Quoten oder Prioritäten; `scheduler.max_concurrent` und Workflow-Limits der Workspaces bleiben zusätzliche Obergrenzen. Der Hub vergibt Plätze über das **Slot-Protokoll** (Unix-Socket `slots.sock`, Modus 0600, [worker-protocol.md](worker-protocol.md#slot-protokoll-hub-seit-0100)): Die Instanz fordert vor jedem automatischen Run (Source und Cron) einen Platz an (`acquire`), gibt ihn mit dem Ende des Runs zurück und erneuert ihre Plätze per Heartbeat; Plätze verfallen, wenn der Kindprozess endet oder der Heartbeat ausbleibt. Der Hub vergibt nie mehr als `max` Plätze. Manuelle Starts und Runs aus der Recovery werden nicht abgelehnt, belegen aber einen Platz (Abgleich der Plätze mit den aktiven Runs der Datenbank bei jedem Heartbeat und nach jedem Neuverbinden – so zählt ein neu gestarteter Hub laufende Runs sofort wieder). Der Scheduler kennt die Entscheidung **`hub_limit`** (Planungsdiagnose, Dry-Run `capacity.hub`, Cron `skipped_limit`); ist der Hub nicht erreichbar oder pausiert, starten keine neuen automatischen Runs (sichere Seite), laufende Runs sind nie betroffen. Ohne `ADISPATCH_HUB_SOCKET` verhält sich die Instanz wie bisher. **Bedienung:** `adispatch hub init|validate|start|status`, `hub workspace start|stop|restart|drain <id>`, `hub stop-all|drain-all|pause|resume` gegen eine lokale Steuer-Schnittstelle (JSON über HTTP auf dem Unix-Socket `hub.sock`, [api.md](api.md) „Steuer-Schnittstelle des Hubs“). Grenzen: alle Workspaces laufen unter dem Benutzer des Hubs und erben seine Umgebung (für getrennte Benutzer: Container-Executor oder eigenständige Instanzen); `hub.yaml` hat keinen Reload; verwaiste Workspaces nach einem Hub-Absturz werden nicht übernommen (Instanzsperre, Exit 78). Die HTTP-Übersicht und das Durchreichen der Workspace-UIs beschreibt der Nachtrag WI-37 (§15/§20). Details: [operations.md](operations.md#hub-mehrere-workspaces-auf-einem-server-seit-0100), [handoff/WI-36.md](handoff/WI-36.md).
- **Nachtrag 0.10.0 (WI-37) – HTTP-Server des Hubs: Übersicht, Hub-API, Durchreichen der Workspaces.** `hub.server` (Default `127.0.0.1:8090`) wird zu einem HTTP-Server unter **einem Port** (Fastify, dieselben Prüfungen wie bei einer Instanz: Host-/Origin-Allowlist, CSRF-Header, Rollen, Header, CSP): die **Übersicht** `/` (Kachel je Workspace mit Zustand, laufenden Runs, blockierten Items, fehlgeschlagenen Actions, Platzanteil, Neustarts; Gesamtleiste „Slots n/m“; Serverressourcen; live), die **Hub-API** `/api/v1/hub/…` (Status, Workspaces, `start|stop|restart|drain` je Workspace, `pause|resume|stop-all|drain-all`, Audit, SSE `hub.*`; [api.md](api.md#hub-api-seit-0100-wi-37)) und `/w/<id>/…` (Web-UI und API jedes Workspaces, HTTP und SSE, an dessen Loopback-Port durchgereicht; nicht laufender Workspace → 503-Seite). **Anmeldung** liegt im Hub (`auth` in `hub.yaml`, Modi und Rollen wie §20 Nachtrag 0.4.0; Lesen ab `viewer`, Steuern ab `operator`, Audit `admin`); eine Anmeldung gilt für Übersicht und alle Workspace-UIs. **Vertrauenskanal:** Der Hub übergibt jedem Kindprozess bei jedem Start ein Zufallsgeheimnis **auf der Standardeingabe** (nicht Umgebung, Argumente oder Datei – für Worker desselben Benutzers lesbar) und reicht die Identität des Benutzers als `X-Adispatch-Hub-Token|-User|-Role` weiter; die Instanz glaubt sie nur mit dem Geheimnis und nur von Loopback, und lehnt als hubverwaltete Instanz **jede** Anfrage ohne Hub-Identität oder Steuer-Token ab – auch mit `auth.mode: none`. Die Rolle des Hub-Benutzers wird so in der Instanz durchgesetzt und der Benutzer im Audit der Instanz genannt. Die Web-UI verwendet seitenrelative URLs (läuft unter `/`, `/w/<id>/` und hinter einem Pfadpräfix); eine Kopfzeilen-Verknüpfung „← Hub“ führt zur Übersicht zurück. **Durchreichen:** Pfade segmentweise geprüft (kein `..`, kein kodierter Trenner, keine Doppelkodierung), Request-Header per Allow-List, kein Cookie und kein fremder Identitäts-Header, kein `Set-Cookie` zurück. **Audit:** Verwaltungsaktionen des Hubs (auch fehlgeschlagene) in `hub.db` im data-dir des Hubs (Tabelle `hub_audit`, keine Schema-Migration der Instanzen). Grenzen: derselbe Benutzer für Hub und Workspaces (Vertrauensgrenze wie `control.token`, Spec §20.2); der Hub hat keine Quoten, keine Queue-Anzeige (eine Warteschlange gibt es in der Instanz nicht) und kein Adopt verwaister Instanzen. Details: [operations.md](operations.md#weboberfläche-des-hubs-durchreichen-und-vertrauensmodell-seit-0100-wi-37), [handoff/WI-37.md](handoff/WI-37.md).
- **Nachtrag 0.10.0 (WI-38) – Hub im Betrieb: systemd, Layout, Migration.** `adispatch service install --hub` erzeugt die Unit `adispatchd-hub` (Default-Name) für `adispatch hub start`; `--config-dir` ist das config-dir des Hubs (mit `hub.yaml`), `--data-dir` das **eigene** data-dir des Hubs, die Verzeichnisse aller Workspaces (auch deaktivierter) liest der Befehl aus `hub.yaml`. Es gelten die Optionen und Schutzprüfungen von `service install` (§4/§14/§20.1, kein `npx`, kein `root`, `--dry-run` überall, echte Änderungen nur unter Linux als root), erweitert auf **alle** Verzeichnisse: keine Systempfade, kein data-dir in einem config-dir (und umgekehrt), keine verschachtelten oder gleichen data-dirs, höchstens 100 Byte Socket-Pfad; außerhalb des Dry-Runs müssen `hub.yaml` und die Konfiguration jedes Workspaces gültig sein. Rechte: Hub-config-dir samt Workspace-Konfigurationen `root:<Gruppe>` (0750/0640), alle data-dirs dem Dienstbenutzer (0750). Stop-Vertrag wie §14 eine Ebene tiefer: `KillMode=mixed` (SIGTERM nur an den Hub, der jedem Workspace genau ein SIGTERM weitergibt; die Workspaces drainen parallel), `TimeoutStopSec` = Drain- + Cancel-Timeout + größtes `cancel_grace` über alle Workspaces + 60 s, `Restart=on-failure`, `RestartPreventExitStatus=78`; stirbt der Hub, beendet systemd die ganze cgroup (die Recovery der Workspaces finalisiert Runs als `crashed`). `service status|uninstall --hub` meinen ohne `--name` diese Unit. `hub init --workspaces-data-dir <dir>` legt die Workspace-Daten getrennt vom config-dir an (`<dir>/<id>`; Voraussetzung für den Dienstbetrieb), `hub init --empty` eine `hub.yaml` ohne Workspaces (Migration); `hub drain-all|stop-all --wait [--timeout]` wartet, bis alle Workspaces beendet sind (Exit 0, 3 Hub weg, 4 Timeout). **Migration einer Einzelinstanz:** deren config-dir/data-dir werden unverändert in `hub.yaml` eingetragen (neuer Port, `server.port` der Instanz wird überschrieben), die alte Unit vorher gedraint und abgeschaltet; die Instanzsperre verhindert zwei Prozesse auf demselben data-dir. Grenzen unverändert: ein Benutzer für alle Workspaces (für getrennte Rechte Container-Executor `user` oder getrennte Hubs), kein Reload, kein Adopt. Details: [operations.md](operations.md#hub-als-systemd-dienst-seit-0100-wi-38), [handoff/WI-38.md](handoff/WI-38.md).

## 22. Tests und Abnahmekriterien

### 22.1 Testebenen

- **Unit:** Filter-AST inkl. `unknown`, Prioritäten, deterministische Sortierung, Platzhalter, Result-/Event-Parser, Konfigurationsschema.
- **SQLite/Integration:** Run+Lock-Transaktionen, Blockgeneration, Lifecycle-Action-Retry, Recovery-Fälle, Retention-Schutzregeln.
- **Process:** normale Exits, Signale, Child-Prozesse, Cancel, Prozessgruppen, Start Error, Timeout, PID-Reuse/Identitätsprüfung.
- **GitHub:** GitHub-App-Auth, Token-Rotation, Labels, Kommentare, echte Issue-/PR-Abfragen, Cross-Repo-`blocked by` inklusive `unknown` bei fehlenden Rechten.
- **E2E UI/API:** manueller Override, Cancel, SSE-Reconnect, Reload, Dry-Run, Views, Blocks und Retry-Actions.
- **systemd:** Drain, Cancel All, Prozessabsturz, systemd-Restart, Boot-Recovery und Update-Migration.

### 22.2 Kritische Akzeptanzszenarien

1. Zwei Coder-Runs laufen parallel in verschiedenen Workspaces und teilen dieselbe Coder-App-Identität; ein dritter automatischer Run wird durch Workflow-Limit verhindert.
2. Manuell gestarteter Run mit Issue-URL ignoriert Filters/Conditions/Limits/Block, respektiert aber den aktiven Lock derselben Workflow/Item-Kombination.
3. Ein GitHub-Issue wird von einem offenen Issue in anderem Repo blockiert; expliziter Dependency-Filter verhindert Start. Nach Schließen des Blockers wird es beim nächsten Poll startfähig.
4. Ein normales `failure` führt zu `on_failure` (z. B. `needs-maintainer`), **ohne** technischen Retry-Zähler zu erhöhen.
5. Drei technische Fehler erzeugen Block; automatische Starts stoppen; „Remove Block“ erlaubt neue Versuche, ohne alte Historie zu verlieren.
6. Ein GitHub-Kommentar scheitert vorübergehend: Action wird wiederholt; Worker läuft **nicht** erneut. Bei endgültigem Fehler wird Kette gestoppt und manueller Retry angeboten.
7. Benutzer cancelt Run: gesamte kontrollierbare Prozessgruppe stoppt, `on_cancel` läuft, kein technischer Retry-Zähler.
8. Controller-Absturz: nach Neustart wird ein sicher identifizierter verwaister Prozess beendet, `on_crash` ausgeführt und vor Recovery-Ende kein Doppelstart zugelassen.
9. Cron-Workflow überspringt Termin bei Limit/Condition, statt Rückstand aufzubauen.
10. View „Needs Maintainer“ kombiniert zwei GitHub-Repositories und zeigt letzten Run/Result sowie klickbare Source-URL.
11. Ungültiger YAML-Reload lässt bisherigen aktiven Konfigurationsstand unverändert.
12. Keine Arbeitsdaten, Secrets und Logs gehen bei npm-Paketupdate verloren; Migration und Neustart sind überprüfbar.

## 23. Implementierungsplan (empfohlene Reihenfolge)

**Phase 1 – Fundament:** Monorepo/Package, CLI `init/start`, YAML-Lader+Zod-Schemas, Config-/Data-Verzeichnisse, SQLite-Migrationen, Run-Schema, Shell-Executor, Logfiles, Workspace und Kontext/Result-Protokoll.

**Phase 2 – GitHub und Scheduler:** GitHub App Credentials, Source-Adapter, Items/Filter, Polling, Prioritäten, Limits, atomare Locks, Lifecycle-Updates/Kommentare, Shell-Conditions.

**Phase 3 – Robustheit:** technische vs. fachliche Ergebnisse, technische Retry-Blocks, Action-Journal, Action-Retries, Cancel, Timeout, Drain, Crash-Recovery und systemd-Prototyp.

**Phase 4 – UI/API:** Fastify HTTP API, SSE, Dashboard, Runs, Blocked, Failed Actions, manuelle Starts, temporäre Overrides, Validierung und Dry-Run.

**Phase 5 – Erweiterungen V1:** Cross-Repo-Dependencies, Cron/Manual-Trigger, Parameterformulare, Views mit Run-Feldern, Systemnotifications, Retention, npm-Publishing und Service-Installer.

Nach jeder Phase automatisierte Tests und mindestens einen realen Coder-/Reviewer-Test-Workflow durchführen. Bestehende Agenten-Skripte können über Wrapper integriert werden, ohne ihre Rollen-Definitionen umzubauen.

## 24. Vor Implementierungsstart gezielt zu validierende Details

Die grundlegenden Produktentscheidungen sind getroffen. Diese Punkte sind bewusst als **technische Validierungen** offen und sollten kein unnötiges neues Feature-Scope erzeugen:

1. **GitHub API:** Native Issue-Dependencies samt Cross-Repo-Zugriff, Rechte und Grenzfälle für Issues/PRs gegen aktuelle offizielle API testen; API-Version pinnen.
2. **Worker-Exit-Konvention:** `0=success`, `1=failure`, `>=2=technical_error` an vorhandenen Bash-/Agent-Skripten prüfen. Vor allem darf ein versehentlicher Shell-Exit 1 nicht als fachliche Rückfrage fehlgedeutet werden. Ggf. gültige Ergebnisdatei als zwingenden Beleg für `failure` verlangen.
3. **Prozess-Supervision:** Linux-Prozessgruppen versus systemd-Scopes/cgroups und PID-Identität in einem kleinen Prototyp absichern; Crash-Recovery darf keine fremden Prozesse beenden.
4. **systemd-Shutdown:** Zusammenspiel von API-Drain, SIGTERM, `TimeoutStopSec` und `Restart=` explizit festlegen und testen.
5. **Lifecycle-Revert:** Kein blindes Rücksetzen manueller GitHub-Änderungen; Sicherheitsregeln für erwartete Labels und idempotente Kommentare konkretisieren.
6. **Npm-Namen, Node-LTS und npm-Dependency-Versionen:** Vor Paketveröffentlichung auswählen/pinnen und aktuelle Sicherheitslage prüfen.
7. **Cron-DST und versäumte Termine:** Exakte Semantik für doppelte/fehlende Lokalzeiten dokumentieren.
8. **Secret-Redaction:** Technische Grenzen offen dokumentieren – ein beliebiges Shell-Skript kann ihm bewusst überlassene Secrets ausgeben; zuverlässige Geheimhaltung setzt vertrauenswürdige Worker voraus.

---

**Zusammenfassung:** V1 ist ein konfigurationsgesteuerter Node.js-Orchestrator mit GitHub als fachlicher Source of Truth, persistentem Run-Journal, unabhängig ausführbaren Shell-Workflows und einer schlichten SSE-Weboberfläche. Er priorisiert und überwacht Arbeit, bietet Retry/Recovery, GitHub-App-Identitäten und frei definierbare Views, ohne ein eigenes Ticketsystem oder eine Pipeline-Engine aufzubauen.
