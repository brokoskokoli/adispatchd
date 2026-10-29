# Worker-Protokoll

Vertrag zwischen Orchestrator und Haupt-Worker (`execute`) bzw. Shell-Lifecycle-Actions. Spec §8.2, §9, §13, §20.
Implementierung: `src/core/worker-protocol.ts`, `src/executors/`.

## Start

- Jeder Run bekommt einen **eigenen Workspace** (Default `{workspace.base_dir}/{workflow.id}/{run.id}`, `create_directory: true`);
  der Orchestrator legt ihn an. Klonen, Git-Worktrees, `npm install`, Docker … erledigt das Skript selbst.
- Das Kommando wird **ohne Shell** mit Argumentliste gestartet (`command` + `args`); Platzhalter in `args`/`env` werden vorher
  ersetzt (feste Platzhalterliste, unbekannte sind Konfigurationsfehler). Wer Shell-Syntax braucht, schreibt ein Skript.
- Eigene Prozessgruppe/Session (`setsid`), stdin = `/dev/null`, cwd = Workspace.
- Dateien, die nach dem Run erhalten bleiben sollen (Mitschnitte, Gate-Logs), schreibt der Worker **in den Workspace**
  und der Workflow nennt sie unter `execute.keep` (relative Glob-Muster). Der Daemon kopiert sie nach dem Abschluss-Hook
  und vor dem Cleanup nach `data-dir/runs/<run-id>/kept/` – nur reguläre Dateien, keine Symlinks, bis `keep_max_size`
  ([Konfigurationsreferenz](configuration-reference.md) §3.4.8).

### Container-Worker (`execute.type: container`, seit 0.3.0)

Der Worker läuft in einem Wegwerf-Container (`<engine> run --rm --init …` im Vordergrund, Details:
[Konfigurationsreferenz](configuration-reference.md) §3.4.8 „Container“). Für den Worker gilt dasselbe Protokoll,
nur mit Container-Pfaden:

| Variable im Container | Wert |
|---|---|
| `ADISPATCH_CONTEXT_FILE` | `/adispatch/context.json` (read-only gemountet) |
| `ADISPATCH_RESULT_FILE` | `/adispatch/out/result.json` – `/adispatch/out/` ist das einzige beschreibbare Daemon-Verzeichnis (leer zu Beginn) |
| `ADISPATCH_WORKSPACE` | Ziel des Workspace-Mounts (Default `/work`); ebenso `workspace.path` in der Kontextdatei |
| `<NAME>_FILE` (`delivery: file`) | `/adispatch/secrets/<NAME>` (Verzeichnis read-only gemountet, Datei wird weiterhin atomar ersetzt) |
| `ADISPATCH_RUN_ID`, `ADISPATCH_WORKFLOW_ID`, `ADISPATCH_SOURCE_*` | wie beim Shell-Worker |
| `execute.env`, `execute.secrets` (`delivery: env`) | wie beim Shell-Worker; Werte gelangen über die Umgebung des Engine-Prozesses (`-e NAME`) in den Container, nie über die Kommandozeile |

Der Container bekommt **keine** Minimalumgebung vom Host (`PATH`, `HOME` … kommen aus dem Image) und läuft mit
`--cap-drop ALL --security-opt no-new-privileges`, standardmäßig als `<uid>:<gid>` des Dienstbenutzers. stdout/stderr,
Events, Exit-Code und Ergebnisdatei werden genau wie beim Shell-Worker ausgewertet (Exit-Code des Containers).
Cancel/Timeout: `<engine> stop -t <cancel_grace>` (SIGTERM an den Init-Prozess des Containers, nach der Frist SIGKILL).

## Input

### Umgebung (Minimalumgebung, Spec §9.1/§20.3)

Der Worker erbt **nicht** die Umgebung des Orchestrators. Er bekommt nur:

