#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
printf 'Vector Studio local server: http://localhost:8000\nPress Ctrl+C to stop.\n'
python3 -m http.server 8000
