# WI-16 – GitHub-Projects-Felder per `source.update` setzen

**Herkunft:** Wunsch des Maintainers (19. Oktober 2026): Felder im GitHub-Projekt (z. B. Status, Priorität) nicht nur filtern, sondern aus dem Lebenszyklus heraus auch setzen · **Abhängig von:** WI-14, WI-15 (`main`, 0.2.0) · **Branch:** `wi-16-project-updates` · **Zielversion:** 0.3.0

## Umfang und Entscheidungen

1. **Konfiguration:** `source.update` bekommt neben `labels` einen optionalen Block `project`:
   ```yaml
   on_start:
     - type: source.update
       labels: { add: [in-progress], remove: [ready-for-coding] }
       project:
         Status: In Progress     # single_select: Optionsname
         Estimate: 3             # number
         Due: 2026-11-01         # date (YYYY-MM-DD)
         Sprint: Sprint 12       # iteration: Iterationstitel
         Notes: null             # null = Feld leeren
   on_success:
     - type: source.update
       project: { Status: Review }
   ```
   - Schlüssel = Name aus `project.fields` der Trigger-Source (wie `project.<Name>` im Filter); nicht deklarierte Felder → Validierungsfehler mit „did you mean …“. Source ohne `project` → Fehler.
   - Werttypen beim Laden geprüft je Art: `single_select`/`text`/`iteration` → String, `number` → Zahl, `date` → ISO-Datum `YYYY-MM-DD` (YAML-Datum, das als Date geparst wird, sauber behandeln), überall `null` = leeren. Leerer Block `project: {}` ist ein Fehler, ebenso `source.update` ganz ohne `labels` und `project`, falls das heute schon so geprüft wird – bestehende Regel übernehmen.
   - Keine Platzhalter in den Werten (wie bei `labels`, §2 der Referenz).
   - Gilt überall, wo `source.update` heute erlaubt ist (Lifecycle-Hooks; ggf. weitere Stellen wie heute).

2. **Ausführung im GitHub-Adapter (`applyUpdate`):**
   - `SourceUpdate` bekommt `project?: Record<string, string | number | null>`; `SourceUpdateResult.applied` bekommt `projectFields?: Record<string, …>` (was tatsächlich geändert wurde) fürs Action-Journal.
   - Metadaten des Projekts (Projekt-ID, Feld-IDs, `dataType`, bei Single-Select die Optionen `id`/`name`, bei Iteration die Iterationen inkl. `completedIterations` mit `id`/`title`) per GraphQL lesen (Cache wie bei WI-14 erlaubt, aber vor einem Schreibvorgang bei unbekannter Option/Iteration einmal frisch nachladen).
   - Projekt-Item des Issues/PRs ermitteln (wie WI-14, frisch gelesen). Ist das Item noch nicht im Projekt, wird es mit `addProjectV2ItemById(input:{projectId, contentId})` hinzugefügt (idempotent: GitHub liefert das bestehende Item zurück).
   - **Erst lesen, dann schreiben** (Spec §10, wie bei Labels): aktueller Wert gleich Sollwert → nichts tun; sonst `updateProjectV2ItemFieldValue(input:{projectId, itemId, fieldId, value:{singleSelectOptionId | text | number | date | iterationId}})`, für `null` `clearProjectV2ItemFieldValue(input:{projectId, itemId, fieldId})`. Alles nur über GraphQL-Variablen.
   - Option/Iteration-Abgleich: Optionsname exakt, sonst ohne Groß-/Kleinschreibung eindeutig; kein oder mehrdeutiger Treffer → nicht wiederholbarer Fehler mit Liste der vorhandenen Optionen. Feld fehlt im Projekt oder Art passt nicht → nicht wiederholbarer Fehler.
   - Mutationen sind idempotent im Sinne des Sollzustands → als idempotent für Retries behandeln; Fehlerklassen (auth/forbidden/not_found/rate_limited/transient) auf `SourceError` abbilden, damit das bestehende Action-Retry (`lifecycle.action_retry`) und das Fehlerjournal greifen. GraphQL-Fehler bei HTTP 200 berücksichtigen.
   - Labels und Projektfelder in einer Action: erst Labels, dann Projektfelder (Reihenfolge dokumentieren); ein Fehler bei den Projektfeldern lässt die Action fehlschlagen (Retry ist wegen Idempotenz sicher).

3. **Identity:** Projekt-Schreibzugriffe laufen mit `project.identity` der Source, wenn dort ausdrücklich gesetzt, sonst mit derselben Identity wie das Label-Update der Action. Rechte dokumentieren: GitHub App (Org-Projekt) „Organization → Projects: Read and write“; `github_token` klassisch `project` (statt `read:project`) plus `repo`; fein granuliert unbestätigt. Validierung: wie bisher.

4. **Dry-Run / UI / API:** Sofern Lifecycle-Actions irgendwo angezeigt oder im Journal dargestellt werden, die neuen `projectFields` mit anzeigen (bestehende Stellen nutzen, keine neue Seite).

5. **Beispiele/Init:** Auskommentiertes `project:`-Beispiel in `source.update` des Coder-Workflows in `init`-Templates und `examples/config`; mit dem in WI-14 eingeführten Beispielprojekt auf `project_b` auch ein echtes Beispiel im Reviewer-Workflow, sofern es validiert.

6. **Dokumentation:** `docs/configuration-reference.md` (Action `source.update`, Rechte, Beispiel in §7, Fehler in §8, Checkliste), Spec-Nachtrag, README-Feature-Liste, `docs/manual-tests/github.md` (Live-Test: Status setzen, Item automatisch hinzufügen, Feld leeren, unbekannte Option), `CHANGELOG.md` (0.3.0), `docs/handoff/WI-16.md`, `docs/status.md`.

7. **Version 0.3.0** (package.json, Lockfile, `APP_VERSION`, Installationszeilen). Nicht pushen oder publizieren.

## Acceptance Criteria
- [ ] Tests: Schema/Validierung (unbekanntes Feld mit Vorschlag, falscher Werttyp je Art, Source ohne Projekt, `null`), Adapter mit gefälschtem GitHub (alle fünf Arten setzen, leeren, unverändert = kein Mutation-Call, Item wird hinzugefügt, unbekannte/mehrdeutige Option, Feld fehlt, Arten-Mismatch, GraphQL-Fehler bei 200, Rate-Limit → retryable, Variablen statt Interpolation), Identity-Auswahl, Journal-Eintrag mit `projectFields`.
- [ ] E2E: Workflow setzt `on_start` Status „In Progress“ und `on_success` „Review“; der Fake sieht genau diese Mutationen; ein zweiter Durchlauf des Hooks ändert nichts.
- [ ] `examples/config`, `init`, Fixture validieren; Doku-Test grün; `npm run check` und `npm run test:pack` grün.
