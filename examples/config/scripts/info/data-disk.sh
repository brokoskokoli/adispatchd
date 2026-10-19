#!/bin/sh
# Dashboard info script (dashboard.yaml, WI-24): disk usage of the data dir in percent.
# Contract: print the value on the first stdout line and exit 0.
set -eu
df -P "${ADISPATCH_DATA_DIR:-.}" | awk 'NR == 2 { sub("%", "", $5); print $5; exit }'
