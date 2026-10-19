# Agent Dispatch Daemon (`adispatchd`) – Technische Spezifikation v0.1

> **Name:** Agent Dispatch Daemon – npm-Paket, Repository, systemd-Unit und Standardpfade `adispatchd`, CLI-Befehl `adispatch`. Ursprünglicher Arbeitsname: „Agent Orchestrator“ (`agent-orchestrator`); alle Bezeichner wurden entsprechend umbenannt (z. B. Umgebungsvariablen `ADISPATCH_*` statt `ORCH_*`, Kommentar-Marker `adispatchd:` statt `orch:`).

**Status:** Technischer Entwurf zur gemeinsamen Review, nicht implementiert  
**Ziel:** Eigenständig installierbarer, konfigurationsgetriebener Orchestrator für Shell-Prozesse und KI-Agenten  
**Technologie:** TypeScript, Node.js (unterstützte LTS-Version), SQLite, YAML, HTTP/SSE  
**Betrieb:** Linux (Produktion, systemd), macOS (lokal)  
**Stand:** 16. Oktober 2026

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
    ready-for-coding.yaml
  scripts/
    coder.sh
    check-credits.sh

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

## 6. Filter und Abhängigkeiten

Eine gemeinsame deklarative Filter-AST unterstützt `all`, `any`, `not` sowie mindestens `equals`, `not_equals`, `contains`, `in`, `greater_than`, `less_than` (vergleichbare Typen). Der Adapter kann Teile der Filter an die externe API pushen; verbleibende Prädikate werden lokal ausgewertet. Für eine unbekannte/fehlgeschlagene Bedingung gilt eine **dreiwertige Semantik**: `true`, `false`, `unknown`. `unknown` ist für automatische Ausführung nicht startfähig und wird diagnostizierbar angezeigt.

**GitHub Dependencies:** Die native `blocked by`-Relation muss über die GitHub-API aufgelöst werden, einschließlich referenzierter Issues in anderen Repositories, sofern die verwendete App darauf Zugriff besitzt. Ableitbare Felder: `dependencies.blocked_by_total`, `dependencies.blocked_by_open`, `dependencies.blocked` (optional), `dependencies.status`. Eine offene Abhängigkeit verhindert einen Start **nur dann**, wenn der Workflow dies ausdrücklich filtert. Fehlender API-Zugriff ist nicht „0 offene Abhängigkeiten“. Die tatsächliche API-Verfügbarkeit, Berechtigungen und Cross-Repo-Eigenschaften sind per Integrationstest gegen GitHub zu prüfen.

**Nachtrag 0.2.0 (WI-14) – Feldkatalog:** Billige Issue-Felder `state_reason`, `milestone` (Titel), `issue_type` (Name des Issue-Typs). Dazu je Source die deklarierten GitHub-Projects-Felder `project.<Name>` (Arten `single_select`/`text`/`iteration` → string, `number`, `date`), gelesen per GraphQL im selben Planungsschritt, nicht teuer, ohne Pushdown. Item nicht im Projekt → `null`; Projekt nicht erreichbar, Feld fehlt/falsche Art, Abfragefehler → nur die betroffenen `project.*` `unknown` (Grund über `SourceItem.unknownFields`), das Listing scheitert nicht. Die Offline-Validierung kennt `project.*` je Source (Views: nur gemeinsame Felder). Details: [configuration-reference.md](configuration-reference.md) §4.7.1.

**Nachtrag 0.2.0 (WI-15) – Benannte Filter:** Filter können einmal in `filters/<id>.yaml` (`id`, optional `description`, `filter`) definiert und überall im Filterbaum per `{ use: <id> }` bzw. als Kurzform `filter: <id>` verwendet werden (Workflow-`filter`, `item_priority.rules[].when`, View-`filter`, andere benannte Filter). Referenzen werden beim Laden expandiert; Scheduler, Views, Pushdown und Dry-Run sehen nur den eingesetzten Baum (Position nach dem Einsetzen zählt). Unbekannte IDs, Zyklen und Ketten tiefer als 16 Ebenen sind Konfigurationsfehler; Feldprüfungen laufen am Verwendungsort; unbenutzte Filter ergeben eine Warnung. Details: [configuration-reference.md](configuration-reference.md) §3.6.

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

### 9.3 Logs und Events

stdout und stderr werden als unveränderte Logs persistiert. Optional kann eine Zeile mit reserviertem Präfix ein Event transportieren:

```text
@@ADISPATCH_EVENT {"type":"status","message":"Tests laufen"}
@@ADISPATCH_EVENT {"type":"progress","value":60}
@@ADISPATCH_EVENT {"type":"question","message":"Welcher OAuth-Anbieter?"}
```

