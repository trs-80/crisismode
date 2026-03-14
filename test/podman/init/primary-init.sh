#!/bin/bash
set -e

# Create replication user
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'replicator';
    SELECT pg_create_physical_replication_slot('replica_1');
EOSQL

# Create a test table with sample data for recovery scenarios
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        total DECIMAL(10,2),
        created_at TIMESTAMPTZ DEFAULT NOW()
    );

    INSERT INTO orders (customer_id, status, total)
    SELECT
        (random() * 1000)::int,
        (ARRAY['pending','processing','shipped','delivered'])[floor(random()*4+1)],
        (random() * 500)::decimal(10,2)
    FROM generate_series(1, 10000);

    -- Create indexes to make queries more realistic
    CREATE INDEX idx_orders_customer ON orders(customer_id);
    CREATE INDEX idx_orders_status ON orders(status);
    CREATE INDEX idx_orders_created ON orders(created_at);
EOSQL

echo "Primary initialization complete: replication user, slot, and test data created."
