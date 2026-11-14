# WI-39 – Slack-Kanal mit Threads je Item und Antworten (`notify`, `on_reply`)

**Herkunft:** Wunsch des Maintainers (14. November 2026) · **Abhängig von:** `main` (0.10.1) · **Branch:** `wi-39-slack-threads-replies` · **Zielversion:** 0.11.0 (neue DB-Tabellen → Minor, DB-Schema v8)

Status: vom Maintainer im Grundsatz freigegeben; Kohärenzprüfung durch den Orchestrator mit Präzisierungen (Abschnitt
„Präzisierungen“ am Ende – sie gehen dem übrigen Text vor, wo sie ihn genauer fassen).

## Problem

Ein Workflow, der ein Item an einen Menschen übergibt (z. B. Outcome `needs_maintainer` → Label), meldet das heute
nirgends aktiv. §18 kennt nur Orchestrator-Ereignisse (`retry_block_created`, …) und nur als Einweg-Webhook. In der
Praxis wartet die Übergabe, bis jemand die View öffnet (Beispiel aus einem Projekt: 42 Übergaben in zwei Wochen,
Median 4,2 h bis zur Fortsetzung). Die Antwort muss außerdem in der Source landen (Kommentar am Issue), weil die
Agenten nur dort lesen – heute heißt das: Kontext wechseln, Issue suchen, kommentieren, Label entfernen.

Gewünscht, und für jedes Projekt nutzbar (nichts Projektspezifisches im Paket):
1. Eine Frage/Übergabe erscheint als **Slack-Nachricht mit Thread je Item**.
2. Eine **Antwort im Thread** löst konfigurierbare Actions am Item aus (Kommentar als Identity, Label entfernen, …).
3. Erinnerung, solange das Item noch wartet.

## Leitidee: Antworten sind ein Lifecycle-Run wie `on_retry_unblock`

Das Modell bekommt keine neue Engine. Es wird kombiniert, was es schon gibt:

| Wunsch | Umsetzung mit vorhandener Mechanik |
|---|---|
| Nachricht an Slack | neuer Kanaltyp `slack` unter `notifications.channels` (§18, Zustellung, Retry, Speicherung wie `webhook`) |
| Nachricht aus einem Workflow | neue Lifecycle-Action `type: notify` (läuft in jeder Hook-Kette, z. B. `on_result.needs_maintainer`) |
| Thread je Item | Zuordnung (Workspace, Workflow, Item) → Slack-Thread in SQLite; jede weitere `notify`-Nachricht zu diesem Item geht in denselben Thread |
| Antwort → Actions am Item | neuer Workflow-Hook `on_reply`, ausgeführt als **Lifecycle-Run** (Trigger `reply`) – Semantik wie `on_retry_unblock` (§11, Spec Zeile „`on_retry_unblock` läuft …“): kein Worker, kein Workspace, Lock `(Workflow, Item)`, Snapshot der beim Eingang geladenen Konfiguration, zählt nicht als technischer Fehler, nicht zu `max_concurrent`, nicht als `run.last_*` |
| Orchestrator-Ereignisse | `retry_block_created` & Co. dürfen auf einen `slack`-Kanal; hat das Ereignis ein Item, landet es im Thread dieses Items (Workflow des Blocks); eine Antwort darauf läuft durch `on_reply` dieses Workflows |

Warum nicht „Beobachtung einer View“ (erste Skizze): Eine View hat keinen Workflow, keine Identity und kein Lock – die
Antwort hätte keinen sauberen Ort, an dem `source.comment` mit welcher Identity und unter welchem Lock läuft. Mit
`notify` + `on_reply` bleibt alles im Workflow, wie Hooks heute.

## Entscheidungen

1. **Kanal `type: slack`** (zusätzlich zu `webhook`):
   ```yaml
   notifications:
     on: [retry_block_created, lifecycle_action_failed, recovery_failed]
     channels:
       - id: team
         type: slack
         bot_token_env: SLACK_BOT_TOKEN        # xoxb-…: chat:write, reactions:write, channels:history bzw. groups:history
         app_token_env: SLACK_APP_TOKEN        # xapp-…: connections:write (Socket Mode); ohne → nur Senden, keine Antworten
         channel: C0123456789                  # Channel-ID, nicht der Name
         allowed_users: [U0123456789]          # Slack-User-IDs, deren Antworten zählen; leer/fehlend → keine Antwort zählt
   ```
   Tokens nur aus der Umgebung (wie `url_env`), beim Redactor registriert, nie in Logs, Events, API, DB.
