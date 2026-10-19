# Work-Items – Übersicht

Zerlegung der Spec v0.1 in umsetzbare Pakete. **Status: alle Work-Items umgesetzt, reviewed und gemergt – siehe `../status.md`.** Abhängigkeiten bestimmen die Wellen; innerhalb einer Welle wird parallel gearbeitet.

| WI | Titel | Spec | Abhängig von | Welle |
|---|---|---|---|---|
| [01](WI-01-foundation.md) | Fundament: Projekt, Core-Typen, Hilfsfunktionen | §3, §4, §9, §20 | – | 1 |
| [02](WI-02-config.md) | Konfiguration: Schemas, Loader, Validierung | §5, §19 | 01 | 2 |
| [03](WI-03-persistence.md) | Persistenz: SQLite, Migrationen, Repositories, Instanz-Lock | §12, §21 | 01 | 2 |
| [04](WI-04-filters.md) | Filter-AST, Prioritäten, Shell-Filter/Conditions | §6, §7 | 01 | 2 |
| [05](WI-05-shell-executor.md) | Shell-Executor, Worker-Protokoll, Prozess-Supervision | §8, §9, §13 | 01 | 2 |
| [06](WI-06-github.md) | GitHub: App-Identitäten, Source-Adapter, Dependencies | §5.2, §5.3, §6, §10 | 01 | 2 |
| [07](WI-07-lifecycle.md) | Lifecycle-Aktionen, Action-Journal, Retries | §10 | 03, 05, 06 | 3 |
| [08](WI-08-run-controller.md) | Run-Controller, Ergebnisse, Retry-Blocks, Recovery, Shutdown | §8, §11, §13, §14 | 02–07 | 4 |
| [09](WI-09-scheduler.md) | Scheduler, Trigger (Source/Cron/Manual), Dry-Run | §7, §5.5, §19 | 08 | 5 |
| [10](WI-10-api-views-notifications.md) | HTTP-API, SSE, Views, Notifications, Retention | §15, §17, §18, §21 | 09 | 6 |
| [11](WI-11-web-ui.md) | Weboberfläche | §16 | 10 | 7 |
| [12](WI-12-cli-service.md) | CLI komplett, `init`, systemd-Service, Paketierung, Doku | §4, §14, §19 | 10 | 7 |
| [13](WI-13-config-fixes.md) | Korrekturen aus der Konfigurationsreferenz | §5, §6, §15, §17 | Referenz | 8 |
| [14](WI-14-project-fields.md) | Filter auf GitHub-Projects-Felder, weitere Issue-Felder, Identity `github_token` | §6, §5.3 | 13 | 9 (0.2.0) |
| [15](WI-15-named-filters.md) | Benannte, wiederverwendbare Filter (`filters/*.yaml`) | §6, §19 | 14 | 9 (0.2.0) |
| [16](WI-16-project-field-updates.md) | Projects-Felder per `source.update` setzen | §10 | 14, 15 | 10 (0.3.0) |
| [17](WI-17-outcomes-on-error.md) | Benannte Ergebnisse (`on_result`), Sammel-Hook `on_error` | §8, §10 | 15 | 10 (0.3.0) |
| [18](WI-18-token-files.md) | Erneuerbare Tokens als Datei, Secrets für Shell-Actions | §8, §20 | 15 | 10 (0.3.0) |
| [19](WI-19-container-executor.md) | Container-Executor (docker/podman) | §8, §13, §20 | 17, 18 | 11 (0.3.0) |
| [20](WI-20-multi-source-workflows.md) | Ein Workflow für mehrere Sources, Source-Variablen | §5.2, §7 | 16 | 11 (0.3.0) |
| [21](WI-21-linked-branches.md) | Verknüpfte Branches und PRs als Item-Felder | §6 | 16 | 11 (0.3.0) |
| [22](WI-22-keep-files.md) | Dateien vor dem Workspace-Cleanup sichern (`execute.keep`) | §8, §15, §21 | 15 | 10 (0.3.0) |
| [23](WI-23-resource-monitor.md) | Server-Ressourcen im Dashboard (CPU, RAM, Platte, Prozesse) | §16, §21 | 22 | 12 (0.3.1) |
| [24](WI-24-conditions-and-info.md) | Conditions in der Workflow-Ansicht, Info-Kacheln im Dashboard (`dashboard.yaml`) | §5, §16 | 22 | 12 (0.3.1) |

Ablauf je Work-Item: Coder-Agent (eigener Branch/Worktree) → Reviewer-Agent (prüft gegen Acceptance Criteria + Spec) → ggf. Fix-Runde → Merge nach `main`.

Bewusst **außerhalb** des automatisierten Umfangs (benötigen echte Umgebung, siehe §22/§24): Integrationstests gegen echtes GitHub, systemd-Tests auf Linux-Host, Prozess-Supervisor-Spike unter Linux-cgroups. Diese werden als manuelle Testanleitungen dokumentiert.
