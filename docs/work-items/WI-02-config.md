# WI-02 – Konfiguration: Schemas, Loader, Validierung

**Spec:** §5, §19, §20 · **Abhängig von:** 01 · **Branch:** `wi-02-config` · **Verzeichnis:** `src/config/`

## Umfang
1. zod-Schemas für `config.yaml` (§5.1), `sources.yaml` (§5.2), `identities.yaml` (§5.3), `workflows/*.yaml` (§5.4, §5.5), `views/*.yaml` (§17). Defaults gemäß Spec (polling 30s, max_concurrent, workspace.base_dir `${dataDir}/workspaces`, cleanup `on_success`, action_retry 3×30s, retention-Defaults, server `127.0.0.1:8787`).
2. Workflow-Schema: `id`, `name`, `enabled` (default true), `priority` (default 0), `max_concurrent`, `identity`, `trigger` (`source|schedule|manual` als discriminated union), `filter` (AST), `shell_filter` (optional, nur Workflows, Felder `command`, `timeout`), `item_priority`, `conditions.workflow|item` (shell: `command`, `args?`, `timeout`, `cache`), `parameters` (string/number/boolean/enum, required, default), `execute` (shell: `command`, `args?`, `working_directory`, `create_directory`, `env`, `secrets` (`{NAME: {identity}}`), `timeout.max_duration|idle_timeout`, `cancel_grace`), `retry.max_technical_failures` (default 3), alle sieben Hooks mit Actions `source.update` (labels add/remove), `source.comment` (`message`, `identity?`), `shell` (`command`, `args?`, `timeout`, `env`), je Action `continue_on_error`, `retry.{max_attempts,delay}`.
3. Notification-Kanäle (§18): `notifications.channels[]` mit `type: webhook`, `url` oder `url_env`, `headers_env`; `on: [...]`.
4. Loader: liest Verzeichnis, sammelt **alle** Fehler mit Dateiname + Pfad, liefert ein unveränderliches `LoadedConfig`-Objekt (normalisiert, Durations in ms) mit Hash/Version.
5. Semantische Validierung: Referenzen (Workflow→Source/Identity, Action→Identity, Secret→Identity, View→Sources gleichen Adaptertyps), eindeutige IDs (Workflow-ID = Dateiname-Konvention optional, aber eindeutig), erlaubte Platzhalter je Kontext (über `src/core/template.ts`), widersprüchliche Angaben (z. B. Source-Filter bei Schedule-Trigger, `shell_filter` bei Views), Cron-Ausdruck + Zeitzone gültig (croner), Parameterdefaults passen zum Typ.
6. `ConfigManager`: hält aktive Config; `reload()` = komplett laden + validieren, nur bei Vollerfolg atomar austauschen, sonst alte behalten und Fehler liefern (§19); Listener für Änderungen. Runtime-Overrides (`enabled`, `priority`, `max_concurrent`, global `max_concurrent`) nicht persistent; Reload setzt Overrides betroffener Workflows zurück.
7. `snapshotWorkflow(workflowId)` → serialisierbarer Snapshot (für `runs.config_snapshot`), ohne Secrets.
8. Validierung von manuellen Start-Parametern gegen Workflow-Parameter-Schema.
9. CLI `config validate --config-dir` verdrahten (Exit 0/1, menschenlesbare Fehlerliste).
10. Beispielkonfiguration unter `examples/config/` (die Beispiele aus der Spec), die validiert.

## Acceptance Criteria
- [ ] Alle Spec-Beispiele (§5.1–§5.5, §17) validieren erfolgreich (Test).
- [ ] Fehlerhafte Referenzen, doppelte IDs, unbekannte Platzhalter, ungültiger Cron, falscher Parametertyp werden mit Datei+Pfad gemeldet (Tests).
- [ ] Ungültiger Reload lässt aktive Config unverändert (Akzeptanzszenario 11, Test).
- [ ] Reload setzt Overrides zurück; Overrides wirken auf effektive Werte (Test).
- [ ] Keine Secrets in Snapshots/Loader-Ausgaben.
- [ ] `config validate` funktioniert gegen `examples/config`.