| Variable | Inhalt |
|---|---|
| `PATH`, `HOME`, `LANG`, `TZ`, `USER`, `LOGNAME`, `TMPDIR` | aus der Controller-Umgebung (Fallback-`PATH` `/usr/local/bin:/usr/bin:/bin`) |
| `execute.env` | explizite Werte aus der Workflow-YAML (keine Secrets!) |
| `execute.secrets` (`delivery: env`, Default) | z. B. `GH_TOKEN: { identity: coder }` → kurzlebiges GitHub-App-Installation-Token in `GH_TOKEN`, nur im Speicher, beim Start einmal geholt |
| `execute.secrets` (`delivery: file`, seit 0.3.0) | z. B. `GH_TOKEN: { identity: coder, delivery: file }` → `GH_TOKEN_FILE` = Pfad der Token-Datei (s. u.); `GH_TOKEN` selbst ist **nicht** gesetzt |
| `ADISPATCH_RUN_ID` | stabile, eindeutige Run-ID (`run-YYYYMMDDTHHMMSSmmmZ-xxxxxxxx`) |
| `ADISPATCH_WORKFLOW_ID` | Workflow-ID |
| `ADISPATCH_SOURCE_TYPE`, `ADISPATCH_SOURCE_ID`, `ADISPATCH_SOURCE_ITEM_ID`, `ADISPATCH_SOURCE_URL` | nur bei Runs mit Source-Item (z. B. `github`, `project_a`, `123`, Issue-URL) |
| `ADISPATCH_CONTEXT_FILE` | Pfad der Kontextdatei (JSON, s. u.) |
| `ADISPATCH_RESULT_FILE` | Pfad, an den der Worker optional sein Ergebnis schreibt |
| `ADISPATCH_WORKSPACE` | absoluter Workspace-Pfad |

`ADISPATCH_*` kann durch `env`/`secrets` nicht überschrieben werden (reservierter Präfix).

### Token-Dateien (`delivery: file`, seit 0.3.0)

Ein Installation-Token gilt ca. 1 h. Damit lange Runs keine App-Schlüssel brauchen, kann der Daemon das Token als
Datei bereitstellen und erneuern:

- Pfad: `data-dir/runs/<run-id>/secrets/<NAME>` (Verzeichnis `0700`, Datei `0600`, Dienstbenutzer), **außerhalb**
  des Workspaces; der Pfad steht in `<NAME>_FILE`. Inhalt: nur das Token, ohne Zeilenumbruch.
- Solange der Worker läuft, ersetzt der Daemon die Datei **atomar** (temporäre Datei + `rename` im selben
  Verzeichnis) spätestens **10 Minuten vor Ablauf** des Tokens. Wer die Datei liest, bekommt immer ein vollständiges
  Token – nie eine halb geschriebene Datei; gültig ist es, solange die Erneuerung klappt (s. u.). Identities ohne Ablauf (`github_token`) werden einmal geschrieben.
- **Pro Aufruf lesen**, nicht einmal am Anfang in eine Variable kopieren:

  ```sh
  GH_TOKEN=$(cat "$GH_TOKEN_FILE") gh pr create --fill
  ```

- Scheitert das Erneuern (z. B. GitHub nicht erreichbar), loggt der Daemon das (ohne Token) und versucht es mit
  Backoff erneut; der Worker läuft weiter, die Datei enthält bis dahin das alte, noch gültige Token.
- Nach dem Ende des Workers (jeder Endstatus) wird das Verzeichnis gelöscht; nach einem Neustart des Daemons räumt
  die Recovery Reste weg (Tokens werden dann nicht mehr erneuert), die Retention entfernt übrig gebliebene Verzeichnisse.
- Jedes ausgegebene Token wird beim Redactor registriert, **bevor** es in der Datei steht (stdout/stderr, Live-Output,
  Events, Ergebnis, Dienst-Log).
- Wird das Verzeichnis während des Runs ersetzt oder entfernt (anderes Inode, Symlink), schreibt der Daemon nicht
  mehr hinein: Erneuerungen enden (Fehler im Dienst-Log, ohne Token), der Worker behält das alte Token.
