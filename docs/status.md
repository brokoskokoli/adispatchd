# Projektstand

Stand: 27. Oktober 2026 · `main`, Version 0.9.0

Alle Work-Items WI-01 bis WI-34 (siehe `docs/work-items/`) sind umgesetzt. 0.2.0: WI-14 (Filter auf GitHub-Projects-Felder `project.<Feld>`, `state_reason`/`milestone`/`issue_type`, Identity `github_token`) und WI-15 (benannte Filter `filters/*.yaml`). 0.3.0: WI-16 (Projects-Felder per `source.update` setzen), WI-17 (`on_result` mit `outcome` in der Ergebnisdatei, Sammel-Hook `on_error`, DB-Schema v3), WI-18 (Tokens als erneuerte Datei `<NAME>_FILE`, `secrets` für Shell-Actions), WI-19 (Container-Executor docker/podman), WI-20 (`trigger.sources`, `max_concurrent_per_source`, `sources.<id>.vars`), WI-21 (`linked_branches`, `closing_prs`, `work_branch`, `work_pr`, `work_pr_url`) und WI-22 (`execute.keep`). 0.4.0 (unveröffentlicht): WI-23 (Server-Ressourcen im Dashboard: CPU/RAM/Platte/Prozesse, `monitoring` in `config.yaml`, `GET /api/v1/system/metrics`, SSE `system.metrics`; Branch `wi-23-resource-monitor`, Review-Nacharbeit erledigt), WI-24 (Namen und Status der Conditions in der UI, Info-Kacheln `dashboard.yaml`) und WI-25 (externe Tools `ui.external_links`, CSP als HTTP-Header). Jedes Work-Item wurde von einem Reviewer-Agent gegen seine Acceptance Criteria und die Spec geprüft, die Findings wurden behoben, dann wurde es gemergt. Details zu jedem Work-Item stehen in `docs/handoff/WI-NN.md`. 0.4.0 zusätzlich: WI-23 (Server-Ressourcen im Dashboard), WI-24 (Conditions in der Workflow-Ansicht, Info-Kacheln aus `dashboard.yaml`), WI-25 (externe Tools wie claude-inspect in der Toolbar), WI-26 (Anmeldung: Passwort oder vertrauenswürdiger Proxy-Header, Rollen, Steuer-Token für die CLI) und WI-27 (in der UI als App-Identität kommentieren, Labels und Projektfelder setzen, Audit-Tabelle, DB-Schema v4). 0.5.0: WI-28 (Views: Sortierung nach Wertereihenfolge, mehrere Sortierschlüssel, Abschnitte mit Überschriften) und WI-29 (kompakte Ressourcenleiste im Dashboard, Reiter „Resources“). 0.6.0: WI-30 (Hooks `on_retry_block`/`on_retry_unblock` beim Entstehen und Aufheben eines Retry-Blocks, Lifecycle-Run mit Trigger `unblock`, Platzhalter `{block.*}`, Benachrichtigung `retry_block_cleared`, DB-Schema v5). 0.7.0: WI-31 (Auswahllisten zur Laufzeit für Parameter manueller Starts: `options_from` mit GitHub-Branches/-Tags oder Skript, `allow_custom`, `GET /api/v1/workflows/:id/parameters/:name/options`). 0.8.0: WI-32 (Dashboard-Layout in `dashboard.yaml`: Reihen/Spalten/Widgets, View-Widgets, Reiter `tabs`, `GET /api/v1/dashboard`; Branch `wi-32-dashboard-layout`). 0.9.0: WI-33 (Item-Verlauf `#/items/<source>/<id>`: aktueller Stand, Pfad der Runs, Zeitleiste mit Hooks und strukturierter Wirkung jeder Action, Retry-Blocks, UI-Aktionen, optional GitHub-Timeline; View-Feld `history`; `GET /api/v1/items/:source/:item/history|github-events`; DB-Schema v6; Branch `wi-33-item-history`). 0.9.1 (unveröffentlicht): WI-34 (Dashboard-Widgets `active_runs`/`recent_runs` verlinken den Item-Verlauf, `recent_runs` mit Spalte „Item“; Branch `wi-34-dashboard-run-history-links`).

