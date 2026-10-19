# WI-14 – Filter auf GitHub-Projects-Felder und weitere Issue-Felder

**Herkunft:** Wunsch des Maintainers (19. Oktober 2026): auf den Status von GitHub, auf Priorität und auf eigene Felder
aus GitHub Projects filtern können, auch mit „Wert A oder Wert B“ · **Abhängig von:** `main` (0.1.0) · **Branch:** `wi-14-project-fields` · **Zielversion:** 0.2.0

## Umfang und Entscheidungen

1. **Neue billige Issue-Felder (REST, schon in der Listenabfrage enthalten):**
   - `state_reason` (string, `null` wenn nicht gesetzt): `completed` | `not_planned` | `reopened` | `duplicate` …, wie GitHub es liefert.
   - `milestone` (string, `null` ohne Milestone): Titel des Milestones.
   - `issue_type` (string, `null` ohne Typ): Name des Issue-Typs (`type.name`, z. B. `Bug`, `Feature`, `Task`; nur bei Orgs mit Issue-Typen).
   - Alle mit den String-Operatoren (`equals`, `not_equals`, `contains`, `in`); kein Pushdown. `state` bleibt wie bisher.

2. **GitHub Projects (v2) je Source in `sources.yaml`:**
   ```yaml
   sources:
     project_a:
       type: github
       owner: my-org
       repository: my-repo
       identity: reader
       project:              # optional
         owner: my-org       # User- oder Org-Login des Projekts; Default = owner der Source
         number: 3           # Projektnummer aus der URL …/projects/3
         fields:             # Felder, auf die gefiltert/sortiert werden soll, mit Art
           Status: single_select
           Priority: single_select
           Estimate: number
           Due: date
           Sprint: iteration
           Notes: text
   ```
   - Erlaubte Arten: `single_select`, `text`, `iteration` → Feldtyp `string` (bei `single_select` der Optionsname, bei `iteration` der Iterationstitel); `number` → `number`; `date` → `date`.
   - Jedes deklarierte Feld wird im Filter, in `item_priority`, in View-`fields`/`sort`/`link` als **`project.<Name>`** angesprochen (z. B. `project.Status`, `project.Priority`). Der Name ist der Schlüssel aus `fields` (Groß-/Kleinschreibung wie geschrieben); beim Abgleich mit GitHub wird der Projektfeldname ohne Beachtung der Groß-/Kleinschreibung verglichen.
   - Feldkatalog wird **je Source** erweitert: die Offline-Validierung (`config validate`, Laden) kennt `project.*` genau dann, wenn die Source sie deklariert. Workflow-Kontext: die Trigger-Source; View-Kontext: nur Felder, die **alle** Sources der View deklarieren (gleiche Art); sonst Fehler mit Hinweis. Tippfehler bekommen „did you mean …“.
   - Schlüssel-Validierung in `fields`: nicht leer, keine führenden/abschließenden Leerzeichen, keine Steuerzeichen; mindestens ein Feld; `number` positive Ganzzahl.
   - Werte vergleichen mit Groß-/Kleinschreibung (wie alle Strings außer `labels`). „Oder“ = Operator `in` (`project.Status in ["Todo", "Ready"]`) oder `any`.

3. **Abfrage (GraphQL, billig, im selben Planungsschritt):**
   - Endpoint: `apiBaseUrl` `https://api.github.com` → `https://api.github.com/graphql`; endet die Basis auf `/api/v3` (GHES) → `…/api/graphql`.
   - In `listCandidates` (nur wenn `project` konfiguriert): nach der REST-Liste
     a) **Metadaten** einmal pro Listing: `repositoryOwner(login:$owner){ ... on User { projectV2(number:$n){ id title fields(first:100){ nodes { ... on ProjectV2FieldCommon { name dataType } } } } } ... on Organization { gleiches } }`. Projekt nicht gefunden/kein Zugriff → alle `project.*` unknown mit Grund. Deklariertes Feld fehlt im Projekt oder `dataType` passt nicht zur Art (SINGLE_SELECT/TEXT/NUMBER/DATE/ITERATION) → genau dieses Feld unknown mit Grund, Warnung im Log (nicht bei jedem Poll spammen: nur bei Änderung des Grundes je Feld).
     b) **Werte** über `nodes(ids:[…])` mit der `node_id` aus dem REST-JSON, in Blöcken zu höchstens 50 IDs: für `Issue` und `PullRequest` jeweils `projectItems(first:20, includeArchived:false){ totalCount nodes { project { id } fN: fieldValueByName(name:$fN){ __typename ... on ProjectV2ItemFieldSingleSelectValue{name} ... on ProjectV2ItemFieldTextValue{text} ... on ProjectV2ItemFieldNumberValue{number} ... on ProjectV2ItemFieldDateValue{date} ... on ProjectV2ItemFieldIterationValue{title} } } }`. Feldnamen **nur als GraphQL-Variablen** (`$f0`, `$f1` …), nie in den Query-String interpolieren (Injection). Aliasse sind generiert (`f0`, `f1`).
   - Ergebnis je Item: Projekt-Item mit passender `project.id` gefunden → Werte (`null`, wenn das Feld leer ist); Item nicht im Projekt (und `totalCount <= 20`) → alle `project.*` = `null` (bekannt leer); `totalCount > 20` ohne Treffer → unknown („item belongs to more than 20 projects“).
   - Fehler (HTTP, GraphQL-`errors` ohne verwertbare `data`, Rate-Limit) → `project.*` unknown mit Grund; das Listing selbst scheitert **nicht** (fail closed nur für diese Felder). Abbruch über `signal` wird weitergereicht.
   - `getItem` (frisches Re-Read vor `on_start`) liest die Projektwerte für dieses eine Item genauso (Metadaten dürfen bis zu 5 Minuten gecacht werden, Zeit über `deps.clock`).
   - Werte landen in `item.fields` (damit Snapshot, Platzhalter, Views und `verifyItemFor` sie sehen). Für unbekannte Felder bekommt `SourceItem` ein optionales `unknownFields?: Record<string, string>` (Feld → Grund); `createItemFieldSource` liefert dann `{known:false, reason}` mit diesem Grund statt „not provided by source“. Prüfen, ob `SourceItem` irgendwo per Schema serialisiert/validiert wird, und dort mitziehen.
   - `project.*` ist **nicht** `expensive` und hat keinen Pushdown.
   - GitHub-HTTP-Client: GraphQL als `POST` mit JSON-Body (`{query, variables}`); als idempotent behandeln (reine Lesequery), Retry/Rate-Limit-Logik wiederverwenden. Prüfen, dass die Rate-Limit-Behandlung auch für GraphQL-Antworten greift (GraphQL meldet Limits teils mit 200 + `errors[].type == "RATE_LIMITED"` → als transient/rate limit behandeln).

