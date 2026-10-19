# WI-24 – Conditions in der Workflow-Ansicht; Info-Kacheln im Dashboard

**Herkunft:** Wunsch des Maintainers (19. Oktober 2026) · **Abhängig von:** `main` (0.3.0); parallel zu WI-23 (beide ändern das Dashboard) · **Branch:** `wi-24-conditions-info` · **Zielversion:** 0.3.1

## Teil A – Conditions sichtbar machen

1. **Optionaler Name:** Jeder Shell-Check in `conditions.workflow[]` und `conditions.item[]` (und `shell_filter`, falls gleiches Schema) bekommt ein optionales Feld `name` (nicht leer, max. 80 Zeichen). Abwärtskompatibel.
   ```yaml
   conditions:
     workflow:
       - name: Credits verfügbar
         type: shell
         command: scripts/check-credits.sh
         timeout: 15s
         cache: 60s
   ```
2. **Anzeige in der UI** (Workflows → Workflow-Detail und kompakt in der Workflow-Liste): alle Conditions mit Anzeigename (= `name`, sonst `command` + `args` gekürzt), Timeout, Cache und **Status der letzten Auswertung**:
   - Workflow-Conditions: grün = ok (Exit 0), rot = „nicht jetzt“ (Exit 1), gelb/grau = Prüffehler/unknown (Exit ≥ 2, Timeout, Signal) bzw. noch nie geprüft; dazu Zeitpunkt, Dauer, ob aus Cache, und die gekürzte erste stderr-Zeile (redigiert, als Text).
   - Item-Conditions: Definition plus Zusammenfassung der letzten Planungsrunde (Anzahl ok / nicht jetzt / Fehler über die geprüften Items), kein Einzelstatus pro Item nötig.
   - Gleiches für `shell_filter`, falls vorhanden.
3. **Datenquelle:** Der Scheduler merkt sich das letzte Ergebnis je Workflow-Condition (In-Memory, bei Reload für geänderte Workflows verwerfen). API: in der bestehenden Workflow-Ansicht (`GET /api/v1/workflows`, `…/:id`) ein Feld `conditions` mit Definition und letztem Status; SSE-Update, wenn sich ein Status ändert (bestehendes Event oder neues `workflow.conditions`). `docs/api.md`.
4. Dry-Run zeigt den Anzeigenamen statt nur des Kommandos.

## Teil B – Info-Kacheln im Dashboard

1. **Neue optionale Datei `dashboard.yaml`** im config-dir (fehlt sie, gibt es keinen Info-Bereich bzw. einen Hinweis):
   ```yaml
   info:
     - id: open-prs                 # Konfigurations-ID, eindeutig
       title: Offene PRs
       type: number                 # text | number | percent
       command: scripts/info/open-prs.sh
       args: []
       env: {}                      # wie bei Shell-Actions (keine Secrets in V1 – oder `secrets` wie WI-18, falls einfach wiederverwendbar)
       timeout: 15s
       cache: 5m                    # wie lange der Wert gilt; danach im Hintergrund neu abrufen
       unit: ''                     # optional, z. B. "GB"
       warn_above: 80               # optional (number/percent): gelb ab
       critical_above: 95           # optional: rot ab
       # alternativ warn_below / critical_below
   ```
2. **Ausführung:** Der Daemon führt die Skripte **im Hintergrund** aus, wenn ein Wert abgelaufen ist (nie durch einen Seitenaufruf ausgelöst; ein manueller „Aktualisieren“-Knopf pro Kachel darf einen sofortigen Abruf anstoßen, gedrosselt und mit CSRF-Schutz wie andere POSTs). Gleiche Mechanik wie Conditions (kein Shell-Parsing: `execFile`, Minimal-Env + `env`, Timeout, Prozessgruppe beenden, Ausgabe begrenzt, Arbeitsverzeichnis config-dir). Höchstens eine Ausführung pro Kachel gleichzeitig, global begrenzt (z. B. 2 parallel). Beim Start einmal alle abrufen.
3. **Ausgabe:** stdout, erste nicht-leere Zeile, getrimmt:
   - `text`: beliebiger Text (max. 200 Zeichen, als Text dargestellt).
   - `number`: Zahl (Punkt als Dezimaltrenner, optional mit Einheit aus `unit`).
   - `percent`: Zahl 0–100, optional mit `%` → Anzeige mit Balken.
   - Exit ≠ 0, Timeout oder unparsbare Ausgabe → Fehlerzustand mit kurzer Meldung (redigiert); der letzte gültige Wert bleibt mit Zeitstempel sichtbar („veraltet“).
4. **API:** `GET /api/v1/dashboard/info` → Liste mit `id`, `title`, `type`, `value`, `unit`, `status` (`ok`/`warn`/`critical`/`error`/`pending`), `updatedAt`, `expiresAt`, `error?`; `POST /api/v1/dashboard/info/:id/refresh`; SSE-Event `dashboard.info` bei Änderungen. `docs/api.md`.
5. **UI:** Dashboard-Bereich „Information“ mit Kacheln (Titel, Wert, Einheit, Prozentbalken, Farbe nach Schwellwerten, Zeitpunkt, Fehlerhinweis, Aktualisieren-Knopf). Barrierearm, Hell/Dunkel.
6. **Config:** `dashboard.yaml` wird beim Start und bei `config reload` geladen und validiert (Schema, IDs eindeutig, Schwellwerte nur bei number/percent, `cache` ≥ 10 s, Skript existiert relativ zum config-dir wie bei Conditions); Fehler mit Pfad und „did you mean …“. Teil des Config-Hashs und der Config-Dateiliste in API/UI. `init` legt eine kommentierte Beispiel-`dashboard.yaml` mit einem harmlosen Beispielskript an (z. B. Plattenbelegung des data-dir in Prozent).

## Allgemein
- Doku: Konfigurationsreferenz (Shell-Checks `name`; neue Datei `dashboard.yaml` mit Beispielen und Fehlern), `docs/api.md`, Worker-Protokoll (Kontext/Exit-Codes der Info-Skripte), Spec-Nachtrag (§5, §16), README (EN) + README.de, Website-Feature-Liste (`site/index.html`, EN/DE), `CHANGELOG.md` (Abschnitt 0.3.1), `docs/handoff/WI-24.md`.
- Version bleibt bei der von WI-23 gesetzten 0.3.1 (falls noch 0.3.0: auf 0.3.1 setzen wie in WI-23 beschrieben).

## Acceptance Criteria
- [ ] Tests: `name` in Schema/Normalisierung; letzter Status je Workflow-Condition (ok/nicht jetzt/Fehler/Cache), Reload verwirft; Item-Condition-Zusammenfassung; API/SSE; UI-Rendering (Name vs. Kommando, Farben).
- [ ] Tests Info: Laden/Validierung von `dashboard.yaml`, Ausführung mit Fake-Uhr (Cache-Ablauf, kein Doppelstart, globale Begrenzung), Parsing text/number/percent inkl. Fehlerfälle, Schwellwerte, Refresh-Endpunkt mit CSRF/Host-Regeln, Redaction, Reload.
- [ ] `examples/config`, `init`, Fixture validieren; Doku-Test grün; `npm run check` und `npm run test:pack` grün.
