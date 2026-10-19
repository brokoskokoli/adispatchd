# WI-18 – Erneuerbare Tokens als Datei; Secrets für Shell-Actions

**Herkunft:** Wunschliste aus dem ersten Praxiseinsatz (19. Oktober 2026), Feature F3 · **Abhängig von:** `main` · **Branch:** `wi-18-token-files` · **Zielversion:** 0.3.0 · Gemeinsame Anforderungen siehe WI-17.

**Problem:** Ein Installation-Token wird einmal beim Start übergeben und ist ca. 1 h gültig. Längere Runs müssen selbst neue Tokens aus App-Keys erzeugen – dafür liegen Private Keys im Zugriff der Worker. Shell-Actions bekommen gar keine Tokens.

**Konfiguration:**
```yaml
execute:
  secrets:
    GH_TOKEN: { identity: coder, delivery: file }   # Default: env (bisheriges Verhalten)
```
**Verhalten bei `delivery: file`:**
1. Der Daemon schreibt das Token in eine Datei im Run-Verzeichnis, **außerhalb** des Workspaces (`data-dir/runs/<run-id>/secrets/<NAME>`, Verzeichnis 0700, Datei 0600).
2. Übergabe des Pfads als `<NAME>_FILE` (hier `GH_TOKEN_FILE`); `<NAME>` selbst wird nicht gesetzt.
3. Solange der Run aktiv ist, ersetzt der Daemon die Datei **atomar** (temp + rename im selben Verzeichnis), spätestens 10 Minuten vor Ablauf des Tokens (Timer über die injizierte Clock/Timers). Identities ohne Ablauf (`github_token`) werden einmal geschrieben.
4. Nach Run-Ende (jeder Endstatus) und bei Recovery nach Neustart wird die Datei gelöscht; Retention räumt Reste.
5. Fehler beim Erneuern: loggen (ohne Token), mit Backoff erneut versuchen; der Run läuft weiter, bis das alte Token abläuft.
6. Jedes ausgegebene Token wird beim Redactor registriert (stdout/stderr, Events, Logs, Action-Logs).

**Shell-Actions** (Hooks) bekommen dasselbe Feld `secrets` wie `execute`, mit `env` oder `file` (Datei in einem action-eigenen Verzeichnis unter dem Run-Verzeichnis, nach der Action gelöscht; bei `file` während langer Actions ebenfalls erneuern). Die bisherige Regel „Shell-Actions bekommen keine Secrets“ im Worker-Protokoll entsprechend ändern. Redaction gilt auch für das Action-Log.

**Validierung:** `delivery` ∈ {`env`, `file`}; `<NAME>_FILE` darf nicht mit `env`-Schlüsseln oder anderen Secret-Namen kollidieren; Identities müssen existieren.

**Akzeptanz:** Ein Run, der länger läuft als die Token-Laufzeit, findet in der Datei immer ein gültiges Token (Test mit Fake-Uhr und kurzer Laufzeit); eine Action mit `secrets` erhält das Token; das Token erscheint in keinem Log; Datei ist nach Run-Ende weg.

Hinweis für die Doku: Mit `gh` lässt sich die Datei nutzen, indem man `GH_TOKEN` pro Aufruf aus `*_FILE` liest (`GH_TOKEN=$(cat "$GH_TOKEN_FILE") gh …`).

## Acceptance Criteria
- [ ] Tests für alle Punkte oben (Erneuerung, atomarer Ersatz, Fehler beim Erneuern, Löschen bei allen Endstatus und bei Recovery, Actions mit env/file, Redaction, Validierung).
- [ ] Doku (Referenz `execute.secrets` und Actions, Worker-Protokoll, Spec-Nachtrag §20 Sicherheit, README, CHANGELOG 0.3.0); Doku-Test grün.
- [ ] `npm run check` und `npm run test:pack` grün.
