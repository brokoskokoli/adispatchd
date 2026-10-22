# WI-30 – Hooks beim Entstehen und Aufheben eines Retry-Blocks

**Herkunft:** Wunsch des Maintainers (22. Oktober 2026) · **Abhängig von:** `main` (0.5.0) · **Branch:** `wi-30-retry-block-hooks` · **Zielversion:** 0.6.0

## Problem

Nach `retry.max_technical_failures` technischen Fehlern in Folge entsteht ein Retry-Block (§6.4). Heute passiert dabei
außer der Benachrichtigung `retry_block_created` nichts Konfigurierbares, und beim Aufheben („Remove Block“,
`POST /api/v1/blocks/:id/clear`) gar nichts. Gewünscht: In beiden Momenten Actions ausführen können – wie in den
übrigen Hooks Labels/Projektfelder setzen (`source.update`), kommentieren (`source.comment`) oder ein Skript
(`shell`, z. B. SSH/Bash) aufrufen.

## Konfiguration

Zwei neue, optionale Hooks im Workflow (Default `[]`), Listen derselben Actions wie die übrigen Hooks (§3.4.11, inkl.
`id`, `continue_on_error`, `retry`, `secrets` bei `shell`):

```yaml
on_retry_block:                 # Block ist gerade entstanden
  - type: source.update
    labels: { add: [agent-blocked], remove: [ready] }
    project: { Status: Blocked }
  - type: source.comment
    message: "Nach {block.failures} technischen Fehlern blockiert (zuletzt {block.last_status}, Run {run.id})."
  - type: shell
    command: ./scripts/notify-blocked.sh
    args: ["{item.key}", "{block.failures}"]

on_retry_unblock:               # Block wurde aufgehoben
  - type: source.update
    labels: { add: [ready], remove: [agent-blocked] }
    project: { Status: Todo }
```

Name bewusst `on_retry_block`/`on_retry_unblock`, nicht `on_block`: „blocked“ ist bereits für GitHub-Abhängigkeiten
belegt (`dependencies.blocked`).

## Verhalten

1. **Entstehen (`on_retry_block`).** Entsteht der Block beim Übergang eines Runs nach `finalizing` (§6.4), wird
   `on_retry_block` an die Abschluss-Kette **dieses Runs angehängt**: erst der gewählte Abschluss-Hook
   (`on_crash`/`on_start_error`/`on_timeout`/`on_error`), danach `on_retry_block`. So kann der Fehler-Hook z. B. ein
   Label zurücksetzen, ohne den Block-Status zu überschreiben. Die Wahl wird wie `completionHook` am Run gespeichert
   (Recovery setzt genau diese Kette fort). Scheitert eine Action des Abschluss-Hooks endgültig (ohne
   `continue_on_error`), läuft `on_retry_block` trotzdem (eigene Kette); Journal-IDs `on_retry_block.<index>` bzw. `id`.
   Auch der Fall „`start_error` ohne Hooks“ (§6.5) führt `on_retry_block` aus, wenn er den Block erzeugt.
2. **Aufheben (`on_retry_unblock`).** Beim Aufheben gibt es keinen Run. Ist `on_retry_unblock` nicht leer, legt das
   Aufheben in **derselben Transaktion** einen Lifecycle-Run an: neuer Trigger `unblock` (`{run.trigger}`), ohne
   Worker, ohne Workspace, nur die Kette `on_retry_unblock`. Er
   - hält das Lock für `(Workflow, Item)`, bis die Kette fertig ist (kein paralleler automatischer Start). Läuft für
     `(Workflow, Item)` gerade ein Run (z. B. ein manueller Start trotz Block), wird das Aufheben mit nicht leerem
     `on_retry_unblock` mit 409 und klarer Meldung abgelehnt; mit leerem Hook bleibt es wie heute erlaubt,
   - zählt nicht als technischer Fehler und setzt den Zähler nicht zurück (das Aufheben startet ohnehin eine neue
     Zählperiode),
   - erscheint in UI/API wie jeder Run (Journal, Retry/Skip einzelner Actions, Recovery nach Neustart),
   - bekommt den Endstatus `completed` + `success`, wenn alle Actions gelangen, sonst `completed` + `failure`; ein
     endgültiges Scheitern löst wie bisher `lifecycle_action_failed` aus. Der Block bleibt in jedem Fall aufgehoben.
   - Snapshot: die zum Zeitpunkt des Aufhebens geladene Workflow-Konfiguration.
   Ist `on_retry_unblock` leer, verhält sich das Aufheben wie heute (kein Run).
3. **Retention:** Lifecycle-Runs fallen unter die normalen Regeln (`retention.successful_runs`/`failed_runs`).
4. **Workflows ohne Item** (Blocks im Workflow-Scope, z. B. Cron): nur `shell` erlaubt; `source.*` ist ein
   Konfigurationsfehler wie in den übrigen Hooks.