2. **Socket Mode** (ausgehende WebSocket-Verbindung, kein offener Port, passt zu Loopback/VPN, §20.1): globales
   `WebSocket` von Node ≥ 22 bzw. 24, **keine neue Dependency**. `apps.connections.open` mit dem App-Token, Envelope-
   Typen `hello`, `events_api`, `disconnect`; jedes `events_api` wird **sofort** bestätigt (`envelope_id`, < 3 s),
   verarbeitet wird danach. Reconnect mit Backoff (1 s … 60 s), `disconnect` → neu verbinden; Zustand sichtbar
   (Health-Detail / Kanalstatus in der UI). Ohne `app_token_env` keine Verbindung (nur Senden).
3. **Eine Slack-App je Workspace (Instanz).** Slack verteilt die Ereignisse einer App auf **eine** ihrer offenen
   Socket-Verbindungen; teilen sich zwei Instanzen (z. B. zwei Workspaces unter einem Hub) eine App, verliert jede einen
   Teil der Antworten. Dokumentieren (operations.md, Hub-Abschnitt); eine hubweite Verbindung mit Routing ist nicht
   Teil von WI-39.
4. **Lifecycle-Action `notify`:**
   ```yaml
   on_result:
     needs_maintainer:
       - type: notify
         channel: team                         # ID aus notifications.channels, Typ slack (webhook: Konfigurationsfehler)
         message: "{item.title}: {result.message}"   # Platzhalter wie source.comment
         remind_after: 4h                      # optional: eine Erinnerung im Thread …
         remind_while: needs-maintainer        # … nur wenn das Item dann noch diesen Filter erfüllt (Filter-ID oder AST)
   ```
   - Erste Nachricht zu (Workflow, Item) legt den Thread an (Kopfnachricht mit Titel und Link des Items, dann die
     Meldung als erste Antwort), jede weitere geht in denselben Thread. Optional `thread: new` erzwingt einen neuen.
   - Zustellung über den bestehenden Zustellmechanismus (Persistenz, Backoff, 429 mit `Retry-After`), die Action ist
     erfolgreich, sobald die Zustellung **angelegt** ist (Orchestrierung hängt nie an Slack, §18). Fehlzustellung
     → wie bei Webhooks in der UI.
   - Erinnerung: einmal je `notify`, nach `remind_after`, nur wenn `remind_while` dann `true` ist (`unknown` → keine
     Erinnerung, Log). Eine Antwort im Thread hebt eine ausstehende Erinnerung auf.
   - Workflows ohne Item: `notify` erlaubt, aber ohne Thread-Zuordnung und ohne Antworten (Hinweis in der Validierung,
     wenn der Workflow `on_reply` hat).
5. **Hook `on_reply`** (Workflow-Ebene, neben `on_retry_unblock`):
   ```yaml
   reply_check:                                # optional: Prüfung des Antworttexts vor der Kette
     command: scripts/check-reply.sh           # stdin = Text; Exit 0 ok, 1 abgelehnt (stdout = Grund), ≥2 unknown
     timeout: 30s
   on_reply:
     - type: source.comment
       identity: maintainer
       message: "{reply.text}"
     - type: source.update
       labels: { remove: [needs-maintainer] }
   ```
   - Eine Antwort zählt nur, wenn: Kanal und Channel stimmen, `thread_ts` einem gespeicherten Thread gehört, Absender in
     `allowed_users`, Nachricht neu (kein `subtype` wie `message_changed`, `message_deleted`, `bot_message`, kein Bot).
   - Exakt einmal je Slack-Nachricht (`channel` + `ts` als Schlüssel; Slack wiederholt Ereignisse): eingehende Antwort
     wird **persistiert**, dann verarbeitet. Ist für `(Workflow, Item)` gerade ein Run aktiv, wartet die Antwort und
     läuft, sobald das Lock frei ist (FIFO je Item); kein 409.
   - Lifecycle-Run, Trigger `reply`, Semantik wie Unblock-Run (siehe Leitidee); Retry/Skip einzelner Actions,
     Recovery und Item-Verlauf (WI-33) wie bei jedem Run. Nicht abbrechbar.
   - Platzhalter nur in `on_reply` und `reply_check`: `{reply.text}`, `{reply.user}` (Slack-ID), `{reply.user_name}`
     (Anzeige, best effort), `{reply.ts}`, `{reply.permalink}`, `{reply.channel}`; anderswo Konfigurationsfehler.
   - `{reply.text}` ist **untrusted text** (§20.5): Slack-Formatierung in Klartext umsetzen (`<@U…>`, `<url|text>`,
     `&amp;`), Länge begrenzen (z. B. 8 KiB), HTML-Kommentare entschärfen wie bei `source.comment`, Secret-artige
     Inhalte ablehnen wie bei WI-27 (gleiche Prüfung wiederverwenden). Abgelehnt → nichts gepostet, Grund im Thread.
   - Rückmeldung in Slack: Reaktion ⏳ bei Eingang, ✅ wenn die Kette `success` endet, ❌ plus kurze Thread-Antwort
     (ohne Interna, ohne Secrets) bei `failure`/Ablehnung. Reaktionen best effort.
