# agent-orchestrator

Konfigurationsgetriebener Orchestrator für Shell-Prozesse und KI-Agenten: findet Aufgaben in externen
Quellen (V1: GitHub Issues/PRs), wählt sie über Filter und Prioritäten aus, führt unabhängige
Shell-Workflows aus, überwacht und protokolliert jeden Run und zeigt alles in einer kleinen Weboberfläche.

Spezifikation: [`docs/spec-v0.1.md`](docs/spec-v0.1.md) · Konventionen: [`docs/conventions.md`](docs/conventions.md) ·
Arbeitspakete: [`docs/work-items/`](docs/work-items/README.md)

> Status: in Entwicklung. Die CLI-Kommandos sind noch Stubs.

## Dev-Setup

Voraussetzung: Node.js ≥ 22.13 (entwickelt mit Node 24, siehe `.nvmrc`).

```bash
npm install
npx tsx src/cli/main.ts --help   # CLI ohne Build starten
npm run build                    # nach dist/ kompilieren
```

## Gate

Vor jedem Commit muss das Gate grün sein:

```bash
npm run check   # = tsc --noEmit && vitest run
```

Weitere Skripte: `npm test` (nur Tests), `npm run typecheck` (nur Typprüfung).

## Struktur

```
src/
  core/        gemeinsame Typen, Interfaces und reine Hilfsfunktionen (Verträge)
  config/      YAML-Konfiguration, Schemas, Reload
  persistence/ SQLite, Migrationen, Repositories
  filters/     Filter-AST, Prioritäten, Shell-Checks
  executors/   Shell-Executor, Worker-Protokoll
  sources/     Source-Adapter (GitHub)
  identities/  Credential-Provider (GitHub Apps)
  lifecycle/   Lifecycle-Aktionen, Action-Journal
  runs/        Run-Controller, Recovery
  scheduler/   Scheduler, Trigger, Dry-Run
  views/ notifications/ api/ ui/ cli/ service/
```

Komponenten importieren voneinander nur über deren `index.ts`.
