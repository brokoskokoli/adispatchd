# WI-29 – Dashboard: kompakte Ressourcenanzeige oben, ausführliche Ansicht als eigener Reiter

**Herkunft:** Maintainer (20. Oktober 2026): Die große „Server“-Sektion unten im Dashboard ist zu wuchtig. · **Abhängig von:** `main` (0.4.0) · **Branch:** `wi-29-resources-tab` · **Zielversion:** 0.5.0

## Umfang
1. **Neuer Reiter „Resources“** in der Navigation (zwischen Dashboard und Runs oder am Ende vor „Configuration“ – passend zur bestehenden Reihenfolge), Route z. B. `#/resources`. Er enthält die bisherige Server-Sektion vollständig (CPU-Stapeldiagramm, Speicher, Platte, Legende, Zeitraumwahl, Werte-Tabelle).
2. **Dashboard:** die große Server-Sektion entfällt dort. Stattdessen **oben** (erste Zeile, vor bzw. neben den Scheduler-Karten) eine kompakte Kachel/Leiste:
   - CPU gesamt in % mit kleiner Sparkline (letzte ~15 min), RAM belegt/gesamt mit Balken, Platte (am stärksten belegter Pfad) mit Balken, optional Load.
   - Darunter höchstens eine Zeile „Top: busy 9 % · reviewer 8 % · python 12 %“ (eigene Runs zuerst).
   - Klick → Reiter „Resources“.
   - Höhe deutlich kleiner (ca. 1/6 der bisherigen Sektion), live per SSE `system.metrics`, keine eigenen schweren Abrufe (nutzt die bestehende API mit kleinem `points`).
   - `monitoring.enabled: false` → Kachel zeigt kurzen Hinweis bzw. entfällt.
3. Info-Kacheln (WI-24) bleiben im Dashboard; Reihenfolge: Ressourcen-Kompaktleiste, Info-Kacheln, Scheduler/Capacity/Attention, Runs.
4. Rollen (WI-26): Reiter und Kachel ab `viewer` sichtbar (wie die Metrics-API).
5. Doku: README EN/DE (Dashboard-Beschreibung), Website-Text falls die Server-Sektion beschrieben ist, Konfigurationsreferenz/operations nur falls dort UI-Orte genannt sind, `CHANGELOG.md` `## [0.5.0] – unveröffentlicht`, `docs/handoff/WI-29.md`. Version nicht erhöhen.

## Akzeptanzkriterien
- [ ] UI-Tests: Navigation/Route, kompakte Kachel (Werte, Sparkline-Daten, Top-Zeile), Hinweis bei deaktiviertem Monitoring, Lifecycle (SSE-Abo beim Verlassen beendet).
- [ ] Screenshots: Dashboard (hell, 1400 px) und Reiter Resources; Kachel auch bei 600 px ohne Überlauf.
- [ ] `npm run check` und `npm run test:pack` grün.
