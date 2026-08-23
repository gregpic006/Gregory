#!/usr/bin/env bash
# Lance l'API et l'interface en mode developpement.
set -euo pipefail
cd "$(dirname "$0")/.."

./.venv/bin/python -m jarvis_core.cli serve &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT

sleep 2
(cd ui && npm run dev)
