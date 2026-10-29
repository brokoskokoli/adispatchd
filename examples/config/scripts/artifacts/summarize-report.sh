#!/bin/sh
# Example worker of workflows/summarize-report.yaml: "$1" is the read-only copy of the artifact (inputs/<name>).
set -eu
mkdir -p out
wc -c "$1" | awk '{ print "Report has " $1 " bytes" }' > out/summary.txt
printf '{"schema_version":1,"result":"success","message":"summary written"}' > "$ADISPATCH_RESULT_FILE"
