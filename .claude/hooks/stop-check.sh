#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! npx tsc --noEmit; then
  echo "Stop hook: tsc failed" >&2
  exit 2
fi
if ! npm test; then
  echo "Stop hook: npm test failed" >&2
  exit 2
fi
exit 0
