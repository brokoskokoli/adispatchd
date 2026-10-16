# WI-12 – CLI komplett, `init`, systemd-Service, Paketierung, Doku

**Spec:** §4, §14, §19, §20.1, §21 · **Abhängig von:** 10 · **Branch:** `wi-12-cli-service` · **Verzeichnisse:** `src/cli/`, `src/service/`, `docs/`

## Umfang
1. `init --config-dir --data-dir`: legt Verzeichnisstruktur §4 mit kommentierter Beispielkonfiguration und Beispielskripten an; überschreibt nie bestehende Dateien.
2. `start`: startet App (WI-10), druckt URL, Warnung bei Nicht-Loopback.
3. `config validate` (Offline), `config reload` und `workflow dry-run` gegen laufende Instanz über HTTP (`--url`, Default aus config), Fallback lokal für dry-run.
4. Steuerkommandos: `drain`, `cancel-all`, `pause`, `resume`, `status` über HTTP.
5. `service install|status|uninstall` (Linux/systemd): Unit-Datei generieren mit absolutem Node- und Paketpfad (kein `npx`), dedizierter Benutzer (anlegen optional mit `--create-user`, sonst Hinweis), `Restart=on-failure`, `KillMode=mixed`, `TimeoutStopSec` abgestimmt auf Drain-Timeout, Dateirechte für config/data. `--dry-run` gibt Unit nur aus. Auf macOS: verständliche Meldung. Unit-Generierung als reine Funktion getestet.
6. Paketierung: `npm pack` liefert lauffähiges Paket (`dist/`, UI-Assets, Migrationen, Beispiel-Config), `bin`-Shebang, `files`-Liste, `engines`.
7. Doku: `README.md` (Installation, Quickstart, Konfiguration, Worker-Protokoll, Sicherheitshinweise), `docs/operations.md` (systemd, Drain/Update-Ablauf, Backups, Recovery), `docs/worker-protocol.md`, `docs/manual-tests/systemd.md` (§22.1 systemd-Tests als Checkliste), `docs/manual-tests/process-supervision.md` (§24.3-Spike).

## Acceptance Criteria
- [ ] `npm pack` + Installation in Temp-Verzeichnis + `agent-orchestrator init` + `start` funktioniert (Skript-Test).
- [ ] `init` überschreibt nichts (Test).
- [ ] Generierte Unit enthält keine `npx`-Zeile, absolute Pfade, dedizierten User (Snapshot-Test).
- [ ] Szenario 12 dokumentiert und so weit lokal möglich getestet (Update erhält data-dir, Migration mit Backup).
