# WI-17 – Benannte Ergebnisse (`on_result`) und Sammel-Hook `on_error`

**Herkunft:** Wunschliste aus dem ersten Praxiseinsatz (19. Oktober 2026), Features F2 und F5 · **Abhängig von:** `main` · **Branch:** `wi-17-outcomes-on-error` · **Zielversion:** 0.3.0

Gemeinsame Anforderungen (gelten für WI-17 bis WI-22): abwärtskompatibel (bestehende Konfigurationen verhalten sich unverändert); Offline-Validierung mit Pfad und „did you mean …“; Dry-Run, API und UI zeigen die neuen Werte; Tests mit Fake-GitHub bzw. Fake-Engine; Einträge in Konfigurationsreferenz, Spec (Nachtrag), Worker-Protokoll (falls betroffen), README-Feature-Liste und `CHANGELOG.md` (Abschnitt 0.3.0). Beispiele bleiben allgemein (keine Projekt- oder Firmennamen aus Anwendungen).

## F2 – Benannte Ergebnisse (`on_result`)

**Problem:** Ein Run kennt fachlich nur `success`/`failure`. Workflows mit drei oder mehr fachlichen Ausgängen (z. B. `approved`, `changes_requested`, `needs_maintainer`) müssen den dritten Ausgang im Worker selbst umsetzen (z. B. Label per API setzen) und brauchen dafür eigene Tokens.

**Worker-Protokoll:** Ergebnisdatei bekommt optional `outcome`:
```json
{ "schema_version": 1, "result": "failure", "outcome": "needs_maintainer", "message": "…" }
```
- `outcome`: String im Format der Konfigurations-IDs. Ungültiges Format → wird ignoriert (Run-Warnung/Event), Ergebnis sonst normal ausgewertet.
- `result` bleibt Pflicht und steuert Statistik und Retry-Logik.
- `{result.outcome}` als Platzhalter (wo `{result.*}` heute verfügbar ist), Feld `run.last_outcome` für Views, `outcome` am Run in DB (Migration), API, SSE und UI (Run-Detail und Run-Liste).

**Konfiguration** (Workflow):
```yaml
on_result:
  approved:          [ …Actions… ]
  changes_requested: [ …Actions… ]
  needs_maintainer:  [ …Actions… ]
```
**Verhalten:** Nach `completed`: steht `outcome` in der Ergebnisdatei **und** gibt es `on_result.<outcome>`, läuft genau diese Kette **statt** `on_success`/`on_failure`. Sonst wie bisher. Ein `outcome` ohne Eintrag ist kein Fehler: Fallback-Kette, Warnung im Run. Das Action-Journal nennt den gelaufenen Hook (`on_result.approved`). Retry/Idempotenz/Recovery der Hook-Ausführung wie bei den bestehenden Hooks (Recovery nach Neustart muss den gewählten Hook deterministisch wieder finden – Hook-Name persistieren).

**Validierung:** Schlüssel sind Konfigurations-IDs; leere Listen erlaubt; `on_result` nur, wenn der Workflow eine Ergebnisdatei hat (heute `execute.type: shell`; WI-19 ergänzt `container`).

**Akzeptanz:** Worker mit `outcome: x` löst `on_result.x` aus; ohne `outcome` oder ohne Eintrag altes Verhalten; Dry-Run listet die `on_result`-Schlüssel; UI zeigt `outcome` am Run.

## F5 – Sammel-Hook `on_error`

**Problem:** `crashed`, `start_error`, `timed_out` und `cancelled` brauchen fast immer dieselbe Aufräum-Kette, die heute viermal pro Workflow steht.

**Konfiguration:**
```yaml
on_error: [ …Actions… ]          # für crashed, start_error, timed_out, cancelled
on_timeout: [ … ]                # optional: spezifischer Hook hat Vorrang
```
**Verhalten:** Für einen technischen Ausgang läuft der spezifische Hook (`on_crash`, `on_start_error`, `on_timeout`, `on_cancel`), falls er **definiert** ist – auch eine leere Liste zählt als definiert. Sonst läuft `on_error`. Nie beides. Dafür muss das Schema „nicht angegeben“ von `[]` unterscheiden (heute Default `[]`): normalisiert z. B. `undefined` vs. `[]`; alle Stellen, die Hooks lesen, entsprechend anpassen. Journal nennt den tatsächlich gelaufenen Hook.

**Akzeptanz:** Jeder der vier Ausgänge ohne eigenen Hook löst `on_error` aus; mit eigenem Hook (auch `[]`) läuft nur dieser.

## Acceptance Criteria
- [ ] Tests für alle Akzeptanzpunkte oben, inkl. Recovery nach Neustart mitten in `on_result.<x>` bzw. `on_error`.
- [ ] Doku (Referenz: Workflow-Hooks, §5 Platzhalter, Views-Felder, Beispiele §7, Fehler §8, Checkliste; Worker-Protokoll; Spec-Nachtrag; README; CHANGELOG 0.3.0); Doku-Test grün.
- [ ] `examples/config`, `init`, Fixture validieren; `npm run check` und `npm run test:pack` grün.