Events werden separat mit Run-ID und Zeitstempel in SQLite gespeichert, zudem per SSE an die GUI gesendet. Sie sind **nur informativ**, lösen keine Workflow-Transitionen aus. Ein `question`-Event startet keine automatische Rückfragefunktion. Letzte Statusmeldung kann auf Run-Karten erscheinen. Ungültige Event-Zeilen bleiben in Rohlogs und erzeugen optional einen Parser-Warnhinweis.

## 10. Lifecycle-Aktionen

Unterstützte Hooks: `on_start`, `on_success`, `on_failure`, `on_crash`, `on_start_error`, `on_cancel`, `on_timeout`.

Aktionstypen V1:

- `source.update`: durch Adapter unterstützte Änderung am Source-Item (z. B. GitHub Labels).
- `source.comment`: Kommentar über Adapter, mit optionaler Action-Identity.
- `shell`: beliebiges Shell-Skript mit Run-/Result-Kontext, isolierter Umgebung und konfigurierbarem Timeout.

Hooks bestehen aus sequenziellen Actions. Standardmäßig wird eine fehlgeschlagene Action 3-mal (30 s Pause) versucht; danach bleibt die Kette an dieser Position stehen und wird als fehlerhaft angezeigt. `continue_on_error: true` lässt nach erschöpften Versuchen die nächsten Actions zu. Einzelne Actions können Retry-Vorgaben überschreiben. GUI unterstützt **Retry Action** und Wiederaufnahme der Kette, ohne den Haupt-Worker neu zu starten.

**Action-Journal:** Jede Action hat stabile ID/Ordinalposition und persistierte Zustände `pending`, `running`, `succeeded`, `failed`, `skipped`; jeder Versuch bekommt Zeit, Fehler und ggf. externe Referenz. Neustart darf erfolgreich bestätigte Actions nicht neu ausführen.

**Idempotenz:** Genau-einmal-Ausführung gegenüber GitHub ist ohne verteilte Transaktion nicht garantiert. `source.update` soll möglichst idempotent sein. `source.comment` enthält idealerweise eine eindeutige, unauffällige Run-/Action-Kennung, anhand derer vor Wiederholung eine bereits erfolgte Veröffentlichung gefunden werden kann. Bei unklarem Erfolg muss ein manueller Abgleich statt blindem Duplikat möglich sein. Bei Reverts nur die erwartete vorherige Änderung zurücknehmen; GitHub-Status vor dem Schreiben neu lesen, um manuelle Änderungen möglichst zu erhalten.

## 11. Retry-Blocks für technische Fehler

Ein technischer Fehler ist `crashed`, `start_error` oder `timed_out`; **fachliches** `failure` ist keiner. `cancelled` ebenfalls nicht. Standardvorschlag `max_technical_failures: 3` pro Workflow. Es zählen aufeinanderfolgende technische Fehler **derselben Workflow/Item-Kombination** seit dem letzten erfolgreichen Abschluss bzw. der letzten manuellen Entblockung. Zwischendurch erfolgte Bearbeitungen am GitHub-Issue setzen die Zählung **nicht** zurück. Fachliches `failure` löst seinen konfigurierten Hook aus und führt typischerweise zu `needs-maintainer`; es erzeugt keinen Retry-Block.

Bei Erreichen des Limits entsteht ein Datensatz `blocks(workflow_id, item_key, reason, created_at, ...)`. Für sourcefreie Cron- oder Manual-Workflows ist der Blockschlüssel workflowbezogen. Die GUI zeigt Blockursache, Quelllink, betroffene Runs und **Remove Block**. Entblocken gibt die nächste automatische Auswahl frei und startet eine neue Zählperiode; alte Runs/Logs bleiben erhalten. Manuelle Starts **umgehen Retry-Blocks**, aber nicht den aktiven Doppelstart-Lock.

**Wichtige Reihenfolge:** Beim technischen Fehler den Abschlusszustand und den Block konsistent persistieren; `on_crash`/`on_timeout` können die Source wieder auf `ready-for-coding` setzen. Der Block verhindert dann automatisch weitere Starts, selbst wenn der externe Filter wieder passt.

## 12. SQLite-Datenmodell (logisches Schema)

Die Tabellen unten sind konzeptionell; DDL, Indizes, Fremdschlüssel und Migrationen sind vor Implementierung auszuarbeiten.

