#!/bin/bash
set -euo pipefail

# Drops the pgvector fixture tables seeded by inject-pgvector-unindexed.sh.
# The extension itself is left installed — that is the state a real pgvector
# user is in, and the "extension present, no vector tables" case is worth
# being able to test on its own.

echo "🔄 Dropping pgvector fixture tables..."
podman exec cm-pg-vector psql -U crisismode -v ON_ERROR_STOP=1 -c \
    "DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS chunks;"
echo "   ✅ documents and chunks dropped"
