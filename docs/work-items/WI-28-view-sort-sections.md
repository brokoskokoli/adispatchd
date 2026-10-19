# WI-28 – Views: Sortierung nach eigener Wertereihenfolge, mehrere Sortierschlüssel, Abschnitte

**Herkunft:** Feature-Anfrage des Maintainers (20. Oktober 2026) · **Abhängig von:** `main` (0.4.0) · **Branch:** `wi-28-view-sort-sections` · **Zielversion:** 0.5.0

## Teil A – Sortierung nach Wertereihenfolge (Anfrage wie eingereicht, mit Präzisierungen)

**Problem:** Views sortieren nach genau einem Feld auf- oder absteigend. Für Felder mit festen Werten (vor allem `project.<Name>` der Art `single_select`, aber auch `state`, `run.last_status`, `issue_type`) ist alphabetisch selten die gewünschte Reihenfolge, z. B. Pipeline-Stufen `open → ready_for_coding → coding → ready_for_review → review → merging`. Innerhalb einer Stufe will man eine zweite Ordnung (z. B. älteste zuerst).

```yaml
# views/pipeline-board.yaml
sort:
  - field: project.Status
    order: [open, ready_for_coding, coding, ready_for_review, review, merging]
  - field: created_at
    direction: asc
```

- `sort` darf weiterhin ein einzelnes Objekt sein (abwärtskompatibel) **oder** eine Liste von 1–5 Sortierschlüsseln; der erste entscheidet, bei Gleichstand der nächste, zum Schluss wie bisher der Item-Schlüssel (natürliche Sortierung).
- Neu je Schlüssel: `order` (Liste von Werten). Mit `order` wird nach der Position des Werts in der Liste sortiert; `direction` kehrt diese Reihenfolge um (Default `asc`).
- Nicht gelistete Werte kommen **nach** allen gelisteten, untereinander alphabetisch; leere/unbekannte Werte (`null`, unknown) ganz zuletzt – auch bei `direction: desc`.
- `order` nur für Felder vom Typ `string` (inkl. `project.*` der Arten `single_select`, `text`, `iteration`); sonst Validierungsfehler mit Hinweis. Vergleich mit Groß-/Kleinschreibung (`string[]`-Felder wie `labels` sind für `order` nicht erlaubt).
- Validierung: `order` nicht leer, Werte eindeutig, höchstens 100 Einträge; `sort` als Liste mit 1–5 Schlüsseln; jedes `field` wie bisher geprüft (Feldkatalog, `project.*` in allen Sources gleich deklariert, kein `object[]`).
- `single_select`-Projektfelder: Werte in `order`, die das Projekt laut Metadaten nicht als Option kennt, ergeben eine **Warnung im View-Ergebnis** (`warnings`), keinen Fehler. (Beim Offline-Laden sind die Metadaten nicht bekannt – dort keine Prüfung.)
- UI: Sortierung wie bisher (kein Umsortieren per Klick nötig; Spaltenklick im Browser bleibt wie heute möglich, „Standard“ stellt die konfigurierte Sortierung wieder her). Nice to have: Gruppenzeile je Wert des ersten Schlüssels, wenn `order` gesetzt ist (`group_by_first: true`).
- API: `GET /api/v1/views/:id` liefert `sort` immer als Liste.

## Teil B – Abschnitte (mehrere Teil-Views mit Überschriften)

**Wunsch:** In einer View mehrere Bereiche untereinander, jeder mit eigener Überschrift – z. B. „Wartet auf Review“, „In Arbeit“, „Blockiert“.

```yaml
# views/pipeline.yaml
id: pipeline
title: Pipeline
sources: [repo_a, repo_b, repo_c]
filter: open-issues                # gilt für alle Abschnitte (optional)
fields: [ … ]                      # Default-Spalten für alle Abschnitte
sort: [ … ]                        # Default-Sortierung
exclusive: true                    # Default true: ein Item erscheint nur im ersten passenden Abschnitt
sections:
  - title: Braucht Maintainer
    filter: { field: labels, operator: contains, value: needs-maintainer }
  - title: Review
    filter: { field: project.Status, operator: in, value: [ready_for_review, review] }
    sort: { field: updated_at, direction: desc }      # überschreibt die Default-Sortierung
  - title: Coding
    filter: { field: project.Status, operator: in, value: [ready_for_coding, coding] }
    fields: [ … ]                                       # überschreibt die Spalten (optional)
  - title: Übrige
    rest: true                     # alle Items der View, die in keinem anderen Abschnitt stehen
hide_empty_sections: false
```

- Abschnittsfilter wird mit dem View-Filter per `all` kombiniert; benannte Filter (`filter: <id>`, `{ use: … }`) funktionieren wie überall; Feldprüfung mit dem View-Kontext (inkl. `run.last_*`); `state`-Regel: der View-Filter bestimmt die Abfrage, `state` in Abschnittsfiltern nur lokal (Hinweis/Validierung wie bei `item_priority`, d. h. keine Pushdown-Wirkung – dokumentieren; bei `state` im Abschnitt, das über die View-Abfrage hinausgeht, Validierungsfehler mit Erklärung).
- Die Sources werden **einmal** gelesen (gemeinsamer Cache), Abschnitte filtern lokal.
- `exclusive: true`: Reihenfolge der Abschnitte entscheidet; `false`: ein Item kann in mehreren Abschnitten stehen. Höchstens ein `rest: true`-Abschnitt (nur sinnvoll mit `exclusive`; mit `exclusive: false` = Items, die in keinem anderen Abschnitt stehen).
- Validierung: 1–20 Abschnitte, `title` 1–80 Zeichen, eindeutige Titel, Abschnitt hat genau `filter` oder `rest: true`, `sort`/`fields` je Abschnitt wie auf View-Ebene.
- Zählung je Abschnitt (Anzahl Zeilen, `filterUnknown` je Abschnitt).
- Ohne `sections` verhält sich die View exakt wie bisher.
- API: View-Ergebnis enthält bei Abschnitten `sections: [{ title, rows, counts, sort, fields }]`; ohne Abschnitte unverändertes Format.
- UI: Überschrift je Abschnitt mit Zeilenzahl, eigene Tabelle; leere Abschnitte mit „keine Einträge“ (oder ausgeblendet mit `hide_empty_sections`); Sprungmarken oben bei mehr als 3 Abschnitten (nice to have).

## Allgemein
- Doku: Konfigurationsreferenz §3.5 (Views) mit Beispielen und Fehlern, §8, Checkliste; `docs/api.md`; Spec-Nachtrag §17; README EN/DE Feature-Liste kurz; Website-Feature-Liste (EN/DE) kurz; `examples/config/views/` (ein Pipeline-Beispiel mit `order` und `sections`, das validiert); `CHANGELOG.md` `## [0.5.0] – unveröffentlicht`; `docs/handoff/WI-28.md`.
- Version nicht erhöhen (Release-Schritt).

## Akzeptanzkriterien
- [ ] Alle Punkte aus Teil A (Reihenfolge, `desc`, mehrere Schlüssel, Abwärtskompatibilität, Validierungsfehler mit Pfad, Warnung für unbekannte Optionen).
- [ ] Teil B: Abschnitte mit `exclusive` true/false, `rest`, eigene Sortierung/Spalten, gemeinsamer Source-Abruf (ein Listing pro Source), Zählungen, Validierung, unveränderte Views ohne Abschnitte.
- [ ] UI-Tests und ein Screenshot einer View mit Abschnitten und Wertereihenfolge.
- [ ] Doku-Test grün; `npm run check` und `npm run test:pack` grün.