6. **Speicher (Schema-Migration mit Backup):** Tabelle `notification_threads` (Kanal, Workflow, Source, Item, Channel,
   `thread_ts`, angelegt, letzte Nachricht) und `notification_replies` (Kanal, `channel`+`ts` eindeutig, Thread, Benutzer,
   Text **nur bis zur Verarbeitung** – danach geleert, Status `pending|running|done|rejected|failed`, Lifecycle-Run-ID).
   Erinnerungen als Deliveries mit Fälligkeit (bestehende Tabelle erweitern oder eigene Spalte – Coder entscheidet,
   im Handoff festhalten). Retention: Threads ohne Nachricht seit `retention.notification_threads` (Default 90 Tage)
   löschen; Antworten mit dem Lifecycle-Run.
7. **Reload:** Kanal-Änderungen wirken nach Reload; die Socket-Verbindung wird nur neu aufgebaut, wenn sich App-Token-
   Variable oder Kanal-ID ändern. Entfernt man einen Kanal, bleiben gespeicherte Threads, Antworten darauf werden
   ignoriert (Log).

## Umfang

- Config-Schema + Validierung (`slack`-Kanal, `notify`, `on_reply`, `reply_check`, Platzhalter-Regeln, Verweise auf
  Kanal-IDs und Filter, Warnung bei `on_reply` ohne `app_token_env`/`allowed_users`).
- Slack-Web-API-Client (`chat.postMessage`, `chat.getPermalink`, `reactions.add`; `fetch`, Timeout, 429/`Retry-After`,
  Fehlertexte ohne Token) und Socket-Mode-Client (siehe Entscheidung 2) mit Fakes für Tests.
- Notification-Service: Kanaltyp `slack`, Thread-Zuordnung, Erinnerungen.
- Lifecycle: Action `notify`, Hook `on_reply` als Lifecycle-Run, Warteschlange je Item, Recovery (Antwort `running`
  beim Neustart → wie andere Lifecycle-Runs).
- API/UI: Kanalstatus (verbunden/getrennt/letzter Fehler), Antworten im Item-Verlauf (WI-33: „Antwort in Slack von …“,
  ohne Text) und in der Run-Ansicht des Lifecycle-Runs; Notifications-Seite zeigt Slack-Zustellungen wie Webhooks.
- Doku: configuration-reference (Kanal, Action, Hook, Platzhalter, Beispiel mit `# example:`-Test), api.md,
  operations.md (Slack-App anlegen: Socket Mode an, Scopes, Event `message.channels`/`message.groups`, App in Channel
  einladen, Tokens in die Env-Datei, eine App je Instanz), worker-protocol nur falls berührt, Spec-Nachtrag §18,
  CHANGELOG, status.md, README EN/DE, Website-Featureliste, `examples/config`, `init`-Vorlage (auskommentiert).

## Nicht Teil davon

Slash-Commands, Buttons/Interaktivität (Block Kit Actions), Direktnachrichten, Antworten außerhalb von Threads,
hubweite Slack-Verbindung mit Routing, andere Chat-Dienste (die Schnittstelle so schneiden, dass ein zweiter
Anbieter später möglich ist, aber nicht bauen), Bearbeiten/Löschen bereits verarbeiteter Antworten.

