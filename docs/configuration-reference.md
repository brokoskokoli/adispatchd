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
   [filters/*.yaml](#36-filtersyaml), [dashboard.yaml](#37-dashboardyaml), [Grenzen](#38-bekannte-grenzen-v1)
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
  dashboard.yaml       Info-Kacheln und Layout des Dashboards (§3.7) optional (fehlt → Standard-Layout, keine Info-Kacheln)
  scripts/…            frei; Skripte werden über Pfade referenziert (siehe §2.4)
```

`adispatch init --config-dir D --data-dir D` legt eine kommentierte, gültige Beispielkonfiguration an
(`src/cli/init-templates.ts`): `config.yaml`, `sources.yaml`, `identities.yaml`, `workflows/hello.yaml`
(manuell, aktiv), `workflows/coder.yaml` und `workflows/nightly-maintenance.yaml` (beide `enabled: false`),
`views/needs-maintainer.yaml`, den benannten Filter `filters/needs-maintainer.yaml` (von `coder.yaml` und der View
verwendet), `dashboard.yaml` mit einer Info-Kachel (Plattenbelegung des data-dir, Skript `scripts/info/data-disk.sh`)
und Beispielskripte unter `scripts/`. `init` überschreibt nie bestehende Dateien.

Das `data-dir` (SQLite, Logs, `runs/<id>/context.json|result.json`, bei Container-Runs `runs/<id>/out/result.json`, Default-Workspaces) ist **keine**
Konfiguration und wird hier nur erwähnt, wo es Defaults bestimmt.

### 1.2 Dateinamensregeln

| Regel | Verhalten |
|---|---|
| Top-Level-Dateien | exakt `config.yaml`, `sources.yaml`, `identities.yaml`, `dashboard.yaml`. `.yml`-Varianten werden **nicht** gelesen. |
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
`token_env`, `url_env` oder `headers_env` gesetzt sind, und es prüft weder Skriptpfade auf Existenz (Ausnahme: die
Skripte der Info-Kacheln in `dashboard.yaml`, §3.7) noch App-Rechte
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
| `auth.*` | sofort (nächster Request): Modus, Benutzer, Rollen, Proxys, `read_requires_login`; eine geänderte Rolle gilt für bestehende Sessions sofort, ein entfernter Benutzer ist sofort abgemeldet; `session_ttl` gilt für neue Anmeldungen. Passwort-Hashes stehen in Umgebungsvariablen → Änderung erfordert **Neustart** |
| `ui.external_links` | sofort: Toolbar der geöffneten UI, `GET /api/v1/config`, CSP `frame-src` für neu geladene Seiten (ein neu eingebettetes Tool braucht im bereits geöffneten Tab einen Browser-Reload; die UI weist darauf hin) |
| `scheduler.polling_interval` | für den nächsten Timer (nach dem laufenden Planungsschritt) |
| `scheduler.max_concurrent` | sofort |
| `workspace.*`, `lifecycle.action_retry` | für neu reservierte Runs (Snapshot) |
| `retention.*` | ab dem nächsten Retention-Durchlauf; `cleanup_interval` bestimmt den Timer nach jedem Durchlauf |
| `notifications.*` | sofort für neue Benachrichtigungen; offene Zustellungen an entfernte Kanäle scheitern endgültig |
| `sources.yaml`, `identities.yaml` | Adapter/Credentials werden neu aufgebaut, wenn sich etwas geändert hat; entfernte bleiben für laufende Runs verfügbar; `ui_actions` gilt sofort (nächster Request) |
| Workflows | sofort für Planung/Cron; geänderte Cron-Ausdrücke planen ab „jetzt“; Cache der Workflow-Conditions wird geleert; der angezeigte letzte Condition-Status geänderter/entfernter Workflows wird verworfen |
| `dashboard.yaml` | sofort: neue und geänderte Kacheln werden gleich abgerufen, unveränderte behalten Wert und Ablaufzeit, entfernte verschwinden (ein laufendes Skript wird beendet) |
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
| `server.host` | String | `127.0.0.1` | nicht leer | Bind-Adresse von API/UI. Ohne `auth` (Default `mode: none`) keine Anmeldung – dann nur Loopback oder hinter authentifizierendem Proxy/VPN. |
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
| `retention.ui_actions` | Dauer \| `never` | `365d` | | seit 0.4.0: Audit-Einträge der UI-Aktionen (§3.3 `ui_actions`), unabhängig vom Ergebnis. |
| `notifications.on` | Liste Enum | `retry_block_created`, `lifecycle_action_failed`, `recovery_failed` | dazu (seit 0.6.0) `retry_block_cleared` | global aktivierte Ereignisse. `[]` = keine Benachrichtigungen. `retry_block_cleared` ist nicht im Default (bestehende Konfigurationen bekommen nicht mehr Meldungen) und muss ausdrücklich eingetragen werden. |
| `notifications.channels` | Liste | `[]` | | Zustellkanäle, siehe unten. |
| `container.engine` | Enum | `docker` | `docker`, `podman` | Engine für `execute.type: container` ohne eigenes `engine` (seit 0.3.0, §3.4.8). |
| `auth.mode` | Enum | `none` | `none`, `password`, `trusted_header` | Anmeldung für Web-UI und API (seit 0.4.0), siehe unten. `none` = keine Anmeldung (Verhalten bis 0.3.0). |
| `auth.users` | Liste | `[]` | | Benutzer für `mode: password`: `name`, `password_hash_env`, `role`. |
| `auth.trusted_header.header` | String | `Tailscale-User-Login` | HTTP-Header-Name | Header mit dem Login für `mode: trusted_header` (z. B. `X-Forwarded-User` bei oauth2-proxy). |
| `auth.trusted_header.trusted_proxies` | Liste IP/CIDR | `[127.0.0.1, ::1]` | | Nur von diesen TCP-Gegenstellen wird der Header geglaubt. |
| `auth.trusted_header.proxy_secret_env` | Env-Name | – | | optional: Umgebungsvariable mit einem gemeinsamen Geheimnis, das der Proxy in `X-Adispatch-Proxy-Secret` mitsenden muss (Vergleich in konstanter Zeit; fehlt die Variable → jede Anfrage `401`). Nur so ist der Header vor anderen lokalen Prozessen geschützt (nginx/oauth2-proxy können ihn setzen, Tailscale Serve nicht). |
| `auth.trusted_header.users` | Liste | `[]` | | Login → Rolle (`login`, `role`); nicht gelistete Logins → `403`. |
| `auth.trusted_proxies` | Liste IP/CIDR | `[127.0.0.1, ::1]` | | `mode: password`: Proxys, deren `X-Forwarded-Proto` (Cookie-Flag `Secure`) und `X-Forwarded-For` (Login-Rate-Limit je IP) geglaubt werden. |
| `auth.session_ttl` | Dauer | `12h` | 1 m – 30 d | Gültigkeit einer Session ab Anmeldung (`mode: password`). |
| `auth.read_requires_login` | Boolean | `true` | | `false`: Lesen (`GET`, inkl. Live-Updates) ohne Anmeldung als `viewer`, Schreiben nur angemeldet. |
| `monitoring.enabled` | Boolean | `true` | | CPU, RAM, Platte und Prozesse messen (seit 0.4.0) – für die Kompaktleiste oben im Dashboard und den Reiter „Resources“ (seit 0.5.0; in 0.4.0 Bereich „Server“ im Dashboard). `false` → keine Messung, Dashboard und Reiter zeigen einen Hinweis. |
| `monitoring.interval` | Dauer | `scheduler.polling_interval`, höchstens `60s` | ≥ 5 s | Abtastintervall. Ohne Angabe gilt das Polling-Intervall, begrenzt auf 5 s … 60 s. Messungen laufen nie parallel. |
| `monitoring.retention` | Dauer | `6h` | ≥ 10 und ≤ 5 000 Intervalle | wie lange Messpunkte **im Speicher** gehalten werden (Ringpuffer; geht beim Neustart verloren). |
| `monitoring.top_processes` | Integer | `5` | 0–20 | fremde Prozesse (weder Daemon noch Run noch Hook), die einzeln mit Namen gezeigt werden; gleichnamige werden zusammengefasst (`node ×3`). `0` = keine. |
| `monitoring.min_cpu_percent` | Zahl | `2` | ≥ 0 | fremde Prozesse(-gruppen) mit weniger CPU landen in „Others“. 100 = ein voll ausgelasteter Kern. |
| `ui.external_links` | Liste | `[]` | | externe Tools in der Toolbar der Web-UI (seit 0.4.0), siehe unten. `[]` = keine Einträge sichtbar. |

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
**ohne** `continue_on_error`), `recovery_failed` (Run nach Neustart nicht sicher zuordenbar → `recovery_pending`),
seit 0.6.0 optional `retry_block_cleared` (Retry-Block aufgehoben; Payload mit `blockId`, `clearedBy`, `clearedAt` und
`runId` des Lifecycle-Runs oder `null`, §6.4).

**Externe Tools `ui.external_links`** (seit 0.4.0): beliebige lokale Werkzeuge, z. B. das Agenten-Dashboard
[claude-inspect](https://github.com/brokoskokoli/claude_inspect), als Eintrag in der Navigation – als Link in neuem Tab
oder eingebettet als eigene Seite. Kein Proxy: Der **Browser** spricht das Tool direkt an; die URL muss also vom Browser
aus erreichbar sein (lokal oder über einen Reverse Proxy). Betrieb von claude-inspect: [operations.md](operations.md).

| Schlüssel | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `id` | Konfigurations-ID | ja | | eindeutig innerhalb der Liste; Teil der Route `#/tools/<id>` |
| `label` | String | ja | | Text des Eintrags, 1–40 Zeichen (nur als Text dargestellt, nie als HTML) |
| `url` | String | ja | | absolute `http(s)`-URL, wie der Browser das Tool erreicht. Keine Zugangsdaten (`user:pass@` → Fehler). Query-Parameter sind erlaubt; ein Parameter, der wie ein Token aussieht (`t`, `token`, `access_token`, `key`, `secret`, `password`, …), ergibt eine **Warnung** – solange der Eintrag aktiv ist, sieht jeder, der UI/API erreicht, die vollständige URL (siehe unten). |
| `enabled` | Boolean | nein | `true` | `false` entfernt den Eintrag aus der Toolbar, aus `externalLinks` und `config.global.ui` von `GET /api/v1/config` und aus der CSP. Die URL bleibt nur in `config.yaml` (in `GET /api/v1/config/files` ist sie wie jeder `url`-Wert redigiert). |
| `embed` | Boolean | nein | `false` | `false` = Link in neuem Tab (`noopener noreferrer`, Symbol „↗“); `true` = Seite `#/tools/<id>` mit dem Tool in einem `iframe` (Sandbox `allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`, kein Referrer) und „Open in new tab“ |

Für jeden aktivierten Eintrag mit `embed: true` erlaubt die Content-Security-Policy der UI dessen Origin
(`schema://host[:port]`) in `frame-src`; sonst bleibt die Policy unverändert. Ob das Tool sich einbetten lässt, entscheidet
das Tool selbst (`X-Frame-Options`/`frame-ancestors`); verbietet es das, nicht läuft oder die Anfrage ablehnt (z. B.
Host-Prüfung), bleibt die Seite leer – der Link „Open in new tab“ und ein Hinweis bleiben sichtbar. Bei `embed: true`
muss sich der Host in der CSP ausdrücken lassen – nur Buchstaben, Ziffern, `.` und `-` (Hostname oder IPv4); IPv6-Literale
(`http://[::1]:…`) und Hosts mit `_`, `*`, `;`, `,` … sind ein **Fehler** (`embed: false` geht).

**Sichtbarkeit:** Die URL jedes **aktiven** Eintrags – inklusive eines Tokens darin – sieht jeder, der die UI oder die API
erreicht (Toolbar, Feld `externalLinks` von `GET /api/v1/config`). Das ist dieselbe Vertrauensgrenze wie für adispatchd
selbst: die UI nur lokal oder hinter einem authentifizierenden Reverse Proxy betreiben. Die Konfigurationsansicht
(`config.global.ui.externalLinks`) zeigt nur aktive Einträge und redigiert deren Query-String und Fragment.

**Gleicher Hostname und gleiches Schema:** UI und Tool sollten mit demselben Hostnamen und Schema geöffnet werden, z. B.
beide über `127.0.0.1` (`http://127.0.0.1:8787/` und `http://127.0.0.1:47717/`) – nicht einmal `localhost` und einmal
`127.0.0.1`. Sonst ist der Frame für den Browser „cross-site“, und Cookies mit `SameSite=Strict`/`Lax` (z. B. das
Zugangs-Cookie eines per Token geschützten Tools) werden im Frame nicht gesendet. Auf einem Server: UI und Tool unter
derselben registrierbaren Domain (z. B. `orchestrator.example.com` und `inspect.example.com`) und beide per HTTPS.

```yaml
# example: external-links
# extends: minimal
# file: config.yaml
# expect-warning: config.yaml: ui.external_links[2].url: Query parameter "t" looks like an access token
ui:
  external_links:
    - id: claude-inspect                 # lokales Agenten-Dashboard (Dienst auf Port 47717, ohne Token)
      label: Claude Inspect
      url: http://127.0.0.1:47717/       # so, wie der Browser das Tool erreicht
      embed: true                        # Seite in der UI (#/tools/claude-inspect)
    - id: grafana
      label: Grafana
      url: https://grafana.example.com/d/agents?orgId=1   # Link in neuem Tab (embed: false)
    - id: inspect-manual
      label: Inspect (manuell)
      url: http://localhost:7717/?t=example-token          # Warnung: Token in der URL
      enabled: false
```

```yaml
# example: external-links-invalid
# extends: minimal
# file: config.yaml
# invalid
# expect: config.yaml: ui.external_links[0].url: Must be an absolute http(s) URL
# expect: config.yaml: ui.external_links[1].url: Must not contain credentials
# expect: config.yaml: ui.external_links[2].id: Duplicate external link ID "tool"
ui:
  external_links:
    - { id: tool, label: Tool, url: "/inspect/" }                          # relativ → Fehler
    - { id: proxy, label: Proxy, url: "https://admin:secret@tools.example.com/" }
    - { id: tool, label: Tool 2, url: "https://tools.example.com/" }
```

**Anmeldung `auth`** (seit 0.4.0): Ohne den Abschnitt gilt `mode: none` – keine Anmeldung, alles wie bis 0.3.0.
Mit `password` oder `trusted_header` verlangt jeder Endpunkt außer `/health`, `/ready`, den Auth-Endpunkten und der
statischen UI-Hülle eine Anmeldung und eine **Mindestrolle** (Tabelle je Endpunkt: [api.md](api.md#mindestrolle-je-endpunkt)):

| Rolle | Darf |
|---|---|
| `viewer` | alles lesen (Status, Runs, Logs, Views, Konfiguration, Live-Updates), Dry-Run und `config validate` (ändern nichts) |
| `operator` | zusätzlich alle schreibenden Aktionen: Runs starten/abbrechen, Pause/Resume/Drain/Cancel-All, Retry/Skip von Actions, Recovery-Retry, Blocks entfernen, Runtime-Overrides, Config-Reload, Info-Refresh, Notification-Retry |
| `admin` | zusätzlich künftige Admin-Funktionen (WI-27 „Als Identität handeln“, sofern dort je Identity erlaubt) |

- **`mode: password`** – eingebaute Benutzer. Das Passwort steht **nie** in YAML, sondern als scrypt-Hash in einer
  Umgebungsvariablen (`password_hash_env`, z. B. in `/etc/default/adispatchd`); erzeugen mit
  `adispatch auth hash-password` (fragt ohne Echo, oder `printf '%s\n' "$PW" | adispatch auth hash-password`). Format
  `scrypt:<N>:<r>:<p>:<salt>:<hash>` ohne `$` (unproblematisch in Env-Dateien). Login-Seite in der UI, Session-Cookie
  `HttpOnly; SameSite=Strict`, `Secure` über HTTPS (eigene TLS-Verbindung oder `X-Forwarded-Proto: https` von einem
  Eintrag in `auth.trusted_proxies`). Sessions liegen im Speicher – nach einem Neustart neu anmelden. Fehlt die Variable
  oder ist der Hash ungültig, kann sich der Benutzer nicht anmelden (Warnung beim Start, ohne Wert). Benutzernamen:
  Buchstaben, Ziffern, `.`, `_`, `@`, `-` (max. 64), eindeutig ohne Groß-/Kleinschreibung; beim Login zählt die
  Groß-/Kleinschreibung nicht.
- **`mode: trusted_header`** – die Identität kommt vom vorgeschalteten Proxy (Tailscale Serve setzt
  `Tailscale-User-Login`, oauth2-proxy z. B. `X-Forwarded-User`, Authelia `Remote-User`). Der Header zählt **nur**, wenn
  die TCP-Gegenstelle (nicht `X-Forwarded-For`) in `trusted_header.trusted_proxies` liegt, sonst `401`; ohne Header `401`;
  Login nicht in `trusted_header.users` → `403`. Logins werden ohne Groß-/Kleinschreibung verglichen. adispatchd muss
  dann an `127.0.0.1` gebunden und **nur** über den Proxy erreichbar sein (beim Start wird bei Nicht-Loopback-Bind
  gewarnt). **Lokal fälschbar:** Deckt ein Eintrag in `trusted_proxies` eine Loopback-Adresse ab und ist kein `proxy_secret_env`
  gesetzt (typisch Tailscale Serve), kann **jeder Prozess auf dem Host – auch jeder Worker** – den Header selbst setzen
  und sich als beliebiger gelisteter Login ausgeben (Warnung beim Start). Mit `proxy_secret_env` muss der Proxy zusätzlich
  `X-Adispatch-Proxy-Secret` senden. Reservierte Header (`Host`, `Cookie`, `Origin`, `X-Forwarded-For`,
  `X-Adispatch-Proxy-Secret`, …) sind nicht erlaubt. `0.0.0.0/0` bzw. `::/0` in einer Proxy-Liste ergibt eine Warnung.
- **CLI-Steuerbefehle** (`status`, `pause`, `drain`, `config reload`, …) funktionieren in allen Modi weiter: Der Daemon
  schreibt bei jedem Start einen zufälligen Steuer-Token nach `<data-dir>/control.token` (`0600`), die CLI liest ihn
  (`--data-dir`, sonst `./data` und `/var/lib/adispatchd`; nur für den Port aus der Datei) und erhält damit `operator` –
  nur über Loopback und **nur** für die Routen der CLI-Befehle. Worker laufen als derselbe Dienstbenutzer und **können die
  Datei lesen**, also genau diese Aktionen auslösen (Status, Pause/Resume, Drain/Cancel-All, Reload, Dry-Run); das
  entspricht der bestehenden Vertrauensgrenze (Skripte sind vertrauenswürdiger Konfigurationscode, Spec §20.2).
- **Audit:** schreibende Aktionen protokollieren den Benutzer (Daemon-Log, Run-Event `audit.user_action`, `clearedBy` bei
  Blocks), siehe [api.md](api.md#anmeldung-und-rollen-seit-040-wi-26).

| Schlüssel (Eintrag in `auth.users`) | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `name` | String | ja | Anmeldename |
| `password_hash_env` | Env-Name | ja | Umgebungsvariable mit dem Hash aus `adispatch auth hash-password` |
| `role` | Enum | ja | `viewer`, `operator`, `admin` |

```yaml
# example: auth-password
# extends: minimal
# file: config.yaml
auth:
  mode: password
  session_ttl: 8h
  users:
    - { name: alice, password_hash_env: ADISPATCH_PW_ALICE, role: admin }
    - { name: ops, password_hash_env: ADISPATCH_PW_OPS, role: operator }
    - { name: board, password_hash_env: ADISPATCH_PW_BOARD, role: viewer }
  trusted_proxies: [127.0.0.1, ::1]      # HTTPS-Proxy auf demselben Host (Secure-Cookie, Rate-Limit je Client-IP)
```

```yaml
# example: auth-tailscale
# extends: minimal
# file: config.yaml
server:
  host: 127.0.0.1                          # nur über den Proxy erreichbar
  allowed_hosts: [orchestrator.tailnet-name.ts.net]
auth:
  mode: trusted_header
  trusted_header:
    header: Tailscale-User-Login           # Default
    trusted_proxies: [127.0.0.1, ::1]      # tailscale serve --bg http://127.0.0.1:8787
    users:
      - { login: alice@example.com, role: admin }
      - { login: bob@example.com, role: viewer }
  read_requires_login: true
```

```yaml
# example: auth-invalid
# extends: minimal
# file: config.yaml
# invalid
# expect: config.yaml: auth.users[0].role: Invalid option
# expect: config.yaml: auth.trusted_header.trusted_proxies[0]: Invalid IP address or CIDR range
auth:
  mode: password
  users:
    - { name: alice, password_hash_env: PW_ALICE, role: root }       # Rolle unbekannt
  trusted_header:
    trusted_proxies: [localhost]                                     # Hostname statt IP/CIDR
```

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
  ui_actions: 365d                                   # Audit der UI-Aktionen (WI-27)
notifications:
  on: [retry_block_created, lifecycle_action_failed, recovery_failed]
  channels:
    - id: ops
      type: webhook
      url_env: OPS_WEBHOOK_URL
      headers_env: { Authorization: OPS_WEBHOOK_AUTH }
      on: [retry_block_created, recovery_failed]
container:
  engine: docker                                     # docker | podman (für execute.type: container)
monitoring:                                          # Server-Ressourcen: Dashboard-Leiste + Reiter Resources
  enabled: true
  interval: 30s                                      # Default: scheduler.polling_interval, 5s … 60s
  retention: 6h                                      # nur im Speicher
  top_processes: 5
  min_cpu_percent: 2
ui:
  external_links:                                    # Default: [] (keine Einträge)
    - id: claude-inspect
      label: Claude Inspect
      url: http://127.0.0.1:47717/
      enabled: true
      embed: true                                    # Default: false (Link in neuem Tab)
auth:
  mode: none                                         # none | password | trusted_header
  users:                                             # mode: password
    - { name: alice, password_hash_env: ADISPATCH_PW_ALICE, role: admin }   # viewer | operator | admin
  trusted_header:                                    # mode: trusted_header
    header: Tailscale-User-Login
    trusted_proxies: [127.0.0.1, ::1]
    proxy_secret_env: ADISPATCH_PROXY_SECRET         # optional; Default: kein Geheimnis
    users:
      - { login: alice@example.com, role: admin }
  trusted_proxies: [127.0.0.1, ::1]                  # mode: password: X-Forwarded-Proto/-For
  session_ttl: 12h
  read_requires_login: true
```

**Ressourcen-Monitor (`monitoring`, seit 0.4.0).** Der Daemon misst im Abstand `interval` die CPU-Auslastung
(Delta der `os.cpus()`-Zeiten), Kerne und Load Average, den Arbeitsspeicher (Linux: `MemAvailable` aus
`/proc/meminfo`; macOS: verfügbar = free + inactive + speculative aus `vm_stat`, sonst `os.freemem()`), den freien
Platz des data-dir und – falls auf einem anderen Dateisystem – von `workspace.base_dir`, sowie einmal je Intervall die
Prozessliste (Linux: `/proc/<pid>/stat`, nur `comm`, nie `cmdline`; macOS bzw. ohne lesbares `/proc`:
`ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,ucomm=`, ohne Shell, mit Timeout). Die CPU je Prozess ist die
Rate der kumulierten CPU-Zeit (100 % = ein Kern); ein Prozess wird über PID und Startzeit wiedererkannt (Linux exakt in
Clock-Ticks, bei `ps` jetzt − `etime` mit 2,5 s Toleranz), PID-Wiederverwendung startet also eine neue Reihe; ein
Namenswechsel (`exec`, Thread-Name) nicht. Liefert unter Linux nur `ps` die Werte (ganze Sekunden), wird die Rate über ein
gleitendes Fenster von bis zu 60 s gebildet. Zuordnung:
eigene PID → Daemon; Prozessgruppe bzw. Vorfahrenkette des Workers → der Run (Container-Runs zusätzlich
`<engine> stats --no-stream`, das selbst über ein kurzes Fenster von 1–2 s misst); andere Kindprozesse des Daemons →
„adispatchd (hooks/checks)“; der Rest → fremde Prozesse. Gezeigt werden **nur Befehlsnamen, nie Argumente**: `ucomm` ist
der Abrechnungsname des Kernels (nicht das umschreibbare `argv[0]`), zusätzlich wird ein Name an der ersten Leerstelle
abgeschnitten (bei Pfaden: Basename). Restrisiko unter Linux: Ein Prozess kann seinen Namen selbst setzen
(`prctl(PR_SET_NAME)`, max. 15 Zeichen) – fremde Prozessnamen sind in der UI sichtbar (UI nur hinter Authentifizierung
freigeben). Fehler einer Messung (z. B. `ps` fehlt) werden gedrosselt geloggt und lassen den
Teilwert leer. API: `GET /api/v1/system/metrics`, SSE-Event `system.metrics` ([api.md](api.md)). UI: kompakte Leiste
oben im Dashboard (CPU gesamt mit Verlauf der letzten 15 min, RAM, am stärksten belegter Pfad, Load, größte
Prozessgruppen – eigene zuerst; Klick → Reiter), ausführliche Diagramme, Zeitraumwahl und Wertetabelle im Reiter
„Resources“ (`#/resources`, ab Rolle `viewer`).

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
    vars:                    # optional (seit 0.3.0): freie Variablen, {source.vars.<Name>}
      base_branch: main
  project_b:
    type: github
    owner: example
    repository: project-b
    identity: maintainer
    vars: { base_branch: develop }
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
| `<id>.vars` | Map Name → String | nein (Default `{}`) | Name wie Parameternamen (`[A-Za-z_][A-Za-z0-9_-]*`); Werte String, Zahlen/Booleans werden zu Text (`port: 8080` → `"8080"`) | freie Variablen der Source, als `{source.vars.<Name>}` überall dort nutzbar, wo `{source.*}` erlaubt ist (§5) |

**Source-Variablen (`vars`, seit 0.3.0).** Werte, die sich je Repository unterscheiden (Basis-Branch,
Build-Kommando, Zielumgebung …), stehen an der Source statt in jedem Workflow: `{source.vars.base_branch}` in
`execute.args`/`env`/`working_directory`, Hook-Templates und `conditions.item[].args`. Die Prüfung beim Laden
verlangt die Variable in **jeder** Source des Workflows (bei mehreren Sources §3.4.2) und nennt sonst die Sources,
in denen sie fehlt. Variablen sind keine Secrets (sie stehen in API und Run-Snapshot) – Tokens gehören in `secrets`.

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
| `<id>.ui_actions` | Boolean | nein (Default `false`) | braucht `auth.mode` ≠ `none` | seit 0.4.0: Benutzer mit Rolle `admin` dürfen in der Web-UI **als diese Identity** kommentieren, Labels setzen/entfernen und Projektfelder ändern (siehe unten) |

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
**Item-Verlauf** (seit 0.9.0): Ereignisse der GitHub-Timeline gelten ebenso am Login als „eigen“. Mit einem
persönlichen Token (PAT) sind das **alle** Änderungen dieses GitHub-Benutzers – auch die, die er selbst von Hand macht:
passen sie zu einer Änderung der Historie, werden sie zusammengeführt (ausgeblendet), sonst als „own identity“ statt
„external“ markiert. Für eine klare Trennung einen eigenen Bot-Account oder eine GitHub App verwenden.

**`ui_actions`** (seit 0.4.0): Freischaltung einer Identity für das **Item-Panel** der Web-UI (Menü „UI Actions“, Link
„Act as identity…“ im Run-Detail und in Views). Ein angemeldeter `admin` kann dort auf ein Issue/PR als diese Identity
antworten, Labels setzen/entfernen und die in `project.fields` der Source deklarierten Projektfelder ändern – ohne als
eigene Person aufzutreten. Default aus. Voraussetzungen und Grenzen:

- `auth.mode` muss `password` oder `trusted_header` sein. Mit `mode: none` sind UI-Aktionen deaktiviert (Hinweis in der
  UI, Warnung bei `config validate`).
- Mit `trusted_header`, in dessen `trusted_proxies` ein Eintrag Loopback abdeckt (z. B. Tailscale Serve auf
  `127.0.0.1`) und kein `proxy_secret_env` gesetzt ist, könnte jeder lokale Prozess – auch ein Worker – den Login-Header
  fälschen: dann ist `ui_actions: true` ein **Fehler**. Abhilfe: `auth.mode: password` (funktioniert auch über Tailscale)
  oder `proxy_secret_env`.
- **Jeder Proxy auf demselben Host** braucht für UI-Aktionen `proxy_secret_env` (oder `auth.mode: password`) – auch wenn
  er in `trusted_proxies` mit seiner LAN- oder Tailscale-IP steht: lokale Prozesse erreichen adispatchd auch über diese
  Adresse. Das erkennt die Prüfung nicht automatisch (sie sieht nur Loopback-Einträge).
- **`ui_actions` an einer `github_token`-Identity** heißt: Admins handeln in der UI **als die Person**, der der Token
  gehört (Kommentare erscheinen unter ihrem Namen). Nur bewusst einsetzen, für Apps bevorzugt `github_app`.
- Nur echte Benutzer: Der CLI-Steuer-Token wird für UI-Aktionen nie akzeptiert.
- Geschrieben wird genau mit dieser Identity (auch Projektfelder, unabhängig von `project.identity` der Source). App-Rechte:
  Issues und Pull Requests **Read and write**, für Projektfelder Organization → Projects **Read and write**.
- Jede Aktion steht im Audit (`GET /api/v1/ui-actions`, UI-Seite „UI Actions“), aufbewahrt für `retention.ui_actions`
  (Default `365d`, §3.1). Details: [api.md](api.md#ui-aktionen-als-identity-seit-040-wi-27).

```yaml
# example: ui-actions
# extends: auth-password
# file: identities.yaml
identities:
  maintainer:
    type: github_app
    app_id: 100001
    installation_id: 200001
    private_key_env: GITHUB_MAINTAINER_PRIVATE_KEY
    ui_actions: true                   # Kommentare/Labels/Projektfelder aus der Web-UI
  coder:
    type: github_app
    app_id: 100002
    installation_id: 200002
    private_key_env: GITHUB_CODER_PRIVATE_KEY
```

```yaml
# example: ui-actions-forgeable
# extends: auth-tailscale
# file: identities.yaml
# invalid
# expect: identities.yaml: identities.maintainer.ui_actions: UI actions are not allowed with auth.mode trusted_header behind a local (loopback) proxy
identities:
  maintainer:
    type: github_app
    app_id: 100001
    installation_id: 200001
    private_key_env: GITHUB_MAINTAINER_PRIVATE_KEY
    ui_actions: true                   # Tailscale Serve auf 127.0.0.1 ohne proxy_secret_env → Fehler
```

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
  source: project_a              # oder (seit 0.3.0) sources: [project_a, project_b] – §3.4.2

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
    BASE_BRANCH: '{source.vars.base_branch}'   # Variable der Source (§3.2)
  secrets:
    GH_TOKEN: { identity: coder }  # kurzlebiges Installation-Token der Identity (delivery: env, Default)
    REVIEW_TOKEN: { identity: maintainer, delivery: file }  # Token-Datei, Pfad in REVIEW_TOKEN_FILE, wird erneuert
  timeout:
    max_duration: 6h
    idle_timeout: 45m
  cancel_grace: 30s
  keep:                            # vor dem Cleanup nach data-dir/runs/<run-id>/kept/ kopieren
    - .agent/transcript.jsonl
    - .agent/gate/*.log
  keep_max_size: 50MB              # Summe pro Run; Default 100MB

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
    secrets:
      GH_TOKEN: { identity: maintainer, delivery: file }  # seit 0.3.0 (WI-18)
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
on_result:                       # benannte Ergebnisse (Ergebnisdatei "outcome"), statt on_success/on_failure
  needs_maintainer:
    - type: source.update
      labels: { add: [needs-maintainer], remove: [in-progress] }
    - type: source.comment
      message: 'Rückfrage ({result.outcome}): {result.message}'
  wont_fix: []                   # definiert, aber ohne Actions: es läuft nichts
on_retry_block:                  # seit 0.6.0: der Run hat gerade einen Retry-Block erzeugt (nach on_crash & Co.)
  - type: source.update
    labels: { add: [agent-blocked], remove: [ready] }
  - type: source.comment
    message: 'Nach {block.failures} technischen Fehlern blockiert (zuletzt {block.last_status}, Run {run.id}).'
on_retry_unblock:                # seit 0.6.0: Block wurde aufgehoben (eigener Lifecycle-Run, Trigger unblock)
  - type: source.update
    labels: { add: [ready], remove: [agent-blocked] }
```

`on_error` fehlt hier bewusst: alle vier technischen Hooks sind definiert, `on_error` liefe nie (Warnung, §3.4.10).

#### 3.4.1 Oberste Ebene

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `id` | Konfigurations-ID | ja | | eindeutig über alle Workflows | stabiler Schlüssel (Runs, Locks, Blocks, API) |
| `name` | String | nein | `id` | nicht leer | Anzeigename, `{workflow.name}` |
| `enabled` | Boolean | nein | `true` | | `false`: keine automatischen Starts (Source/Cron); **manuelle Starts bleiben möglich** |
| `priority` | Zahl | nein | `0` | | Workflow-Priorität, wird vor der Item-Priorität sortiert (§6.2) |
| `max_concurrent` | Integer | nein | `1` | ≥ 1 | Limit gleichzeitig aktiver Runs dieses Workflows für automatische Starts |
| `max_concurrent_per_source` | Integer | nein | (kein Limit) | ≥ 1; nur `trigger.type: source` | zusätzliches Limit je Source (seit 0.3.0, §3.4.2, §6.3); `max_concurrent` bleibt das Limit des Workflows insgesamt |
| `identity` | Identity-ID | nein | Source-Identity | muss existieren | Schreib-Identity für `source.update`/`source.comment` (§6.10) |
| `trigger` | Objekt | ja | | §3.4.2 | |
| `filter` | Filter-AST | nein | (alles passt) | nur `trigger.type: source` | §4 |
| `shell_filter` | Objekt | nein | | nur `source` | §3.4.4 |
| `item_priority` | Objekt | nein | Priorität 0 | nur `source` | §3.4.5 |
| `conditions` | Objekt | nein | keine | `item` nur bei `source` | §3.4.6 |
| `parameters` | Map | nein | `{}` | §3.4.7 | Parameter für manuelle Starts |
| `execute` | Objekt | ja | | §3.4.8 | Haupt-Worker |
| `retry.max_technical_failures` | Integer | nein | `3` | ≥ 1 | aufeinanderfolgende technische Fehler bis zum Retry-Block (§6.4) |
| `on_start`, `on_success`, `on_failure` | Liste Actions | nein | `[]` | §3.4.10 | Lifecycle-Hooks |
| `on_crash`, `on_start_error`, `on_cancel`, `on_timeout` | Liste Actions | nein | nicht definiert | §3.4.10 | technische Hooks; definiert (auch als `[]`) haben sie Vorrang vor `on_error` |
| `on_error` | Liste Actions | nein | nicht definiert | §3.4.10 | Sammel-Hook für `crashed`, `start_error`, `timed_out`, `cancelled` ohne eigenen Hook |
| `on_result` | Map Ergebnis-ID → Liste Actions | nein | `{}` | Schlüssel sind Konfigurations-IDs; nur mit Ergebnisdatei (`execute.type: shell` oder `container`); leere Listen erlaubt | benannte Ergebnisse (`outcome` der Ergebnisdatei), §3.4.10 |
| `on_retry_block`, `on_retry_unblock` | Liste Actions | nein | nicht definiert (`[]`) | §3.4.10 | seit 0.6.0: beim Entstehen bzw. Aufheben eines Retry-Blocks (§6.4) |

#### 3.4.2 `trigger`

| `type` | weitere Schlüssel | Bedeutung |
|---|---|---|
| `source` | **entweder** `source` (Source-ID, muss existieren) **oder** (seit 0.3.0) `sources` (Liste von Source-IDs: nicht leer, ohne Duplikate, alle existieren, alle mit demselben Adaptertyp) | Items der Source(s) werden jeden Planungsschritt gepollt; ein Run ist an genau ein Item gebunden. |
| `schedule` | `cron` (Pflicht, nicht leer), `timezone` (Default `UTC`, IANA-Name wie `Europe/Berlin`) | höchstens ein Run pro Cron-Slot, ohne Item (§6.7). |
| `manual` | – | nur manuelle Starts (UI/API), ohne Item. |

**Mehrere Sources (`sources`, seit 0.3.0).** Ein Workflow für mehrere Repositories statt fast gleicher Kopien:

- Jede Source wird im Planungsschritt abgefragt (parallel, Pushdown je Source); die Kandidaten aller Sources
  konkurrieren nach Item-Priorität. Bei gleicher Item-Priorität entscheidet die **Reihenfolge der Liste**, danach die
  bisherigen Tie-Breaker (§6.2).
- Lock, Retry-Block, Fehlerzähler und Historie bleiben pro globalem Item-Schlüssel `<source>:<nr>` – gleiche
  Nummern in zwei Repositories sind zwei Items.
- `max_concurrent` gilt für den Workflow insgesamt; `max_concurrent_per_source` begrenzt zusätzlich je Source
  (Entscheidung `source_limit`).
- Fällt eine Source beim Pollen aus, laufen die anderen weiter; die Diagnose (API, Dry-Run, UI) zeigt Status und
  Fehler **je Source**.
- Felder: `project.*` in `filter`, `item_priority` und `source.update.project` nur, wenn **alle** Sources das Feld
  mit gleicher Art deklarieren (Regel wie bei Views, §4.7.1); die `state`-Regel (§4.5) und der Pushdown gelten je
  Source. `{source.vars.<Name>}` muss in allen Sources definiert sein.
- Ein Run kennt nur seine Source: `{source.*}`, `{item.*}`, Lifecycle-Actions, Identity-Fallback und Run-Snapshot
  beziehen sich auf die Source des Items. Ein eigenes `execute.working_directory` sollte `{source.id}` oder
  `{item.key}` enthalten (oder beim Default `{workflow.id}/{run.id}` bleiben), damit sich gleiche Nummern aus
  verschiedenen Repositories nicht dasselbe Verzeichnis teilen.
- Manueller Start: die Source folgt aus der Item-Referenz (URL, `owner/repo#nr` oder `<source>:<nr>`); eine bloße
  Nummer ist bei mehreren Sources mehrdeutig und wird mit Hinweis abgelehnt (§6.6).
- `sources: [x]` mit einem Eintrag verhält sich wie `source: x`.

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
| `name` | String (1–80 Zeichen) | nein | | Anzeigename in UI und Dry-Run (seit 0.4.0); ohne `name` wird das Kommando angezeigt |
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
| `name` | String | nein | | 1–80 Zeichen, nicht leer | Anzeigename in UI, Dry-Run und Ablehnungsgründen (seit 0.4.0); ohne `name` zeigt die UI `command` + `args` (gekürzt, relativ zum config-dir) |
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
- **Anzeige (seit 0.4.0):** Workflows → Workflow-Detail (Bereich „Conditions“) und kompakt in der Workflow-Liste
  zeigen jede Condition mit Anzeigename, Timeout, Cache und dem **letzten Status**: Workflow-Conditions grün = ok
  (Exit 0), rot = „nicht jetzt“ (Exit 1), gelb = Prüffehler (Exit ≥ 2, Timeout, Signal), grau = nicht ausgewertet
  (eine frühere Condition hat entschieden) bzw. seit Start/Reload noch nie geprüft – dazu Zeitpunkt, Dauer, ob aus
  dem Cache, Exit-Code und die erste stderr-Zeile (redigiert, gekürzt). Für Item-Conditions und `shell_filter`
  gibt es eine Zusammenfassung des letzten Planungsschritts (Anzahl ok / nicht jetzt / Fehler / nicht ausgewertet
  über die geprüften Items). Der Status liegt nur im Speicher; ein Reload verwirft ihn für geänderte Workflows.
  API: `conditions` in `GET /api/v1/workflows[/:id]`, SSE `workflow.conditions` ([api.md](api.md)).

```yaml
# Ausschnitt
conditions:
  workflow:
    - name: Credits verfügbar
      type: shell
      command: scripts/check-credits.sh
      timeout: 15s
      cache: 60s
```

#### 3.4.7 `parameters`

Map Parametername → Definition. Werte **übergeben** werden nur bei manuellen Starts (UI-Formular,
`POST /api/v1/workflows/:id/start` mit `{"parameters": {…}}`) und vor dem Start validiert; automatisch gestartete
Runs (Source, Cron) erhalten die `default`-Werte (siehe unten).

| Schlüssel | Typ | Pflicht | Default | Regeln |
|---|---|---|---|---|
| `type` | Enum | ja | | `string`, `number`, `boolean`, `enum` |
| `values` | Liste | bei `enum` eins von `values`/`options_from` | | nicht leer, eindeutig; Zahlen/Booleans werden zu Strings |
| `options_from` | Map | bei `enum` eins von `values`/`options_from` | | seit 0.7.0: Auswahlliste zur Laufzeit, s. u. „Auswahllisten zur Laufzeit“; nicht zusammen mit `values` |
| `allow_custom` | Boolean | nein | `false` | nur `enum` (mit `values` oder `options_from`): auch Werte außerhalb der Liste erlaubt |
| `required` | Boolean | nein | `false` | |
| `default` | passend zum Typ | nein | keiner | `string` → String, `number` → endliche Zahl, `boolean` → Boolean, `enum` → einer der `values` (Skalare werden zu Strings, `values: [1, 2]` + `default: 1` ist gültig); mit `options_from` oder `allow_custom` ein beliebiger String (Prüfung erst beim Start) |
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

**Auswahllisten zur Laufzeit (`options_from`, seit 0.7.0, WI-31)** – ein `enum` kann seine Werte beim manuellen Start
aus GitHub (Branches/Tags einer Source) oder aus einem eigenen Skript beziehen:

| Schlüssel | Typ | Pflicht | Default | Regeln |
|---|---|---|---|---|
| `options_from.github` | `branches` \| `tags` | eins von `github`/`command` | | Branches: Default-Branch zuerst, dann alphabetisch; Tags: neueste zuerst (Reihenfolge der API) |
| `options_from.source` | Source-ID | bei `github`; optional, wenn der Workflow genau eine Trigger-Source hat bzw. – ohne Trigger-Source – `sources.yaml` genau eine Source enthält | diese Source | GitHub-Source; gelesen mit deren `identity` |
| `options_from.limit` | Integer 1–500 | nein | `100` | nur `github`; höchstens so viele Optionen (Paginierung bis dahin) |
| `options_from.command` | String | eins von `github`/`command` | | wie `command` von Shell-Actions (§2.4, relativ zum Config-Verzeichnis, kein Template); als Pfad angegebenes Skript muss existieren |
| `options_from.args` | Liste String | nein | `[]` | nur `command`; Templates nur mit `{workflow.id}`, `{workflow.name}`, `{workspace.base_dir}`, `{timestamp}` |
| `options_from.secrets` | wie bei `execute.secrets` | nein | `{}` | nur `command`; Token der Identity als Env-Wert oder Token-Datei (`delivery: file`) |
| `options_from.timeout` | Dauer | nein | `10s` | > 0, ≤ `60s` (bei `github` für den ganzen Abruf) |
| `options_from.cache` | Dauer | nein | `1m` (`github`), `0s` (`command`) | `0s` = nicht cachen; nur erfolgreiche Abrufe werden gecacht |

- **Skript:** läuft wie die Info-Kacheln (§3.7): ohne Shell, minimale Umgebung plus `secrets` sowie
  `ADISPATCH_WORKFLOW_ID`, `ADISPATCH_PARAMETER`, `ADISPATCH_CONFIG_DIR`, `ADISPATCH_DATA_DIR` und
  `ADISPATCH_CHECK_CONTEXT_FILE` (JSON `{schema_version, kind: "parameter_options", workflow: {id}, parameter: {name},
  config_dir, data_dir}`), Arbeitsverzeichnis = Config-Verzeichnis, eigene Prozessgruppe, Kill bei Timeout. stdout
  (UTF-8): eine Option pro Zeile (getrimmt, leere Zeilen ignoriert) **oder** – beginnt die Ausgabe mit `[` – eine
  JSON-Liste aus Strings bzw. `{"value": "…", "label": "…"}` (`label` nur Anzeige). Exit ≠ 0, Timeout, ungültiges
  JSON, mehr als 500 Optionen, leere Werte, Werte/Labels über 200 Zeichen oder mit Steuerzeichen, mehr als 256 KiB
  Ausgabe → Fehler mit kurzer Meldung (Exit-Code + erste stderr-Zeile, Secrets geschwärzt). Doppelte Werte zählen einmal.
  `timeout` gilt für den ganzen Abruf einschließlich Token-Beschaffung.
- **Start:** `POST …/start` prüft Werte ohne `allow_custom` gegen die **aktuelle** Liste (Cache erlaubt): nicht
  enthalten → HTTP 400 `invalid_parameters`; Liste nicht abrufbar → HTTP 502 `parameter_options_unavailable`, kein
  Start. Mit `allow_custom` keine Listenprüfung (aber höchstens 200 Zeichen, keine Steuerzeichen). Werte gelangen wie
  alle Parameter als einzelne Argumente/Env-Werte zum Prozess (keine Shell), im Pfadmodus als sicheres Segment.
  **Achtung:** Ein frei eingegebener Wert (`allow_custom`, `type: string`) kann mit `-` beginnen und kommt dann als
  eigenes argv-Element an, das ein Programm als Option deuten könnte – im Skript Optionen mit `--` abschließen (z. B.
  `git checkout -- "$1"`) oder den Wert als `--name=<wert>` übergeben (`args: ['--target={parameters.target}']`).
- **`default`** muss nicht in einer Liste stehen; fehlt er in der aktuellen Liste, zeigt das Formular einen Hinweis,
  beim Start gilt die normale Prüfung.
- **Automatische Workflows** (Source/Cron) erhalten nur den `default` (ohne Abruf, ohne Listenprüfung);
  `options_from` ohne `default` ist dort ein Fehler.
- **Rollen:** die Optionen eines Skripts darf nur abrufen, wer starten darf (`operator`); GitHub-Optionen schon `viewer`
  (API: `GET /api/v1/workflows/:id/parameters/:name/options`); `refresh` (Cache umgehen) nur ab `operator`.
- **Drosselung:** GitHub-Optionen werden höchstens alle `max(30 s, cache)` neu geholt (auch mit „Reload“), Skripte
  höchstens alle 2 s.

```yaml
# example: dynamic-options
# extends: github
# file: workflows/release.yaml
id: release
name: Release
trigger: { type: manual }
parameters:
  branch:
    type: enum
    options_from: { github: branches, source: project_a }
    default: main
  tag:
    type: enum
    options_from: { github: tags, source: project_a, limit: 50 }
  target:
    type: enum
    options_from:
      command: scripts/list-hosts.sh
      args: ['--env', 'prod']
      timeout: 10s
      cache: 5m
    allow_custom: true
execute:
  type: shell
  command: scripts/deploy.sh
  args: ['{parameters.branch}', '{parameters.tag}', '{parameters.target}']
```

```sh
#!/bin/sh
# example: dynamic-options
# file: scripts/list-hosts.sh
# Eine Option pro Zeile – oder JSON: [{"value": "web-1", "label": "Web 1"}, "web-2"]
echo web-1
echo web-2
```

#### 3.4.8 `execute`

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `type` | `shell` \| `container` | ja | | | lokaler Prozess bzw. Wegwerf-Container (seit 0.3.0, s. u. „Container“) |
| `command` | String | bei `shell` ja | | §2.4 | Worker-Programm (bei `container`: Liste, s. u.) |
| `args` | Liste String | nein | `[]` | Templates, Modus `text`; nur `shell` | Argumente |
| `working_directory` | String | nein | `{workspace.base_dir}/{workflow.id}/{run.id}` | Modus `path`; beginnt mit `/` oder `{workspace.base_dir}` | Arbeitsverzeichnis = Workspace (`ADISPATCH_WORKSPACE`) |
| `create_directory` | Boolean | nein | `true` | | Verzeichnis anlegen; bei `false` muss es existieren (sonst `start_error`) |
| `env` | Map Name → String/Zahl/Boolean | nein | `{}` | Templates; kein `ADISPATCH_`-Präfix | zusätzliche Umgebungsvariablen |
| `secrets` | Map Name → `{ identity: <id>, delivery?: env\|file }` | nein | `{}` | Identity muss existieren; Name nicht zugleich in `env`; kein `ADISPATCH_`; bei `file` darf `<NAME>_FILE` weder in `env` noch als anderer Secret-Name vorkommen | Token der Identity für den Worker, s. u. „Secrets und Token-Dateien“ |
| `timeout.max_duration` | Dauer | nein | unbegrenzt | > 0 | Gesamtlaufzeit → `timed_out` |
| `timeout.idle_timeout` | Dauer | nein | unbegrenzt | > 0 | Zeit ohne Ausgabe auf stdout/stderr → `timed_out` (Warnung, wenn > `max_duration`) |
| `cancel_grace` | Dauer | nein | `30s` | | Wartezeit zwischen `SIGTERM` und `SIGKILL` an die Prozessgruppe bei Cancel/Timeout |
| `keep` | Liste String | nein | `[]` | relative Glob-Muster (`*`, `?`, `**`); nicht leer, nicht absolut, kein `..`, keine leeren Segmente, nicht auf `**` endend | Dateien, die nach dem Run nach `data-dir/runs/<run-id>/kept/` gesichert werden (s. u.) |
| `keep_max_size` | Größe | nein | `100MB` | > 0 (§2.2) | Obergrenze für die Summe der gesicherten Dateien pro Run |

Workspace-Regeln: Liegt der gerenderte Pfad strikt unter `workspace.base_dir`, wird er sicher angelegt
(Symlink-geprüft) und gemäß `workspace.cleanup` gelöscht. Liegt er außerhalb, wird er wie konfiguriert angelegt,
aber **nie** automatisch gelöscht. Der Pfad darf nicht `base_dir` selbst sein. Eine Warnung erscheint, wenn ein
`env`-Schlüssel nach Secret aussieht (`…_TOKEN`, `…PASSWORD`, `API_KEY`, …) und einen nicht-leeren Literalwert hat.

**Secrets und Token-Dateien** (`delivery`, seit 0.3.0): Jeder Eintrag unter `secrets` übergibt ein Token der
angegebenen Identity (GitHub App: Installation-Token, ca. 1 h gültig; `github_token`: der Token selbst).

| `delivery` | Variable(n) beim Prozess | Verhalten |
|---|---|---|
| `env` (Default, wie bis 0.2.0) | `<NAME>` = Token | Token wird beim Start einmal geholt und nur im Speicher gehalten; läuft der Prozess länger als das Token gilt, muss er sich selbst ein neues besorgen. |
| `file` | `<NAME>_FILE` = absoluter Pfad der Token-Datei; `<NAME>` selbst wird **nicht** gesetzt | Der Daemon schreibt das Token nach `data-dir/runs/<run-id>/secrets/<NAME>` (Verzeichnis `0700`, Datei `0600`, **außerhalb** des Workspaces) und ersetzt die Datei, solange der Prozess läuft, **atomar** (temporäre Datei + `rename` im selben Verzeichnis) spätestens **10 Minuten vor Ablauf** des Tokens. Identities ohne Ablauf (`github_token`) werden einmal geschrieben. |

Bei `file` gilt außerdem: Die Datei enthält nur das Token (ohne Zeilenumbruch). Scheitert das Erneuern (z. B.
GitHub nicht erreichbar), wird das ohne Token geloggt und mit Backoff (30 s, verdoppelt bis 5 min) erneut versucht;
der Worker läuft weiter, die alte Datei bleibt bis zum Ablauf des alten Tokens gültig. Scheitert schon das erste
Schreiben, endet der Run mit `start_error` (`on_start_error`). Nach dem Prozessende (jeder Endstatus) wird das
Verzeichnis gelöscht, nach einem Neustart räumt die Recovery Reste weg, die Retention entfernt bei jedem Lauf
übrig gebliebene Token-Verzeichnisse beendeter Runs. Jedes ausgegebene Token wird beim Redactor registriert, bevor
es in der Datei steht (stdout/stderr-Logs, Live-Output, Events, Ergebnis, Dienst-Log). Liegt der Workspace so, dass
das Token-Verzeichnis darin läge (Vergleich der aufgelösten Pfade, Symlinks werden verfolgt; z. B. Workspace unter
`<data-dir>/runs/`), endet der Run mit `start_error`. Wird das Verzeichnis während des Runs ersetzt (Symlink, anderes
Inode), enden die Erneuerungen; der Worker behält das alte Token.

**Isolation:** Die Rechte `0700`/`0600` schützen nur vor **anderen Systembenutzern**, nicht vor anderen Runs und Actions **desselben Dienstes**: Alle Worker laufen als derselbe Dienstbenutzer, die Pfade sind vorhersagbar – ein Worker kann die Token-Datei eines parallel laufenden Runs lesen (genauso wie unter Linux dessen Umgebung über `/proc/<pid>/environ` bei `delivery: env`). Wer hoch- und niedrig-privilegierte Workflows trennen muss, betreibt getrennte Instanzen unter getrennten Benutzern oder nutzt Container (WI-19).

Mit der GitHub CLI liest man das Token pro Aufruf aus der Datei:

```sh
GH_TOKEN=$(cat "$GH_TOKEN_FILE") gh pr create --fill
```

**Dateien sichern (`keep`):** Nach dem Abschluss-Hook und **vor** dem Workspace-Cleanup kopiert der Daemon alle
regulären Dateien, die auf ein Muster passen, mit ihrer relativen Struktur nach `data-dir/runs/<run-id>/kept/` – bei
**jedem** Endstatus (`completed`, `crashed`, `timed_out`, `cancelled`, `start_error` mit Workspace), auch wenn gar
nicht aufgeräumt wird. Muster sind relativ zum Workspace: `*` = beliebige Zeichen außer `/`, `?` = ein Zeichen außer
`/`, `**` als ganzes Segment = beliebig viele Verzeichnisebenen (auch keine); alles andere ist literal. Wildcards
passen auch auf Namen mit führendem Punkt (`**/*.log` findet `.agent/gate/unit.log`). Ein Muster ohne Treffer ist kein
Fehler. Ein Muster, das genau ein Verzeichnis benennt (`.agent/gate`), kopiert nichts und wird als übersprungen
(`directory`, Hinweis `.agent/gate/**/*`) vermerkt; Verzeichnisse, die nur über Wildcards passen, werden ignoriert.
Symlinks werden **nie** verfolgt (weder Datei- noch Verzeichnis-Links; passende Links werden als übersprungen
vermerkt), nur reguläre Dateien werden kopiert, und jede Datei wird vor dem Kopieren zusätzlich über ihren
aufgelösten Pfad geprüft. **Secrets werden beim Kopieren redigiert** – best effort, wie Logs: dieselbe
byteweise Ersetzung wie für stdout/stderr (auch über Lesegrenzen hinweg) mit den Secrets des Runs
(`execute.secrets`, bei `delivery: file` alle Tokens, die die Token-Datei je enthielt) und allen dem Daemon bekannten Tokens/Schlüsseln; umgewandelte Werte (base64, URL-kodiert …)
werden nicht erkannt, nach einem Neustart sind bereits abgelaufene Tokens nicht mehr bekannt. Was die Summe
`keep_max_size` überschreiten würde (gezählt werden die **geschriebenen** Bytes nach dem Redigieren), wird
übersprungen (kleinere spätere Dateien passen ggf. noch). Ergebnis als Run-Event `run.kept_files` (Anzahl, Bytes,
übersprungene Einträge mit Grund `size_limit`/`symlink`/`directory`/`not_regular_file`/…, Muster ohne Treffer,
Muster, die wegen der Grenze nicht durchsucht wurden), sichtbar in der UI (Run → **Files**) und über
`GET /api/v1/runs/:id/kept` ([api.md](api.md)). Die Dateien gehören zum Run und werden mit ihm von der Retention
gelöscht. Grenzen: höchstens 10 000 Dateien und 100 000 untersuchte Verzeichniseinträge pro Run; Muster ohne
Wildcards werden zuerst und ohne Verzeichnisauflistung geprüft und zählen nicht zur Grenze. Wildcard-Muster, die
nach Erreichen der Grenze nichts gefunden haben, gelten als „nicht durchsucht“ (`notSearched`), nicht als ohne Treffer.

**Container (`type: container`, seit 0.3.0):** Der Worker läuft in einem Wegwerf-Container. Der Daemon ruft die
Engine-CLI im Vordergrund auf (`<engine> run --rm …`) und überwacht diesen Prozess wie einen Shell-Worker: stdout/stderr,
Events (`@@ADISPATCH_EVENT`), Log-Limit, Timeouts, Ergebnisdatei und Klassifikation (§6.8) sind identisch, der
Exit-Code des Containers ist der Exit-Code. `working_directory`, `create_directory`, `env`, `secrets`, `timeout`,
`cancel_grace`, `keep` und `keep_max_size` gelten wie oben – der Workspace liegt weiterhin **auf dem Host** und wird in
den Container gemountet (Cleanup und `keep` arbeiten auf dem Host-Pfad). Zusätzliche Schlüssel:

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `image` | String | ja | | ohne Leerzeichen, nicht mit `-` beginnend | Image-Referenz, z. B. `localhost/worker:current` |
| `engine` | Enum | nein | `container.engine` aus `config.yaml` (Default `docker`) | `docker`, `podman` | Engine-CLI (Binary über den `PATH` des Dienstes) |
| `command` | Liste String | nein | `[]` (= Default-Kommando des Images) | Templates, Modus `text` | Kommando im Container |
| `workdir` | String | nein | Ziel des Workspace-Mounts | absolut, normalisiert, nicht `/`, nicht unter `/adispatch` | Arbeitsverzeichnis im Container (`--workdir`) |
| `mounts` | Liste `{ source, target, mode }` | nein | `[]` | s. u. | Bind-Mounts |
| `mounts[].source` | String | ja | | absolut, relativ zum **config-dir** oder `{workspace.path}` bzw. `{workspace.path}/<pfad>` (einziger erlaubter Platzhalter, kein `..`); statische Quellen müssen existieren; keine `,`/`"`/Zeilenumbrüche | Quelle auf dem Host |
| `mounts[].target` | String | ja | | absolut, normalisiert, nicht `/`, nicht `/adispatch` oder darunter, eindeutig | Ziel im Container |
| `mounts[].mode` | Enum | ja | | `ro`, `rw` | Nur-Lesen oder Lesen/Schreiben |
| `resources.memory` | String | nein | Engine-Default | z. B. `512m`, `8g`, `1.5g` | `--memory` |
| `resources.cpus` | Zahl | nein | Engine-Default | > 0, z. B. `3`, `1.5` | `--cpus` |
| `resources.pids` | Integer | nein | Engine-Default | ≥ 1 | `--pids-limit` |
| `user` | String | nein | `<uid>:<gid>` des Dienstbenutzers | `name`, `uid`, `name:group`, `uid:gid` | `--user`; bei `podman` zusätzlich `--userns keep-id` |
| `network` | String | nein | `default` | `default` (Engine-Default, kein Flag), `none` oder ein Netzwerkname (`[A-Za-z0-9][A-Za-z0-9_.-]*`; `container:<x>` ist damit ausgeschlossen) | `--network`. **Vorsicht `host`:** Der Container erreicht dann alles auf `127.0.0.1` des Hosts – auch die API des Daemons (mit `auth.mode: none` ohne Anmeldung, §3.1) und damit Start/Cancel beliebiger Runs. |
| `pull` | Enum | nein | `missing` | `never`, `missing`, `always` | `--pull` |

Aufruf (immer): `--rm --init --name adispatch-<run-id>`, Labels `adispatch.run=<run-id>`,
`adispatch.workflow=<id>`, `adispatch.instance=<hash>` (erste 16 Hex-Zeichen von SHA-256 über den absoluten
data-dir-Pfad – mehrere Instanzen räumen sich nie gegenseitig auf), `--cap-drop ALL --security-opt no-new-privileges`.
Mounts als `--mount type=bind,source=…,target=…[,readonly]`:

| Ziel im Container | Quelle auf dem Host | Modus |
|---|---|---|
| Ziel des Mounts mit `source: '{workspace.path}'`; fehlt er: `/work` (automatisch) | Workspace | `rw` (automatisch) bzw. wie konfiguriert |
| `/adispatch/context.json` (`ADISPATCH_CONTEXT_FILE`) | `data-dir/runs/<run-id>/context.json` | `ro` |
| `/adispatch/out/` (`ADISPATCH_RESULT_FILE` = `/adispatch/out/result.json`) | `data-dir/runs/<run-id>/out/` (leer angelegt) | `rw` |
| `/adispatch/secrets/` (nur bei `delivery: file`; `<NAME>_FILE` = `/adispatch/secrets/<NAME>`) | `data-dir/runs/<run-id>/secrets/` | `ro` |

So kann der Container weder die Daemon-Logs im Run-Verzeichnis noch andere Dateien außerhalb seines
Ausgabeverzeichnisses (und seiner eigenen `rw`-Mounts) verändern. `ADISPATCH_WORKSPACE` und `workspace.path` der
Kontextdatei sind der Container-Pfad des Workspaces. **Platzhalter:** In `command` und `env` steht
`{workspace.path}` für diesen Container-Pfad, in `mounts[].source` für den Host-Pfad; alle anderen Platzhalter
(auch `{source.vars.*}`, `{item.work_branch}`, `{item.work_pr}`) wie beim Shell-Executor.

**Umgebung:** Nur explizit. `env`-Einträge und `secrets` (`delivery: env`) gehen als `-e NAME` an die Engine, der
Wert steht nur in der Prozessumgebung des Engine-Aufrufs – **nie auf der Kommandozeile** (nicht in `ps`, nicht im
gespeicherten Run-Kommando). Ausnahme: `env`-Namen, die der Engine-Prozess selbst braucht (`PATH`, `HOME`, `LANG`,
`TZ`, `USER`, `LOGNAME`, `TMPDIR`, `DBUS_SESSION_BUS_ADDRESS`, `REGISTRY_AUTH_FILE`) und alle Namen, die die
Engine-CLI steuern würden (Präfixe `LD_`, `DYLD_`, `SSL_CERT_`, `DOCKER_`, `CONTAINER_`, `CONTAINERS_`, `XDG_`; Endung
`_PROXY`/`_proxy`, `NO_PROXY`/`no_proxy`; `GODEBUG`, `GOGC`, `GOMAXPROCS`, `GOMEMLIMIT`, `GOTRACEBACK`, `GORACE`,
`GOEXPERIMENT`), stehen als `-e NAME=wert` auf der Kommandozeile – im Container sind sie also gesetzt, beeinflussen
aber nie den Engine-Prozess; als `secrets`-Name sind sie verboten (Validierungsfehler). `ADISPATCH_*` stehen ebenfalls als
`-e NAME=wert` auf der Kommandozeile (keine Secrets). Der Engine-Prozess selbst bekommt die Minimalumgebung (§6.11)
plus `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `DOCKER_API_VERSION`,
`CONTAINER_HOST`, `CONTAINER_CONNECTION`, `CONTAINERS_CONF`, `CONTAINERS_STORAGE_CONF`, `XDG_RUNTIME_DIR`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `DBUS_SESSION_BUS_ADDRESS` aus der Dienstumgebung, falls gesetzt.

**Prüfungen direkt vor dem Start** (Verstoß → `start_error`, die Engine wird nicht aufgerufen): Quellen müssen
existieren; bei `{workspace.path}/<pfad>` darf kein Pfadsegment unterhalb des Workspaces ein Symlink sein und der
aufgelöste Pfad muss im Workspace liegen (`ln -s / ws/cache` wird abgelehnt); keine Quelle (auch nicht der Workspace)
darf das data-dir enthalten oder darin liegen – ausgenommen Pfade im Workspace, und ein Workspace unter dem data-dir
nur außerhalb von `runs/`, `logs/` und `backups/` (der Default `<data-dir>/workspaces` ist erlaubt).

**Cancel und Timeout:** `<engine> stop -t <cancel_grace in s> adispatch-<run-id>`; endet der Engine-Prozess danach
nicht innerhalb von 10 s, wird er wie ein Shell-Worker behandelt (SIGTERM → `cancel_grace` → SIGKILL an seine
Prozessgruppe). Nach **jedem** Ende des Engine-Prozesses folgt `<engine> rm -f adispatch-<run-id>` (ein bereits
entfernter Container ist kein Fehler); nach einem Stopp/Abbruch sucht der Daemon zusätzlich sofort und nach 2 s noch
einmal per `ps -a --filter label=adispatch.run=<run-id>` und entfernt, was die Engine noch spät angelegt hat (z. B.
Abbruch während des Image-Pulls).

**Ergebnisdatei:** Wie bei `shell` wird sie nie über Symlinks gelesen (Symlink, FIFO, ausgetauschtes Verzeichnis →
`crashed` mit Protokollfehler); Meldungen zu ungültigem JSON nennen nur die Position, nie den Inhalt. **Recovery nach Neustart:** Container dieser Instanz werden am Label
`adispatch.instance` gefunden (`<engine> ps -a --filter label=…`) und gestoppt – sowohl die von Runs, die als aktiv
galten (diese enden wie Shell-Runs nach einem Neustart, i. d. R. `crashed`; Event `recovery.container_stopped`), als
auch solche ohne aktiven Run. Laufende Container werden **nie übernommen** (wie beim Shell-Executor). Ist die Engine
dabei nicht erreichbar, bleiben betroffene Runs `recovery_pending` (Retry über API/UI, wenn die Engine wieder läuft).
**Fehler:** Engine-Binary fehlt → `start_error` (beim Daemon-Start zusätzlich eine Warnung im Log, nicht bei
`config validate`); Engine-Fehler wie „Image nicht gefunden“ (Exit 125) → `crashed`.


#### 3.4.9 `retry`

`retry.max_technical_failures` (Integer ≥ 1, Default 3): Nach so vielen **aufeinanderfolgenden** technischen
Fehlern (`crashed`, `start_error`, `timed_out`) derselben Workflow/Item-Kombination entsteht ein Retry-Block (§6.4).

#### 3.4.10 Hooks

Zehn Hooks als Listen von Actions plus die Map `on_result`; die Actions eines Hooks laufen **sequentiell**:

| Hook | läuft … |
|---|---|
| `on_start` | vor dem Start des Workers (nach Re-Read des Items). Scheitert die Kette, startet der Worker **nicht** (→ `start_error`). |
| `on_success` | nach `completed` + `success` (ohne passendes `on_result.<outcome>`) |
| `on_failure` | nach `completed` + `failure` (fachlich, gültige Ergebnisdatei; ohne passendes `on_result.<outcome>`) |
| `on_result.<outcome>` | nach `completed`, wenn die Ergebnisdatei `"outcome": "<outcome>"` enthält und der Eintrag existiert – **statt** `on_success`/`on_failure` |
| `on_crash` | nach `crashed` |
| `on_start_error` | nach `start_error` (sofern der Run `starting` erreicht hat) |
| `on_cancel` | nach `cancelled` (sofern der Run `starting` erreicht hat) |
| `on_timeout` | nach `timed_out` |
| `on_error` | nach `crashed`, `start_error`, `timed_out` oder `cancelled`, wenn der jeweilige Hook oben **nicht definiert** ist |
| `on_retry_block` | seit 0.6.0: im Run, dessen technischer Fehler gerade einen Retry-Block erzeugt hat – **nach** dessen Abschluss-Hook |
| `on_retry_unblock` | seit 0.6.0: nach dem Aufheben eines Retry-Blocks, in einem eigenen Lifecycle-Run (Trigger `unblock`) |

Genau ein Abschluss-Hook pro Run; Details in §6.8. `source.update`/`source.comment` nur in Source-Workflows.
`on_retry_block`/`on_retry_unblock` sind keine Abschluss-Hooks; sie kommen zusätzlich hinzu (unten).

**Benannte Ergebnisse (`on_result`).** Für Workflows mit mehr als zwei fachlichen Ausgängen (z. B. `approved`,
`changes_requested`, `needs_maintainer`). Der Worker schreibt zusätzlich zu `result` ein `outcome` in die
Ergebnisdatei ([worker-protocol.md](worker-protocol.md)); `result` bleibt Pflicht und steuert weiter Statistik und
Retry-Zähler (`success` setzt zurück, `failure` lässt unverändert). Ohne `outcome` oder ohne passenden Eintrag gilt
das bisherige Verhalten (`on_success`/`on_failure`); ein `outcome` ohne Eintrag ist kein Fehler, der Run bekommt
eine Warnung (Event `run.outcome_warning`). Ein `outcome` im falschen Format wird ignoriert (ebenfalls Warnung).
Ein leerer Eintrag (`wont_fix: []`) ist definiert: dann läuft gar nichts. Das Journal nennt die Kette
`on_result.<outcome>`, generierte Action-IDs lauten `on_result.<outcome>.<index>`.

**Sammel-Hook (`on_error`).** Für einen technischen Ausgang läuft der spezifische Hook (`on_crash`, `on_start_error`,
`on_timeout`, `on_cancel`), wenn er **definiert** ist – auch eine leere Liste zählt als definiert –, sonst
`on_error`. Nie beides. Sind alle vier spezifischen Hooks definiert, warnt die Validierung, dass `on_error` nie
läuft. Typisch: eine gemeinsame Aufräum-Kette in `on_error` und nur Abweichungen (z. B. `on_timeout`) separat.

Der gewählte Abschluss-Hook wird beim Übergang nach `finalizing` am Run gespeichert (`completionHook` in API/UI);
nach einem Neustart setzt die Recovery genau diese Kette fort.

**Retry-Block-Hooks (`on_retry_block`, `on_retry_unblock`, seit 0.6.0).** Nach `retry.max_technical_failures`
technischen Fehlern in Folge entsteht ein Retry-Block (§6.4). Beide Hooks sind optional (fehlt der Schlüssel, läuft
nichts) und nehmen dieselben Actions wie die übrigen Hooks (§3.4.11, inkl. `id`, `continue_on_error`, `retry`,
`secrets`); Action-IDs `on_retry_block.<index>` bzw. `on_retry_unblock.<index>`, workflowweit eindeutig. In
`{block.*}` (§5.1) stehen ID, Fehlerzahl, Zeitpunkt und letzter Status des Blocks, in `on_retry_unblock` zusätzlich
`{block.cleared_at}`/`{block.cleared_by}`. Der Name ist bewusst nicht `on_block`: „blocked“ meint im Filter
GitHub-Abhängigkeiten (`dependencies.blocked`).

- **`on_retry_block`** läuft im Run, dessen Übergang nach `finalizing` den Block erzeugt hat, als **eigene Kette
  nach** dem Abschluss-Hook (`on_crash`/`on_start_error`/`on_timeout`/`on_error`): So kann der Fehler-Hook z. B. ein
  Label zurücksetzen, und `on_retry_block` setzt danach den Block-Zustand, ohne überschrieben zu werden. Er läuft auch,
  wenn der Abschluss-Hook endgültig gescheitert ist, und auch bei `start_error` **ohne** Hooks (§6.5, z. B. Source
  nicht erreichbar). Er läuft nicht, wenn kein Block entsteht (Grenze nicht erreicht oder Block schon aktiv, z. B. bei
  einem manuellen Start trotz Block). Die Entscheidung wird mit `→ finalizing` am Run gespeichert
  (`retryBlockHook` in API/UI); die Recovery setzt eine unterbrochene Kette fort.
- **`on_retry_unblock`** läuft, wenn der Block aufgehoben wird (UI „Remove Block“, `POST /api/v1/blocks/:id/clear`).
  Dabei gibt es keinen Run; deshalb legt das Aufheben in **derselben Transaktion** einen **Lifecycle-Run** an: Trigger
  `unblock`, kein Worker, kein Workspace, nur diese Kette, Konfiguration = beim Aufheben geladene Workflow-Datei.
  Er hält das Lock für `(Workflow, Item)` bis die Kette fertig ist (bei Blocks ohne Item: kein Cron-Start und kein
  manueller Start ohne Item, solange er läuft – `409 unblock_run_active`), zählt nicht als technischer Fehler, setzt den Zähler nicht zurück, zählt nicht zu den Limits
  (`max_concurrent`) und nicht als „letzter Run“ in Views (`run.last_*`). Endstatus `completed` + `success`, wenn
  alle Actions gelangen, sonst `completed` + `failure` (endgültiges Scheitern → `lifecycle_action_failed`); der Block
  bleibt in jedem Fall aufgehoben. In UI/API erscheint er wie jeder Run (Journal, Retry/Skip einzelner Actions,
  Recovery nach Neustart), lässt sich aber nicht abbrechen. Läuft für `(Workflow, Item)` gerade ein Run (z. B. ein
  manueller Start trotz Block), wird das Aufheben mit nicht leerem `on_retry_unblock` mit `409 block_run_active`
  abgelehnt; mit leerem oder fehlendem Hook verhält sich das Aufheben wie bisher (kein Run, auch bei laufendem Run).
  Ist der Workflow nicht mehr konfiguriert, wird ohne Hook aufgehoben.
- **Workflows ohne Item** (Blocks im Workflow-Scope, z. B. Cron): nur `shell`-Actions; `source.*` ist wie in den
  übrigen Hooks ein Konfigurationsfehler.

```yaml
# example: retry-block-hooks
# extends: github
# file: workflows/retry-block-hooks.yaml
id: retry-block-hooks
trigger: { type: source, source: project_a }
execute: { type: shell, command: /bin/true }
retry: { max_technical_failures: 3 }
on_crash:
  - type: source.update
    labels: { add: [ready], remove: [in-progress] }
on_retry_block:                 # Block ist gerade entstanden – läuft nach on_crash
  - type: source.update
    labels: { add: [agent-blocked], remove: [ready] }
  - type: source.comment
    message: 'Nach {block.failures} technischen Fehlern blockiert (zuletzt {block.last_status}, Run {run.id}).'
  - type: shell
    command: /bin/echo
    args: ['{item.key}', '{block.failures}']
on_retry_unblock:               # Block wurde aufgehoben – eigener Lifecycle-Run (Trigger unblock)
  - type: source.update
    labels: { add: [ready], remove: [agent-blocked] }
  - type: source.comment
    message: 'Block {block.id} aufgehoben von {block.cleared_by}.'
```

#### 3.4.11 Actions

Gemeinsame Schlüssel aller Actions:

| Schlüssel | Typ | Pflicht | Default | Bedeutung |
|---|---|---|---|---|
| `type` | Enum | ja | | `source.update`, `source.comment`, `shell` |
| `id` | Konfigurations-ID | nein | `<hook>.<index>` (z. B. `on_success.1`, `on_result.approved.0`, `on_retry_block.0`) | stabiler Name im Journal; **workflowweit** eindeutig |
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
| `secrets` | Map Name → `{ identity, delivery? }` | nein | `{}` | wie `execute.secrets` (seit 0.3.0), dieselben Regeln |
| `timeout` | Dauer | nein | `5m` | Laufzeitlimit pro Versuch (> 0) |

Erfolg = Exit 0; alles andere (Exit ≠ 0, Signal, Timeout, Startfehler) = gescheiterter, wiederholbarer Versuch.
Arbeitsverzeichnis: der Run-Workspace, falls er existiert, sonst ein eigenes Verzeichnis pro Versuch
unter `data-dir/runs/<run>/actions/…`. SIGTERM→SIGKILL-Frist fest 5 s, Log-Limit fest 10 MiB pro Versuch.

**Secrets für Shell-Actions** (seit 0.3.0): `secrets` wie bei `execute` (§3.4.8), in allen Hooks einschließlich
`on_result.<outcome>`, `on_error`, `on_retry_block` und `on_retry_unblock`. Tokens werden **pro Versuch**
geholt. Bei `delivery: file` liegt die Datei in einem action-eigenen Verzeichnis
`data-dir/runs/<run>/actions/<action>/attempt-<n>/secrets/<NAME>`, wird bei langen Actions ebenso erneuert und
nach dem Versuch gelöscht. Werte werden im Action-Log redigiert. Scheitert das Holen des Tokens, scheitert der
Versuch (wiederholbar je nach Fehlerart, z. B. `transient` ja, `auth` nein); die Action startet dann nicht. Ohne
deklarierte `secrets` bekommt eine Shell-Action wie bisher keine Tokens.

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
  - { field: history, label: Verlauf }         # Link auf die Seite „Item-Verlauf“ (seit 0.9.0, §4.8)
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
| `fields[].field` | String | ja | | muss im Feldkatalog des Adaptertyps oder in §4.8 stehen; `project.*` nur, wenn **alle** Sources der View es mit gleicher Art deklarieren (§4.7.1) | Feldname (§4.7, §4.8); `object[]`-Felder (`closing_prs`) erscheinen als Liste, z. B. `#12 open, #9 merged`, jeder Eintrag als Link auf seine `url`; `history` (seit 0.9.0) erscheint als Link „History →“ auf den Item-Verlauf, auch in Abschnitten und Dashboard-View-Widgets |
| `fields[].label` | String | nein | Feldname | | Spaltenüberschrift |
| `fields[].link` | String (Feldname, geprüft wie `field`) | nein | `link` der Felddefinition (`number`, `title` → `url`; `work_pr` → `work_pr_url`, also der PR) | | Feld, dessen Wert (nur absolute `http(s)`-URL) als Link dient |
| `sort` | Sortierschlüssel oder Liste von 1–5 Sortierschlüsseln (seit 0.5.0) | nein | Item-Schlüssel | | erster Schlüssel entscheidet, bei Gleichstand der nächste, zuletzt der Item-Schlüssel (natürlich) |
| `sort[].field` | String | ja (je Schlüssel) | | geprüft wie `fields[].field`; kein `object[]`-Feld (`Views cannot be sorted by "closing_prs" (type object[])`), nicht `history` (`Views cannot be sorted by "history": it is a link column …`) | Sortierfeld |
| `sort[].direction` | Enum | nein | `asc` | `asc`, `desc` | leere Werte immer zuletzt; mit `order` kehrt `desc` die Liste um |
| `sort[].order` | Liste String (seit 0.5.0) | nein | | 1–100 Werte, eindeutig; nur Felder vom Typ `string` (§3.5.1) | eigene Wertereihenfolge |
| `group_by_first` | Boolean (seit 0.5.0) | nein | `false` | erster Sortierschlüssel (der View oder eines Abschnitts) braucht `order` | Gruppenzeile je Wert des ersten Schlüssels |
| `sections` | Liste (seit 0.5.0) | nein | | 1–20 Abschnitte (§3.5.2) | Teil-Tabellen mit Überschrift |
| `exclusive` | Boolean | nein | `true` | nur mit `sections` (sonst Warnung) | ein Item nur im ersten passenden Abschnitt |
| `hide_empty_sections` | Boolean | nein | `false` | nur mit `sections` (sonst Warnung) | leere Abschnitte ausblenden statt „No entries.“ |

Laden: beim Öffnen/Refresh aus allen Sources (parallel; eine fehlerhafte Source erscheint als Fehlerzeile, die
anderen liefern trotzdem), Cache 30 s, max. 2 000 Zeilen (mit Abschnitten je Abschnitt). Nicht auflösbare Felder (z. B. fehlende API-Rechte) bleiben erkennbar leer; unbekannte Feldnamen sind bereits
ein Konfigurationsfehler (§4.3). Im Browser lässt sich jede Tabelle per Spaltenklick umsortieren (nur lokal);
„Default order“ stellt die konfigurierte Sortierung wieder her.

#### 3.5.1 Sortierung nach eigener Wertereihenfolge (seit 0.5.0)

Für Felder mit festen Werten (`project.*` der Arten `single_select`, `text`, `iteration`, aber auch `state`,
`issue_type`, `run.last_status`, …) ist alphabetisch selten die gewünschte Reihenfolge. Mit `order` wird nach der
Position des Werts in der Liste sortiert:

- gelistete Werte in Listenreihenfolge (`direction: desc` kehrt sie um), danach **nicht gelistete** Werte
  untereinander in natürlicher Reihenfolge (wie ohne `order`, Großbuchstaben vor Kleinbuchstaben), ganz zuletzt
  **leere/unbekannte** Werte – in beiden Richtungen;
- Vergleich mit Groß-/Kleinschreibung (`Review` ≠ `review`);
- nur Felder vom Typ `string`; Listenfelder wie `labels` (`string[]`), Zahlen und Daten sind ein Fehler;
- Werte, die ein `single_select`-Projektfeld laut Projekt-Metadaten nicht als Option kennt, ergeben beim Laden
  der View eine **Warnung** im Ergebnis (`warnings`, in der UI als Hinweis), keinen Fehler. `config validate`
  kennt die Metadaten nicht und prüft das nicht.

`sort` als einzelnes Objekt bleibt gültig (ein Schlüssel). Die API liefert `sort` immer als Liste.

#### 3.5.2 Abschnitte (seit 0.5.0)

Mit `sections` zeigt eine View mehrere Tabellen untereinander, jede mit Überschrift und Zeilenzahl. Die Sources
werden **einmal** gelesen (View-`filter` wie bisher, inkl. Pushdown); jeder Abschnitt filtert die Items der View
lokal (Abschnittsfilter und View-Filter sind per `all` verknüpft).

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `sections[].title` | String | ja | | 1–80 Zeichen, eindeutig in der View | Überschrift |
| `sections[].filter` | Filter-AST oder ID eines benannten Filters | genau eins von `filter` / `rest: true` | | §4 inkl. `run.last_*`; `state` nur lokal (s. u.) | Items des Abschnitts |
| `sections[].rest` | Boolean | | `false` | höchstens ein Abschnitt | alle Items der View, die in keinem anderen Abschnitt stehen |
| `sections[].sort` | wie `sort` | nein | `sort` der View | wie `sort` | eigene Sortierung |
| `sections[].fields` | wie `fields` | nein | `fields` der View | wie `fields` | eigene Spalten |

- **`exclusive: true`** (Default): die Reihenfolge der Abschnitte entscheidet, ein Item steht nur im ersten
  passenden. **`exclusive: false`**: ein Item steht in jedem passenden Abschnitt; `rest` enthält dann die Items, die
  in keinem anderen stehen.
- Ergibt ein Abschnittsfilter `unknown`, wird das Item bei diesem Abschnitt gezählt (`counts.filterUnknown`) und
  **nie woandershin verschoben** (es könnte in diesen Abschnitt gehören): mit `exclusive: true` endet die Auswertung
  dort, das Item erscheint in keinem Abschnitt (auch nicht in `rest`); mit `exclusive: false` steht es in den
  Abschnitten, deren Filter `true` ergibt, aber nie in `rest`.
- Die Feldliste je Item umfasst alles, was irgendein Abschnitt braucht (View- und Abschnittsfilter, Spalten aller
  Abschnitte, Link-Felder, Sortierschlüssel): sobald für ein Item ein teures Feld (§4.7.2) gebraucht wird, werden
  alle teuren Felder dieser Liste in einer Abfrage mitgelesen – auch die Spalten von Abschnitten, in denen das Item
  am Ende nicht steht.
- **`state` in Abschnittsfiltern** wirkt nur lokal (kein Pushdown, keine eigene Abfrage): welche Items gelesen
  werden, bestimmt allein der View-`filter` (ohne `state`-Prädikat nur offene, §4.5). Ein Abschnitt, der nach
  Werten fragt, die die View nie liest (z. B. `state equals closed` bei einer View ohne `state`-Selektor), ist ein
  Fehler; Lösung: `state in [open, closed]` im View-`filter`. Anders als im View-`filter` darf `state` im Abschnitt
  auch unter `any`/`not` stehen.
- Ohne `sections` verhält sich die View genau wie vor 0.5.0.

```yaml
# example: view-pipeline
# extends: projects
# file: views/pipeline.yaml
id: pipeline
title: Pipeline
sources: [project_a, project_b]
fields:
  - { field: repository, label: Repository }
  - { field: number, label: Nr. }
  - { field: title, label: Titel, link: url }
  - { field: project.Status, label: Status }
  - { field: created_at, label: Erstellt }
sort:
  - field: project.Status
    order: [Todo, Ready, In Progress, Review, Done]
  - field: created_at
    direction: asc
group_by_first: true                 # Gruppenzeile je Status
exclusive: true                      # Default: nur im ersten passenden Abschnitt
sections:
  - title: Braucht Maintainer
    filter: { field: labels, operator: contains, value: needs-maintainer }
  - title: Review
    filter: { field: project.Status, operator: equals, value: Review }
    sort: { field: updated_at, direction: desc }      # überschreibt die Sortierung der View
  - title: In Arbeit
    filter: { field: project.Status, operator: in, value: [Ready, In Progress] }
    fields:                                            # überschreibt die Spalten
      - { field: number, label: Nr. }
      - { field: title, label: Titel, link: url }
      - { field: run.last_status, label: Letzter Run }
  - title: Übrige
    rest: true
hide_empty_sections: false
```

![View mit Abschnitten, Wertereihenfolge und Gruppenzeilen](https://raw.githubusercontent.com/brokoskokoli/adispatchd/main/docs/screenshots/view-sections.png)

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
  als 16 Ebenen, mehr als 10 000 Knoten nach dem Einsetzen (§3.8), `use` mit weiteren Schlüsseln oder ohne gültige ID.
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

### 3.7 dashboard.yaml

Optionale Datei mit **Info-Kacheln** für den Dashboard-Bereich „Information“ (seit 0.4.0) und dem **Layout** des
Dashboards (`layout`, seit 0.8.0, §3.7.1). Jede Kachel ist ein vertrauenswürdiges Skript wie eine Condition; seine
erste Ausgabezeile ist der angezeigte Wert. Fehlt die Datei, gibt es keinen Info-Bereich und das Standard-Layout gilt.

```yaml
# example: dashboard
# extends: minimal
# file: dashboard.yaml
info:
  - id: data-disk                     # Pflicht, eindeutig
    title: Plattenbelegung data-dir   # optional, Default: id
    type: percent                     # text | number | percent
    command: scripts/info/data-disk.sh
    timeout: 10s
    cache: 5m                         # so lange gilt der Wert; danach im Hintergrund neu abrufen
    warn_above: 80                    # gelb ab 80
    critical_above: 95                # rot ab 95
  - id: open-prs
    title: Offene PRs
    type: number
    command: scripts/info/open-prs.sh
    args: [--state, open]
    env: { REPOSITORY: example/repo }
    unit: PRs
    cache: 10m
    warn_below: 1
```

```sh
#!/bin/sh
# example: dashboard
# file: scripts/info/data-disk.sh
# Wert auf der ersten stdout-Zeile, Exit 0.
df -P "${ADISPATCH_DATA_DIR:-.}" | awk 'NR == 2 { sub("%", "", $5); print $5; exit }'
```

```sh
#!/bin/sh
# example: dashboard
# file: scripts/info/open-prs.sh
# Anzahl offener PRs; Argumente kommen ohne Shell an ("$1" = --state, "$2" = open).
set -eu
gh pr list --repo "$REPOSITORY" "$1" "$2" --json number --jq length
```

| Schlüssel | Typ | Pflicht | Default | Regeln | Bedeutung |
|---|---|---|---|---|---|
| `info` | Liste | nein | `[]` | höchstens 50 Kacheln | Kacheln in Anzeigereihenfolge |
| `layout` | Liste | nein | Standard-Layout | §3.7.1 | Anordnung des Dashboards (seit 0.8.0) |
| `info[].id` | Konfigurations-ID | ja | | eindeutig in der Datei | ID (API, Refresh) |
| `info[].title` | String | nein | `id` | 1–80 Zeichen | Überschrift der Kachel |
| `info[].type` | `text` \| `number` \| `percent` | ja | | | wie die Ausgabe gelesen wird (unten) |
| `info[].command` | String | ja | | §2.4; ein Pfad (absolut oder mit `/`) **muss existieren** | Skript |
| `info[].args` | Liste String | nein | `[]` | keine Templates | Argumente (ohne Shell) |
| `info[].env` | Map | nein | `{}` | Namen ohne Präfix `ADISPATCH_`; geheim wirkende Namen mit Literalwert → Warnung | zusätzliche Umgebung |
| `info[].timeout` | Dauer | nein | `15s` | > 0, höchstens `5m` und nicht länger als `cache` | danach Fehler, Prozessgruppe wird beendet |
| `info[].cache` | Dauer | nein | `5m` | ≥ 10s | Gültigkeit eines Werts |
| `info[].unit` | String | nein | | max. 20 Zeichen; nur `number` | Einheit hinter der Zahl (`percent` zeigt immer `%`) |
| `info[].warn_above` / `critical_above` | Zahl | nein | | nur `number`/`percent`; `critical_above` ≥ `warn_above`; bei `percent` außerhalb 0–100 → Warnung | gelb/rot, wenn Wert **≥** Schwelle |
| `info[].warn_below` / `critical_below` | Zahl | nein | | nur `number`/`percent`; `critical_below` ≤ `warn_below` | gelb/rot, wenn Wert **≤** Schwelle |

**Ausgabe:** erste nicht-leere stdout-Zeile, getrimmt. `text`: beliebiger Text (auf 200 Zeichen gekürzt, als Text
dargestellt, redigiert). `number`: Dezimalzahl mit Punkt (`42`, `-1.5`), optional gefolgt von der konfigurierten
`unit` (`12.5 GB`). `percent`: Zahl 0–100, optional mit `%`, Anzeige mit Balken. Exit ≠ 0, Timeout, Signal,
Startfehler oder eine unlesbare Ausgabe → Fehlerzustand mit kurzer Meldung (`exit code 2: <erste stderr-Zeile>`,
`timed out after 10000ms`, `unparsable output "…"`); Werte, Meldungen und stderr-Zeilen werden von ANSI-Escapes,
Steuer- und Bidi-Zeichen bereinigt, dann redigiert und erst dann gekürzt;
der letzte gültige Wert bleibt mit Zeitstempel sichtbar („stale“). Rot (`critical`) hat Vorrang vor Gelb (`warn`);
`above` und `below` dürfen kombiniert werden.

**Ausführung:** Der Daemon führt die Skripte **nur im Hintergrund** aus: einmal beim Start (nach der Recovery),
wenn ein Wert abgelaufen ist (`cache`), nach einem Fehler erneut nach `min(cache, 60s)`, und nach einem Reload für
neue/geänderte Kacheln – **nie** durch einen Seitenaufruf. Der „Refresh“-Knopf je Kachel
(`POST /api/v1/dashboard/info/:id/refresh`) stößt einen sofortigen Abruf an; er ist gedrosselt (je Kachel höchstens
alle 10 s, insgesamt 20 je Minute; sonst HTTP 429) und unterliegt denselben CSRF-/Host-/Origin-Regeln wie jede
schreibende Anfrage. Höchstens eine Ausführung je Kachel gleichzeitig, insgesamt höchstens 2 parallel (weitere
warten). Mechanik wie Conditions: Argumentliste ohne Shell, Minimalumgebung + `env` + Kontext (§6.11),
Arbeitsverzeichnis = config-dir, Timeout mit Beenden der Prozessgruppe, Ausgabe bis 4 KiB je Stream.

**Prüfung beim Laden:** Schema (unbekannte Schlüssel mit „did you mean …“), eindeutige IDs, Schwellwerte nur bei
`number`/`percent` und in sinnvoller Reihenfolge, `unit` nur bei `number`, `cache` ≥ 10 s, `timeout` ≤ 5 min und
≤ `cache`, reservierte
Env-Namen, Existenz des Skripts (Pfade relativ zum config-dir). Die Datei ist Teil des Konfigurations-Hashs und der
Dateiliste (`GET /api/v1/config/files`, UI: Configuration); `config reload` lädt sie mit (§1.5).

#### 3.7.1 `layout`: Dashboard frei anordnen (seit 0.8.0)

Optionaler Schlüssel `layout`: **was** in **welcher Anordnung** auf dem Dashboard erscheint – Reihen aus Spalten aus
Widgets, dazu Views (§3.5) und Reiter (`tabs`) als Bausteine. Fehlt `layout` (oder die ganze Datei), gilt das
**Standard-Layout**, das genau dem Dashboard bis 0.7.0 entspricht:

```yaml
# Standard-Layout (gilt ohne „layout“)
layout:
  - row: [resources]
  - row: [info]                      # nur sichtbar, wenn dashboard.yaml existiert
  - row: [scheduler, capacity, attention]
  - row: [active_runs]
  - row: [recent_runs]
```

Beispiel mit Spalten, Breiten, Titeln, View-Widgets und Reitern:

```yaml
# example: dashboard-layout
# extends: view-pipeline
# file: dashboard.yaml
info:
  - { id: data-disk, title: Plattenbelegung, type: percent, command: echo, args: ["42"] }
  - { id: open-prs, title: Offene PRs, type: number, command: echo, args: ["7"] }

layout:
  - row: [resources]
  - title: Arbeit                               # optionale Überschrift über der Reihe
    row:
      - column: [scheduler, attention]          # Spalte: Widgets untereinander
        width: 1
      - column:
          - { widget: view, view: pipeline, sections: [Braucht Maintainer, Review], limit: 15 }
        width: 3                                # relative Breite
  - row:
      - { widget: info, ids: [open-prs] }
      - { widget: recent_runs, limit: 5, title: Zuletzt fertig, workflows: [coder, reviewer] }
  - row:
      - widget: tabs                            # Reiter; Unter-Reiter bis Tiefe 3
        default: runs                           # anfangs offener Reiter (Default: der erste)
        tabs:
          - title: Pipeline                     # ID aus dem Titel: „pipeline“
            layout:
              - row: [{ widget: view, view: board, refresh: 2m }]
          - { title: Runs, layout: [{ row: [active_runs, recent_runs] }] }
          - title: Projekte
            layout:
              - row:
                  - widget: tabs
                    tabs:
                      - { title: Maintainer, id: maint, layout: [{ row: [{ widget: view, view: needs-maintainer }] }] }
                      - { title: Kapazität, layout: [{ row: [capacity] }] }
```

![Dashboard mit eigenem Layout: Spalten, Reiter und View-Widget](https://raw.githubusercontent.com/brokoskokoli/adispatchd/main/docs/screenshots/dashboard-layout.png)

**Struktur**

| Schlüssel | Typ | Regeln | Bedeutung |
|---|---|---|---|
| `layout` | Liste von Reihen | 1–30 Reihen | ohne Schlüssel: Standard-Layout |
| `layout[].row` | Liste von Elementen | 1–6 Elemente | ein Element ist ein **Widget** oder eine **Spalte** |
| `layout[].title` | String | 1–80 Zeichen | Überschrift über der Reihe |
| `…row[].column` | Liste von Widgets | 1–20 Widgets | Widgets untereinander |
| `…row[].width` | Integer | 1–12, Default 1 | relative Breite der Spalte (CSS-Grid `fr`); auch an einem Widget direkt in der Reihe erlaubt, nicht an Widgets in einer Spalte |
| Widget | String oder `{ widget: <Name>, title?, …Optionen }` | | `title` (1–80 Zeichen) ersetzt die Überschrift; ohne: die bisherige Überschrift bzw. der Name der View |

Ein Widget direkt in der Reihe ist eine Spalte mit genau diesem Widget. Auf schmalen Bildschirmen (< 900 px) stehen
alle Spalten untereinander. Jedes Widget darf mehrfach vorkommen; insgesamt höchstens **100 Widgets** (inklusive
der Widgets in Reitern und der `tabs`-Widgets selbst). `scheduler`, `capacity`, `attention`, `active_runs` und
`recent_runs` dürfen fehlen – die Funktionen bleiben über die anderen Seiten erreichbar. Hinweise (Drain läuft,
nicht bereit, ungeschützte Bindung) erscheinen **immer** oben, unabhängig vom Layout.

**Widgets**

| Name | Inhalt | Optionen |
|---|---|---|
| `resources` | kompakte Ressourcenleiste, Klick → Reiter „Resources“ | – |
| `resources_full` | große Ressourcenansicht wie im Reiter „Resources“ (Verlauf, Prozesse) | – |
| `info` | Info-Kacheln aus `info` | `ids`: Liste von Kachel-IDs (Default: alle, in Dateireihenfolge) |
| `scheduler` | Zustand, Pause/Resume, Drain, Cancel All | – |
| `capacity` | Kapazität, Limit-Override, Auslastung je Workflow | – |
| `attention` | Retry-Blocks, gescheiterte Actions/Notifications | – |
| `active_runs` | laufende Runs | `limit` (1–100, Default 100), `workflows` (Liste von Workflow-IDs; Default: alle) |
| `recent_runs` | zuletzt beendete Runs | `limit` (1–50, Default 10), `workflows` |
| `view` | eine View (§3.5) mit voller Funktion: Abschnitte, Sortierung im Browser, Gruppenzeilen, „act…“ öffnet das Item-Panel mit allen Aktionen, „Refresh“, Link „Open view →“; gekürzte Tabellen enden mit „N more …“ | `view` (Pflicht, View-ID), `sections` (Abschnitts-Titel; Default: alle), `limit` (Zeilen je Abschnitt bzw. Tabelle, 1–200, Default 50), `refresh` (Dauer ≥ 15s, Default 60s) |
| `tabs` | Reiter, jeder mit eigenem Layout | `tabs` (Pflicht, 1–12 Einträge), `default` (ID des anfangs offenen Reiters) |

Ein Reiter ist `{ title, id?, layout }`: `title` Pflicht (1–40 Zeichen, eindeutig im `tabs`-Widget), `id`
optional (Konfigurations-ID; Default: Slug des Titels – klein, Umlaute als `ae`/`oe`/`ue`/`ss`, andere Zeichen als
`-`), `layout` Pflicht mit derselben Struktur wie oben (rekursiv). Reiter-IDs müssen unter allen `tabs`-Widgets
**desselben Layouts** eindeutig sein (die URL adressiert einen Reiter über seinen Pfad aus IDs); `tabs` lassen sich
höchstens 3 Ebenen tief schachteln. `view` und `tabs` brauchen Optionen und haben keine Kurzform als String.

**Verhalten**

- **Views** laden wie die View-Seite (`GET /api/v1/views/:id/items` mit `sections`/`limit`, gleicher 30-s-Cache
  und gleiche GitHub-Kosten); mehrere Widgets derselben View teilen sich **eine** Abfrage (Vereinigung der
  Abschnitte, größtes `limit`), die im kürzesten `refresh` der Widgets wiederholt wird. Views folgen keinen
  Live-Ereignissen.
- **Reiter sind lazy:** Widgets inaktiver Reiter werden nicht gerendert, laden nichts, pollen nicht und abonnieren
  nichts; Umschalten montiert den neuen Reiter und gibt den alten frei. Der gewählte Reiter steht im URL-Hash
  (`#/?tab=projekte/maint` – Pfad aus Reiter-IDs, mehrere Reiter-Widgets durch Komma getrennt; teilbar, Zurück-Knopf)
  und wird je Betrachter im `localStorage` des Browsers gemerkt (URL vor gemerktem Wert vor `default`). Die
  Reiterleiste ist per Tastatur bedienbar (←/→, Pos1/Ende) und scrollt auf schmalen Bildschirmen horizontal.
- Ein Widget mit Fehler (z. B. View nicht ladbar) zeigt den Fehler nur in seiner Karte. Rollen wie bisher: viewer
  sieht alles, Steuerknöpfe brauchen operator.
- Nach `config reload` lädt das Dashboard das Layout neu.

**Prüfung beim Laden** (auch `config validate`, Reload): Schema mit Pfad (z. B.
`layout[1].row[0].tabs[2].layout[0].row[0]`) und „did you mean …“ für unbekannte Schlüssel und Widget-Namen; leere
`layout`/`row`/`column`/`tabs` sind Fehler; Grenzen wie oben; `view` muss existieren, `sections` nur bei Views mit
Abschnitten und jeder Titel muss existieren; `info.ids` und `workflows` müssen existieren; `default` muss eine
Reiter-ID des Widgets sein. **Warnungen:** `info` im Layout ohne Info-Kacheln; `resources`/`resources_full` bei
`monitoring.enabled: false`.

```yaml
# example: dashboard-layout-invalid
# extends: view-pipeline
# file: dashboard.yaml
# invalid
# expect: dashboard.yaml: layout[0].row[0]: Invalid option
# expect: dashboard.yaml: layout[0].row[1].view: Unknown view "pipline" (did you mean "pipeline"?)
# expect: dashboard.yaml: layout[0].row[2].sections[0]: View "pipeline" has no section "Reveiw" (did you mean "Review"?)
# expect: dashboard.yaml: layout[0].row[3].workflows[0]: Unknown workflow "codr" (did you mean "coder"?)
# expect: dashboard.yaml: layout[1].row: A row needs at least one widget or column
# expect: dashboard.yaml: layout[2].row[0].tabs[1].title: Duplicate tab title "A" (also used by tabs[0])
# expect: dashboard.yaml: layout[2].row[0].default: Unknown tab "c" (tab IDs: a)
layout:
  - row:
      - schedulr                                    # Tippfehler → did you mean "scheduler"
      - { widget: view, view: pipline }
      - { widget: view, view: pipeline, sections: [Reveiw] }
      - { widget: active_runs, workflows: [codr] }
  - row: []
  - row:
      - widget: tabs
        default: c
        tabs:
          - { title: A, layout: [{ row: [scheduler] }] }
          - { title: A, layout: [{ row: [capacity] }] }
```

### 3.8 Bekannte Grenzen (V1)

- `shell_filter` hat nur `command` und `timeout`: **keine `args`**, kein `env`. Das Item kommt ausschließlich über
  `ADISPATCH_CHECK_CONTEXT_FILE`; Parameter für das Skript über einen Wrapper bzw. die Kontextdatei.
- Conditions (`conditions.workflow`, `conditions.item`) haben `args`, aber **kein `env`**; die Umgebung ist die
  Minimalumgebung plus `ADISPATCH_CHECK_CONTEXT_FILE` (§6.11).
- `shell`-Actions: Frist zwischen `SIGTERM` und `SIGKILL` fest **5 s**, Log-Limit fest **10 MiB** pro Versuch –
  nicht konfigurierbar (`execute.cancel_grace` und `retention.max_log_size_per_run` gelten nur für den Haupt-Worker).
- Prüfskripte (Conditions, `shell_filter`): Ausgabe wird bis 16 KiB je Stream erfasst, SIGTERM→SIGKILL nach 2 s.
- Info-Kacheln (`dashboard.yaml`): keine `secrets` (nur `env`), keine Templates in `args`; höchstens 50 Kacheln,
  2 parallele Ausführungen, Ausgabe bis 4 KiB je Stream; Werte und Status nur im Speicher (nach einem Neustart
  zunächst `pending`, bis der erste Abruf fertig ist).
- Auswahllisten (`options_from`, WI-31): höchstens 500 Optionen, Werte/Labels bis 200 Zeichen, Skriptausgabe bis
  256 KiB je Stream; Cache nur im Speicher (ein Reload verwirft ihn); ein Parameter wird höchstens alle 2 s (Skript)
  bzw. `max(30 s, cache)` (GitHub) neu geholt; kein `env` für das Skript (nur `secrets`); keine Auswahl von Items per Filter.
- Der angezeigte letzte Condition-Status liegt nur im Speicher; Item-Conditions und `shell_filter` werden nur als
  Zusammenfassung je Planungsschritt angezeigt, nicht je Item.
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
| Abschnitte | – | `sections[].filter` lokal auf den Items der View, `state` ohne Pushdown (§3.5.2) |
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
| `run.last_outcome` | string | benanntes Ergebnis (`outcome` der Ergebnisdatei, sonst `null`) |
| `run.last_status_message` | string | letzte Status-Meldung des Workers (`@@ADISPATCH_EVENT` `status`) |
| `run.last_started_at` | date | Start |
| `run.last_finished_at` | date | Ende |

**Feld `history` (seit 0.9.0).** Reine Link-Spalte für `fields` (Views, Abschnitte, Dashboard-View-Widgets): Wert
ist die UI-Route des Item-Verlaufs `#/items/<source>/<id>`, angezeigt als „History →“. Das Feld ist in Views
**nicht** filter- und nicht sortierbar (`Field "history" (type string) cannot be used in filters; it is a link column
for views (fields) only, …` bzw. `Views cannot be sorted by "history": …`) und in Workflows unbekannt.

| Feld | Typ | Bedeutung |
|---|---|---|
| `history` | string | Link auf die Seite „Item-Verlauf“ (Runs, Hooks mit Wirkung, Retry-Blocks, UI-Aktionen des Items) |

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
| `{run.trigger}` | `source` \| `schedule` \| `manual` \| `unblock` (Lifecycle-Run von `on_retry_unblock`, seit 0.6.0) | – |
| `{run.started_at}` | ISO-8601 mit ms (UTC) | in `on_start` und in Hooks von Runs, deren Worker nie lief |
| `{workspace.path}` | absoluter Workspace-Pfad des Runs | in `on_start`; in Abschluss-Hooks, wenn der Worker nie gespawnt wurde |
| `{source.id}` | Source-ID | Run ohne Item |
| `{source.type}` | `github` | Run ohne Item |
| `{source.repository}` | `owner/repository` | Run ohne Item |
| `{source.vars.<name>}` | Variable `vars.<name>` der Source des Items (§3.2, seit 0.3.0) | Run ohne Item |
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
| `{result.outcome}` | benanntes Ergebnis (`outcome` der Ergebnisdatei, z. B. `approved`) | ohne/ungültiges `outcome`, bei technischem Fehler/Cancel |
| `{parameters.<name>}` | Parameterwert (`true`, `5`, Text) | optionaler Parameter ohne Wert und ohne Default; in `on_retry_unblock` immer |
| `{block.id}` | ID des Retry-Blocks (seit 0.6.0, nur `on_retry_block`/`on_retry_unblock`) | – |
| `{block.failures}` | Anzahl der gezählten technischen Fehler | – |
| `{block.created_at}` | Entstehungszeitpunkt des Blocks, ISO-8601 (UTC) | – |
| `{block.last_status}` | technischer Endstatus des auslösenden Runs (`crashed`, `start_error`, `timed_out`) | Blocks von vor 0.6.0, deren Run gelöscht ist |
| `{block.cleared_at}` | Zeitpunkt des Aufhebens, ISO-8601 (UTC) | nur in `on_retry_unblock` erlaubt |
| `{block.cleared_by}` | wer aufgehoben hat: angemeldeter Benutzer (§3.1 `auth`), ohne Anmeldung der vom Client mitgeschickte Name (UI `ui`, sonst `api`) – über die API also immer gesetzt; `anonymous` nur bei einem intern ohne Namen aufgehobenen Block | nur in `on_retry_unblock` erlaubt |

Fehlender Wert: Modus `text` → leerer String; Modus `path` → Fehler (`start_error`).

### 5.2 Scope – wo welcher Platzhalter erlaubt ist

✓ = erlaubt, – = Konfigurationsfehler, (s) = nur wenn `trigger.type: source`, (leer) = erlaubt, aber dort leer.

| Platzhalter | `execute.working_directory` (path) | `execute.args`, `execute.env` | `on_start` (`message`, `args`, `env`) | übrige Hooks | `on_retry_unblock` | `conditions.workflow[].args` | `conditions.item[].args` |
|---|---|---|---|---|---|---|---|
| `workflow.*`, `workspace.base_dir`, `timestamp` | ✓ (`base_dir` nur am Anfang) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `run.id`, `run.trigger` | ✓ | ✓ | ✓ | ✓ | ✓ (des Lifecycle-Runs) | – | – |
| `run.started_at` | ✓ | ✓ | ✓ (leer) | ✓ | ✓ (Start der Kette) | – | – |
| `workspace.path` | – | ✓ | ✓ (leer) | ✓ | ✓ (leer) | – | – |
| `source.*` (inkl. `source.vars.<name>`), `item.*` | ✓ (s) | ✓ (s) | ✓ (s) | ✓ (s) | ✓ (s, Item frisch gelesen) | – | ✓ |
| `result.*` | – | – | – | ✓ | – | – | – |
| `parameters.<name>` | ✓ nur `required` oder mit `default` | ✓ | ✓ | ✓ | ✓ (leer) | – | – |
| `item.work_branch`, `item.work_pr` | ✓ (s, GitHub; `null` → Fehler) | ✓ (s, GitHub) | ✓ (s, GitHub) | ✓ (s, GitHub) | ✓ (s, GitHub) | – | – |
| `block.id`, `block.failures`, `block.created_at`, `block.last_status` | – | – | – | nur `on_retry_block` | ✓ | – | – |
| `block.cleared_at`, `block.cleared_by` | – | – | – | – | ✓ | – | – |

`{source.vars.<name>}` muss zusätzlich in `vars` **jeder** Source des Workflows stehen (sonst Fehler mit der Liste
der Sources, in denen sie fehlt); im Pfadmodus wird der Wert wie jeder Platzhalter zu genau einem sicheren
Pfadsegment.

Nicht als Template ausgewertet (Platzhalter bleiben wörtlich stehen): alle `command`, `source.update.labels`,
`source.update.project`, `shell_filter`, Filterwerte, `secrets`, alle anderen Felder.

„Übrige Hooks“ schließt `on_result.<outcome>`, `on_error` und `on_retry_block` ein; `on_retry_block` sieht die Werte
des auslösenden Runs (`run.*`, `result.*`, `item.*`, …) plus `block.*` ohne `block.cleared_*`. In
`on_retry_unblock` gibt es kein Ergebnis (`result.*` ist wie in `on_start` ein Konfigurationsfehler); Workspace und
Parameter hat der Lifecycle-Run nicht (leer). Ist das Item beim Aufheben nicht lesbar, bleiben `{item.title}` & Co.
leer und Actions mit `source.*` scheitern regulär (z. B. `item_not_found`). `{item.work_branch}`/`{item.work_pr}` gelten auch in
Workflows mit mehreren Sources (`trigger.sources`, alle GitHub); gelesen wird jeweils in der Source des Items.
Außerhalb dieser Stellen (z. B. in `conditions.item[].args`) oder in Workflows ohne GitHub-Source-Trigger: `Placeholder "{item.work_branch}" is only available in "execute" and lifecycle
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
1. **Pollen** (alle aktiven Source-Workflows parallel; deaktivierte erscheinen nur als `disabled`): Liste jeder
   Source des Workflows mit dem pushbaren Filterteil (gleiche Source + gleicher Pushdown = ein API-Aufruf pro
   Schritt). Fehler einer Source betreffen nur deren Workflows bzw. bei mehreren Sources nur deren Items
   (`source_error` am Workflow und an der Source; die übrigen Sources werden normal geplant).
2. **Deduplizieren** pro `(Source, Item, Workflow)`.
3. **Billiger Filter** (teure Felder = unknown): `false` → verworfen. **Item-Priorität** bestimmen (darf teure
   Felder laden).
4. **Sortieren** aller Kandidaten aller Workflows (§6.2).
5. Pro Kandidat **sequentiell** in dieser Reihenfolge:
   1. freie Kapazität global, für den Workflow und ggf. je Source (`max_concurrent_per_source`)? (zuerst, damit
      volle Limits keine API-Aufrufe kosten)
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
(2) **Item-Priorität** absteigend, (3) Position der Source in `trigger.sources` aufsteigend (seit 0.3.0; bei
`source: <id>` immer 0), (4) Erstellungszeit des Items aufsteigend (fehlend/ungültig zuletzt),
(5) Item-Schlüssel natürlich aufsteigend (`repo:9` < `repo:10`), (6) Workflow-ID aufsteigend.

Die Source-Position (3) gilt über alle Workflows hinweg, nicht nur innerhalb eines Workflows (sonst wäre die Ordnung
nicht eindeutig). Nebeneffekt: Bei gleicher Workflow- **und** Item-Priorität verliert ein Item einer späteren Source
eines Multi-Source-Workflows einen knappen globalen Slot auch gegen gleichrangige Items anderer Workflows (deren
Items haben Position 0 bzw. eine frühere Position) – unabhängig von der Erstellungszeit. Wer das nicht will, gibt dem
Workflow bzw. den Items eine passende Priorität. Ein Item mit hoher
Item-Priorität überholt also keinen Workflow mit höherer Workflow-Priorität. Kein Aging.

### 6.3 Limits

- Global `scheduler.max_concurrent`, pro Workflow `max_concurrent` und (seit 0.3.0) pro Source des Workflows
  `max_concurrent_per_source` gelten nur für **automatische** Starts (Source, Cron). Aktive Runs **aller** Trigger
  zählen (inkl. manueller und `recovery_pending`; für das Source-Limit die Runs des Workflows mit Items dieser
  Source).
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
- **Hooks (seit 0.6.0):** `on_retry_block` läuft im erzeugenden Run nach dessen Abschluss-Hook; `on_retry_unblock`
  läuft beim Entfernen in einem eigenen Lifecycle-Run (Trigger `unblock`), der bis zum Ende der Kette das Lock hält –
  das Item wird also erst danach wieder automatisch gestartet (Planung zeigt `locked: run <id>`). Bei Blocks ohne Item
  (z. B. Cron) startet währenddessen kein Run ohne Item: Cron-Slots werden `skipped_blocked` mit Grund
  `unblock run <id> active`, manuelle Starts ohne Item scheitern mit `409 unblock_run_active`. Mit nicht leerem `on_retry_unblock` und laufendem Run
  für `(Workflow, Item)` wird das Entfernen abgelehnt (`409 block_run_active`). Optional die Benachrichtigung
  `retry_block_cleared`. Details §3.4.10.

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
  Parametervalidierung und (seit 0.6.0) einen laufenden Lifecycle-Run eines aufgehobenen Workflow-Blocks: Start ohne
  Item, solange `on_retry_unblock` läuft → HTTP 409 `unblock_run_active`.
- Source-Workflow: Item-Referenz Pflicht – `123`, `#123`, `owner/repo#123`,
  `https://github.com/owner/repo/issues/123` bzw. `/pull/123` (Owner/Repo ohne Groß-/Kleinschreibung, muss zur
  Source passen) oder (seit 0.3.0) `<source>:<ref>` wie `project_a:123`; das Item muss existieren. Bei mehreren
  Sources wird die Source aus der Referenz abgeleitet (URL, `owner/repo#123`, `<source>:123`); passt keine oder –
  bei einer bloßen Nummer – mehr als eine Source, folgt `400 manual_item_invalid_ref` mit Hinweis. Andere Trigger:
  Item verboten.
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
| Exit 0 + gültiges `"outcome": "x"` und `on_result.x` definiert | `completed` | laut `result` | `on_result.x` (statt `on_success`/`on_failure`) | laut `result` |
| Controller-Neustart, Worker nachweislich weg | `crashed` (bzw. `cancelled`, wenn Cancel lief) | – | `on_crash` / `on_cancel` | `crashed`: ja |
| Controller-Neustart, Prozess nicht sicher zuordenbar | `recovery_pending` (hält Lock) | – | – | – |

Eine fachliche `failure` gibt es nur über eine gültige Ergebnisdatei; ein Exit-Code allein ist nie „failure“.
Ergebnisdatei-Format: [worker-protocol.md](worker-protocol.md).

Die Spalte „Hook“ nennt den spezifischen Hook. Für `crashed`, `start_error`, `timed_out` und `cancelled` läuft
stattdessen `on_error`, wenn der spezifische Hook nicht definiert ist (§3.4.10). Der gewählte Hook wird mit
`→ finalizing` gespeichert; die Recovery nach einem Neustart setzt genau ihn fort. Erzeugt der Übergang einen
Retry-Block, läuft danach zusätzlich `on_retry_block` (seit 0.6.0, auch bei `start_error` ohne Hooks; §3.4.10).

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
| `execute.secrets.<NAME>` | die angegebene Identity (Installation-Token, ca. 1 h gültig, beim Start geholt; bei `delivery: file` bis zum Prozessende erneuert; bei `github_token` der Token selbst) |
| `shell`-Action `secrets.<NAME>` | die angegebene Identity (pro Versuch geholt; bei `delivery: file` während der Action erneuert) |
| `shell`-Actions ohne `secrets`, Conditions, `shell_filter` | keine (keine Secrets) |

### 6.11 Umgebung von Worker, Actions und Prüfskripten

| | Haupt-Worker | `shell`-Action | Conditions / `shell_filter` |
|---|---|---|---|
| Basis | `PATH`, `HOME`, `LANG`, `TZ`, `USER`, `LOGNAME`, `TMPDIR` aus der Controller-Umgebung (PATH-Fallback `/usr/local/bin:/usr/bin:/bin`) | wie Worker | dieselben Variablen (ohne PATH-Fallback) |
| Konfiguriert | `execute.env`, dann `execute.secrets` (`<NAME>` bzw. bei `delivery: file` `<NAME>_FILE`) | Action-`env`, dann Action-`secrets` (ebenso) | – |
| Orchestrator | `ADISPATCH_RUN_ID`, `ADISPATCH_WORKFLOW_ID`, `ADISPATCH_CONTEXT_FILE`, `ADISPATCH_RESULT_FILE`, `ADISPATCH_WORKSPACE`; bei Item zusätzlich `ADISPATCH_SOURCE_TYPE`, `ADISPATCH_SOURCE_ID`, `ADISPATCH_SOURCE_ITEM_ID`, `ADISPATCH_SOURCE_URL` | dieselben (`ADISPATCH_WORKSPACE` = Arbeitsverzeichnis der Action; Kontext `kind: lifecycle_action` mit Hook, Action, `result`, in den Retry-Block-Hooks `block`) | `ADISPATCH_CHECK_CONTEXT_FILE` (JSON: `kind`, `workflow.id`, bei Item `source{id,type,item_id,item_key,url,item_type,created_at,attributes}`) |
| Arbeitsverzeichnis | Workspace | Workspace, falls vorhanden, sonst Versuchsverzeichnis | temporäres Verzeichnis |

**Info-Skripte** (`dashboard.yaml`, §3.7): Basis wie Conditions, dann `info[].env`, dann `ADISPATCH_INFO_ID`,
`ADISPATCH_CONFIG_DIR`, `ADISPATCH_DATA_DIR` und `ADISPATCH_CHECK_CONTEXT_FILE` (JSON: `schema_version`,
`kind: dashboard_info`, `info{id,type}`, `config_dir`, `data_dir`); Arbeitsverzeichnis = config-dir.

Vorrang (spätere gewinnen): Basis < `env` < `secrets` < `ADISPATCH_*`. Die übrige Controller-Umgebung wird **nie**
vererbt. Details zu Kontextdatei, Ergebnisdatei, Events und Cancel: [worker-protocol.md](worker-protocol.md).

### 6.12 Workspace-Cleanup

Nach dem Abschluss-Hook werden zuerst die `execute.keep`-Dateien gesichert (§3.4.8), dann gilt: `always` = immer, `on_success` = nur `completed`+`success`, `never` = nie. Gelöscht wird nur
ein Workspace strikt unter `workspace.base_dir` (auch nach Auflösen von Symlinks; ein Workspace, der selbst ein
Symlink ist, wird nie gelöscht). Später entfernt die Retention auch verbliebene Workspaces gelöschter Runs.

### 6.13 Dry-Run

`adispatch workflow dry-run <id>` (gegen die laufende Instanz, sonst mit `--config-dir` lokal) bzw.
`POST /api/v1/workflows/:id/dry-run`: Source-Abfrage, Filter-Trace pro Regel (inkl. Dependencies), Prioritäten,
Locks/Blocks, Kapazität (in Prioritätsreihenfolge simuliert), je Kandidat die Werte bzw. Unknown-Gründe aller
`project.*`-Felder (`projectFields`), die Werte der im Filter verwendeten teuren Felder (z. B.
`work_pr not_equals null: true (actual 12)`) im Filter-Trace, je Kandidat die verknüpften Branches/PRs
(`linkedFields`, Textausgabe `linked fields:`), wenn der Workflow sie irgendwo verwendet (Filter, `item_priority`,
`execute`, Actions; nicht für Items, die schon der billige Filterteil verwirft), den ausgewerteten Filter mit
eingesetzten benannten Filtern (`source.filter`,
Textausgabe `filter:`), bei `execute.keep` die Muster samt Größenlimit (unter `notes`), das Hook-Routing
(`hooks`: die `on_result`-Schlüssel und je technischem Ausgang der Hook, der liefe, z. B. `timed_out → on_error`) sowie
seit 0.3.0 alle deklarierten Secrets von `execute` und `shell`-Actions mit Ort, Identity, Übergabeart und Variable
(`secrets`, Textausgabe `secret execute: GH_TOKEN ← identity coder, delivery file (GH_TOKEN_FILE)`; nie Werte, es wird
kein Token geholt). Bei mehreren Sources (seit 0.3.0) je Source eine Zeile mit gepollten Items, Pushdown und
ggf. Fehler (`source.sources`), je Kandidat `sourceId`, bei `max_concurrent_per_source` die Auslastung je Source
(`capacity.perSource`, Textzeile `capacity per source:`). Reserviert nichts, startet keine Worker oder Actions
und führt **nie** `shell_filter`/Conditions aus (`not_evaluated`, Entscheidung `pending_checks`); seit 0.4.0 mit
ihrem Anzeigenamen (`name`, Textausgabe `workflow condition 0 "Credits verfügbar" (/pfad/check.sh): …`). Cron-Workflows:
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
    GH_TOKEN: { identity: coder, delivery: file }   # lange Runs: $GH_TOKEN_FILE, wird erneuert (§3.4.8)
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
on_result:                                   # dritter fachlicher Ausgang: {"result": "failure", "outcome": "needs_maintainer"}
  needs_maintainer:
    - type: source.update
      labels: { add: [needs-maintainer], remove: [reviewing] }
    - type: source.comment
      message: 'Review braucht eine Entscheidung: {result.message}'
on_error:                                    # crashed, start_error, timed_out, cancelled: zurück in die Warteschlange
  - type: source.update
    labels: { add: [ready-for-review], remove: [reviewing] }
```

Der Reviewer kennt drei fachliche Ausgänge: ohne `outcome` gelten `on_success`/`on_failure`, mit
`"outcome": "needs_maintainer"` läuft nur `on_result.needs_maintainer` (das Review-Skript braucht dafür keine
eigenen Schreibrechte). Alle technischen Ausgänge teilen sich `on_error`, weil keiner einen eigenen Hook hat.

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
  - { field: history, label: Verlauf }    # Link „History →“ auf den Item-Verlauf (seit 0.9.0)
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

### 7.9 Ein Workflow für mehrere Repositories

Ein Coder für zwei Repositories mit unterschiedlichem Basis-Branch. Je Repository läuft höchstens ein Run, zusammen
höchstens zwei; bei gleicher Item-Priorität wird `project_a` vor `project_b` bedient.

```yaml
# example: multi-source
# extends: github
# file: sources.yaml
sources:
  project_a:
    type: github
    owner: example
    repository: project-a
    identity: maintainer
    vars: { base_branch: main, test_command: npm test }
  project_b:
    type: github
    owner: example
    repository: project-b
    identity: maintainer
    vars: { base_branch: develop, test_command: make check }
```

```yaml
# example: multi-source
# file: workflows/coder-all.yaml
id: coder-all
identity: coder
max_concurrent: 2
max_concurrent_per_source: 1
trigger: { type: source, sources: [project_a, project_b] }
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: is_pull_request, operator: equals, value: false }
execute:
  type: shell
  command: scripts/coder.sh
  args: ['{item.url}']
  env:
    BASE_BRANCH: '{source.vars.base_branch}'
    TEST_COMMAND: '{source.vars.test_command}'
  secrets:
    GH_TOKEN: { identity: coder }
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
  - type: source.comment
    message: 'Fertig für {source.repository} (Basis {source.vars.base_branch}): {result.message}'
on_failure:     [ { type: source.update, labels: { add: [needs-maintainer], remove: [coding] } } ]
on_crash:       [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
on_start_error: [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
on_timeout:     [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
on_cancel:      [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
```

Labels, Kommentare und `{source.*}` beziehen sich immer auf das Repository des Items. Manuell gestartet wird mit
URL oder `project_b:12`. Der Dry-Run zeigt je Source die gepollten Items:

```text
  trigger: sources project_a, project_b
  capacity per source: project_a 0/1, project_b 0/1
  source project_a: 3 item(s) polled, pushdown {…}
  source project_b: 1 item(s) polled, pushdown {…}
```

### 7.10 Review auf dem Arbeits-Branch (verknüpfte PRs)

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

### 7.11 Worker im Container

Der Coder aus §7.2, aber in einem Wegwerf-Container (§3.4.8 „Container“): Workspace unter `/work/repo`,
Agent-Definitionen aus dem config-dir read-only, Ressourcenlimits, kein Netzwerk außer dem Standardnetz, das Token
als erneuerte Datei unter `/adispatch/secrets/GH_TOKEN`. `workflow dry-run` zeigt den vollständigen Engine-Aufruf.

```yaml
# example: container
# extends: github
# file: config.yaml
container:
  engine: podman
```

```yaml
# example: container
# file: agents/coder.yaml
# Beliebige Dateien für den Container (hier: Agent-Definitionen), read-only gemountet.
name: coder
```

```yaml
# example: container
# file: workflows/boxed-coder.yaml
id: boxed-coder
identity: coder
trigger: { type: source, source: project_a }
filter: { field: labels, operator: contains, value: ready-for-coding }
execute:
  type: container
  image: localhost/worker:current
  command: [worker, --issue, '{item.number}', --workspace, '{workspace.path}']   # {workspace.path} = /work/repo
  mounts:
    - { source: '{workspace.path}', target: /work/repo, mode: rw }
    - { source: agents/, target: /home/worker/agents, mode: ro }               # relativ zum config-dir
  env: { REPOSITORY: '{source.repository}' }
  secrets:
    GH_TOKEN: { identity: coder, delivery: file }   # GH_TOKEN_FILE=/adispatch/secrets/GH_TOKEN
  resources: { memory: 8g, cpus: 3, pids: 4096 }
  user: '1000:1000'
  pull: missing
  timeout: { max_duration: 4h, idle_timeout: 30m }
  cancel_grace: 30s
  keep: [.agent/transcript.jsonl]
on_start:  [ { type: source.update, labels: { add: [coding], remove: [ready-for-coding] } } ]
on_success: [ { type: source.update, labels: { add: [ready-for-review], remove: [coding] } } ]
on_failure: [ { type: source.update, labels: { add: [needs-maintainer], remove: [coding] } } ]
on_error:   [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
```

Mit `podman` und `user` wird zusätzlich `--userns keep-id` gesetzt. Rechte von Docker/Podman: siehe
[operations.md](operations.md) „Container-Executor“.


---

## 8. Häufige Validierungsfehler

Format der Ausgabe von `config validate`: `datei:zeile: pfad: meldung`. Alle folgenden Blöcke sind bewusst
ungültig und werden vom Test gegen die angegebene Meldung geprüft.

**Tippfehler im Schlüssel** – alle Objekte sind strikt.

```yaml
# example: err-unknown-key
# extends: minimal
# invalid
# expect: config.yaml: scheduler: Unknown key(s): "max_concurent" (did you mean "max_concurrent"?)
# file: config.yaml
scheduler:
  max_concurent: 2
```

Lösung: Schreibweise laut §3 korrigieren (der Vorschlag nennt den nächstliegenden erlaubten Schlüssel).

**Hooks `on_error`/`on_result`** – Tippfehler im Hook-Namen und Ergebnis-Schlüssel, die keine IDs sind.

```yaml
# example: err-result-hooks
# extends: github
# invalid
# expect: workflows/reviewer.yaml: Unknown key(s): "on_errors" (did you mean "on_error"?)
# expect: workflows/reviewer.yaml: on_result.needs maintainer: Invalid key "needs maintainer": Invalid ID (allowed: letters, digits, "_" and "-", must start with a letter or digit, max. 64)
# file: workflows/reviewer.yaml
id: reviewer
trigger: { type: source, source: project_a }
execute: { type: shell, command: scripts/reviewer.sh }
on_errors: []
on_result:
  "needs maintainer": []
```

Lösung: `on_error` (Singular); Ergebnis-Schlüssel wie Konfigurations-IDs schreiben (`needs_maintainer`) – genauso
muss der Worker sie als `outcome` liefern.

**Retry-Block-Hooks** (seit 0.6.0) – `{block.*}` außerhalb von `on_retry_block`/`on_retry_unblock`,
`{block.cleared_*}` in `on_retry_block`, `{result.*}` in `on_retry_unblock`, `source.*` ohne Item.

```yaml
# example: err-retry-block-hooks
# extends: github
# invalid
# expect: workflows/coder.yaml: on_crash[0].message: Placeholder "{block.id}" is only available in "on_retry_block" and "on_retry_unblock"
# expect: workflows/coder.yaml: on_retry_block[0].message: Placeholder "{block.cleared_by}" is only available in "on_retry_unblock"
# expect: workflows/coder.yaml: on_retry_unblock[0].message: Placeholder "{result.message}" is not available in this context
# expect: workflows/nightly.yaml: on_retry_block[0].type: "source.update" needs a source item; the workflow has no source trigger
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
execute: { type: shell, command: scripts/coder.sh }
on_crash:
  - type: source.comment
    message: 'Block {block.id}'
on_retry_block:
  - type: source.comment
    message: 'Aufgehoben von {block.cleared_by}'
on_retry_unblock:
  - type: source.comment
    message: 'Ergebnis {result.message}'
```

```yaml
# example: err-retry-block-hooks
# file: workflows/nightly.yaml
id: nightly
trigger: { type: schedule, cron: '0 3 * * *' }
execute: { type: shell, command: scripts/nightly.sh }
on_retry_block:
  - type: source.update
    labels: { add: [blocked] }
```

Lösung: `{block.*}` nur in den beiden Retry-Block-Hooks verwenden, `{block.cleared_at}`/`{block.cleared_by}` nur in
`on_retry_unblock`; dort gibt es kein Ergebnis. In Workflows ohne Item nur `shell`-Actions.

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

**Secrets: `delivery` und `<NAME>_FILE`** (seit 0.3.0) – `delivery` ist `env` oder `file`; bei `file` setzt der
Daemon `<NAME>_FILE`, das weder in `env` noch als anderer Secret-Name vorkommen darf.

```yaml
# example: err-secret-delivery
# extends: github
# invalid
# expect: workflows/coder.yaml: execute.secrets.GH_TOKEN.delivery: Invalid option: expected one of "env"|"file" (did you mean "file"?)
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
execute:
  type: shell
  command: scripts/coder.sh
  secrets:
    GH_TOKEN: { identity: coder, delivery: fiel }
```

Ein Schemafehler wie dieser verhindert die weiteren Prüfungen der Datei; Kollisionen und Identities prüft erst die
semantische Validierung:

```yaml
# example: err-secret-file-name
# extends: github
# invalid
# expect: workflows/coder.yaml: execute.secrets.API_TOKEN.delivery: "delivery: file" sets "API_TOKEN_FILE", which is also defined in "env"
# expect: workflows/coder.yaml: on_success[0].secrets.GH_TOKEN.identity: Unknown identity "revewer" (did you mean "reviewer"?)
# file: workflows/coder.yaml
id: coder
trigger: { type: source, source: project_a }
execute:
  type: shell
  command: scripts/coder.sh
  env: { API_TOKEN_FILE: /tmp/token }
  secrets:
    API_TOKEN: { identity: coder, delivery: file }
on_success:
  - type: shell
    command: scripts/notify.sh
    secrets:
      GH_TOKEN: { identity: revewer }
```

Lösung: `delivery: file`; die Variable in `env` umbenennen (oder `delivery: env`); Identity-Namen korrigieren.

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

**Link-Spalte `history` als Filter oder Sortierung** (seit 0.9.0) – `history` ist nur eine Spalte (§4.8).

```yaml
# example: err-history
# extends: github
# invalid
# expect: views/history.yaml: filter.field: Field "history" (type string) cannot be used in filters; it is a link column for views (fields) only, not a value to filter or sort by
# expect: views/history.yaml: sort[0].field: Views cannot be sorted by "history": it is a link column to the item history (use it in "fields" only)
# file: views/history.yaml
id: history
sources: [project_a]
filter: { field: history, operator: contains, value: "#/items" }
fields:
  - { field: title }
  - { field: history }
sort: [ { field: history } ]
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

**Auswahllisten zur Laufzeit (`options_from`)**

```yaml
# example: err-options-from
# extends: github
# invalid
# expect: workflows/release.yaml: parameters.branch.options_from: "options_from" cannot be combined with "values" (use one of them)
# expect: workflows/release.yaml: parameters.tag.options_from: "options_from" needs exactly one of "github" or "command", not both
# expect: workflows/release.yaml: parameters.ref.options_from.source: "source" is required: the workflow has no single source to read branches/tags from
# expect: workflows/release.yaml: parameters.host.options_from.timeout: "timeout" must not exceed 60s
# expect: workflows/release.yaml: parameters.host.options_from.limit: "limit" is only allowed with "options_from.github"
# file: workflows/release.yaml
id: release
trigger: { type: manual }
parameters:
  branch: { type: enum, values: [main], options_from: { github: branches, source: project_a } }
  tag: { type: enum, options_from: { github: tags, command: scripts/tags.sh } }
  ref: { type: enum, options_from: { github: tags } }
  host: { type: enum, options_from: { command: /bin/echo, timeout: 2m, limit: 5 } }
execute: { type: shell, command: scripts/release.sh }
```

```yaml
# example: err-options-from-automatic
# extends: github
# invalid
# expect: workflows/nightly.yaml: parameters.branch.default: "options_from" without "default" in an automatically triggered workflow: automatic runs only receive the default
# file: workflows/nightly.yaml
id: nightly
trigger: { type: schedule, cron: '0 3 * * *' }
parameters:
  branch: { type: enum, options_from: { github: branches, source: project_a } }
execute: { type: shell, command: scripts/nightly.sh }
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

**View-Sortierung und Abschnitte** (seit 0.5.0, §3.5.1, §3.5.2) – `order` nur für `string`-Felder, Werte
eindeutig; Abschnitte mit eindeutigem Titel und genau `filter` oder `rest: true`; `state` im Abschnitt nicht über
die View-Abfrage hinaus.

```yaml
# example: err-view-sections
# extends: projects
# invalid
# expect: views/board.yaml: sort[0].order[2]: Duplicate value "Todo" in "order"
# expect: views/board.yaml: sort[1].order: "order" is only allowed for string fields (e.g. project.* single_select/text/iteration, state, run.last_status); "labels" has type string[]
# expect: views/board.yaml: sections[1].title: Duplicate section title "Offen" (also used by section 1)
# expect: views/board.yaml: sections[2]: A section needs a "filter" or "rest: true"
# expect: views/board.yaml: sections[3].filter.field: "state" in a section only filters the items the view lists (only open issues/PRs); this section asks for "closed", which the view never reads – select them in the view filter (top level, e.g. state in [open, closed])
# file: views/board.yaml
id: board
sources: [project_a, project_b]
fields: [ { field: title }, { field: project.Status } ]
sort:
  - { field: project.Status, order: [Todo, Ready, Todo] }
  - { field: labels, order: [bug] }
sections:
  - title: Offen
    filter: { field: project.Status, operator: equals, value: Todo }
  - title: Offen
    rest: true
  - title: Ohne Filter
  - title: Erledigt
    filter: { field: state, operator: equals, value: closed }
```

Lösung: `order` nur für Felder vom Typ `string` (für Labels einen Abschnitt je Label), doppelte Werte entfernen;
Titel eindeutig; jedem Abschnitt einen `filter` geben oder ihn als einzigen `rest: true` markieren;
geschlossene Items im View-`filter` auswählen (`state in [open, closed]`). Weitere Meldungen: `A view can sort by
at most 5 keys`, `A sort list needs at least one key`, `"order" must list at least one value`, `"order" may list at
most 100 values`, `A view can have at most 20 sections`, `A section title may have at most 80 characters`,
`A section has either "filter" or "rest: true", not both`, `Only one section can be "rest: true"`,
`"group_by_first" needs a first sort key with "order"`. Als Warnung:
`"exclusive" has no effect without "sections"` (ebenso `hide_empty_sections`).

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
Ebenen, §3.8), `"use" requires the ID of a named filter` (`use` ohne gültige ID), `Filter node must be a mapping …;
to reference a named filter write { use: x }` (Kurzform `x` gibt es nur an der Wurzel),
`Duplicate filter ID "x" (already defined in filters/a.yaml)`.

**Null-Intervalle und -Timeouts**

```yaml
# example: err-multi-source
# extends: multi-source
# invalid
# expect: workflows/both.yaml: trigger.sources: "source" and "sources" are mutually exclusive
# expect: workflows/dup.yaml: trigger.sources[1]: Source "project_a" is listed more than once
# expect: workflows/vars.yaml: trigger.sources[2]: Unknown source "project_c"
# expect: workflows/vars.yaml: execute.env.DEPLOY: Source variable "deploy_target" is not defined in "vars" of sources "project_a", "project_b" (sources.yaml)
# file: workflows/both.yaml
id: both
trigger: { type: source, source: project_a, sources: [project_b] }
execute: { type: shell, command: scripts/coder.sh }
```

```yaml
# example: err-multi-source
# file: workflows/dup.yaml
id: dup
trigger: { type: source, sources: [project_a, project_a] }
execute: { type: shell, command: scripts/coder.sh }
```

```yaml
# example: err-multi-source
# file: workflows/vars.yaml
id: vars
trigger: { type: source, sources: [project_a, project_b, project_c] }
execute:
  type: shell
  command: scripts/coder.sh
  env:
    BASE_BRANCH: '{source.vars.base_branch}'   # in beiden bekannten Sources definiert
    DEPLOY: '{source.vars.deploy_target}'      # fehlt in beiden
```

`sources: []` → `"sources" must not be empty`; `max_concurrent_per_source: 0` → `Must be greater than 0`; weder `source` noch `sources` → `A source trigger needs "source:
<id>" or "sources: [<id>, ...]"`; `max_concurrent_per_source` an einem Cron-/Manual-Workflow →
`"max_concurrent_per_source" is only allowed for workflows with a source trigger`. Projektfelder, die nicht alle
Sources mit gleicher Art deklarieren: im Filter `… workflows with several sources only offer project fields declared
by all their sources (missing in "…")`, in `source.update.project` `… it is not declared in "project.fields" of all
sources of the workflow (missing in "…")` bzw. `Project field "…" has different kinds in the sources of the
workflow`.

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
# expect-warning: workflows/janitor.yaml: on_error: "on_error" never runs: "on_crash", "on_start_error", "on_timeout", "on_cancel" are all defined (a defined hook, even [], takes precedence)
# file: workflows/janitor.yaml
id: janitor
trigger: { type: manual }
execute: { type: shell, command: scripts/hello.sh }
on_crash: []
on_start_error: []
on_timeout: []
on_cancel: []
on_error:
  - { type: shell, command: scripts/cleanup.sh }
```

```yaml
# example: warn-common
# expect-warning: filters/old.yaml: id: Named filter "spare" is not used by any workflow or view
# expect-warning: filters/old.yaml: id: Filter ID "spare" differs from file name "old.yaml"
# file: filters/old.yaml
id: spare
filter: { field: labels, operator: contains, value: spare }
```

**Sicherungsmuster außerhalb des Workspaces** – `execute.keep` darf nur Dateien im Workspace bezeichnen.

```yaml
# example: err-keep-outside
# extends: minimal
# invalid
# expect: workflows/hello.yaml: execute.keep[1]: Pattern must not contain ".." (only files inside the workspace can be kept)
# file: workflows/hello.yaml
id: hello
trigger: { type: manual }
execute:
  type: shell
  command: scripts/hello.sh
  keep:
    - .agent/transcript.jsonl
    - ../shared/report.log
```

Lösung: Die Datei im Worker in den Workspace schreiben (bzw. dorthin kopieren) und relativ angeben.

**Container-Mounts** (§3.4.8): Ziele müssen absolute, normalisierte Container-Pfade außerhalb von `/adispatch`
sein; als Platzhalter in Quellen ist nur `{workspace.path}` erlaubt; statische Quellen müssen existieren.

```yaml
# example: err-container
# extends: minimal
# invalid
# expect: workflows/hello.yaml: execute.mounts[0].source: Mount source does not exist:
# expect: workflows/hello.yaml: execute.mounts[1].source: Only "{workspace.path}" (optionally followed by "/<path>") is allowed as template in a mount source
# expect: workflows/hello.yaml: execute.mounts[2].target: "/adispatch" is reserved for the daemon's own mounts (context, result, token files)
# expect: workflows/hello.yaml: execute.mounts[3].target: Duplicate mount target "/data" (also used by mounts[0])
# file: workflows/hello.yaml
id: hello
trigger: { type: manual }
execute:
  type: container
  image: busybox
  mounts:
    - { source: shared/data, target: /data, mode: ro }
    - { source: '{run.id}', target: /run-data, mode: rw }
    - { source: '{workspace.path}', target: /adispatch/work, mode: rw }
    - { source: '{workspace.path}/cache', target: /data, mode: rw }
```

Lösung: Verzeichnis anlegen (relativ zum config-dir) bzw. absolut angeben, den Workspace unter einem eigenen Ziel
(z. B. `/work`) mounten und Ziele eindeutig wählen.

**Info-Kacheln** – Schwellwerte, Einheit, IDs und Skriptpfad werden beim Laden geprüft (§3.7).

```yaml
# example: err-dashboard
# extends: minimal
# invalid
# expect: dashboard.yaml: info[0].cache: Duration must be at least 10s
# expect: dashboard.yaml: info[1]: Unknown key(s): "warn_abve" (did you mean "warn_above"?)
# file: dashboard.yaml
info:
  - id: disk
    type: percent
    command: /bin/sh
    cache: 5s
  - id: prs
    type: number
    command: /bin/sh
    warn_abve: 3
```

```yaml
# example: err-dashboard-semantics
# extends: minimal
# invalid
# expect: dashboard.yaml: info[0].unit: "unit" is only supported for "number" tiles (percent tiles always show %)
# expect: dashboard.yaml: info[1].id: Duplicate info tile ID "disk" (also used by info[0])
# expect: dashboard.yaml: info[1].warn_above: Thresholds are only supported for "number" and "percent" tiles (type is "text")
# expect: dashboard.yaml: info[1].command: Script does not exist:
# expect: dashboard.yaml: info[2].critical_above: "critical_above" (80) must not be lower than "warn_above" (90)
# expect: dashboard.yaml: info[3].timeout: "timeout" (60s) must not be longer than "cache" (30s)
# expect: dashboard.yaml: info[4].timeout: "timeout" must not exceed 5m
# file: dashboard.yaml
info:
  - id: disk
    type: percent
    command: /bin/sh
    unit: GB
  - id: disk
    type: text
    command: scripts/info/missing.sh
    warn_above: 3
  - id: load
    type: number
    command: /bin/sh
    warn_above: 90
    critical_above: 80
  - id: slow
    type: number
    command: /bin/sh
    timeout: 1m
    cache: 30s
  - id: slower
    type: number
    command: /bin/sh
    timeout: 10m
    cache: 1h
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
| `At most 80 characters` (Pfad `conditions.workflow[0].name`) | Anzeigename einer Condition zu lang |
| `Duration must be greater than 0` | `max_duration`/`idle_timeout: 0s` |
| `Invalid host name (expected "name" or "name:port")` | Schema/Pfad in `allowed_hosts` (`https://…`) |
| `Invalid environment variable name` | z. B. `private_key_env: my-key` |
| `Invalid IP address or CIDR range …` (Pfad `auth.…trusted_proxies[n]`) | Hostname oder Tippfehler – IP (`127.0.0.1`, `::1`) oder CIDR (`100.64.0.0/10`) angeben |
| `No users configured: nobody can log in …` (Warnung) | `auth.mode: password` ohne `auth.users` – Benutzer anlegen (CLI-Befehle gehen weiter) |
| `"0.0.0.0/0" trusts every address …` (Warnung) | Proxy-Liste erlaubt jede Adresse – nur die tatsächlichen Proxy-Adressen eintragen |
| `This header cannot carry the user` | `auth.trusted_header.header` ist ein reservierter Header (`Cookie`, `Host`, …) |
| `Must be an absolute http(s) URL` (Pfad `ui.external_links[n].url`) | relative URL oder anderes Schema – volle URL angeben, wie der Browser das Tool erreicht |
| `Query parameter "t" looks like an access token …` (Warnung) | Token in `ui.external_links[n].url` – für jeden sichtbar, der UI/API erreicht; besser Tool ohne Token nur lokal betreiben bzw. hinter dem authentifizierenden Proxy |
| `The host cannot be allowed in the Content-Security-Policy (frame-src) …` (Pfad `ui.external_links[n].embed`) | IPv6-Literal oder Host mit `_`, `*`, `;` … bei `embed: true` – Hostname/IPv4 verwenden oder `embed: false` |
| `Expected a size such as 100MB` | Größe als Zahl statt String (`max_log_size_per_run: 100`) |
| `Invalid size "100" (expected e.g. 512KB, 100MB, 1GB)` | String ohne oder mit unbekannter Einheit (`'100'`, `'100MiBs'`) |
| `Must be greater than 0` (Pfad `execute.keep_max_size`) | `keep_max_size: 0MB` |
| `Pattern must be relative to the workspace (no absolute path)` | `keep: [/var/log/app.log]` – Pfade relativ zum Workspace angeben |
| `Pattern must not end with "**" (use "dir/**/*" or "**/*.log")` | `keep: [logs/**]` → `logs/**/*` |
| `config.yaml not found, using defaults` (Warnung) | `config.yaml` fehlt |
| `UI actions need a login (auth.mode password or trusted_header); with auth.mode none they are disabled` (Warnung) | `ui_actions: true` bei `auth.mode: none` (§3.3) |

Laufzeitfehler, die `config validate` **nicht** findet: fehlende Umgebungsvariablen (Keys, Tokens, Webhooks),
nicht existierende/nicht ausführbare Skripte (außer Info-Kacheln, §3.7), fehlende App-Rechte (→ Felder unknown bzw. Actions scheitern),
Projekt nicht gefunden bzw. deklariertes Projektfeld fehlt im Projekt oder hat eine andere Art (→ `project.*`
unknown, Warnung im Log). Dafür: `workflow dry-run` und die Run-Details.

---

## 9. Checkliste „neuen Workflow anlegen“

1. **Trigger wählen:** `source` (Items), `schedule` (Cron) oder `manual`. Gleiche Abläufe für mehrere Repositories
   als **ein** Workflow mit `sources: [...]` (Reihenfolge = Tie-Breaker), Unterschiede je Repository als
   `vars` an der Source (`{source.vars.<Name>}`), bei Bedarf `max_concurrent_per_source`.
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
   Liste; Timeouts setzen; Secrets nur über `secrets`. Läuft der Worker (oder eine Shell-Action) länger als ein
   Installation-Token gilt (ca. 1 h), `delivery: file` verwenden und das Token pro Aufruf aus `<NAME>_FILE` lesen.
   Mitschnitte/Logs, die nach dem Cleanup erhalten bleiben sollen, unter `keep` eintragen.
6. **Hooks:** Label-Übergänge für jeden Ausgang (`on_start`, `on_success`, `on_failure`, `on_crash`,
   `on_start_error`, `on_timeout`, `on_cancel`) so wählen, dass das Item nicht hängen bleibt und nicht sofort wieder
   matcht (Retry-Blocks fangen Endlosschleifen technischer Fehler ab). Gleiche Aufräum-Ketten der technischen
   Ausgänge einmal in `on_error`; mehr als zwei fachliche Ausgänge über `on_result` (Worker schreibt `outcome`).
   Wer per `project` einen Status setzt, der im Filter vorkommt, setzt ihn in den Fehler-Hooks (bzw. `on_error`)
   auch zurück; Optionsnamen genau wie im Projekt, Schreibrecht der Identity (§3.2) vorher prüfen.
7. **Validieren:** `adispatch config validate --config-dir <dir>` → Exit 0, Warnungen lesen.
8. **Trockenlauf:** `adispatch workflow dry-run <id> --config-dir <dir>` – Kandidaten, Filter-Trace
   (kein `unknown` durch Tippfehler?), Prioritäten, Locks/Blocks, Kapazität; bei Projektfeldern die Zeilen
   `project fields:` (Werte oder Unknown-Grund, z. B. fehlende Rechte); bei mehreren Sources je Source eine Zeile
   `source <id>: … polled` (und ggf. `SOURCE ERROR`); bei `work_pr`/`work_branch` die Zeilen `linked fields:`.
9. **Aktivieren:** `enabled: true` setzen und `adispatch config reload --config-dir <dir>` (bei Fehlern
   bleibt die alte Konfiguration aktiv). Alternativ zuerst ein manueller Start über die UI.
10. **Beobachten:** erster Run in der UI (Status, Logs, Lifecycle-Journal), ggf. `max_concurrent` per Override
    anpassen und danach in YAML übernehmen (Overrides gehen beim Neustart verloren).
11. **Übersicht:** für den Überblick über die Items des Workflows eine View anlegen (§3.5): Pipeline-Stufen mit
    `sort[].order` in der richtigen Reihenfolge (Werte genau wie im Projekt; unbekannte Optionen meldet die View als
    Warnung), bei Bedarf `group_by_first` und `sections` (z. B. „Braucht Maintainer“, „Review“, `rest: true` für
    den Rest); geschlossene Items in einem Abschnitt nur, wenn der View-`filter` sie mit `state` auswählt.
