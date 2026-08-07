#!/bin/bash
set -euo pipefail

# Seeds a pgvector fixture that trips both readiness vector rules:
#   documents — 100k rows, vector column, NO approximate index  → vector-index-missing
#   chunks    — 100k rows, ivfflat index with lists = 4          → ivfflat-lists-mismatch
#                (sqrt(100000) ≈ 316; the accepted 4x band is 79–1265)
#
# Target: the cm-pg-vector container (postgres:16 + pgvector) on host port 5434.

ROWS="${1:-100000}"

# SECURITY: $ROWS is interpolated directly into SQL below (generate_series(1,
# $ROWS)) inside a psql -c string. Validate it as a positive decimal integer
# BEFORE any psql command runs — an unvalidated argument here is a SQL
# injection vector (e.g. `1)); DROP TABLE documents; --`).
if ! [[ "$ROWS" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: rows argument must be a positive integer (got: '$ROWS')" >&2
    exit 1
fi

PSQL=(podman exec cm-pg-vector psql -U crisismode -v ON_ERROR_STOP=1)

echo "💉 Seeding pgvector fixture ($ROWS rows per table)..."

"${PSQL[@]}" -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "   📄 documents — vector column, no index"
"${PSQL[@]}" -c "
    DROP TABLE IF EXISTS documents;
    CREATE TABLE documents (id bigserial PRIMARY KEY, embedding vector(3));
    INSERT INTO documents (embedding)
    SELECT ARRAY[random(), random(), random()]::vector
    FROM generate_series(1, $ROWS);
    ANALYZE documents;"

echo "   📄 chunks — ivfflat index with a deliberately wrong lists value"
"${PSQL[@]}" -c "
    DROP TABLE IF EXISTS chunks;
    CREATE TABLE chunks (id bigserial PRIMARY KEY, embedding vector(3));
    INSERT INTO chunks (embedding)
    SELECT ARRAY[random(), random(), random()]::vector
    FROM generate_series(1, $ROWS);
    CREATE INDEX chunks_embedding_idx ON chunks
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 4);
    ANALYZE chunks;"

echo ""
echo "   📊 Seeded catalog state:"
"${PSQL[@]}" -c "
    SELECT c.relname AS table_name, c.reltuples::bigint AS row_estimate
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname IN ('documents', 'chunks') AND n.nspname = 'public';"
"${PSQL[@]}" -c "
    SELECT ic.relname AS index_name, am.amname AS access_method, ic.reloptions
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
    WHERE am.amname IN ('ivfflat', 'hnsw');"

echo ""
echo "   Run readiness against it:"
echo "     DATABASE_URL=postgresql://crisismode:crisismode@localhost:5434/crisismode node \$BUNDLE readiness --json"
echo "   To clear, run: ./reset-pgvector.sh"
