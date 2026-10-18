# WI-04 – Filter-AST, Prioritäten, Shell-Filter/Conditions

**Spec:** §6, §7 · **Abhängig von:** 01 · **Branch:** `wi-04-filters` · **Verzeichnis:** `src/filters/`

## Umfang
1. **Dreiwertiger Evaluator** für den Filter-AST: `all`, `any`, `not`; Operatoren `equals`, `not_equals`, `contains` (Array enthält / String enthält), `in`, `greater_than`, `less_than` (nur vergleichbare Typen, sonst `unknown`); Feldpfade mit Punkten (`dependencies.blocked_by_open`, `run.last_result.message`). Kleene-Logik: `all` = false wenn ein false, sonst unknown wenn ein unknown; `any` analog; `not unknown = unknown`.
2. Felder können `known: false` liefern (z. B. fehlender API-Zugriff) → `unknown`, **nie** als 0/leer werten (§6, §20.7).
3. **Lazy Evaluation:** Evaluator nimmt einen async Feld-Resolver; günstige Felder zuerst, teure (vom Adapter markiert) nur bei Bedarf; Kurzschluss, sobald Ergebnis feststeht. Diagnose-Trace (welche Regel → true/false/unknown/not_evaluated) für Dry-Run/GUI.
4. **Pushdown-Split:** Funktion, die einen AST in (a) vom Adapter unterstützten Teil (anhand `FieldDefinition.operators`/Pushdown-Fähigkeit) und (b) lokal auszuwertenden Rest teilt – konservativ (nur `all`-Konjunktionen pushen).
5. **Item-Priorität** (`item_priority.rules`, erste passende Regel gewinnt, sonst `default`; `unknown` matcht nicht).
6. **Deterministische Sortierung** von Kandidaten: Workflow-Priorität desc, Item-Priorität desc, Tie-Breaker Erstellungszeit asc, dann Item-Key asc (§7).
7. **Shell-Check-Runner** (für Shell-Filter und Conditions): Kommando als Argumentliste (`execFile`, kein Shell-String, außer explizit konfiguriert), Item-Kontext als JSON via Datei/Env (`ADISPATCH_CHECK_CONTEXT_FILE`) mit Minimal-Env, Timeout → `unknown`/Prüffehler, Exit 0 = true, 1 = false, ≥2/Signal/Spawnfehler = `unknown` mit Fehlerdetail. Cache für Workflow-Conditions (TTL aus Config, Clock-basiert); Item-Conditions ohne Cache standardmäßig. Ausgabe begrenzen.

## Acceptance Criteria
- [ ] Wahrheitstabellen für all/any/not mit unknown getestet.
- [ ] Typinkompatible Vergleiche → unknown (Test).
- [ ] Teures Feld wird nicht abgefragt, wenn günstiger Teil bereits false (Test mit Resolver-Spy).
- [ ] Sortierung deterministisch inkl. Tie-Breaker (Test, Szenario „priority:high im Coder überholt nicht Reviewer mit höherer Workflow-Priorität“).
- [ ] Shell-Check: Exit 0/1/2, Timeout, nicht existierendes Kommando, Cache-TTL (Tests mit echten kleinen Shell-Skripten).
- [ ] Diagnose-Trace enthält pro Regel den Wert inkl. `not_evaluated`.
