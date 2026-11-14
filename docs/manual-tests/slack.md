# Manuelle Tests: Slack-Kanal mit Threads und Antworten (WI-39)

Automatisiert ist alles gegen einen **Fake-Slack** (Web-API über ein injiziertes `fetch`, Socket Mode über eine
injizierte WebSocket-Fabrik und einen minimalen WebSocket-Server ohne Abhängigkeit): Thread je (Workflow, Item),
Reihenfolge im Thread, Backoff mit `Retry-After`, Erinnerungen, Annahme von Antworten (was zählt, genau einmal,
Secrets), Lifecycle-Run `reply`, Warteschlange je Item, `reply_check`, Recovery, Reconnect. **Kein Test spricht mit dem
echten Slack.** Diese Checkliste prüft die Annahmen über das echte Slack (Scopes, Event-Formate, Socket-Mode-Verhalten)
mit einer eigenen Test-App und einem eigenen Test-Channel – nicht in einem produktiven Workspace-Channel.

Ergebnis je Schritt in einer Kopie dieser Datei abhaken (✓ / ✗ mit Notiz). Annahmen, die sich als falsch erweisen,
als Befund an den Maintainer.

## Vorbereitung

1. Slack-App nach [operations.md → Slack](../operations.md#slack-thread-je-item-und-antworten-seit-0110) anlegen:
   Socket Mode an (App-Level-Token `xapp-…` mit `connections:write`), Bot-Scopes `chat:write`, `reactions:write`,
   `channels:history`, `users:read`; Event `message.channels`; installieren (Bot-Token `xoxb-…`).
2. Test-Channel `#adispatchd-test` anlegen, App einladen (`/invite @<App>`), Channel-ID und eigene User-ID notieren.
   Eine zweite Person (oder ein zweites Konto) für den Test „fremder Nutzer“.
3. Lokale Instanz mit Fake-freiem GitHub-Test-Repo (wie in [github.md](github.md)) oder einem Wegwerf-Repo:

   ```bash
   export SLACK_BOT_TOKEN=xoxb-…   SLACK_APP_TOKEN=xapp-…
   adispatch init --config-dir ./slack-cfg --data-dir ./slack-data
   ```

   `config.yaml` ergänzen (IDs ersetzen):

   ```yaml
   notifications:
     on: [retry_block_created, lifecycle_action_failed, recovery_failed]
     channels:
       - id: team
         type: slack
         bot_token_env: SLACK_BOT_TOKEN
         app_token_env: SLACK_APP_TOKEN
         channel: C0123456789
         allowed_users: [U0123456789]
   ```

   Workflow `workflows/handover.yaml` (Worker meldet `needs_maintainer`):

   ```yaml
   id: handover
   trigger: { type: source, source: <source-id> }
   filter: { field: labels, operator: contains, value: handover-test }
   execute:
     type: shell
     command: scripts/needs-maintainer.sh
   on_result:
     needs_maintainer:
       - type: source.update
         labels: { add: [needs-maintainer], remove: [handover-test] }
       - type: notify
         channel: team
         message: "{item.title}: {result.message}"
         remind_after: 2m
         remind_while: { field: labels, operator: contains, value: needs-maintainer }
   reply_check:
     command: scripts/check-reply.sh
     timeout: 10s
   on_reply:
     - type: source.comment
       message: "{reply.text}\n\n(Antwort in Slack von {reply.user_name}, {reply.permalink})"
     - type: source.update
       labels: { remove: [needs-maintainer] }
   ```

   `scripts/needs-maintainer.sh`:

   ```sh
   #!/bin/sh
   printf '{"schema_version":1,"result":"success","outcome":"needs_maintainer","message":"Welche Datenbank?"}' > "$ADISPATCH_RESULT_FILE"
   ```

   `scripts/check-reply.sh` (lehnt „nein“ ab, Exit 3 bei „kaputt“):

   ```sh
   #!/bin/sh
   text=$(cat)
   case "$text" in *nein*) echo "Bitte konkreter antworten"; exit 1;; *kaputt*) exit 3;; esac
   exit 0
   ```

   `adispatch config validate`, dann `adispatch start …`.

## Testfälle

| # | Schritt | Erwartung |
|---|---|---|
| S1 | UI *Config → Notifications* | Kanal `team`: `slack`, Replies `yes (1 allowed user)`, Connection `connected`. Log ohne Token (`grep -c xoxb-` = 0). |
| S2 | Issue mit Label `handover-test` anlegen, Planung abwarten | Run endet, Label `needs-maintainer`; im Channel **ein** Kopf (Titel als Link, `<source>:<nr> · workflow handover`, Hinweis „Reply in this thread …“), darin die Antwort „<Titel>: Welche Datenbank?“. |
| S3 | Zweites Mal (Label wieder setzen, `needs-maintainer` entfernen) | Neue Nachricht im **selben** Thread, kein zweiter Kopf. |
| S4 | 2 min warten, ohne zu antworten | Genau **eine** Erinnerung „⏰ Reminder: …“ im Thread; danach keine weitere. |
| S5 | Im Thread antworten: „Bitte *Postgres* nehmen, siehe <Link>“ | Sofort ⏳ an der Antwort; danach ✅. Am Issue ein Kommentar mit dem Klartext (Link als `Text (url)`), Anzeigename und Permalink; Label `needs-maintainer` entfernt. Run-Liste: Run mit Trigger `reply`, `completed`/`success`. Item-Verlauf: „Reply in Slack from <Name>“ ohne Text. |
| S6 | Dieselbe Antwort bearbeiten (Slack „Edit message“) | Nichts passiert (`message_changed` ignoriert), kein zweiter Run. |
| S7 | Antwort „nein“ | ❌, Antwort im Thread „Reply rejected: Bitte konkreter antworten.“; kein Kommentar am Issue; Run `failure` mit Grund `reply rejected by reply_check: …`. |
| S8 | Antwort „kaputt“ | ❌, „The reply could not be processed (the reply check failed). Lifecycle run …“; Run zeigt Action `reply_check` `failed`. Skript auf `exit 0` ändern, in der UI „Retry“ der Action → Kommentar erscheint, ✅. |
| S9 | Antwort mit einem Fake-Token `ghp_` + 36 Zeichen | ❌, „Reply rejected: looks like it contains a secret (GitHub token ×1) …“; Datenbank enthält den Text nicht (`sqlite3 slack-data/adispatchd.sqlite "select text from notification_replies"` → leer). |
| S10 | Antwort einer Person **nicht** in `allowed_users` | Keine Reaktion, kein Run (Log `reply ignored` auf `debug` mit `user not in allowed_users`). |
| S11 | Nachricht im Channel **außerhalb** des Threads | ignoriert. |
| S12 | Während ein Run des Items läuft (Worker mit `sleep 60`), im Thread antworten; parallel „Start“ in der UI für dasselbe Item | Antwort bekommt ⏳, Reply-Run startet erst nach Ende des Runs; der manuelle Start wird mit `409 reply_pending` abgelehnt, solange die Antwort wartet; Planung zeigt `locked: reply … pending`. |
| S13 | Socket trennen: Netzwerk kurz weg (z. B. WLAN aus, 30 s) | Kanalstatus `disconnected` mit Fehler und „next attempt“; danach automatisch `connected`. Eine Antwort, die während der Trennung geschrieben wurde, kommt nach dem Reconnect an (Slack liefert nach) und läuft genau einmal. |
| S14 | Instanz während eines Reply-Runs hart beenden (`kill -9` während `reply_check` mit `sleep 5`) und neu starten | Recovery setzt den Reply-Run fort; genau ein Kommentar am Issue. |
| S15 | `allowed_users` per Reload ändern (eigene ID entfernen), Reload | Verbindung bleibt (`connected`, keine neue Verbindung im Log), eigene Antworten werden jetzt ignoriert. |
| S16 | `app_token_env` entfernen, Reload | Verbindung wird geschlossen, Kanal `disabled (send only)`; Nachrichten gehen weiter. |
| S17 | Scope `users:read` entfernen, App neu installieren, antworten | `{reply.user_name}` = User-ID; alles andere funktioniert. |
| S18 | Zwei Instanzen mit **derselben** App starten (nur zur Bestätigung der Doku) | Antworten kommen nur teilweise an der richtigen Instanz an (Bestätigung von „eine App je Instanz“). |

## Annahmen über Slack, die hier bestätigt werden

- A1: `chat.postMessage` mit `thread_ts` antwortet im Thread; `ts` der Kopfnachricht = `thread_ts` der Antworten im Event.
- A2: Socket Mode liefert `hello`, `events_api` mit `envelope_id` und `disconnect` (`refresh_requested` ca. alle paar Stunden).
- A3: Antworten im Thread kommen als `message`-Event mit `thread_ts` ≠ `ts`, ohne `subtype`; Bearbeiten als `message_changed`.
- A4: Eigene Bot-Nachrichten kommen mit `bot_id` (werden ignoriert).
- A5: `reactions.add` mit `already_reacted` bei doppelter Reaktion; `reactions.remove` mit `no_reaction`.
- A6: HTTP `429` mit `Retry-After` bei Rate-Limits (z. B. viele Nachrichten in kurzer Zeit in denselben Channel).
