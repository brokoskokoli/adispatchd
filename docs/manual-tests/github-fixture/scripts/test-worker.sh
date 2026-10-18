#!/bin/sh
# Test-Worker für docs/manual-tests/github.md. Simuliert je nach Issue-Label das Worker-Verhalten
# (Worker-Protokoll: docs/worker-protocol.md, Spec §8.2):
#
#   (kein test:*-Label)  Exit 0 + Ergebnis success                → on_success
#   test:slow            vorher TEST_SLOW_SECONDS (Default 90) schlafen, alle 10 s ein progress-Event
#   test:failure         Exit 0 + Ergebnis failure (fachlich)     → on_failure, kein Retry-Zähler
#   test:crash           Ergebnis success schreiben, dann Exit 1  → crashed (Datei wird ignoriert), on_crash
#   test:invalid-result  Exit 0 + ungültige Ergebnisdatei         → crashed (Protokollfehler)
#   test:token           GH_TOKEN (execute.secrets) gegen die API prüfen; Exit 1, falls nicht HTTP 200
#   test:revoke-token    GH_TOKEN per DELETE /installation/token widerrufen (erzwingt Token-Erneuerung im
#                        Orchestrator: nächster Aufruf der Identity → 401 → invalidate → neues Token)
#
# Labels kombinierbar (z. B. test:slow + test:failure). Argumente: $1 = Issue-Nummer, $2 = owner/repo.
set -eu

number="${1:-?}"
repo="${2:-?}"
slow="${TEST_SLOW_SECONDS:-90}"

# Labels aus der Kontextdatei lesen (source.attributes.labels). node ist vorhanden, weil der Orchestrator
# damit läuft; Fallback grep (Labels stehen als JSON-Strings in der Datei).
labels=""
if command -v node >/dev/null 2>&1; then
  labels="$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.env.ADISPATCH_CONTEXT_FILE, "utf8"));
    const l = (c.source && c.source.attributes && c.source.attributes.labels) || [];
    process.stdout.write(l.join("\n"));
  ')"
else
  labels="$(grep -o '"test:[a-z-]*"' "${ADISPATCH_CONTEXT_FILE}" | tr -d '"' || true)"
fi
has() { printf '%s\n' "${labels}" | grep -qx "$1"; }

# Ergebnis atomar schreiben (temporäre Datei im selben Verzeichnis + mv).
write_result() { # $1 = success|failure, $2 = message
  tmp="${ADISPATCH_RESULT_FILE}.tmp.$$"
  msg="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"schema_version":1,"result":"%s","message":"%s","details":{"repo":"%s","number":"%s"}}\n' \
    "$1" "${msg}" "${repo}" "${number}" > "${tmp}"
  mv "${tmp}" "${ADISPATCH_RESULT_FILE}"
}

echo "test-worker: run ${ADISPATCH_RUN_ID} workflow ${ADISPATCH_WORKFLOW_ID} item ${repo}#${number}"
echo "test-worker: labels: $(printf '%s' "${labels}" | tr '\n' ' ')"
echo "test-worker: workspace ${ADISPATCH_WORKSPACE}"
echo '@@ADISPATCH_EVENT {"type":"status","message":"test-worker gestartet"}'

if has test:token; then
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${GH_TOKEN:-missing}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "https://api.github.com/repos/${repo}/issues/${number}")"
  echo "test-worker: GET issue with GH_TOKEN → HTTP ${code}"
  [ "${code}" = "200" ] || { echo "test-worker: GH_TOKEN rejected" >&2; exit 1; }
fi

if has test:revoke-token; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer ${GH_TOKEN:-missing}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "https://api.github.com/installation/token")"
  echo "test-worker: DELETE /installation/token → HTTP ${code} (expected 204)"
fi

if has test:slow; then
  elapsed=0
  while [ "${elapsed}" -lt "${slow}" ]; do
    printf '@@ADISPATCH_EVENT {"type":"progress","value":%s}\n' "$((elapsed * 100 / slow))"
    echo "test-worker: working ${elapsed}/${slow}s"
    sleep 10
    elapsed=$((elapsed + 10))
  done
fi

if has test:crash; then
  write_result success "wird ignoriert, weil Exit != 0"
  echo "test-worker: simulating crash (exit 1)" >&2
  exit 1
fi

if has test:invalid-result; then
  tmp="${ADISPATCH_RESULT_FILE}.tmp.$$"
  printf '%s\n' '{"schema_version":1,"result":"maybe"}' > "${tmp}"
  mv "${tmp}" "${ADISPATCH_RESULT_FILE}"
  echo "test-worker: wrote invalid result file"
  exit 0
fi

if has test:failure; then
  write_result failure "Simulierter fachlicher Fehler fuer ${repo}#${number}"
  echo '@@ADISPATCH_EVENT {"type":"question","message":"Anforderungen unklar (simuliert)"}'
  exit 0
fi

write_result success "Simulierter Erfolg fuer ${repo}#${number}"
echo '@@ADISPATCH_EVENT {"type":"progress","value":100}'
exit 0
