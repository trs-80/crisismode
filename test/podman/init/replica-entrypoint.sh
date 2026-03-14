#!/bin/bash
set -e

# If data directory is empty, bootstrap from primary via pg_basebackup
PGDATA="/var/lib/postgresql/data"

if [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
    echo "Replica data directory empty — running pg_basebackup from primary..."

    # Wait for primary to be ready
    until pg_isready -h pg-primary -p 5432 -U replicator; do
        echo "Waiting for primary..."
        sleep 2
    done

    PGPASSWORD=replicator pg_basebackup \
        -h pg-primary \
        -p 5432 \
        -U replicator \
        -D "$PGDATA" \
        -Fp -Xs -P -R \
        -S replica_1

    # pg_basebackup with -R creates standby.signal and sets primary_conninfo
    # in postgresql.auto.conf automatically

    chown -R postgres:postgres "$PGDATA"
    chmod 700 "$PGDATA"

    echo "pg_basebackup complete. Starting replica."
fi

# Start PostgreSQL as the postgres user
exec su-exec postgres postgres -D "$PGDATA" \
    -c hot_standby=on \
    -c primary_conninfo="host=pg-primary port=5432 user=replicator password=replicator"
