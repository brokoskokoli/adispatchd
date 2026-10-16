# Manuelle Integrationstests gegen echtes GitHub (WI-06, Spec §22.1, §24.1)

Automatisierte Tests laufen ausschließlich gegen `FakeGitHub`. Diese Anleitung prüft die Annahmen
gegen die echte API. Ergebnis je Schritt (Datum, API-Version, Beobachtung) unten im Protokoll festhalten.

## Annahmen, die zu verifizieren sind

| # | Annahme (im Code umgesetzt) | Stelle |
|---|---|---|
| A1 | `X-GitHub-Api-Version: 2026-03-10` (laut offizieller Doku aktuell) wird akzeptiert und enthält die Dependencies-API. | `GITHUB_API_VERSION` in `src/sources/github/http.ts` |
| A2 | `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` liefert ein Array von Issue-Objekten mit `state` (`open`/`closed`) und `repository`/`repository_url`; paginiert über `Link` (`per_page` ≤ 100). Laut Doku Statuscodes 200/301/404/410. | `resolveDependencies` in `adapter.ts` |
| A3 | Cross-Repo-Blocker erscheinen in der Liste, **sofern** die App Zugriff auf das Blocker-Repo hat. | dito |
| A4 | Blocker in Repos ohne App-Zugriff werden **weggelassen** (oder führen zu 403/404). Das (frisch gelesene) Issue-Objekt enthält `issue_dependencies_summary.total_blocked_by` inkl. unsichtbarer Blocker; ist dieser Wert größer als die sichtbare Liste oder fehlt das Summary → `dependencies.status = unknown` (fail-closed). | `resolveDependencies` |
| A5 | `issue_dependencies_summary.blocked_by` = Anzahl **offener** Blocker, `total_blocked_by` = alle (Doku nennt nur die Typen). Genutzt wird nur `total_blocked_by`. | dito |
| A6 | Fehlende Rechte am Dependencies-Endpunkt → 403 (`Resource not accessible by integration`) oder 404. Beides → `unknown`. | dito |
| A7 | Benötigte App-Rechte: *Issues: read* (Lesen inkl. Dependencies), *Issues: write* (Labels/Kommentare an Issues), *Pull requests: write* (Labels/Kommentare an PRs über die Issues-API), *Metadata: read*. Die Doku der Dependencies-Endpunkte nennt keine Rechte. | – |
| A8 | Primäres Rate-Limit: 403/429 mit `x-ratelimit-remaining: 0` + `x-ratelimit-reset`; sekundäres: 403/429 mit `retry-after` bzw. Meldung „rate limit“. | `GitHubHttpClient.toError` |
| A9 | Installation-Tokens laufen nach 1 h ab (`expires_at`); JWT mit `iat = now-60 s`, `exp = now+9 min`, `iss = App-ID` wird akzeptiert. | `src/identities/` |
| A11 | Von einer App per Installation-Token erstellte Issue-Kommentare tragen `performed_via_github_app.id = <App-ID>` und `user.type = "Bot"`. Sonst findet `findCommentByMarker` eigene Kommentare nicht (Folge: Duplikat statt Unterdrückung). | `authorPredicate` |
| A10 | Transferierte Issues leiten per 301 auf das neue Repo um; `repository_url` passt dann nicht → `getItem` liefert `null`. | `fetchIssue` |

## Vorbereitung

1. Zwei Test-Repos anlegen, z. B. `<org>/orch-test-a` und `<org>/orch-test-b`, plus ein drittes privates
   Repo `<org>/orch-test-hidden`, auf das die App **keinen** Zugriff bekommt.
2. GitHub App anlegen (Rechte siehe A7), auf `orch-test-a` und `orch-test-b` installieren. App-ID und
   Installation-ID notieren, Private Key herunterladen.
3. Key als Env-Variable bereitstellen (beide Formen testen):
   ```bash
   export GITHUB_TEST_PRIVATE_KEY="$(cat app.private-key.pem)"
   # bzw. einzeilig mit \n-Escapes:
   export GITHUB_TEST_PRIVATE_KEY="$(awk 'BEGIN{ORS="\\n"}1' app.private-key.pem)"
   ```
