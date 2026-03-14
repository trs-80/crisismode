#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$COMPOSE_DIR"

echo "🛑 Stopping CrisisMode test environment..."
podman-compose down

echo ""
echo "🧹 Remove volumes too? (data will be lost)"
read -r -p "   [y/N] " response
if [[ "$response" =~ ^[Yy]$ ]]; then
    podman-compose down -v
    echo "   Volumes removed."
else
    echo "   Volumes preserved. Data will persist on next start."
fi

echo "✅ Done."