## Offene Detailfragen für den Coder-Agenten (im Handoff festhalten)

1. Erinnerungen in `notification_deliveries` (Fälligkeit) oder eigene Tabelle?
2. Kopfnachricht: Felder und Format (Item-Titel als Link, Source, Workflow) – kurz halten, kein Block Kit nötig.
3. Mehrere `notify` desselben Items aus **verschiedenen** Workflows: ein Thread je (Workflow, Item) wie entschieden,
   oder je Item? Empfehlung: je (Workflow, Item), weil `on_reply` workflowgebunden ist.
4. Verhalten, wenn das Item beim Eingang der Antwort nicht mehr lesbar/gelöscht ist (Empfehlung: `failed` mit ❌).

## Präzisierungen (Kohärenzprüfung des Orchestrators, 14. November 2026)

Die Spezifikation passt zum bestehenden Modell (§18-Zustellung mit `notification_deliveries`, Lifecycle-Run wie
`unblock` in `src/runs/controller.ts`, Platzhalter-Scoping wie `{block.*}`, Secret-Scan aus `src/api/secret-scan.ts`,
Entschärfung von `<!--` in `src/lifecycle/performers.ts`, `retention.*`). Folgende Punkte waren offen oder ungenau und
gelten verbindlich:

P1. **Abweichung von WI-30 bewusst:** Der Unblock-Run lehnt bei aktivem Run mit `409 block_run_active` ab; eine Antwort
    wartet stattdessen (sie kommt asynchron, niemand könnte den 409 sehen). Damit die wartende Antwort nicht von einem
    neuen Worker-Run überholt wird: Ist für `(Workflow, Item)` eine Antwort `pending`, startet der Scheduler dort keinen
    neuen Run (Entscheidung `skipped_blocked` bzw. eigener Grund, z. B. `reply pending`; manueller Start mit diesem
    Item → `409 reply_pending`), und sobald das Lock frei wird, wird der Reply-Run reserviert, bevor andere Starts
    zum Zug kommen. In Spec und configuration-reference beschreiben.
P2. **Reihenfolge beim Eingang:** Ereignis prüfen → Antwort **synchron persistieren** (eindeutig `channel`+`ts`,
    `INSERT … ON CONFLICT DO NOTHING`) → Ack an Slack → Verarbeitung. Persistieren ist keine „Verarbeitung“ im Sinne
    von Entscheidung 2 und dauert Millisekunden; so geht zwischen Ack und Absturz nichts verloren. Ereignisse, die
    ignoriert werden, werden trotzdem bestätigt.
P3. **Typ der `notify`-Nachrichten:** `notify` legt einen Eintrag in `notifications` mit eigenem Typ (z. B.
    `workflow_notify`) und genau einer Delivery auf den genannten Kanal an. Weder `notifications.on` noch das `on` des
    Kanals filtern ihn (die Action ist explizit). `notifications.on`/Kanal-`on` gelten weiter nur für die
    Orchestrator-Ereignisse; ein `slack`-Kanal kennt dasselbe optionale `on` wie `webhook`.
P4. **Orchestrator-Ereignisse auf Slack:** Text aus dem Ereignis (Typ, Workflow, Item, kurzer Grund – ohne Interna und
    ohne Secrets) erzeugen; mit Item in den Thread `(Workflow, Item)` (Thread wird bei Bedarf angelegt), sonst als
    Top-Level-Nachricht im Channel.
P5. **Reihenfolge je Thread:** Zustellungen in denselben Thread werden der Reihe nach zugestellt; eine Folgenachricht
    wartet, bis die Kopfnachricht zugestellt ist und ihr `ts` gespeichert ist (kein zweiter Kopf bei gleichzeitigen
    `notify`). Ein erneuter Versuch nach teilweisem Erfolg (Kopf gepostet, Antwort nicht) postet den Kopf nicht noch
    einmal.
P6. **Kein `on_reply` (oder leer):** Antworten im Thread werden ignoriert (Log debug), keine Reaktion; eine
    ausstehende Erinnerung wird trotzdem aufgehoben.
P7. **Scope `users:read`** nur für `{reply.user_name}` (`users.info`, best effort, im Speicher gecacht); fehlt der
    Scope, bleibt `{reply.user_name}` = `{reply.user}`. In operations.md bei den Scopes als optional nennen.
