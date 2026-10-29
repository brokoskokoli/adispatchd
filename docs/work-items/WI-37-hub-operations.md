# WI-37 – Hub im Betrieb: systemd, `init`, Doku und Website

**Herkunft:** Wunsch des Maintainers (29. Oktober 2026) · **Abhängig von:** WI-35, WI-36 · **Branch:** `wi-37-hub-operations` · **Zielversion:** 0.10.0

## Umfang

1. **systemd:** `adispatch service install --hub` erzeugt eine Unit für `adispatch hub start` (Dienstbenutzer wie bisher,
   Drain-/Cancel-Timeouts, Env-Datei für Secrets aller Workspaces); Prüfungen wie bei `service install`
   (`--dry-run` funktioniert überall, auf dem Entwicklungsrechner keine echten systemd-Änderungen). Der Hub ist der
   einzige Dienst, Workspaces haben keine eigenen Units.
2. **`init`:** `adispatch hub init` legt `hub.yaml`, ein erstes Workspace-Verzeichnis mit der bestehenden Beispielkonfiguration
   (`init`-Vorlage) an; überschreibt nie.
3. **Migration einer Einzelinstanz:** dokumentierter Weg, eine bestehende Instanz als Workspace in einen Hub aufzunehmen
   (config-dir/data-dir unverändert eintragen, Port anpassen, alten Dienst stoppen); getestet.
4. **Betrieb:** `docs/operations.md` (Hub-Abschnitt: Aufbau, ein Benutzer für alle Workspaces, Hinweis auf Container-
   Executor `user` für getrennte Rechte, Reverse Proxy mit `/w/…`, Backup/Update, Verhalten bei Hub-Ausfall),
   `docs/manual-tests/` (Hub unter systemd/Linux), Konfigurationsreferenz.
5. **Öffentliche Doku:** README (EN) und README.de, Website `site/` (EN/DE) Feature-Liste, `examples/config`, CHANGELOG
   (0.10.0 datieren), `docs/status.md` (Gate-Ergebnisse), Spec-Kopf, `docs/handoff/WI-37.md`.
6. **Release 0.10.0 vorbereiten:** `package.json`, Lockfile, `APP_VERSION`, Installationszeilen; `npm run test:pack`
   erweitert um einen Hub-Durchlauf (pack → install → hub init → hub start → Run in zwei Workspaces → drain-all).
   Nicht pushen oder publizieren.

## Acceptance Criteria

- [x] `service install --hub --dry-run` zeigt die korrekte Unit; Tests für Pfadprüfungen und Fehlerfälle (`src/cli/service-hub.test.ts`: Unit, TimeoutStopSec aus allen Workspaces, geplante Schritte, macOS-Dry-Run, fehlende/ungültige `hub.yaml`, Trial-Layout abgelehnt, Systempfade, Verschachtelung, Socket-Pfadlänge, nicht-root, ungültiger Workspace, fehlender Benutzer; `src/service/unit.test.ts` (Snapshot), `install.test.ts`).
- [x] `hub init` ist idempotent und erzeugt eine gültige Konfiguration (`hub validate` grün) (`src/cli/hub.test.ts`: Standard-Layout, `--workspaces-data-dir`, `--empty`, zweiter Lauf ohne Änderung; `test:pack` mit dem installierten Paket).
- [ ] `test:pack` deckt den Hub ab und ist grün (macOS und Linux-Container `node:24`). **Teilweise belegt:** Hub-Durchlauf (installiertes Paket: `hub init` → `hub validate` → `service install --hub --dry-run` → `hub start` → Run in zwei Workspaces über `/w/<id>/` → `drain-all --wait` → SIGTERM, danach Migration einer Einzelinstanz) ist in `src/cli/pack.test.ts` und in der Sandbox grün; macOS und `node:24`-Container stehen aus.
- [x] Alle Dokumente, README EN/DE, Website und `examples/config` konsistent; Doku-Tests grün (`src/cli/hub-docs.test.ts`: Versionspins, Anker, Pflichtinhalte; `reference-doc.test.ts` mit Beispielsatz `hub-production`; `src/config/hub.test.ts` für `examples/hub/hub.yaml`; `examples/config` bleibt unverändert gültig, die Instanz-Konfiguration hat sich nicht geändert).
- [ ] `npm run check` und `npm run test:pack` grün. **Teilweise belegt:** in der Sandbox `test:pack` grün, `check` mit den 8–9 bekannten umgebungsbedingten Fehlschlägen (siehe `docs/status.md`); macOS und Linux-Container `node:24` stehen aus.
