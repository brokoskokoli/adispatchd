# Projektstand

Stand: 17. Oktober 2026 · `main`

Alle Work-Items WI-01 bis WI-13 (siehe `docs/work-items/`) sind umgesetzt. Jedes wurde von einem Reviewer-Agent gegen seine Acceptance Criteria und die Spec geprüft, die Findings wurden behoben, dann wurde es gemergt. Details zu jedem Work-Item stehen in `docs/handoff/WI-NN.md`.

- **Gate:** `npm run check` grün auf macOS und Linux (Container `node:24`): 744 Tests.
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
3. Den GitHub-Integrationstest gegen echte Repos durchführen: Anleitung mit 24 Testfällen, Fixture und `gh`-Befehlen in `docs/manual-tests/github.md`. Dabei die Dependencies-API, die App-Rechte und den Kommentar-Marker über `performed_via_github_app` prüfen und API-Version `2026-03-10` bestätigen.
4. Paketname und Binary-Name festlegen: `agent-orchestrator` ist in der npm-Registry vergeben. Bis dahin nur per Tarball installieren (`private: true`). Lizenz klären.

**P2 – vor Release**
5. Versionen pinnen und die Sicherheitslage prüfen (Node 24 LTS, TypeScript 7, Vitest 5, zod 4, fastify).
6. Die Version an einer einzigen Stelle führen; sie steht heute in `package.json` und in `APP_VERSION`.
7. `test:pack` in die CI bzw. den Release-Ablauf aufnehmen.
8. Einen echten Coder-/Reviewer-Workflow durchspielen (§23).

**P3 – Härtung und Betrieb**
9. Den Reverse Proxy mit Authentifizierung und `server.allowed_hosts` einrichten.
10. Die UI in weiteren Browsern prüfen und einen Browser-E2E-Test ergänzen.
11. Skalierung angehen:
    - `listCandidates` ohne `since`/ETag
    - Listen ohne Paging
    - globale SSE-Verbindung, die `run.output` aller Runs empfängt
