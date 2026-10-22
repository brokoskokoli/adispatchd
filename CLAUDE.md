# Agent Dispatch Daemon (adispatchd) – Anleitung für Coding-Agenten

Diese Datei gilt für Claude Code und andere Agenten (`AGENTS.md` verweist hierher). Sie beschreibt, wie in diesem
Repository gearbeitet wird. Was gebaut ist, steht in der Doku, nicht hier.

## Name und Paket
- Projekt: **Agent Dispatch Daemon**; npm-Paket, Repository, systemd-Unit und Standardpfade: `adispatchd`;
  CLI-Befehl: `adispatch`. Lizenz MIT. Öffentliches Repository: `brokoskokoli/adispatchd`, Website aus `site/`
  (GitHub Pages).

## Einstieg in eine neue Sitzung
Lies in dieser Reihenfolge:
1. `docs/status.md` – Version, Gate-Ergebnisse, offene Punkte (P1/P2).
2. `docs/conventions.md` – verbindliche Regeln für Code, Tests, Git und Handoffs.
3. `CHANGELOG.md` – was in welcher Version kam; Abschnitt „Unreleased“ = laufende Arbeit.
4. `git log --oneline -15`, `git worktree list` – laufende Branches `wi-NN-*`.
5. Bei Arbeit an einem Thema: das passende `docs/work-items/WI-NN-*.md` und `docs/handoff/WI-NN.md`.

## Quellen der Wahrheit
| Datei | Inhalt |
|---|---|
| `docs/spec-v0.1.md` | Spezifikation; Kopf „Umgesetzt bis Version …“, je Work-Item ein Nachtrag |
| `docs/configuration-reference.md` | verbindliche Referenz aller Dateiformate (ein Test validiert die Beispiele darin) |
| `docs/api.md`, `docs/worker-protocol.md`, `docs/operations.md` | HTTP-API, Worker-Protokoll, Betrieb |
| `docs/work-items/` | ein Arbeitspaket pro Datei mit Acceptance Criteria |
| `docs/handoff/` | Übergabe je Work-Item: Umgesetztes, Abweichungen, Tests |
| `README.md` (EN), `README.de.md`, `site/` (EN/DE) | öffentliche Beschreibung |

Ändert sich Verhalten, werden **alle** betroffenen Dokumente im selben Branch mitgezogen (Referenz, API, Spec-
Nachtrag, CHANGELOG, Status, README EN/DE, Website-Feature-Liste, `examples/config`, `init`-Vorlage).

## Arbeitsweise (Orchestrator mit Sub-Agenten)
1. Neuer Wunsch → kurz auf Kohärenz mit dem bestehenden Modell prüfen und dem Maintainer einen Entwurf vorschlagen.
2. Nach Zustimmung: `docs/work-items/WI-NN-<kurzname>.md` mit Umfang, Entscheidungen und Acceptance Criteria anlegen,
   auf `main` committen.
3. Worktree und Branch: `git worktree add -b wi-NN-<kurzname> ../orchestrator-wt/wi-NN main`.
4. Coder-Agent im Worktree setzt um (inkl. Doku und Handoff). Danach ein **unabhängiger Reviewer-Agent** gegen
   Acceptance Criteria und Spec; Findings werden behoben, dann Merge nach `main` durch den Orchestrator.
5. Agenten nie auf `main` committen lassen; Agenten pushen nie.

## Gate und Release
- Vor jedem Commit: `npm run check` (Typecheck Server + UI, alle Tests).
- Vor einem Release zusätzlich:
  - `npm run test:pack` (pack → install → init → start → Run → drain → Update).
  - Dasselbe Gate unter Linux im Container `node:24` (Quellstand als Tar hineinreichen, `npm ci`, `npm run check`,
    `npm run test:pack`).
  - `src/version.test.ts` prüft, dass `APP_VERSION`, `package.json` und `package-lock.json` übereinstimmen; Tests
    verwenden `APP_VERSION` statt fester Versionsnummern.
- Release vorbereiten: Version setzen (`package.json`, Lockfile, `APP_VERSION`), CHANGELOG-Abschnitt datieren,
  `docs/status.md` mit Gate-Ergebnissen (Testanzahl macOS/Linux), Spec-Kopf, Tag `vX.Y.Z`.
- **`npm publish` führt der Maintainer selbst aus** (Bestätigung im Browser). Danach Registry prüfen
  (`npm view adispatchd versions dist-tags`).
- Schema-Änderungen der DB sind Einbahnstraßen: Migration mit Backup, Major-/Minor-Version entsprechend erhöhen.

## Öffentliches Repository – Datenschutz vor jedem Push
Das Repository ist öffentlich. Vor **jedem** Push, als eigener Schritt (nie mit dem Push verkettet):
- `git grep -nE "/Users/|/private/tmp|claude-[0-9]+/|scratchpad"` muss leer sein (Ausnahmen nur bewusst geprüft).
- Keine echten Namen, keine privaten oder Firmen-E-Mail-Adressen, keine Namen privater Projekte des Maintainers in
  Code, Doku, Beispielen, Tests oder Commit-Messages. Beispiele bleiben generisch (`acme/app`, `my-project`).
- Commit-Identität ist die GitHub-noreply-Adresse des Kontos; vor dem Push `git log --format='%an <%ae>'` prüfen.
- Sub-Agenten schreiben keine lokalen Pfade (Screenshots, Scratchpad) in committete Dateien.

## Sicherheit
- Secrets nie loggen, persistieren oder in API-Antworten ausgeben; nie nach Secret-Werten fragen.
- Auf dem Entwicklungsrechner keine echten systemd-Änderungen (`adispatch service install --dry-run`).
- Laufende Instanzen, die nicht vom Agenten selbst gestartet wurden, nicht anfassen. Eigene Testinstanzen nur über
  die eigene PID oder `adispatch drain` mit eigenen Verzeichnissen stoppen – nie `pkill`/`killall` nach Mustern.
- Fremde Prozesse und Container nicht beenden; kein `docker system prune` o. Ä.
- Der Entwicklungsrechner ist nicht schnell: Tests gezielt (`npx vitest run <datei>`), volles Gate am Ende, keine
  parallelen schweren Läufe.

## Commits
- Englisch, Imperativ, Präfix `WI-NN:` auf Work-Item-Branches; kleine, sinnvolle Commits.
- Agenten-Commits tragen die von der Sitzung vorgegebenen Attribution-Zeilen (`Co-Authored-By: …`).
