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
   [identities.yaml](#33-identitiesyaml), [workflows/*.yaml](#34-workflowsyaml), [views/*.yaml](#35-viewsyaml),
   [filters/*.yaml](#36-filtersyaml), [Grenzen](#37-bekannte-grenzen-v1)
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
  identities.yaml      GitHub-Identitäten (Apps, Tokens)          optional (fehlt → keine Identities)
  workflows/*.yaml     ein Workflow pro Datei                     optional (fehlt → keine Workflows)
  views/*.yaml         eine View pro Datei                        optional
  filters/*.yaml       ein benannter Filter pro Datei             optional (fehlt → keine benannten Filter)
  scripts/…            frei; Skripte werden über Pfade referenziert (siehe §2.4)
```

`adispatch init --config-dir D --data-dir D` legt eine kommentierte, gültige Beispielkonfiguration an
(`src/cli/init-templates.ts`): `config.yaml`, `sources.yaml`, `identities.yaml`, `workflows/hello.yaml`
(manuell, aktiv), `workflows/coder.yaml` und `workflows/nightly-maintenance.yaml` (beide `enabled: false`),
`views/needs-maintainer.yaml`, den benannten Filter `filters/needs-maintainer.yaml` (von `coder.yaml` und der View
verwendet) und Beispielskripte unter `scripts/`. `init` überschreibt nie bestehende Dateien.

Das `data-dir` (SQLite, Logs, `runs/<id>/context.json|result.json`, Default-Workspaces) ist **keine**
Konfiguration und wird hier nur erwähnt, wo es Defaults bestimmt.

### 1.2 Dateinamensregeln

| Regel | Verhalten |
|---|---|
| Top-Level-Dateien | exakt `config.yaml`, `sources.yaml`, `identities.yaml`. `.yml`-Varianten werden **nicht** gelesen. |
| `workflows/`, `views/`, `filters/` | alle Einträge, deren Name auf `.yaml` **oder** `.yml` endet und nicht mit `.` beginnt, alphabetisch sortiert. |
| Unterordner | werden **nicht** rekursiv gelesen (`workflows/alt/x.yaml` wird ignoriert). Ein *Verzeichnis* namens `x.yaml` ist ein Fehler („Not a regular file“). |
| Versteckte Dateien | `.foo.yaml` wird ignoriert (z. B. Editor-Backups). Andere Endungen (`x.yaml.bak`, `x.json`) ebenfalls. |
| Dateiname ↔ `id` | Maßgeblich ist das Feld `id`. Weicht der Dateiname (ohne Endung) davon ab, gibt es nur eine **Warnung** (nur für Workflows und benannte Filter). Doppelte `id` über zwei Dateien ist ein **Fehler** in der alphabetisch späteren Datei. |
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
   Benannte Filter (`filters/`) werden zuerst geladen und in Workflows/Views eingesetzt (§3.6).
4. Semantische Prüfung über alle Dateien (`src/config/validate.ts`): Referenzen, eindeutige IDs, Platzhalter je
   Kontext, Widersprüche, Cron/Zeitzone, Parameter-Defaults, Feldnamen/Operatoren/Werttypen in Filtern und Views
   gegen den statischen Feldkatalog des Adaptertyps (`src/config/field-catalog.ts`, §4.3).
5. **Alle** Probleme aller Dateien werden gesammelt (nicht beim ersten abgebrochen), sortiert nach Datei, Zeile,
   Pfad, und als `datei:zeile: pfad: meldung` ausgegeben. Warnungen (`warning:`) verhindern das Laden nicht.

Folgefehler sind möglich: Ist z. B. `identities.yaml` ungültig, meldet `sources.yaml` zusätzlich
`Unknown identity "…"`. Den ersten Fehler zuerst beheben.

Der Loader liest **keine** Umgebungsvariablen. `config validate` prüft also nicht, ob `private_key_env`,
`token_env`, `url_env` oder `headers_env` gesetzt sind, und es prüft weder Skriptpfade auf Existenz noch App-Rechte
oder die Erreichbarkeit von GitHub. Feldnamen werden offline gegen den Feldkatalog geprüft (§4.3) – auch
`project.*` nur gegen die Deklaration in `sources.yaml`, nicht gegen das echte Projekt (das zeigt erst der Dry-Run).
Exit-Code: 0 = gültig (ggf. mit Warnungen), 1 = ungültig.

### 1.5 Wann Änderungen wirken

Konfigurationsänderungen wirken **nur** durch einen manuellen Reload (`adispatch config reload`,
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
| Benannte Filter (`filters/`) | wie eine Änderung an jedem verwendenden Workflow/jeder verwendenden View (dort ist der Filter eingesetzt); Workflows zählen im Reload-Diff als `changedWorkflows` |
| Umgebungsvariablen (Keys, Tokens, Webhook-URLs, Header) | gehören zum Prozess, nicht zur Konfiguration → Änderung erfordert **Neustart** |

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
- `0s` ist syntaktisch gültig, aber nur dort erlaubt, wo 0 einen Sinn hat (Retry-`delay`, `cancel_grace`,
  `cache`, `retention.*_runs`). **> 0** verlangen: `execute.timeout.max_duration`, `execute.timeout.idle_timeout`,
  `timeout` von Conditions, `shell_filter` und `shell`-Actions. **≥ 1 s** verlangen: `scheduler.polling_interval`
  und `retention.cleanup_interval` (ein Null-Intervall würde die Schleife ohne Pause laufen lassen).
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
| Präfix `ADISPATCH_` | in `env`/`secrets` verboten (Groß-/Kleinschreibung egal) | reserviert für das Worker-Protokoll |
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
  `shell`-Action `args[]` und `env.*` (alle Modus `text`). **Keine** Templates: `command`, Labels und
  Projektfeldwerte in `source.update`, Filterwerte, `secrets`, alle übrigen Felder.

**Modus `text`:** Werte werden unverändert eingesetzt (Zahlen/Booleans als `5`, `true`). Ein erlaubter Platzhalter
ohne Wert wird zu einem **leeren String**. Ausnahme `{item.work_branch}`/`{item.work_pr}` (§5.3): ist der Wert
**unknown** (z. B. GitHub nicht erreichbar), wird gar nicht gerendert – der Run endet als `start_error` bzw. die
Action scheitert; nur ein bekannt leerer Wert (`null`) wird zum leeren String.

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

**Sicherheit:** Ersetzte Werte (z. B. `{item.title}`, `{result.message}`, `{item.work_branch}` – Branch-Namen dürfen
Shell-Metazeichen wie `;`, `$`, `` ` `` enthalten) stammen aus externen Quellen und sind untrusted. In `args` sind sie wegen der fehlenden Shell unkritisch; wer sie über `/bin/sh -c` interpoliert,
erzeugt eine Injection. In `source.comment.message` wird `<!--` zu `&lt;!--` neutralisiert (§6.9).

---

## 3. Die Dateien

### 3.1 config.yaml

Alle Schlüssel sind optional. Fehlt die Datei, gelten alle Defaults (mit Warnung).

| Schlüssel | Typ | Default | Erlaubte Werte / Regeln | Bedeutung |
|---|---|---|---|---|
| `server.host` | String | `127.0.0.1` | nicht leer | Bind-Adresse von API/UI. Keine Authentifizierung – nur Loopback oder hinter authentifizierendem Proxy/VPN. |
| `server.port` | Integer | `8787` | 1–65535 | TCP-Port. |
| `server.allowed_hosts` | Liste String | `[]` | je `name` oder `name:port`; IPv6 in Klammern (`[::1]:8787`) | zusätzliche Namen, die im `Host`-Header akzeptiert werden (DNS-Rebinding-Schutz), z. B. der öffentliche Name des Reverse-Proxys. Vergleich ohne Groß-/Kleinschreibung; `name` = jeder Port, `name:port` = nur dieser Port. Ein `Host` **ohne** Port (Standardport des Schemas, z. B. hinter einem HTTPS-Proxy) passt auf `name`, `name:80` und `name:443`. Immer erlaubt: `localhost`, `127.0.0.1`, `[::1]` und – wenn nicht Loopback/Wildcard – `server.host` selbst. |
| `scheduler.polling_interval` | Dauer | `30s` | ≥ 1 s | Pause zwischen zwei Planungsschritten (gemessen ab Ende des vorherigen). |
| `scheduler.max_concurrent` | Integer | `5` | ≥ 1 | Globales Limit für **automatische** Starts. Gezählt werden alle aktiven Runs (inkl. manueller und `recovery_pending`). |
| `workspace.base_dir` | String | `<data-dir>/workspaces` | relativ → zum config-dir | Wurzel der Run-Workspaces; nur Verzeichnisse **strikt darunter** werden symlink-sicher angelegt und automatisch gelöscht. |
| `workspace.cleanup` | Enum | `on_success` | `always`, `on_success`, `never` | Wann der Workspace nach Run-Ende gelöscht wird (§6.12). |
| `lifecycle.action_retry.max_attempts` | Integer | `3` | ≥ 1 | Standard-Anzahl **Versuche insgesamt** pro Lifecycle-Action. |
| `lifecycle.action_retry.delay` | Dauer | `30s` | ≥ 0 | Pause zwischen Versuchen (mind. ein `Retry-After` der API). |
| `retention.completed_runs` | Dauer \| `never` | `30d` | | Aufbewahrung erfolgreicher Runs (`completed` + `success`). |
| `retention.failed_runs` | Dauer \| `never` | `90d` | | alle anderen beendeten Runs (fachlich `failure`, technisch gescheitert, `cancelled`), soweit nicht „blocked“. |
| `retention.blocked_runs` | Dauer \| `never` | `never` | | Runs, deren technischer Fehler in einen Retry-Block gezählt wurde. |
| `retention.max_log_size_per_run` | Größe | `100MB` | | Log-Limit des Haupt-Workers pro Run (stdout+stderr); Überlauf wird markiert. |
| `retention.cleanup_interval` | Dauer | `24h` | ≥ 1 s | Abstand der Retention-Durchläufe (erster Lauf 60 s nach Bereitschaft). |
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
`{"source":"adispatchd","id":…,"event":"…","createdAt":"…","text":"[adispatchd] …","payload":{…}}`
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
  base_dir: /var/lib/adispatchd/workspaces   # Default: <data-dir>/workspaces
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
    project:                 # optional: Felder eines GitHub-Projects-(v2)-Boards als project.<Name>
      owner: example         # User- oder Org-Login des Projekts (Default: owner der Source)
      number: 3              # Projektnummer aus der URL …/projects/3
      identity: maintainer   # liest das Projekt (Default: identity der Source)
      fields:                # Name (wie im Projekt) → Art
        Status: single_select
        Priority: single_select
        Estimate: number
        Due: date
        Sprint: iteration
        Notes: text
```

| Schlüssel | Typ | Pflicht | Regeln | Bedeutung |
|---|---|---|---|---|
| `sources` | Map Source-ID → Source | nein (Default `{}`) | Schlüssel = Konfigurations-ID | alle Sources |
| `<id>.type` | `github` | ja | einziger Adapter in V1 | |
| `<id>.owner` | String | ja | nicht leer (Format nicht geprüft) | Owner/Organisation |
| `<id>.repository` | String | ja | nicht leer | Repository-Name; `{source.repository}` und Feld `repository` = `owner/repository` in der hier geschriebenen Schreibweise |
| `<id>.identity` | Identity-ID | ja | muss in `identities.yaml` existieren | liest Issues/PRs/Dependencies; Fallback für Schreibaktionen (§6.10) |
| `<id>.project` | Objekt | nein | strikt | GitHub-Projects-(v2)-Projekt, dessen Felder als `project.<Name>` verfügbar sind (§4.7.1) |
| `<id>.project.owner` | String | nein | nicht leer; Default = `<id>.owner` | User- **oder** Org-Login, dem das Projekt gehört |
| `<id>.project.number` | Integer | ja | > 0 | Projektnummer aus `https://github.com/orgs/<org>/projects/<n>` bzw. `…/users/<user>/projects/<n>` |
| `<id>.project.identity` | Identity-ID | nein | muss existieren; Default = `<id>.identity` | Identity für die Projekt-Abfragen (z. B. eine `github_token`-Identity für User-Projekte, §3.3); **wenn gesetzt**, schreibt sie auch die Projektfelder von `source.update` (§3.4.11, §6.10) |
| `<id>.project.fields` | Map Feldname → Art | ja | mind. ein Eintrag; Name nicht leer, ohne führende/abschließende Leerzeichen und ohne Steuerzeichen; Art `single_select`, `text`, `number`, `date`, `iteration` | Felder, auf die gefiltert/sortiert werden soll |

Nur `github.com` wird unterstützt (keine Einstellung für GitHub Enterprise). Gelesen werden Issues **und** Pull
Requests des Repositories über `GET /repos/{owner}/{repo}/issues`, standardmäßig **nur offene** (siehe §4.5).

**Projektfelder (`project`).** Jeder Eintrag in `fields` wird zum Feld `project.<Name>` (Name genau wie unter
`fields` geschrieben, z. B. `project.Status`), nutzbar in `filter`, `item_priority` und in Views (`fields`, `sort`,
`link`). Feldtyp je Art: `single_select` (Name der Option), `text` und `iteration` (Titel der Iteration) → `string`;
`number` → `number`; `date` → `date`. Der Abgleich mit dem Projekt vergleicht den Feldnamen **ohne** Beachtung der
Groß-/Kleinschreibung (`status` findet `Status`); die **Werte** werden wie alle Strings außer `labels` mit
Groß-/Kleinschreibung verglichen. Gelesen wird per GraphQL im selben Planungsschritt wie die Issue-Liste – die
Felder sind daher **nicht teuer** und haben **keinen Pushdown**. Unbekannt-Regeln: §4.7.1.

**Anfragevolumen je Listing** mit *n* Items: höchstens **eine** Metadaten-Abfrage plus **⌈n/50⌉** Werte-Abfragen.
Die Metadaten (Projekt-ID, Felder) teilen sich alle Listings derselben Source **30 s** lang (mehrere Workflows auf
einer Source → eine Metadaten-Abfrage pro Poll; Workflows mit gleichem Pushdown teilen sich ohnehin das Listing eines
Planungsschritts); das frische Lesen eines Items vor `on_start` nutzt sie bis zu 5 Minuten. Die Werte werden pro
Listing neu gelesen. **Rate-Limits** halten den Planungsschritt nicht auf: Projekt-Abfragen warten höchstens 5 s auf
einen Retry; nach einem Rate-Limit sind alle `project.*` der Source bis zum Reset (`Retry-After` bzw.
`x-ratelimit-reset`, sonst 60 s) sofort `unknown` mit Grund „GitHub GraphQL rate limit until <Zeit>“, ohne GitHub
zu fragen.

**Rechte.** Die Projekt-Identity liest über `nodes(ids:)` die Issues/PRs selbst; sie braucht deshalb **Lesezugriff
auf das Projekt und auf die Issues/PRs des Repositories**. Fehlt der Zugriff aufs Repository, sind die Werte der
Items `unknown`.
- **Org-eigene** Projekte: die GitHub App der Source mit der Berechtigung **Organization → Projects: Read** (in der
  App-Konfiguration hinzufügen und in der Installation bestätigen); Issues-Lesezugriff hat sie als Source-Identity
  ohnehin.
- **User-eigene** Projekte sind für GitHub-App-Installationstoken nicht zugänglich: dafür eine Identity vom Typ
  `github_token` (§3.3) anlegen und als `project.identity` eintragen. **Empfohlen:** klassischer Personal Access
  Token des Projekt-Owners mit **`read:project`**, bei privaten Repositories zusätzlich **`repo`** (für öffentliche
  genügt `read:project`). Ein fine-grained Token (Repository-Rechte *Issues: Read* und *Pull requests: Read*,
  Account-Recht *Projects: Read*) ist für user-eigene Projekte **nicht verifiziert** (Live-Test T25c in
  [manual-tests/github.md](manual-tests/github.md)).
- Die Source selbst kann weiter per App lesen.

**Schreibrechte (seit 0.3.0, `source.update` → `project`, §3.4.11).** Geschrieben wird mit `project.identity`, wenn
sie an der Source **ausdrücklich** gesetzt ist, sonst mit der Identity der Action (Workflow → Source, §6.10).
- **Org-eigene** Projekte per GitHub App: **Organization → Projects: Read and write**.
- **User-eigene** Projekte per `github_token`: klassischer Token mit **`project`** (statt `read:project`) plus
  **`repo`** (private Repositories; zum Hinzufügen des Items muss der Token das Issue/den PR lesen können).
  Fine-grained Tokens (*Projects: Read and write*) sind **nicht verifiziert**.
- Fehlt das Schreibrecht, scheitert die Action mit `forbidden` (nicht wiederholbar).

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
  project_reader:
    type: github_token                 # z. B. klassischer PAT mit read:project (+ repo bei privaten Repos)
    token_env: GITHUB_PROJECT_TOKEN    # Name der Env-Variable, nie der Token selbst
```

| Schlüssel | Typ | Pflicht | Regeln | Bedeutung |
|---|---|---|---|---|
| `identities` | Map Identity-ID → Identity | nein (Default `{}`) | Schlüssel = Konfigurations-ID | |
| `<id>.type` | `github_app` \| `github_token` | ja | | Art der Identity |
| `<id>.app_id` | Integer | ja (`github_app`) | > 0 | GitHub-App-ID (auch zur Erkennung eigener Kommentare) |
| `<id>.installation_id` | Integer | ja (`github_app`) | > 0 | Installation der App im Ziel-Owner |
| `<id>.private_key_env` | Env-Name | ja (`github_app`) | `^[A-Za-z_][A-Za-z0-9_]*$` | Name der Umgebungsvariable mit dem privaten Schlüssel |
| `<id>.token_env` | Env-Name | ja (`github_token`) | `^[A-Za-z_][A-Za-z0-9_]*$` | Name der Umgebungsvariable mit dem Token |

**Secrets über die Umgebung:** Der Schlüssel steht nie in YAML. Die Variable muss in der Umgebung des
Orchestrator-Prozesses gesetzt sein (unter systemd: `EnvironmentFile`, Default `/etc/default/adispatchd`,
siehe [operations.md](operations.md)). Format des Werts: **RSA**-Private-Key im PEM-Format
(`-----BEGIN RSA PRIVATE KEY-----` bzw. PKCS#8 `-----BEGIN PRIVATE KEY-----`); akzeptiert werden echte
Zeilenumbrüche, wörtliche `\n`-Escapes (typisch in Env-Dateien), CRLF sowie umschließende `"…"`/`'…'`.
Gelesen wird der Schlüssel erst beim **ersten Token-Bedarf** (nicht beim Laden/Validieren); fehlt er oder ist er
ungültig, scheitert der jeweilige Zugriff mit einem nicht wiederholbaren Authentifizierungsfehler (Source-Fehler
in der Planungsdiagnose, `start_error` bei `execute.secrets`, endgültig gescheiterte Action). Aus dem Schlüssel
werden kurzlebige Installation-Tokens erzeugt und im Speicher gecacht; Schlüssel, JWT und Tokens werden in Logs
redigiert. Minimale App-Rechte: Issues lesen/schreiben, Pull Requests schreiben (Labels/Kommentare auf PRs),
Metadata lesen; für Projektfelder org-eigener Projekte zusätzlich **Organization → Projects: Read**, zum Setzen
von Projektfeldern **Read and write** (§3.2).

**`github_token`** (seit 0.2.0): ein langlebiger GitHub-Token, vor allem für **user-eigene Projekte**, die
GitHub-App-Installationstoken nicht lesen können (§3.2). Der Token wird beim Start des Dienstes (bzw. beim Aufbau
der Credentials nach einem Reload) aus `token_env` gelesen und sofort beim Redactor registriert; er erscheint nie in
Logs, API-Antworten oder der Datenbank. Fehlt die Variable oder ist sie leer, wird das beim Start als Fehler
geloggt, und jeder Zugriff mit dieser Identity scheitert mit einem nicht wiederholbaren Authentifizierungsfehler
(wie beim fehlenden Private Key). Nach einem 401 wird die Variable einmal neu gelesen. Eine `github_token`-Identity
kann überall verwendet werden, wo Identities erlaubt sind (Source, `project.identity`, `execute.secrets`,
Schreib-Actions). **Kommentar-Marker** (`source.comment`-Idempotenz, §3.4.11) erkennt der Adapter bei
`github_token` am **Autor-Login**: beim ersten Gebrauch fragt er `GET /user` ab und cacht den Login; ein Kommentar
mit Marker zählt nur, wenn `user.login` gleich diesem Login ist (bei Apps: `performed_via_github_app.id`).

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
    - not: { use: on-hold }        # benannter Filter filters/on-hold.yaml (§3.6)
    - any:
        - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
        - { field: labels, operator: contains, value: ignore-dependencies }

shell_filter:                    # nur Source-Workflows; ein Programm ohne Argumente
  command: scripts/filter.sh     # bekommt ADISPATCH_CHECK_CONTEXT_FILE; Exit 0/1/≥2
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
Source (beachte §4.5: standardmäßig nur offene Issues/PRs). Statt eines Mappings darf die ID eines benannten
Filters stehen (`filter: ready-for-coding`, §3.6); `{ use: <id> }` geht an jeder Stelle im Baum.

#### 3.4.4 `shell_filter`

| Schlüssel | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `command` | String | ja | | Programm (§2.4). **Keine `args`** – das Item kommt über `ADISPATCH_CHECK_CONTEXT_FILE`. |
| `timeout` | Dauer | nein | `30s` | > 0; danach `unknown` |

Exit `0` = passt, `1` = passt nicht, `≥ 2`/Signal/Timeout/Startfehler = `unknown` (kein Start). Nie gecacht, nie im
Dry-Run ausgeführt, nicht in Views. Umgebung und Kontextdatei: §6.11.

#### 3.4.5 `item_priority`

| Schlüssel | Typ | Default | Bedeutung |
|---|---|---|---|
| `rules` | Liste `{ when: <Filter-AST oder Filter-ID>, value: <Zahl> }` | `[]` | in Reihenfolge ausgewertet; die erste Regel mit Ergebnis `true` liefert die Priorität; `false`/`unknown` zählen nicht |
| `default` | Zahl | `0` | wenn keine Regel zutrifft |

Ohne `item_priority` ist die Item-Priorität 0. Regeln dürfen teure Felder verwenden (werden dann aufgelöst).

#### 3.4.6 `conditions`

`conditions.workflow[]` und `conditions.item[]` haben dieselbe Form:

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `type` | `shell` | ja | | | |
| `command` | String | ja | | §2.4 | Prüfprogramm |
| `args` | Liste String | nein | `[]` | Templates (§5) | |
| `timeout` | Dauer | nein | `30s` | > 0 | danach `unknown` |
| `cache` | Dauer | nein | kein Cache | **nur** `conditions.workflow` | Ergebnis `true`/`false` so lange wiederverwenden; `unknown` wird nie gecacht |

- `workflow`: werden – falls Kandidaten vorhanden – einmal pro Planungsschritt bzw. einmal pro Cron-Slot geprüft,
  in Listenreihenfolge, Abbruch beim ersten Nicht-`true`. Erlaubt bei allen Triggern; bei `manual` wirkungslos
  (manuelle Starts umgehen Conditions).
- `item`: pro Kandidat, nur Source-Workflows, nie gecacht.
- Exit-Semantik wie `shell_filter`. Dry-Runs führen Conditions nie aus.

#### 3.4.7 `parameters`

Map Parametername → Definition. Werte **übergeben** werden nur bei manuellen Starts (UI-Formular,
`POST /api/v1/workflows/:id/start` mit `{"parameters": {…}}`) und vor dem Start validiert; automatisch gestartete
Runs (Source, Cron) erhalten die `default`-Werte (siehe unten).

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
- Automatisch gestartete Runs (Source, Cron) erhalten die **`default`-Werte** aller Parameter, die einen haben
  (gespeichert am Run, sichtbar in API/UI und Kontextdatei). Parameter ohne Default bleiben dort leer
  (`{parameters.x}` = leerer String).

#### 3.4.8 `execute`

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `type` | `shell` | ja | | einziger Executor in V1 | |
| `command` | String | ja | | §2.4 | Worker-Programm |
| `args` | Liste String | nein | `[]` | Templates, Modus `text` | Argumente |
| `working_directory` | String | nein | `{workspace.base_dir}/{workflow.id}/{run.id}` | Modus `path`; beginnt mit `/` oder `{workspace.base_dir}` | Arbeitsverzeichnis = Workspace (`ADISPATCH_WORKSPACE`) |
| `create_directory` | Boolean | nein | `true` | | Verzeichnis anlegen; bei `false` muss es existieren (sonst `start_error`) |
| `env` | Map Name → String/Zahl/Boolean | nein | `{}` | Templates; kein `ADISPATCH_`-Präfix | zusätzliche Umgebungsvariablen |
| `secrets` | Map Name → `{ identity: <id> }` | nein | `{}` | Identity muss existieren; Name nicht zugleich in `env`; kein `ADISPATCH_` | Installation-Token der Identity als Env-Variable (nur im Speicher) |
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
| `retry.delay` | Dauer | nein | `lifecycle.action_retry.delay` | Pause zwischen Versuchen (`0s` erlaubt) |

`source.update` – Labels und/oder Projektfelder des Items ändern (nur Source-Workflows):

| Schlüssel | Typ | Pflicht | Regeln |
|---|---|---|---|
| `labels.add` | Liste String | nein (`[]`) | kein Label in `add` und `remove` |
| `labels.remove` | Liste String | nein (`[]`) | |
| `project` | Map Feldname → Wert | nein | seit 0.3.0; mind. ein Eintrag; Schlüssel = Name aus `project.fields` der Trigger-Source (ohne `project.`-Präfix); Wert je Art (Tabelle unten), `null` = Feld leeren |

Mindestens ein Label in `labels.add`/`labels.remove` **oder** ein `project`-Eintrag ist Pflicht. Kein Template:
Labels und Projektwerte werden wörtlich übernommen. Vor dem Schreiben wird das Item neu gelesen; nur fehlende Labels
werden hinzugefügt, nur vorhandene entfernt (Vergleich ohne Groß-/Kleinschreibung) → idempotent. Schreib-Identity:
Workflow → Source (§6.10).

```yaml
on_start:
  - type: source.update
    labels: { add: [in-progress], remove: [ready-for-coding] }
    project:
      Status: In Progress     # single_select: Optionsname
      Estimate: 3             # number
      Due: 2026-11-01         # date (YYYY-MM-DD)
      Sprint: Sprint 12       # iteration: Iterationstitel
      Notes: null             # null = Feld leeren
on_success:
  - type: source.update
    project: { Status: Review }
```

| Art (`project.fields`) | Wert in `project` | Abgleich beim Schreiben |
|---|---|---|
| `single_select` | String (Optionsname) | Option mit exakt diesem Namen, sonst ohne Groß-/Kleinschreibung, wenn eindeutig |
| `iteration` | String (Iterationstitel) | wie `single_select`, über laufende/kommende **und** abgeschlossene Iterationen |
| `text` | String (nicht leer) | wörtlich |
| `number` | Zahl | |
| `date` | Datum `YYYY-MM-DD` (unquotiert oder quotiert) | gültiges Kalenderdatum |
| alle | `null` | Feld leeren |

**Projektfelder setzen** (Source braucht `project` in `sources.yaml`, §3.2):
- **Reihenfolge:** erst Labels, dann Projektfelder. Scheitern die Projektfelder, scheitert die Action (die Labels
  sind dann schon gesetzt); ein Retry ist sicher, weil beide Teile idempotent sind.
- **Erst lesen, dann schreiben:** Metadaten des Projekts (Feld-IDs, Optionen, Iterationen; bis zu 5 min gecacht)
  und das Projekt-Item des Issues/PRs werden per GraphQL gelesen. Ist das Item nicht im Projekt, wird es mit
  `addProjectV2ItemById` hinzugefügt (Journal `projectItemAdded: true`). Felder, deren Wert schon stimmt, werden
  übersprungen; sonst je Feld `updateProjectV2ItemFieldValue` bzw. für `null` `clearProjectV2ItemFieldValue`.
  Alle Werte gehen nur als GraphQL-Variablen an GitHub.
- **Nicht wiederholbare Fehler** (Action sofort `failed`, §6.9): Feld fehlt im Projekt, Art passt nicht zum
  `dataType`, Option/Iteration unbekannt oder mehrdeutig (Meldung listet die vorhandenen, z. B. `option "Blocked"
  not found (available: "Todo", "In Progress", "Done")`), fehlendes Schreibrecht (`forbidden`). Vorher werden
  gecachte Metadaten einmal frisch geladen (neu angelegte Optionen werden also gefunden).
- **Wiederholbar:** Rate-Limits (auch HTTP 200 mit `RATE_LIMITED`, mit `Retry-After`), transiente Fehler und
  GraphQL-Fehler ohne Typ (`lifecycle.action_retry`). Nach jeder gescheiterten Mutation werden die Metadaten beim
  nächsten Versuch neu geladen; meldet GitHub `NOT_FOUND` für eine ID aus gecachten Metadaten (z. B. neu angelegte
  Option), lädt der Adapter sofort einmal neu und wiederholt das Update im selben Versuch.
- **Identity:** `project.identity` der Source, wenn dort ausdrücklich gesetzt, sonst dieselbe wie für die Labels
  (§6.10). Rechte: §3.2.
- **Journal:** `details.applied.projectFields` (geänderte Felder → neuer Wert, `null` = geleert), sichtbar im Run
  unter *Events* (z. B. `on_start on_start.0 succeeded (+in-progress, Status=In Progress)`) und in
  `GET /api/v1/runs/:id/events`. Scheitert die Action mittendrin, steht das bis dahin Geänderte (Labels,
  Projektfelder, `projectItemAdded`) im Fehler des Versuchs unter `details.applied` (auch im Event und in der
  Zusammenfassung, z. B. `on_success on_success.0 failed (+ready-for-review, -coding)`). `projectItemAdded` wird nur
  gemeldet, wenn das Item nachweislich fehlte (alle Projekt-Mitgliedschaften gelesen).

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
| `env` | Map | nein | `{}` | Templates, kein `ADISPATCH_`-Präfix |
| `timeout` | Dauer | nein | `5m` | Laufzeitlimit pro Versuch (> 0) |

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
| `filter` | Filter-AST oder ID eines benannten Filters (§3.6) | nein | alles | §4; inkl. `run.last_*` | nur Items mit Ergebnis `true` werden gezeigt |
| `shell_filter` | – | – | | **verboten** (Fehler) | Views führen nie Skripte aus |
| `fields` | Liste | ja | | ≥ 1 | Spalten in Reihenfolge |
| `fields[].field` | String | ja | | muss im Feldkatalog des Adaptertyps oder in §4.8 stehen; `project.*` nur, wenn **alle** Sources der View es mit gleicher Art deklarieren (§4.7.1) | Feldname (§4.7, §4.8); `object[]`-Felder (`closing_prs`) erscheinen als Liste, z. B. `#12 open, #9 merged`, jeder Eintrag als Link auf seine `url` |
| `fields[].label` | String | nein | Feldname | | Spaltenüberschrift |
| `fields[].link` | String (Feldname, geprüft wie `field`) | nein | `link` der Felddefinition (`number`, `title` → `url`; `work_pr` → `work_pr_url`, also der PR) | | Feld, dessen Wert (nur absolute `http(s)`-URL) als Link dient |
| `sort.field` | String | ja (wenn `sort`) | | geprüft wie `fields[].field`; kein `object[]`-Feld (`Views cannot be sorted by "closing_prs" (type object[])`) | Sortierfeld |
| `sort.direction` | Enum | nein | `asc` | `asc`, `desc` | leere Werte immer zuletzt; Gleichstand nach Item-Schlüssel (natürlich) |

Laden: beim Öffnen/Refresh aus allen Sources (parallel; eine fehlerhafte Source erscheint als Fehlerzeile, die
anderen liefern trotzdem), Cache 30 s, max. 2 000 Zeilen. Nicht auflösbare Felder (z. B. fehlende API-Rechte) bleiben erkennbar leer; unbekannte Feldnamen sind bereits
ein Konfigurationsfehler (§4.3).

### 3.6 filters/*.yaml

Ein **benannter Filter** pro Datei: einmal zentral definiert, in Workflows und Views nur noch referenziert, damit
alle dieselben Items sehen.

```yaml
# example: reference
# file: filters/on-hold.yaml
id: on-hold                        # Pflicht; Dateiname sollte <id>.yaml sein
description: Zurückgestellte Items  # optional, nur zur Anzeige
filter: { field: labels, operator: contains, value: on-hold }
```

| Schlüssel | Typ | Pflicht | Regeln | Bedeutung |
|---|---|---|---|---|
| `id` | Konfigurations-ID | ja | eindeutig über alle Filterdateien (sonst Fehler in der alphabetisch späteren Datei); weicht der Dateiname ab → Warnung | Name für `use` |
| `description` | String | nein | | Beschreibung (API `GET /api/v1/config` → `filters`) |
| `filter` | Filter-AST oder Filter-ID | ja | §4; darf selbst andere benannte Filter verwenden | der Filter |

**Verwendung** (§4.1):

- **Kurzform:** `filter: on-hold` – ein String statt Mapping – in Workflow, View und `item_priority.rules[].when`
  bedeutet genau diesen Filter.
- **Referenzknoten** `{ use: on-hold }` (einziger Schlüssel) **überall** im Filterbaum: Workflow-`filter`,
  `item_priority.rules[].when`, View-`filter` und in anderen benannten Filtern. Damit lässt sich kombinieren:
  `all: [{ use: ready-for-coding }, { field: labels, operator: contains, value: backend }]`.

**Auflösung beim Laden:** Jede Referenz wird durch den Baum des benannten Filters ersetzt (expandiert). Der
geladene Workflow bzw. die View enthält nur noch den expandierten Baum; Scheduler, Planner, Views, Pushdown,
Dry-Run und Run-Snapshot sehen keine Referenzen. Ein `use` steht für seinen Inhalt an genau dieser Stelle: für die
`state`-Regel und den Pushdown (§4.5) zählt die Position **nach** dem Einsetzen.

**Prüfung:**

- Jeder benannte Filter wird strukturell geprüft (wie jeder Filter) – auch wenn ihn niemand verwendet. Fehler in
  der Filterdatei selbst: unbekannte Filter-ID (mit „did you mean …“), Zyklus (`a → b → a`), Referenzkette tiefer
  als 16 Ebenen, mehr als 10 000 Knoten nach dem Einsetzen (§3.7), `use` mit weiteren Schlüsseln oder ohne gültige ID.
- Die **Feldprüfung** (Feldkatalog, Operatoren, Werttypen, `run.last_*` nur in Views, `project.*` je Source, §4.3)
  hängt vom Kontext ab und läuft daher **an jedem Verwendungsort** auf dem expandierten Baum. Die Meldung nennt den
  Verwendungsort und den Pfad im benannten Filter, z. B.
  `workflows/coder.yaml: filter.all[0] (use "ready-for-coding" → filters/ready-for-coding.yaml: filter.all[1].field): Unknown field …`.
  Ein Filter mit `run.last_status` ist also in einer View gültig, in einem Workflow ein Fehler.
- Verwendet ein Workflow/eine View einen fehlerhaften benannten Filter, kommt dort zusätzlich
  `Named filter "x" is invalid (see filters/x.yaml)`. Wie jeder Fehler macht das die ganze Konfiguration ungültig
  (Laden und Reload sind atomar, §1.5).
- Ein benannter Filter, den kein Workflow und keine View verwendet (auch nicht über andere benannte Filter), ergibt
  eine **Warnung**.

**Reload:** `config reload` und der Start lesen `filters/` mit; eine Änderung an einem benannten Filter wirkt nach
dem Reload auf alle verwendenden Workflows und Views (§1.5). `workflow dry-run` zeigt den expandierten Filter
(Zeile `filter:`), `GET /api/v1/config` listet die benannten Filter unter `filters` (expandiert), die Dateien
erscheinen in `GET /api/v1/config/files` (UI: Configuration).

### 3.7 Bekannte Grenzen (V1)

- `shell_filter` hat nur `command` und `timeout`: **keine `args`**, kein `env`. Das Item kommt ausschließlich über
  `ADISPATCH_CHECK_CONTEXT_FILE`; Parameter für das Skript über einen Wrapper bzw. die Kontextdatei.
- Conditions (`conditions.workflow`, `conditions.item`) haben `args`, aber **kein `env`**; die Umgebung ist die
  Minimalumgebung plus `ADISPATCH_CHECK_CONTEXT_FILE` (§6.11).
- `shell`-Actions: Frist zwischen `SIGTERM` und `SIGKILL` fest **5 s**, Log-Limit fest **10 MiB** pro Versuch –
  nicht konfigurierbar (`execute.cancel_grace` und `retention.max_log_size_per_run` gelten nur für den Haupt-Worker).
- Prüfskripte (Conditions, `shell_filter`): Ausgabe wird bis 16 KiB je Stream erfasst, SIGTERM→SIGKILL nach 2 s.
- Nur Adapter `github` (github.com), Identity-Typen `github_app` und `github_token`, nur Kanaltyp `webhook`, nur
  Executor `shell`.
- Projektfelder: ein Projekt je Source; Metadaten lesen die ersten 100 Felder des Projekts; je Issue/PR werden die
  ersten 20 (nicht archivierten) Projekt-Mitgliedschaften gelesen (mehr → unknown, §4.7.1). Kein Pushdown: die
  Issue-Liste wird wie bisher nur über `state`/`labels` eingeschränkt.
- Verknüpfte Branches/PRs (§4.7.2): je Issue werden die ersten **20** verlinkten Branches und die ersten **20**
  schließenden PRs gelesen; mehr → alle fünf Felder unknown. Nur Branches und PRs des Source-Repositorys zählen.
- Benannte Filter haben keine Parameter (kein `{use: x, value: …}`); Referenzketten höchstens 16 Ebenen tief
  (gezählt ab jedem Workflow-, View- oder Filter-Wurzelknoten).
- Ein expandierter Filterbaum hat höchstens **10 000 Knoten** je Wurzel (Workflow-`filter`, jede
  `item_priority`-Regel, View-`filter`, jeder benannte Filter für sich). Benannte Filter werden an jedem
  Verwendungsort kopiert; die Expansion bricht ab, bevor die Grenze überschritten würde (Fehler am Verwendungsort).

---

## 4. Filter-Sprache

Gemeinsam für `filter` (Workflows), `item_priority.rules[].when`, `filter` (Views) und benannte Filter (§3.6).

### 4.1 Grammatik

```text
Wurzel     := Knoten | <Filter-ID>            # Kurzform: String = { use: <Filter-ID> }
Knoten     := All | Any | Not | Use | Prädikat
All        := { all: [ Knoten, … ] }          # einziger Schlüssel; [] = true
Any        := { any: [ Knoten, … ] }          # einziger Schlüssel; [] = false
Not        := { not: Knoten }                 # einziger Schlüssel
Use        := { use: <Filter-ID> }            # einziger Schlüssel; benannter Filter aus filters/ (§3.6)
Prädikat   := { field: <String>, operator: <Operator>, value: <Wert> }   # genau diese drei Schlüssel
Operator   := equals | not_equals | contains | in | greater_than | less_than
Wert       := String | Zahl | Boolean | null            # equals, not_equals, contains
            | [ Skalar, … ] (nicht leer)                # in
            | Zahl | String (ISO-Datum)                  # greater_than, less_than
```

`value` ist immer Pflicht (`null` explizit schreiben). Strukturfehler werden exakt verortet
(`filter.all[1].operator`). Eine Liste als `value` nimmt **nur** `in`; alle anderen Operatoren verlangen einen
Skalar (`greater_than`/`less_than`: Zahl oder Datums-String) – sonst Fehler. `Use` wird beim Laden durch den
Baum des benannten Filters ersetzt (§3.6).

### 4.2 Operatoren – exakte Semantik

`a` = Feldwert, `v` = `value`. Ergebnis `true`/`false`/`unknown`; „unknown (Typ)“ heißt: inkompatible Typen (bei
katalogisierten Feldern verhindert die Werttyp-Prüfung beim Laden diesen Fall, Tabelle unten).

| Operator | Skalares Feld (string/number/boolean) | Datumsfeld (`date`) | Listenfeld (`string[]`) |
|---|---|---|---|
| `equals` | gleicher JS-Typ und gleicher Wert; anderer Typ → unknown (Typ). `'1'` vs `1`, `'true'` vs `true` → unknown | beide als ISO-8601 geparst, Vergleich als Zeitpunkt; nicht parsebar → unknown | nicht erlaubt (Validierungsfehler) |
| `not_equals` | Negation von `equals`; unknown bleibt unknown | dito | nicht erlaubt |
| `contains` | nur String-Feld: Teilstring (Groß-/Kleinschreibung beachtet) | nicht erlaubt | `true`, wenn ein Element `=== v`; leere Liste → `false`; kein Element vom Typ von `v` → unknown |
| `in` | `true`, wenn `equals` mit einem Listenelement `true` ist, sonst `false` (string/number) | nicht erlaubt | `true` bei nichtleerer Schnittmenge; leere Feldliste → `false`; keinerlei Typgleichheit → unknown |
| `greater_than` / `less_than` | Zahl vs Zahl numerisch (String-Felder: nicht erlaubt) | ISO-8601-Zeitpunkte | nicht erlaubt |

`null`-Regeln (ein Feldwert `null` bedeutet „bekannt leer“, z. B. kein Autor):

- `equals null` ist genau dann `true`, wenn der Feldwert `null` ist; `equals x` auf `null`-Feld → `false`;
  `not_equals` entsprechend umgekehrt.
- `contains`/`in` auf `null`-Feld → `false`; `null` als Wert ist nur bei `equals`/`not_equals` erlaubt.
- `greater_than`/`less_than` mit `null` auf einer Seite → unknown.

Datumswerte: `YYYY-MM-DD` oder `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]`; ohne Offset = UTC. Relative Angaben
(„vor 7 Tagen“) gibt es nicht. Datumssemantik gilt nur für Felder, die der Adapter als `date` deklariert.

**Erlaubte Operatoren je Feldtyp** (beim Laden geprüft, Spalte „Operatoren“ in §4.7/§4.8):

| Feldtyp | Operatoren | Erlaubte `value`-Typen |
|---|---|---|
| `string` | equals, not_equals, contains, in | String (`in`: Liste von Strings); `null` bei equals/not_equals |
| `number` | equals, not_equals, in, greater_than, less_than | Zahl (`in`: Liste von Zahlen); `null` bei equals/not_equals |
| `boolean` | equals, not_equals | Boolean (nicht `'true'`); `null` bei equals/not_equals |
| `date` | equals, not_equals, greater_than, less_than | ISO-8601-String (s. o.); `null` bei equals/not_equals |
| `string[]` | contains, in | String bzw. Liste von Strings |
| `object[]` |  | – (keine Operatoren; in Filtern ein Fehler, §4.7.2) |

**Groß-/Kleinschreibung:** `labels` (GitHub) vergleicht ohne Beachtung der Groß-/Kleinschreibung – wie GitHub
und `source.update` (`Ready` passt auf `ready`). Alle anderen String-Vergleiche beachten sie.

### 4.3 Fehlende und unbekannte Felder

- **Beim Laden geprüft** gegen den statischen Feldkatalog des Adaptertyps der Source (Workflows: `filter`,
  `item_priority.rules[].when`; Views: `filter`, `fields[].field`, `fields[].link`, `sort.field`): unbekannte
  Feldnamen (mit Vorschlag „did you mean …“), nicht erlaubte Operatoren, falsche Werttypen, ungültige Datumswerte.
- `run.last_*` ist nur in Views erlaubt; in Workflows ist es ein Fehler („only available in views“).
- Felder vom Typ `object[]` (`closing_prs`) haben keine Operatoren: in `filter`/`item_priority` ein Fehler
  `Field "closing_prs" (type object[]) cannot be used in filters; use "work_pr" (…) or "work_branch" instead`, als
  `sort.field` einer View ebenfalls. Als View-Spalte und in der Kontextdatei sind sie erlaubt.
- Benannte Filter (§3.6) werden am Verwendungsort gegen dessen Kontext geprüft; die Meldung nennt in Klammern den
  Pfad im benannten Filter.
- `project.<Name>` gibt es je Source genau für die in `sources.yaml` unter `project.fields` deklarierten Namen
  (Workflow: die Trigger-Source; View: nur Felder, die alle Sources der View mit gleicher Art deklarieren). Sonst
  Fehler `Unknown project field "…"` mit Grund (nicht deklariert / keine `project`-Einstellung / fehlt in Source X /
  Art unterschiedlich) und ggf. „did you mean …“.
- Kann ein bekanntes Feld zur Laufzeit nicht ermittelt werden (fehlender API-Zugriff, z. B. Cross-Repo-Blocker
  ohne Rechte, kein Zugriff aufs Projekt), ist es **unknown** – nie 0, leer oder `false` („fail closed“).
  `workflow dry-run` zeigt pro Regel den Wert und den Grund, zusätzlich je Kandidat alle `project.*`-Werte bzw.
  deren Unknown-Grund.

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

- **Teure Felder** (GitHub: `dependencies.*`, `linked_branches`, `closing_prs`, `work_branch`, `work_pr`,
  `work_pr_url`) stehen nicht in der Listenabfrage und werden lazy nachgeladen – pro Item in **einer** Anfragerunde
  für alle benötigten teuren Felder (Dependencies per REST, die verknüpften Branches/PRs mit genau **einer**
  GraphQL-Abfrage, beide parallel), gültig für einen Planungsschritt/View-Aufruf.
- Innerhalb von `all`/`any` werden zuerst Kinder ausgewertet, die nur billige Felder brauchen; sobald das Ergebnis
  feststeht, wird abgebrochen (Rest = `not_evaluated` in der Diagnose). Workflow-Filter laufen zweistufig: erst nur
  billige Felder (teure = unknown); ist das Ergebnis schon `true` oder `false`, ist es endgültig, nur bei unknown
  werden teure Felder später (nach Lock/Block/Conditions) aufgelöst.
- **Pushdown:** Nur Prädikate der obersten Konjunktion (`all`, verschachtelte `all` werden abgeflacht; ein
  einzelnes Prädikat zählt auch) mit billigem Feld und in `pushdown` deklariertem Operator gehen in die API-Abfrage.
  `any`/`not` werden nie gepusht. Der vollständige Filter wird **immer** zusätzlich lokal ausgewertet.
  Benannte Filter zählen nach dem Einsetzen: `{ use: x }` direkt in der obersten `all` (oder `filter: x`) wird wie
  ein verschachteltes `all` abgeflacht, unter `any`/`not` nicht.
- **GitHub-Abfrage:** `state` = `open` (Default!), `closed` oder `all`, abgeleitet aus `state equals open|closed`
  bzw. `state in [...]` auf oberster Ebene; `labels contains "x"` (ohne Komma) → `labels=x` (alle müssen
  vorhanden sein). **Ohne ein solches `state`-Prädikat werden nur offene Issues/PRs gelesen.**
- **Regel für `state`** (Workflow- und View-`filter`, geprüft beim Laden): `state` darf nur auf oberster Ebene
  stehen (direkt oder in oberster `all`), nur mit `equals` oder `in` und nur mit den Werten `open`/`closed`.
  Unter `any`/`not`, mit `not_equals`/`contains` oder mit anderen Werten wäre es stillschweigend wirkungslos
  (es würden trotzdem nur offene Items gelesen) und ist daher ein Fehler. In `item_priority` ist `state` frei
  verwendbar (beeinflusst die Abfrage nicht). Mit benannten Filtern zählt die Position nach dem Einsetzen:
  `filter: x` bzw. `{ use: x }` direkt in der obersten `all` ist oberste Ebene, unter `any`/`not` nicht – ein
  benannter Filter mit `state` ist also je nach Verwendungsort gültig oder ein Fehler.

### 4.6 Workflow-Filter vs. View-Filter

| | Workflow `filter` | View `filter` |
|---|---|---|
| Ergebnis unknown | kein Start (Diagnose `filter_unknown`) | Zeile ausgeblendet, gezählt in `filterUnknown` |
| Felder | Adapterfelder | Adapterfelder + `run.last_*` |
| Shell | zusätzlich `shell_filter`, Conditions | nie |
| Zeitpunkt | jeder Planungsschritt; vor `on_start` erneut der billige Teil auf dem frisch gelesenen Item: `false` bricht den Run ohne Hooks ab, ebenso `unknown` durch ein billiges Feld, das die Source nicht ermitteln konnte (z. B. `project.*` ohne Zugriff); `unknown` nur durch teure Felder lässt ihn laufen | Öffnen/Refresh (Cache 30 s) |

### 4.7 Feldkatalog des GitHub-Adapters

| Feld | Typ | Sinnvolle Operatoren | Pushdown | Teuer | Bedeutung |
|---|---|---|---|---|---|
| `number` | number | equals, not_equals, in, greater_than, less_than | | | Issue-/PR-Nummer (Link → `url`) |
| `title` | string | equals, not_equals, contains, in | | | Titel (Link → `url`) |
| `state` | string | equals, not_equals, contains, in – im `filter` nur `equals`/`in` auf oberster Ebene (§4.5) | equals, in | | `open` \| `closed` |
| `labels` | string[] | contains, in | contains | | Label-Namen; Vergleich **ohne** Groß-/Kleinschreibung |
| `assignees` | string[] | contains, in | | | Logins der Assignees |
| `author` | string | equals, not_equals, contains, in | | | Login des Autors (`null` falls unbekannt) |
| `is_pull_request` | boolean | equals, not_equals | | | `true` für Pull Requests |
| `created_at` | date | equals, not_equals, greater_than, less_than | | | Erstellungszeit |
| `updated_at` | date | equals, not_equals, greater_than, less_than | | | letzte Änderung |
| `url` | string | equals, not_equals, contains, in | | | Web-URL |
| `repository` | string | equals, not_equals, contains, in | | | `owner/repository` (wie in `sources.yaml`) |
| `state_reason` | string | equals, not_equals, contains, in | | | Grund für Schließen/Wiedereröffnen wie von GitHub geliefert (`completed`, `not_planned`, `reopened`, `duplicate`, …); `null`, wenn nicht gesetzt |
| `milestone` | string | equals, not_equals, contains, in | | | Titel des Milestones; `null` ohne Milestone |
| `issue_type` | string | equals, not_equals, contains, in | | | Name des Issue-Typs (`type.name`, z. B. `Bug`, `Feature`, `Task`; nur bei Organisationen mit Issue-Typen); `null` ohne Typ |
| `project.<Name>` | je Art (§4.7.1) | je Typ (§4.2) | | | Feld des in `sources.yaml` konfigurierten GitHub-Projekts; nur deklarierte Namen |
| `dependencies.blocked_by_total` | number | equals, not_equals, in, greater_than, less_than | | ja | Anzahl blockierender Issues (native „blocked by“, inkl. Cross-Repo) |
| `dependencies.blocked_by_open` | number | equals, not_equals, in, greater_than, less_than | | ja | davon offen; unknown ohne Zugriff |
| `dependencies.blocked` | boolean | equals, not_equals | | ja | mindestens ein Blocker offen; unknown ohne Zugriff |
| `dependencies.status` | string | equals, not_equals, contains, in | | ja | `ok` = vollständig aufgelöst, sonst `unknown` (dieses Feld selbst ist dann bekannt) |
| `linked_branches` | string[] | contains, in | | ja | unter „Development“ verlinkte Branches im selben Repository (§4.7.2); PRs: `[]` |
| `closing_prs` | object[] | – (nicht in Filtern) | | ja | PRs des Repositorys, die das Issue schließen: `{ number, state, head_ref, is_draft, url }` (§4.7.2); PRs: `[]` |
| `work_branch` | string | equals, not_equals, contains, in | | ja | abgeleiteter Arbeits-Branch (§4.7.2); `null`, wenn keiner |
| `work_pr` | number | equals, not_equals, in, greater_than, less_than | | ja | Nummer des ersten offenen schließenden PRs (Link → `work_pr_url`); `null`, wenn keiner |
| `work_pr_url` | string | equals, not_equals, contains, in | | ja | URL des `work_pr`-PRs; `null`, wenn keiner (Link-Ziel von `work_pr` in Views) |

Abhängigkeiten sind unknown, wenn die API-Zusammenfassung fehlt, ein Blocker einen unerwarteten Status hat oder die
Identity weniger Blocker sieht, als GitHub meldet. „Offen ⇒ kein Start“ gilt nur, wenn der Filter das ausdrücklich
verlangt (z. B. `dependencies.blocked_by_open equals 0`).

#### 4.7.1 Projektfelder `project.<Name>`

Verfügbar je Source, die `project` deklariert (§3.2). Typ je Art:

| Art (`project.fields`) | Feldtyp | Wert | GitHub-`dataType` |
|---|---|---|---|
| `single_select` | string | Name der gewählten Option | `SINGLE_SELECT` |
| `text` | string | Text | `TEXT` |
| `iteration` | string | Titel der Iteration (z. B. `Sprint 7`) | `ITERATION` |
| `number` | number | Zahl | `NUMBER` |
| `date` | date | Datum `YYYY-MM-DD` | `DATE` |

„A **oder** B“: `{ field: project.Status, operator: in, value: [Todo, Ready] }` oder ein `any`. Werte vergleichen
mit Groß-/Kleinschreibung, so wie sie im Projekt heißen.

Bekannt **leer** (`null`) ist ein Feld, wenn das Item im Projekt ist, das Feld aber keinen Wert hat, **oder** wenn
das Item gar nicht im Projekt ist (und höchstens 20 Projekt-Mitgliedschaften hat). `equals null` trifft dann zu,
`in [...]` ist `false`.

**unknown** (fail closed, Grund in Dry-Run und Diagnose) sind:

| Situation | betroffene Felder | Log |
|---|---|---|
| Projekt nicht gefunden, kein Zugriff (z. B. fehlende App-Berechtigung, User-Projekt mit App-Token), GraphQL-/HTTP-Fehler bei den Metadaten | alle `project.*` der Source | Warnung nur bei Änderung des Grundes |
| Rate-Limit (Metadaten oder Werte) | alle `project.*` der Source bis zum Reset, ohne GitHub-Aufruf | Warnung je Rate-Limit |
| GraphQL-Fehler **unterhalb** eines Items (`errors[].path` beginnt mit `["nodes", i]`, z. B. an einem Feldwert) oder eine nicht lesbare (`null`) Projekt-Mitgliedschaft ohne Treffer | alle `project.*` dieses Items | – |
| deklariertes Feld fehlt im Projekt oder hat einen anderen `dataType` als die Art verlangt | genau dieses Feld | Warnung nur bei Änderung des Grundes |
| Werte-Abfrage scheitert (HTTP, GraphQL ohne verwertbare Daten, Rate-Limit); folgende Blöcke werden dann nicht mehr abgefragt | alle `project.*` der betroffenen Items | Warnung nur bei Änderung des Grundes |
| Item für die Projekt-Identity nicht lesbar | alle `project.*` dieses Items | – |
| Item gehört zu mehr als 20 Projekten und das konfigurierte ist nicht unter den gelesenen | alle `project.*` dieses Items | – |

Das Listing selbst scheitert wegen des Projekts **nie**; die übrigen Felder bleiben bekannt. Archivierte
Projekt-Items zählen als „nicht im Projekt“. Vor `on_start` liest der Run-Controller das Item frisch (inkl.
Projektwerten; Projekt-Metadaten dürfen dafür bis zu 5 Minuten alt sein) und prüft den billigen Filterteil erneut.
Ist er dabei `unknown`, weil ein `project.*`-Feld nicht ermittelt werden konnte, wird der Run **abgebrochen** (wie
bei `false`, fail closed).

#### 4.7.2 Verknüpfte Branches und PRs

Der Arbeits-Branch eines Issues bzw. der PR, der es schließt – ohne eigene GraphQL-Abfragen im Worker. Alle fünf
Felder sind **teuer** (nur geladen, wenn verwendet) und kommen aus **einer** GraphQL-Abfrage pro Item:
`repository(owner, name) { issueOrPullRequest(number) { … } }` mit `owner`, `name`, `number` ausschließlich als
Variablen; Identity = Source-Identity (braucht Lesezugriff auf Issues, Pull Requests und Inhalte bzw. Branches).

| Feld | Issue | Pull Request |
|---|---|---|
| `linked_branches` | Namen der Branches aus `linkedBranches(first: 20)`, nur Branches **dieses** Repositorys; gelöschte Branches (Link ohne `ref`) fehlen | `[]` |
| `closing_prs` | PRs aus `closedByPullRequestsReferences(first: 20, includeClosedPrs: true)`, nur PRs **dieses** Repositorys; je PR `{ number, state, head_ref, is_draft, url }` mit `state` = `open`/`merged`/`closed`; sortiert: offene, dann gemergte, dann geschlossene, je nach Nummer aufsteigend | `[]` |
| `work_branch` | erster verlinkter Branch, sonst `head_ref` des ersten offenen, dann des ersten gemergten PRs aus `closing_prs` (PRs aus Forks zählen dafür nicht – ihr Branch liegt nicht im Repository); sonst `null` | eigener `head_ref`; bei PRs aus einem Fork (`isCrossRepository`) `null` |
| `work_pr` | Nummer des ersten offenen PRs aus `closing_prs` (auch aus einem Fork); sonst `null` | eigene Nummer, solange offen; sonst `null` |
| `work_pr_url` | URL dieses PRs; sonst `null` | eigene URL, solange offen; sonst `null` |

Verlauf eines Issues: verlinkter Branch `feature/12` → `work_branch: feature/12`, `work_pr: null`; PR mit
„Closes #12“ geöffnet → `work_branch` bleibt `feature/12`, `work_pr` = Nummer des PRs; nach dem Merge (und Löschen
des Branches) → `work_pr: null`, `work_branch` = `head_ref` des gemergten PRs.

**unknown** (fail closed, alle fünf Felder zugleich, Grund in Dry-Run/Diagnose): HTTP-/GraphQL-Fehler,
**Teilfehler** (jeder Eintrag in `errors[]`, z. B. `FORBIDDEN` an `closedByPullRequestsReferences`), Repository oder
Item nicht gefunden, unerwartete Antwortform, mehr als 20 verlinkte Branches bzw. schließende PRs (mehr Treffer als
gelesen), Rate-Limit. Nach einem Rate-Limit liefert die Source bis zum Reset ohne GitHub-Aufruf unknown (wie bei
`project.*`, §4.7.1); Wartezeit eines Retries höchstens 5 s. Warnung im Log nur bei Änderung des Grundes.

Verwendung:

- **Filter:** z. B. „hat einen offenen PR“ `{ field: work_pr, operator: not_equals, value: null }`, „Branch-Präfix“
  `{ field: work_branch, operator: contains, value: feature/ }`. `closing_prs` ist nicht filterbar (Typ `object[]`).
- **Platzhalter** `{item.work_branch}`, `{item.work_pr}` in `execute` und Actions (§5.3).
- **Views:** als Spalten; `work_pr` verlinkt auf den PR, `closing_prs` zeigt `#12 open, #9 merged` mit Link je PR.
- **Kontextdatei des Workers:** „wenn verwendet“ – siehe §5.3.

### 4.8 Run-Felder für Views

Pro Item der **zuletzt erzeugte** Run (über alle Workflows, globaler Item-Schlüssel). Ohne Run: alle `null`
(bekannt leer, also z. B. `run.last_status equals null` = „noch nie bearbeitet“).

Operatoren je Typ wie in §4.2 (`string`: equals, not_equals, contains, in; `date`: equals, not_equals,
greater_than, less_than – als Zeitpunkt verglichen).

| Feld | Typ | Bedeutung |
|---|---|---|
| `run.last_id` | string | Run-ID |
| `run.last_workflow` | string | Workflow-ID |
| `run.last_status` | string | technischer Status (`running`, `completed`, `crashed`, …) |
| `run.last_result` | string | fachliches Ergebnis `success`/`failure` (sonst `null`) |
| `run.last_result.message` | string | `message` der Ergebnisdatei |
| `run.last_status_message` | string | letzte Status-Meldung des Workers (`@@ADISPATCH_EVENT` `status`) |
| `run.last_started_at` | date | Start |
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
| `{item.work_branch}` | Feld `work_branch` (§4.7.2), direkt vor dem Rendern frisch gelesen | `null` (kein Branch) → leer; **unknown → kein Rendern** (§5.3) |
| `{item.work_pr}` | Feld `work_pr` (§4.7.2), direkt vor dem Rendern frisch gelesen | `null` (kein offener PR) → leer; **unknown → kein Rendern** (§5.3) |
| `{result.status}` | technischer Endstatus (`completed`, `crashed`, `start_error`, `timed_out`, `cancelled`) | – |
| `{result.result}` | `success` \| `failure` | bei technischem Fehler/Cancel |
| `{result.message}` | `message` der Ergebnisdatei | keine/ungültige Ergebnisdatei oder ohne `message` |
| `{parameters.<name>}` | Parameterwert (`true`, `5`, Text) | optionaler Parameter ohne Wert und ohne Default |

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
| `item.work_branch`, `item.work_pr` | ✓ (s, GitHub; `null` → Fehler) | ✓ (s, GitHub) | ✓ (s, GitHub) | ✓ (s, GitHub) | – | – |

Nicht als Template ausgewertet (Platzhalter bleiben wörtlich stehen): alle `command`, `source.update.labels`,
`source.update.project`, `shell_filter`, Filterwerte, `secrets`, alle anderen Felder.

`{item.work_branch}`/`{item.work_pr}` außerhalb dieser Stellen (z. B. in `conditions.item[].args`) oder in
Workflows ohne GitHub-Source-Trigger: `Placeholder "{item.work_branch}" is only available in "execute" and lifecycle
actions of workflows triggered by a GitHub source`.

### 5.3 Teure Platzhalter `{item.work_branch}`, `{item.work_pr}`

Die Werte stammen aus den teuren Feldern `work_branch`/`work_pr` (§4.7.2) und werden **direkt vor dem Rendern frisch**
gelesen (eine GraphQL-Abfrage), nie aus der Planung übernommen:

- **Run-Start:** nach dem frischen Lesen des Items und vor `on_start` (§6.5 Schritt 2), wenn `execute`
  (`working_directory`, `args`, `env`) einen der Platzhalter verwendet. Ist ein verwendeter Wert unknown, endet der
  Run als **`start_error` ohne Hooks** (`on_start` lief nie, am Item wurde nichts geändert; zählt als technischer
  Fehler) mit Grund `{item.work_pr} is unknown: …` (Fehlercode `run_linked_field_unknown`). Ein bekannt leerer Wert
  (`null`) ergibt in `args`/`env` einen leeren String; im `working_directory` (Modus `path`) ebenfalls einen
  **`start_error` ohne Hooks** vor `on_start` (`{item.work_branch} is empty (null) and cannot be used in
  working_directory`, Fehlercode `run_linked_field_empty`).
- **Keine doppelte Abfrage:** stehen die Felder im `filter`/`item_priority`, liest der Planungsschritt alle fünf in
  einer Abfrage, und der unmittelbar folgende Start übernimmt sie, wenn alle bekannt sind (Event
  `run.linked_resolved` mit `reused: true`); sonst liest der Start frisch. Manuelle Starts lesen immer frisch.
- **Actions** (`source.comment.message`, `shell` `args`/`env`, in jedem Hook): bei **jedem Versuch** frisch gelesen –
  z. B. sieht `on_success` den PR, den der Worker gerade geöffnet hat. Unknown → der Versuch scheitert mit
  `lifecycle_linked_field_unknown` (wiederholbar nach `lifecycle.action_retry`); es wird nichts gepostet.
- **Kontextdatei des Workers** (`source.attributes`, Entscheidung „wenn verwendet“): die bekannten Werte aller fünf
  Felder (`linked_branches`, `closing_prs`, `work_branch`, `work_pr`, `work_pr_url`) stehen darin, wenn der Workflow
  sie verwendet – Platzhalter in `execute` **oder** eines der Felder in `filter`/`item_priority`. Sonst fragt der
  Start GitHub nicht danach (keine Kosten). Wer nur `closing_prs` im Worker braucht, verwendet z. B.
  `env: { WORK_PR: '{item.work_pr}' }`. Unknown-Werte fehlen in `attributes` (nur bei verwendetem Platzhalter
  bricht der Start ab). Kontexte von `shell`-Actions enthalten die Felder, wenn die Action einen der Platzhalter
  verwendet.
- Das Run-Event `run.linked_resolved` (`{ known: [...], unknown: [...] }`) zeigt in der Run-Ansicht, welche Felder
  beim Start gelesen wurden.

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
   (unknown startet trotzdem). Source fehlt oder Lesefehler → `start_error` **ohne** Hooks (gezählt). Verwendet der
   Workflow `work_branch`/`work_pr` & Co. (§5.3), werden sie jetzt frisch gelesen; ein in `execute` verwendeter,
   aber unknown Platzhalter → `start_error` **ohne** Hooks (gezählt).
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
- **Idempotenz:** `source.update` liest vor dem Schreiben neu und ändert nur, was fehlt (Labels und
  Projektfelder; ein fehlendes Projekt-Item wird hinzugefügt, GitHub liefert dabei ein vorhandenes zurück). `source.comment` hängt als
  letzte Zeile `<!-- adispatchd:<run-id>:<journal-action-id> -->` an; vor jeder Wiederholung (und nach Neustart) wird ein
  Kommentar mit diesem Marker gesucht, der von der eigenen App stammt → kein Duplikat. `<!--` im gerenderten Text
  wird zu `&lt;!--`.
- **Neustart:** unterbrochene `source.*`-Actions werden fortgesetzt; eine unterbrochene `shell`-Action wird
  `failed` und nie automatisch wiederholt (manueller Retry). Eine unterbrochene `on_start`-Kette wird verworfen.

### 6.10 Identitäten je Zugriff

| Zugriff | Identity |
|---|---|
| Pollen, Item lesen, Dependencies auflösen, Item-Re-Read vor `on_start` | `sources.<id>.identity` |
| Projektfelder lesen (`project.*`, GraphQL) | `sources.<id>.project.identity` → `sources.<id>.identity` |
| `source.update` (inkl. Re-Read vor dem Schreiben) | Workflow-`identity` → Source-`identity` |
| `source.update` → `project` (Metadaten, Item lesen, Mutationen) | `sources.<id>.project.identity`, **wenn ausdrücklich gesetzt** → Workflow-`identity` → Source-`identity` |
| `source.comment` (inkl. Marker-Suche) | Action-`identity` → Workflow-`identity` → Source-`identity` |
| `execute.secrets.<NAME>` | die angegebene Identity (Installation-Token, ca. 1 h gültig, beim Start geholt; bei `github_token` der Token selbst) |
| `shell`-Actions, Conditions, `shell_filter` | keine (keine Secrets) |

### 6.11 Umgebung von Worker, Actions und Prüfskripten

| | Haupt-Worker | `shell`-Action | Conditions / `shell_filter` |
|---|---|---|---|
| Basis | `PATH`, `HOME`, `LANG`, `TZ`, `USER`, `LOGNAME`, `TMPDIR` aus der Controller-Umgebung (PATH-Fallback `/usr/local/bin:/usr/bin:/bin`) | wie Worker | dieselben Variablen (ohne PATH-Fallback) |
| Konfiguriert | `execute.env`, dann `execute.secrets` | Action-`env` | – |
| Orchestrator | `ADISPATCH_RUN_ID`, `ADISPATCH_WORKFLOW_ID`, `ADISPATCH_CONTEXT_FILE`, `ADISPATCH_RESULT_FILE`, `ADISPATCH_WORKSPACE`; bei Item zusätzlich `ADISPATCH_SOURCE_TYPE`, `ADISPATCH_SOURCE_ID`, `ADISPATCH_SOURCE_ITEM_ID`, `ADISPATCH_SOURCE_URL` | dieselben (`ADISPATCH_WORKSPACE` = Arbeitsverzeichnis der Action; Kontext `kind: lifecycle_action` mit Hook, Action, `result`) | `ADISPATCH_CHECK_CONTEXT_FILE` (JSON: `kind`, `workflow.id`, bei Item `source{id,type,item_id,item_key,url,item_type,created_at,attributes}`) |
| Arbeitsverzeichnis | Workspace | Workspace, falls vorhanden, sonst Versuchsverzeichnis | temporäres Verzeichnis |

Vorrang (spätere gewinnen): Basis < `env` < `secrets` < `ADISPATCH_*`. Die übrige Controller-Umgebung wird **nie**
vererbt. Details zu Kontextdatei, Ergebnisdatei, Events und Cancel: [worker-protocol.md](worker-protocol.md).

### 6.12 Workspace-Cleanup

Nach dem Abschluss-Hook: `always` = immer, `on_success` = nur `completed`+`success`, `never` = nie. Gelöscht wird nur
ein Workspace strikt unter `workspace.base_dir` (auch nach Auflösen von Symlinks; ein Workspace, der selbst ein
Symlink ist, wird nie gelöscht). Später entfernt die Retention auch verbliebene Workspaces gelöschter Runs.

### 6.13 Dry-Run

`adispatch workflow dry-run <id>` (gegen die laufende Instanz, sonst mit `--config-dir` lokal) bzw.
`POST /api/v1/workflows/:id/dry-run`: Source-Abfrage, Filter-Trace pro Regel (inkl. Dependencies), Prioritäten,
Locks/Blocks, Kapazität (in Prioritätsreihenfolge simuliert), je Kandidat die Werte bzw. Unknown-Gründe aller
`project.*`-Felder (`projectFields`), die Werte der im Filter verwendeten teuren Felder (z. B.
`work_pr not_equals null: true (actual 12)`) im Filter-Trace, je Kandidat die verknüpften Branches/PRs
(`linkedFields`, Textausgabe `linked fields:`), wenn der Workflow sie irgendwo verwendet (Filter, `item_priority`,
`execute`, Actions; nicht für Items, die schon der billige Filterteil verwirft), den ausgewerteten Filter mit eingesetzten benannten Filtern (`source.filter`,
Textausgabe `filter:`). Reserviert nichts, startet keine Worker oder Actions
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

Der Coder aus `init` und `examples/config` schließt zusätzlich den benannten Filter `needs-maintainer` aus
(`- not: { use: needs-maintainer }`, §3.6). Wer ein Item dort an den Coder zurückgibt, muss daher neben dem Setzen
von `ready-for-coding` auch `needs-maintainer` entfernen – sonst startet es stillschweigend nie (der Dry-Run zeigt
die Regel als `false`).

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

Start: `curl -X POST -H 'X-Adispatch-Request: 1' -H 'Content-Type: application/json'
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

Umgebung (z. B. `/etc/default/adispatchd`): `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…`,
`OPS_WEBHOOK_AUTH=Bearer …`. Danach **Neustart** (Env-Änderung) bzw. `config reload` (nur YAML-Änderung).

### 7.7 Filter auf Projektstatus und Priorität

`project_a` liest das Board der Organisation per App (Berechtigung **Organization → Projects: Read and write**,
weil der Coder den Status setzt), `project_b` ein **user-eigenes** Board über eine `github_token`-Identity, das
Repository selbst weiter per App. Der Coder startet Items, deren Projektstatus `Todo` **oder** `Ready` ist;
`P0`/`P1` kommen zuerst. Beim Start setzt er den Status auf `In Progress`, nach Erfolg auf `Review`, bei Abbruch
oder Absturz zurück auf `Ready` (sonst passt das Item nicht mehr zum Filter und bliebe liegen).

```yaml
# example: projects
# extends: github
# file: identities.yaml
identities:
  maintainer: { type: github_app, app_id: 100001, installation_id: 200001, private_key_env: GITHUB_MAINTAINER_PRIVATE_KEY }
  coder:      { type: github_app, app_id: 100002, installation_id: 200002, private_key_env: GITHUB_CODER_PRIVATE_KEY }
  reviewer:   { type: github_app, app_id: 100003, installation_id: 200003, private_key_env: GITHUB_REVIEWER_PRIVATE_KEY }
  project_reader: { type: github_token, token_env: GITHUB_PROJECT_TOKEN }
```

```yaml
# example: projects
# file: sources.yaml
sources:
  project_a:
    type: github
    owner: example
    repository: project-a
    identity: maintainer
    project:
      number: 3                        # https://github.com/orgs/example/projects/3
      fields: { Status: single_select, Priority: single_select, Estimate: number, Sprint: iteration }
  project_b:
    type: github
    owner: example
    repository: project-b
    identity: maintainer
    project:
      owner: alice                     # https://github.com/users/alice/projects/1
      number: 1
      identity: project_reader         # App-Tokens können User-Projekte nicht lesen
      fields: { Status: single_select, Priority: single_select }
```

```yaml
# example: projects
# file: workflows/board-coder.yaml
id: board-coder
name: Coder – Board
identity: coder
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: project.Status, operator: in, value: [Todo, Ready] }
    - { field: issue_type, operator: not_equals, value: Epic }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
item_priority:
  rules:
    - when: { field: project.Priority, operator: in, value: [P0, P1] }
      value: 100
    - when: { field: project.Estimate, operator: less_than, value: 3 }
      value: 10
  default: 0
execute:
  type: shell
  command: scripts/coder.sh
  args: ['{item.url}']
on_start:
  - type: source.update
    labels: { add: [coding] }
    project: { Status: In Progress }
on_success:
  - type: source.update
    labels: { remove: [coding] }
    project: { Status: Review }
on_crash:       [ { type: source.update, labels: { remove: [coding] }, project: { Status: Ready } } ]
on_start_error: [ { type: source.update, labels: { remove: [coding] }, project: { Status: Ready } } ]
on_timeout:     [ { type: source.update, labels: { remove: [coding] }, project: { Status: Ready } } ]
on_cancel:      [ { type: source.update, labels: { remove: [coding] }, project: { Status: Ready } } ]
```

```yaml
# example: projects
# file: views/board.yaml
id: board
title: Board
sources: [project_a, project_b]        # beide deklarieren Status und Priority als single_select
filter: { field: project.Status, operator: not_equals, value: Done }
fields:
  - { field: title, link: url }
  - { field: repository }
  - { field: project.Status, label: Status }
  - { field: project.Priority, label: Priorität }
  - { field: milestone }
sort: { field: project.Priority }
```

Umgebung: `GITHUB_PROJECT_TOKEN=ghp_…` (klassischer Token von `alice` mit `read:project`, bei privatem
`project-b` zusätzlich `repo`; fine-grained Tokens für User-Projekte sind unverifiziert, §3.2) in der Env-Datei,
danach Neustart. `project.Sprint` gibt es nur in Workflows auf
`project_a`; in der View wäre es ein Fehler, weil `project_b` es nicht deklariert. Ohne Projektzugriff ist der
Filter `unknown` (kein Start) und der Dry-Run nennt den Grund.

### 7.8 Benannte Filter teilen

„Bereit fürs Coding“ wird einmal definiert. Die View zeigt alle Items beider Sources, die bereit fürs Coding sind;
der Backend-Coder nimmt davon nur Backend-Items aus `project_a` und zieht dringende (benannter Filter `urgent`)
in der Item-Priorität vor.

```yaml
# example: named-filters
# extends: github
# file: filters/ready-for-coding.yaml
id: ready-for-coding
description: Offene Issues mit Label ready-for-coding, ohne offene Blocker
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: is_pull_request, operator: equals, value: false }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
```

```yaml
# example: named-filters
# file: filters/urgent.yaml
id: urgent
filter: { field: labels, operator: in, value: ['priority:high', 'priority:critical'] }
```

```yaml
# example: named-filters
# file: workflows/coder-backend.yaml
id: coder-backend
identity: coder
trigger: { type: source, source: project_a }
filter:
  all:
    - { use: ready-for-coding }        # oberste Ebene: labels contains → Pushdown wie direkt geschrieben
    - { field: labels, operator: contains, value: backend }
item_priority:
  rules:
    - when: urgent                     # Kurzform auch in item_priority
      value: 100
execute:
  type: shell
  command: scripts/coder.sh
  args: ['{item.url}']
```

```yaml
# example: named-filters
# file: views/ready.yaml
id: ready
title: Bereit fürs Coding
sources: [project_a, project_b]
filter: ready-for-coding               # Kurzform
fields:
  - { field: title, link: url }
  - { field: repository }
  - { field: labels }
sort: { field: updated_at }
```

Der geladene Workflow enthält den eingesetzten Baum
`all: [ { all: [labels…, is_pull_request…, dependencies…] }, labels contains backend ]`; der Pushdown flacht ihn
zu `labels=ready-for-coding,backend` ab. Eine Änderung an `filters/ready-for-coding.yaml` wirkt nach
`config reload` auf Coder und View zugleich.

### 7.9 Review auf dem Arbeits-Branch (verknüpfte PRs)

Der Reviewer nimmt Issues mit Label `ready-for-review`, die einen offenen PR haben, und bekommt Branch und PR-Nummer
direkt als Argumente – ohne eigene GraphQL-Abfrage im Worker. Die View zeigt den Arbeitsstand aller Items (§4.7.2).

```yaml
# example: linked
# extends: github
# file: workflows/pr-reviewer.yaml
id: pr-reviewer
identity: reviewer
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-review }
    - { field: work_pr, operator: not_equals, value: null }    # teuer: nur für Items mit dem Label gelesen
execute:
  type: shell
  command: scripts/review-pr.sh
  args: ['--branch', '{item.work_branch}', '--pr', '{item.work_pr}']
on_start:
  - { type: source.update, labels: { add: [reviewing], remove: [ready-for-review] } }
on_success:
  - { type: source.comment, message: 'Review von PR #{item.work_pr} abgeschlossen: {result.message}' }
  - { type: source.update, labels: { remove: [reviewing] } }
on_failure:     [ { type: source.update, labels: { add: [needs-maintainer], remove: [reviewing] } } ]
on_crash:       [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
on_start_error: [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
on_timeout:     [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
on_cancel:      [ { type: source.update, labels: { add: [ready-for-review], remove: [reviewing] } } ]
```

```yaml
# example: linked
# file: views/work-in-progress.yaml
id: work-in-progress
title: Arbeitsstand
sources: [project_a, project_b]
filter: { field: is_pull_request, operator: equals, value: false }
fields:
  - { field: title, link: url }
  - { field: work_branch, label: Branch }
  - { field: work_pr, label: PR }                 # Link automatisch auf den PR (work_pr_url)
  - { field: closing_prs, label: Schließende PRs } # "#12 open, #9 merged", Link je PR
sort: { field: work_pr, direction: desc }
```

Kann GitHub die verknüpften PRs eines Items nicht liefern (z. B. Rate-Limit), ist der Filter `unknown` (kein Start)
und der Dry-Run nennt den Grund. Wird das Item trotzdem gestartet (z. B. manuell) und ist `work_branch` dann unknown,
endet der Run als `start_error`, bevor `on_start` das Label ändert. Der Kommentar in `on_success` liest `work_pr`
erneut – er nennt also auch einen PR, den der Worker erst während des Runs geöffnet hat.

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
# expect: workflows/coder.yaml: filter.all[3].value: Operator "contains" requires a scalar value (string, number, boolean or null)
# expect: workflows/coder.yaml: filter.all[4].value: Operator "equals" requires a scalar value (string, number, boolean or null)
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: state, operator: in, value: open }
    - { field: labels, operator: has, value: ready }
    - { field: author, operator: equals }
    - { field: labels, operator: contains, value: [a, b] }     # Liste nur mit "in"
    - { field: author, operator: equals, value: [alice, bob] }
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
# expect: workflows/coder.yaml: execute.env.ADISPATCH_MODE: Environment variables with prefix "ADISPATCH_" are reserved
# expect: workflows/coder.yaml: execute.secrets.GH_TOKEN: "GH_TOKEN" is defined both in "env" and "secrets"
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
execute:
  type: shell
  command: scripts/coder.sh
  env: { ADISPATCH_MODE: fast, GH_TOKEN: '' }
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
# expect: workflows/coder.yaml: on_success[0].labels: "source.update" must add or remove at least one label or set a project field
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

**Unbekannte Felder, unpassende Operatoren und Werttypen** – Prüfung gegen den Feldkatalog (§4.7, §4.8).

```yaml
# example: err-fields
# extends: github
# invalid
# expect: workflows/coder.yaml: filter.all[0].field: Unknown field "labls" for source type github (did you mean "labels"?)
# expect: workflows/coder.yaml: filter.all[1].operator: Operator "greater_than" is not supported for field "labels" (type string[]); allowed: contains, in
# expect: workflows/coder.yaml: filter.all[2].value: Value for field "is_pull_request" (type boolean) must be a boolean, got string "false"
# expect: workflows/coder.yaml: filter.all[3].value: Value "last week" for date field "updated_at" is not an ISO-8601 date
# expect: workflows/coder.yaml: filter.all[4].field: Field "run.last_status" is only available in views, not in workflows
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: labls, operator: contains, value: ready-for-coding }
    - { field: labels, operator: greater_than, value: 2 }
    - { field: is_pull_request, operator: equals, value: 'false' }
    - { field: updated_at, operator: greater_than, value: last week }
    - { field: run.last_status, operator: equals, value: completed }
execute: { type: shell, command: scripts/coder.sh }
```

Lösung: Feldnamen aus §4.7 (Views zusätzlich §4.8), Operatoren laut §4.2, Booleans unquotiert, Datumswerte ISO.
In Views werden auch `fields[].field`, `fields[].link` und `sort.field` so geprüft.

**Projektfelder** – nur deklarierte `project.*`-Felder, in Views nur die gemeinsamen.

```yaml
# example: err-project
# extends: projects
# invalid
# expect: workflows/board-coder.yaml: filter.all[0].field: Unknown project field "project.Statsu": it is not declared in "project.fields" of source "project_a" (did you mean "project.Status"?)
# expect: workflows/board-coder.yaml: filter.all[1].value: Value for field "project.Estimate" (type number) must be a number, got string "3"
# expect: views/board.yaml: sort.field: Unknown project field "project.Sprint": views only offer project fields declared by all their sources (missing in "project_b")
# expect: sources.yaml: sources.project_b.project.identity: Unknown identity "project-reader"
# file: workflows/board-coder.yaml
id: board-coder
trigger: { type: source, source: project_a }
filter:
  all:
    - { field: project.Statsu, operator: in, value: [Todo, Ready] }
    - { field: project.Estimate, operator: less_than, value: '3' }
execute: { type: shell, command: scripts/coder.sh }
```

```yaml
# example: err-project
# file: views/board.yaml
id: board
sources: [project_a, project_b]
fields: [ { field: title } ]
sort: { field: project.Sprint }
```

```yaml
# example: err-project
# file: sources.yaml
sources:
  project_a:
    type: github
    owner: example
    repository: project-a
    identity: maintainer
    project:
      number: 3
      fields: { Status: single_select, Estimate: number, Sprint: iteration }
  project_b:
    type: github
    owner: example
    repository: project-b
    identity: maintainer
    project: { owner: alice, number: 1, identity: project-reader, fields: { Status: single_select } }
```

Lösung: Feldnamen genau wie unter `project.fields` (Tippfehler zeigt „did you mean“), Werttyp passend zur Art
(`number` unquotiert), in Views nur Felder, die alle Sources mit gleicher Art deklarieren, `project.identity` muss
existieren. Ohne `project` an der Source meldet jedes `project.*` `source "…" has no "project" configured in
sources.yaml`. Weitere Meldungen in `sources.yaml`: `Expected one of: single_select, text, number, date, iteration`
(unbekannte Art), `Declare at least one project field`, `Project field name must not start or end with
whitespace`, `Project field name must not contain control characters`; in Views zusätzlich `its kind differs
between the sources of the view`.

**Projektfelder setzen** – `source.update` → `project` nur mit deklarierten Feldern und passendem Werttyp.

```yaml
# example: err-project-update
# extends: projects
# invalid
# expect: workflows/board-coder.yaml: on_start[0].project.Statsu: Unknown project field "Statsu": it is not declared in "project.fields" of source "project_a" (did you mean "Status"?)
# expect: workflows/board-coder.yaml: on_start[0].project.Estimate: Invalid value for project field "Estimate" (number): expected a number or null
# expect: workflows/board-coder.yaml: on_success[0].project: "project" must set at least one field
# expect: workflows/review.yaml: on_success[0].project: Source "project_c" has no "project" in sources.yaml; project fields cannot be set
# file: workflows/board-coder.yaml
id: board-coder
trigger: { type: source, source: project_a }
execute: { type: shell, command: scripts/coder.sh }
on_start:
  - type: source.update
    project: { Statsu: In Progress, Estimate: three }
on_success:
  - type: source.update
    project: {}
```

```yaml
# example: err-project-update
# file: workflows/review.yaml
id: review
trigger: { type: source, source: project_c }
execute: { type: shell, command: scripts/coder.sh }
on_success:
  - type: source.update
    project: { Status: Done }
```

```yaml
# example: err-project-update
# file: sources.yaml
sources:
  project_a:
    type: github
    owner: example
    repository: project-a
    identity: maintainer
    project:
      number: 3
      fields: { Status: single_select, Priority: single_select, Estimate: number }
  project_b:
    type: github
    owner: example
    repository: project-b
    identity: maintainer
    project: { owner: alice, number: 1, identity: project_reader, fields: { Status: single_select, Priority: single_select } }
  project_c: { type: github, owner: example, repository: project-c, identity: maintainer }
```

Lösung: Schlüssel genau wie unter `project.fields` (ohne `project.`-Präfix), Wert passend zur Art (§3.4.11), `null`
zum Leeren; die Trigger-Source braucht `project`. Weitere Meldungen: `expected a date YYYY-MM-DD or null`, `expected
a string or null`, `empty value; use null to clear the field`, `Expected a string, a number, a date or null`
(Boolean, Liste), `"source.update" must add or remove at least one label or set a project field`. Erst **zur
Laufzeit** fallen auf (Action `failed`, nicht wiederholbar): unbekannte/mehrdeutige Option oder Iteration, Feld fehlt
im Projekt oder hat eine andere Art, fehlendes Schreibrecht – siehe Fehlertext in der Run-Ansicht (*Actions*).

**Verknüpfte PRs falsch verwendet** – `closing_prs` ist eine Liste von Objekten (`object[]`) ohne Operatoren;
`{item.work_branch}`/`{item.work_pr}` gibt es nur in `execute` und Actions.

```yaml
# example: err-linked
# extends: github
# invalid
# expect: workflows/review.yaml: filter.any[0].field: Field "closing_prs" (type object[]) cannot be used in filters; use "work_pr" (e.g. { field: work_pr, operator: not_equals, value: null }) or "work_branch" instead
# expect: workflows/review.yaml: conditions.item[0].args[0]: Placeholder "{item.work_branch}" is only available in "execute" and lifecycle actions of workflows triggered by a GitHub source
# expect: views/prs.yaml: sort.field: Views cannot be sorted by "closing_prs" (type object[])
# file: workflows/review.yaml
id: review
trigger: { type: source, source: project_a }
filter:
  any:
    - { field: closing_prs, operator: contains, value: 12 }
conditions:
  item:
    - { type: shell, command: scripts/branch-exists.sh, args: ['{item.work_branch}'] }
execute: { type: shell, command: scripts/review.sh }
```

```yaml
# example: err-linked
# file: views/prs.yaml
id: prs
sources: [project_a]
fields:
  - { field: closing_prs }
sort: { field: closing_prs }
```

Lösung: im Filter `work_pr` (offener PR vorhanden?) oder `work_branch` verwenden; eine Prüfung des Branches in den
Worker verlegen (Prüfskripte bekommen die Felder nicht); Views nach `work_pr` sortieren. Erst **zur Laufzeit** fallen auf:
unknown Werte (fehlende Rechte, Rate-Limit) → `start_error` bzw. Action `failed` (§5.3).

**`state` an wirkungsloser Stelle** – die Source liest ohne `state`-Selektor auf oberster Ebene nur offene Items.

```yaml
# example: err-state
# extends: github
# invalid
# expect: workflows/coder.yaml: filter.any[0].field: "state" only works at the top level of the filter (directly or inside top-level "all"): the source lists only open issues/PRs unless the top-level filter selects others (state equals/in open|closed), so under "any"/"not" it would silently never see them
# expect: views/needs-maintainer.yaml: filter.all[0].operator: "state" must use "equals" or "in": only these select which items are listed (otherwise only open issues/PRs are seen)
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
filter:
  any:
    - { field: state, operator: equals, value: closed }
    - { field: labels, operator: contains, value: reopen }
execute: { type: shell, command: scripts/coder.sh }
```

```yaml
# example: err-state
# file: views/needs-maintainer.yaml
id: needs-maintainer
sources: [project_a, project_b]
filter:
  all:
    - { field: state, operator: not_equals, value: open }
fields: [ { field: title } ]
```

Lösung: `state` als oberstes Prädikat, z. B. `all: [{ field: state, operator: in, value: [open, closed] }, { any: [...] }]`.

**Benannte Filter** – Feldfehler werden am Verwendungsort mit dem Pfad im benannten Filter gemeldet (§3.6),
Referenzfehler in der Datei, in der die Referenz steht.

```yaml
# example: err-named-filters
# extends: github
# invalid
# expect: workflows/backend.yaml: filter.all[0] (use "ready-for-coding" → filters/ready-for-coding.yaml: filter.all[1].field): Unknown field "labls" for source type github (did you mean "labels"?)
# expect: workflows/backend.yaml: filter.all[1]: Unknown named filter "closd" (did you mean "closed"?)
# expect: workflows/backend.yaml: filter.all[2].any[0] (use "closed" → filters/closed.yaml: filter.field): "state" only works at the top level of the filter
# expect: filters/loop.yaml: filter.not: Cycle in named filters: loop → loop
# expect: filters/extra.yaml: filter: "use" must be the only key of its filter node ({ use: <filter-id> } references a named filter)
# file: workflows/backend.yaml
id: backend
trigger: { type: source, source: project_a }
filter:
  all:
    - { use: ready-for-coding }
    - { use: closd }
    - any: [ { use: closed }, { field: labels, operator: contains, value: reopen } ]
execute: { type: shell, command: scripts/coder.sh }
```

```yaml
# example: err-named-filters
# file: filters/ready-for-coding.yaml
id: ready-for-coding
filter:
  all:
    - { field: is_pull_request, operator: equals, value: false }
    - { field: labls, operator: contains, value: ready-for-coding }
```

```yaml
# example: err-named-filters
# file: filters/closed.yaml
id: closed
filter: { field: state, operator: equals, value: closed }   # gültig nur als oberstes Prädikat (§4.5)
```

```yaml
# example: err-named-filters
# file: filters/loop.yaml
id: loop
filter: { not: { use: loop } }
```

```yaml
# example: err-named-filters
# file: filters/extra.yaml
id: extra
filter: { use: closed, field: labels }
```

Weitere Meldungen: `Named filter "x" is invalid (see filters/x.yaml)` (verwendeter Filter ist selbst fehlerhaft),
`Named filters are nested more than 16 levels deep: a → b → …`, `Expanded filter would exceed 10000 nodes ("x"
alone has …; named filters are copied at every place of use)` (zu viele Kopien, z. B. Auffächerung über mehrere
Ebenen, §3.7), `"use" requires the ID of a named filter` (`use` ohne gültige ID), `Filter node must be a mapping …;
to reference a named filter write { use: x }` (Kurzform `x` gibt es nur an der Wurzel),
`Duplicate filter ID "x" (already defined in filters/a.yaml)`.

**Null-Intervalle und -Timeouts**

```yaml
# example: err-zero-durations
# extends: minimal
# invalid
# expect: config.yaml: scheduler.polling_interval: Duration must be at least 1s
# expect: config.yaml: retention.cleanup_interval: Duration must be at least 1s
# file: config.yaml
scheduler:
  polling_interval: 0s
retention:
  cleanup_interval: 500ms
lifecycle:
  action_retry: { delay: 0s }      # erlaubt: sofort wiederholen
```

`timeout: 0s` bei Conditions, `shell_filter` oder `shell`-Actions meldet `Duration must be greater than 0`.

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

```yaml
# example: warn-common
# expect-warning: filters/old.yaml: id: Named filter "spare" is not used by any workflow or view
# expect-warning: filters/old.yaml: id: Filter ID "spare" differs from file name "old.yaml"
# file: filters/old.yaml
id: spare
filter: { field: labels, operator: contains, value: spare }
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
| `Expected a size such as 100MB` | Größe als Zahl statt String (`max_log_size_per_run: 100`) |
| `Invalid size "100" (expected e.g. 512KB, 100MB, 1GB)` | String ohne oder mit unbekannter Einheit (`'100'`, `'100MiBs'`) |
| `config.yaml not found, using defaults` (Warnung) | `config.yaml` fehlt |

Laufzeitfehler, die `config validate` **nicht** findet: fehlende Umgebungsvariablen (Keys, Tokens, Webhooks),
nicht existierende/nicht ausführbare Skripte, fehlende App-Rechte (→ Felder unknown bzw. Actions scheitern),
Projekt nicht gefunden bzw. deklariertes Projektfeld fehlt im Projekt oder hat eine andere Art (→ `project.*`
unknown, Warnung im Log). Dafür: `workflow dry-run` und die Run-Details.

---

## 9. Checkliste „neuen Workflow anlegen“

1. **Trigger wählen:** `source` (Items), `schedule` (Cron) oder `manual`.
2. **Voraussetzungen:** Source in `sources.yaml`, Identities in `identities.yaml`, Private Keys/Tokens als
   Umgebungsvariablen des Dienstes (Env-Datei, danach Neustart), App-Rechte prüfen. Für Projektfelder: `project`
   an der Source mit allen benötigten Feldern und passender Art; Org-Projekt → App-Recht **Projects: Read**,
   User-Projekt → `github_token`-Identity als `project.identity`.
3. **Datei** `workflows/<id>.yaml` anlegen (Dateiname = `id`), am besten mit `enabled: false` beginnen.
4. **Filter** nur mit Feldern aus §4.7; Labels exakt schreiben; für geschlossene Items ein `state`-Prädikat auf
   oberster Ebene; teure `dependencies.*`, `work_pr`, `work_branch` (§4.7.2) nur wenn nötig und möglichst hinter
   einem billigen Kriterium (z. B. Label) – dann werden sie nur für passende Items gelesen; Projektwerte (`project.Status in [...]`) genau so
   schreiben, wie sie im Projekt heißen (Groß-/Kleinschreibung zählt). Filter, die mehrere Workflows/Views teilen
   sollen, als benannten Filter in `filters/<id>.yaml` anlegen und mit `filter: <id>` bzw. `{ use: <id> }`
   verwenden (§3.6).
5. **execute:** Skript ausführbar machen (`chmod +x`), Pfad relativ zum config-dir oder absolut; Argumente als
   Liste; Timeouts setzen; Secrets nur über `secrets`.
6. **Hooks:** Label-Übergänge für jeden Ausgang (`on_start`, `on_success`, `on_failure`, `on_crash`,
   `on_start_error`, `on_timeout`, `on_cancel`) so wählen, dass das Item nicht hängen bleibt und nicht sofort wieder
   matcht (Retry-Blocks fangen Endlosschleifen technischer Fehler ab). Wer per `project` einen Status setzt, der
   im Filter vorkommt, setzt ihn in den Fehler-Hooks auch zurück; Optionsnamen genau wie im Projekt, Schreibrecht
   der Identity (§3.2) vorher prüfen.
7. **Validieren:** `adispatch config validate --config-dir <dir>` → Exit 0, Warnungen lesen.
8. **Trockenlauf:** `adispatch workflow dry-run <id> --config-dir <dir>` – Kandidaten, Filter-Trace
   (kein `unknown` durch Tippfehler?), Prioritäten, Locks/Blocks, Kapazität; bei Projektfeldern die Zeilen
   `project fields:` (Werte oder Unknown-Grund, z. B. fehlende Rechte); bei `work_pr`/`work_branch` im Filter den
   Wert im Filter-Trace.
9. **Aktivieren:** `enabled: true` setzen und `adispatch config reload --config-dir <dir>` (bei Fehlern
   bleibt die alte Konfiguration aktiv). Alternativ zuerst ein manueller Start über die UI.
10. **Beobachten:** erster Run in der UI (Status, Logs, Lifecycle-Journal), ggf. `max_concurrent` per Override
    anpassen und danach in YAML übernehmen (Overrides gehen beim Neustart verloren).
