# WI-23 – Server-Ressourcen im Dashboard (CPU, RAM, Platte, Prozesse)

**Herkunft:** Wunsch des Maintainers (19. Oktober 2026): im Dashboard sehen, wie ausgelastet der Server ist und welche Runs bzw. fremden Prozesse die CPU verbrauchen · **Abhängig von:** `main` (0.3.0) · **Branch:** `wi-23-resource-monitor` · **Zielversion:** 0.3.1

## Umfang und Entscheidungen

1. **Konfiguration** (`config.yaml`, alles optional, Defaults aktiv):
   ```yaml
   monitoring:
     enabled: true
     interval: 30s          # Abtastintervall (≥ 5s); Default = scheduler.polling_interval, höchstens 60s
     retention: 6h          # wie lange Messpunkte im Speicher gehalten werden (≥ 10 Intervalle)
     top_processes: 5       # fremde Prozesse mit dem höchsten Verbrauch, die einzeln gezeigt werden (0 = keine)
     min_cpu_percent: 2     # fremde Prozesse darunter landen in „Sonstige“
   ```
   Abwärtskompatibel: ohne Abschnitt gelten die Defaults.

2. **Messung** (eigenes Modul, z. B. `src/monitoring/`, Uhr/Timer injiziert, Prozessliste über eine injizierbare Quelle für Tests):
   - **System:** CPU-Auslastung gesamt in % (Delta der `os.cpus()`-Zeiten zwischen zwei Messungen), Anzahl Kerne, Load Average; RAM gesamt/verfügbar (Linux: `MemAvailable` aus `/proc/meminfo`; macOS: verfügbar = free + inactive + speculative aus `vm_stat`, Fallback `os.freemem()`); Platte: frei/gesamt für das data-dir und – falls auf anderem Dateisystem – für `workspace.base_dir` (`fs.statfs`).
   - **Prozesse:** eine Prozessliste pro Messung, portabel über `ps -A -o pid=,ppid=,pgid=,time=,rss=,comm=` (Linux und macOS; `time` = kumulierte CPU-Zeit). CPU-% je Prozess aus dem **Delta der CPU-Zeit** zwischen zwei Messungen geteilt durch die Wandzeit (100 % = ein Kern; im Diagramm zusätzlich auf Gesamtkapazität normiert). Nur der Befehlsname (`comm`, gekürzt, Basename), **niemals Argumente** (können Secrets enthalten). Prozess-IDs werden mit Startzeit/Identität so abgeglichen, dass PID-Wiederverwendung keine falschen Deltas erzeugt (Delta nur bei gleicher PID **und** nicht kleinerer CPU-Zeit).
   - **Zuordnung „unsere“ Prozesse:** Daemon selbst (eigene PID); jeder aktive Run über seine bekannte Prozessgruppe/Prozessbaum (Run-Controller kennt PID/PGID) → Summe je Run (Label: Workflow-ID + Run-ID kurz, Item-Key falls vorhanden); laufende Shell-Actions/Conditions des Daemons → „adispatchd (Hooks/Checks)“. Container-Runs (WI-19): der Engine-CLI-Prozess gehört zum Run; zusätzlich, wenn möglich, Verbrauch des Containers über `<engine> stats --no-stream --format '{{json .}}' <name>` (Fehler/fehlende Engine → nur der CLI-Prozess, kein Fehler). Auf Linux sichtbare Container-Prozesse werden nicht doppelt gezählt.
   - **Fremde Prozesse:** die übrigen nach CPU absteigend; die Top N über `min_cpu_percent` einzeln mit Namen (gleichnamige zusammengefasst, z. B. „node ×3“), Rest als „Sonstige“. Zusätzlich RAM (RSS) je Gruppe.
   - Fehler bei einer Messung (z. B. `ps` fehlt) werden geloggt (gedrosselt) und lassen die Teilwerte leer; der Daemon läuft normal weiter. Messung läuft nie parallel zu sich selbst; Laufzeit begrenzen (Timeout für `ps`/`stats`).
   - Ressourcenschonend: eine `ps`-Ausführung pro Intervall, keine Shell (`execFile`), Ausgabe begrenzt.

