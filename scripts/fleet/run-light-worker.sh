#!/bin/bash
set -euo pipefail

SINCE="${ELANOUS_FLEET_USAGE_SINCE:-24h}"
if [[ "$SINCE" = *[!a-zA-Z0-9smhdw]* ]]; then
  echo "invalid usage lookback window" >&2
  exit 2
fi
exec elanous logs --all --include-test --event llm-usage --since "$SINCE" --limit 50000 --json --json-data
