# Cron-Semantik (Spec §5.5, §7, §24.7)

Gilt für Workflows mit `trigger: { type: schedule, cron, timezone }` (Default-Zeitzone `UTC`). Implementiert in
`src/scheduler/cron.ts` (Slot-Berechnung, croner 10.0.1) und `src/scheduler/scheduler.ts` (Auslösung, Protokoll).
Das DST-Verhalten ist durch Tests festgenagelt (`src/scheduler/cron.test.ts`); ein croner-Update, das es ändert,
fällt dort auf.

## Grundregeln

- **Slot** = von croner berechneter Zeitpunkt (UTC-Instant, Sekundengenauigkeit). Syntax: croner (5 Felder, optional
  6 mit Sekunden); Validierung in `config validate` (WI-02).
- **Höchstens ein automatischer Run pro Slot.** Absicherung doppelt: Primärschlüssel `cron_firings(workflow_id,
  scheduled_for)` und Lock-Key `cron:<slot>` des Runs. Eintrag und Reservierung erfolgen in **einer** Transaktion.
- **Jeder behandelte Slot bekommt genau einen `cron_firings`-Eintrag** mit `decision`:

| decision | Bedeutung |
|---|---|
| `started` | Run reserviert und gestartet (`run_id` gesetzt) |
| `skipped_missed` | Slot verpasst (Downtime oder zu spät behandelt) – **wird nicht nachgeholt** |
| `skipped_limit` | globales oder Workflow-`max_concurrent` erreicht (aktive Runs inkl. manueller und `recovery_pending`) |
| `skipped_condition` / `skipped_condition_unknown` | Workflow-Condition `false` (Exit 1) / `unknown` (Exit ≥ 2, Timeout, Fehler) |
| `skipped_blocked` | aktiver Retry-Block im Workflow-Scope |
| `skipped_disabled` | Workflow deaktiviert (Config oder Runtime-Override) |
| `skipped_paused` / `skipped_not_ready` / `skipped_draining` | Controller pausiert / Recovery läuft noch / Drain bzw. Shutdown |
| `skipped_lock` | Slot-Lock bereits belegt (defensiv, sollte nicht vorkommen) |
| `start_failed` | Reservierung oder Start unerwartet fehlgeschlagen (`reason`) |

- **Kein Rückstau:** Ein übersprungener Slot (egal warum) wird nie nachgeholt; der nächste Run entsteht frühestens
  zum nächsten Slot. Überlappung verschiedener Slots desselben Workflows regelt `max_concurrent` (Default 1).

## Verpasste Slots

- **Toleranz** (`cronMisfireToleranceMs`, Default 60 s): Wird ein Slot spätestens so lange nach seinem Zeitpunkt
  behandelt (Timer-Latenz, kurzer Neustart), wird er normal entschieden. Ist er älter, gilt er als `skipped_missed`.
- **Nach einem Neustart** sucht der Scheduler pro Workflow ab dem jüngsten persistierten Slot (`cron_firings.latest`)
  alle Slots bis „jetzt“: der jüngste wird – falls innerhalb der Toleranz – normal entschieden, alle älteren werden
  `skipped_missed` mit Grund „slot passed while the orchestrator was not running“.
- Gibt es noch keinen persistierten Slot (erster Start, neu angelegter Workflow), beginnt die Planung bei „jetzt“ –
  es wird nichts rückwirkend protokolliert.
- Wird ein Cron-Ausdruck/eine Zeitzone per Reload **geändert**, beginnt die Planung ebenfalls bei „jetzt“.
- Begrenzung: pro Nachhol-Prüfung werden höchstens `maxRecordedMissedSlots` (Default 100) Slots einzeln
  protokolliert; ältere werden nur gezählt und im Grund des ältesten protokollierten Eintrags genannt
  („+N older missed slot(s) not recorded“). Die Suche ist auf 100 000 Slots begrenzt (danach nur noch die jüngsten).
- Timer werden höchstens 1 h im Voraus gestellt und danach neu berechnet; damit wirken auch Systemzeit-Sprünge
  (NTP, Suspend) spätestens nach 1 h, und übersprungene Slots werden als `skipped_missed` protokolliert.

## Sommerzeit (DST) – beobachtetes und festgelegtes Verhalten

Beispiel `Europe/Berlin` 2026: Umstellung auf Sommerzeit 29.03. 02:00 CET → 03:00 CEST (01:00Z),
zurück auf Winterzeit 25.10. 03:00 CEST → 02:00 CET (01:00Z).

**Fehlende Lokalzeit (Frühjahr, Lücke 02:00–02:59):**

| Ausdruck | Verhalten am Umstellungstag |
|---|---|
| `30 2 * * *` (täglich, Zeitpunkt in der Lücke) | läuft **genau einmal**, um 03:30 CEST (= 01:30Z; um die Lückenlänge verschoben) |
| `0 2 * * *` | läuft einmal um 03:00 CEST (01:00Z) |
| `0 3 * * *` | läuft einmal um 03:00 CEST (01:00Z) – also zum selben Zeitpunkt wie `0 2` |
| `*/30 * * * *` | 01:30 CET, dann 03:00 CEST, 03:30 … – die nicht existierenden 02:00/02:30 entfallen ersatzlos, keine Duplikate |

Regel: Tägliche (und seltenere) Jobs mit einer Uhrzeit in der Lücke fallen **nicht** aus, sondern laufen einmal,
verschoben um die Lückenlänge. Sub-stündliche/stündliche Jobs verlieren die Slots in der Lücke (die verschobene Zeit
existiert ohnehin als regulärer Slot und läuft nur einmal).

**Doppelte Lokalzeit (Herbst, 02:00–02:59 zweimal):**

| Ausdruck | Verhalten am Umstellungstag |
|---|---|
| `30 2 * * *` | läuft **genau einmal**, beim ersten Durchlauf (02:30 CEST = 00:30Z); die zweite 02:30 (CET) läuft nicht |
| `0 * * * *` | 02:00 CEST (00:00Z), dann 03:00 CET (02:00Z) – die zweite 02:00 (CET, 01:00Z) entfällt |
| `*/30 * * * *` | 02:00, 02:30 CEST, dann 03:00 CET – Lücke von 1,5 h, die wiederholten 02:00/02:30 CET entfallen |

Regel: Jede **Wanduhrzeit** wird höchstens einmal ausgelöst – beim ersten Auftreten. Es gibt nie zwei Runs für
„02:30“ an einem Tag. Wer exakte Intervalle braucht, verwendet `timezone: UTC`.

**UTC** hat keine Umstellung; Slots sind unverändert.

## Zusammenspiel mit anderen Regeln

- Conditions werden pro Slot ausgewertet (Workflow-Conditions mit `cache` über den TTL-Cache, sonst neu);
  Item-Conditions/Filter gibt es für Schedule-Workflows nicht.
- Retry-Blocks für Schedule-Workflows sind workflowbezogen (`itemKey = null`); ein aktiver Block führt zu
  `skipped_blocked`, bis er entfernt wird.
- Manuelle Starts eines Schedule-Workflows haben eigene Lock-Keys (`manual:<runId>`), erzeugen keinen
  `cron_firings`-Eintrag, zählen aber zur Auslastung und können dadurch einen Slot zu `skipped_limit` machen.
- Deaktivierte Workflows werden weiter getaktet, jeder Slot wird als `skipped_disabled` protokolliert (vollständige
  Historie; bei sehr häufigen Ausdrücken entsprechend viele Zeilen – Retention `deleteCronFirings` räumt auf).
