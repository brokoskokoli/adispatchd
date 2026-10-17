# Konfigurationsreferenz

> **Verbindlichkeit.** Dieses Dokument ist die maßgebliche Referenz für alle Dateien im `config-dir`. Es **ersetzt
> die vorgeschlagenen Dateiformate** der Spezifikation ([spec-v0.1.md](spec-v0.1.md) §5, §6, §17, §18 und die
> YAML-Beispiele dort). Alles hier ist aus dem Code abgeleitet (`src/config/`, `src/core/`, `src/filters/`,
> `src/sources/github/`, `src/scheduler/`, `src/runs/`, `src/lifecycle/`, `src/executors/`,
> `src/notifications/`, `src/views/`). Weicht etwas vom Code ab, ist das ein Fehler dieses Dokuments.
>
> **Abgesichert durch Tests:** Alle YAML-Blöcke mit Kopfzeile `# file: <pfad>` werden von
> `src/config/reference-doc.test.ts` je Beispiel-Set (`# example: <name>`) in ein temporäres config-dir geschrieben
> und mit dem echten Loader validiert. Blöcke mit `# invalid` müssen die unter `# expect:` dokumentierte
> Fehlermeldung liefern. Kopfzeilen: `# example:` (Set-Name), `# extends:` (übernimmt zuerst alle Dateien eines
> anderen Sets), `# file:` (Zielpfad relativ zum config-dir), `# invalid`, `# expect:` / `# expect-warning:`
> (Teilstring von `<datei>: <pfad>: <meldung>`). Blöcke ohne `# file:` sind Ausschnitte und werden nicht geprüft.

## Inhalt