4. Kleines Skript `scratch.ts` im Repo-Root (nicht einchecken), ausführen mit `npx tsx scratch.ts`:
   ```ts
   import { ConsoleLogger, SecretRedactor, systemClock } from './src/core/index.js';
   import { GitHubAppCredentialProvider } from './src/identities/index.js';
   import { githubSourceFactory } from './src/sources/index.js';

   const redactor = new SecretRedactor();
   const logger = new ConsoleLogger({ level: 'debug', redact: redactor.asRedactor });
   const credentials = new GitHubAppCredentialProvider(
     { test: { appId: process.env.APP_ID!, installationId: process.env.INSTALLATION_ID!, privateKeyEnv: 'GITHUB_TEST_PRIVATE_KEY' } },
     { clock: systemClock, logger, redactor },
   );
   const a = githubSourceFactory.create(
     'test_a',
     { owner: '<org>', repository: 'orch-test-a', identity: 'test' },
     { credentials, logger, clock: systemClock },
   );
   // ... Aufrufe aus den Testfällen unten
   ```

## Testfälle

1. **Auth/Token-Cache:** `credentials.getToken('test')` zweimal → gleicher Token. `credentials.invalidate('test')`
   → neuer Token. Log enthält `Obtained GitHub installation token` ohne Token-/Key-Inhalt.
2. **Kandidaten:** In `orch-test-a` Issue #1 (Label `ready-for-coding`), PR #2, geschlossenes Issue #3 anlegen.
   `a.listCandidates({ filter: { field: 'labels', operator: 'contains', value: 'ready-for-coding' } })` → nur #1;
   `a.listCandidates()` → #1 und #2 (`type: pull_request`).
3. **Cross-Repo-Dependency (Szenario 3):** In `orch-test-b` Issue #1 anlegen, in der GitHub-UI bei
   `orch-test-a#1` „Mark as blocked by“ `orch-test-b#1`.
   `a.resolveFields(item, ['dependencies.blocked_by_total', 'dependencies.blocked_by_open', 'dependencies.blocked', 'dependencies.status'])`
   → `1 / 1 / true / ok`. Blocker schließen → `1 / 0 / false / ok`. Rohantwort (`curl` mit Token) für A2/A5 sichern.
4. **Fehlender Zugriff (fail-closed):** Zusätzlich `orch-test-hidden#1` als Blocker eintragen (mit einem
   Account, der beide Repos sieht). Erwartung: `dependencies.status = unknown`, übrige Felder `known: false` (A4).
   Rohantwort von `blocked_by` und `issue_dependencies_summary` dokumentieren. Liefert GitHub stattdessen
   403/404, ist das Ergebnis ebenfalls `unknown` – Beobachtung notieren.
5. **Recht entziehen:** App-Recht *Issues* auf „No access“ setzen (oder App vom Repo entfernen) → `unknown`
   (A6), nie `0`.
6. **Labels:** Vorher manuell Label `manual` setzen, dann
   `a.applyUpdate(item, { labels: { add: ['coding'], remove: ['ready-for-coding'] } }, 'test')`.
   Erwartung: `manual` bleibt; zweiter Aufruf → `{ changed: false }`. Label mit Leerzeichen/Slash
   (`prio: high/urgent`) entfernen → funktioniert (URL-Encoding).
7. **Kommentar + Marker:** `a.postComment(item, 'Hallo', 'orch:run-test:a1', 'test')` → Kommentar ohne sichtbaren
   Marker (HTML-Kommentar), Autor ist der App-Bot. `a.findCommentByMarker(item, 'orch:run-test:a1', 'test')` →
   gleiche ID; Rohantwort von `GET …/comments` auf `performed_via_github_app` prüfen (A11). Denselben Marker als
   normaler Nutzer posten → wird nicht gefunden. Auf einem PR wiederholen: Kommentar landet in der Konversation, nicht als Review.
8. **Rate-Limit-Header:** `curl -sI -H "Authorization: Bearer <token>" https://api.github.com/rate_limit`
   → Header `x-ratelimit-*` prüfen (A8).
9. **Redaction:** Gesamte Konsolenausgabe nach `ghs_`, `eyJ` und `PRIVATE KEY` durchsuchen → keine Treffer.

## Protokoll

| Datum | API-Version | Fall | Ergebnis / Beobachtung |
|---|---|---|---|
| | | | |
