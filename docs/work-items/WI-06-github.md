# WI-06 – GitHub: App-Identitäten, Source-Adapter, Dependencies

**Spec:** §5.2, §5.3, §6, §10, §20 · **Abhängig von:** 01 · **Branch:** `wi-06-github` · **Verzeichnisse:** `src/identities/`, `src/sources/github/`

## Umfang
1. **GitHub-App-Credential-Provider** (`src/identities/`): JWT RS256 mit `node:crypto` (iat −60 s, exp ≤ 10 min), Private Key aus Env-Variable (`private_key_env`, PEM, auch mit `\n`-Escapes), Installation Token via `POST /app/installations/{id}/access_tokens`, Cache bis kurz vor Ablauf, parallele Anfragen deduplizieren. Implementiert `CredentialProvider`. Keys/Tokens nie loggen.
2. **HTTP-Client-Abstraktion** (injizierbares `fetch`), API-Version-Header `X-GitHub-Api-Version` gepinnt (Konstante), `Accept: application/vnd.github+json`, Rate-Limit-/Retry-After-Behandlung, Pagination über `Link`-Header, Fehlerklassen (Auth, NotFound, Forbidden, RateLimit, Transient).
3. **Source-Adapter `github`** (implementiert `SourceAdapter`):
   - `listCandidates`: Issues+PRs eines Repos (`state=open` Default), Pushdown von Label-`contains`/`state` in Query-Parameter, Rest lokal.
   - Felder (mit `FieldDefinition`): `number`, `title`, `state`, `labels` (string[]), `assignees`, `author`, `is_pull_request`, `created_at`, `updated_at`, `url`, `repository` (`owner/name`), `dependencies.blocked_by_total`, `dependencies.blocked_by_open`, `dependencies.blocked`, `dependencies.status` (`ok|unknown`). Dependencies sind **teure** Felder (lazy).
   - Dependencies über die native API `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` (cross-repo Einträge auswerten, Zustand der Blocker). 403/404/Fehler → Felder `known: false` → Filter ergibt `unknown` (fail-closed, §20.7). Kein Zugriff ≠ 0 offene Abhängigkeiten.
   - `getItem`, `parseItemRef` (URL `https://github.com/o/r/issues/123`, `/pull/123`, oder `123`), stabiler `key` `github:<owner>/<repo>#<n>`.
   - `applyUpdate({labels:{add,remove}})`: vorher Item neu lesen, nur fehlende Labels hinzufügen / vorhandene entfernen (idempotent, manuelle Änderungen erhalten), Label-Namen URL-encodieren.
   - `postComment(item, body, marker)`: Marker als HTML-Kommentar `<!-- orch:<run-id>:<action-id> -->` anhängen; `findCommentByMarker` durchsucht Kommentare (für Idempotenz vor Retry, §10). Kommentare sind Issue-/PR-Konversationskommentare, keine Reviews.
4. **Fake-GitHub** für Tests (`src/sources/github/testing/`): In-Memory-Server/fetch-Stub mit Issues, Labels, Kommentaren, Dependencies inkl. Cross-Repo und 403 – wird auch von WI-07/08/09/10 für E2E-Tests genutzt.
5. Doku `docs/manual-tests/github.md`: manuelle Integrationstests gegen echtes GitHub (§22.1, §24.1).

## Acceptance Criteria
- [ ] JWT korrekt signiert/verifizierbar (Test mit generiertem Testschlüssel); Token-Caching + Ablauf (FakeClock).
- [ ] Pagination und Rate-Limit-Handling getestet.
- [ ] Szenario 3: Issue blockiert durch offenes Issue in anderem Repo → `blocked_by_open=1`; nach Schließen 0 (Test gegen Fake).
- [ ] Fehlender Zugriff auf Dependencies → `unknown`, nicht 0 (Test).
- [ ] Label-Update idempotent und erhält manuell gesetzte fremde Labels (Test).
- [ ] Kommentar mit Marker; erneuter Versuch findet bestehenden Kommentar statt Duplikat (Test).
- [ ] Keine Tokens/Keys in Fehlermeldungen oder Logs (Test).
