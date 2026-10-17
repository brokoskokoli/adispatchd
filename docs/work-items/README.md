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

Ablauf je Work-Item: Coder-Agent (eigener Branch/Worktree) → Reviewer-Agent (prüft gegen Acceptance Criteria + Spec) → ggf. Fix-Runde → Merge nach `main`.

Bewusst **außerhalb** des automatisierten Umfangs (benötigen echte Umgebung, siehe §22/§24): Integrationstests gegen echtes GitHub, systemd-Tests auf Linux-Host, Prozess-Supervisor-Spike unter Linux-cgroups. Diese werden als manuelle Testanleitungen dokumentiert.
