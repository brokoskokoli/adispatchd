# WI-21 – Verknüpfte Branches und PRs als Item-Felder (GitHub)

**Herkunft:** Wunschliste aus dem ersten Praxiseinsatz (19. Oktober 2026), Feature F7 · **Abhängig von:** `main` (nach WI-16) · **Branch:** `wi-21-linked-branches` · **Zielversion:** 0.3.0 · Gemeinsame Anforderungen siehe WI-17.

**Problem:** Den Arbeits-Branch eines Issues oder den PR, der es schließt, muss heute jeder Worker selbst per GraphQL ermitteln. GitHub zeigt je nach Zustand den verlinkten Branch („Development“) oder den PR – das ist fehleranfällig.

**Neue Felder** (GitHub-Adapter; **teuer**, nur geladen, wenn verwendet; eine GraphQL-Abfrage pro Item für alle vier):

| Feld | Typ | Inhalt |
|---|---|---|
| `linked_branches` | string[] | Namen der unter „Development“ verlinkten Branches im selben Repo (`Issue.linkedBranches { ref { name repository { nameWithOwner } } }`) |
| `closing_prs` | object[] | PRs, die das Issue schließen (`closedByPullRequestsReferences(includeClosedPrs: true)`): `{ number, state, head_ref, is_draft, url }` (`state` = `open`/`merged`/`closed`), sortiert: offene, dann gemergte, dann geschlossene, je nach Nummer aufsteigend |
| `work_branch` | string | abgeleitet: erster verlinkter Branch, sonst `head_ref` des ersten offenen, dann des ersten gemergten PRs aus `closing_prs`; sonst `null` |
| `work_pr` | number | abgeleitet: Nummer des ersten offenen PRs aus `closing_prs`, sonst `null` |

- `closing_prs` hat den neuen Feldtyp `object[]` ohne Filter-Operatoren (Validierungsfehler mit Hinweis auf `work_pr`), ist aber in Views (Darstellung z. B. „#12 open“, Link je PR) und in der Worker-Kontextdatei verfügbar.
- Für Pull-Request-Items: `linked_branches` = `[]`, `closing_prs` = `[]`, `work_branch` = eigener `head_ref`, `work_pr` = eigene Nummer, wenn offen, sonst `null`.
- Paging-Grenzen (z. B. `first: 20`) dokumentieren; mehr Treffer als gelesen → unknown.

**Verwendung:**
- Platzhalter `{item.work_branch}` und `{item.work_pr}` (Templates in `execute`, Actions). Weil die Felder teuer sind, muss der Run-Controller sie vor dem Rendern auflösen, wenn ein Template sie verwendet; unknown → Run endet als `start_error` mit Grund (bzw. Action-Fehler), nie leerer String.
- In Filtern, z. B. `{ field: work_pr, operator: not_equals, value: null }`; in Views als Spalte mit Link auf den PR.
- In der Kontextdatei des Workers (`item`), wenn verwendet oder immer – entscheiden und dokumentieren (Kosten beachten).

**Fehlerfall:** Kann die Abfrage nicht gelesen werden (HTTP/GraphQL-Fehler, Teilfehler, Rate-Limit), sind alle vier Felder unknown (fail closed) mit Grund, wie bei `project.*`. Rate-Limit-Pause aus WI-14 wiederverwenden.

**Akzeptanz:** Issue mit verlinktem Branch liefert diesen als `work_branch`; wird zusätzlich ein PR mit „Closes #n“ geöffnet, bleibt `work_branch` derselbe Name und `work_pr` ist gesetzt; nach dem Merge ist `work_pr` `null` und `work_branch` kommt aus dem gemergten PR (wenn der verlinkte Branch gelöscht ist).

## Acceptance Criteria
- [ ] Tests mit Fake-GitHub für alle Punkte, inkl. Teilfehler, PR-Items, Template-Auflösung im Run-Controller, `object[]`-Validierung.
- [ ] Live-Test in `docs/manual-tests/github.md`.
- [ ] Doku (Referenz Feldkatalog, §5 Platzhalter, Views, Beispiele, Fehler; Spec-Nachtrag; README; CHANGELOG 0.3.0); Doku-Test grün.
- [ ] `npm run check` und `npm run test:pack` grün.