3. **Speicherung:** In-Memory-Ringpuffer (gemäß `retention`), geht beim Neustart verloren (dokumentieren). Keine DB-Migration.

4. **API:** `GET /api/v1/system/metrics?since=<ISO>` → `{ intervalMs, samples: [{ at, cpu: { totalPercent, cores, load: [1,5,15] }, memory: { totalBytes, availableBytes }, disks: [{ path, freeBytes, totalBytes }], processes: [{ kind: 'daemon'|'run'|'hooks'|'other'|'rest', label, runId?, workflowId?, cpuPercent, rssBytes, count }] }] }`. Neueste Messung zusätzlich per SSE-Event `system.metrics` (bestehender Event-Stream). In `docs/api.md` dokumentieren. Schreibgeschützt; Host-/Origin-Regeln wie die anderen GET-Endpunkte.

5. **UI (Dashboard):** neuer Bereich „Server“:
   - Gestapeltes Flächen- oder Balkendiagramm der CPU über die Zeit: je eigener Farbbalken für den Daemon, jeden Run (Farbe stabil je Workflow, Legende mit Workflow/Run, Klick → Run-Detail), Hooks/Checks, die benannten fremden Prozesse und „Sonstige“; Rest bis zur Gesamtauslastung = „System/unzugeordnet“; Skala 0–100 % der Gesamtkapazität.
   - Darunter bzw. daneben: Linien/Flächen für RAM verfügbar vs. belegt und freien Plattenplatz (je überwachtem Pfad), aktuelle Werte als Zahlen.
   - Tooltip/Hover mit Werten je Zeitpunkt; Zeitraum-Auswahl (z. B. 15 min / 1 h / 6 h, begrenzt durch `retention`); Live-Aktualisierung über SSE.
   - Ohne externe Bibliotheken (eigenes SVG-Rendering wie der Rest der UI), barrierearm (Text-Alternative/Tabelle der aktuellen Werte), Hell/Dunkel wie die restliche UI. Prozessnamen nur als Text (kein HTML).
   - `monitoring.enabled: false` → Bereich zeigt einen Hinweis.

6. **Dry-Run/Config:** `config validate` prüft den Abschnitt; Config-Seite/API zeigt die Werte.

7. **Doku:** Konfigurationsreferenz (`config.yaml` → `monitoring`), `docs/api.md`, Spec-Nachtrag (§16 UI, §21 Betrieb), README (EN) und README.de, `docs/operations.md` (Hinweis: fremde Prozessnamen sind in der UI sichtbar – UI nur hinter Auth/Reverse-Proxy freigeben; macOS-RAM-Berechnung), Website-Feature-Liste in `site/index.html` (EN/DE) ergänzen, `CHANGELOG.md` (0.3.1).

8. **Version 0.3.1** (package.json, Lockfile, `APP_VERSION`, Installationszeilen in README/README.de/operations/manual tests/site). Nicht pushen oder publizieren.

## Acceptance Criteria
- [ ] Tests mit injizierter Prozessliste/Uhr: CPU-Deltas, PID-Wiederverwendung, Zuordnung zu Runs über Prozessgruppe/Baum, Container-Run mit Fake-Engine-`stats`, Top-N/Gruppierung/„Sonstige“, keine Argumente im Ergebnis, Fehler von `ps` → leere Teilwerte ohne Absturz, Ringpuffer-Retention, kein paralleles Messen.
- [ ] Parser-Tests für `ps`-Ausgabe (Linux- und macOS-Format, `time` als `MM:SS.cc`, `HH:MM:SS`, `D-HH:MM:SS`), `/proc/meminfo`, `vm_stat`.
- [ ] API- und SSE-Test; UI-Unit-Tests für die Diagrammdaten (Stapelung, Farben, Legende).
- [ ] Ein echter Messlauf auf macOS (lokal) liefert plausible Werte; im `node:22`/`node:24`-Linux-Container ebenfalls (Test oder manueller Check, dokumentiert).
- [ ] Doku aktualisiert, Doku-Test grün; `npm run check` und `npm run test:pack` grün.