- **Isolation:** Die Rechte `0700`/`0600` schützen nur vor **anderen Systembenutzern**, nicht vor anderen Runs und Actions **desselben Dienstes**: Alle Worker laufen als derselbe Dienstbenutzer, die Pfade sind vorhersagbar – ein Worker kann die Token-Datei eines parallel laufenden Runs lesen (genauso wie unter Linux dessen Umgebung über `/proc/<pid>/environ` bei `delivery: env`). Wer hoch- und niedrig-privilegierte Workflows trennen muss, betreibt getrennte Instanzen unter getrennten Benutzern oder nutzt Container (WI-19).

### Kontextdatei `ADISPATCH_CONTEXT_FILE` (`data-dir/runs/<run-id>/context.json`, Modus 0600)

```json
{
  "schema_version": 1,
  "run": { "id": "run-…", "trigger": "source", "started_at": "2026-10-16T19:00:00Z" },
  "workflow": { "id": "coder-project-a", "name": "Coder – Project A" },
  "source": {
    "id": "project_a", "type": "github", "item_id": "123", "item_key": "project_a:123",
    "url": "https://github.com/example/project-a/issues/123",
    "attributes": { "title": "Implement OAuth", "labels": ["coding"] }
  },
  "parameters": {},
  "workspace": { "path": "/var/lib/adispatchd/workspaces/coder-project-a/run-…" }
}
```

`source.attributes` enthält die billigen Item-Felder; bei GitHub-Items zusätzlich `linked_branches`, `closing_prs`
(`[{ "number": 12, "state": "open", "head_ref": "feature/12", "is_draft": false, "url": "…" }]`), `work_branch`,
`work_pr` und `work_pr_url`, **wenn der Workflow sie verwendet** (`{item.work_branch}`/`{item.work_pr}` in `execute`
oder eines der Felder in `filter`/`item_priority`; Konfigurationsreferenz §5.3) – frisch beim Start gelesen,
unbekannte Werte fehlen. `source` fehlt bei Cron-/Manual-Runs ohne Item; `run.scheduled_for` gibt es bei Cron-Runs; `parameters` enthält die validierten
Parameter manueller Starts (inkl. Defaults). Die Datei enthält **nie** Secrets.

## Output

### Exit-Code und Ergebnisdatei (verbindlich, Spec §8.2)

| Exit-Code | Ergebnisdatei | Ergebnis |
|---|---|---|
| `0` | `"result": "success"` | `completed` / `success` → `on_success` |
| `0` | `"result": "failure"` | `completed` / `failure` → `on_failure` (fachlich, **kein** technischer Fehler) |
| `0` | zusätzlich `"outcome": "x"` und `on_result.x` konfiguriert | `completed` / laut `result` → `on_result.x` **statt** `on_success`/`on_failure` |
| `0` | keine | `completed` / `success` (einfache Shell-Skripte) |
| `0` | ungültig / zu groß / kein reguläres File | `crashed` (Protokollfehler) → `on_crash` |
| `≠ 0` | beliebig (wird ignoriert) | `crashed` → `on_crash` |
| Signal | beliebig | `crashed` (außer durch Cancel/Timeout) |
| Start unmöglich (ENOENT, kein Exec-Recht, `on_start` gescheitert) | – | `start_error` → `on_start_error` |
| Timeout (`max_duration`, `idle_timeout`) | beliebig | `timed_out` → `on_timeout` |
| kontrollierter Abbruch (UI/API/Cancel-All) | beliebig | `cancelled` → `on_cancel` |

Ist der spezifische Hook eines technischen Ausgangs (`on_crash`, `on_start_error`, `on_timeout`, `on_cancel`) nicht
definiert, läuft stattdessen `on_error` (falls vorhanden; ab 0.3.0).

- **Ein fachliches `failure` gibt es nur mit gültiger Ergebnisdatei.** Ein Exit-Code allein ist nie „Needs Maintainer“ – ein
  versehentliches `exit 1` (z. B. `git clone` scheitert) ist ein technischer Fehler.
