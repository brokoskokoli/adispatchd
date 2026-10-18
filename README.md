# Agent Dispatch Daemon (`adispatchd`)

Konfigurationsgetriebener Orchestrator für Shell-Prozesse und KI-Agenten. Er findet Aufgaben in externen Quellen
(V1: GitHub Issues/PRs), wählt sie über Filter und Prioritäten aus, prüft Startbedingungen, führt unabhängige
Shell-Workflows in eigenen Workspaces aus, überwacht und protokolliert jeden Run, führt Lifecycle-Aktionen aus
(Labels, Kommentare, Shell-Hooks) und zeigt alles in einer kleinen Weboberfläche mit Live-Updates.

- **GitHub bleibt Source of Truth** – kein eigener Ticketstore; SQLite hält nur Runs, Locks, Events, Blocks, Aktionsjournale.
- **Unabhängige Workflows** mit Source-, Cron- oder manuellem Trigger, globalen und workflowbezogenen Limits.
- **Robust:** technische Fehler vs. fachliches `failure`, Retry-Blocks, Aktions-Retries, Cancel/Timeout per
  Prozessgruppe, Drain, Crash-Recovery, systemd-Integration.

Dokumentation: [Betrieb](docs/operations.md) · [Worker-Protokoll](docs/worker-protocol.md) · [HTTP-API/SSE](docs/api.md) ·
[Cron-Semantik](docs/cron-semantics.md) · [Spezifikation](docs/spec-v0.1.md) · Manuelle Tests:
[systemd](docs/manual-tests/systemd.md), [Prozess-Supervision](docs/manual-tests/process-supervision.md),
[GitHub](docs/manual-tests/github.md)

## Installation

Voraussetzungen: Linux (Produktion, systemd) oder macOS (lokal), **Node.js ≥ 22.13** (empfohlen 24 LTS; SQLite kommt aus
`node:sqlite`, kein natives Addon). Windows wird nicht unterstützt.

> **Paketname:** `adispatchd` (Befehl: `adispatch`). Das Paket ist noch **nicht** in der npm-Registry veröffentlicht
> (`private: true`) – bis dahin nur aus dem Repository-Checkout bzw. als Tarball installieren.

```bash
git clone <repo-url> adispatchd && cd adispatchd
npm install
npm pack                                        # baut (prepack) und erzeugt adispatchd-0.1.0.tgz
npm install -g ./adispatchd-0.1.0.tgz   # feste Version aus dem Tarball (für Dienste Pflicht)
# lokal ohne globale Installation: npm run build && node dist/cli/main.js <kommando> …
```

## Quickstart (lokal)

```bash
adispatch init --config-dir ./config --data-dir ./data      # legt Beispielkonfiguration + Skripte an
adispatch start --config-dir ./config --data-dir ./data     # Vordergrund, Ctrl-C = Drain
```

- Weboberfläche/API: <http://127.0.0.1:8787/> (`/health`, `/ready`, `/api/v1/…`).
- Workflow **hello** (manuell, ohne GitHub) starten – in der UI unter *Workflows* oder:
  ```bash
  curl -X POST -H 'X-Adispatch-Request: 1' -H 'Content-Type: application/json' \
       -d '{"parameters":{"name":"Ada"}}' http://127.0.0.1:8787/api/v1/workflows/hello/start
  ```
  Logs liegen unter `data/logs/<run-id>/`, Kontext/Ergebnis unter `data/runs/<run-id>/`.
- Steuerung: `adispatch status|pause|resume|drain|cancel-all --config-dir ./config`.
- GitHub anbinden: GitHub App je Rolle anlegen (Rechte: Issues r/w, Pull requests write, Metadata read), App-/Installation-ID in
  `identities.yaml`, Repo in `sources.yaml`, Private Key als Umgebungsvariable (`export GITHUB_CODER_PRIVATE_KEY="$(cat key.pem)"`),
  dann in `workflows/coder.yaml` `enabled: true` setzen und `adispatch config reload --config-dir ./config`.

`init` überschreibt nie bestehende Dateien (vorhandene werden als „kept“ gemeldet) und validiert danach die Konfiguration.

## CLI

