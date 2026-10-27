# WI-34 – Item-Verlauf aus den Run-Widgets des Dashboards

**Herkunft:** Wunsch des Maintainers (27. Oktober 2026) · **Abhängig von:** `main` (0.9.0) · **Branch:** `wi-34-dashboard-run-history-links` · **Zielversion:** 0.9.1

## Problem

WI-33 verlinkt den Item-Verlauf aus Run-Liste, Run-Detail, Item-Panel, Blocked-Seite und Views (Feld `history`),
aber nicht aus den Dashboard-Widgets `active_runs` und `recent_runs`: `active_runs` verlinkt das Item nur extern
(GitHub), `recent_runs` zeigt gar kein Item. Gerade dort sieht man Runs zuerst.

## Umfang

- `active_runs`: in der Spalte „Item“ hinter dem externen Link ein Link „history“ auf `#/items/<source>/<id>`, wie
  in der Run-Liste (`historyLinkForKey(r.sourceItemKey, 'history')`); nur bei Runs mit Item.
- `recent_runs`: neue Spalte „Item“ nach „Workflow“ mit demselben Inhalt wie in `active_runs` (externer Link bzw.
  Item-Schlüssel, dahinter „history“); ohne Item der Trigger bzw. leer wie in `active_runs`.
- Keine API-Änderung (`sourceItemKey`/`sourceUrl` stehen schon in `RunSummary`).

## Doku

CHANGELOG (Unreleased → 0.9.1), Referenz §3.7.1 (Widget-Tabelle: Inhalt von `active_runs`/`recent_runs`),
`docs/status.md`, `docs/handoff/WI-34.md`.

## Acceptance Criteria

- [ ] `active_runs` zeigt bei Runs mit Item den Link „history“ auf den Item-Verlauf, der externe Link bleibt.
- [ ] `recent_runs` hat die Spalte „Item“ mit externem Link und „history“; Runs ohne Item bleiben lesbar.
- [ ] Beides auch in Reitern und mit `workflows`/`limit`; Rollen unverändert (Verlauf ab `viewer`).
- [ ] Im Browser geprüft (eigene Instanz, hell/dunkel, schmal); `npm run check` grün.
