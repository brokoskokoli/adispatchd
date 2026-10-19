# WI-20 – Ein Workflow für mehrere Sources; Source-Variablen

**Herkunft:** Wunschliste aus dem ersten Praxiseinsatz (19. Oktober 2026), Feature F6 · **Abhängig von:** `main` (nach WI-16) · **Branch:** `wi-20-multi-source` · **Zielversion:** 0.3.0 · Gemeinsame Anforderungen siehe WI-17.

**Problem:** Ein Workflow hat genau eine Source. Bei mehreren Repos und mehreren Pipeline-Schritten entstehen viele fast gleiche Workflow-Dateien.

**Konfiguration:**
```yaml
trigger: { type: source, sources: [repo_a, repo_b] }   # Alternative zu source: <id>
execute:
  env:
    BASE_BRANCH: '{source.vars.base_branch}'          # freie Variablen je Source
```
```yaml
# sources.yaml
sources:
  repo_a:
    type: github
    …
    vars: { base_branch: main }
```
**Verhalten:**
- Der Planer fragt jede Source ab; Kandidaten aller Sources konkurrieren nach Item-Priorität; bei Gleichstand gilt die Reihenfolge der Liste, danach die bestehenden Tie-Breaker.
- Lock, Retry-Block und Historie bleiben pro globalem Item-Schlüssel `<source>:<nr>`.
- `max_concurrent` gilt für den Workflow insgesamt; optional `max_concurrent_per_source`.
- Fällt eine Source aus (Fehler beim Pollen), laufen die anderen weiter; Diagnose pro Source.
- Feldprüfung: `project.*` (Filter, `item_priority`, `source.update.project` aus WI-16) nur, wenn **alle** Sources das Feld mit gleicher Art deklarieren (Regel wie bei Views); Pushdown und `state`-Regel je Source.
- Neu: `sources.<id>.vars` (Map String → String, Schlüssel im Platzhalter-Namensformat), Platzhalter `{source.vars.<name>}` überall, wo `{source.*}` verfügbar ist (auch in Single-Source-Workflows).
- Manuelle Starts eines Multi-Source-Workflows mit Item-Referenz: Source aus der Referenz ableiten (URL/`<source>:<nr>`), sonst Fehler mit Hinweis.

**Validierung:** `source` und `sources` schließen sich aus; `sources` nicht leer, eindeutig; alle Sources existieren und haben denselben Adaptertyp; `{source.vars.x}` muss in allen Sources des Workflows definiert sein (Fehler mit Liste der fehlenden Sources).

**Akzeptanz:** Zwei Fake-Repos, ein Workflow: Kandidaten aus beiden werden gestartet, Locks getrennt; `max_concurrent_per_source` greift; Dry-Run zeigt pro Source die gepollten Items und Diagnosen; API/UI (Workflow-Übersicht) zeigen alle Sources.

## Acceptance Criteria
- [ ] Tests wie oben, inkl. Ausfall einer Source, Tie-Break nach Listenreihenfolge, `vars`-Validierung, manueller Start.
- [ ] Doku (Referenz Trigger, `sources.yaml` `vars`, §5 Platzhalter, Beispiele, Fehler, Checkliste; Spec-Nachtrag; README; CHANGELOG 0.3.0); Doku-Test grün.
- [ ] `npm run check` und `npm run test:pack` grün.