P8. **Hub:** Jeder Workspace hat seine eigene `config.yaml` und damit eigene Kanäle und Socket-Verbindung; der Hub
    selbst bekommt nichts. Validierung kann nicht erkennen, dass zwei Workspaces dieselbe App nutzen → nur Doku
    (Entscheidung 3).
P9. **Fakes statt echter Dienste:** Tests nutzen einen Fake-Slack (Web-API über injiziertes `fetch`) und eine
    injizierbare WebSocket-Fabrik bzw. einen minimalen Test-WebSocket-Server ohne neue Dependency. Kein Test spricht
    mit dem echten Slack. Zusätzlich eine manuelle Testanleitung `docs/manual-tests/slack.md` (echte App, echter
    Channel) für den Maintainer; als P1-Punkt in `docs/status.md` aufnehmen.
P10. **Version und Schema:** 0.11.0 und DB-Schema v8 (Migration mit Backup, kein Downgrade); `runs.trigger_type`
    erlaubt `reply`, `run_actions.hook` erlaubt `on_reply`. Kein Release/Tag/Publish in diesem Work-Item – das macht
    der Orchestrator bzw. Maintainer nach dem Merge; der CHANGELOG-Abschnitt bleibt unter „Unreleased“.

## Acceptance Criteria

- [ ] `config validate` akzeptiert die Beispiele oben und lehnt ab: `notify` auf `webhook`-Kanal, unbekannter Kanal,
      `{reply.*}` außerhalb von `on_reply`/`reply_check`, `remind_while` mit unbekanntem Filter, Token im YAML statt Env.
- [ ] `notify` legt beim ersten Mal einen Thread an und schreibt weitere Nachrichten zum selben (Workflow, Item) in
      diesen Thread (Test mit Fake-Slack: `thread_ts` der Folgenachrichten = Kopf-`ts`).
- [ ] Slack nicht erreichbar / 5xx / 429 mit `Retry-After`: die Hook-Kette ist trotzdem sofort fertig, die Zustellung
      wird mit Backoff wiederholt, Versuche sind gespeichert und in der UI sichtbar; nie ein Token in Fehlertext/Log.
- [ ] Erinnerung kommt genau einmal nach `remind_after`, nur wenn `remind_while` dann `true` ist; nicht nach einer
      Antwort; nicht bei `unknown`.
- [ ] Antwort eines Nutzers aus `allowed_users` im bekannten Thread startet genau **einen** Lifecycle-Run `reply` mit
      `on_reply`; dieselbe Slack-Nachricht doppelt zugestellt (Reconnect, Slack-Retry) startet keinen zweiten.
- [ ] Ignoriert (kein Run, Log auf debug): fremder Nutzer, anderer Channel, unbekannter Thread, Top-Level-Nachricht,
      `message_changed`/`message_deleted`/`bot_message`, eigene Bot-Nachrichten.
- [ ] Läuft für (Workflow, Item) ein Run, wartet die Antwort und startet danach (Test: Run aktiv → Antwort → Run endet
      → Lifecycle-Run startet); mehrere Antworten in Reihenfolge; kein neuer Worker-Run überholt eine wartende Antwort (P1).
- [ ] `reply_check` Exit 1 → nichts ausgeführt, Grund im Thread, ❌; Exit ≥ 2/Timeout → nicht ausgeführt, als
      `failed` sichtbar, erneut versuchbar (Retry in der UI).
- [ ] `{reply.text}` wird in Klartext umgesetzt, gekürzt, HTML-Kommentare entschärft; Secret-artiger Text abgelehnt.
- [ ] Neustart mit Antwort `pending`/`running`: wird genau einmal fertig verarbeitet (Recovery-Test).
- [ ] Socket Mode: `hello` → verbunden; `disconnect` und Verbindungsabbruch → Reconnect mit Backoff; Ack jedes
      `events_api` vor der Verarbeitung (Test mit Fake-WebSocket-Server); Status in API/UI.
- [ ] Schema-Migration mit Backup; `src/version.test.ts` und die Release-Gates grün (macOS + Linux-Container `node:24`).
- [ ] Doku vollständig gezogen (Liste unter Umfang); Beispiele in configuration-reference durch den Beispiel-Test geprüft;
      keine projektspezifischen Namen in Code, Doku, Tests (generisch: `acme/app`, `team`).