5. **Benachrichtigungen:** `retry_block_created` bleibt unverändert. Neu, optional: `retry_block_cleared` (nicht in den
   Defaults von `notifications.on`, damit bestehende Konfigurationen nicht mehr Meldungen bekommen).

## Platzhalter

Neue Gruppe `block.*`, nur in `on_retry_block` und `on_retry_unblock` erlaubt (sonst Konfigurationsfehler):

| Platzhalter | Wert | Fehlt, wenn … |
|---|---|---|
| `{block.id}` | ID des Retry-Blocks | – |
| `{block.failures}` | Anzahl der gezählten technischen Fehler | – |
| `{block.created_at}` | ISO-8601 (UTC) | – |
| `{block.last_status}` | technischer Endstatus des auslösenden Runs (`crashed`, `start_error`, `timed_out`) | – |
| `{block.cleared_at}` | ISO-8601 (UTC) | in `on_retry_block` |
| `{block.cleared_by}` | angemeldeter Benutzer (WI-26) bzw. `cli`/`api` | in `on_retry_block`; `auth.mode: none` → `anonymous` |

In `on_retry_block` gelten zusätzlich alle Platzhalter der übrigen Hooks (`run.*`, `result.*`, `item.*`, …) des
auslösenden Runs. In `on_retry_unblock` gelten `workflow.*`, `run.*` (des Lifecycle-Runs), `source.*`/`item.*`
(Item frisch gelesen; nicht lesbar → Actions mit `source.*` scheitern regulär), `parameters.*` nicht (leer),
`result.*`/`workspace.path` nicht (Konfigurationsfehler bzw. leer – Coder entscheidet konsistent mit §5.2 und
dokumentiert es).

## DB und API

- DB-Schema v5 (Migration mit Backup wie bei v3/v4): Run-Trigger `unblock`, Verweis Lifecycle-Run ↔ Block
  (z. B. `blocks.cleared_run_id`), Kennzeichen am Run, dass `on_retry_block` angehängt ist. Ein Downgrade ist wie
  bisher nicht vorgesehen.
- `POST /api/v1/blocks/:id/clear`: Antwort enthält `runId` des Lifecycle-Runs (oder `null`).
- `GET /api/v1/runs…`: `trigger: "unblock"`; Block-Endpunkte zeigen `clearedBy`, `clearedAt`, `clearedRunId`.
- UI: Lifecycle-Run in Listen erkennbar (Trigger „unblock“); nach „Remove Block“ Link auf den Run.

## Doku

`docs/configuration-reference.md` (§3.4.10 Hooks, §5 Platzhalter, §6.4), `docs/api.md`, `docs/spec-v0.1.md`
(Nachtrag WI-30, Kopf „Umgesetzt bis Version 0.6.0“), `CHANGELOG.md` (0.6.0, Unreleased bis zum Release),
`docs/status.md`, README (EN/DE) und Website-Feature-Liste kurz, `examples/config` (ein Workflow mit beiden Hooks),
`init`-Vorlage auskommentiert, `docs/handoff/WI-30.md`. **Keine lokalen Pfade, keine privaten Projektnamen** in
committeter Doku.

## Acceptance Criteria

- [ ] Schema/Validierung: beide Hooks optional, Actions wie übrige Hooks, `block.*` nur dort, `source.*` in
      Workflows ohne Item abgelehnt, IDs workflowweit eindeutig.
- [ ] Entstehen: `on_retry_block` läuft nach dem Abschluss-Hook im selben Run, auch wenn dieser scheitert, auch bei
      `start_error` ohne Hooks; nicht, wenn kein Block entsteht; Recovery nach Neustart mitten in der Kette.
- [ ] Aufheben: Lifecycle-Run mit Trigger `unblock`, hält das Lock, kein automatischer Start während der Kette,
      Zähler unverändert, Block auch bei Fehlschlag aufgehoben, `lifecycle_action_failed`, Recovery nach Neustart;
      leerer Hook → kein Run; laufender Run → 409.
- [ ] Platzhalter `block.*` korrekt gerendert, inkl. `cleared_by` mit Anmeldung (WI-26) und ohne.
- [ ] Migration v4 → v5 mit Backup; bestehende Blocks bleiben gültig.
- [ ] API/UI wie oben; `retry_block_cleared` abonnierbar.
- [ ] End-to-end gegen Fake-GitHub: 3 Crashes → Label `agent-blocked` gesetzt → Remove Block → Label zurück, Run
      sichtbar.
- [ ] `examples/config` und `init` validieren; Doku-Test grün; `npm run check` und `npm run test:pack` grün.