| Tabelle | Relevante Spalten | Zweck |
|---|---|---|
| `runs` | `id`, `workflow_id`, `trigger_type`, `source_id`, `source_item_key`, `source_url`, `config_snapshot`, `parameters_json`, `status`, `business_result`, `exit_code`, `pid`, `process_start_identity`, `workspace_path`, `started_at`, `finished_at`, `lifecycle_status` | Versuche und Ausführungshistorie |
| `run_events` | `id`, `run_id`, `sequence`, `timestamp`, `type`, `payload_json` | Strukturierte Events |
| `run_actions` | `id`, `run_id`, `hook`, `ordinal`, `action_config_json`, `status`, `external_key` | Action-Journal |
| `action_attempts` | `id`, `run_action_id`, `attempt`, `started_at`, `finished_at`, `error_json` | Retry-/Fehlerdiagnose |
| `blocks` | `id`, `workflow_id`, `source_item_key_nullable`, `reason`, `created_at`, `cleared_at_nullable`, `generation` | Persistente technische Blocks |
| `locks` | `workflow_id`, `source_item_key`, `run_id`, `acquired_at` | Aktive Reservierungen |
| `notifications` | `id`, `event_type`, `payload_json`, `delivery_state`, `attempts`, `created_at` | Systemmeldungen |
| `cron_firings` | `workflow_id`, `scheduled_for`, `run_id_nullable`, `decision` | Cron-Idempotenz und Diagnose |
| `schema_migrations` | `version`, `applied_at` | Updates |

SQLite erhält Fremdschlüssel, WAL-Modus (wo sinnvoll) und atomare Transaktionen für Run-/Lock-Erstellung. Unique-Constraint für aktive `(workflow_id, source_item_key)`-Reservierungen; bei sourcefreien Runs passende Semantik nach Trigger. Historische Run-Konfigurationssnapshots sind wesentlich für Abschluss-Hooks nach Reload und Recovery. Persistenz jeder Run-Transition und jeder Action-Zustandsänderung hat Vorrang vor UI-Kosmetik.

**Hinweis:** Datenbank und Logdateien sind gemeinsam das Run-Journal. Inkonsistenzen zwischen ihnen müssen diagnostizierbar sein; bei DB-Erfolg und Dateischreibfehler ist ein Fehlerereignis zu speichern, statt einen vollständigen Log zu behaupten.

## 13. Prozess-Supervision und Cancel

Der Shell-Executor startet eine eigene Prozessgruppe und überwacht Spawn-Erfolg, Exit-Code, Signal und stdout/stderr. `Cancel` per GUI/HTTP: Run auf `cancelling` setzen, `SIGTERM` an die Gruppe, nach konfigurierbarem Grace-Timeout `SIGKILL`, Prozessende bestätigen, `on_cancel` abarbeiten und final `cancelled` setzen. Misslingt das Beenden, ist der Run **nicht** voreilig als abgeschlossen zu kennzeichnen. Andere Prozesse/Container, die ein Skript losgelöst startet, kann die Shell-Prozessgruppe unter Umständen nicht erfassen; das Skript trägt hierfür die Cleanup-Verantwortung.

**PID allein reicht nicht:** Beim erneuten Auffinden muss mindestens PID plus verlässliche Startidentität/OS-Prozesszuordnung verwendet werden. PID-Reuse darf nicht zum Töten eines fremden Prozesses führen. Für Linux sollte vor Produktionsfreigabe ein kleiner **Prozess-Supervisor-Spike** erproben, ob `systemd`-Scopes/cgroups oder ein dedizierter Wrapper für Crash-Recovery und kontrolliertes Töten erforderlich sind. Bei unsicherer Identität niemals blind eine PID terminieren.

## 14. Shutdown, Drain und Recovery

- **Pause:** verhindert neue automatische Starts; laufende Runs werden nicht verändert.
- **Drain (Standard):** keine neuen Runs, aktive Runs sauber abschließen, dann Dienst stoppen.
- **Cancel All & Shutdown:** automatische Starts stoppen, alle Runs kontrolliert abbrechen, `on_cancel` ausführen, Dienst stoppen.
- **Unerwarteter Crash:** Nach Neustart zunächst alle zuvor aktiven Runs und möglichen Prozessgruppen erfassen, noch lebende eindeutig zuordenbare Gruppen beenden (Variante A), verschwundene Runs als `crashed` behandeln, fällige Hooks und technische Retries/Blocks rekonstruieren, erst **danach** Scheduler freigeben.

**Kein Attach an verwaiste Worker in V1.** Die Recovery soll diese gezielt beenden, nicht übernehmen. Nicht zugreifbare oder nicht identifizierbare Prozesse führen zu einem sichtbaren Recovery-Fehler und dürfen keine unkontrollierten automatischen Doppelstarts auslösen.

systemd: `Restart=on-failure`, dedizierter Benutzer, feste absolute Executable, sauber abgestimmtes Stop-/Timeout-Verhalten. Ein absichtlicher GUI-Shutdown darf nicht unbeabsichtigt von systemd als crashbedingter automatischer Neustart behandelt werden. Der tatsächliche Service-Vertrag muss in Integrationstests mit `systemctl stop`, App-Absturz und Server-Reboot getestet werden. Ein sofortiger Prozess-Kill durch den Service-Manager kann keinen Drain garantieren; für geplante Abschaltungen ist ein CLI/API-Drain-Schritt vorzusehen.

