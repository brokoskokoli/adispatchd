# WI-15 – Benannte, wiederverwendbare Filter (`filters/*.yaml`)

**Herkunft:** Wunsch des Maintainers (19. Oktober 2026): einen Filter einmal zentral definieren und in Workflows und Views nur noch „gefiltert nach Filter X“ sagen, damit alle dieselben Issues sehen · **Abhängig von:** WI-14 (Branch `wi-14-project-fields`, nutzt dieselben Validierungsstellen) · **Branch:** `wi-15-named-filters` · **Zielversion:** 0.2.0 (gemeinsam mit WI-14)

## Umfang und Entscheidungen

1. **Neues Verzeichnis `filters/`** im Config-Verzeichnis, analog zu `workflows/` und `views/`: eine Datei pro Filter.
   ```yaml
   # filters/ready-for-coding.yaml
   id: ready-for-coding
   description: Offene Issues im Projektstatus Ready, ohne offene Blocker   # optional
   filter:
     all:
       - { field: is_pull_request, operator: equals, value: false }
       - { field: project.Status, operator: in, value: [Ready, Todo] }
       - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
   ```
   - `id` wie bei Workflows/Views (gleiche ID-Regeln, eindeutig über alle Filterdateien; Konvention Dateiname = ID wie bei den anderen Dateien – bestehende Regel übernehmen).
   - Fehlendes Verzeichnis = keine benannten Filter (kein Fehler).

2. **Verwendung:**
   - Kurzform: `filter: ready-for-coding` (String statt Mapping) in Workflow und View = genau dieser Filter.
   - Referenzknoten `{ use: ready-for-coding }` (einziger Schlüssel) **überall** in einem Filterbaum: Workflow-`filter`, `item_priority.rules[].when`, View-`filter` und innerhalb anderer benannter Filter. Damit lässt sich kombinieren:
     ```yaml
     filter:
       all:
         - { use: ready-for-coding }
         - { field: labels, operator: contains, value: backend }
     ```
   - Grammatik in §4.1 der Referenz um `Use := { use: <Filter-ID> }` erweitern.

3. **Auflösung beim Laden:** Referenzen werden beim Laden der Konfiguration in den Baum eingesetzt (expandiert). Die normalisierte `WorkflowConfig`/`ViewConfig` enthält nur noch den expandierten Baum; Scheduler, Planner, Views, Pushdown, Dry-Run und Snapshot bleiben unverändert.
   - Ein `use` steht für seinen Inhalt an genau dieser Stelle. Für die `state`-Regel (nur oberste Ebene, §4.5) und den Pushdown zählt die Position nach dem Einsetzen: `filter: x` bzw. `{use: x}` direkt in der obersten `all` ist oberste Ebene; unter `any`/`not` nicht. Das Abflachen verschachtelter `all` funktioniert also auch über Referenzen hinweg.
   - Fehler: unbekannte Filter-ID (mit „did you mean …“), Zyklus (`a → b → a`, Meldung mit der Kette), Verschachtelungstiefe > 16, `use` mit weiteren Schlüsseln oder nicht-String-Wert.
   - Die Feldprüfung (Feldkatalog, Operatoren, Werttypen, `run.last_*` nur in Views, `project.*` je Source) läuft **am Verwendungsort** gegen den Kontext dieses Workflows/dieser View, auf dem expandierten Baum. Fehlermeldungen nennen den Verwendungsort und den Pfad im benannten Filter, z. B. `workflows/coder.yaml: filter.all[0] (use "ready-for-coding" → filters/ready-for-coding.yaml: filter.all[1].field): Unknown field …`.
   - Benannte Filter selbst werden strukturell geprüft (wie jeder Filter), auch wenn sie nirgends verwendet werden; Feldprüfung nur bei Verwendung. Unbenutzte Filter: Warnung (nicht Fehler) in `config validate`.
   - Ein Fehler in einem benannten Filter macht alle Workflows/Views ungültig, die ihn verwenden (wie andere Fehler in deren Konfiguration: bestehende Regeln für Hot-Reload/Teil-Gültigkeit beibehalten – nachsehen, wie `config reload` mit fehlerhaften Workflows umgeht, und gleich verfahren).

4. **Reload:** `config reload` und das Laden beim Start lesen `filters/` mit ein; eine Änderung an einem benannten Filter wirkt nach Reload auf alle verwendenden Workflows/Views.

5. **Sichtbarkeit:** `workflow dry-run` zeigt den expandierten Filter; in der Diagnose genügt der expandierte Baum. Die API/Config-Übersicht listet die benannten Filter, wenn es eine passende bestehende Stelle gibt (keine neue UI-Seite nötig).

6. **Init und Beispiele:** `adispatch init` legt `filters/` mit einem Beispielfilter an, ein Beispiel-Workflow und die Beispiel-View nutzen ihn (`examples/config` ebenso). Alles muss weiter validieren.

7. **Dokumentation:** `docs/configuration-reference.md` (neuer Abschnitt für `filters/*.yaml` im Kapitel Dateien, §4.1 Grammatik, §4.5 Hinweis zur Position, Beispiel in §7, Fehler in §8, Checkliste §9, Verzeichnisübersicht), Doku-Test erweitern; Spec-Nachtrag, README, `CHANGELOG.md` (Eintrag unter 0.2.0), `docs/handoff/WI-15.md`, `docs/status.md`.

## Acceptance Criteria
- [ ] Tests: Kurzform und `use`-Knoten in Workflow-Filter, `item_priority` und View; Verschachtelung benannter Filter; unbekannte ID mit Vorschlag; Zyklus; Tiefe; `use` mit Zusatzschlüssel; `state` über Referenz oben (ok) und unter `any` (Fehler); Feldfehler im benannten Filter mit Verwendungsort; `run.last_*` in benanntem Filter nur bei View-Verwendung ok; unbenutzter Filter = Warnung; Pushdown über Referenz; Reload übernimmt geänderten Filter.
- [ ] `examples/config`, `init`-Konfiguration und GitHub-Testfixture validieren.
- [ ] Doku aktualisiert, Doku-Test grün; `npm run check` und `npm run test:pack` grün.
