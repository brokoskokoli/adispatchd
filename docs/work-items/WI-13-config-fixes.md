# WI-13 – Korrekturen aus der Konfigurationsreferenz

**Herkunft:** Beim Ableiten von `docs/configuration-reference.md` aus dem Code gefunden · **Abhängig von:** Branch `docs-config-reference` · **Branch:** `wi-13-config-fixes`

## Umfang und Entscheidungen
1. **Parameter-Defaults bei automatischen Runs:** Source- und Cron-Runs erhalten die `default`-Werte der Workflow-Parameter. Bisher bekamen sie gar keine Werte, sodass `{parameters.x}` leer blieb und `working_directory` mit `start_error` scheiterte.
2. **Null-Intervalle ablehnen:** `scheduler.polling_interval`, `retention.cleanup_interval`, die Timeouts von Conditions und `shell_filter`, die Timeouts von Shell-Actions und `lifecycle.action_retry.delay` (sowie Action-`retry.delay`) müssen > 0 sein, wo 0 keinen sinnvollen Wert hat. Ein Delay von 0 ist erlaubt. Bei Polling und Cleanup gilt eine Untergrenze von 1 s.
3. **`state` in Filtern:** Kommt `state` an einer Stelle vor, die der Adapter nicht als Pushdown nutzen kann (unter `any` oder `not`), gibt die Validierung einen Fehler mit Erklärung aus. Abgerufen werden nur offene Items, außer der Filter enthält auf oberster Ebene `state equals closed`, `state in […]` oder eine gleichwertige Bedingung. So kann ein Filter nicht mehr stillschweigend wirkungslos sein. Gilt für Workflows und Views.
4. **Feldnamen validieren:** Feldnamen in Filtern, `item_priority`, Views (`fields`, `sort`, `link`) und Operatoren werden offline gegen den statischen Feldkatalog des Adaptertyps geprüft. Dazu kommen Operatoren, die zum Feldtyp passen. `run.last_*` ist nur in Views erlaubt. Ein Tippfehler gibt einen Fehler mit Vorschlag aus („did you mean …“).
5. **Label-Vergleich ohne Groß-/Kleinschreibung:** `labels` vergleicht in Filtern und `item_priority` unabhängig von Groß-/Kleinschreibung, wie GitHub und `source.update`.
6. **`allowed_hosts` hinter HTTPS-Proxy:** Ein Host-Header ohne Port passt auf Einträge ohne Port und auf Einträge mit `:80` oder `:443`.
7. **Datumsfelder in Views:** `run.last_started_at` und `run.last_finished_at` werden in View-Filtern als Datum verglichen und sind im Katalog als `date` typisiert.
8. Die Referenz (`docs/configuration-reference.md`) und ihr Doku-Test werden auf das neue Verhalten angepasst.

## Acceptance Criteria
- [ ] Für jeden Punkt 1–7 gibt es einen Regressionstest, der ohne den Fix fehlschlägt.
- [ ] `examples/config`, die von `init` erzeugte Konfiguration und das GitHub-Testfixture validieren weiterhin.
- [ ] `docs/configuration-reference.md` beschreibt das neue Verhalten; der Doku-Test ist grün.
- [ ] `npm run check` ist grün.