| Kommando | Zweck |
|---|---|
| `init --config-dir D --data-dir D [--port P]` | Verzeichnisstruktur + kommentierte Beispielkonfiguration anlegen |
| `start --config-dir D --data-dir D [--drain-timeout 10m] [--cancel-timeout 2m] [--host H] [--port P]` | Orchestrator im Vordergrund; SIGTERM/SIGINT = Drain, danach Cancel-All; 2. Signal = sofort Cancel-All; Exit 0 nach geordnetem Stop |
| `status`, `pause`, `resume` | Zustand / automatische Starts pausieren und fortsetzen |
| `drain [--wait] [--timeout T]` | keine neuen Runs, aktive zu Ende, dann Stop |
| `cancel-all [--reason R] [--wait]` | alle Runs abbrechen (`on_cancel`), dann Stop |
| `config validate --config-dir D` | Offline-Validierung (Syntax, Schema, Referenzen, Platzhalter) mit Datei:Zeile |
| `config reload` | laufende Instanz lädt die Konfiguration atomar neu (ungültig → alte bleibt aktiv) |
| `workflow dry-run <id> [--json] [--local]` | Kandidatenauswahl ohne Start/Actions/Shell-Prüfungen; gegen die laufende Instanz, sonst lokal |
| `service install\|status\|uninstall [--dry-run]` | systemd-Dienst (Linux), siehe [Betrieb](docs/operations.md#installation-als-systemd-dienst-linux) |

HTTP-Kommandos finden die Instanz über `--url` oder Host/Port aus `config.yaml` von `--config-dir` (Default
`http://127.0.0.1:8787`). Exit-Codes: 0 ok, 1 Fehler, 2 Aufruffehler, 3 Instanz nicht erreichbar, 4 `--wait`-Timeout.

## Konfiguration

**Verbindliche Referenz aller Dateien, Felder, Defaults, Filter, Platzhalter und des Auswertungsablaufs:
[docs/configuration-reference.md](docs/configuration-reference.md)** (ersetzt die Formatvorschläge der Spec; die
Beispiele darin werden per Test gegen den echten Loader geprüft).

```
config-dir/                      data-dir/
  config.yaml   global (§5.1)      adispatchd.sqlite   Runs, Locks, Events, Blocks, Journale
  sources.yaml  GitHub-Repos       adispatchd.lock     Instanzsperre (nie anfassen)
  identities.yaml GitHub Apps      logs/<run>/stdout.log, stderr.log
  workflows/*.yaml                 runs/<run>/context.json, result.json
  views/*.yaml                     workspaces/<workflow>/<run>/
  scripts/*.sh                     backups/   DB-Backups vor Migrationen
```

Ein Workflow (vollständiges Beispiel: `workflows/coder.yaml` nach `init`, Referenz: [Konfigurationsreferenz](docs/configuration-reference.md)):

```yaml
id: coder
priority: 50                         # Workflow-Priorität vor Item-Priorität
max_concurrent: 2
identity: coder                      # GitHub-App für Labels/Kommentare
trigger: { type: source, source: project_a }   # oder { type: schedule, cron: '0 3 * * *' } / { type: manual }
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
conditions:
  workflow: [ { type: shell, command: scripts/check-credits.sh, cache: 60s } ]
execute:
  type: shell
  command: scripts/coder.sh          # relativ zum config-dir; ohne Shell, Argumente als Liste
  secrets: { GH_TOKEN: { identity: coder } }
  timeout: { max_duration: 6h, idle_timeout: 45m }
retry: { max_technical_failures: 3 }
on_start:   [ { type: source.update, labels: { add: [coding], remove: [ready-for-coding] } } ]
on_success: [ { type: source.comment, message: 'Completed: {result.message}' } ]
on_failure: [ { type: source.update, labels: { add: [needs-maintainer], remove: [coding] } } ]
on_crash:   [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]
```

- Hooks: `on_start`, `on_success`, `on_failure`, `on_crash`, `on_start_error`, `on_timeout`, `on_cancel`; Actions
  `source.update`, `source.comment`, `shell`; Retry 3 × 30 s (`lifecycle.action_retry`), `continue_on_error`.
- Platzhalter (feste Liste): `{run.id}`, `{workflow.id}`, `{item.number}`, `{item.url}`, `{result.message}`,
  `{parameters.<name>}`, `{workspace.base_dir}` … – unbekannte Platzhalter sind Konfigurationsfehler.
- Manuelle Starts (UI/API) umgehen Filter, Conditions, Limits und Retry-Blocks, nie aber den aktiven Lock pro Workflow+Item.
- Views (`views/*.yaml`) sind read-only Tabellen über mehrere Sources inkl. `run.last_*`-Feldern.
- Änderungen gelten erst nach `config reload` (oder UI „Reload“); laufende Runs nutzen ihren Snapshot. Runtime-Overrides aus
  der UI gehen bei Neustart verloren.
- Secrets stehen nie in YAML: Private Keys/Webhook-URLs nur über Umgebungsvariablen (`private_key_env`, `url_env`, `headers_env`).

## Worker-Protokoll (Kurzfassung)

Details: [docs/worker-protocol.md](docs/worker-protocol.md).

- **Input:** Minimalumgebung (`PATH`, `HOME`, …) + `execute.env` + deklarierte Secrets + `ADISPATCH_RUN_ID`, `ADISPATCH_WORKFLOW_ID`,
  `ADISPATCH_SOURCE_*`, `ADISPATCH_WORKSPACE`, `ADISPATCH_CONTEXT_FILE` (JSON-Kontext), `ADISPATCH_RESULT_FILE`. Keine Controller-Umgebung.
- **Exit-Code = technischer Status:** `0` = ok, alles andere = `crashed` (technischer Fehler, zählt zum Retry-Block).
- **Fachliches Ergebnis** nur über die Ergebnisdatei (atomar schreiben):
  `{"schema_version":1,"result":"failure","message":"Requirements unclear"}` + `exit 0` → `on_failure` („Needs Maintainer“),
  kein technischer Fehler. Ohne Datei gilt Exit 0 als `success`.
- **Events:** Zeilen `@@ADISPATCH_EVENT {"type":"status","message":"Tests laufen"}` auf stdout/stderr – nur informativ.
- **Cancel/Timeout:** SIGTERM an die Prozessgruppe, nach `cancel_grace` (30 s) SIGKILL. Eigene Sessions/Container räumt das
  Skript selbst auf.

## Sicherheit

- **Keine Anmeldung in V1.** Die API bindet standardmäßig nur an `127.0.0.1`. Fernzugriff ausschließlich über einen
  **authentifizierenden** Reverse Proxy, VPN oder Tailscale; dessen Hostnamen in `server.allowed_hosts` eintragen
  (DNS-Rebinding-Schutz). Bei Nicht-Loopback-Bind warnt `start`. Anleitung: [Betrieb → Fernzugriff](docs/operations.md#fernzugriff-reverse-proxy-spec-15-201).
- Mutierende Requests brauchen den Header `X-Adispatch-Request: 1`; es gibt keine CORS-Freigaben.
- **Skripte und YAML sind vertrauenswürdiger Code** mit den Rechten des Dienstes – keine Sandbox. Schreibrecht auf das
  config-dir ist gleichbedeutend mit Codeausführung; `service install` legt es `root`-eigen an und lässt den Dienst unter einem
  eigenen Benutzer laufen.
- Worker erhalten nur ausdrücklich deklarierte Secrets (z. B. kurzlebiges `GH_TOKEN`); Secrets werden nie in Kontext-/
  Ergebnisdateien, API-Antworten oder Logs persistiert, Redaction in Prozesslogs ist best-effort. Ein Worker kann ihm
  übergebene Secrets dennoch ausgeben.
- GitHub-Apps mit minimalen Rechten; fehlende Rechte bei Cross-Repo-Abhängigkeiten führen zu `unknown` (kein Start), nicht zu „0“.
- Event-, Result- und Log-Inhalte werden in der UI nur als Text dargestellt.

## Betrieb

Kurzfassung – Details in [docs/operations.md](docs/operations.md):

- **systemd:** `sudo adispatch service install --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd --create-user`
  (vorher `--dry-run`). Unit mit absolutem Node-/Paketpfad, dediziertem Benutzer, `Restart=on-failure`, `KillMode=mixed`,
  `TimeoutStopSec` > Drain + Cancel + Grace. Secrets in `/etc/default/adispatchd`.
- **Geplante Stopps/Updates:** `adispatch drain --wait`, dann neuen Tarball installieren (`npm install -g ./adispatchd-<neu>.tgz`), starten.
  Migrationen laufen automatisch mit Backup in `data-dir/backups/`; config-dir und data-dir bleiben erhalten.
- **Backups:** config-dir (git), Env-Datei, `adispatchd.sqlite` per `sqlite3 … ".backup …"`, `logs/`, `runs/`.
  `adispatchd.lock*` nie kopieren oder öffnen. data-dir nur auf lokalem Dateisystem (kein NFS).
- **Recovery:** nach Absturz/Neustart werden verwaiste Runs `crashed` + `on_crash`, nicht sicher identifizierbare Prozesse
  `recovery_pending` (UI „Retry Recovery“); der Scheduler startet erst danach.

## Entwicklung

```bash
npm install
npm run check        # Gate: tsc --noEmit && vitest run (vor jedem Commit)
npm run test:pack    # npm pack → Installation im Temp-Verzeichnis → init → start → drain → Update (≈ 10–60 s)
npm run dev -- start --config-dir ./config --data-dir ./data   # ohne Build (tsx)
npm run build        # nach dist/
```

```
src/
  core/        gemeinsame Typen, Verträge, Hilfsfunktionen
  config/      YAML-Konfiguration, Schemas, Reload        persistence/ SQLite, Migrationen, Repositories, Instanz-Lock
  filters/     Filter-AST, Prioritäten, Shell-Checks      executors/   Shell-Executor, Worker-Protokoll, Prozessidentität
  sources/     GitHub-Adapter                             identities/  GitHub-App-Credentials
  lifecycle/   Lifecycle-Aktionen, Action-Journal         runs/        Run-Controller, Recovery, Shutdown, Retention
  scheduler/   Scheduler, Trigger, Dry-Run                views/ notifications/ api/ (HTTP/SSE) ui/ (Weboberfläche)
  cli/         Kommandos                                  service/     systemd-Unit und Installationsplan
  app.ts       Bootstrap einer Instanz
```

Konventionen: [docs/conventions.md](docs/conventions.md) · Arbeitspakete: [docs/work-items/](docs/work-items/README.md) ·
Übergaben: `docs/handoff/`.
