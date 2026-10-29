#!/bin/sh
# Example worker of workflows/make-report.yaml: writes the files that execute.artifacts collects.
set -eu
mkdir -p out/site
printf 'Report created at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > out/report.txt
printf '<h1>Report</h1>\n' > out/site/index.html
printf '{"schema_version":1,"result":"success","message":"report written"}' > "$ADISPATCH_RESULT_FILE"
