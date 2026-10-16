# Entwicklungskonventionen

Verbindliche Regeln für alle Work-Items (Coder- und Reviewer-Agents).

## Grundlage
- Spezifikation: `docs/spec-v0.1.md` (im Folgenden „Spec“, Abschnitte als `§n`).
- Bei Widerspruch gilt §8.2 (Exit-Code/Ergebnisdatei) vor §24.2: Exit-Code ≠ 0 ist immer technisch (`crashed`), fachliches `failure` nur über gültige Ergebnisdatei.
- Arbeitsname des Pakets: `agent-orchestrator`, Binary: `agent-orchestrator`.

## Stack
- Node.js ≥ 22.13 (entwickelt mit Node 24), TypeScript `strict`, ESM (`"type": "module"`, `NodeNext`-Module, Importe mit `.js`-Endung).
- SQLite über das eingebaute `node:sqlite` (`DatabaseSync`), kein natives Addon.
- YAML: `yaml`; Schemas: `zod`; HTTP: `fastify` (+ `@fastify/static`); Cron: `croner`; CLI: `commander`; Tests: `vitest`.
- Neue Laufzeit-Dependencies nur, wenn wirklich nötig, und im Handoff begründen. GitHub-API über `fetch` + `node:crypto` (JWT RS256), kein Octokit.

## Code
- Code, Bezeichner und Code-Kommentare auf Englisch; Doku (`docs/`) darf Deutsch sein.
- Layout: `src/<komponente>/…`, Tests co-located als `*.test.ts`.
- Gemeinsame Typen/Interfaces liegen in `src/core/`. Komponenten importieren voneinander nur über deren `index.ts`.
- Keine globalen Singletons; Abhängigkeiten per Konstruktor/Factory injizieren (Clock, Logger, HTTP-Client, Prozess-Spawner), damit testbar.
- Zeit über `Clock`-Interface (`src/core/clock.ts`), nie direkt `Date.now()` in Logik, die getestet werden muss.
- Secrets nie loggen, nie persistieren, nie in API-Antworten (Spec §20).

## Gate (muss vor jedem Commit grün sein)
```bash
npm run check   # = tsc --noEmit && vitest run
```

## Git
- Ein Work-Item = ein Branch `wi-NN-kurzname`, kleine sinnvolle Commits, Commit-Messages auf Englisch im Imperativ, Präfix `WI-NN:`.
- Nicht auf `main` committen (Merge erfolgt durch den Orchestrator-Agent nach Review).
- `package.json`/`package-lock.json` nur ändern, wenn das Work-Item es braucht.

## Handoff
Am Ende jedes Work-Items eine Datei `docs/handoff/WI-NN.md` anlegen/aktualisieren: Was umgesetzt ist, bewusste Abweichungen/offene Punkte, wie testen, öffentliche API der Komponente (kurz).
