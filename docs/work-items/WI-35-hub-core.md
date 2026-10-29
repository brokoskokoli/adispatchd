# WI-35 – Hub-Kern: mehrere Workspaces als Kindprozesse mit gemeinsamem Slot-Limit

**Herkunft:** Wunsch des Maintainers (29. Oktober 2026): mehrere Projekte bzw. Dispatcher-Instanzen auf einem Server mit gemeinsamer Übersicht und gemeinsamem Limit · **Abhängig von:** `main` (0.9.1) · **Branch:** `wi-35-hub-core` · **Zielversion:** 0.10.0 (zusammen mit WI-36 und WI-37)

## Entscheidungen

- Ein **Workspace** ist eine vollständige, unveränderte Instanz: eigenes config-dir und data-dir, eigene Workflows,
  Sources, Identities, DB, Port. Kein Schema-Umbau, keine `workspace_id` in Tabellen.
- Ein **Hub** ist ein eigener Prozess (`adispatch hub start`) und startet jeden Workspace als **Kindprozess**
  (`adispatch start --config-dir … --data-dir …`). Isolation durch Prozessgrenzen.
- Alle Kinder laufen unter **demselben Benutzer** wie der Hub. Andere Benutzer pro Workspace sind ausdrücklich nicht
  Teil dieses Work-Items (Hinweis in der Doku: dafür Container-Executor `user`, WI-19, oder eigenständige Instanzen).
- Es gibt nur ein einfaches **Gesamtlimit** (`max_concurrent` im Hub); keine Quoten oder Prioritäten je Workspace.
  Das lokale `scheduler.max_concurrent` im Workspace bleibt zusätzliche Obergrenze.

## Umfang

1. **`hub.yaml`** im Hub-config-dir (strikt validiert wie die anderen Dateien):
   ```yaml
   hub:
     max_concurrent: 6          # Gesamtlimit gleichzeitiger Runs über alle Workspaces
     server: { host: 127.0.0.1, port: 8090, allowed_hosts: [] }   # genutzt von WI-36
   workspaces:
     - id: coder                # [a-z0-9-], eindeutig
       config_dir: /etc/adispatchd/coder
       data_dir: /var/lib/adispatchd/coder
       port: 8091               # Port der Workspace-Instanz (nur loopback), eindeutig
       enabled: true
   ```
   Pfade und Ports müssen eindeutig sein, data-dirs dürfen sich nicht verschachteln; `config validate` prüft zusätzlich
   die Konfiguration jedes Workspaces.
2. **Prozessverwaltung:** Start/Stop/Restart je Workspace; Kindprozess-Absturz → Neustart mit Backoff, Zustand
   (`starting|running|backoff|stopped|failed`) und Zähler sichtbar; Ausgabe der Kinder im Hub-Log mit Präfix
   (Secrets bleiben redigiert). Hub-Shutdown drained alle Kinder (Drain-Timeout, zweites Signal → cancel-all) und
   gibt den Hub-Lock frei. Ein Hub-Instanz-Lock pro Hub-data-dir verhindert Doppelstarts.
3. **Slot-Protokoll:** lokaler Unix-Socket im Hub-data-dir (Rechte 0600). Ein Workspace fordert vor jedem
   Run-Start einen Slot an (`acquire`), gibt ihn beim Run-Ende frei (`release`) und erneuert Leases per Heartbeat.
   Stirbt ein Kind oder bleibt der Heartbeat aus, verfallen dessen Slots. Der Hub vergibt nie mehr als `max_concurrent`.
   Der Worker-Daemon erhält den Socket-Pfad über eine Umgebungsvariable (`ADISPATCH_HUB_SOCKET`); ohne sie ist das
   Verhalten unverändert (Einzelinstanz).
4. **Scheduler-Anbindung:** `capacityProblem()` (`src/scheduler/scheduler.ts`) kennt die neue Entscheidung `hub_limit`
   („hub limit reached (n/m active)“); auch Dry-Run, Diagnose und Cron-Firings (`skipped_limit`) zeigen sie. Manuelle Starts werden wie
   beim globalen Limit behandelt. Ist der Hub nicht erreichbar, starten automatische Runs nicht (sichere Seite),
   laufende Runs laufen weiter; Recovery nach Hub-Neustart gleicht Slots mit den tatsächlich laufenden Runs ab.
5. **Server-Verwaltung (CLI, gegen die Steuer-API des Hubs):** `adispatch hub start|status`,
   `hub workspace start|stop|restart|drain <id>`, `hub stop-all`, `hub drain-all`, `hub pause|resume` (global: keine
   neuen Runs, laufende enden regulär). `hub validate` / `hub init` (legt `hub.yaml` und Workspace-Verzeichnisse an,
   überschreibt nie).

## Doku

Konfigurationsreferenz (neuer Abschnitt `hub.yaml`), `docs/worker-protocol.md` oder `docs/operations.md` (Slot-Protokoll),
Spec-Nachtrag, CHANGELOG (Unreleased), `docs/status.md`, `docs/handoff/WI-35.md`.

## Acceptance Criteria

- [x] Schema-Tests für `hub.yaml` (Eindeutigkeit, Verschachtelung, strikte Schlüssel); Beispiel in der Referenz wird validiert.
- [x] Hub startet zwei echte Kindprozesse (Fake-GitHub), Absturz eines Kindes führt zu Neustart mit Backoff; die Kinder beeinflussen sich nicht.
- [x] Gesamtlimit: bei `max_concurrent: 2` und zwei Workspaces laufen nie mehr als 2 Runs gleichzeitig; Slots verfallen bei `kill -9` eines Kindes.
- [x] `hub_limit` erscheint in Diagnose, Dry-Run und Cron-Firings (es entsteht kein Run); ohne Hub (kein `ADISPATCH_HUB_SOCKET`) unverändertes Verhalten, alle bestehenden Tests grün.
- [x] `hub drain-all`/`stop-all`/`pause` verhalten sich wie beschrieben; Hub-Shutdown hinterlässt keine Waisenprozesse (auch bei SIGTERM und Doppelsignal).
- [x] Hub-Ausfall: Kinder starten keine neuen automatischen Runs, laufende Runs bleiben unberührt.
- [ ] Doku aktualisiert, Doku-Test grün; `npm run check` grün (Doku und Doku-Test grün; `check` in der Sandbox wegen 9 umgebungsbedingter Fehlschläge nicht grün, Linux-Container und macOS vor dem Release).