- Technische Fehler (`crashed`, `start_error`, `timed_out`) zählen pro Workflow+Item; nach `retry.max_technical_failures`
  (Default 3) aufeinanderfolgenden Fehlern entsteht ein **Retry-Block** (UI „Blocked“ → „Remove Block“). `failure` und
  `cancelled` zählen nicht; ein Erfolg setzt den Zähler zurück.

Ergebnisdatei (max. 1 MiB, **atomar schreiben**: temporäre Datei + `mv`):

```json
{
  "schema_version": 1,
  "result": "failure",
  "message": "OAuth-Anbieter nicht spezifiziert",
  "details": { "missing_information": ["OAuth provider", "Scopes"] },
  "artifacts": [ { "type": "url", "name": "Draft PR", "url": "https://github.com/example/project-a/pull/142" } ]
}
```

| Feld | Pflicht | Regel |
|---|---|---|
| `schema_version` | ja | `1` |
| `result` | ja | `success` \| `failure` |
| `message` | nein | ≤ 10 000 Zeichen; als `{result.message}` in Hooks verfügbar |
| `details` | nein | beliebiges Objekt |
| `artifacts` | nein | ≤ 100 Einträge `{type, name?, url?}` |
| `outcome` | nein | benanntes Ergebnis (ab 0.3.0): Konfigurations-ID (Buchstaben, Ziffern, `_`, `-`; beginnt mit Buchstabe/Ziffer; max. 64). Wählt `on_result.<outcome>`; als `{result.outcome}` in Hooks und `run.last_outcome` in Views. Falsches Format → ignoriert (Warnung am Run), Rest wird normal ausgewertet |

**Benannte Ergebnisse:** Kennt ein Workflow mehr als zwei fachliche Ausgänge, meldet der Worker sie über `outcome`;
`result` bleibt Pflicht und steuert Statistik und Retry-Zähler (`success` setzt zurück). Die Label-/Kommentar-Arbeit
erledigt dann `on_result.<outcome>` – der Worker braucht dafür keine eigenen Tokens. Ohne passenden Eintrag laufen
`on_success`/`on_failure` (Warnung am Run). Bei Exit ≠ 0 wird die Ergebnisdatei – und damit auch `outcome` – ignoriert.

```json
{ "schema_version": 1, "result": "failure", "outcome": "needs_maintainer", "message": "Scope unklar" }
```

```sh
tmp="${ADISPATCH_RESULT_FILE}.tmp"
printf '%s\n' '{"schema_version":1,"result":"success","message":"PR opened"}' > "$tmp"
mv "$tmp" "$ADISPATCH_RESULT_FILE"
```

### Logs und Events (Spec §9.3)

- stdout und stderr werden getrennt und unverändert nach `data-dir/logs/<run-id>/{stdout,stderr}.log` geschrieben
  (best-effort Redaction bekannter Secrets) und live per SSE an die UI gesendet. Limit `retention.max_log_size_per_run`
  (stdout+stderr zusammen, Default 100 MB): danach wird abgeschnitten und das als Diagnose-Event markiert.
- Strukturierte Events: eine Zeile `@@ADISPATCH_EVENT {json}` auf stdout oder stderr, JSON-Objekt mit `type`, max. 64 KiB:

```text
@@ADISPATCH_EVENT {"type":"status","message":"Tests laufen"}
@@ADISPATCH_EVENT {"type":"progress","value":60}
@@ADISPATCH_EVENT {"type":"question","message":"Welcher OAuth-Anbieter?"}
```

  Events sind **nur informativ** (keine Workflow-Transitionen); `status`-Events mit `message` erscheinen als letzte
  Statusmeldung auf Run-Karten. Ungültige Zeilen bleiben im Log und erzeugen eine Parser-Warnung.
- `idle_timeout` misst die Zeit seit der letzten Ausgabe (auch Events). Lange stille Phasen → regelmäßig ein
  `progress`-/`status`-Event ausgeben.

## Abbruch, Timeout, Prozesse