1. [Überblick](#1-überblick)
2. [Gemeinsame Datentypen](#2-gemeinsame-datentypen)
3. [Die Dateien](#3-die-dateien) – [config.yaml](#31-configyaml), [sources.yaml](#32-sourcesyaml),
   [identities.yaml](#33-identitiesyaml), [workflows/*.yaml](#34-workflowsyaml), [views/*.yaml](#35-viewsyaml)
4. [Filter-Sprache](#4-filter-sprache)
5. [Platzhalter-Referenz](#5-platzhalter-referenz)
6. [Auswertungsablauf](#6-auswertungsablauf)
7. [Vollständige Beispiele](#7-vollständige-beispiele)
8. [Häufige Validierungsfehler](#8-häufige-validierungsfehler)
9. [Checkliste „neuen Workflow anlegen“](#9-checkliste-neuen-workflow-anlegen)

---

## 1. Überblick

### 1.1 Verzeichnisstruktur

```text
config-dir/
  config.yaml          globale Einstellungen                      optional (fehlt → Warnung, Defaults)
  sources.yaml         externe Quellen (V1: GitHub-Repositories)  optional (fehlt → keine Sources)
  identities.yaml      GitHub-App-Identitäten                     optional (fehlt → keine Identities)
  workflows/*.yaml     ein Workflow pro Datei                     optional (fehlt → keine Workflows)
  views/*.yaml         eine View pro Datei                        optional
  scripts/…            frei; Skripte werden über Pfade referenziert (siehe §2.4)
```

`agent-orchestrator init --config-dir D --data-dir D` legt eine kommentierte, gültige Beispielkonfiguration an
(`src/cli/init-templates.ts`): `config.yaml`, `sources.yaml`, `identities.yaml`, `workflows/hello.yaml`
(manuell, aktiv), `workflows/coder.yaml` und `workflows/nightly-maintenance.yaml` (beide `enabled: false`),
`views/needs-maintainer.yaml` und Beispielskripte unter `scripts/`. `init` überschreibt nie bestehende Dateien.

Das `data-dir` (SQLite, Logs, `runs/<id>/context.json|result.json`, Default-Workspaces) ist **keine**
Konfiguration und wird hier nur erwähnt, wo es Defaults bestimmt.

### 1.2 Dateinamensregeln

| Regel | Verhalten |
|---|---|
| Top-Level-Dateien | exakt `config.yaml`, `sources.yaml`, `identities.yaml`. `.yml`-Varianten werden **nicht** gelesen. |
| `workflows/`, `views/` | alle Einträge, deren Name auf `.yaml` **oder** `.yml` endet und nicht mit `.` beginnt, alphabetisch sortiert. |
| Unterordner | werden **nicht** rekursiv gelesen (`workflows/alt/x.yaml` wird ignoriert). Ein *Verzeichnis* namens `x.yaml` ist ein Fehler („Not a regular file“). |
| Versteckte Dateien | `.foo.yaml` wird ignoriert (z. B. Editor-Backups). Andere Endungen (`x.yaml.bak`, `x.json`) ebenfalls. |
| Dateiname ↔ `id` | Maßgeblich ist das Feld `id`. Weicht der Dateiname (ohne Endung) davon ab, gibt es nur eine **Warnung** (nur für Workflows). Doppelte `id` über zwei Dateien ist ein **Fehler** in der alphabetisch späteren Datei. |
| Größe | max. 1 MiB pro Datei, sonst Fehler. |

### 1.3 Kodierung und YAML-Dialekt

- Dateien werden als **UTF-8** gelesen (Parser `yaml`, YAML **1.2** Core-Schema).
- Folge von YAML 1.2: `yes`/`no`/`on`/`off` sind **Strings**, keine Booleans. Schreibe `true`/`false`.
  (`enabled: yes` ist daher ein Typfehler.)
- Doppelte Schlüssel in einem Mapping sind ein Fehler („Map keys must be unique“).
- Anker/Aliase sind erlaubt (max. 100 Alias-Auflösungen pro Datei).
- Die oberste Ebene jeder Datei muss ein Mapping sein. Eine leere Datei gilt als leeres Mapping
  (für `config.yaml` also „alle Defaults“; für einen Workflow fehlen dann Pflichtfelder).
- **Alle Objekte sind strikt:** unbekannte Schlüssel (Tippfehler) sind Fehler: `Unknown key(s): "…"`.
- Zahlen sind YAML-Zahlen. Wo ein String erwartet wird (Dauer, Größe, `args`), ist eine unquotierte Zahl ein
  Typfehler. Ausnahme: Werte in `env`-Maps dürfen Zahl/Boolean sein und werden zu Strings (`PORT: 8080` → `"8080"`).

### 1.4 Wie geladen und validiert wird

`config validate`, `start` und `config reload` verwenden denselben Loader (`src/config/loader.ts`):

1. config-dir muss existieren und ein Verzeichnis sein.
2. Alle Dateien werden gelesen und geparst (YAML-Syntaxfehler mit Zeilennummer).
3. Jede Datei wird gegen ihr Schema geprüft (`src/config/schemas.ts`: Struktur, Typen, Dauern, Größen, Defaults).
   Ist `config.yaml` ungültig, werden Workflows trotzdem gegen die **Default**-Globalwerte weitergeprüft.
4. Semantische Prüfung über alle Dateien (`src/config/validate.ts`): Referenzen, eindeutige IDs, Platzhalter je
   Kontext, Widersprüche, Cron/Zeitzone, Parameter-Defaults.
5. **Alle** Probleme aller Dateien werden gesammelt (nicht beim ersten abgebrochen), sortiert nach Datei, Zeile,
   Pfad, und als `datei:zeile: pfad: meldung` ausgegeben. Warnungen (`warning:`) verhindern das Laden nicht.

Folgefehler sind möglich: Ist z. B. `identities.yaml` ungültig, meldet `sources.yaml` zusätzlich
`Unknown identity "…"`. Den ersten Fehler zuerst beheben.

Der Loader liest **keine** Umgebungsvariablen. `config validate` prüft also nicht, ob `private_key_env`,
`url_env` oder `headers_env` gesetzt sind, und es prüft weder Skriptpfade auf Existenz noch Filter-Feldnamen
gegen den Adapter (siehe §4.3). Exit-Code: 0 = gültig (ggf. mit Warnungen), 1 = ungültig.

### 1.5 Wann Änderungen wirken

Konfigurationsänderungen wirken **nur** durch einen manuellen Reload (`agent-orchestrator config reload`,
`POST /api/v1/config/reload`, UI „Reload“) oder einen Neustart. Es gibt keine Dateiüberwachung.

- **Atomar:** Der Reload lädt alles neu. Nur wenn **kein Fehler** auftritt, wird die neue Konfiguration aktiv;
  sonst bleibt die bisherige vollständig aktiv (HTTP 422 `config_invalid` mit allen Fehlern).
- **Laufende Runs** verwenden den beim Reservieren gespeicherten Snapshot ihres Workflows (inkl. `execute`, Hooks,
  `workspace`, effektiver Action-Retry-Werte und der Source-Konfiguration). Ein Reload ändert laufende Runs und
  deren spätere Hooks nicht; auch manuelle Retries von Actions nutzen den Snapshot.
- Nach einem erfolgreichen Reload läuft sofort ein Planungsschritt.

| Bereich | Wirkung nach erfolgreichem Reload |
|---|---|
| `server.host`, `server.port` | erst nach Neustart |
| `server.allowed_hosts` | sofort (nächster Request) |
| `scheduler.polling_interval` | für den nächsten Timer (nach dem laufenden Planungsschritt) |
| `scheduler.max_concurrent` | sofort |
| `workspace.*`, `lifecycle.action_retry` | für neu reservierte Runs (Snapshot) |
| `retention.*` | ab dem nächsten Retention-Durchlauf; `cleanup_interval` bestimmt den Timer nach jedem Durchlauf |
| `notifications.*` | sofort für neue Benachrichtigungen; offene Zustellungen an entfernte Kanäle scheitern endgültig |
| `sources.yaml`, `identities.yaml` | Adapter/Credentials werden neu aufgebaut, wenn sich etwas geändert hat; entfernte bleiben für laufende Runs verfügbar |
| Workflows | sofort für Planung/Cron; geänderte Cron-Ausdrücke planen ab „jetzt“; Cache der Workflow-Conditions wird geleert |
| Views | sofort; View-Cache wird verworfen |
| Umgebungsvariablen (Keys, Webhook-URLs, Header) | gehören zum Prozess, nicht zur Konfiguration → Änderung erfordert **Neustart** |

**Runtime-Overrides** (UI bzw. `PATCH /api/v1/workflows/:id/runtime`, `PATCH /api/v1/scheduler/runtime`):
pro Workflow `enabled`, `priority`, `maxConcurrent`, global `maxConcurrent`. Sie werden **nicht persistiert**
(Neustart = weg), gehören nicht zum Run-Snapshot und wirken nur auf das Scheduling. Beim Reload:

- ein Workflow-Override wird **pro Feld** zurückgesetzt, wenn sich genau dieser konfigurierte Wert geändert hat;
  andere Änderungen am Workflow lassen ihn bestehen;
- ein entfernter Workflow verliert alle Overrides;
- das globale Override wird zurückgesetzt, wenn sich `scheduler.max_concurrent` geändert hat;
- die Antwort nennt betroffene Workflows in `resetOverrides` (`"*"` = global).

---

## 2. Gemeinsame Datentypen

### 2.1 Dauer

Syntax: `<zahl><einheit>` – genau **eine** Zahl und **eine** Einheit, optional umgebende Leerzeichen.

| Einheit | Bedeutung |
|---|---|
| `ms` | Millisekunden |
| `s` | Sekunden |
| `m` | Minuten |
| `h` | Stunden |
| `d` | Tage (24 h) |

- Dezimalzahlen sind erlaubt, wenn das Ergebnis ganze Millisekunden ergibt: `1.5h`, `0.5s` ✓, `0.0001s` ✗.
- Nicht erlaubt: zusammengesetzte Formen (`1h30m` → `90m`), Leerzeichen zwischen Zahl und Einheit (`6 h`),
  negative Werte, fehlende Einheit, Großbuchstaben (`30S`), unquotierte Zahlen (`timeout: 30`).
- `0s` ist syntaktisch gültig. Nur `execute.timeout.max_duration` und `execute.timeout.idle_timeout` verlangen
  ausdrücklich > 0.
- Wo `never` erlaubt ist (`retention.*_runs`), bedeutet es „nie löschen“.

### 2.2 Größe

Syntax: `<zahl>[ ]<einheit>`, Einheit ohne Beachtung der Groß-/Kleinschreibung: `B`, `KB`, `MB`, `GB`, `KiB`,
`MiB`, `GiB`. **Alle** Einheiten sind binär (`1 KB = 1024 B`, `100MB = 104 857 600 B`). Dezimalzahlen erlaubt
(abgerundet auf ganze Bytes). Eine Zahl ohne Einheit ist ungültig.

### 2.3 IDs und Namen

| Art | Regel | Verwendung |
|---|---|---|
| Konfigurations-ID | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` – Buchstaben, Ziffern, `_`, `-`; beginnt mit Buchstabe/Ziffer; 1–64 Zeichen; Groß-/Kleinschreibung zählt | Workflow-`id`, View-`id`, Source- und Identity-Schlüssel, Action-`id`, Kanal-`id`, alle Referenzen darauf |
| Parametername | `^[A-Za-z_][A-Za-z0-9_-]*$` | Schlüssel unter `parameters`, `{parameters.<name>}` |
| Env-Variablenname | `^[A-Za-z_][A-Za-z0-9_]*$` | Schlüssel in `env`/`secrets`, `private_key_env`, `url_env`, Werte in `headers_env` |
| Präfix `ORCH_` | in `env`/`secrets` verboten (Groß-/Kleinschreibung egal) | reserviert für das Worker-Protokoll |
| HTTP-Header-Name | `^[A-Za-z0-9-]+$` | Schlüssel in `headers_env` |

Source-IDs sind Teil des globalen Item-Schlüssels `<source-id>:<item-id>` (z. B. `project_a:123`), der für Locks,
Retry-Blocks, Run-Historie und Views benutzt wird. **Umbenennen einer Source trennt die Historie.**

### 2.4 Pfade und Kommandos

| Feld | Auflösung |
|---|---|
| `workspace.base_dir` | absolut bleibt; relativ → relativ zum **config-dir** (nicht zum Arbeitsverzeichnis). Default `<data-dir>/workspaces`. |
| `command` in `execute`, `conditions.*`, `shell_filter`, `shell`-Actions | absolut → normalisiert; enthält `/` (`scripts/x.sh`, `./x.sh`, `../x`) → relativ zum **config-dir**; ohne `/` (`bash`, `gh`) → bleibt Name für die **PATH-Suche** zur Laufzeit (PATH der Minimalumgebung, §6.11). |
| `execute.working_directory` | Platzhalter-Template im Modus `path` (§2.5); muss mit `/` oder `{workspace.base_dir}` beginnen. |

Es gibt **keine Shell**: `command` ist genau ein ausführbares Programm, Argumente kommen ausschließlich aus `args`
(Liste, ein Element = ein Argument, keine Wortzerlegung, keine Globs, keine `$VAR`-Expansion).
`command: 'test -f /x'` ist falsch (würde als Pfad `config-dir/test -f /x` aufgelöst). Für Pipes etc.:
`command: /bin/sh`, `args: ['-c', '…']` – dann liegt die Quotierung beim Autor. `command` ist **kein**
Template; Platzhalter in `command` werden nicht ersetzt. Existenz/Ausführbarkeit wird erst zur Laufzeit geprüft
(→ `start_error` bzw. Prüffehler).

### 2.5 Platzhalter-Syntax

- Form `{name}`, z. B. `{run.id}`, `{parameters.version}`; Leerzeichen innerhalb der Klammern werden ignoriert.
- Nur die feste Liste aus §5 ist erlaubt; jeder andere Name ist ein Konfigurationsfehler
  (`Unknown placeholder "{…}"`), ebenso ein Platzhalter außerhalb seines Kontexts
  (`… is not available in this context`) und ein nicht deklarierter Parameter (`Parameter "x" is not declared`).
- **Escaping:** `{{` ergibt `{`, `}}` ergibt `}`. Ein einzelnes `}` oder ein nicht geschlossenes `{` ist ein
  Syntaxfehler. Beispiel: `'{{"run":"{run.id}"}}'` → `{"run":"run-2026…"}`.
- Templates sind nur folgende Felder: `execute.working_directory` (Modus `path`), `execute.args[]`,
  `execute.env.*`, `conditions.workflow[].args[]`, `conditions.item[].args[]`, `source.comment.message`,
  `shell`-Action `args[]` und `env.*` (alle Modus `text`). **Keine** Templates: `command`, Labels in
  `source.update`, Filterwerte, `secrets`, alle übrigen Felder.

**Modus `text`:** Werte werden unverändert eingesetzt (Zahlen/Booleans als `5`, `true`). Ein erlaubter Platzhalter
ohne Wert wird zu einem **leeren String**.

**Modus `path`** (nur `working_directory`):

- `{workspace.base_dir}` ist eine vertrauenswürdige Wurzel: nur ganz am Anfang erlaubt und muss von `/` oder dem
  Ende gefolgt werden (`{workspace.base_dir}{run.id}` ist ein Fehler).
- Jeder andere Wert wird zu **genau einem** sicheren Pfadsegment: jedes Zeichen außer `[A-Za-z0-9._@+=,-]` wird
  `_` (auch `/`, `\`, Leerzeichen, NUL); ein Wert nur aus Punkten wird zu Unterstrichen; leer → `_`; max. 128 Zeichen.
- Literale Teile des Templates werden **nicht** bereinigt; das Ergebnis wird normalisiert (`..` im Literal wird
  aufgelöst – das ist Sache des Autors).
- Ein Platzhalter ohne Wert ist ein **Fehler** (Run endet als `start_error`). Deshalb dürfen im
  `working_directory` nur Parameter stehen, die `required` sind oder einen `default` haben.
- Das Ergebnis muss absolut sein und darf nicht `workspace.base_dir` selbst sein.

**Sicherheit:** Ersetzte Werte (z. B. `{item.title}`, `{result.message}`) stammen aus externen Quellen und sind
untrusted. In `args` sind sie wegen der fehlenden Shell unkritisch; wer sie über `/bin/sh -c` interpoliert,
erzeugt eine Injection. In `source.comment.message` wird `<!--` zu `&lt;!--` neutralisiert (§6.9).

---

## 3. Die Dateien

### 3.1 config.yaml

Alle Schlüssel sind optional. Fehlt die Datei, gelten alle Defaults (mit Warnung).

| Schlüssel | Typ | Default | Erlaubte Werte / Regeln | Bedeutung |
|---|---|---|---|---|
| `server.host` | String | `127.0.0.1` | nicht leer | Bind-Adresse von API/UI. Keine Authentifizierung – nur Loopback oder hinter authentifizierendem Proxy/VPN. |
| `server.port` | Integer | `8787` | 1–65535 | TCP-Port. |
| `server.allowed_hosts` | Liste String | `[]` | je `name` oder `name:port`; IPv6 in Klammern (`[::1]:8787`) | zusätzliche Namen, die im `Host`-Header akzeptiert werden (DNS-Rebinding-Schutz), z. B. der öffentliche Name des Reverse-Proxys. Vergleich ohne Groß-/Kleinschreibung; `name` = jeder Port, `name:port` = nur dieser Port (ein `Host` **ohne** Port gilt dabei als Port 80). Immer erlaubt: `localhost`, `127.0.0.1`, `[::1]` und – wenn nicht Loopback/Wildcard – `server.host` selbst. |
| `scheduler.polling_interval` | Dauer | `30s` | | Pause zwischen zwei Planungsschritten (gemessen ab Ende des vorherigen). |
| `scheduler.max_concurrent` | Integer | `5` | ≥ 1 | Globales Limit für **automatische** Starts. Gezählt werden alle aktiven Runs (inkl. manueller und `recovery_pending`). |
| `workspace.base_dir` | String | `<data-dir>/workspaces` | relativ → zum config-dir | Wurzel der Run-Workspaces; nur Verzeichnisse **strikt darunter** werden symlink-sicher angelegt und automatisch gelöscht. |
| `workspace.cleanup` | Enum | `on_success` | `always`, `on_success`, `never` | Wann der Workspace nach Run-Ende gelöscht wird (§6.12). |
| `lifecycle.action_retry.max_attempts` | Integer | `3` | ≥ 1 | Standard-Anzahl **Versuche insgesamt** pro Lifecycle-Action. |
| `lifecycle.action_retry.delay` | Dauer | `30s` | | Pause zwischen Versuchen (mind. ein `Retry-After` der API). |
| `retention.completed_runs` | Dauer \| `never` | `30d` | | Aufbewahrung erfolgreicher Runs (`completed` + `success`). |
| `retention.failed_runs` | Dauer \| `never` | `90d` | | alle anderen beendeten Runs (fachlich `failure`, technisch gescheitert, `cancelled`), soweit nicht „blocked“. |
| `retention.blocked_runs` | Dauer \| `never` | `never` | | Runs, deren technischer Fehler in einen Retry-Block gezählt wurde. |
| `retention.max_log_size_per_run` | Größe | `100MB` | | Log-Limit des Haupt-Workers pro Run (stdout+stderr); Überlauf wird markiert. |
| `retention.cleanup_interval` | Dauer | `24h` | | Abstand der Retention-Durchläufe (erster Lauf 60 s nach Bereitschaft). |
| `notifications.on` | Liste Enum | alle drei | `retry_block_created`, `lifecycle_action_failed`, `recovery_failed` | global aktivierte Ereignisse. `[]` = keine Benachrichtigungen. |
| `notifications.channels` | Liste | `[]` | | Zustellkanäle, siehe unten. |

Retention löscht nie aktive Runs, Runs mit unfertiger oder gescheiterter Lifecycle-Kette und Runs eines **aktiven**
Retry-Blocks. Gelöscht werden DB-Zeilen, `runs/<id>/`, `logs/<id>/` und der Workspace (nur unter `base_dir`).

**Kanal `type: webhook`:**

| Schlüssel | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `type` | `webhook` | ja | | einziger Kanaltyp in V1 |
| `id` | Konfigurations-ID | nein | `channel-<n>` (1-basiert nach Position) | eindeutig innerhalb der Kanäle |
| `url` | String | genau eines von `url`/`url_env` | | absolute `http(s)`-URL. Wird intern redigiert, kann aber Tokens enthalten → besser `url_env`. |
| `url_env` | Env-Name | genau eines von `url`/`url_env` | | Umgebungsvariable mit der URL (gelesen bei jeder Zustellung; fehlt sie → Zustellung scheitert endgültig). |
| `headers_env` | Map Header-Name → Env-Name | nein | `{}` | zusätzliche HTTP-Header, Werte aus Umgebungsvariablen (fehlt eine → Zustellung scheitert endgültig). |
| `on` | Liste Enum | nein | `notifications.on` | Ereignisse für diesen Kanal. Wirksam ist nur die Schnittmenge mit `notifications.on`. |

Zustellung: `POST` mit `content-type: application/json`, Body
`{"source":"agent-orchestrator","id":…,"event":"…","createdAt":"…","text":"[agent-orchestrator] …","payload":{…}}`
(Slack-kompatibles `text`), Timeout 10 s, keine Redirects. 2xx = Erfolg; 408/429/5xx/Netzfehler werden bis zu
6-mal versucht (Pausen 5 s, 30 s, 2 min, 10 min, 30 min); andere Status sind endgültig. Ereignisse:
`retry_block_created` (Retry-Block entstanden), `lifecycle_action_failed` (Action endgültig gescheitert und
**ohne** `continue_on_error`), `recovery_failed` (Run nach Neustart nicht sicher zuordenbar → `recovery_pending`).

Vollständige `config.yaml` mit allen Schlüsseln (Defaults, außer wo kommentiert):

```yaml
# example: reference
# file: config.yaml
server:
  host: 127.0.0.1
  port: 8787
  allowed_hosts: [orchestrator.example.com]   # Name des authentifizierenden Reverse-Proxys
scheduler:
  polling_interval: 30s
  max_concurrent: 5
workspace:
  base_dir: /var/lib/agent-orchestrator/workspaces   # Default: <data-dir>/workspaces
  cleanup: on_success                                # always | on_success | never
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
  on: [retry_block_created, lifecycle_action_failed, recovery_failed]
  channels:
    - id: ops
      type: webhook
      url_env: OPS_WEBHOOK_URL
      headers_env: { Authorization: OPS_WEBHOOK_AUTH }
      on: [retry_block_created, recovery_failed]
```

### 3.2 sources.yaml

```yaml
# example: reference
# file: sources.yaml
sources:
  project_a:                 # Source-ID (Konfigurations-ID), Teil jedes Item-Schlüssels project_a:<nr>
    type: github
    owner: example           # GitHub-Owner/Organisation
    repository: project-a    # Repository-Name
    identity: maintainer     # Identity für lesende Aufrufe (und Fallback für Schreiben)
  project_b:
    type: github
    owner: example
    repository: project-b
    identity: maintainer
```

| Schlüssel | Typ | Pflicht | Regeln | Bedeutung |
|---|---|---|---|---|
| `sources` | Map Source-ID → Source | nein (Default `{}`) | Schlüssel = Konfigurations-ID | alle Sources |
| `<id>.type` | `github` | ja | einziger Adapter in V1 | |
| `<id>.owner` | String | ja | nicht leer (Format nicht geprüft) | Owner/Organisation |
| `<id>.repository` | String | ja | nicht leer | Repository-Name; `{source.repository}` und Feld `repository` = `owner/repository` in der hier geschriebenen Schreibweise |
| `<id>.identity` | Identity-ID | ja | muss in `identities.yaml` existieren | liest Issues/PRs/Dependencies; Fallback für Schreibaktionen (§6.10) |

Nur `github.com` wird unterstützt (keine Einstellung für GitHub Enterprise). Gelesen werden Issues **und** Pull
Requests des Repositories über `GET /repos/{owner}/{repo}/issues`, standardmäßig **nur offene** (siehe §4.5).

### 3.3 identities.yaml

```yaml
# example: reference
# file: identities.yaml
identities:
  maintainer:
    type: github_app
    app_id: 100001                     # Zahl, keine Zeichenkette
    installation_id: 200001
    private_key_env: GITHUB_MAINTAINER_PRIVATE_KEY
  coder:
    type: github_app
    app_id: 100002
    installation_id: 200002
    private_key_env: GITHUB_CODER_PRIVATE_KEY
```

| Schlüssel | Typ | Pflicht | Regeln | Bedeutung |
|---|---|---|---|---|
| `identities` | Map Identity-ID → Identity | nein (Default `{}`) | Schlüssel = Konfigurations-ID | |
| `<id>.type` | `github_app` | ja | einziger Typ in V1 | |
| `<id>.app_id` | Integer | ja | > 0 | GitHub-App-ID (auch zur Erkennung eigener Kommentare) |
| `<id>.installation_id` | Integer | ja | > 0 | Installation der App im Ziel-Owner |
| `<id>.private_key_env` | Env-Name | ja | `^[A-Za-z_][A-Za-z0-9_]*$` | Name der Umgebungsvariable mit dem privaten Schlüssel |

**Secrets über die Umgebung:** Der Schlüssel steht nie in YAML. Die Variable muss in der Umgebung des
Orchestrator-Prozesses gesetzt sein (unter systemd: `EnvironmentFile`, Default `/etc/default/agent-orchestrator`,
siehe [operations.md](operations.md)). Format des Werts: **RSA**-Private-Key im PEM-Format
(`-----BEGIN RSA PRIVATE KEY-----` bzw. PKCS#8 `-----BEGIN PRIVATE KEY-----`); akzeptiert werden echte
Zeilenumbrüche, wörtliche `\n`-Escapes (typisch in Env-Dateien), CRLF sowie umschließende `"…"`/`'…'`.
Gelesen wird der Schlüssel erst beim **ersten Token-Bedarf** (nicht beim Laden/Validieren); fehlt er oder ist er
ungültig, scheitert der jeweilige Zugriff mit einem nicht wiederholbaren Authentifizierungsfehler (Source-Fehler
in der Planungsdiagnose, `start_error` bei `execute.secrets`, endgültig gescheiterte Action). Aus dem Schlüssel
werden kurzlebige Installation-Tokens erzeugt und im Speicher gecacht; Schlüssel, JWT und Tokens werden in Logs
redigiert. Minimale App-Rechte: Issues lesen/schreiben, Pull Requests schreiben (Labels/Kommentare auf PRs),
Metadata lesen.

### 3.4 workflows/*.yaml

Ein Workflow pro Datei. Vollständige Referenz mit (fast) allen Schlüsseln – ein Source-Workflow:

```yaml
# example: reference
# file: workflows/full-reference.yaml
id: full-reference               # Pflicht; Dateiname sollte <id>.yaml sein
name: Full Reference             # Anzeigename, Default = id
enabled: true                    # Default true; false = keine automatischen Starts
priority: 10                     # Default 0; höher = früher (auch negativ/dezimal erlaubt)
max_concurrent: 2                # Default 1; Limit gleichzeitiger automatischer Runs dieses Workflows
identity: coder                  # Default: Identity der Source; Schreib-Identity für Actions

trigger:
  type: source                   # source | schedule | manual
  source: project_a

filter:                          # deklarativ, nur bei trigger.type: source
  all:
    - { field: labels, operator: contains, value: ready }
    - { field: is_pull_request, operator: equals, value: false }
    - not: { field: labels, operator: contains, value: on-hold }
    - any:
        - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
        - { field: labels, operator: contains, value: ignore-dependencies }

shell_filter:                    # nur Source-Workflows; ein Programm ohne Argumente
  command: scripts/filter.sh     # bekommt ORCH_CHECK_CONTEXT_FILE; Exit 0/1/≥2
  timeout: 30s

item_priority:
  rules:                         # erste zutreffende Regel (true) gewinnt
    - when: { field: labels, operator: contains, value: 'priority:critical' }
      value: 100
    - when: { field: labels, operator: contains, value: 'priority:high' }
      value: 50
  default: 0

conditions:
  workflow:                      # einmal pro Planungsschritt bzw. Cron-Slot
    - type: shell
      command: scripts/check-credits.sh
      args: ['{workflow.id}']
      timeout: 15s
      cache: 60s                 # nur bei workflow-Conditions erlaubt
  item:                          # pro Kandidat, nur Source-Workflows
    - type: shell
      command: scripts/check-item.sh
      args: ['{item.key}', '{item.url}']
      timeout: 30s

execute:
  type: shell
  command: scripts/worker.sh
  args: ['--issue', '{item.number}', '--run', '{run.id}']
  working_directory: '{workspace.base_dir}/{workflow.id}/{run.id}'   # Default
  create_directory: true
  env:
    NODE_ENV: production
    ISSUE_URL: '{item.url}'
  secrets:
    GH_TOKEN: { identity: coder }  # kurzlebiges Installation-Token der Identity
  timeout:
    max_duration: 6h
    idle_timeout: 45m
  cancel_grace: 30s

retry:
  max_technical_failures: 3

on_start:
  - type: source.update
    labels: { add: [in-progress], remove: [ready] }
on_success:
  - id: done-labels
    type: source.update
    labels: { add: [done], remove: [in-progress] }
  - type: source.comment
    message: 'Fertig ({result.result}): {result.message}'
    identity: maintainer
    continue_on_error: true
    retry: { max_attempts: 5, delay: 1m }
  - type: shell
    command: scripts/notify.sh
    args: ['{workflow.id}', '{run.id}', '{result.status}']
    env: { CHANNEL: '#agents' }
    timeout: 1m
on_failure:
  - type: source.update
    labels: { add: [needs-maintainer], remove: [in-progress] }
on_crash:
  - type: source.update
    labels: { add: [ready], remove: [in-progress] }
on_start_error:
  - type: source.update
    labels: { add: [ready], remove: [in-progress] }
on_cancel:
  - type: source.update
    labels: { add: [ready], remove: [in-progress] }
on_timeout:
  - type: source.update
    labels: { add: [ready], remove: [in-progress] }
```

#### 3.4.1 Oberste Ebene

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `id` | Konfigurations-ID | ja | | eindeutig über alle Workflows | stabiler Schlüssel (Runs, Locks, Blocks, API) |
| `name` | String | nein | `id` | nicht leer | Anzeigename, `{workflow.name}` |
| `enabled` | Boolean | nein | `true` | | `false`: keine automatischen Starts (Source/Cron); **manuelle Starts bleiben möglich** |
| `priority` | Zahl | nein | `0` | | Workflow-Priorität, wird vor der Item-Priorität sortiert (§6.2) |
| `max_concurrent` | Integer | nein | `1` | ≥ 1 | Limit gleichzeitig aktiver Runs dieses Workflows für automatische Starts |
| `identity` | Identity-ID | nein | Source-Identity | muss existieren | Schreib-Identity für `source.update`/`source.comment` (§6.10) |
| `trigger` | Objekt | ja | | §3.4.2 | |
| `filter` | Filter-AST | nein | (alles passt) | nur `trigger.type: source` | §4 |
| `shell_filter` | Objekt | nein | | nur `source` | §3.4.4 |
| `item_priority` | Objekt | nein | Priorität 0 | nur `source` | §3.4.5 |
| `conditions` | Objekt | nein | keine | `item` nur bei `source` | §3.4.6 |
| `parameters` | Map | nein | `{}` | §3.4.7 | Parameter für manuelle Starts |
| `execute` | Objekt | ja | | §3.4.8 | Haupt-Worker |
| `retry.max_technical_failures` | Integer | nein | `3` | ≥ 1 | aufeinanderfolgende technische Fehler bis zum Retry-Block (§6.4) |
| `on_start`, `on_success`, `on_failure`, `on_crash`, `on_start_error`, `on_cancel`, `on_timeout` | Liste Actions | nein | `[]` | §3.4.10 | Lifecycle-Hooks |

#### 3.4.2 `trigger`

| `type` | weitere Schlüssel | Bedeutung |
|---|---|---|
| `source` | `source` (Pflicht, Source-ID, muss existieren) | Items der Source werden jeden Planungsschritt gepollt; ein Run ist an genau ein Item gebunden. |
| `schedule` | `cron` (Pflicht, nicht leer), `timezone` (Default `UTC`, IANA-Name wie `Europe/Berlin`) | höchstens ein Run pro Cron-Slot, ohne Item (§6.7). |
| `manual` | – | nur manuelle Starts (UI/API), ohne Item. |

Cron-Syntax: [croner](https://github.com/hexagon/croner) – 5 Felder (`min std tag monat wochentag`) oder 6 mit
führenden Sekunden; Listen, Bereiche, Schritte (`*/15`), Namen (`MON`, `JAN`) und croner-Erweiterungen (`L`, `#`)
werden akzeptiert. Ein Ausdruck, der nie feuert (`0 3 31 2 *`), ist ein Fehler. Jeder Workflow kann – unabhängig
vom Trigger – manuell gestartet werden; Source-Workflows dann mit Item-Referenz.

#### 3.4.3 `filter`

Deklarativer Filter-AST, siehe §4. Nur für Source-Workflows (sonst Fehler). Fehlt er, passt jedes Item der
Source (beachte §4.5: standardmäßig nur offene Issues/PRs).

#### 3.4.4 `shell_filter`

| Schlüssel | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `command` | String | ja | | Programm (§2.4). **Keine `args`** – das Item kommt über `ORCH_CHECK_CONTEXT_FILE`. |
| `timeout` | Dauer | nein | `30s` | danach `unknown` |

Exit `0` = passt, `1` = passt nicht, `≥ 2`/Signal/Timeout/Startfehler = `unknown` (kein Start). Nie gecacht, nie im
Dry-Run ausgeführt, nicht in Views. Umgebung und Kontextdatei: §6.11.

#### 3.4.5 `item_priority`

| Schlüssel | Typ | Default | Bedeutung |
|---|---|---|---|
| `rules` | Liste `{ when: <Filter-AST>, value: <Zahl> }` | `[]` | in Reihenfolge ausgewertet; die erste Regel mit Ergebnis `true` liefert die Priorität; `false`/`unknown` zählen nicht |
| `default` | Zahl | `0` | wenn keine Regel zutrifft |

Ohne `item_priority` ist die Item-Priorität 0. Regeln dürfen teure Felder verwenden (werden dann aufgelöst).

#### 3.4.6 `conditions`

`conditions.workflow[]` und `conditions.item[]` haben dieselbe Form:

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `type` | `shell` | ja | | | |
| `command` | String | ja | | §2.4 | Prüfprogramm |
| `args` | Liste String | nein | `[]` | Templates (§5) | |
| `timeout` | Dauer | nein | `30s` | | danach `unknown` |
| `cache` | Dauer | nein | kein Cache | **nur** `conditions.workflow` | Ergebnis `true`/`false` so lange wiederverwenden; `unknown` wird nie gecacht |

- `workflow`: werden – falls Kandidaten vorhanden – einmal pro Planungsschritt bzw. einmal pro Cron-Slot geprüft,
  in Listenreihenfolge, Abbruch beim ersten Nicht-`true`. Erlaubt bei allen Triggern; bei `manual` wirkungslos
  (manuelle Starts umgehen Conditions).
- `item`: pro Kandidat, nur Source-Workflows, nie gecacht.
- Exit-Semantik wie `shell_filter`. Dry-Runs führen Conditions nie aus.

#### 3.4.7 `parameters`

Map Parametername → Definition. Parameter werden **nur bei manuellen Starts** übergeben (UI-Formular,
`POST /api/v1/workflows/:id/start` mit `{"parameters": {…}}`) und vor dem Start validiert.

| Schlüssel | Typ | Pflicht | Default | Regeln |
|---|---|---|---|---|
| `type` | Enum | ja | | `string`, `number`, `boolean`, `enum` |
| `values` | Liste | bei `enum` ja | | nicht leer, eindeutig; Zahlen/Booleans werden zu Strings |
| `required` | Boolean | nein | `false` | |
| `default` | passend zum Typ | nein | keiner | `string` → String, `number` → endliche Zahl, `boolean` → Boolean, `enum` → einer der `values` (Skalare werden zu Strings, `values: [1, 2]` + `default: 1` ist gültig) |
| `description` | String | nein | | Anzeige im Formular |

Validierung beim Start: unbekannte Parameter → Fehler; fehlender/leerer Wert (`null`, `""`) → `default`, sonst
Fehler, wenn `required`; `number` akzeptiert auch numerische Strings (`"7"`), `boolean` auch `"true"`/`"false"`.

Regeln der Konfigurationsprüfung:

- `required: true` **ohne** `default` in einem `source`- oder `schedule`-Workflow ist ein Fehler (automatische
  Runs könnten ihn nie liefern).
- Im `working_directory` nur Parameter mit `required: true` oder `default`.
- **Achtung (aktuelles Verhalten):** Automatisch gestartete Runs (Source, Cron) erhalten **keine**
  Parameterwerte – auch keine Defaults. `{parameters.x}` wird dort in `args`/`env`/Hooks zu einem leeren String;
  im `working_directory` führt es zu `start_error`. Parameter daher nur in `manual`-Workflows bzw. nur für manuelle
  Starts verwenden.

#### 3.4.8 `execute`

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `type` | `shell` | ja | | einziger Executor in V1 | |
| `command` | String | ja | | §2.4 | Worker-Programm |
| `args` | Liste String | nein | `[]` | Templates, Modus `text` | Argumente |
| `working_directory` | String | nein | `{workspace.base_dir}/{workflow.id}/{run.id}` | Modus `path`; beginnt mit `/` oder `{workspace.base_dir}` | Arbeitsverzeichnis = Workspace (`ORCH_WORKSPACE`) |
| `create_directory` | Boolean | nein | `true` | | Verzeichnis anlegen; bei `false` muss es existieren (sonst `start_error`) |
| `env` | Map Name → String/Zahl/Boolean | nein | `{}` | Templates; kein `ORCH_`-Präfix | zusätzliche Umgebungsvariablen |
| `secrets` | Map Name → `{ identity: <id> }` | nein | `{}` | Identity muss existieren; Name nicht zugleich in `env`; kein `ORCH_` | Installation-Token der Identity als Env-Variable (nur im Speicher) |
| `timeout.max_duration` | Dauer | nein | unbegrenzt | > 0 | Gesamtlaufzeit → `timed_out` |
| `timeout.idle_timeout` | Dauer | nein | unbegrenzt | > 0 | Zeit ohne Ausgabe auf stdout/stderr → `timed_out` (Warnung, wenn > `max_duration`) |
| `cancel_grace` | Dauer | nein | `30s` | | Wartezeit zwischen `SIGTERM` und `SIGKILL` an die Prozessgruppe bei Cancel/Timeout |

Workspace-Regeln: Liegt der gerenderte Pfad strikt unter `workspace.base_dir`, wird er sicher angelegt
(Symlink-geprüft) und gemäß `workspace.cleanup` gelöscht. Liegt er außerhalb, wird er wie konfiguriert angelegt,
aber **nie** automatisch gelöscht. Der Pfad darf nicht `base_dir` selbst sein. Eine Warnung erscheint, wenn ein
`env`-Schlüssel nach Secret aussieht (`…_TOKEN`, `…PASSWORD`, `API_KEY`, …) und einen nicht-leeren Literalwert hat.

#### 3.4.9 `retry`

`retry.max_technical_failures` (Integer ≥ 1, Default 3): Nach so vielen **aufeinanderfolgenden** technischen
Fehlern (`crashed`, `start_error`, `timed_out`) derselben Workflow/Item-Kombination entsteht ein Retry-Block (§6.4).

#### 3.4.10 Hooks

Sieben Hooks, jeder eine Liste von Actions, die **sequentiell** ausgeführt werden:

| Hook | läuft … |
|---|---|
| `on_start` | vor dem Start des Workers (nach Re-Read des Items). Scheitert die Kette, startet der Worker **nicht** (→ `start_error`). |
| `on_success` | nach `completed` + `success` |
| `on_failure` | nach `completed` + `failure` (fachlich, gültige Ergebnisdatei) |
| `on_crash` | nach `crashed` |
| `on_start_error` | nach `start_error` (sofern der Run `starting` erreicht hat) |
| `on_cancel` | nach `cancelled` (sofern der Run `starting` erreicht hat) |
| `on_timeout` | nach `timed_out` |

Genau ein Abschluss-Hook pro Run; Details in §6.8. `source.update`/`source.comment` nur in Source-Workflows.

#### 3.4.11 Actions

Gemeinsame Schlüssel aller Actions:

| Schlüssel | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `type` | Enum | ja | | `source.update`, `source.comment`, `shell` |
| `id` | Konfigurations-ID | nein | `<hook>.<index>` (z. B. `on_success.1`) | stabiler Name im Journal; **workflowweit** eindeutig |
| `continue_on_error` | Boolean | nein | `false` | nach endgültigem Scheitern trotzdem mit der nächsten Action weitermachen |
| `retry.max_attempts` | Integer ≥ 1 | nein | `lifecycle.action_retry.max_attempts` | Versuche insgesamt |
| `retry.delay` | Dauer | nein | `lifecycle.action_retry.delay` | Pause zwischen Versuchen |

`source.update` – Labels des Items ändern (nur Source-Workflows):

| Schlüssel | Typ | Pflicht | Regeln |
|---|---|---|---|
| `labels.add` | Liste String | nein (`[]`) | mindestens eines von `add`/`remove` nicht leer; kein Label in beiden |
| `labels.remove` | Liste String | nein (`[]`) | |

Kein Template. Vor dem Schreiben wird das Item neu gelesen; nur fehlende Labels werden hinzugefügt, nur vorhandene
entfernt (Vergleich ohne Groß-/Kleinschreibung) → idempotent. Schreib-Identity: Workflow → Source (§6.10).

`source.comment` – Kommentar am Issue/PR (nur Source-Workflows; Konversationskommentar, kein Review):

| Schlüssel | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `message` | String | ja | Template (Modus `text`); `result.*` nicht in `on_start` |
| `identity` | Identity-ID | nein | Action-Identity (vor Workflow- und Source-Identity) |

`shell` – beliebiges Programm mit Run-/Ergebnis-Kontext:

| Schlüssel | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `command` | String | ja | | §2.4 |
| `args` | Liste String | nein | `[]` | Templates |
| `env` | Map | nein | `{}` | Templates, kein `ORCH_`-Präfix |
| `timeout` | Dauer | nein | `5m` | Laufzeitlimit pro Versuch |

Erfolg = Exit 0; alles andere (Exit ≠ 0, Signal, Timeout, Startfehler) = gescheiterter, wiederholbarer Versuch.
Keine Secrets. Arbeitsverzeichnis: der Run-Workspace, falls er existiert, sonst ein eigenes Verzeichnis pro Versuch
unter `data-dir/runs/<run>/actions/…`. SIGTERM→SIGKILL-Frist fest 5 s, Log-Limit fest 10 MiB pro Versuch.

### 3.5 views/*.yaml

```yaml
# example: reference
# file: views/reference.yaml
id: reference
title: Offene Arbeit
sources: [project_a, project_b]        # gleicher Adaptertyp, eindeutig
filter:
  all:
    - { field: state, operator: in, value: [open, closed] }   # sonst nur offene Items
    - { field: run.last_status, operator: not_equals, value: null }
fields:
  - { field: repository, label: Repository }
  - { field: number, label: Nr. }              # Link automatisch auf url (Felddefinition)
  - { field: title, label: Titel, link: url }
  - { field: labels, label: Labels }
  - { field: run.last_workflow, label: Letzter Agent }
  - { field: run.last_status, label: Status }
  - { field: run.last_result.message, label: Ergebnis }
  - { field: updated_at, label: Aktualisiert }
sort: { field: updated_at, direction: desc }
```

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `id` | Konfigurations-ID | ja | | eindeutig über alle Views | |
| `title` | String | nein | `id` | nicht leer | |
| `sources` | Liste Source-ID | ja | | ≥ 1, existieren, eindeutig, gleicher Adaptertyp | Datenquellen |
| `filter` | Filter-AST | nein | alles | §4; inkl. `run.last_*` | nur Items mit Ergebnis `true` werden gezeigt |
| `shell_filter` | – | – | | **verboten** (Fehler) | Views führen nie Skripte aus |
| `fields` | Liste | ja | | ≥ 1 | Spalten in Reihenfolge |
| `fields[].field` | String | ja | | nicht leer; nicht gegen den Katalog geprüft | Feldname (§4.7, §4.8) |
| `fields[].label` | String | nein | Feldname | | Spaltenüberschrift |
| `fields[].link` | String | nein | `link` der Felddefinition (`number`, `title` → `url`) | | Feld, dessen Wert (nur absolute `http(s)`-URL) als Link dient |
| `sort.field` | String | ja (wenn `sort`) | | | Sortierfeld |
| `sort.direction` | Enum | nein | `asc` | `asc`, `desc` | leere Werte immer zuletzt; Gleichstand nach Item-Schlüssel (natürlich) |

Laden: beim Öffnen/Refresh aus allen Sources (parallel; eine fehlerhafte Source erscheint als Fehlerzeile, die
anderen liefern trotzdem), Cache 30 s, max. 2 000 Zeilen. Unbekannte/nicht auflösbare Felder bleiben erkennbar leer.

---

## 4. Filter-Sprache

Gemeinsam für `filter` (Workflows), `item_priority.rules[].when` und `filter` (Views).

### 4.1 Grammatik

```text
Knoten     := All | Any | Not | Prädikat
All        := { all: [ Knoten, … ] }          # einziger Schlüssel; [] = true
Any        := { any: [ Knoten, … ] }          # einziger Schlüssel; [] = false
Not        := { not: Knoten }                 # einziger Schlüssel
Prädikat   := { field: <String>, operator: <Operator>, value: <Wert> }   # genau diese drei Schlüssel
Operator   := equals | not_equals | contains | in | greater_than | less_than
Wert       := String | Zahl | Boolean | null            # equals, not_equals, contains
            | [ Skalar, … ] (nicht leer)                # in
            | Zahl | String (ISO-Datum)                  # greater_than, less_than
```

`value` ist immer Pflicht (`null` explizit schreiben). Strukturfehler werden exakt verortet
(`filter.all[1].operator`). `contains` mit Liste und `equals` mit Liste sind syntaktisch erlaubt (siehe 4.2).

### 4.2 Operatoren – exakte Semantik

`a` = Feldwert, `v` = `value`. Ergebnis `true`/`false`/`unknown`; „unknown (Typ)“ heißt: inkompatible Typen.

| Operator | Skalares Feld (string/number/boolean) | Datumsfeld (`date`) | Listenfeld (`string[]`) |
|---|---|---|---|
| `equals` | gleicher JS-Typ und gleicher Wert; anderer Typ → unknown (Typ). `'1'` vs `1`, `'true'` vs `true` → unknown | beide als ISO-8601 geparst, Vergleich als Zeitpunkt; nicht parsebar → unknown | nur mit Listen-`value`: Mengenvergleich (Reihenfolge/Duplikate egal); mit Skalar → unknown (Typ) |
| `not_equals` | Negation von `equals`; unknown bleibt unknown | dito | dito |
| `contains` | nur String-Feld + String-Wert: Teilstring (Groß-/Kleinschreibung beachtet); sonst unknown | wie String (kein Datumsvergleich) | `true`, wenn ein Element `=== v`; leere Liste → `false`; kein Element vom Typ von `v` → unknown |
| `in` | `true`, wenn `equals` mit einem Listenelement `true` ist; sonst `false`, wenn mindestens ein Element typgleich war, sonst unknown | wie skalar, aber Datumsvergleich je Element | `true` bei nichtleerer Schnittmenge; leere Feldliste → `false`; keinerlei Typgleichheit → unknown |
| `greater_than` / `less_than` | Zahl vs Zahl numerisch; String vs String nach Code-Units (nicht locale); sonst unknown | ISO-8601-Zeitpunkte; nicht parsebar → unknown | immer unknown |

`null`-Regeln (ein Feldwert `null` bedeutet „bekannt leer“, z. B. kein Autor):

- `equals null` ist genau dann `true`, wenn der Feldwert `null` ist; `equals x` auf `null`-Feld → `false`;
  `not_equals` entsprechend umgekehrt.
- `contains`/`in` auf `null`-Feld → `false`; `contains null` → unknown.
- `greater_than`/`less_than` mit `null` auf einer Seite → unknown.

Datumswerte: `YYYY-MM-DD` oder `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]`; ohne Offset = UTC. Relative Angaben
(„vor 7 Tagen“) gibt es nicht. Datumssemantik gilt nur für Felder, die der Adapter als `date` deklariert.

Die Operatorlisten im Feldkatalog (§4.7) beschreiben, was sinnvoll ist; der Evaluator erzwingt sie **nicht**
(z. B. ist `labels equals [a, b]` ein Mengenvergleich und funktioniert). Pushdown nutzt sie (§4.5).

### 4.3 Fehlende und unbekannte Felder

- Ein Feld, das der Adapter nicht kennt (Tippfehler!) oder nicht liefern kann, ist **unknown** – nie 0, leer oder
  `false`. Feldnamen werden beim Laden **nicht** geprüft: Ein Tippfehler macht den Filter dauerhaft unknown, der
  Workflow startet nie. Kontrolle: `workflow dry-run` zeigt pro Regel den Wert und den Grund.
- Fehlender API-Zugriff (z. B. Cross-Repo-Blocker ohne Rechte) → unknown („fail closed“).
- `run.last_*` existiert nur in Views; in Workflow-Filtern ist es ein unbekanntes Feld (→ unknown).

### 4.4 Dreiwertige Logik (Kleene)

| A | B | `all [A, B]` | `any [A, B]` | `not A` |
|---|---|---|---|---|
| true | true | true | true | false |
| true | false | false | true | false |
| true | unknown | unknown | true | false |
| false | false | false | false | true |
| false | unknown | false | unknown | true |
| unknown | unknown | unknown | unknown | unknown |

`all`: `false` dominiert, sonst unknown falls ein Kind unknown, sonst `true`. `any`: `true` dominiert, sonst
unknown falls ein Kind unknown, sonst `false`. Ergebnis für den Start: **nur `true` startet**. Bei Views wird nur
`true` angezeigt (unknown wird gezählt), in `item_priority` trifft nur `true`.

### 4.5 Auswertungsreihenfolge, teure Felder, Pushdown

- **Teure Felder** (GitHub: `dependencies.*`) stehen nicht in der Listenabfrage und werden lazy nachgeladen – pro
  Item in **einer** Anfragerunde für alle benötigten teuren Felder, gültig für einen Planungsschritt/View-Aufruf.
- Innerhalb von `all`/`any` werden zuerst Kinder ausgewertet, die nur billige Felder brauchen; sobald das Ergebnis
  feststeht, wird abgebrochen (Rest = `not_evaluated` in der Diagnose). Workflow-Filter laufen zweistufig: erst nur
  billige Felder (teure = unknown); ist das Ergebnis schon `true` oder `false`, ist es endgültig, nur bei unknown
  werden teure Felder später (nach Lock/Block/Conditions) aufgelöst.
- **Pushdown:** Nur Prädikate der obersten Konjunktion (`all`, verschachtelte `all` werden abgeflacht; ein
  einzelnes Prädikat zählt auch) mit billigem Feld und in `pushdown` deklariertem Operator gehen in die API-Abfrage.
  `any`/`not` werden nie gepusht. Der vollständige Filter wird **immer** zusätzlich lokal ausgewertet.
- **GitHub-Abfrage:** `state` = `open` (Default!), `closed` oder `all`, abgeleitet aus `state equals open|closed`
  bzw. `state in [...]` auf oberster Ebene; `labels contains "x"` (ohne Komma) → `labels=x` (alle müssen
  vorhanden sein). **Ohne ein solches `state`-Prädikat werden nur offene Issues/PRs gelesen** – ein Filter
  `any: [{state equals closed}, …]` oder `not: {state equals open}` sieht daher nie geschlossene Items.

### 4.6 Workflow-Filter vs. View-Filter

| | Workflow `filter` | View `filter` |
|---|---|---|
| Ergebnis unknown | kein Start (Diagnose `filter_unknown`) | Zeile ausgeblendet, gezählt in `filterUnknown` |
| Felder | Adapterfelder | Adapterfelder + `run.last_*` |
| Shell | zusätzlich `shell_filter`, Conditions | nie |
| Zeitpunkt | jeder Planungsschritt; vor `on_start` erneut der billige Teil auf dem frisch gelesenen Item | Öffnen/Refresh (Cache 30 s) |

### 4.7 Feldkatalog des GitHub-Adapters

| Feld | Typ | Sinnvolle Operatoren | Pushdown | Teuer | Bedeutung |
|---|---|---|---|---|---|
| `number` | number | equals, not_equals, in, greater_than, less_than | | | Issue-/PR-Nummer (Link → `url`) |
| `title` | string | equals, not_equals, contains, in | | | Titel (Link → `url`) |
| `state` | string | equals, not_equals, contains, in | equals, in | | `open` \| `closed` |
| `labels` | string[] | contains | contains | | Label-Namen (exakte Schreibweise) |
| `assignees` | string[] | contains | | | Logins der Assignees |
| `author` | string | equals, not_equals, contains, in | | | Login des Autors (`null` falls unbekannt) |
| `is_pull_request` | boolean | equals, not_equals | | | `true` für Pull Requests |
| `created_at` | date | equals, not_equals, greater_than, less_than | | | Erstellungszeit |
| `updated_at` | date | equals, not_equals, greater_than, less_than | | | letzte Änderung |
| `url` | string | equals, not_equals, contains, in | | | Web-URL |
| `repository` | string | equals, not_equals, contains, in | | | `owner/repository` (wie in `sources.yaml`) |
| `dependencies.blocked_by_total` | number | equals, not_equals, in, greater_than, less_than | | ja | Anzahl blockierender Issues (native „blocked by“, inkl. Cross-Repo) |
| `dependencies.blocked_by_open` | number | equals, not_equals, in, greater_than, less_than | | ja | davon offen; unknown ohne Zugriff |
| `dependencies.blocked` | boolean | equals, not_equals | | ja | mindestens ein Blocker offen; unknown ohne Zugriff |
| `dependencies.status` | string | equals, not_equals, in | | ja | `ok` = vollständig aufgelöst, sonst `unknown` (dieses Feld selbst ist dann bekannt) |

Abhängigkeiten sind unknown, wenn die API-Zusammenfassung fehlt, ein Blocker einen unerwarteten Status hat oder die
Identity weniger Blocker sieht, als GitHub meldet. „Offen ⇒ kein Start“ gilt nur, wenn der Filter das ausdrücklich
verlangt (z. B. `dependencies.blocked_by_open equals 0`).

### 4.8 Run-Felder für Views

Pro Item der **zuletzt erzeugte** Run (über alle Workflows, globaler Item-Schlüssel). Ohne Run: alle `null`
(bekannt leer, also z. B. `run.last_status equals null` = „noch nie bearbeitet“).

| Feld | Typ | Bedeutung |
|---|---|---|
| `run.last_id` | string | Run-ID |
| `run.last_workflow` | string | Workflow-ID |
| `run.last_status` | string | technischer Status (`running`, `completed`, `crashed`, …) |
| `run.last_result` | string | fachliches Ergebnis `success`/`failure` (sonst `null`) |
| `run.last_result.message` | string | `message` der Ergebnisdatei |
| `run.last_status_message` | string | letzte Status-Meldung des Workers (`@@ORCH_EVENT` `status`) |
| `run.last_started_at` | date | Start (im Filter als String verglichen, nicht als Datum – ISO-Format verwenden) |
| `run.last_finished_at` | date | Ende |

---

## 5. Platzhalter-Referenz

### 5.1 Werte

| Platzhalter | Wert | Fehlt, wenn … |
|---|---|---|
| `{workflow.id}` | Workflow-ID | nie |
| `{workflow.name}` | `name` (Default `id`) | nie |
| `{workspace.base_dir}` | absoluter, normalisierter `workspace.base_dir` | nie |
| `{timestamp}` | aktuelle UTC-Zeit beim Rendern, `YYYYMMDDTHHMMSSZ` | nie |
| `{run.id}` | Run-ID `run-YYYYMMDDTHHMMSSmmmZ-xxxxxxxx` | – |
| `{run.trigger}` | `source` \| `schedule` \| `manual` | – |
| `{run.started_at}` | ISO-8601 mit ms (UTC) | in `on_start` und in Hooks von Runs, deren Worker nie lief |
| `{workspace.path}` | absoluter Workspace-Pfad des Runs | in `on_start`; in Abschluss-Hooks, wenn der Worker nie gespawnt wurde |
| `{source.id}` | Source-ID | Run ohne Item |
| `{source.type}` | `github` | Run ohne Item |
| `{source.repository}` | `owner/repository` | Run ohne Item |
| `{item.id}` | Item-ID (GitHub: Nummer als String) | Run ohne Item |
| `{item.number}` | Nummer (nur bei numerischer Item-ID) | Run ohne Item |
| `{item.key}` | globaler Schlüssel `<source>:<id>` | Run ohne Item |
| `{item.url}` | Web-URL | Run ohne Item |
| `{item.title}` | Titel (frisch gelesen bzw. aus der Planung) | Run ohne Item |
| `{result.status}` | technischer Endstatus (`completed`, `crashed`, `start_error`, `timed_out`, `cancelled`) | – |
| `{result.result}` | `success` \| `failure` | bei technischem Fehler/Cancel |
| `{result.message}` | `message` der Ergebnisdatei | keine/ungültige Ergebnisdatei oder ohne `message` |
| `{parameters.<name>}` | Parameterwert (`true`, `5`, Text) | optionaler Parameter ohne Wert/Default; **alle** Parameter bei automatischen Runs (§3.4.7) |

Fehlender Wert: Modus `text` → leerer String; Modus `path` → Fehler (`start_error`).

### 5.2 Scope – wo welcher Platzhalter erlaubt ist

✓ = erlaubt, – = Konfigurationsfehler, (s) = nur wenn `trigger.type: source`, (leer) = erlaubt, aber dort leer.

| Platzhalter | `execute.working_directory` (path) | `execute.args`, `execute.env` | `on_start` (`message`, `args`, `env`) | übrige Hooks | `conditions.workflow[].args` | `conditions.item[].args` |
|---|---|---|---|---|---|---|
| `workflow.*`, `workspace.base_dir`, `timestamp` | ✓ (`base_dir` nur am Anfang) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `run.id`, `run.trigger` | ✓ | ✓ | ✓ | ✓ | – | – |
| `run.started_at` | ✓ | ✓ | ✓ (leer) | ✓ | – | – |
| `workspace.path` | – | ✓ | ✓ (leer) | ✓ | – | – |
| `source.*`, `item.*` | ✓ (s) | ✓ (s) | ✓ (s) | ✓ (s) | – | ✓ |
| `result.*` | – | – | – | ✓ | – | – |
| `parameters.<name>` | ✓ nur `required` oder mit `default` | ✓ | ✓ | ✓ | – | – |

Nicht als Template ausgewertet (Platzhalter bleiben wörtlich stehen): alle `command`, `source.update.labels`,
`shell_filter`, Filterwerte, `secrets`, alle anderen Felder.

---

## 6. Auswertungsablauf

### 6.1 Planungsschritt (Source-Workflows)

Ein Planungsschritt läuft sofort beim Start, danach jeweils `polling_interval` nach Ende des vorherigen sowie direkt
nach jedem erfolgreichen Reload. Schritte überlappen nie; es gibt keine persistente Kandidaten-Warteschlange.

0. **Gate:** Ist der Controller nicht bereit (Recovery läuft), pausiert oder im Drain/Shutdown, wird der ganze
   Schritt übersprungen.
1. **Pollen** (alle aktiven Source-Workflows parallel; deaktivierte erscheinen nur als `disabled`): Liste der Source
   mit dem pushbaren Filterteil (gleiche Source + gleicher Pushdown = ein API-Aufruf pro Schritt). Fehler einer
   Source betreffen nur deren Workflows (`source_error`).
2. **Deduplizieren** pro `(Source, Item, Workflow)`.
3. **Billiger Filter** (teure Felder = unknown): `false` → verworfen. **Item-Priorität** bestimmen (darf teure
   Felder laden).
4. **Sortieren** aller Kandidaten aller Workflows (§6.2).
5. Pro Kandidat **sequentiell** in dieser Reihenfolge:
   1. freie Kapazität global und für den Workflow? (zuerst, damit volle Limits keine API-Aufrufe kosten)
   2. aktiver Run desselben Workflows für dieses Item (Lock) → `locked`
   3. aktiver Retry-Block → `blocked`
   4. Workflow-Conditions (einmal pro Schritt und Workflow, ggf. aus dem `cache`)
   5. teurer deklarativer Filter (nur wenn der billige Teil unknown war): `false` → `filtered`, unknown → `filter_unknown`
   6. `shell_filter`
   7. Item-Conditions
   8. synchron und atomar: Gate erneut, Workflow noch aktiv **und unverändert** (sonst `workflow_unavailable`),
      Kapazität erneut, Reservierung in SQLite (scheitert bei Lock/Block)
   9. Start an den Run-Controller (§6.5)
6. Ein nicht startfähiger Kandidat blockiert nie die folgenden.

Diagnose je Workflow (letzter Schritt, max. 500 Kandidaten) unter `GET /api/v1/workflows/:id` bzw. im Dry-Run.

### 6.2 Priorität und Tie-Breaker

Totale Ordnung über alle Kandidaten: (1) **Workflow-Priorität** absteigend (effektiv, inkl. Override),
(2) **Item-Priorität** absteigend, (3) Erstellungszeit des Items aufsteigend (fehlend/ungültig zuletzt),
(4) Item-Schlüssel natürlich aufsteigend (`repo:9` < `repo:10`), (5) Workflow-ID aufsteigend. Ein Item mit hoher
Item-Priorität überholt also keinen Workflow mit höherer Workflow-Priorität. Kein Aging.

### 6.3 Limits

- Global `scheduler.max_concurrent` und pro Workflow `max_concurrent` gelten nur für **automatische** Starts
  (Source, Cron). Aktive Runs **aller** Trigger zählen (inkl. manueller und `recovery_pending`).
- Aktiv = `reserved`, `starting`, `running`, `cancelling`, `finalizing`, `recovery_pending` (also auch während
  Abschluss-Hooks laufen).
- Overrides wirken sofort.

### 6.4 Locks und Retry-Blocks

- **Lock:** höchstens ein aktiver Run pro `(Workflow, Item)`. Verschiedene Workflows dürfen dasselbe Item parallel
  bearbeiten. Cron-Runs: Lock pro Slot; manuelle Runs ohne Item: nie Konflikt.
- **Zählung technischer Fehler** pro `(Workflow, Item)` bzw. pro Workflow bei Runs ohne Item:
  `crashed`, `start_error`, `timed_out` erhöhen; `completed`+`success` setzt auf 0 (neue Zählperiode);
  `completed`+`failure` und `cancelled` ändern nichts. Auch manuelle Runs zählen.
- Erreicht der Zähler `retry.max_technical_failures`, entsteht in **derselben Transaktion** wie der Übergang nach
  `finalizing` ein Retry-Block – also bevor `on_crash`/`on_timeout` z. B. das Label zurücksetzen. Der Block
  verhindert automatische Starts, bis er entfernt wird (UI „Remove Block“, `POST /api/v1/blocks/:id/clear`);
  Entfernen startet eine neue Zählperiode. Benachrichtigung `retry_block_created`.

### 6.5 Run-Start

1. Source-Runs: Item frisch lesen. Nicht mehr vorhanden → `cancelled` (ohne Hooks, nicht gezählt). Bei
   automatischen Runs zusätzlich billiger Filterteil auf dem frischen Item: `false` → `cancelled` ohne Hooks
   (unknown startet trotzdem). Source fehlt oder Lesefehler → `start_error` **ohne** Hooks (gezählt).
2. `starting`, `on_start`-Kette. Scheitert sie → Worker startet nicht, `start_error`, `on_start_error`.
3. Workspace-Pfad, `args`/`env` rendern, Secrets holen, Kontextdatei schreiben; Fehler → `start_error`, `on_start_error`.
4. Worker als eigene Prozessgruppe starten → `running`.
5. Ergebnis klassifizieren (§6.8), Abschluss-Hook, Workspace-Cleanup, Endstatus, Lock frei.

### 6.6 Manueller Start

UI oder `POST /api/v1/workflows/:id/start` `{"item"?: "…", "parameters"?: {…}}`:

- **Umgeht:** `enabled`/Overrides, Pause, Filter, `shell_filter`, Conditions, Retry-Blocks, Prioritäten, Limits,
  den Filter-Recheck vor `on_start`.
- **Umgeht nicht:** den Lock pro Workflow+Item (HTTP 409 `lock_conflict`), Drain/Shutdown, laufende Recovery,
  Parametervalidierung.
- Source-Workflow: Item-Referenz Pflicht – `123`, `#123`, `owner/repo#123` oder
  `https://github.com/owner/repo/issues/123` bzw. `/pull/123` (Owner/Repo ohne Groß-/Kleinschreibung, muss zur
  Source passen); das Item muss existieren. Andere Trigger: Item verboten.
- Manuelle Runs zählen zu den Limits automatischer Starts und zum Fehlerzähler.

### 6.7 Cron

- Slots berechnet croner in der `timezone` des Triggers (Default `UTC`), Sekundengenauigkeit.
- **Höchstens ein Run pro Slot**; jeder behandelte Slot bekommt einen `cron_firings`-Eintrag mit Entscheidung.
- Pro Slot: aktiv? Gate offen? Limits frei? kein Workflow-Block? → Workflow-Conditions → nochmals prüfen →
  Eintrag + Reservierung in einer Transaktion. Sonst `skipped_disabled|paused|not_ready|draining|limit|blocked|
  condition|condition_unknown`.
- **Verpasste Slots werden nie nachgeholt.** Toleranz 60 s: Ein Slot, der höchstens so spät behandelt wird, läuft
  normal; ältere werden `skipped_missed`. Nach Neustart: ab dem letzten persistierten Slot; nur der jüngste (falls
  in der Toleranz) kann noch laufen. Neuer Workflow/geänderter Ausdruck: ab „jetzt“.
- **DST:** Jede Wanduhrzeit höchstens einmal (beim ersten Auftreten); tägliche Zeiten in der Frühjahrslücke laufen
  einmal, um die Lückenlänge verschoben; stündliche Slots in der Lücke entfallen. Exakte Intervalle → `UTC`.
- Details und Tabellen: [cron-semantics.md](cron-semantics.md).

### 6.8 Outcome → Status → Hook

| Situation | Technischer Status | Fachlich | Hook | Technischer Fehler (zählt)? |
|---|---|---|---|---|
| Item vor dem Start verschwunden / passt nicht mehr | `cancelled` | – | keiner | nein |
| Cancel vor `starting` | `cancelled` | – | keiner | nein |
| Source nicht verfügbar / Item-Re-Read scheitert | `start_error` | – | **keiner** | ja |
| `on_start`-Kette gestoppt | `start_error` | – | `on_start_error` | ja |
| Cancel während `on_start` oder vor Spawn | `cancelled` | – | `on_cancel` | nein |
| Vorbereitung scheitert (Template, Workspace, Secret-Token) | `start_error` | – | `on_start_error` | ja |
| Spawn unmöglich (ENOENT, keine Exec-Rechte) | `start_error` | – | `on_start_error` | ja |
| kontrollierter Abbruch (UI/API/Cancel-All) | `cancelled` | – | `on_cancel` | nein |
| `max_duration` oder `idle_timeout` überschritten | `timed_out` | – | `on_timeout` | ja |
| durch Signal beendet (nicht Cancel/Timeout) | `crashed` | – | `on_crash` | ja |
| Exit ≠ 0 (Ergebnisdatei wird ignoriert) | `crashed` | – | `on_crash` | ja |
| Exit 0 + ungültige/zu große Ergebnisdatei | `crashed` | – | `on_crash` | ja |
| Exit 0 + keine Ergebnisdatei | `completed` | `success` | `on_success` | nein (setzt Zähler zurück) |
| Exit 0 + `"result": "success"` | `completed` | `success` | `on_success` | nein (setzt Zähler zurück) |
| Exit 0 + `"result": "failure"` | `completed` | `failure` | `on_failure` | nein (Zähler unverändert) |
| Controller-Neustart, Worker nachweislich weg | `crashed` (bzw. `cancelled`, wenn Cancel lief) | – | `on_crash` / `on_cancel` | `crashed`: ja |
| Controller-Neustart, Prozess nicht sicher zuordenbar | `recovery_pending` (hält Lock) | – | – | – |

Eine fachliche `failure` gibt es nur über eine gültige Ergebnisdatei; ein Exit-Code allein ist nie „failure“.
Ergebnisdatei-Format: [worker-protocol.md](worker-protocol.md).

### 6.9 Action-Ketten

- Actions eines Hooks laufen **sequentiell** in Listenreihenfolge; jeder Zustand wird vor dem Weiterarbeiten
  persistiert (Journal `pending → running → succeeded|failed|skipped`, jeder Versuch einzeln).
- **Retry:** bis `max_attempts` Versuche, Pause `delay` (mindestens ein `Retry-After`). Sofort endgültig (ohne
  weitere Versuche) bei nicht wiederholbaren Fehlern: Template-/Konfigurationsfehler, Authentifizierung, Item
  nicht gefunden, ungültige Anfrage. Wiederholbar: transiente API-Fehler, Rate-Limits, jeder `shell`-Fehlschlag.
- **Stopp:** Scheitert eine Action endgültig ohne `continue_on_error`, bleibt die Kette dort stehen; folgende
  Actions bleiben `pending`, der Run zeigt „Lifecycle failed“, Benachrichtigung `lifecycle_action_failed`. Mit
  `continue_on_error: true` geht es weiter (keine Benachrichtigung).
- Der Run-Status hängt nicht vom Hook-Ergebnis ab – Ausnahme `on_start` (→ `start_error`).
- **Manuell:** `POST /api/v1/actions/:id/retry` (frische Versuchsrunde, danach läuft die Kette weiter; nicht für
  `on_start`, wenn der Run nicht mehr `starting` ist) und `POST /api/v1/actions/:id/skip` (failed/pending →
  `skipped`, Kette läuft weiter). Der Haupt-Worker wird nie neu gestartet; erfolgreiche Actions laufen nie erneut.
- **Idempotenz:** `source.update` liest vor dem Schreiben neu und ändert nur, was fehlt. `source.comment` hängt als
  letzte Zeile `<!-- orch:<run-id>:<journal-action-id> -->` an; vor jeder Wiederholung (und nach Neustart) wird ein
  Kommentar mit diesem Marker gesucht, der von der eigenen App stammt → kein Duplikat. `<!--` im gerenderten Text
  wird zu `&lt;!--`.
- **Neustart:** unterbrochene `source.*`-Actions werden fortgesetzt; eine unterbrochene `shell`-Action wird
  `failed` und nie automatisch wiederholt (manueller Retry). Eine unterbrochene `on_start`-Kette wird verworfen.

### 6.10 Identitäten je Zugriff

| Zugriff | Identity |
|---|---|
| Pollen, Item lesen, Dependencies auflösen, Item-Re-Read vor `on_start` | `sources.<id>.identity` |
| `source.update` (inkl. Re-Read vor dem Schreiben) | Workflow-`identity` → Source-`identity` |
| `source.comment` (inkl. Marker-Suche) | Action-`identity` → Workflow-`identity` → Source-`identity` |
| `execute.secrets.<NAME>` | die angegebene Identity (Installation-Token, ca. 1 h gültig, beim Start geholt) |
| `shell`-Actions, Conditions, `shell_filter` | keine (keine Secrets) |

### 6.11 Umgebung von Worker, Actions und Prüfskripten

| | Haupt-Worker | `shell`-Action | Conditions / `shell_filter` |
|---|---|---|---|
| Basis | `PATH`, `HOME`, `LANG`, `TZ`, `USER`, `LOGNAME`, `TMPDIR` aus der Controller-Umgebung (PATH-Fallback `/usr/local/bin:/usr/bin:/bin`) | wie Worker | dieselben Variablen (ohne PATH-Fallback) |
| Konfiguriert | `execute.env`, dann `execute.secrets` | Action-`env` | – |
| Orchestrator | `ORCH_RUN_ID`, `ORCH_WORKFLOW_ID`, `ORCH_CONTEXT_FILE`, `ORCH_RESULT_FILE`, `ORCH_WORKSPACE`; bei Item zusätzlich `ORCH_SOURCE_TYPE`, `ORCH_SOURCE_ID`, `ORCH_SOURCE_ITEM_ID`, `ORCH_SOURCE_URL` | dieselben (`ORCH_WORKSPACE` = Arbeitsverzeichnis der Action; Kontext `kind: lifecycle_action` mit Hook, Action, `result`) | `ORCH_CHECK_CONTEXT_FILE` (JSON: `kind`, `workflow.id`, bei Item `source{id,type,item_id,item_key,url,item_type,created_at,attributes}`) |
| Arbeitsverzeichnis | Workspace | Workspace, falls vorhanden, sonst Versuchsverzeichnis | temporäres Verzeichnis |

Vorrang (spätere gewinnen): Basis < `env` < `secrets` < `ORCH_*`. Die übrige Controller-Umgebung wird **nie**
vererbt. Details zu Kontextdatei, Ergebnisdatei, Events und Cancel: [worker-protocol.md](worker-protocol.md).

### 6.12 Workspace-Cleanup

Nach dem Abschluss-Hook: `always` = immer, `on_success` = nur `completed`+`success`, `never` = nie. Gelöscht wird nur
ein Workspace strikt unter `workspace.base_dir` (auch nach Auflösen von Symlinks; ein Workspace, der selbst ein
Symlink ist, wird nie gelöscht). Später entfernt die Retention auch verbliebene Workspaces gelöschter Runs.

### 6.13 Dry-Run

`agent-orchestrator workflow dry-run <id>` (gegen die laufende Instanz, sonst mit `--config-dir` lokal) bzw.
`POST /api/v1/workflows/:id/dry-run`: Source-Abfrage, Filter-Trace pro Regel (inkl. Dependencies), Prioritäten,
Locks/Blocks, Kapazität (in Prioritätsreihenfolge simuliert). Reserviert nichts, startet keine Worker oder Actions
und führt **nie** `shell_filter`/Conditions aus (`not_evaluated`, Entscheidung `pending_checks`). Cron-Workflows:
nächste 5 Slots und Prognose; Manual-Workflows: nur Hinweise.

---

## 7. Vollständige Beispiele

### 7.1 Minimal-Setup (ohne GitHub)

Ein manueller Workflow, keine Sources/Identities nötig.

```yaml
# example: minimal
# file: config.yaml
# Alles optional – nur zur Verdeutlichung zwei Werte.
server:
  port: 8787
scheduler:
  max_concurrent: 2
```

```yaml
# example: minimal
# file: workflows/hello.yaml
id: hello
name: Hello World
trigger: { type: manual }
parameters:
  name: { type: string, default: world, description: Wen grüßen? }
execute:
  type: shell
  command: scripts/hello.sh          # relativ zum config-dir
  args: ['{parameters.name}']
  timeout: { max_duration: 10m }
```

### 7.2 Coder-/Reviewer-Paar über Labels

Label-Fluss auf dem Issue: `ready-for-coding` → `coding` → `ready-for-review` → `reviewing` → `ready-to-merge`
(bzw. zurück zu `ready-for-coding` oder `needs-maintainer`). Der Reviewer hat die höhere Workflow-Priorität, damit
fertige Arbeit zuerst geprüft wird.

```yaml
# example: github
# file: config.yaml
scheduler:
  polling_interval: 60s
  max_concurrent: 4
workspace:
  cleanup: on_success
```

```yaml
# example: github
# file: identities.yaml
identities:
  maintainer: { type: github_app, app_id: 100001, installation_id: 200001, private_key_env: GITHUB_MAINTAINER_PRIVATE_KEY }
  coder:      { type: github_app, app_id: 100002, installation_id: 200002, private_key_env: GITHUB_CODER_PRIVATE_KEY }
  reviewer:   { type: github_app, app_id: 100003, installation_id: 200003, private_key_env: GITHUB_REVIEWER_PRIVATE_KEY }
```

```yaml
# example: github
# file: sources.yaml
sources:
  project_a: { type: github, owner: example, repository: project-a, identity: maintainer }
  project_b: { type: github, owner: example, repository: project-b, identity: maintainer }
```

```yaml
# example: github
# file: workflows/coder.yaml
id: coder
name: Coder – Project A
priority: 50
max_concurrent: 2
identity: coder
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }   # Pushdown: labels=ready-for-coding
    - { field: is_pull_request, operator: equals, value: false }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }   # teuer, lazy
item_priority:
  rules:
    - when: { field: labels, operator: contains, value: 'priority:high' }
      value: 50
conditions:
  workflow:
    - { type: shell, command: scripts/check-credits.sh, timeout: 15s, cache: 60s }
execute:
  type: shell
  command: scripts/coder.sh
  args: ['{item.url}']
  secrets:
    GH_TOKEN: { identity: coder }
  timeout: { max_duration: 6h, idle_timeout: 45m }
retry: { max_technical_failures: 3 }
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
  - type: source.comment
    message: 'Coder fertig (Run {run.id}): {result.message}'
    continue_on_error: true
on_failure:
  - type: source.update
    labels: { add: [needs-maintainer], remove: [coding] }
  - type: source.comment
    message: 'Needs maintainer: {result.message}'
on_crash:       [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
on_start_error: [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
on_timeout:     [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
on_cancel:      [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
```

```yaml
# example: github
# file: workflows/reviewer.yaml
id: reviewer
name: Reviewer – Project A
priority: 60
identity: reviewer
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-review }
    - { field: is_pull_request, operator: equals, value: false }
execute:
  type: shell
  command: scripts/reviewer.sh
  args: ['{item.url}']
  secrets:
    GH_TOKEN: { identity: reviewer }
  timeout: { max_duration: 2h }
on_start:
  - type: source.update
    labels: { add: [reviewing], remove: [ready-for-review] }
on_success:                                  # Review bestanden
  - type: source.update
    labels: { add: [ready-to-merge], remove: [reviewing] }
on_failure:                                  # Änderungen nötig → zurück an den Coder
  - type: source.update
    labels: { add: [ready-for-coding], remove: [reviewing] }
  - type: source.comment
    message: 'Review: {result.message}'
on_crash:       [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
on_start_error: [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
on_timeout:     [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
on_cancel:      [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
```

### 7.3 View über zwei Repositories

```yaml
# example: github
# file: views/needs-maintainer.yaml
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

### 7.4 Cron-Workflow

```yaml
# example: cron
# extends: minimal
# file: workflows/nightly-maintenance.yaml
id: nightly-maintenance
name: Nightly Maintenance
priority: 20
trigger:
  type: schedule
  cron: '0 3 * * *'            # täglich 03:00 Ortszeit
  timezone: Europe/Berlin
conditions:
  workflow:
    - type: shell
      command: scripts/maintenance-window.sh
      args: ['{timestamp}']
execute:
  type: shell
  command: scripts/maintenance.sh
  args: ['--run', '{run.id}', '--trigger', '{run.trigger}']
  timeout: { max_duration: 1h }
retry: { max_technical_failures: 2 }   # Block im Workflow-Scope (kein Item)
on_failure:
  - type: shell
    command: scripts/notify.sh
    args: ['{workflow.name}: {result.message}']
on_crash:
  - type: shell
    command: scripts/notify.sh
    args: ['{workflow.name} abgestürzt ({result.status}), Run {run.id}']
```

### 7.5 Manual-Workflow mit Parametern

```yaml
# example: manual-params
# extends: minimal
# file: workflows/deploy.yaml
id: deploy
name: Deploy
trigger: { type: manual }
parameters:
  environment:
    type: enum
    values: [staging, production]
    required: true
    description: Zielumgebung
  version:
    type: string
    required: true
  dry_run:
    type: boolean
    default: false
  replicas:
    type: number
    default: 2
execute:
  type: shell
  command: scripts/deploy.sh
  # environment ist Pflicht → im Pfad erlaubt (wird zu einem sicheren Segment)
  working_directory: '{workspace.base_dir}/deploy/{parameters.environment}/{run.id}'
  args: ['--version={parameters.version}', '--dry-run={parameters.dry_run}', '--replicas={parameters.replicas}']
  env:
    DEPLOY_ENV: '{parameters.environment}'
  timeout: { max_duration: 30m }
on_success:
  - type: shell
    command: scripts/notify.sh
    args: ['Deploy {parameters.version} nach {parameters.environment}: {result.message}']
```

Start: `curl -X POST -H 'X-Orchestrator-Request: 1' -H 'Content-Type: application/json'
-d '{"parameters":{"environment":"staging","version":"1.4.2"}}' http://127.0.0.1:8787/api/v1/workflows/deploy/start`.

### 7.6 Notifications per Webhook

```yaml
# example: notifications
# extends: minimal
# file: config.yaml
notifications:
  on: [retry_block_created, lifecycle_action_failed, recovery_failed]
  channels:
    - id: slack                        # Slack-Incoming-Webhook; URL enthält ein Token → aus der Umgebung
      type: webhook
      url_env: SLACK_WEBHOOK_URL
    - id: ops
      type: webhook
      url: https://ops.example.com/hooks/orchestrator
      headers_env:
        Authorization: OPS_WEBHOOK_AUTH   # z. B. "Bearer …" in der Env-Datei
      on: [recovery_failed]               # nur dieses Ereignis
```

Umgebung (z. B. `/etc/default/agent-orchestrator`): `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…`,
`OPS_WEBHOOK_AUTH=Bearer …`. Danach **Neustart** (Env-Änderung) bzw. `config reload` (nur YAML-Änderung).

---

## 8. Häufige Validierungsfehler

Format der Ausgabe von `config validate`: `datei:zeile: pfad: meldung`. Alle folgenden Blöcke sind bewusst
ungültig und werden vom Test gegen die angegebene Meldung geprüft.

**Tippfehler im Schlüssel** – alle Objekte sind strikt.

```yaml
# example: err-unknown-key
# extends: minimal
# invalid
# expect: config.yaml: scheduler: Unknown key(s): "max_concurent"
# file: config.yaml
scheduler:
  max_concurent: 2
```

Lösung: Schreibweise laut §3 korrigieren.

**Falsches Dauerformat** – keine zusammengesetzten Dauern, keine Leerzeichen.

```yaml
# example: err-duration
# extends: minimal
# invalid
# expect: workflows/hello.yaml: execute.timeout.max_duration: Invalid duration "1h30m" (expected e.g. 100ms, 30s, 45m, 6h, 30d)
# file: workflows/hello.yaml
id: hello
trigger: { type: manual }
execute:
  type: shell
  command: scripts/hello.sh
  timeout: { max_duration: 1h30m }
```

Lösung: `90m`. Eine unquotierte Zahl (`max_duration: 30`) meldet `Expected a duration such as 30s, 45m, 6h`.

**Unbekannte Referenz** (Source, Identity) – auch Folgefehler einer kaputten `identities.yaml`.

```yaml
# example: err-unknown-source
# extends: github
# invalid
# expect: workflows/coder.yaml: trigger.source: Unknown source "project_x"
# expect: workflows/coder.yaml: identity: Unknown identity "codr"
# file: workflows/coder.yaml
id: coder
identity: codr
trigger: { type: source, source: project_x }
execute: { type: shell, command: scripts/coder.sh }
```

**Unbekannter oder unpassender Platzhalter** – `{result.*}` gibt es in `on_start` noch nicht.

```yaml
# example: err-placeholder
# extends: github
# invalid
# expect: workflows/coder.yaml: on_start[0].message: Placeholder "{result.message}" is not available in this context
# expect: workflows/coder.yaml: on_start[0].message: Unknown placeholder "{item.body}"
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
execute: { type: shell, command: scripts/coder.sh }
on_start:
  - type: source.comment
    message: 'Start: {result.message} – {item.body}'
```

Lösung: nur Platzhalter aus §5 im erlaubten Scope; literale Klammern als `{{`/`}}`.

**Source-Elemente in Workflows ohne Source-Trigger**

```yaml
# example: err-source-only
# extends: minimal
# invalid
# expect: workflows/nightly.yaml: filter: "filter" is only allowed for workflows with a source trigger (trigger is "schedule")
# expect: workflows/nightly.yaml: on_success[0].type: "source.comment" needs a source item; the workflow has no source trigger
# file: workflows/nightly.yaml
id: nightly
trigger: { type: schedule, cron: '0 3 * * *' }
filter: { field: state, operator: equals, value: open }
execute: { type: shell, command: scripts/nightly.sh }
on_success:
  - type: source.comment
    message: done
```

Lösung: `filter`, `shell_filter`, `item_priority`, `conditions.item`, `source.update`, `source.comment` nur mit
`trigger.type: source`; für Cron/Manual `shell`-Actions verwenden.

**Filter-Struktur** – `in` braucht eine Liste, `value` ist Pflicht.

```yaml
# example: err-filter
# extends: github
# invalid
# expect: workflows/coder.yaml: filter.all[0].value: Operator "in" requires a non-empty list of strings, numbers or booleans
# expect: workflows/coder.yaml: filter.all[1].operator: Predicate requires "operator", one of: equals, not_equals, contains, in, greater_than, less_than
# expect: workflows/coder.yaml: filter.all[2].value: Predicate requires a "value" (use null explicitly if intended)
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: state, operator: in, value: open }
    - { field: labels, operator: has, value: ready }
    - { field: author, operator: equals }
execute: { type: shell, command: scripts/coder.sh }
```

**Relatives `working_directory` / Wurzel nicht am Anfang**

```yaml
# example: err-working-directory
# extends: minimal
# invalid
# expect: workflows/hello.yaml: execute.working_directory: Must be absolute: start with "/" or "{workspace.base_dir}"
# file: workflows/hello.yaml
id: hello
trigger: { type: manual }
execute:
  type: shell
  command: scripts/hello.sh
  working_directory: 'work/{run.id}'
```

Weitere Meldungen: `Placeholder "{workspace.base_dir}" must be followed by "/" or the end of the path template`
bzw. `… is a directory root and must start the path template`.

**Parameter im Pfad bzw. in automatischen Workflows**

```yaml
# example: err-parameters
# extends: minimal
# invalid
# expect: workflows/hello.yaml: execute.working_directory: Parameter "name" is optional without default and cannot be used in a path
# expect: workflows/hello.yaml: execute.args[0]: Parameter "nme" is not declared
# file: workflows/hello.yaml
id: hello
trigger: { type: manual }
parameters:
  name: { type: string }
execute:
  type: shell
  command: scripts/hello.sh
  working_directory: '{workspace.base_dir}/{parameters.name}'
  args: ['{parameters.nme}']
```

```yaml
# example: err-required-parameter
# extends: minimal
# invalid
# expect: workflows/nightly.yaml: parameters.target.required: Required parameter without default in an automatically triggered workflow: automatic runs could never supply it
# file: workflows/nightly.yaml
id: nightly
trigger: { type: schedule, cron: '0 3 * * *' }
parameters:
  target: { type: string, required: true }
execute: { type: shell, command: scripts/nightly.sh }
```

**Reservierte oder doppelte Env-Namen**

```yaml
# example: err-env
# extends: github
# invalid
# expect: workflows/coder.yaml: execute.env.ORCH_MODE: Environment variables with prefix "ORCH_" are reserved
# expect: workflows/coder.yaml: execute.secrets.GH_TOKEN: "GH_TOKEN" is defined both in "env" and "secrets"
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
execute:
  type: shell
  command: scripts/coder.sh
  env: { ORCH_MODE: fast, GH_TOKEN: '' }
  secrets: { GH_TOKEN: { identity: coder } }
```

**Cron und Zeitzone**

```yaml
# example: err-cron
# extends: minimal
# invalid
# expect: workflows/nightly.yaml: trigger.cron: Invalid cron expression "0 25 * * *"
# expect: workflows/nightly.yaml: trigger.timezone: Invalid time zone "Europe/Berln"
# file: workflows/nightly.yaml
id: nightly
trigger: { type: schedule, cron: '0 25 * * *', timezone: Europe/Berln }
execute: { type: shell, command: scripts/nightly.sh }
```

Ein Ausdruck, der nie feuert, meldet `Cron expression "…" never fires`.

**Webhook-Kanal**

```yaml
# example: err-webhook
# extends: minimal
# invalid
# expect: config.yaml: notifications.channels[0]: Webhook channel needs exactly one of "url" or "url_env"
# expect: config.yaml: notifications.channels[1].url: Webhook "url" must be an absolute http(s) URL
# file: config.yaml
notifications:
  channels:
    - { type: webhook, url: 'https://hooks.example.com/x', url_env: HOOK_URL }
    - { type: webhook, url: 'hooks.example.com/x' }
```

**Labels und Action-IDs**

```yaml
# example: err-actions
# extends: github
# invalid
# expect: workflows/coder.yaml: on_start[0].labels: Label "coding" is both added and removed
# expect: workflows/coder.yaml: on_success[0].labels: "source.update" must add or remove at least one label
# expect: workflows/coder.yaml: on_success[1].id: Duplicate action ID "notify" (also used at on_start[1])
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
execute: { type: shell, command: scripts/coder.sh }
on_start:
  - type: source.update
    labels: { add: [coding], remove: [coding] }
  - { id: notify, type: shell, command: scripts/notify.sh }
on_success:
  - type: source.update
    labels: { add: [] }
  - { id: notify, type: shell, command: scripts/notify.sh }
```

**Views ohne Shell, gleiche Quellen eindeutig**

```yaml
# example: err-view
# extends: github
# invalid
# expect: views/needs-maintainer.yaml: shell_filter: Views do not support "shell_filter"; views never run shell scripts (Spec §17)
# expect: views/needs-maintainer.yaml: sources: Sources of a view must be unique
# file: views/needs-maintainer.yaml
id: needs-maintainer
sources: [project_a, project_a]
shell_filter: { command: scripts/filter.sh }
fields: [ { field: title } ]
```

**Ungültige ID und YAML-Typen**

```yaml
# example: err-types
# extends: minimal
# invalid
# expect: workflows/hello.yaml: id: Invalid ID (allowed: letters, digits, "_" and "-", must start with a letter or digit, max. 64)
# expect: workflows/hello.yaml: enabled: Invalid input: expected boolean, received string
# expect: workflows/hello.yaml: trigger.type: Invalid discriminator value. Expected 'source' | 'schedule' | 'manual'
# file: workflows/hello.yaml
id: hello world
enabled: yes                 # YAML 1.2: String, kein Boolean
trigger: { type: cron }
execute: { type: shell, command: scripts/hello.sh }
```

**Warnungen** (blockieren nicht):

```yaml
# example: warn-common
# extends: minimal
# expect-warning: workflows/hello.yaml: id: Workflow ID "greeter" differs from file name "hello.yaml"
# expect-warning: workflows/hello.yaml: execute.env.API_TOKEN: Looks like a secret stored literally in YAML
# expect-warning: workflows/hello.yaml: execute.timeout.idle_timeout: "idle_timeout" is longer than "max_duration"
# file: workflows/hello.yaml
id: greeter
trigger: { type: manual }
execute:
  type: shell
  command: scripts/hello.sh
  env: { API_TOKEN: abc123 }
  timeout: { max_duration: 1m, idle_timeout: 5m }
```

Weitere häufige Meldungen (ohne eigenes Beispiel):

| Meldung | Ursache / Lösung |
|---|---|
| `YAML syntax error: Map keys must be unique` | Schlüssel doppelt im selben Mapping |
| `YAML syntax error: …` | Einrückung, nicht geschlossene `{`/`[`, Tabs |
| `Top level must be a mapping` | Datei beginnt mit einer Liste (`- …`) |
| `Invalid input: expected object, received undefined` (Pfad `execute`/`trigger`) | Pflichtblock fehlt |
| `Invalid discriminator value. Expected 'github'` | falscher `type` in Source/Identity/Kanal |
| `Duplicate workflow ID "x" (already defined in workflows/a.yaml)` | zwei Dateien mit gleicher `id` |
| `Default does not match parameter type: expected …` | `default` passt nicht zu `type`/`values` |
| `"cache" is only supported for workflow conditions` | `cache` unter `conditions.item` |
| `Duration must be greater than 0` | `max_duration`/`idle_timeout: 0s` |
| `Invalid host name (expected "name" or "name:port")` | Schema/Pfad in `allowed_hosts` (`https://…`) |
| `Invalid environment variable name` | z. B. `private_key_env: my-key` |
| `Expected a size such as 100MB` | Größe ohne Einheit |
| `config.yaml not found, using defaults` (Warnung) | `config.yaml` fehlt |

Laufzeitfehler, die `config validate` **nicht** findet: fehlende Umgebungsvariablen (Keys, Webhooks),
nicht existierende/nicht ausführbare Skripte, Tippfehler in Filter-Feldnamen (→ dauerhaft unknown), fehlende
App-Rechte. Dafür: `workflow dry-run` und die Run-Details.

---

## 9. Checkliste „neuen Workflow anlegen“

1. **Trigger wählen:** `source` (Items), `schedule` (Cron) oder `manual`.
2. **Voraussetzungen:** Source in `sources.yaml`, Identities in `identities.yaml`, Private Keys als
   Umgebungsvariablen des Dienstes (Env-Datei, danach Neustart), App-Rechte prüfen.
3. **Datei** `workflows/<id>.yaml` anlegen (Dateiname = `id`), am besten mit `enabled: false` beginnen.
4. **Filter** nur mit Feldern aus §4.7; Labels exakt schreiben; für geschlossene Items ein `state`-Prädikat auf
   oberster Ebene; teure `dependencies.*` nur wenn nötig.
5. **execute:** Skript ausführbar machen (`chmod +x`), Pfad relativ zum config-dir oder absolut; Argumente als
   Liste; Timeouts setzen; Secrets nur über `secrets`.
6. **Hooks:** Label-Übergänge für jeden Ausgang (`on_start`, `on_success`, `on_failure`, `on_crash`,
   `on_start_error`, `on_timeout`, `on_cancel`) so wählen, dass das Item nicht hängen bleibt und nicht sofort wieder
   matcht (Retry-Blocks fangen Endlosschleifen technischer Fehler ab).
7. **Validieren:** `agent-orchestrator config validate --config-dir <dir>` → Exit 0, Warnungen lesen.
8. **Trockenlauf:** `agent-orchestrator workflow dry-run <id> --config-dir <dir>` – Kandidaten, Filter-Trace
   (kein `unknown` durch Tippfehler?), Prioritäten, Locks/Blocks, Kapazität.
9. **Aktivieren:** `enabled: true` setzen und `agent-orchestrator config reload --config-dir <dir>` (bei Fehlern
   bleibt die alte Konfiguration aktiv). Alternativ zuerst ein manueller Start über die UI.
10. **Beobachten:** erster Run in der UI (Status, Logs, Lifecycle-Journal), ggf. `max_concurrent` per Override
    anpassen und danach in YAML übernehmen (Overrides gehen beim Neustart verloren).