4. **Zugriffsrechte und neue Identity-Art `github_token`:**
   - GitHub-App-Installationstoken können **org-eigene** Projekte lesen (App-Berechtigung „Organization → Projects: Read“). **User-eigene** Projekte sind für GitHub-App-Installationstoken nicht zugänglich. Damit das trotzdem geht, kommt eine zweite Identity-Art dazu:
     ```yaml
     identities:
       project_reader:
         type: github_token
         token_env: ADISPATCH_GITHUB_TOKEN   # Name der Env-Variable, nie der Token selbst
     ```
   - Provider: liest den Token aus der Env-Variable (wie `private_key_env`), registriert ihn beim Redactor, `expiresAt` weit in der Zukunft, `invalidate` ist ein No-op bzw. liest neu, `describe` ohne `appId` (Marker-Kommentare von PAT-Identitäten: die bestehende Regel „Bot-Autor nötig“ würde nie greifen → dokumentieren, dass `source.comment`-Idempotenz mit `github_token` auf den Autor-Login der Identität prüft: beim ersten Gebrauch `GET /user` → Login cachen, Kommentar zählt, wenn `user.login` gleich ist). Fehlende/leere Env-Variable → klarer Fehler beim Start (wie beim Private Key).
   - `project.identity` (optional, Default = `identity` der Source): mit welcher Identity die Projektwerte gelesen werden. So kann die Source per App lesen und das Projekt per Token.
   - Validierung: `project.identity` muss existieren.
   - Ein Composite-Credential-Provider (je Identity-Art) wird in `src/app.ts` verdrahtet.

5. **Planner/Views/Dry-Run:** Laufen über `adapter.fieldDefinitions()` (jetzt instanzabhängig) und `createItemFieldSource`. `workflow dry-run` zeigt die Werte bzw. den Unknown-Grund der `project.*`-Felder. Die View-API/UI zeigt `project.*`-Spalten wie andere Felder.

6. **Init-Templates und Beispiele:** `examples/config` bekommt ein auskommentiertes oder echtes `project`-Beispiel nur, wenn es weiter validiert; das von `init` erzeugte `sources.yaml` enthält einen auskommentierten `project`-Block. Ein Workflow-Beispiel mit `project.Status in [...]`.

7. **Dokumentation:**
   - `docs/configuration-reference.md`: `sources.yaml` (`project`, Arten, Rechte), `identities.yaml` (`github_token`), §4.7 Feldkatalog (neue Felder + `project.*`-Abschnitt mit Unknown-Regeln), neues Beispiel in §7 (z. B. „7.7 Filter auf Projektstatus und Priorität“), §8 neue Validierungsfehler, §9 Checkliste. Doku-Test (`src/config/reference-doc.test.ts`) grün halten/erweitern.
   - `docs/spec-v0.1.md` bzw. die Spec: knapper Nachtrag (Feldkatalog, Identity-Art), README-Feature-Liste, `docs/operations.md` (Token-Env-Variable in `/etc/default/adispatchd`), `docs/manual-tests/github.md` (Live-Test für Projektfelder org- und user-eigen), `docs/handoff/WI-14.md`, `docs/status.md`.

8. **Version 0.2.0:** `package.json`, `package-lock.json`, `APP_VERSION`; README/Doku-Installationszeilen `adispatchd@0.1.0` → `@0.2.0`; ein `CHANGELOG.md` mit Einträgen 0.1.0 und 0.2.0 anlegen. **Nicht** publizieren oder pushen – das macht die Hauptsitzung.

## Acceptance Criteria
- [ ] Unit-Tests für: Schema/Normalisierung `project` und `github_token`; Feldkatalog je Source (Workflow, View mit mehreren Sources, Tippfehler-Vorschlag, falscher Werttyp, `project.*` ohne Deklaration → Fehler); Adapter mit gefälschtem `fetch` (Werte aller fünf Arten, Item nicht im Projekt → `null`, Projekt fehlt/kein Zugriff → unknown mit Grund, Feld fehlt im Projekt, Arten-Mismatch, GraphQL-Fehler und Rate-Limit, >50 Items → mehrere Blöcke, Variablen statt Interpolation, GHES-Endpoint); Filter-Auswertung `project.Status in [...]` true/false/unknown; `getItem`; Token-Provider (Env fehlt, Redaction, Login-Abgleich für Marker).
- [ ] Ein E2E- oder Integrationstest: Workflow mit `project.Status equals "Ready"` startet nur das passende Item.
- [ ] `examples/config`, `init`-Konfiguration und GitHub-Testfixture validieren.
- [ ] Doku wie oben aktualisiert; Doku-Test grün.
- [ ] `npm run check` und `npm run test:pack` grün.
