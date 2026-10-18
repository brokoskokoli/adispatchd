# Shell-Helfer für docs/manual-tests/github.md – NICHT vom Orchestrator ausgeführt, sondern in der eigenen
# Shell geladen (bash oder zsh), im Repo-Root:
#
#   export ADISPATCH_TEST_OWNER=<account-oder-org>
#   source docs/manual-tests/github-fixture/helpers.sh
#
# Benötigt: gh (angemeldet als Maintainer-Mensch, Zugriff auf alle drei Test-Repos), curl, jq, openssl, npx.

: "${ADISPATCH_TEST_OWNER:?ADISPATCH_TEST_OWNER setzen (GitHub-Account oder Org der Test-Repos)}"
export ADISPATCH_CFG="${ADISPATCH_CFG:-$PWD/tmp/orch-cfg}"
export ADISPATCH_DATA="${ADISPATCH_DATA:-$PWD/tmp/orch-data}"
export API="${API:-http://127.0.0.1:8791/api/v1}"
export GH_API_VERSION="${GH_API_VERSION:-2026-03-10}"   # = GITHUB_API_VERSION in src/sources/github/http.ts

# --- Orchestrator ------------------------------------------------------------------------------------------
orch() { npx tsx src/cli/main.ts "$@"; }                                   # CLI aus dem Checkout
api() { curl -sS "$API$1"; }                                               # GET gegen die API
post() {                                                                   # POST mit CSRF-Header
  local body="${2:-}"
  [ -n "$body" ] || body='{}'
  curl -sS -X POST -H 'X-Adispatch-Request: 1' -H 'Content-Type: application/json' -d "$body" "$API$1"
}
runs() {                                                                   # runs <workflow> [limit]
  api "/runs?workflow=$1&limit=${2:-10}" |
    jq -r '.runs[] | [.id, .sourceItemKey, .status, .outcome, (.businessResult // "-"), .lifecycleStatus, (.finalReason // "")] | @tsv'
}
run_of() {                                                                 # run_of <source> <nr> → neueste Run-ID
  api "/runs?item=$1:$2&limit=1" | jq -r '.runs[0].id // empty'
}
diag() {                                                                   # diag <workflow> → letzte Planungsdiagnose
  api "/workflows/$1" | jq -r '.diagnosis // {} | "status=\(.status) polled=\(.polled) error=\(.error) pushdown=\(.pushdown | tojson)",
    (.candidates // [] | .[] | [.itemKey, .decision, (.reason // "")] | @tsv)'
}
actions() {                                                                # actions <run-id> → Action-Journal
  api "/runs/$1" | jq -r '.actions[] | [.id, .hook, .ordinal, .type, .status, "attempts=\(.attempts)", (.externalKey // "-"), (.lastError.message // "")] | @tsv'
}
events() { api "/runs/$1/events?limit=1000" | jq -c '.events[] | {type, payload}'; }   # events <run-id>
view() {                                                                   # view <view-id> → Tabelle (frisch, ohne Cache)
  api "/views/$1/items?refresh=true" |
    jq -r '(.columns | map(.label) | @tsv), (.rows[] | .cells | map(if .known then (.value | tostring) else "?" end) | @tsv), (.errors[] | "ERROR \(.sourceId): \(.message)")'
}

# --- GitHub (als Mensch über gh) ---------------------------------------------------------------------------
repo() { printf '%s/%s' "$ADISPATCH_TEST_OWNER" "$1"; }                         # repo orch-test-a → owner/orch-test-a
issue_url() { printf 'https://github.com/%s/issues/%s' "$(repo "$1")" "$2"; }
mkissue() {                                                                # mkissue <repo> <titel> [label ...] → Nummer
  local r="$1" title="$2" l
  shift 2
  local args=()
  for l in "$@"; do args+=(--label "$l"); done
  gh issue create -R "$(repo "$r")" --title "$title" --body "adispatchd manual test: $title" "${args[@]}" | sed 's#.*/##'
}
blockedby() {                                                              # blockedby <repo> <nr> <blocker-repo> <blocker-nr>
  gh issue edit "$2" -R "$(repo "$1")" --add-blocked-by "$(issue_url "$3" "$4")"
}
blockedby_api() {                                                          # wie blockedby, über REST (issue_id = Datenbank-ID!)
  local id
  id="$(gh api "repos/$(repo "$3")/issues/$4" --jq .id)" || return 1
  gh api -X POST "repos/$(repo "$1")/issues/$2/dependencies/blocked_by" -H "X-GitHub-Api-Version: $GH_API_VERSION" \
    -F issue_id="$id" --jq '"blocked_by added: #\(.number)"'
}
unblock_api() {                                                            # unblock_api <repo> <nr> <blocker-repo> <blocker-nr>
  local id
  id="$(gh api "repos/$(repo "$3")/issues/$4" --jq .id)" || return 1
  gh api -X DELETE "repos/$(repo "$1")/issues/$2/dependencies/blocked_by/$id" -H "X-GitHub-Api-Version: $GH_API_VERSION" --jq '.number'
}
labels() { gh issue view "$2" -R "$(repo "$1")" --json labels --jq '[.labels[].name] | sort | join(",")'; }   # labels <repo> <nr>
comments() {                                                               # comments <repo> <nr> → id, Autor, Typ, App-ID, letzte Zeile
  gh api --paginate "repos/$(repo "$1")/issues/$2/comments" \
    --jq '.[] | [.id, .user.login, .user.type, (.performed_via_github_app.id // "-" | tostring), (.body | split("\n") | last)] | @tsv'
}

# --- GitHub (als App) --------------------------------------------------------------------------------------
probe() { npx tsx tmp/probe.ts "$@"; }                                      # siehe github.md, Abschnitt 2.4
ghraw() {                                                                  # ghraw <identity> <pfad> [curl-Optionen] → Rohantwort als App
  local identity="$1" path="$2" token
  shift 2
  token="$(probe token "$identity" 2>/dev/null)" || { echo "kein Token für $identity" >&2; return 1; }
  curl -sS -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: $GH_API_VERSION" "$@" "https://api.github.com$path"
}
app_jwt() {                                                                # app_jwt <app-id> <pem-datei> → JWT (9 min)
  local now h p s
  now="$(date +%s)"
  h="$(printf '{"alg":"RS256","typ":"JWT"}' | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  p="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$1" | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  s="$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign "$2" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  printf '%s.%s.%s' "$h" "$p" "$s"
}
installation_id() {                                                        # installation_id <app-id> <pem-datei> <repo>
  curl -sS -H "Authorization: Bearer $(app_jwt "$1" "$2")" -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: $GH_API_VERSION" "https://api.github.com/repos/$(repo "$3")/installation" | jq '{id, app_id, app_slug, repository_selection, permissions}'
}
