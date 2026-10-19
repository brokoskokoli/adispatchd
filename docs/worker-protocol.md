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
| `execute.secrets` | z. B. `GH_TOKEN: { identity: coder }` → kurzlebiges GitHub-App-Installation-Token, nur im Speicher |
| `ADISPATCH_RUN_ID` | stabile, eindeutige Run-ID (`run-YYYYMMDDTHHMMSSmmmZ-xxxxxxxx`) |
| `ADISPATCH_WORKFLOW_ID` | Workflow-ID |
| `ADISPATCH_SOURCE_TYPE`, `ADISPATCH_SOURCE_ID`, `ADISPATCH_SOURCE_ITEM_ID`, `ADISPATCH_SOURCE_URL` | nur bei Runs mit Source-Item (z. B. `github`, `project_a`, `123`, Issue-URL) |
| `ADISPATCH_CONTEXT_FILE` | Pfad der Kontextdatei (JSON, s. u.) |
| `ADISPATCH_RESULT_FILE` | Pfad, an den der Worker optional sein Ergebnis schreibt |
| `ADISPATCH_WORKSPACE` | absoluter Workspace-Pfad |

`ADISPATCH_*` kann durch `env`/`secrets` nicht überschrieben werden (reservierter Präfix).

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
Sandbox. Ein Worker kann ihm übergebene Secrets (z. B. `GH_TOKEN`) ausgeben; die Redaction in Logs ist best-effort
(transformierte Secrets, z. B. base64, werden nicht erkannt). Nur benötigte Secrets deklarieren, App-Rechte minimal halten.
Event-/Result-/Log-Inhalte werden in API/UI als untrusted Text behandelt.

## Shell-Lifecycle-Actions und Prüfskripte

| Art | Erfolg | Kontext |
|---|---|---|
| `shell`-Action in Hooks | Exit 0 (Ergebnisdatei wird ignoriert); sonst Retry gemäß `lifecycle.action_retry` | `ADISPATCH_CONTEXT_FILE` mit `kind: lifecycle_action`, Run, Hook, Action, `result` (außer `on_start`), Minimal-Env + `env` + `ADISPATCH_*`, **keine Secrets** |
| `conditions.*`, `shell_filter` | Exit 0 = passt, 1 = passt nicht, ≥ 2/Timeout/Signal = Prüffehler (`unknown`, kein Start) | `ADISPATCH_CHECK_CONTEXT_FILE` (Workflow bzw. Item) |

Die Exit-Code-Semantik 0/1/≥2 gilt **nur** für Prüfskripte, nicht für den Haupt-Worker. Dry-Runs führen Prüfskripte nie aus.
