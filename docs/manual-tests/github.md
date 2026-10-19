# Manuelle Integrationstests gegen echtes GitHub (Spec §22.1 „GitHub“, §22.2, §24.1)

Automatisierte Tests laufen nur gegen `FakeGitHub` (`src/sources/github/testing/`). Diese Anleitung prüft dieselben
Annahmen Schritt für Schritt gegen die echte GitHub-API, mit eigenen Test-Apps und Wegwerf-Repos. Sie ist so geschrieben,
dass die Befehle der Reihe nach kopiert werden können. Zeitbedarf: Einrichtung etwa 45 Minuten, Testfälle etwa 2 Stunden.
Der natürliche Token-Ablauf (T2b) braucht mindestens 60 Minuten Laufzeit am Stück. Die anderen Testfälle laufen in
dieser Zeit nebenher.

Inhalt:
[0 Annahmen und Doku-Stand](#0-annahmen-und-doku-stand) ·
[1 Voraussetzungen und Testaufbau](#1-voraussetzungen-und-testaufbau) ·
[2 Testkonfiguration](#2-testkonfiguration) ·
[3 Testdaten](#3-testdaten) ·
[4 Testfälle](#4-testfälle) ·
[5 Auswertung und Aufräumen](#5-auswertung-und-aufräumen)

---

## 0 Annahmen und Doku-Stand

### 0.1 Annahmen im Code (A1–A11)

| # | Annahme (im Code umgesetzt) | Stelle | Doku-Stand 2026-10-17 | Testfall |
|---|---|---|---|---|
| A1 | `X-GitHub-Api-Version: 2026-03-10` wird akzeptiert und enthält die Dependencies-API. | `GITHUB_API_VERSION` in `src/sources/github/http.ts` | **bestätigt**: neueste unterstützte Version ([R1](#r1)) | T1, T11 |
| A2 | `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` liefert ein Array von Issue-Objekten mit `state` und `repository_url`, paginiert über `Link` (`per_page` ≤ 100), Status 200/301/404/410. | `resolveDependencies` in `adapter.ts` | **bestätigt** ([R2](#r2)) | T11 |
| A3 | Cross-Repo-Blocker erscheinen in der Liste, **sofern** die App Zugriff auf das Blocker-Repo hat. | dito | nicht dokumentiert | T12 |
| A4 | Blocker in Repos ohne App-Zugriff fehlen in der Liste (oder führen zu 403/404). `issue_dependencies_summary.total_blocked_by` des frisch gelesenen Issues zählt sie mit. Ist der Wert größer als die sichtbare Liste oder fehlt das Summary → `dependencies.status = unknown` (fail-closed). | `resolveDependencies` | nicht dokumentiert ([R3](#r3), [R11](#r11)) | T13 |
| A5 | `issue_dependencies_summary.blocked_by` = Anzahl **offener** Blocker, `total_blocked_by` = alle. Genutzt wird nur `total_blocked_by`. | dito | Felder dokumentiert, Bedeutung **nicht** ([R3](#r3)) | T11, T14 |
| A6 | Fehlende Rechte am Dependencies-Endpunkt → 403 (`Resource not accessible by integration`) oder 404. Beides → `unknown`. | dito | Endpunkt verlangt *Issues: read* ([R2](#r2)) | T13, T19 |
| A7 | Benötigte App-Rechte: *Issues: read* (Lesen inkl. Dependencies), *Issues: write* (Labels/Kommentare an Issues), *Pull requests: write* (Labels/Kommentare an PRs über die Issues-API), *Metadata: read*. | Doku (`README.md`, `init`-Vorlage) | **teilweise anders**: Labels/Kommentare akzeptieren *Issues: write* **oder** *Pull requests: write*; die Dependencies-Endpunkte verlangen *Issues* read/write ([R4](#r4)) | T19 |
| A8 | Primäres Rate-Limit: 403/429 mit `x-ratelimit-remaining: 0` + `x-ratelimit-reset`. Sekundäres: 403/429 mit `retry-after` bzw. Meldung „rate limit“. | `GitHubHttpClient.toError` | **bestätigt** ([R8](#r8)) | T22 |
| A9 | Installation-Tokens laufen nach 1 h ab (`expires_at`). Ein JWT mit `iat = now-60 s`, `exp = now+9 min`, `iss = App-ID` wird akzeptiert. | `src/identities/` | **bestätigt**. Hinweis: GitHub *empfiehlt* inzwischen die Client-ID als `iss`, die App-ID bleibt zulässig ([R6](#r6)) | T1, T2 |
| A10 | Transferierte Issues leiten per 301 auf das neue Repo um. `repository_url` passt dann nicht → `getItem` liefert `null`. | `fetchIssue` | **bestätigt** (301, gelöscht 410, kein Zugriff 404) ([R9](#r9)) | T23 |
| A12 | GraphQL unter `POST https://api.github.com/graphql` akzeptiert Installation-Tokens und Tokens von `github_token`-Identities. `repositoryOwner(login:) { ... on User/Organization { projectV2(number:) { id fields(first: 100) { nodes { ... on ProjectV2FieldCommon { name dataType } } } } } }` liefert das Projekt bzw. `projectV2: null` + `errors[]` bei fehlendem Projekt/Zugriff. | `src/sources/github/project.ts` (`METADATA_QUERY`) | Schema laut GraphQL-Doku, Fehlerform **nicht** geprüft | T25a, T25c |
| A13 | Org-eigene Projekte sind mit der App-Berechtigung *Organization → Projects: Read* lesbar; **user-eigene** Projekte sind für Installation-Tokens nicht lesbar, wohl aber mit einem klassischen Token des Users (`read:project`, bei privaten Repos zusätzlich `repo`, da die Identity auch die Issues liest); fine-grained PAT (*Issues/Pull requests: Read*, *Projects: Read*) für User-Projekte unverifiziert. | Doku (`configuration-reference.md` §3.2) | nicht geprüft | T25a, T25c |
| A14 | `nodes(ids: [<REST node_id>])` liefert Issues/PRs; `projectItems(first: 20, includeArchived: false) { totalCount nodes { project { id } fN: fieldValueByName(name: $fN) { … } } }` liefert die Werte (`name`, `text`, `number`, `date`, `title`); leeres Feld → `null`. Nicht lesbare Knoten → `null` + Fehler mit `path: ["nodes", i]`. | `projectValuesQuery`, `readChunk` | nicht geprüft | T25a, T25b |
| A15 | `fieldValueByName` erwartet den Feldnamen des Projekts; der Adapter übergibt den exakten Namen aus den Metadaten (Abgleich der Deklaration ohne Groß-/Kleinschreibung). | `parseMetadata` | Groß-/Kleinschreibung bei GitHub **nicht** geprüft | T25b |
| A16 | GraphQL-Rate-Limits kommen als HTTP 200 mit `errors[].type = "RATE_LIMITED"` oder als 403/429 mit `x-ratelimit-*`. | `GitHubHttpClient.graphql` | nur teilweise dokumentiert | T25e |
| A17 | Kommentare mit dem Token einer `github_token`-Identity tragen `user.login` = Token-User; `GET /user` liefert diesen Login. | `authorPredicate`, `userLogin` in `adapter.ts` | nicht geprüft | T25d |
| A11 | Von einer App per Installation-Token erstellte Kommentare tragen `performed_via_github_app.id = <App-ID>` und `user.type = "Bot"`. Sonst findet `findCommentByMarker` eigene Kommentare nicht (Folge: Duplikat statt Unterdrückung). | `authorPredicate` in `adapter.ts` | Feld im Schema dokumentiert, `Bot`/`[bot]` **nicht** ([R7](#r7)) | T6, T7 |

### 0.2 Rechercheergebnisse (offizielle GitHub-Doku, abgerufen 2026-10-17)

<a id="r1"></a>**R1 – API-Version.** Unterstützt sind `2026-03-10` (Supportende „Not yet scheduled“) und `2022-11-28`
(Supportende 10.03.2028). Ohne Header gilt `2022-11-28`, eine nicht mehr unterstützte Version gibt `410`.
Breaking Changes in `2026-03-10`, die den Orchestrator betreffen könnten:
- Das Feld `assignee` (Einzahl) ist aus Issues/PRs entfernt. Der Code liest nur `assignees` und ist nicht betroffen.
- `GET /rate_limit` hat kein `rate` mehr, stattdessen `resources.core`. Der Code nutzt den Endpunkt nicht, nur T22.
- `DELETE /app/installations/{id}` gibt 202. Der Code nutzt den Endpunkt nicht.
- Labels und Issue-Kommentare sind unverändert.

Quellen: [API Versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions),
[Breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes).

<a id="r2"></a>**R2 – Issue-Dependencies-API.** Quelle: [Issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies),
[Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies).

| Operation | Methode, Pfad | Status | Recht (Fine-grained/App) |
|---|---|---|---|
| Blocker auflisten | `GET /repos/{o}/{r}/issues/{issue_number}/dependencies/blocked_by` (`per_page` ≤ 100, `page`) | 200, 301, 404, 410 | *Issues: read* |
| Blocker hinzufügen | `POST …/dependencies/blocked_by`, Body `{"issue_id": <int>}` | 201, 301, 403, 404, 410, 422 | *Issues: write* |
| Blocker entfernen | `DELETE …/dependencies/blocked_by/{issue_id}` | **200** (nicht 204), 301, 400, 401, 403, 404, 410 | *Issues: write* |
| Blockierte auflisten | `GET …/dependencies/blocking` | 200, 301, 404, 410 | *Issues: read* |

- `issue_id` ist die **Datenbank-ID** des blockierenden Issues (`.id`), **nicht** die Nummer.
- Die Antwort ist ein Array vollständiger Issue-Objekte mit `repository_url` (Pflicht) und optional `repository`.
- *Pull requests* ist bei keinem der vier Endpunkte als alternatives Recht genannt.
- `gh` kann Abhängigkeiten selbst setzen (`gh issue edit N --add-blocked-by <nr|url>`, `--remove-blocked-by`;
  `gh issue create --blocked-by`). Das wurde mit gh 2.101.0 geprüft.
- Laut [Changelog 2025-08-21](https://github.blog/changelog/2025-08-21-dependencies-on-issues) sind bis zu 50 Issues je
  Beziehungstyp möglich.

<a id="r3"></a>**R3 – `issue_dependencies_summary`.** Das Feld ist Teil des Issue-Schemas (Get/Create/List) mit den
Pflicht-Integern `blocked_by`, `blocking`, `total_blocked_by` und `total_blocking`. Die Bedeutung ist **nicht
dokumentiert**. Dass `blocked_by` die offenen und `total_*` alle Blocker zählt, ist eine Annahme (A5, T11/T14).
Ebenfalls nicht dokumentiert ist, ob unsichtbare Blocker mitzählen (A4, T13).

<a id="r4"></a>**R4 – Rechte je Endpunkt** (Kästen „Fine-grained access tokens“, Übersicht
[Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)):
- **Nur *Issues: read*:**
  - `GET /repos/{o}/{r}/issues`. Die Liste enthält auch PRs, erkennbar an `pull_request`.
  - `GET …/issues/{n}`.
- ***Issues: write* oder *Pull requests: write*** (eines von beiden genügt):
  - `POST …/issues/{n}/labels`
  - `DELETE …/labels/{name}`
  - `POST …/issues/{n}/comments`
  - `POST /repos/{o}/{r}/labels`
- ***Issues: read* oder *Pull requests: read*:** `GET …/issues/{n}/comments`.
- **Metadata:** *Metadata: read* setzt GitHub automatisch.

Die Doku sagt **nicht**, welches der beiden Rechte bei einem PR greift. Deshalb behält diese Anleitung für PR-schreibende
Apps vorsichtshalber beide Rechte und prüft die Frage in T19d. Die fehlende Berechtigung nennt der Antwort-Header
`X-Accepted-GitHub-Permissions`. Quellen: [Issues](https://docs.github.com/en/rest/issues/issues),
[Labels](https://docs.github.com/en/rest/issues/labels), [Comments](https://docs.github.com/en/rest/issues/comments).

<a id="r5"></a>**R5 – App anlegen und installieren.**
- **Anlegen:** [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
  (Webhook „Active“ abwählen, „Only on this account“).
- **Schlüssel:** [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).
  Der PEM ist im Format PKCS#1 (`BEGIN RSA PRIVATE KEY`), läuft nicht ab, und je App sind bis zu 25 Schlüssel möglich.
- **Installieren:** [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app),
  mit „Only select repositories“.
- **Installation-ID:** laut [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
  über das JWT mit `GET /repos/{o}/{r}/installation`, `GET /users/{u}/installation`, `GET /orgs/{org}/installation` oder
  `GET /app/installations`. Die URL `…/settings/installations/<ID>` funktioniert, ist aber nicht offiziell dokumentiert.

<a id="r6"></a>**R6 – Installation-Token und JWT.**
- **Token:** `POST /app/installations/{id}/access_tokens` → `201 {token, expires_at, permissions, repository_selection}`.
  Das Token läuft nach einer Stunde ab, danach kommt `401`. Mit `repositories`/`permissions` im Body lässt sich ein Token
  weiter einschränken, aber nie erweitern.
- **Neues Token-Format:** Seit dem 27.04.2026 stellt GitHub auf das zustandslose Format `ghs_<APPID>_<JWT>` um (länger als
  40 Zeichen). Der Code setzt keine Länge voraus.
- **JWT:**
  - Algorithmus RS256.
  - `iat` 60 s in der Vergangenheit empfohlen.
  - `exp` höchstens 10 min in der Zukunft.
  - `iss` darf Client-ID **oder** App-ID sein; die Client-ID wird empfohlen.

  Quellen: [Create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app),
  [Generating a JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).

<a id="r7"></a>**R7 – Kommentare einer App.** Das Kommentar-Schema enthält `performed_via_github_app` (`null` oder ein
App-Objekt mit `id`, `slug`, `client_id` …) und `user.type`. Laut Doku werden Requests einer Installation „der App
zugeschrieben“
([Authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
`user.type = "Bot"` und der Login `<slug>[bot]` sind **nicht dokumentiert** und werden in T6 gemessen.

<a id="r8"></a>**R8 – Rate-Limits** ([Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[Best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).
- **Primäres Limit je Installation:** mindestens 5 000/h. Mit mehr Repos/Nutzern skaliert es bis 12 500/h, unter
  Enterprise Cloud sind es 15 000/h.
- **Header:** `x-ratelimit-limit|remaining|used|reset|resource`. `GET /rate_limit` zählt nicht zum primären Limit.
- **Sekundäre Limits:**
  - 100 parallele Requests.
  - 900 Punkte/min je Endpunkt (GET = 1 Punkt, Schreiben = 5).
  - 80 content-erzeugende Requests/min bzw. 500/h.
- **Antwort bei Überschreitung:** `403` **oder** `429`. Mit `retry-after` gilt dessen Wartezeit, bei `remaining: 0` die
  bis `reset`, sonst mindestens 1 min mit Backoff.
- **Empfehlung:** Schreibende Requests seriell senden, mit mindestens 1 s Abstand. Der Code drosselt das nicht, siehe
  [5.2](#52-bei-abweichungen).

<a id="r9"></a>**R9 – Transfer/Löschung** ([Get an issue](https://docs.github.com/en/rest/issues/issues#get-an-issue)):
- Transferiert in ein lesbares Repo → `301`.
- Transferiert in ein nicht lesbares Repo oder dort gelöscht → `404`.
- In einem lesbaren Repo gelöscht → `410`.

<a id="r11"></a>**R11 – Cross-Repo-Abhängigkeiten.** Es gibt keine dokumentierte Einschränkung (gleicher Owner o. Ä.).
Was ein Token sieht, wenn ihm das Blocker-Repo fehlt, ist nicht dokumentiert. Das prüft T13.

**Abweichungen zwischen Code-Annahmen und Doku:**
- Es gibt **keine** falsche Konstante und keinen falschen Endpunkt oder Feldnamen. Code wurde nicht geändert.
- **A7:** Die Aussage „Pull requests: write ist für Labels/Kommentare an PRs nötig“ deckt die Doku nicht. Laut Doku genügt
  eines der beiden Rechte. Prüfen in T19d und danach die Rechte-Hinweise in `README.md` und `src/cli/init-templates.ts`
  anpassen.
- **A7 (Dependencies):** Die Dependencies-Endpunkte nennen jetzt explizit *Issues: read/write*. Die alte Aussage „Doku
  nennt keine Rechte“ ist überholt.
- **A9:** `iss` = App-ID ist weiterhin zulässig. Empfohlen ist die Client-ID; ein Umstieg ist optional (Konfigfeld fehlt).

---

## 1 Voraussetzungen und Testaufbau

### 1.1 Werkzeuge

- Repo-Checkout mit `npm ci`, Node ≥ 22.13. Alle Befehle laufen im **Repo-Root**.
- `gh` ≥ 2.80 (getestet mit 2.101.0), angemeldet als Mensch mit Admin-Rechten auf die Test-Repos (`gh auth status`).
  Zum Aufräumen zusätzlich `gh auth refresh -s delete_repo`.
- `curl`, `jq`, `openssl`, eine bash- oder zsh-Shell.
- Ein **eigener** GitHub-Account oder eine Test-Org. Keine produktiven Repos und keine produktiven Apps verwenden.

### 1.2 Repos

| Repo | Sichtbarkeit | Apps installiert | Zweck |
|---|---|---|---|
| `orch-test-a` | privat | maintainer, coder, reviewer | Source `test_a`: Coder-/Reviewer-Workflows, Dependencies |
| `orch-test-b` | privat | maintainer, coder, reviewer | Source `test_b`: Kommentar-Workflow, Cross-Repo-Blocker **mit** Zugriff |
| `orch-test-hidden` | privat | **keine** | Cross-Repo-Blocker **ohne** App-Zugriff (A4) |

```bash
export ADISPATCH_TEST_OWNER=<dein-account-oder-org>
for r in orch-test-a orch-test-b orch-test-hidden; do
  gh repo create "$ADISPATCH_TEST_OWNER/$r" --private --add-readme --description "adispatchd manual test (Wegwerf)"
done
```

`orch-test-hidden` muss **privat** sein, sonst kann die App es über die öffentliche API trotzdem lesen.

### 1.3 Apps

Empfohlen sind **drei** GitHub Apps, eine je Rolle wie in Spec §5.3. Nur so lässt sich prüfen, dass
- Kommentare der falschen App den Marker nicht „besitzen“ (A11, T6c),
- Action-Identitäten die Workflow-Identität überschreiben (T7),
- eine Rolle ohne Schreibrechte wirklich nicht schreiben kann (T19).

| App (Vorschlag Name) | Identity | Repository permissions (minimal) | Wofür |
|---|---|---|---|
| `orch-test-maintainer-<owner>` | `maintainer` | **Issues: Read-only**, Metadata: Read-only (automatisch) | Source-Identity: Polling, Dependencies, Views, Item-Lesen für Hooks und manuelle Starts |
| `orch-test-coder-<owner>` | `coder` | **Issues: Read and write**, **Pull requests: Read and write**, Metadata: Read-only | Labels und Kommentare in `coder-test` und `commenter-test`, `GH_TOKEN` des Workers. Liest selbst: Neu-Lesen des Items vor jedem Label-Update und die Marker-Suche nutzen die **schreibende** Identity (`applyUpdate`, `findCommentByMarker`) |
| `orch-test-reviewer-<owner>` | `reviewer` | **Issues: Read and write**, **Pull requests: Read and write**, Metadata: Read-only | Labels/Kommentare an PRs (`reviewer-test`), Start-Kommentar in `commenter-test`; liest wie coder selbst (Neu-Lesen, Marker-Suche) |

Schreibende Apps brauchen also immer auch Lesezugriff auf Issues (in „Read and write“ enthalten). *Issues* darf bei
coder/reviewer nie auf „No access“ stehen, sonst scheitert schon das Neu-Lesen vor dem Update.

Alles andere bleibt auf „No access“: Contents, Workflows, Administration, Account permissions, Organization
permissions. Ein echter Coder bräuchte zusätzlich *Contents: write* für Push und PR. Das ist hier nicht nötig, weil der
Test-Worker nichts pusht.

*Pull requests* ist bei coder und reviewer bewusst vorhanden, obwohl die Doku *Issues: write* für Labels/Kommentare an
PRs vermutlich genügen lässt ([R4](#r4)). T19d prüft genau das. Fällt der Test positiv aus, kann *Pull requests* später
entfallen.

**Minimalvariante mit zwei Apps** (weniger Aufwand, eingeschränkte Aussagekraft):
- Die App `maintainer` bleibt wie oben.
- Eine App `writer` übernimmt **coder und reviewer**: In `identities.yaml` zeigen beide Einträge auf dieselbe App-ID und
  Installation-ID und dieselbe Key-Variable.
- Dann entfallen T6c (fremde App mit gleichem Marker) und der Identitätswechsel in T7. Alle anderen Fälle laufen
  unverändert.

Eine einzige App für alles ist **nicht** sinnvoll: Dann lässt sich weder die Read-only-Source-Identität (T19a) noch eine
Rollentrennung prüfen.

**Anlegen** (je App, [R5](#r5)):

1. *Settings → Developer settings → GitHub Apps → New GitHub App* (bei einer Org:
   *Org Settings → Developer settings → GitHub Apps*).
2. **GitHub App name** wie oben (≤ 34 Zeichen, global eindeutig). **Homepage URL**: z. B.
   `https://github.com/<owner>/orch-test-a`.
3. **Webhook → Active abwählen** (der Orchestrator pollt).
4. **Permissions → Repository permissions** gemäß Tabelle setzen.
5. **Where can this GitHub App be installed? → Only on this account.** Dann *Create GitHub App*.
6. Auf der Seite *General*: **App ID** notieren (und die Client ID, nur zur Information).
7. *Private keys → Generate a private key*. Der Browser lädt `<name>.<datum>.private-key.pem` herunter. Die Datei nach
   `~/orch-test-keys/` verschieben, `chmod 600`. Sie **nie** ins Repo legen.
8. *Install App → Install → Only select repositories → `orch-test-a`, `orch-test-b` → Install*.
   **Nicht** `orch-test-hidden`.
9. Installation-ID notieren: Sie steht in der URL nach der Installation (`…/settings/installations/<ID>`). Zuverlässiger
   ist der Helfer aus 2.3: `installation_id <app-id> <pem> orch-test-a`.

### 1.4 Private Keys als Umgebungsvariablen

Der Orchestrator liest den PEM aus der Variablen, die `private_key_env` nennt (`normalizePrivateKeyPem` in
`src/identities/jwt.ts`). Erlaubt sind echte Zeilenumbrüche, `\n`-Escapes, CRLF und umschließende Quotes. Beide Formen
werden getestet:

```bash
# Form 1: echte Zeilenumbrüche (direkt in der Shell)
export ADISPATCH_TEST_MAINTAINER_KEY="$(cat ~/orch-test-keys/orch-test-maintainer-*.private-key.pem)"
export ADISPATCH_TEST_REVIEWER_KEY="$(cat ~/orch-test-keys/orch-test-reviewer-*.private-key.pem)"

# Form 2: einzeilig mit literalen \n (wie in einer systemd-EnvironmentFile oder .env)
export ADISPATCH_TEST_CODER_KEY="$(awk 'BEGIN{ORS="\\n"}1' ~/orch-test-keys/orch-test-coder-*.private-key.pem)"
printf '%s' "$ADISPATCH_TEST_CODER_KEY" | head -c 40; echo   # → -----BEGIN RSA PRIVATE KEY-----\nMIIE…
```

Variante als Datei, die nur gesourct und nie eingecheckt wird (`/tmp/` im Repo ist in `.gitignore`):

```bash
mkdir -p tmp && umask 077
{
  printf 'ADISPATCH_TEST_MAINTAINER_KEY="%s"\n' "$(awk 'BEGIN{ORS="\\n"}1' ~/orch-test-keys/orch-test-maintainer-*.pem)"
  printf 'ADISPATCH_TEST_CODER_KEY="%s"\n'      "$(awk 'BEGIN{ORS="\\n"}1' ~/orch-test-keys/orch-test-coder-*.pem)"
  printf 'ADISPATCH_TEST_REVIEWER_KEY="%s"\n'   "$(awk 'BEGIN{ORS="\\n"}1' ~/orch-test-keys/orch-test-reviewer-*.pem)"
} > tmp/orch-test.env
set -a; . tmp/orch-test.env; set +a
```

### 1.5 App-ID und Installation-ID prüfen

```bash
source docs/manual-tests/github-fixture/helpers.sh
export MAINTAINER_APP_ID=<id> CODER_APP_ID=<id> REVIEWER_APP_ID=<id>
K=~/orch-test-keys
installation_id "$MAINTAINER_APP_ID" $K/orch-test-maintainer-*.pem orch-test-a
installation_id "$CODER_APP_ID"      $K/orch-test-coder-*.pem      orch-test-a
installation_id "$REVIEWER_APP_ID"   $K/orch-test-reviewer-*.pem   orch-test-a
# → {"id": <Installation-ID>, "app_id": …, "app_slug": "…", "repository_selection": "selected", "permissions": {…}}
export MAINTAINER_INSTALLATION_ID=<id> CODER_INSTALLATION_ID=<id> REVIEWER_INSTALLATION_ID=<id>
# Gegenprobe: das versteckte Repo hat KEINE Installation (erwartet: 404 "Not Found")
installation_id "$MAINTAINER_APP_ID" $K/orch-test-maintainer-*.pem orch-test-hidden
# Slugs für T6 (Bot-Login = <slug>[bot]):
app_info() { curl -sS -H "Authorization: Bearer $(app_jwt "$1" "$2")" -H 'Accept: application/vnd.github+json' \
  https://api.github.com/app | jq -c '{id, slug, client_id, permissions}'; }
app_info "$MAINTAINER_APP_ID" $K/orch-test-maintainer-*.pem
app_info "$CODER_APP_ID"      $K/orch-test-coder-*.pem
app_info "$REVIEWER_APP_ID"   $K/orch-test-reviewer-*.pem
```

`permissions` muss der Tabelle in 1.3 entsprechen (`issues: read` bzw. `write`, `pull_requests`, `metadata: read`).

---

## 2 Testkonfiguration

### 2.1 Inhalt des Fixtures

Das komplette config-dir liegt unter [`github-fixture/`](github-fixture/). Der Test
`src/sources/github/manual-fixture.test.ts` prüft bei jedem `npm run check`:
- Das Fixture lädt mit dem echten Loader ohne Fehler und Warnungen.
- Der Test-Worker hält das Worker-Protokoll ein.
- Worker und Helfer pinnen dieselbe API-Version wie `GITHUB_API_VERSION`.

| Datei | Inhalt |
|---|---|
| `config.yaml` | Port **8791**, Polling **20 s**, global `max_concurrent: 4`, Action-Retry 3 × **20 s**, Workspaces behalten |
| `sources.yaml` | `test_a` → `orch-test-a`, `test_b` → `orch-test-b`, Lese-Identity `maintainer`; Owner-Platzhalter `ADISPATCH_TEST_OWNER` |
| `identities.yaml` | `maintainer`, `coder`, `reviewer`; Platzhalter-IDs `900000x` (App) / `910000x` (Installation); Keys aus `ADISPATCH_TEST_{MAINTAINER,CODER,REVIEWER}_KEY` |
| `workflows/coder-test.yaml` | Source `test_a`, Identity `coder`, Filter `labels contains ready-for-coding` **und** `dependencies.blocked_by_open = 0`, `max_concurrent: 2`, `max_technical_failures: 3`, Label-Hooks (`coding` → `ready-for-review` / `needs-maintainer` / zurück zu `ready-for-coding`), Kommentar bei Erfolg und `failure`, `GH_TOKEN` für den Worker |
| `workflows/reviewer-test.yaml` | Source `test_a`, Identity `reviewer`, nur **PRs** mit `ready-for-review` und ohne offene Blocker, Kommentar bei Erfolg |
| `workflows/commenter-test.yaml` | Source `test_b`, Label `ready-for-comment`. `on_start` kommentiert als **reviewer** (Action-Identity), `on_success` als **coder** mit `retry: {max_attempts: 6, delay: 20s}` (Szenario 6) |
| `views/needs-maintainer.yaml` | Szenario 10: beide Repos, Label `needs-maintainer`, letzter Run und Ergebnis, Link |
| `views/dependencies.yaml` | Beobachtung: alle Items mit Label `deps-test` und ihre `dependencies.*`-Felder (startet nichts) |
| `scripts/test-worker.sh` | Test-Worker; das Verhalten steuern Labels (siehe unten) |
| `helpers.sh` | Shell-Helfer für diese Anleitung (wird **nicht** vom Orchestrator ausgeführt) |

Labels für den Test-Worker (kombinierbar):

| Label | Verhalten | Erwarteter Run |
|---|---|---|
| (kein `test:*`) | Ergebnis `success`, Exit 0 | `completed` / `success` → `on_success` |
| `test:slow` | schläft `TEST_SLOW_SECONDS` (coder 90 s, sonst 60 s), alle 10 s ein `progress`-Event | wie ohne, nur später |
| `test:failure` | Ergebnis `failure`, Exit 0 | `completed` / `failure` → `on_failure`, kein Retry-Zähler |
| `test:crash` | schreibt `success`, dann Exit 1 | `crashed` (Datei ignoriert) → `on_crash`, zählt |
| `test:invalid-result` | ungültige Ergebnisdatei, Exit 0 | `crashed` (Protokollfehler) |
| `test:token` | prüft `GH_TOKEN` per `GET /repos/…/issues/<n>` | bei HTTP ≠ 200 `crashed` |
| `test:revoke-token` | widerruft `GH_TOKEN` per `DELETE /installation/token` | Erfolg; der Orchestrator muss das Coder-Token erneuern (T2a) |

### 2.2 Fixture kopieren und IDs eintragen

```bash
source docs/manual-tests/github-fixture/helpers.sh      # setzt ADISPATCH_CFG=tmp/orch-cfg, ADISPATCH_DATA=tmp/orch-data, API=…:8791
rm -rf "$ADISPATCH_CFG" && mkdir -p "$ADISPATCH_CFG" "$ADISPATCH_DATA"
cp -Rp docs/manual-tests/github-fixture/. "$ADISPATCH_CFG"/
perl -pi -e "s/ADISPATCH_TEST_OWNER/$ADISPATCH_TEST_OWNER/g" "$ADISPATCH_CFG/sources.yaml"
perl -pi -e "s/9000001/$MAINTAINER_APP_ID/; s/9100001/$MAINTAINER_INSTALLATION_ID/;
             s/9000002/$CODER_APP_ID/;      s/9100002/$CODER_INSTALLATION_ID/;
             s/9000003/$REVIEWER_APP_ID/;   s/9100003/$REVIEWER_INSTALLATION_ID/" "$ADISPATCH_CFG/identities.yaml"
grep -nE 'owner|app_id|installation_id' "$ADISPATCH_CFG"/sources.yaml "$ADISPATCH_CFG"/identities.yaml
ls -l "$ADISPATCH_CFG/scripts/test-worker.sh"              # muss ausführbar sein (rwx)
orch config validate --config-dir "$ADISPATCH_CFG"
# → Configuration in …/tmp/orch-cfg is valid: 3 workflow(s), 2 view(s), 2 source(s), 3 identities. Hash …
```

Minimalvariante: In `identities.yaml` bei `reviewer` dieselben Werte wie bei `coder` eintragen und
`private_key_env: ADISPATCH_TEST_CODER_KEY` setzen.

### 2.3 Helfer

`source docs/manual-tests/github-fixture/helpers.sh` stellt diese Helfer bereit. `probe` und `ghraw` holen sich eigene
Tokens; die Key-Variablen aus 1.4 müssen deshalb auch in der Test-Shell gesetzt sein.

| Helfer | Wirkung |
|---|---|
| `orch …` | CLI aus dem Checkout |
| `api /pfad`, `post /pfad '{json}'` | Orchestrator-API; `post` setzt den CSRF-Header |
| `runs <wf>` | Runs als Tabelle |
| `run_of <source> <nr>` | neueste Run-ID eines Items |
| `diag <wf>` | letzte Planungsdiagnose (Kandidaten + Entscheidung) |
| `actions <run>` | Action-Journal |
| `events <run>` | Run-Events |
| `view <id>` | View-Zeilen, `?` = unbekannt |
| `mkissue <repo> <titel> [label…]` | Issue anlegen, gibt die Nummer aus |
| `blockedby <repo> <nr> <blocker-repo> <nr>` | Abhängigkeit setzen (über gh) |
| `blockedby_api` / `unblock_api` | Abhängigkeit setzen bzw. entfernen über REST (`issue_id`) |
| `labels <repo> <nr>` | Labels eines Issues |
| `comments <repo> <nr>` | Kommentare als Tabelle: id, Login, `user.type`, `performed_via_github_app.id`, letzte Zeile |
| `probe …` | Adapter direkt aufrufen (2.4) |
| `ghraw <identity> <pfad> [curl-Optionen]` | Rohantwort der API **als App** (frisches Installation-Token) |
| `app_jwt <app-id> <pem>`, `installation_id <app-id> <pem> <repo>` | App-JWT bzw. Installation einer App ermitteln |

### 2.4 Probe-Skript (Adapter direkt)

Für Rohbeobachtungen ohne laufende Instanz. Die Datei unter `tmp/probe.ts` anlegen; das Verzeichnis ist in `.gitignore`.
Sie nutzt dieselbe Verdrahtung wie `start`/`dry-run` (`SourceRegistry` aus `src/app.ts`). Jeder Aufruf holt **eigene**
Tokens und teilt keinen Cache mit der laufenden Instanz.

```ts
// tmp/probe.ts – direkter Zugriff auf Adapter/Credentials mit der Test-Konfiguration (nicht einchecken; /tmp/ ist ignoriert).
// Aufruf: npx tsx tmp/probe.ts <befehl> ...   (config-dir aus $ADISPATCH_CFG, Logs auf stderr, Ergebnis als JSON auf stdout)
import { loadConfig } from '../src/config/index.js';
import { ConsoleLogger, SecretRedactor, systemClock } from '../src/core/index.js';
import { SourceRegistry } from '../src/app.js';
import { DEPENDENCY_FIELDS } from '../src/sources/index.js';

const [cmd, ...args] = process.argv.slice(2);
const loaded = await loadConfig(process.env.ADISPATCH_CFG ?? 'tmp/orch-cfg', { dataDir: process.env.ADISPATCH_DATA ?? 'tmp/orch-data' });
if (!loaded.ok) throw new Error(`config invalid: ${JSON.stringify(loaded.errors)}`);
const redactor = new SecretRedactor();
const logger = new ConsoleLogger({ level: 'debug', redact: redactor.asRedactor });
const registry = new SourceRegistry(loaded.config, { redactor, logger });
const out = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const adapter = (id: string) => registry.get(id) ?? (() => { throw new Error(`unknown source ${id}`); })();
const item = async (source: string, ref: string) => {
  const a = adapter(source);
  const id = a.parseItemRef(ref);
  const it = id ? await a.getItem(id) : null;
  if (!it) throw new Error(`item ${ref} not found in ${source}`);
  return { a, it };
};

switch (cmd) {
  case 'token': { // token <identity>  → nur das Token (für curl); 1 h gültig
    const t = await registry.getToken(args[0]!);
    process.stderr.write(`expires_at ${t.expiresAt.toISOString()}\n`);
    process.stdout.write(`${t.token}\n`);
    break;
  }
  case 'list': { // list <source> [label]
    const filter = args[1] ? { field: 'labels', operator: 'contains' as const, value: args[1] } : undefined;
    const items = await adapter(args[0]!).listCandidates(filter ? { filter } : {});
    out(items.map((i) => ({ key: i.key, type: i.type, state: i.fields.state, labels: i.fields.labels, title: i.fields.title })));
    break;
  }
  case 'item': { // item <source> <ref>
    out((await item(args[0]!, args[1]!)).it);
    break;
  }
  case 'deps': { // deps <source> <ref>
    const { a, it } = await item(args[0]!, args[1]!);
    out(await a.resolveFields(it, DEPENDENCY_FIELDS));
    break;
  }
  case 'labels': { // labels <source> <ref> <identity> +add -remove ...
    const { a, it } = await item(args[0]!, args[1]!);
    const add = args.slice(3).filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    const remove = args.slice(3).filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    out(await a.applyUpdate(it, { labels: { add, remove } }, args[2]!));
    break;
  }
  case 'comment': { // comment <source> <ref> <identity> <marker> <text>
    const { a, it } = await item(args[0]!, args[1]!);
    out(await a.postComment(it, args[4] ?? 'probe', args[3]!, args[2]!));
    break;
  }
  case 'find': { // find <source> <ref> <identity> <marker>
    const { a, it } = await item(args[0]!, args[1]!);
    out(await a.findCommentByMarker(it, args[3]!, args[2]!));
    break;
  }
  default:
    process.stderr.write('usage: probe.ts token|list|item|deps|labels|comment|find ...\n');
    process.exitCode = 2;
}
```

Der Code wurde am 2026-10-17 gegen diesen Stand mit `tsc` geprüft. Bricht er nach Refactorings, die Importe an die
`index.ts`-Exporte anpassen.

### 2.5 Instanz starten

In einem **eigenen Terminal**, in dem die Key-Variablen gesetzt sind:

```bash
source docs/manual-tests/github-fixture/helpers.sh
orch start --config-dir "$ADISPATCH_CFG" --data-dir "$ADISPATCH_DATA" 2>&1 | tee -a tmp/orch.log
# → URL http://127.0.0.1:8791, Stop-Timeouts; Logs (JSON-Zeilen) auf stderr → tmp/orch.log
```

Weboberfläche: <http://127.0.0.1:8791>. Bei Bedarf stoppen und neu starten (`Ctrl-C` = Drain, zweimal = Cancel-All).
Die Daten in `$ADISPATCH_DATA` bleiben erhalten.

**Während des Testdaten-Setups** die automatischen Starts anhalten, damit kein Run startet, bevor alle Abhängigkeiten
gesetzt sind:

```bash
post /scheduler/pause | jq .scheduler.state     # → "paused"   (Views und Dry-Run funktionieren weiter)
post /scheduler/resume | jq .scheduler.state    # → "running"  (sofortiger Planungsschritt)
```

---

## 3 Testdaten

Alle Befehle setzen `source …/helpers.sh` und `ADISPATCH_TEST_OWNER` voraus. Die Testfälle legen ihre Issues selbst an
(`mkissue`). Hier entstehen nur Labels, Blocker und der PR.

### 3.1 Labels (in beiden Repos)

```bash
for r in orch-test-a orch-test-b; do
  for l in ready-for-coding coding ready-for-review reviewing reviewed needs-maintainer \
           ready-for-comment commenting commented deps-test manual-keep 'priority:high' 'prio: high/urgent' \
           test:slow test:failure test:crash test:invalid-result test:token test:revoke-token; do
    gh label create "$l" -R "$(repo $r)" --color C5DEF5 --force >/dev/null && printf '.'
  done; echo " $r"
done
gh label list -R "$(repo orch-test-a)" --limit 100 | wc -l    # ≥ 21 (inkl. GitHub-Standardlabels)
```

Die Hooks setzen auch selbst Labels an, die es noch nicht gibt. GitHub legt sie dann an. Das Vorab-Anlegen sorgt nur für
Ordnung.

### 3.2 Blocker-Issues

```bash
post /scheduler/pause >/dev/null
export A_BLOCKER=$(mkissue orch-test-a "Blocker A (same repo)")
export B_BLOCKER=$(mkissue orch-test-b "Blocker B (cross repo, App hat Zugriff)")
export H_BLOCKER=$(mkissue orch-test-hidden "Blocker H (cross repo, KEIN App-Zugriff)")
echo "A_BLOCKER=$A_BLOCKER B_BLOCKER=$B_BLOCKER H_BLOCKER=$H_BLOCKER" | tee -a tmp/testdata.env
```

### 3.3 Pull Request in `orch-test-a`

```bash
R=$(repo orch-test-a)
sha=$(gh api repos/$R/git/ref/heads/main --jq .object.sha)
gh api -X POST repos/$R/git/refs -f ref=refs/heads/pr-test -f sha="$sha" >/dev/null
gh api -X PUT repos/$R/contents/pr-test.txt -f message="PR-Test" -f branch=pr-test \
  -f content="$(printf 'manual test\n' | base64)" >/dev/null
export A_PR=$(gh pr create -R $R --head pr-test --base main --title "PR-Test (Reviewer)" --body "manual test" | sed 's#.*/##')
echo "A_PR=$A_PR" | tee -a tmp/testdata.env
post /scheduler/resume >/dev/null
```

Variablen in einer neuen Shell wiederherstellen: `set -a; . tmp/testdata.env; set +a`.

---

## 4 Testfälle

Format je Fall: **Ziel** (Bezug), **Schritte**, **Erwartet**, **Ist**. Die Ist-Zeile wird im Protokoll ([5.1](#51-ergebnisse-festhalten))
oder direkt hier abgehakt. „Nächster Poll“ heißt: höchstens 20 s plus Dauer des Planungsschritts. Die Instanz läuft
während aller Fälle (2.5), sofern nicht anders angegeben.

Reihenfolge: T1–T2 zuerst, dann beliebig. T2b läuft nebenher. T19 und T7 verändern App-Installationen: anschließend
**immer zurücksetzen**.

### T1 – App-Auth: JWT → Installation-Token (A1, A9)

**Ziel:** Alle drei Identities bekommen Tokens. Das JWT-Format wird akzeptiert, `expires_at` liegt etwa 1 h in der
Zukunft, und jedes Token sieht genau die installierten Repos.

**Schritte:**
```bash
grep 'Obtained GitHub installation token' tmp/orch.log | tail -5
for i in maintainer coder reviewer; do
  echo "== $i"; ghraw $i /installation/repositories | jq -r '.repositories[].full_name'
done
ghraw coder /installation/repositories -o /dev/null -D - | grep -i -E '^x-github-api-version-selected|^x-ratelimit-limit'
```

**Erwartet:**
- Das Log hat je benutzter Identity eine Zeile `Obtained GitHub installation token` mit `identity` und `expiresAt`
  (≈ jetzt + 60 min), aber **ohne** Token- oder Key-Inhalt.
- Jede App listet genau `orch-test-a` und `orch-test-b`, **nicht** `orch-test-hidden`.
- Der Header `x-github-api-version-selected: 2026-03-10` ist vorhanden. Steht eine andere Version darin, ist A1
  abweichend. Fehlt der Header ganz, nur notieren.

**Ist:** ☐ OK ☐ Abweichung: ……

### T2 – Token-Erneuerung (A9, §22.1 „Token-Rotation“)

**T2a – erzwungen (Token widerrufen).**

**Ziel:** Ein ungültiges gecachtes Token (401) führt zu `invalidate` und einem neuen Token. Die Aktion gelingt ohne
sichtbaren Fehler. Der Worker bekommt dasselbe gecachte Coder-Token (`execute.secrets`) und widerruft es.

**Schritte:**
```bash
N=$(mkissue orch-test-a "T2a revoke token" ready-for-coding test:revoke-token)
sleep 45; RUN=$(run_of test_a $N); echo $RUN
api "/runs/$RUN/logs?stream=stdout" | jq -r .data | grep DELETE
actions $RUN
grep -c '"identity":"coder"' <(grep 'Obtained GitHub installation token' tmp/orch.log)
labels orch-test-a $N
```

**Erwartet:**
- Das stdout des Workers enthält `DELETE /installation/token → HTTP 204`.
- Die `on_success`-Actions sind `succeeded` mit `attempts=1`. Der 401 wird im Adapter einmal wiederholt und zählt nicht
  als Action-Versuch.
- Das Log enthält **eine weitere** Zeile `Obtained GitHub installation token` für `coder`, kurz nach dem Run-Ende.
- Labels am Ende: `ready-for-review,test:revoke-token`.

Abweichung: Ist die Action `failed` mit HTTP 401, wiederholt der Adapter nach 401 nicht. Bleibt die zweite Token-Zeile
aus, obwohl alles gelang, bekam der Worker ein anderes Token als der Adapter. Das ist kein Fehler, aber zu notieren.

**Ist:** ☐ OK ☐ Abweichung: ……

**T2b – natürlicher Ablauf (läuft nebenher).**

**Ziel:** Das Token wird **vor** dem Ablauf erneuert (Refresh-Marge 5 min). Es gibt keinen 401 im Log.

**Schritte:** Die Instanz ≥ 65 min ohne Neustart laufen lassen. Dann:
```bash
grep 'Obtained GitHub installation token' tmp/orch.log | jq -c '{time, identity, expiresAt}'
grep -E 'HTTP 401|"kind":"auth"' tmp/orch.log | head
```

**Erwartet:**
- Für `maintainer` (pollt ständig) kommt etwa alle 55 min eine neue Zeile; `expiresAt` der Vorgängerzeile minus etwa
  5 min ≈ Zeit der neuen Zeile.
- Es gibt keine 401-Zeilen, außer der aus T2a.

**Ist:** ☐ OK ☐ Abweichung: ……

### T3 – Polling, Label-Filter, Pushdown (§6, §7)

**Ziel:** Nur offene Items mit `ready-for-coding` werden gepollt (Pushdown `labels=`, `state=open`). Items ohne Label und
geschlossene Items erscheinen nicht.

**Schritte:**
```bash
post /scheduler/pause >/dev/null
N_OK=$(mkissue orch-test-a "T3 mit Label" ready-for-coding manual-keep); echo "N_OK=$N_OK" >> tmp/testdata.env
N_NO=$(mkissue orch-test-a "T3 ohne Label")
N_CL=$(mkissue orch-test-a "T3 geschlossen mit Label" ready-for-coding); gh issue close $N_CL -R $(repo orch-test-a)
orch workflow dry-run coder-test --config-dir "$ADISPATCH_CFG" --local --data-dir "$ADISPATCH_DATA"   # lokal: Gate egal
post /scheduler/resume >/dev/null; sleep 25; runs coder-test 5 | grep "test_a:$N_OK"
```

**Erwartet:**
- Der Dry-Run zeigt `pushdown {"field":"labels","operator":"contains","value":"ready-for-coding"}`.
- `polled` entspricht der Zahl **offener** Items mit `ready-for-coding`.
- `test_a:$N_OK` ist `would_start`; `$N_NO` und `$N_CL` fehlen ganz.
- Nach `resume` gibt es einen Run für `test_a:$N_OK` (`runs`). `diag` zeigt nur den **letzten** Planungsschritt, in dem
  das gestartete Item meist schon `locked` ist oder fehlt; Starts deshalb immer über `runs`/`run_of` prüfen.
- Über HTTP (`dry-run` ohne `--local`) wäre das Item bei pausiertem Scheduler `gate_closed` statt `would_start`.

**Ist:** ☐ OK ☐ Abweichung: ……

### T4 – Erfolgreicher Run und Label-Hooks, manuelle Labels bleiben (§10, §24.5)

**Ziel:** `on_start` und `on_success` setzen bzw. entfernen genau die konfigurierten Labels. Das manuelle Label
`manual-keep` bleibt.

**Schritte:** Fortsetzung von T3.
```bash
RUN=$(run_of test_a $N_OK); sleep 10; api /runs/$RUN | jq '{status, outcome, businessResult, resultMessage, identity, workspacePath, lifecycleStatus}'
actions $RUN
labels orch-test-a $N_OK
gh api repos/$(repo orch-test-a)/issues/$N_OK/events --jq '.[] | select(.event|test("label")) | [.event, .label.name, .actor.login, (.performed_via_github_app.slug // "-")] | @tsv'
```

**Erwartet:**
- Der Run ist `completed`, `outcome: success`, mit `resultMessage: "Simulierter Erfolg fuer …"` und `identity: coder`.
- `on_start-labels`, `on_success-labels` und `on_success-comment` sind `succeeded` (explizite Action-IDs im Fixture).
- Labels: `manual-keep,ready-for-review`.
- Die Label-Events stammen vom Coder-Bot (`<coder-slug>[bot]`): erst `labeled coding` / `unlabeled ready-for-coding`,
  dann `labeled ready-for-review` / `unlabeled coding`.

**Ist:** ☐ OK ☐ Abweichung: ……

### T5 – Label-Updates idempotent, Sonderzeichen, Groß/Klein (§10, `applyUpdate`)

**Schritte:**
```bash
N=$(mkissue orch-test-a "T5 labels" manual-keep 'prio: high/urgent'); echo "N_T5=$N" >> tmp/testdata.env
probe labels test_a $N coder +coding -'prio: high/urgent'        # 1. Aufruf
probe labels test_a $N coder +coding -'prio: high/urgent'        # 2. Aufruf
probe labels test_a $N coder +CODING                             # Groß/Klein
gh issue edit $N -R $(repo orch-test-a) --add-label needs-maintainer   # „manuelle“ Änderung dazwischen
probe labels test_a $N coder -coding
labels orch-test-a $N
```

**Erwartet:**
- Der 1. Aufruf gibt `{"changed": true, "applied": {"labelsAdded": ["coding"], "labelsRemoved": ["prio: high/urgent"]}}`.
  Das Label mit Leerzeichen und Slash wird entfernt (URL-Encoding).
- Der 2. Aufruf und der Groß/Klein-Aufruf geben `{"changed": false}`.
- Am Ende: `manual-keep,needs-maintainer`. Die manuell hinzugefügten Labels bleiben.

**Ist:** ☐ OK ☐ Abweichung: ……

### T6 – Kommentar mit Marker, Autor-Erkennung (A11, §10 Idempotenz)

**Ziel:** Kommentare tragen den unsichtbaren Marker als letzte Zeile. `performed_via_github_app.id` und `user.type`
entsprechen A11. `findCommentByMarker` findet nur Kommentare der **eigenen** App.

**Schritte:**
```bash
comments orch-test-a $N_OK                                 # Kommentar aus T4 (on_success-comment)
MARK=$(comments orch-test-a $N_OK | tail -1 | grep -o 'adispatchd:[^ ]*')
probe find test_a $N_OK coder "$MARK"                      # a) eigene App
probe find test_a $N_OK reviewer "$MARK"                   # c) fremde App, gleicher Marker
N=$(mkissue orch-test-a "T6 marker")
gh issue comment $N -R $(repo orch-test-a) --body $'Mensch\n\n<!-- adispatchd:manual-human:1 -->'
probe find test_a $N coder adispatchd:manual-human:1             # b) Mensch, gleicher Marker
probe comment test_a $N reviewer adispatchd:manual-rev:1 'als reviewer'
probe find test_a $N coder adispatchd:manual-rev:1               # c) andere App
probe find test_a $N reviewer adispatchd:manual-rev:1            # a) eigene App
probe comment test_a $A_PR coder adispatchd:manual-pr:1 'Kommentar an PR'
gh pr view $A_PR -R $(repo orch-test-a) --json comments,reviews --jq '{comments: (.comments|length), reviews: (.reviews|length)}'
```

**Erwartet:**
- `comments` zeigt Login `<coder-slug>[bot]`, Typ `Bot`, App-ID = `$CODER_APP_ID`. Die letzte Zeile ist
  `<!-- adispatchd:run-…:<action-id> -->`. Im Web-UI ist der Marker unsichtbar.
- a) gibt `{"id": "…", "url": "…#issuecomment-…"}`. b) und c) geben `null`.
- Der PR-Kommentar landet in der Konversation (`comments` +1), nicht als Review (`reviews` unverändert).

Weicht `performed_via_github_app` ab (fehlt oder `null`), ist A11 verletzt. Folge: Retries erzeugen Duplikate.
Betroffener Code: `authorPredicate`, siehe [5.2](#52-bei-abweichungen).

**Ist:** ☐ OK ☐ Abweichung: ……

### T7 – Retry ohne Duplikat: Marker-Abgleich nach endgültigem Fehler (§10, Szenario 6 Teil 2, A11)

**Ziel:** Eine endgültig gescheiterte Kommentar-Action stoppt die Kette sichtbar. Nach der Behebung erkennt **Retry
Action** einen bereits vorhandenen Kommentar am Marker und postet **nicht** doppelt. Das simuliert „Kommentar wurde
gepostet, Antwort ging verloren“. Zusätzlich wird der Identitätswechsel geprüft: Der Start-Kommentar stammt vom Reviewer.

**Schritte:**
1. Issue in `orch-test-b` anlegen, der Worker läuft 60 s:
   ```bash
   N=$(mkissue orch-test-b "T7 retry ohne Duplikat" ready-for-comment test:slow)
   sleep 30; RUN=$(run_of test_b $N); actions $RUN
   ```
2. **Während der Worker läuft:** Die Coder-App verliert den Zugriff auf `orch-test-b`. Dazu
   *Settings → Applications → Installed GitHub Apps → orch-test-coder-… → Configure → Repository access* öffnen,
   `orch-test-b` entfernen und *Save* klicken.
3. Das Run-Ende abwarten (ca. 40 s), dann:
   ```bash
   actions $RUN; api /runs/$RUN | jq '{status, outcome, lifecycleStatus, lifecycleFailed}'
   api /actions/failed | jq '.actions[] | {id, hook, name, status, attempts, err: .lastError.message}'
   api '/notifications?limit=3' | jq '.notifications[] | {eventType, deliveryState}'
   ```
4. Zugriff für die Coder-App wiederherstellen (`orch-test-b` wieder auswählen). Dann den Kommentar **mit genau dem
   Marker** der gescheiterten Action als Coder posten. Das ist die Simulation „gepostet, Antwort verloren“:
   ```bash
   AID=$(api /runs/$RUN | jq -r '.actions[] | select(.name=="done-comment") | .id')
   probe comment test_b $N coder "adispatchd:$RUN:$AID" 'Kommentar-Test fertig (vorab, simuliert)'
   post /actions/$AID/retry | jq .accepted
   sleep 5; actions $RUN; events $RUN | grep -i reconciled
   comments orch-test-b $N
   ```

**Erwartet:**
- Nach Schritt 1 ist `on_start-labels` `succeeded` und `start-comment` `succeeded`. Der erste Kommentar stammt von
  `<reviewer-slug>[bot]` mit App-ID `$REVIEWER_APP_ID` (Action-Identity überschreibt die Workflow-Identity).
- Schritt 3:
  - Der Run ist `completed`, `outcome: success`, mit `lifecycleStatus: failed` und `lifecycleFailed: true`.
  - `done-comment` ist `failed` nach **1** Versuch, mit HTTP 404 bzw. 403. Das ist nicht wiederholbar, bewusst nach
    WI-07.
  - Das folgende `on_success-labels` bleibt `pending`.
  - Es gibt eine Notification `lifecycle_action_failed`.
- Schritt 4:
  - Der Retry endet mit `done-comment` `succeeded` und `externalKey` = ID des Vorab-Kommentars. Das Event
    `lifecycle.action` hat `reconciled: true`.
  - Danach läuft `on_success-labels`: Labels `commented,test:slow`.
  - `comments` zeigt **genau einen** Kommentar mit diesem Marker. Der Worker wurde **nicht** neu gestartet (nur ein
    `run.spawn` in `events`).

Variante ohne manuelles Posten: Wird Schritt 4 ohne `probe comment` ausgeführt, postet der Retry genau einmal.

Gelingt `done-comment` in Schritt 3 trotz entferntem Zugriff, war das gecachte Token noch gültig. Die Beobachtung
notieren und den Test so wiederholen: Den Zugriff **vor** dem Anlegen des Issues entziehen und die Instanz neu starten.
`on_start` scheitert dann allerdings ebenfalls, siehe T19b.

**Ist:** ☐ OK ☐ Abweichung: ……

### T8 – Temporärer Kommentarfehler → automatischer Action-Retry (Szenario 6)

**Ziel:** Netzfehler beim Kommentar sind `transient`. Die Action wird nach 20 s wiederholt, der Worker läuft **nicht**
erneut, und es entsteht genau ein Kommentar.

**Schritte:**
```bash
N=$(mkissue orch-test-b "T8 Netzwerk weg" ready-for-comment test:slow)
sleep 30; RUN=$(run_of test_b $N); api "/runs/$RUN/logs?stream=stdout&tail=200" | jq -r .data   # Fortschritt beobachten
```

Kurz **vor** dem Worker-Ende (bei `working 50/60s`) das Netz kappen und nach etwa 45 s wiederherstellen:

| System | Netz aus | Netz an |
|---|---|---|
| macOS (WLAN) | `networksetup -setairportpower en0 off` | `networksetup -setairportpower en0 on` |
| Linux (NetworkManager) | `nmcli networking off` | `nmcli networking on` |
| nur GitHub-API sperren | `echo '0.0.0.0 api.github.com' \| sudo tee -a /etc/hosts` (macOS danach `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`) | Zeile aus `/etc/hosts` entfernen, Cache erneut leeren |

```bash
sleep 120; actions $RUN
api /runs/$RUN | jq '.actions[] | select(.name=="done-comment") | .attemptsDetail[] | {attempt, outcome, error: .error.message}'
events $RUN | grep -c run.spawn
comments orch-test-b $N | grep -c 'adispatchd:'
```

**Erwartet:**
- `done-comment` hat ≥ 2 Versuche. Die ersten sind `failed` mit `network error` bzw. `request timed out` (`transient`),
  der letzte `succeeded`. Die Abstände betragen etwa 20 s (`retryInMs` in den `lifecycle.action`-Events).
- `run.spawn` = 1.
- Genau **2** Kommentare mit Marker: `start-comment` und `done-comment`. Es gibt **kein** Duplikat. Ab dem 2. Versuch
  sucht die Engine zuerst per Marker.
- Bleibt das Netz länger als 6 × 20 s weg, wird `done-comment` `failed`. Dann gilt Retry Action wie in T7.

Hinweis: Wird auch das Token-Holen getroffen, steht die Meldung beim Token-Austausch. Das ist ebenfalls `transient` und
ebenso wiederholbar.

**Ist:** ☐ OK ☐ Abweichung: ……

### T9 – Fachliches `failure` → `needs-maintainer` (Szenario 4)

**Schritte:**
```bash
N_FAIL=$(mkissue orch-test-a "T9 failure" ready-for-coding test:failure); echo "N_FAIL=$N_FAIL" >> tmp/testdata.env
sleep 45; RUN=$(run_of test_a $N_FAIL)
api /runs/$RUN | jq '{status, outcome, businessResult, resultMessage, countedTechnicalFailure, block}'
labels orch-test-a $N_FAIL; comments orch-test-a $N_FAIL
sleep 25; diag coder-test | grep "test_a:$N_FAIL"; api /blocks | jq '.blocks | length'
```

**Erwartet:**
- `completed` / `outcome: failure` / `businessResult: failure`, mit `countedTechnicalFailure: false` und `block: null`.
- Labels: `needs-maintainer,test:failure` (`coding` weg, `ready-for-coding` weg).
- Der Kommentar lautet `Needs maintainer: Simulierter fachlicher Fehler fuer …`.
- Kein neuer Start, weil `ready-for-coding` fehlt; `diag` zeigt das Item deshalb gar nicht mehr (Ausgabe leer).
  Es entsteht kein Block.

**Ist:** ☐ OK ☐ Abweichung: ……

### T10 – Issue vs. Pull Request (Reviewer-Filter, Dependencies an PRs)

**Ziel:**
- PRs erscheinen im Listing (`type: pull_request`, `is_pull_request: true`), obwohl die Maintainer-App nur *Issues: read*
  hat ([R4](#r4)).
- `reviewer-test` startet nur den PR. Ein Issue mit gleichem Label wird gefiltert.
- Dependencies sind an PRs auflösbar (offen, nicht dokumentiert).

**Schritte:**
```bash
gh pr edit $A_PR -R $(repo orch-test-a) --add-label ready-for-review
probe list test_a ready-for-review | jq '.[] | {key, type}'
probe deps test_a $A_PR
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$A_PR/dependencies/blocked_by" -w '\nHTTP %{http_code}\n'
sleep 25; diag reviewer-test | grep "test_a:$N_OK"          # Issue: dauerhaft filtered
sleep 70; RUN=$(run_of test_a $A_PR); echo "PR-Run: ${RUN:-keiner}"; api /runs/$RUN | jq '{status, outcome, identity}'
gh pr view $A_PR -R $(repo orch-test-a) --json labels,comments --jq '{labels: [.labels[].name], last: .comments[-1].author.login}'
```

**Erwartet:**
- `list` enthält `$A_PR` mit `type: pull_request` und das Issue aus T4 (`$N_OK`) mit `type: issue`.
- Für `deps` und den Rohaufruf gibt es zwei mögliche Ergebnisse:
  - (a) HTTP 200 `[]`, `status: ok`: Dependencies funktionieren an PRs.
  - (b) 404/403, `status: unknown`.

  **Ergebnis notieren.** Bei (b) startet `reviewer-test` den PR nie (`filter_unknown`). Dann muss der Dependency-Filter
  für PR-Workflows dokumentiert entfallen, siehe [5.2](#52-bei-abweichungen).
- `diag reviewer-test`: Das Issue `test_a:$N_OK` ist `filtered` (`is_pull_request` = false), in jedem Planungsschritt.
- Bei (a) gibt `run_of` einen Run für den PR. `diag` eignet sich dafür nicht: Es zeigt nur den letzten Schritt, und
  nach dem Start fehlt der PR dort (Label `ready-for-review` entfernt). Bei (b) gibt es keinen Run, `diag` zeigt
  `filter_unknown`.
- Der Run ist `completed` mit `identity: reviewer`.
- PR-Labels: `reviewed`. Der letzte Kommentar stammt von `<reviewer-slug>[bot]`.

**Ist:** ☐ OK ☐ Abweichung: …… (PR-Dependencies: ☐ a ☐ b)

### T11 – Dependency im selben Repo (A2, A5)

**Schritte:**
```bash
post /scheduler/pause >/dev/null
N_SAME=$(mkissue orch-test-a "T11 blocked by same repo" deps-test); echo "N_SAME=$N_SAME" >> tmp/testdata.env
blockedby orch-test-a $N_SAME orch-test-a $A_BLOCKER
gh issue edit $N_SAME -R $(repo orch-test-a) --add-label ready-for-coding
post /scheduler/resume >/dev/null; sleep 25
view dependencies
probe deps test_a $N_SAME
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$N_SAME/dependencies/blocked_by" | jq '[.[] | {number, state, repository_url}]'
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$N_SAME" | jq .issue_dependencies_summary
diag coder-test | grep "test_a:$N_SAME"
```

**Erwartet:**
- View/`deps`: `status ok`, `blocked_by_total 1`, `blocked_by_open 1`, `blocked true`.
- Die Rohliste enthält genau den Blocker mit `state: "open"` und `repository_url` `…/repos/<owner>/orch-test-a`.
- Summary: `{"blocked_by": 1, "total_blocked_by": 1, …}` (A5: zuerst nur die Gesamtzahl).
- `coder-test`: `filtered` (Trace `dependencies.blocked_by_open` = 1, erwartet 0).
- Gegenprobe A5: `gh issue close $A_BLOCKER -R $(repo orch-test-a)`. Danach ist die Summary `blocked_by: 0`,
  `total_blocked_by: 1`, und der nächste Poll startet `$N_SAME`. Den Blocker **wieder öffnen**
  (`gh issue reopen $A_BLOCKER -R $(repo orch-test-a)`), er wird später nicht mehr gebraucht.

**Ist:** ☐ OK ☐ Abweichung: ……

### T12 – Cross-Repo-Dependency mit Zugriff (A3)

**Schritte:**
```bash
post /scheduler/pause >/dev/null
N_CROSS=$(mkissue orch-test-a "T12/T14 blocked by orch-test-b" deps-test); echo "N_CROSS=$N_CROSS" >> tmp/testdata.env
blockedby_api orch-test-a $N_CROSS orch-test-b $B_BLOCKER      # bewusst über REST (issue_id), prüft auch den POST
gh issue edit $N_CROSS -R $(repo orch-test-a) --add-label ready-for-coding
post /scheduler/resume >/dev/null; sleep 25
view dependencies | grep -E "Nr|$N_CROSS"
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$N_CROSS/dependencies/blocked_by" | jq '[.[] | {number, state, repository_url, repo: .repository.full_name}]'
diag coder-test | grep "test_a:$N_CROSS"
```

**Erwartet:**
- `blockedby_api` gibt `blocked_by added: #<nr>` aus (HTTP 201; `gh api` zeigt den Status nicht). Laut Doku ist die
  Antwort ein Issue-Objekt: notieren, ob `<nr>` das blockierte Issue (`$N_CROSS`) oder der Blocker (`$B_BLOCKER`) ist.
- View: `ok / 1 / 1 / true`.
- Die Rohliste enthält den Blocker aus `orch-test-b` (`repository_url …/orch-test-b`).
- `coder-test`: `filtered`.

**Ist:** ☐ OK ☐ Abweichung: ……

### T13 – Cross-Repo-Dependency **ohne** Zugriff → `unknown` (A4, A6, §20.7 fail-closed)

**Schritte:**
```bash
post /scheduler/pause >/dev/null
N_HID=$(mkissue orch-test-a "T13 blocked by hidden repo" deps-test); echo "N_HID=$N_HID" >> tmp/testdata.env
blockedby orch-test-a $N_HID orch-test-hidden $H_BLOCKER       # als Mensch, der alle Repos sieht
gh issue edit $N_HID -R $(repo orch-test-a) --add-label ready-for-coding
gh issue view $N_HID -R $(repo orch-test-a) --json blockedBy --jq '.blockedBy'   # Mensch sieht den Blocker
post /scheduler/resume >/dev/null; sleep 25
view dependencies | grep -E "Nr|$N_HID"
probe deps test_a $N_HID
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$N_HID/dependencies/blocked_by" -w '\nHTTP %{http_code}\n'
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$N_HID" | jq .issue_dependencies_summary
diag coder-test | grep "test_a:$N_HID"
gh issue close $H_BLOCKER -R $(repo orch-test-hidden); sleep 25
view dependencies | grep -E "Nr|$N_HID"; diag coder-test | grep "test_a:$N_HID"
gh issue reopen $H_BLOCKER -R $(repo orch-test-hidden)
```

**Erwartet:**
- Der Mensch sieht den Blocker (`blockedBy` enthält `orch-test-hidden#…`).
- App-Rohantwort, **festhalten**, eine der folgenden Varianten:
  - (a) HTTP 200 `[]` und Summary `total_blocked_by: 1` (A4 wie angenommen),
  - (b) 403/404,
  - (c) 200 mit dem Blocker trotz fehlender Installation.
- Bei (a) und (b):
  - View: Status `unknown`, die anderen Spalten `?`.
  - `deps`: `blocked_by_*` mit `known: false` und Grund `… not visible to identity …` bzw. `dependencies unavailable …`.
  - `coder-test`: `filter_unknown`, **kein Start**.
- Auch nach dem Schließen des versteckten Blockers bleibt der Status `unknown`. Die App kann den Zustand nicht sehen,
  bleibt also fail-closed.
- Bei (c) ist A4 falsch: Das private Repo wäre über die Abhängigkeit lesbar. Unbedingt melden.

**Ist:** ☐ OK ☐ Abweichung: …… (Variante: ☐ a ☐ b ☐ c; Rohantwort ins Protokoll)

### T14 – Blocker schließen → nächster Poll startet (Szenario 3)

**Schritte:** Fortsetzung von T12, Blocker ist offen:
```bash
diag coder-test | grep "test_a:$N_CROSS"                     # filtered
gh issue close $B_BLOCKER -R $(repo orch-test-b); date -u +%T
for i in 1 2 3 4; do sleep 10; date -u +%T; echo "run: $(run_of test_a $N_CROSS)"; done   # leer, bis gestartet
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$N_CROSS" | jq .issue_dependencies_summary
```

**Erwartet:**
- Bis zum nächsten Planungsschritt gibt es keinen Run (das Issue bleibt `filtered`); ein früherer Start ist nicht
  möglich. Danach liefert `run_of` eine Run-ID (≤ 20 s + Schrittdauer nach dem Schließen; Zeitstempel vergleichen).
- Der Run ist `completed` / `success`.
- Summary: `blocked_by: 0`, `total_blocked_by: 1` (A5).

**Ist:** ☐ OK ☐ Abweichung: ……

### T15 – Zwei parallele Coder mit gleicher Identität, dritter durch Limit verhindert (Szenario 1)

**Schritte:**
```bash
post /scheduler/pause >/dev/null
P1=$(mkissue orch-test-a "T15 parallel 1" ready-for-coding test:slow)
P2=$(mkissue orch-test-a "T15 parallel 2" ready-for-coding test:slow)
P3=$(mkissue orch-test-a "T15 parallel 3" ready-for-coding test:slow)
post /scheduler/resume >/dev/null; sleep 15
api /status | jq '.usage.byWorkflow["coder-test"]'
for n in $P1 $P2 $P3; do echo "#$n run: $(run_of test_a $n)"; done
diag coder-test | grep "test_a:$P3"                         # solange 2 aktiv: workflow_limit
for n in $P1 $P2; do api /runs/$(run_of test_a $n) | jq -c '{id, identity, workspacePath, status}'; done
sleep 100; echo "#$P3 run: $(run_of test_a $P3)"
```

**Erwartet:**
- `byWorkflow` ist `{"active": 2, "max": 2}`. `$P1` und `$P2` haben einen Run (älteste zuerst), `$P3` keinen.
  `diag` zeigt `$P3` als `workflow_limit` (`workflow limit reached (2/2 active)`); die beiden gestarteten Items
  fehlen dort ab dem nächsten Schritt (Label `coding`), deshalb Starts über `run_of` prüfen.
- Beide Runs haben `identity: coder` und **verschiedene** `workspacePath`.
- Im Log gibt es **keine** zusätzliche `Obtained … coder`-Zeile für den zweiten Run (gemeinsamer Token-Cache).
- Nach Ende eines Runs startet `$P3` beim nächsten Poll (`run_of` liefert dann eine ID).

**Ist:** ☐ OK ☐ Abweichung: ……

### T16 – Manueller Start per URL, Lock-Konflikt (Szenario 2)

**Schritte:**
```bash
M=$(mkissue orch-test-a "T16 manuell, ohne ready-Label" test:slow)
post /workflows/coder-test/start "{\"item\":\"$(issue_url orch-test-a $M)\"}" | jq '{run: .run.id, trigger: .run.triggerType, status: .run.status}'
post /workflows/coder-test/start "{\"item\":\"$(issue_url orch-test-a $M)\"}" | jq .
post /workflows/coder-test/start "{\"item\":\"#$M\"}" | jq .error.code
post /workflows/coder-test/start "{\"item\":\"https://github.com/$ADISPATCH_TEST_OWNER/orch-test-b/issues/1\"}" | jq .error.code
post /workflows/coder-test/start "{\"item\":\"$(issue_url orch-test-a $N_HID)\"}" | jq '{run: .run.id, error: .error.code}'
```

**Erwartet:**
- Der 1. Start gibt `202` mit `triggerType: manual`, obwohl `ready-for-coding` fehlt (Filter wird umgangen).
- Der 2. und 3. Start geben `409`, `error.code: lock_conflict`, `details.holderRunId` = Run des 1. Starts.
- Eine fremde Repo-URL gibt `400 manual_item_invalid_ref`.
- `$N_HID` (Dependency `unknown`) startet manuell (`202`), weil Filter umgangen werden. Danach erscheinen beide Runs in
  `runs coder-test` mit `manual`.
- Der manuelle Run zählt zur Auslastung: `api /status | jq .usage`.

**Ist:** ☐ OK ☐ Abweichung: ……

### T17 – Drei Crashes → Retry-Block → Remove Block (Szenario 5)

**Schritte:**
```bash
C=$(mkissue orch-test-a "T17 crash" ready-for-coding test:crash); echo "C=$C" >> tmp/testdata.env
sleep 90; runs coder-test 10 | grep "test_a:$C"            # noch keine 3 crashed? 20 s warten, wiederholen
api /blocks | jq '.blocks[] | {id, workflowId, itemKey, reason, failureCount, affectedRunIds}'
labels orch-test-a $C; sleep 25; diag coder-test | grep "test_a:$C"
api '/notifications?limit=5' | jq -r '.notifications[] | .eventType' | sort | uniq -c
```

Nach dem Block das Crash-Label entfernen und den Block aufheben:
```bash
gh issue edit $C -R $(repo orch-test-a) --remove-label test:crash
BID=$(api /blocks | jq -r ".blocks[] | select(.itemKey==\"test_a:$C\") | .id")
post /blocks/$BID/clear '{"clearedBy":"manual-test"}' | jq '.block | {active, clearedBy}'
sleep 15; runs coder-test 10 | grep "test_a:$C"; labels orch-test-a $C
api "/runs?item=test_a:$C" | jq '.total'
```

**Erwartet:**
- Drei Runs `crashed` (`finalReason` mit Exit-Code 1). Die Ergebnisdatei mit `success` wird ignoriert.
- Nach jedem Crash setzt `on_crash` `ready-for-coding` wieder. Der nächste Poll startet erneut, bis zum 3. Crash.
- Danach entsteht genau ein aktiver Block (`failureCount: 3`, 3 `affectedRunIds`) und eine Notification
  `retry_block_created`.
- Das Label `ready-for-coding` bleibt stehen, und `diag` zeigt `blocked` (`retry block <id>: …`). Es gibt keinen
  4. Start.
- Nach `clear` folgt sofort ein Planungsschritt. Der neue Run ist `completed` / `success`, die Labels werden
  `ready-for-review`.
- `total` = 4: Die Historie bleibt vollständig.

**Ist:** ☐ OK ☐ Abweichung: ……

### T18 – Ungültige Ergebnisdatei und Worker-Token (Worker-Protokoll, `execute.secrets`)

**Schritte:**
```bash
I=$(mkissue orch-test-a "T18 invalid result" ready-for-coding test:invalid-result)
T=$(mkissue orch-test-a "T18 token" ready-for-coding test:token)
sleep 45; for n in $I $T; do api /runs/$(run_of test_a $n) | jq -c '{status, outcome, finalReason}'; done
api "/runs/$(run_of test_a $T)/logs?stream=stdout" | jq -r .data | grep 'HTTP'
gh issue edit $I -R $(repo orch-test-a) --remove-label ready-for-coding   # sonst Crash-Schleife bis Block
```

**Erwartet:**
- `$I`: `crashed` mit Grund „ungültige Ergebnisdatei“/Protokollfehler, `on_crash` lief.
- `$T`: `completed` / `success`. Das Log zeigt `GET issue with GH_TOKEN → HTTP 200`, das Token selbst taucht nicht auf.

**Ist:** ☐ OK ☐ Abweichung: ……

### T19 – Fehlende Rechte/Zugänge → sichtbarer Fehler statt stiller Annahme (§20.7, A6, A7)

Nach jedem Teil den Ausgangszustand wiederherstellen. Installationsänderungen wirken auf **neue** Tokens. Damit die
laufende Instanz sie sofort sieht, die Instanz neu starten (Drain), sonst bis zur Token-Erneuerung warten.

**T19a – Source-Identity verliert ein Repo.** Bei der Maintainer-App unter *Configure → Repository access* `orch-test-b`
entfernen, dann:
```bash
sleep 25; diag commenter-test | head -1
view needs-maintainer
orch workflow dry-run commenter-test --config-dir "$ADISPATCH_CFG" --local --data-dir "$ADISPATCH_DATA"; echo "exit=$?"
```

Erwartet:
- `status=source_error`, `error` z. B. `GET /repos/<owner>/orch-test-b/issues failed with HTTP 404: Not Found`. Kein
  Start, und andere Workflows laufen weiter.
- Die View zeigt die Zeilen aus `test_a` plus `ERROR test_b: …`.
- Der Dry-Run meldet `SOURCE ERROR`, Exit 1.
- Danach `orch-test-b` wieder hinzufügen.

**T19b – Schreib-Identity verliert ein Repo.** Bei der Coder-App `orch-test-a` aus dem Repository access entfernen,
Instanz neu starten:
```bash
post /scheduler/pause >/dev/null
W=$(mkissue orch-test-a "T19b ohne Schreibzugriff" ready-for-coding)
post /scheduler/resume >/dev/null; sleep 30; RUN=$(run_of test_a $W)
api /runs/$RUN | jq '{status, finalReason, lifecycleFailed, countedTechnicalFailure}'; actions $RUN
post /scheduler/pause >/dev/null; labels orch-test-a $W
```

Erwartet:
- Der Run ist `start_error` mit `finalReason` `on_start action 'on_start-labels' failed`. Der Fehler der Action
  (`actions $RUN`, letzte Spalte) lautet `Item <owner>/orch-test-a#<nr> not found`: Das Neu-Lesen in `applyUpdate`
  mit der Coder-Identity bekommt 404 und wertet es als „nicht gefunden“ (`fetchIssue` → `null`). Bei 403 stünde dort
  `… HTTP 403 …`. Der Worker wurde **nicht**
  gestartet.
- `on_start-labels` ist `failed`, und `on_start_error-labels` ist ebenfalls `failed` (gleiche Ursache).
- `lifecycleFailed: true`, und eine Notification `lifecycle_action_failed` entsteht.
- Die Labels bleiben unverändert (`ready-for-coding`). Ohne Pause würde der nächste Poll erneut starten, bis nach 3
  `start_error` ein Block entsteht. Das ist korrekt (Spec §11), aber zu beobachten.
- Danach den Zugriff wiederherstellen, `resume`, und ggf. den Block aufheben.

**T19c – fehlender Key.** Instanz stoppen, `unset ADISPATCH_TEST_MAINTAINER_KEY`, dann:
```bash
orch workflow dry-run coder-test --config-dir "$ADISPATCH_CFG" --local --data-dir "$ADISPATCH_DATA"
```

Erwartet: `SOURCE ERROR: … Private key for identity "maintainer" missing: environment variable ADISPATCH_TEST_MAINTAINER_KEY is not set`.
Mit einem kaputten Key (`export ADISPATCH_TEST_MAINTAINER_KEY=kaputt`) lautet die Meldung `… is not a valid RSA PEM key`.
Keine der Ausgaben enthält Key-Material. Danach den Key wieder setzen.

**T19d – Rechte-Granularität (A7, [R4](#r4)).**
1. Coder-App *Permissions & events*: *Pull requests* auf **No access** setzen und speichern. Die Installation übernimmt
   Rechte-**Reduktionen** in der Regel sofort; ob eine Bestätigung nötig ist, notieren.
2. Dann:
   ```bash
   probe labels test_a $A_PR coder +perm-test        # Label an PR nur mit Issues: write
   probe comment test_a $A_PR coder adispatchd:perm-pr:1 'PR-Kommentar nur mit Issues: write'
   ```
3. *Pull requests* wieder auf **Read and write** und *Issues* auf **Read-only** setzen. Die Erhöhung muss in der
   Installation bestätigt werden (*Review request* bzw. *Configure → Accept new permissions*). Dann:
   ```bash
   N=$(mkissue orch-test-a "T19d")
   probe labels test_a $N coder +perm-test           # Label an Issue nur mit Pull requests: write
   ghraw coder "/repos/$(repo orch-test-a)/issues/$N/labels" -X POST -d '{"labels":["perm-test"]}' -D - -o /dev/null | grep -i -E '^HTTP|x-accepted-github-permissions'
   probe labels test_a $A_PR coder +perm-test2       # Label an PR nur mit Pull requests: write
   ```
4. Ursprüngliche Rechte wiederherstellen (Issues und Pull requests: Read and write) und bestätigen.

Erwartet (laut Doku): Jede der Aktionen gelingt mit **einem** der beiden Rechte. Die Ergebnisse festhalten:

| Ziel | nur Issues: write | nur Pull requests: write |
|---|---|---|
| Label an Issue | ✔ (Basis) | ☐ ✔ ☐ ✘ |
| Label an PR | ☐ ✔ ☐ ✘ | ☐ ✔ ☐ ✘ |
| Kommentar an PR | ☐ ✔ ☐ ✘ | – |

Ein ✘ zeigt sich als `forbidden`, HTTP 403 `Resource not accessible by integration`, und
`x-accepted-github-permissions` nennt das nötige Recht. Ergebnis → Rechte-Tabelle 1.3, `README.md` und
`src/cli/init-templates.ts` (Kommentar in `identities.yaml`) anpassen.

**Ist:** a ☐ b ☐ c ☐ d ☐ OK ☐ Abweichung: ……

### T20 – Dry-Run gegen echte Repos (§19)

**Schritte:**
```bash
post /scheduler/pause >/dev/null
D=$(mkissue orch-test-a "T20 dry-run" ready-for-coding 'priority:high')
# frische blockierte Kandidaten (die aus T11–T13 sind inzwischen gestartet/umgelabelt); Blocker A/H sind offen
D_SAME=$(mkissue orch-test-a "T20 blocked same repo"); blockedby orch-test-a $D_SAME orch-test-a $A_BLOCKER
D_HID=$(mkissue orch-test-a "T20 blocked hidden");     blockedby orch-test-a $D_HID orch-test-hidden $H_BLOCKER
for n in $D_SAME $D_HID; do gh issue edit $n -R "$(repo orch-test-a)" --add-label ready-for-coding; done
before_labels=$(labels orch-test-a $D); before_runs=$(api /runs | jq .total)
orch workflow dry-run coder-test --config-dir "$ADISPATCH_CFG"                    # über die laufende Instanz (HTTP)
orch workflow dry-run coder-test --config-dir "$ADISPATCH_CFG" --local --data-dir "$ADISPATCH_DATA" --json | jq '.candidates[] | {itemKey, decision, itemPriority, reason}'
orch workflow dry-run reviewer-test --config-dir "$ADISPATCH_CFG"
[ "$(labels orch-test-a $D)" = "$before_labels" ] && [ "$(api /runs | jq .total)" = "$before_runs" ] && echo "unverändert"
post /scheduler/resume >/dev/null
```

**Erwartet:**
- Über HTTP: Gate `paused`, geeignete Kandidaten `gate_closed`. Lokal: `test_a:$D` ist `would_start` mit
  `itemPriority: 50` und steht vor anderen Kandidaten.
- `$D_HID` ist `filter_unknown`, `$D_SAME` ist `filtered` (Trace `dependencies.blocked_by_open` = 1).
  Nach `resume` bleiben beide ohne Run; zum Aufräumen `ready-for-coding` wieder entfernen.
- Blockierte Items erscheinen als `blocked`, aktive als `locked`.
- Labels, Kommentare und Runs bleiben unverändert (`unverändert`).
- Die Notes nennen „shell filters and conditions are never executed“.

**Ist:** ☐ OK ☐ Abweichung: ……

### T21 – View über zwei Repos (Szenario 10)

**Schritte:**
```bash
F=$(mkissue orch-test-b "T21 failure in repo b" ready-for-comment test:failure)
sleep 45; view needs-maintainer
api /views/needs-maintainer/items | jq '{cached, rows: [.rows[] | {key, url, lastRunId}], errors}'
```

Zusätzlich im Browser *Views → Needs Maintainer* öffnen.

**Erwartet:**
- Es gibt Zeilen aus **beiden** Repos: `test_a:$N_FAIL` (T9) und `test_b:$F`. Die Spalten „Letzter Agent“ zeigen
  `coder-test` bzw. `commenter-test`, „Ergebnis“ die `failure`-Nachricht, „Status“ `completed`.
- Außerdem erscheint `test_a:$N_T5` (T5): Das Label `needs-maintainer` wurde dort manuell gesetzt, das Issue hat
  **keinen** Run. Die Run-Spalten sind leer (`null`, nicht `?`), sortiert nach „Aktualisiert“. Weitere Zeilen nur für
  Items, die in anderen Fällen ebenfalls `needs-maintainer` bekamen.
- Der Titel ist ein klickbarer Link auf das GitHub-Issue.
- `errors: []`.
- Ein zweiter Aufruf ohne `refresh` innerhalb von 30 s liefert `cached: true`.

**Ist:** ☐ OK ☐ Abweichung: ……

### T22 – Rate-Limit beobachten (A8, [R8](#r8))

**Schritte:**
```bash
for i in maintainer coder; do echo "== $i"; ghraw $i /rate_limit | jq -c '.resources.core, (has("rate"))'; done
ghraw maintainer /rate_limit -D - -o /dev/null | grep -i '^x-ratelimit'
u1=$(ghraw maintainer /rate_limit | jq .resources.core.used); sleep 600
u2=$(ghraw maintainer /rate_limit | jq .resources.core.used); echo "maintainer: $((u2 - u1)) Requests in 10 min"
grep -E '"kind":"rate_limited"|retrying' tmp/orch.log | tail
```

**Erwartet:**
- `resources.core.limit` ≥ 5000. `has("rate")` ist `false` (API 2026-03-10).
- Die Header `x-ratelimit-limit|remaining|used|reset|resource` sind vorhanden.
- Verbrauch in 10 min ≈ 30 Polls × (Listing `coder-test` + Listing `reviewer-test` + Listing `commenter-test` +
  2 × Anzahl Kandidaten mit Dependency-Filter, deren günstiger Filter passt) plus View-Aufrufe. Bei rund 3 Kandidaten
  sind das etwa 300. Der Wert muss weit unter 5000/h bleiben. Messwert festhalten.
- Im Log stehen keine `rate_limited`-Einträge.

Ein echtes Rate-Limit wird **nicht** provoziert, weil das sekundäre Limit den Test-Account sperren kann. Die Behandlung
von 403/429, `retry-after` und `x-ratelimit-reset` ist in `http.test.ts` gegen Fake-Antworten geprüft. Tritt ein Limit
zufällig auf, Header und Logzeile festhalten.

**Ist:** ☐ OK ☐ Abweichung: ……

### T23 – Transferiertes Issue (A10, optional)

**Schritte:**
```bash
X=$(mkissue orch-test-a "T23 transfer")
gh issue transfer "$(issue_url orch-test-a $X)" "$(repo orch-test-b)"   # URL statt Nummer: nie das Repo im cwd
ghraw maintainer "/repos/$(repo orch-test-a)/issues/$X" -o /dev/null -w 'HTTP %{http_code} → %{redirect_url}\n'
probe item test_a $X; echo "exit=$?"
```

**Erwartet:** Der Rohaufruf gibt `HTTP 301` mit einer Ziel-URL im neuen Repo. `probe item` meldet `item … not found`,
weil `getItem` = `null` (fetch folgt dem Redirect, `repository_url` passt nicht).

**Ist:** ☐ OK ☐ Abweichung: ……

### T24 – Keine Secrets in Logs und Daten (§20.4)

**Schritte:** nach allen anderen Fällen.
```bash
PAT='ghs_[A-Za-z0-9_]{10,}|BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY|eyJhbGciOi'
grep -rlaE "$PAT" tmp/orch.log "$ADISPATCH_DATA" && echo "TREFFER!" || echo "sauber"      # -a: auch SQLite/WAL (binär)
command -v sqlite3 >/dev/null && sqlite3 -readonly "$ADISPATCH_DATA/adispatchd.sqlite" .dump | grep -cE "$PAT"
api /config/files | grep -c 'PRIVATE KEY'
```

**Erwartet:** `sauber`, der `sqlite3`-Dump ergibt `0` (falls `sqlite3` installiert) und `/config/files` ebenfalls `0`. Ein Treffer ist ein Fehler: die Datei notieren, **nicht** einchecken, den Key rotieren.

**Ist:** ☐ OK ☐ Abweichung: ……

### T25 – GitHub-Projects-Felder (WI-14, A12–A17)

Prüft `project.*` gegen echte Projekte, **org-eigen** (per App) und **user-eigen** (per `github_token`). Für den
Org-Teil muss `ADISPATCH_TEST_OWNER` eine Organisation sein; mit einem User-Account entfällt T25a.

**Vorbereitung:**
1. Der Maintainer-App (`orch-test-maintainer-…`) unter *Permissions → Organization permissions* **Projects: Read-only**
   geben und die geänderten Rechte in der Installation bestätigen.
2. `gh auth refresh -s project` (der Mensch legt Projekte an).
3. Ein Org-Projekt und ein User-Projekt anlegen, Felder ergänzen und je zwei Issues hinzufügen:
   ```bash
   gh project create --owner "$ADISPATCH_TEST_OWNER" --title orch-test-org --format json | jq .number   # → ORG_PROJECT
   gh project create --owner "@me" --title orch-test-user --format json | jq .number                  # → USER_PROJECT
   USER_LOGIN=$(gh api user --jq .login)
   for o in "$ADISPATCH_TEST_OWNER:$ORG_PROJECT" "$USER_LOGIN:$USER_PROJECT"; do
     owner=${o%%:*}; n=${o##*:}
     gh project field-create "$n" --owner "$owner" --name Priority --data-type SINGLE_SELECT --single-select-options "P0,P1,P2"
     gh project field-create "$n" --owner "$owner" --name Estimate --data-type NUMBER
     gh project field-create "$n" --owner "$owner" --name Due --data-type DATE
   done
   P1=$(mkissue orch-test-a "T25 ready"); P2=$(mkissue orch-test-a "T25 todo"); P3=$(mkissue orch-test-a "T25 not in project")
   for n in $P1 $P2; do
     gh project item-add "$ORG_PROJECT" --owner "$ADISPATCH_TEST_OWNER" --url "$(issue_url orch-test-a $n)"
     gh project item-add "$USER_PROJECT" --owner "$USER_LOGIN" --url "$(issue_url orch-test-a $n)"
   done
   ```
   Im Web-UI beider Projekte: `$P1` → *Status* `Ready`, *Priority* `P1`, *Estimate* `3`, *Due* ein Datum;
   `$P2` → *Status* `Todo`, sonst leer. Eine Iteration (Feld *Sprint*) optional anlegen und `$P1` zuordnen.
4. Für den User-Teil einen **klassischen** Token des Users mit `read:project` und `repo` (Test-Repos sind privat)
   anlegen und exportieren: `export ADISPATCH_TEST_PROJECT_TOKEN=…`. Zusätzlich (T25c) einen fine-grained Token mit
   *Issues: Read*, *Pull requests: Read* und – falls angeboten – *Projects: Read* probieren und das Ergebnis notieren.
5. Im kopierten Fixture (`$ADISPATCH_CFG`) die auskommentierten Blöcke aktivieren: `project` bei `test_a` in
   `sources.yaml` (Nummer/Owner eintragen) und `project_reader` in `identities.yaml`. Dazu
   `workflows/project-test.yaml` anlegen:
   ```bash
   cat > "$ADISPATCH_CFG/workflows/project-test.yaml" <<'EOF'
   id: project-test
   enabled: false
   trigger: { type: source, source: test_a }
   filter: { field: project.Status, operator: in, value: [Ready] }
   item_priority:
     rules: [ { when: { field: project.Priority, operator: equals, value: P1 }, value: 10 } ]
   execute: { type: shell, command: scripts/test-worker.sh }
   EOF
   orch config validate --config-dir "$ADISPATCH_CFG" && orch config reload --config-dir "$ADISPATCH_CFG"
   ```

**T25a – Org-Projekt per App:** `project: { number: $ORG_PROJECT, fields: { Status: single_select, Priority: single_select, Estimate: number, Due: date } }`
(ohne `owner`/`identity`).
```bash
orch workflow dry-run project-test --config-dir "$ADISPATCH_CFG" --json | jq '.candidates[] | {itemKey, decision, itemPriority, projectFields}'
```
**Erwartet:** `$P1` `would_start`/`workflow_unavailable` (Workflow ist disabled) mit `projectFields`
`Status: "Ready"`, `Priority: "P1"`, `Estimate: 3`, `Due: "YYYY-MM-DD"`, `itemPriority: 10`; `$P2` `filtered`
(`Status: "Todo"`, Rest `null`); `$P3` `filtered` mit allen Werten `null`. Danach der App das Recht *Projects* wieder
entziehen und erneut: alle `project.*` `known: false` mit Grund „GitHub project … unavailable: …“, Entscheidung
`filter_unknown`, im Log **eine** Warnung „GitHub project field unavailable“ (beim nächsten Poll keine weitere).
Rohantwort notieren: `ghraw maintainer /graphql -X POST -d '{"query":"query{repositoryOwner(login:\"'$ADISPATCH_TEST_OWNER'\"){... on Organization{projectV2(number:'$ORG_PROJECT'){id}}}}"}'`.

**T25b – Feldnamen und Arten:** in `sources.yaml` `status: single_select` (klein) eintragen → Werte wie in T25a
(A15). `Estimate: text` eintragen → nur `project.Estimate` unknown („has type NUMBER, but is declared as text“), die
anderen bekannt. `Nope: text` → `project.Nope` unknown („not found in GitHub project“).

**T25c – User-Projekt:** `project: { owner: <USER_LOGIN>, number: $USER_PROJECT, fields: {…} }` zuerst **ohne**
`identity` (also per App) → alle `project.*` unknown (A13; Fehlermeldung notieren). Dann `identity: project_reader`
→ Werte wie in T25a. Prüfen, dass nur die GraphQL-Requests den Token nutzen: im Log stehen keine Token-Werte.

**T25d – Kommentar-Marker mit Token-Identity (A17, optional):** `commenter-test` vorübergehend mit
`identity: project_reader` laufen lassen (Token braucht dann *Issues: write* im Test-Repo) und einen Retry wie in T7
auslösen. **Erwartet:** kein Duplikat; der Kommentar trägt `user.login = <USER_LOGIN>`, `user.type = "User"`.

**T25e – Rate-Limit/Abfragekosten (A16, beobachten):** `ghraw maintainer /rate_limit | jq .resources.graphql` vor und
nach einem Poll; Kosten pro Poll notieren (erwartet: wenige Punkte für Metadaten + ein Werte-Request je 50 Items).

**Ist:** ☐ OK ☐ Abweichung: ……

---

## 5 Auswertung und Aufräumen

### 5.1 Ergebnisse festhalten

Je Testlauf eine Zeile pro Fall. Bei Abweichungen gehören die Rohantworten (`ghraw …`) und die passenden Logzeilen
(`grep <run-id> tmp/orch.log`) dazu. Tokens vorher unkenntlich machen. Bleibt dieses Dokument im Repo, landen die
Ergebnisse in einem Issue oder PR.

| Datum | Commit | API-Version | gh-Version | Fall | Ergebnis | Beobachtung / Rohantwort |
|---|---|---|---|---|---|---|
| | | 2026-03-10 | | T1 | | |

Zusätzlich die offenen Fragen beantworten:

| Frage | Testfall | Antwort |
|---|---|---|
| Blocker ohne Zugriff: Variante a/b/c? Summary zählt sie mit? | T13 | |
| `issue_dependencies_summary.blocked_by` = offene Blocker? | T11, T14 | |
| Dependencies an PRs: 200 oder 404/403? | T10 | |
| Labels/Kommentare an PRs nur mit *Issues: write*? | T19d | |
| `user.type = Bot`, `performed_via_github_app.id = App-ID`? | T6 | |
| POST `blocked_by` gibt welches Issue zurück? | T12 | |
| Reduktion von App-Rechten sofort wirksam? | T19d | |
| User-Projekt mit App-Token: Fehlertyp/Meldung? Fine-grained PAT für User-Projekte möglich? | T25c | |
| `fieldValueByName` case-sensitiv? | T25b | |
| GraphQL-Kosten je Poll? | T25e | |

### 5.2 Bei Abweichungen

Vorgehen nach `docs/conventions.md`:
1. `FakeGitHub` an das echte Verhalten anpassen.
2. Einen fehlschlagenden Test schreiben.
3. Den Code korrigieren und `npm run check` laufen lassen.
4. Diese Anleitung und die Annahmen-Tabelle aktualisieren.

| Abweichung | Betroffene Stellen |
|---|---|
| A1 API-Version abgelehnt/veraltet | `GITHUB_API_VERSION` (`src/sources/github/http.ts`). `GH_API_VERSION` in `github-fixture/helpers.sh` und `scripts/test-worker.sh` mitziehen, `manual-fixture.test.ts` erzwingt das |
| A2/A3 andere Form der Blocker-Liste, Pagination | `resolveDependencies` (`src/sources/github/adapter.ts`), `FakeGitHub` Dependencies (`src/sources/github/testing/`) |
| A4 Variante b (403/404) | nichts nötig, fail-closed über den `catch`. Nur Fake ergänzen (`denyDependencies`) |
| A4 Variante c (Blocker trotz fehlendem Zugriff sichtbar) | sicherheitsrelevant: als GitHub-Verhalten dokumentieren. Der Adapter bleibt korrekt (zählt), aber Spec §20.7 und README ergänzen |
| A4 Summary zählt unsichtbare Blocker **nicht** | **kritisch**: fail-closed greift nicht, `blocked_by_open` wäre 0 → Start trotz Blocker. Mit App-Rechten ist das nicht erkennbar. Sofort dokumentieren (README, Spec §6/§20.7), dass alle Blocker-Repos für die Source-Identity installiert sein **müssen**. Code-Entscheidung als eigenes Work-Item: z. B. Option, Cross-Repo-Abhängigkeiten nur aus konfigurierten Sources zu akzeptieren |
| A5 Semantik vertauscht | nur relevant, falls der Code `blocked_by` nutzt (derzeit nicht) |
| A6 anderer Status bei fehlendem Recht | `GitHubHttpClient.toError` (Klassifikation). Für Dependencies unkritisch, jeder Fehler → `unknown` |
| A7 PR-Rechte | Doku: Tabelle 1.3, `README.md` („Rechte: …“), Kommentar in `src/cli/init-templates.ts` (`IDENTITIES_YAML`) |
| A8 Rate-Limit-Header anders | `GitHubHttpClient.toError` / `retryAfter`, `http.test.ts` |
| A9 Token-Laufzeit/JWT abgelehnt | `src/identities/jwt.ts` (`JWT_*`), `refreshMarginMs` in `github-app.ts`. Bei `iss`-Problemen Client-ID als neues Konfigfeld (`src/config/`, eigenes Work-Item) |
| A10 Transfer anders | `fetchIssue` / `sameRepoUrl` in `adapter.ts` |
| A11 Autor-Felder anders | `authorPredicate` in `adapter.ts`, `FakeGitHub.addComment` (`viaAppId`, `type`). Ohne `performed_via_github_app` ggf. `user.login === '<slug>[bot]'` über `describe()` (`IdentityDescription`, `src/core/types.ts`) |
| PR-Dependencies 404 (T10 b) | Doku: Dependency-Filter nicht für PR-Workflows (`reviewer-test`, README, Beispiel-Configs). Optional: `resolveDependencies` für `type: pull_request` → `ok/0` (Entscheidung nötig: fail-closed vs. „PRs haben keine Blocker“) |
| Retry erzeugt Duplikat (T7/T8) | `performSourceComment` (`src/lifecycle/performers.ts`), `findCommentByMarker` / `markerPattern` (`adapter.ts`) |
| A12–A16 GraphQL/Projects anders | `src/sources/github/project.ts` (Queries, Auswertung), `GitHubHttpClient.graphql`, `FakeGitHub` GraphQL (`src/sources/github/testing/fake-github.ts`), Doku §3.2/§4.7.1 der Konfigurationsreferenz |
| A13 User-Projekte auch per App lesbar bzw. nicht per Token | Doku (`configuration-reference.md` §3.2, README, `init`-Vorlage) |
| A17 Autor-Login anders | `authorPredicate` / `userLogin` in `adapter.ts` |
| Sekundäres Rate-Limit bei vielen Hooks | Drosselung schreibender Requests (≥ 1 s Abstand laut [R8](#r8)) in `GitHubHttpClient` fehlt. Als Folge-Work-Item aufnehmen |

### 5.3 Aufräumen

```bash
# 1. Instanz stoppen (im Start-Terminal Ctrl-C) bzw.:
orch drain --config-dir "$ADISPATCH_CFG" --wait
# 2. Lokale Testdaten und Probe entfernen
rm -rf tmp/orch-cfg tmp/orch-data tmp/orch.log tmp/testdata.env tmp/orch-test.env tmp/probe.ts
unset ADISPATCH_TEST_MAINTAINER_KEY ADISPATCH_TEST_CODER_KEY ADISPATCH_TEST_REVIEWER_KEY
# 3. Repos löschen (braucht Scope delete_repo)
gh auth refresh -s delete_repo
: "${ADISPATCH_TEST_OWNER:?ADISPATCH_TEST_OWNER setzen}"; type repo >/dev/null || { echo "helpers.sh nicht geladen"; false; } &&
for r in orch-test-a orch-test-b orch-test-hidden; do gh repo delete "$(repo $r)"; done   # fragt je Repo nach (Namen prüfen)
# 4. Private Keys lokal löschen
rm -P ~/orch-test-keys/*.pem 2>/dev/null || shred -u ~/orch-test-keys/*.pem; rmdir ~/orch-test-keys
```

Danach in GitHub für jede App:
1. *Settings → Applications → Installed GitHub Apps → Configure → Uninstall*.
2. *Developer settings → GitHub Apps → \<App> → Advanced → Delete GitHub App*. Damit werden auch die öffentlichen
   Schlüssel ungültig.
3. Prüfen, dass unter *Settings → Applications* keine `orch-test-*`-Installation übrig ist.

Soll dasselbe Setup für spätere Läufe bleiben, die Apps nur behalten, wenn die Keys sicher liegen. Zwischen den Läufen
reicht es, die Test-Repos neu anzulegen (Abschnitt 1.2/3) und die Installationen auf die neuen Repos zu setzen.
