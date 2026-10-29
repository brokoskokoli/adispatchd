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

- [ ] `service install --hub --dry-run` zeigt die korrekte Unit; Tests für Pfadprüfungen und Fehlerfälle.
- [ ] `hub init` ist idempotent und erzeugt eine gültige Konfiguration (`hub validate` grün).
- [ ] `test:pack` deckt den Hub ab und ist grün (macOS und Linux-Container `node:24`).
- [ ] Alle Dokumente, README EN/DE, Website und `examples/config` konsistent; Doku-Tests grün.
- [ ] `npm run check` und `npm run test:pack` grün.