- Cancel/Timeout: `SIGTERM` an die **ganze Prozessgruppe**, nach `execute.cancel_grace` (Default 30 s) `SIGKILL`; der Run
  gilt erst als beendet, wenn die Gruppe nachweislich weg ist.
- Bleiben nach normalem Exit noch Prozesse der Gruppe übrig (`cmd &` ohne `wait`), werden sie beendet.
- Prozesse **außerhalb** der Gruppe (eigene Session via `setsid`, `nohup … &` mit neuer Session, selbst gestartete
  Docker-Container) erfasst der Orchestrator nicht – das Skript ist für deren Cleanup verantwortlich (`trap '…' TERM EXIT`,
  `docker run --rm --init`). Für Worker in Containern gibt es `execute.type: container`: Dann stoppt der Daemon den
  Container selbst (Cancel, Timeout, Recovery nach Neustart über das Label `adispatch.instance`).
- Nach einem Absturz des Orchestrators beendet die Recovery verwaiste Worker nur bei sicher verifizierter Identität
  (PID + Startzeit/Boot-ID); sonst `recovery_pending` (sichtbar, kein Doppelstart). Unter systemd beendet systemd die
  Worker beim Absturz ohnehin mit der cgroup (siehe [operations.md](operations.md#hub-als-systemd-dienst-seit-0100-wi-38)).

## Slot-Protokoll (Hub, seit 0.10.0)

Läuft die Instanz unter einem Hub ([operations.md](operations.md#hub-mehrere-workspaces-auf-einem-server-seit-0100)), setzt der
Hub `ADISPATCH_HUB_SOCKET` (Pfad des Unix-Sockets `<hub-data-dir>/slots.sock`, Modus `0600`) und `ADISPATCH_HUB_WORKSPACE`
(Workspace-ID) in die Umgebung der Instanz. **Ohne `ADISPATCH_HUB_SOCKET` ändert sich nichts** (Einzelinstanz). Die Variablen
gehören dem Daemon, nicht den Workern: Worker, Actions und Prüfskripte erhalten sie nicht (Minimalumgebung, §„Umgebung“).
Implementierung: `src/hub/protocol.ts`, `slot-server.ts` (Hub), `slot-client.ts` (Instanz), `ledger.ts`.

**Framing:** je Zeile ein JSON-Objekt (`\n`), höchstens 64 KiB. Die Instanz meldet sich mit `hello` an; danach gilt:

| Instanz → Hub | Wirkung |
|---|---|
| `{"t":"hello","v":1,"workspace":"coder","pid":4720,"leases":["run:…"]}` | Anmeldung; `leases` = die Plätze, die die Instanz noch hält (nach einem Hub-Neustart zählt der Hub sie damit wieder – die Liste ist maßgeblich). Antwort `welcome`. Unbekannte Workspace-IDs und andere Protokollversionen werden mit `error` abgewiesen |
| `{"t":"acquire","id":7,"lease":"a:<uuid>"}` | Platz für einen automatischen Run; Antwort `granted` oder `denied` (mit Grund) |
| `{"t":"adopt","lease":"run:<run-id>"}` | Platz für einen Run, der nicht abgelehnt werden kann (manueller Start, Run aus der Recovery); darf das Limit überschreiten |
| `{"t":"release","lease":"…"}` | Platz zurückgeben |
| `{"t":"heartbeat","leases":["…"]}` | alle 2 s: Lebenszeichen; Plätze, die der Hub hält und die in der Liste fehlen, werden freigegeben, unbekannte Einträge ignoriert. Antwort `state` |
| `{"t":"bye"}` | Abmeldung ohne laufende Runs; gibt alle Plätze frei |

| Hub → Instanz | Bedeutung |
|---|---|
| `{"t":"welcome","active":3,"max":6,"paused":false}` | angemeldet |
| `{"t":"granted","id":7}` / `{"t":"denied","id":7,"reason":"hub limit reached (6/6 active)","active":…,"max":…,"paused":…}` | Antwort auf `acquire` (`reason` auch `hub paused (no new automatic runs)`) |
| `{"t":"state","active":4,"max":6,"paused":false}` | gepusht bei jeder Änderung an alle Verbindungen und als Antwort auf `heartbeat` |
| `{"t":"error","code":"…","message":"…"}` | Protokollfehler (Verbindung wird geschlossen) |

**Garantien.** (1) Der Hub vergibt per `acquire` nie mehr als `max` Plätze (Entscheidung und Buchung sind ein Schritt). Nur
`adopt`/`hello` echter Runs können `active` über `max` heben; bis sie enden, wird kein `acquire` gewährt. (2) Plätze verfallen
sofort, wenn der Hub sieht, dass der Kindprozess endet, und nach 15 s ohne Nachricht der Verbindung (die Verbindung wird dann
geschlossen); eine geschlossene Verbindung hält die Plätze noch 15 s, damit sich die Instanz mit `hello` neu verbinden kann.
(3) Die Instanz gleicht ihre Plätze bei jedem Heartbeat mit der Datenbank ab: ein aktiver Run ohne Platz bekommt einen
(`adopt`), ein Platz ohne aktiven Run wird freigegeben; ein vergebener, aber nie einem Run zugeordneter Platz wird nach 60 s
zurückgegeben. (4) **Sichere Seite:** Ist der Hub nicht erreichbar oder antwortet 5 s lang nicht auf `acquire`, startet die
Instanz keinen automatischen Run (Entscheidung `hub_limit`: „hub not reachable (no new automatic runs)“); laufende Runs sind
nie betroffen. Die Verbindung wird mit 0,5 s … 5 s Backoff neu aufgebaut.

**Ablauf in der Instanz.** Source-Workflows: Kandidat prüfen (Filter, Conditions) → `acquire` → in einem synchronen
Abschnitt Limits erneut prüfen, Run reservieren, starten → der Platz gehört dem Run und wird mit dessen Ende
freigegeben. Scheitert etwas dazwischen (Gate zu, Lock-Konflikt, Start fehlgeschlagen), wird der Platz zurückgegeben. Cron-Termine
gehen genauso vor. Die Vorprüfung (`capacityProblem`) nutzt den letzten gepushten Stand (`active >= max` → `hub_limit`, ohne
Anfrage), damit ein volles Limit keine Prüfungen kostet.

## Sicherheit

Worker und Shell-Actions sind **vertrauenswürdiger Konfigurationscode** mit den OS-Rechten des Dienstes – es gibt keine
Sandbox. Ein Worker kann ihm übergebene Secrets (z. B. `GH_TOKEN` oder den Inhalt von `GH_TOKEN_FILE`) ausgeben; die Redaction in Logs ist best-effort
(transformierte Secrets, z. B. base64, werden nicht erkannt). Nur benötigte Secrets deklarieren, App-Rechte minimal halten.
Event-/Result-/Log-Inhalte werden in API/UI als untrusted Text behandelt.

Secrets sind nicht zwischen Runs/Actions desselben Dienstes isoliert: Die Rechte `0700`/`0600` schützen nur vor **anderen Systembenutzern**, nicht vor anderen Runs und Actions **desselben Dienstes**: Alle Worker laufen als derselbe Dienstbenutzer, die Pfade sind vorhersagbar – ein Worker kann die Token-Datei eines parallel laufenden Runs lesen (genauso wie unter Linux dessen Umgebung über `/proc/<pid>/environ` bei `delivery: env`). Wer hoch- und niedrig-privilegierte Workflows trennen muss, betreibt getrennte Instanzen unter getrennten Benutzern oder nutzt Container (WI-19).

Mit `execute.type: container` sieht ein Worker nur seine eigenen Mounts: den eigenen Workspace, die eigene Kontextdatei,
das eigene Ausgabeverzeichnis und die eigenen Token-Dateien (plus konfigurierte `mounts`) – nicht die Token-Dateien
oder Umgebungen anderer Runs. Die Grenze ist die Engine (Container-Isolation, Rechte des Engine-Daemons), nicht der
Daemon; wer `docker` nutzen darf, ist faktisch root ([operations.md](operations.md) „Container-Executor“). Mit
`network: host` erreicht der Container die API des Daemons auf `127.0.0.1`.

Die Ergebnisdatei wird bei **allen** Executors ohne Symlinks gelesen (`lstat`, `O_NOFOLLOW`, Prüfung des Handles,
aufgelöster Pfad im erwarteten Verzeichnis): Symlink, FIFO oder ein ausgetauschtes Verzeichnis ergeben `crashed`
(Protokollfehler), ungültiges JSON wird nur mit Position gemeldet.

## Shell-Lifecycle-Actions und Prüfskripte

| Art | Erfolg | Kontext |
|---|---|---|
| `shell`-Action in Hooks | Exit 0 (Ergebnisdatei wird ignoriert); sonst Retry gemäß `lifecycle.action_retry` | `ADISPATCH_CONTEXT_FILE` mit `kind: lifecycle_action`, Run, Hook (z. B. `on_result.approved`, `on_error`), Action, `result` (außer `on_start` und `on_retry_unblock`; inkl. `outcome`), in `on_retry_block`/`on_retry_unblock` (seit 0.6.0) zusätzlich `block {id, failures, created_at, last_status, cleared_at, cleared_by}`, Minimal-Env + `env` + `ADISPATCH_*`; Secrets **nur**, wenn die Action `secrets` deklariert (seit 0.3.0, wie `execute.secrets`; in allen Hooks inkl. `on_result.*`, `on_error` und den Retry-Block-Hooks) |
| `conditions.*`, `shell_filter` | Exit 0 = passt, 1 = passt nicht, ≥ 2/Timeout/Signal = Prüffehler (`unknown`, kein Start) | `ADISPATCH_CHECK_CONTEXT_FILE` (Workflow bzw. Item) |
| Info-Skripte (`dashboard.yaml`, seit 0.4.0) | Exit 0 **und** ein lesbarer Wert auf der ersten nicht-leeren stdout-Zeile (`text`; `number` mit Punkt, optional + `unit`; `percent` 0–100, optional `%`). Jeder andere Exit-Code (auch 1), Timeout, Signal oder ein unlesbarer Wert = Fehler (letzter gültiger Wert bleibt sichtbar) | `ADISPATCH_CHECK_CONTEXT_FILE` mit `{schema_version: 1, kind: "dashboard_info", info: {id, type}, config_dir, data_dir}`, dazu `ADISPATCH_INFO_ID`, `ADISPATCH_CONFIG_DIR`, `ADISPATCH_DATA_DIR`; Minimal-Env + `env`; Arbeitsverzeichnis = config-dir; keine Secrets |

Die Exit-Code-Semantik 0/1/≥2 gilt **nur** für Conditions und `shell_filter`, nicht für den Haupt-Worker und nicht für
Info-Skripte. Dry-Runs führen Prüfskripte nie aus. Info-Skripte laufen nur im Hintergrund (Start, Ablauf von `cache`,
Reload, gedrosselter „Refresh“), nie durch einen Seitenaufruf; Ausgabe bis 4 KiB je Stream, Timeout beendet die ganze
Prozessgruppe. stderr dient der Diagnose: die erste Zeile erscheint (redigiert, gekürzt) in der Fehlermeldung der
Kachel bzw. – bei Workflow-Conditions – im angezeigten letzten Status.

**Secrets für Shell-Actions** (seit 0.3.0): `secrets: { GH_TOKEN: { identity: maintainer, delivery: env|file } }` an
der Action. Tokens werden pro Versuch geholt; bei `file` liegt die Datei unter
`data-dir/runs/<run>/actions/<action>/attempt-<n>/secrets/<NAME>`, wird während langer Actions ebenso erneuert und
nach dem Versuch gelöscht. Werte werden im Action-Log redigiert. Conditions und `shell_filter` bekommen nie Secrets.
