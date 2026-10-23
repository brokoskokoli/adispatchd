#!/bin/sh
# Options of the parameter "target" of workflows/release.yaml (options_from.command, WI-31).
# One option per line – or a JSON list of strings / {"value": "...", "label": "..."} objects.
# Arguments arrive without a shell: "$1" = --env, "$2" = prod.
set -eu
env="${2:-prod}"
printf '[{"value":"web-1.%s","label":"Web 1 (%s)"},{"value":"web-2.%s","label":"Web 2 (%s)"}]\n' "$env" "$env" "$env" "$env"
