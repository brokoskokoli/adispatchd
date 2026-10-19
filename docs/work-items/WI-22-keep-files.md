# WI-22 – Dateien vor dem Workspace-Cleanup sichern (`execute.keep`)

**Herkunft:** Wunschliste aus dem ersten Praxiseinsatz (19. Oktober 2026), Feature F8 · **Abhängig von:** `main` · **Branch:** `wi-22-keep-files` · **Zielversion:** 0.3.0 · Gemeinsame Anforderungen siehe WI-17.

**Problem:** Mit `cleanup: on_success` (bzw. `always`) verschwinden alle Dateien im Workspace, auch Mitschnitte und Logs, die man zur Analyse braucht.

**Konfiguration:**
```yaml
execute:
  keep:
    - .agent/transcript.jsonl
    - .agent/gate/*.log            # Glob relativ zum Workspace
  keep_max_size: 50MB              # optional, pro Run; Default 100MB
```
**Verhalten:**
1. Nach dem Abschluss-Hook und vor dem Cleanup kopiert der Daemon passende Dateien nach `data-dir/runs/<run-id>/kept/` mit relativer Struktur – bei **jedem** Endstatus (auch wenn nicht aufgeräumt wird), sofern `keep` gesetzt ist.
2. Was das Größenlimit (Summe pro Run) überschreitet, wird übersprungen und am Run vermerkt (Event/Warnung, API).
3. Symlinks werden nicht verfolgt; nichts außerhalb des Workspaces (Muster mit `..` oder absolut → Validierungsfehler; aufgelöste Pfade zusätzlich prüfen). Nur reguläre Dateien.
4. Globs: `*`, `?`, `**` (eigene, kleine Implementierung oder stabile Node-API ohne ExperimentalWarning auf Node ≥ 22.13).
5. Die Dateien unterliegen der Run-Retention (werden mit dem Run gelöscht).
6. API: `GET /api/v1/runs/:id/kept` (Liste mit Pfad, Größe) und `GET /api/v1/runs/:id/kept/<path>` (Download, sichere Pfadauflösung, passender Content-Type/`Content-Disposition`); UI zeigt sie am Run zum Herunterladen.
7. Gilt für `execute.type: shell` (und `container`, sobald WI-19 da ist – Workspace liegt auf dem Host).

**Validierung:** `keep` Liste nicht-leerer relativer Muster; `keep_max_size` Größenangabe (`KB`, `MB`, `GB`; > 0).

**Akzeptanz:** Nach einem erfolgreichen Run mit Cleanup existieren die Dateien unter `kept/`; Glob ohne Treffer ist kein Fehler; zu große Datei wird übersprungen und vermerkt; Retention löscht die Dateien mit dem Run; Symlink nach außen wird nicht kopiert.

## Acceptance Criteria
- [ ] Tests wie oben, inkl. API-Pfad-Traversal-Versuche.
- [ ] Doku (Referenz `execute.keep`, API-Doku `docs/api.md`, Spec-Nachtrag, README, CHANGELOG 0.3.0); Doku-Test grün.
- [ ] `npm run check` und `npm run test:pack` grün.