## 15. HTTP-API und SSE (Entwurf)

Basis: `/api/v1`; JSON-Antworten; mutierende Requests via POST/PATCH; SSE unter `/api/v1/events` oder runbezogenem Stream. API lauscht standardmäßig **nur auf `127.0.0.1`**. Keine integrierte Anmeldung in V1: Absicherung zwingend durch Reverse Proxy/VPN/Tailscale; unsichere öffentliche Bindung ist deutlich zu warnen. CORS und CSRF-Risiken auch hinter Reverse Proxy berücksichtigen.

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

- **Dashboard:** Scheduler-Status, globales Limit und Auslastung, Pause/Resume, Drain, Cancel All, aktive Runs und letzte Agent-Statusmeldungen.
- **Runs:** Name, Run-ID, Workflow, Agenten-/Rollenidentität, Trigger, Start/Ende/Dauer, Arbeitsverzeichnis, Startkommando, Exit-Code, Source-URL, Input-JSON, Ergebnis-JSON, Rohlogs, Events, Lifecycle-Aktionen; bei aktiven Runs `Cancel`.
- **Workflows:** aktiv/inaktiv, Priorität, Max-Parallelität, aktueller Verbrauch, manuelle Starts (Source-URL + optionale Parameter), Dry-Run; Runtime-Overrides für `enabled`, `priority`, Limits.
- **Blocked:** Blockschlüssel, Fehlversuche, Run-Links, Source-URL, Remove Block. Nicht mit GitHub-„blocked by“ oder einem GitHub-Label verwechseln.
- **Failed Actions:** Fehler, Versuche, manuelle Wiederholung.
- **Configuration:** YAML nur lesend anzeigen, Validierung, Fehler und manueller Reload. Runtime-Overrides bleiben **nicht** nach Neustart erhalten; Reload setzt betroffene Overrides auf YAML-Werte zurück.
- **Live-Updates:** SSE für Logs, strukturierte Events, Run-Zustände und Systemstatus. Alle Steuerbefehle per HTTP.

Die GUI muss bei komplexen Logs nur benötigte Bereiche laden (Paging/Tailing), keine 100-MB-Datei auf einmal in den Browser senden.

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

Filter nur deklarativ, keine Shell-Filter, keine zusätzlichen UI-Filter/Textsuche. Spaltensortierung im Browser ist erlaubt. Daten werden beim Öffnen/Refresh aus Sources geladen; optional kurzer Cache. Source-Adapter liefern deklarierte Felddefinitionen samt Typ, optionalem Link und unterstützten Operatoren. Nicht verfügbare Spalten bleiben erkennbar leer. `run.last_*` bezieht sich auf den letzten passenden, zeitlich eindeutig bestimmten Run; bei Bedarf später workflowbezogene Selektoren ergänzen. Auch bei mehreren Repositories muss die Item-ID global eindeutig sein.

## 18. Benachrichtigungen

**Workflow-Benachrichtigungen** über `source.comment` oder `shell`-Hook (z. B. Slack-Skript). **Kritische Orchestrator-Ereignisse** erhalten ein zentrales, konfigurierbares Benachrichtigungssystem, z. B. HTTP-Webhook/Slack-Webhook als erster Kanal: Retry-Block erstellt, Lifecycle endgültig gescheitert, Recovery fehlgeschlagen. Zustellung und Versuche werden gespeichert, Fehlzustellungen in GUI gezeigt. Die Orchestrierung darf bei Benachrichtigungsfehler nicht hängen. Secrets in Notification-URLs/-Headers schützen und redigieren.

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

## 21. Betrieb, Observability und Aufbewahrung

- Health: `/health`; Readiness: `/ready` (Recovery abgeschlossen, DB verfügbar, Konfiguration gültig). Optional später `/metrics`.
- Logs: pro Run stdout/stderr als Dateien; Status-/Events in SQLite; interne Fehler separat im Dienstlog; SSE als Live-Transport.
- Default-Retention-Vorschlag: erfolgreiche Runs 30 Tage, fehlgeschlagene/abgebrochene 90 Tage, offene Blocks und unvollständige Lifecycle-Ketten nicht löschen. `never` pro Kategorie möglich. Maximale Logs 100 MB/Run, Overflow klar markieren. Tägliche Cleanup-Prüfung.
- Unterscheidung `failed` als **fachliches Ergebnis** gegenüber **technischem** `crashed` und separat `lifecycle failed` in API und UI eindeutig darstellen.
- Nur eine Instanz pro Data-Dir durch OS-weite exklusive Sperre; Stale-Lock-Erkennung darf nicht versehentlich zwei Instanzen erlauben. Mehrere getrennte Data-Dirs koordinieren sich **nicht** gegenseitig.

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
