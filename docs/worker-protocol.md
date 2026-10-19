# Worker-Protokoll

Vertrag zwischen Orchestrator und Haupt-Worker (`execute`) bzw. Shell-Lifecycle-Actions. Spec §8.2, §9, §13, §20.
Implementierung: `src/core/worker-protocol.ts`, `src/executors/`.

## Start

- Jeder Run bekommt einen **eigenen Workspace** (Default `{workspace.base_dir}/{workflow.id}/{run.id}`, `create_directory: true`);
  der Orchestrator legt ihn an. Klonen, Git-Worktrees, `npm install`, Docker … erledigt das Skript selbst.
- Das Kommando wird **ohne Shell** mit Argumentliste gestartet (`command` + `args`); Platzhalter in `args`/`env` werden vorher
  ersetzt (feste Platzhalterliste, unbekannte sind Konfigurationsfehler). Wer Shell-Syntax braucht, schreibt ein Skript.
- Eigene Prozessgruppe/Session (`setsid`), stdin = `/dev/null`, cwd = Workspace.

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
  Verzeichnis) spätestens **10 Minuten vor Ablauf** des Tokens. Wer die Datei liest, bekommt immer ein vollständiges,
  gültiges Token – nie eine halb geschriebene Datei. Identities ohne Ablauf (`github_token`) werden einmal geschrieben.
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

`source` fehlt bei Cron-/Manual-Runs ohne Item; `run.scheduled_for` gibt es bei Cron-Runs; `parameters` enthält die validierten
Parameter manueller Starts (inkl. Defaults). Die Datei enthält **nie** Secrets.

## Output

### Exit-Code und Ergebnisdatei (verbindlich, Spec §8.2)

| Exit-Code | Ergebnisdatei | Ergebnis |
|---|---|---|
| `0` | `"result": "success"` | `completed` / `success` → `on_success` |
| `0` | `"result": "failure"` | `completed` / `failure` → `on_failure` (fachlich, **kein** technischer Fehler) |
| `0` | keine | `completed` / `success` (einfache Shell-Skripte) |
| `0` | ungültig / zu groß / kein reguläres File | `crashed` (Protokollfehler) → `on_crash` |
| `≠ 0` | beliebig (wird ignoriert) | `crashed` → `on_crash` |
| Signal | beliebig | `crashed` (außer durch Cancel/Timeout) |
| Start unmöglich (ENOENT, kein Exec-Recht, `on_start` gescheitert) | – | `start_error` → `on_start_error` |
| Timeout (`max_duration`, `idle_timeout`) | beliebig | `timed_out` → `on_timeout` |
| kontrollierter Abbruch (UI/API/Cancel-All) | beliebig | `cancelled` → `on_cancel` |

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
- Prozesse **außerhalb** der Gruppe (eigene Session via `setsid`, `nohup … &` mit neuer Session, Docker-Container) erfasst
  der Orchestrator nicht – das Skript ist für deren Cleanup verantwortlich (`trap '…' TERM EXIT`, `docker run --rm --init`).
- Nach einem Absturz des Orchestrators beendet die Recovery verwaiste Worker nur bei sicher verifizierter Identität
  (PID + Startzeit/Boot-ID); sonst `recovery_pending` (sichtbar, kein Doppelstart). Unter systemd beendet systemd die
  Worker beim Absturz ohnehin mit der cgroup (siehe [operations.md](operations.md#systemd)).

## Sicherheit

Worker und Shell-Actions sind **vertrauenswürdiger Konfigurationscode** mit den OS-Rechten des Dienstes – es gibt keine
Sandbox. Ein Worker kann ihm übergebene Secrets (z. B. `GH_TOKEN` oder den Inhalt von `GH_TOKEN_FILE`) ausgeben; die Redaction in Logs ist best-effort
(transformierte Secrets, z. B. base64, werden nicht erkannt). Nur benötigte Secrets deklarieren, App-Rechte minimal halten.
Event-/Result-/Log-Inhalte werden in API/UI als untrusted Text behandelt.

## Shell-Lifecycle-Actions und Prüfskripte

| Art | Erfolg | Kontext |
|---|---|---|
| `shell`-Action in Hooks | Exit 0 (Ergebnisdatei wird ignoriert); sonst Retry gemäß `lifecycle.action_retry` | `ADISPATCH_CONTEXT_FILE` mit `kind: lifecycle_action`, Run, Hook, Action, `result` (außer `on_start`), Minimal-Env + `env` + `ADISPATCH_*`; Secrets **nur**, wenn die Action `secrets` deklariert (seit 0.3.0, wie `execute.secrets`) |
| `conditions.*`, `shell_filter` | Exit 0 = passt, 1 = passt nicht, ≥ 2/Timeout/Signal = Prüffehler (`unknown`, kein Start) | `ADISPATCH_CHECK_CONTEXT_FILE` (Workflow bzw. Item) |

Die Exit-Code-Semantik 0/1/≥2 gilt **nur** für Prüfskripte, nicht für den Haupt-Worker. Dry-Runs führen Prüfskripte nie aus.

**Secrets für Shell-Actions** (seit 0.3.0): `secrets: { GH_TOKEN: { identity: maintainer, delivery: env|file } }` an
der Action. Tokens werden pro Versuch geholt; bei `file` liegt die Datei unter
`data-dir/runs/<run>/actions/<action>/attempt-<n>/secrets/<NAME>`, wird während langer Actions ebenso erneuert und
nach dem Versuch gelöscht. Werte werden im Action-Log redigiert. Conditions und `shell_filter` bekommen nie Secrets.