- **Gate (0.9.0):** `npm run check` grün auf macOS und Linux (Container `node:24`): 1628 Tests (3 übersprungen); `npm run test:pack` grün auf beiden.
- **Gate (0.8.0):** `npm run check` grün auf macOS und Linux (Container `node:24`): 1594 Tests (3 übersprungen); `npm run test:pack` grün auf beiden.
- **Gate (0.7.0):** `npm run check` grün auf macOS und Linux (Container `node:24`): 1568 Tests (3 übersprungen); `npm run test:pack` grün auf beiden.
- **Gate (0.6.0):** `npm run check` grün auf macOS und Linux (Container `node:24`): 1528 Tests (3 übersprungen); `npm run test:pack` grün auf beiden.
- **Gate (0.5.0):** `npm run check` grün auf macOS und Linux (Container `node:24`): 1501 Tests (3 übersprungen); `npm run test:pack` grün auf beiden.
- **Gate (0.4.0):** `npm run check` grün auf macOS und Linux (Container `node:24`, tmpfs): 1455 Tests (3 übersprungen); `npm run test:pack` grün auf beiden.
- **Gate (0.3.0):** `npm run check` grün auf macOS: 1084 Tests (3 übersprungen, darunter der optionale echte Docker-Test); `npm run test:pack` grün. Linux (Container `node:24`): 1084 Tests grün, `test:pack` grün. Echter Docker-Test (`ADISPATCH_CONTAINER_TEST=1`) auf macOS mit Docker Desktop grün.
- **Gate (0.2.0):** `npm run check` grün auf macOS und Linux (Container `node:24`): 813 Tests (1 übersprungen); `npm run test:pack` grün auf beiden.
- **Paket-Test:** `npm run test:pack` grün (pack → install → init → start → Run → drain → Update).
- **Dateiformate:** verbindliche Referenz in `docs/configuration-reference.md`; ein Test validiert alle Beispiele darin gegen den echten Loader.
- **Abschlussprüfung:** Smoke-Test der installierten App erfolgreich (init, start, manueller Run, API, SSE, Dry-Run, drain mit Exit 0). Die Abdeckung der Szenarien aus §22.2 ist unten zusammengefasst.

## Abdeckung der Akzeptanzszenarien (§22.2)

| # | Automatisiert | Grenze |
|---|---|---|
| 1, 4, 7, 9, 11 | end-to-end (echte Prozesse, SQLite, Fake-GitHub) | – |
| 2 | end-to-end | Lock-Konflikt nur manuell gegen manuell getestet |
| 3 | end-to-end gegen Fake-GitHub | Annahmen A1–A11 zum echten GitHub ungeprüft |
| 5, 6 | je Komponente vollständig | keine einzelne Kette über Scheduler, Controller und API |
| 8 | Absturz simuliert (DB-Zustand plus echter verwaister Prozess) | kein echter `kill -9`, nicht unter systemd |
| 10 | App über HTTP | Run-Historie direkt in die DB geschrieben |
| 12 | Migration mit Backup, Paket-Update | systemd-Update auf Linux ungetestet |

## Offen vor Produktivbetrieb

**P1 – blockierend**
1. Die systemd-Tests auf einer Linux-VM durchführen (`docs/manual-tests/systemd.md`).
2. Den Prozess-Supervisor-Spike unter Linux durchführen (`docs/manual-tests/process-supervision.md`), auch das Zusammenspiel mit `KillMode=mixed`.
3. Den GitHub-Integrationstest gegen echte Repos durchführen: Anleitung mit 26 Testfällen, Fixture und `gh`-Befehlen in `docs/manual-tests/github.md`. Dabei die Dependencies-API, die App-Rechte und den Kommentar-Marker über `performed_via_github_app` prüfen und API-Version `2026-03-10` bestätigen; seit WI-14 auch die GitHub-Projects-Abfragen (GraphQL, org- und user-eigene Projekte, `github_token`, T25 / A12–A17), seit WI-16 das Setzen von Projektfeldern (Mutationen, Schreibrechte, T26 / A18–A21), seit WI-21 die Verknüpfungen Branch/PR (`linkedBranches`, `closedByPullRequestsReferences`, T27 / A22–A25).
   Container-Executor (WI-19) mit echtem Docker (`ADISPATCH_CONTAINER_TEST=1 npx vitest run src/executors/container-docker.test.ts`) sowie Podman und rootless Docker unter Linux prüfen.
4. Name: **Agent Dispatch Daemon**, Paket `adispatchd`, Befehl `adispatch`, Lizenz MIT. Öffentlich: https://github.com/brokoskokoli/adispatchd und npm `adispatchd`. Optional noch offen: npm-Org `@adispatchd` reservieren.

**P2 – vor Release**
5. Versionen pinnen und die Sicherheitslage prüfen (Node 24 LTS, TypeScript 7, Vitest 5, zod 4, fastify).
6. Die Version an einer einzigen Stelle führen; sie steht heute in `package.json` und in `APP_VERSION`.
7. ~~`test:pack` in die CI aufnehmen~~ – erledigt: GitHub Actions (`.github/workflows/ci.yml`, Node 22 und 24: `npm run check` + `npm run test:pack`).
8. Einen echten Coder-/Reviewer-Workflow durchspielen (§23).

**P3 – Härtung und Betrieb**
9. Den Reverse Proxy mit Authentifizierung und `server.allowed_hosts` einrichten.
10. Die UI in weiteren Browsern prüfen und einen Browser-E2E-Test ergänzen.
11. Skalierung angehen:
    - `listCandidates` ohne `since`/ETag
    - Listen ohne Paging
    - globale SSE-Verbindung, die `run.output` aller Runs empfängt
