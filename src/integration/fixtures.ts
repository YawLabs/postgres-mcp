/**
 * Shared fixture for integration tests. Creates a predictable schema
 * (`test_fixture`) with tables, views, functions, indexes, FKs, and a
 * quoted-name identifier so we can exercise every tool against a real DB.
 *
 * Gated on POSTGRES_MCP_INTEGRATION=1 so `npm test` without a DB stays fast.
 */

import { runInternal, shutdown } from "../api.js";

export const FIXTURE_SCHEMA = "test_fixture";

export function integrationEnabled(): boolean {
  return process.env.POSTGRES_MCP_INTEGRATION === "1";
}

/** Drop + recreate the fixture schema so each test run starts clean. */
export async function setupFixtures(): Promise<void> {
  const statements = [
    `DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`,
    `CREATE SCHEMA ${FIXTURE_SCHEMA}`,

    `CREATE TABLE ${FIXTURE_SCHEMA}.users (
       id SERIAL PRIMARY KEY,
       email TEXT NOT NULL UNIQUE,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       metadata JSONB
     )`,

    `CREATE TABLE ${FIXTURE_SCHEMA}.posts (
       id SERIAL PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES ${FIXTURE_SCHEMA}.users(id) ON DELETE CASCADE,
       title TEXT NOT NULL,
       body TEXT
     )`,
    `CREATE INDEX posts_user_id_idx ON ${FIXTURE_SCHEMA}.posts(user_id)`,

    // A quoted/awkward identifier — proves the validateIdent loosening works.
    `CREATE TABLE ${FIXTURE_SCHEMA}."Odd Table" (
       id SERIAL PRIMARY KEY,
       "weird-col" TEXT
     )`,

    `CREATE VIEW ${FIXTURE_SCHEMA}.user_post_counts AS
       SELECT u.id, u.email, COUNT(p.id) AS post_count
       FROM ${FIXTURE_SCHEMA}.users u
       LEFT JOIN ${FIXTURE_SCHEMA}.posts p ON p.user_id = u.id
       GROUP BY u.id, u.email`,

    `CREATE FUNCTION ${FIXTURE_SCHEMA}.user_count() RETURNS BIGINT
       LANGUAGE SQL AS $$ SELECT COUNT(*) FROM ${FIXTURE_SCHEMA}.users $$`,

    // Constraints fixture: CHECK + UNIQUE non-PK so describe_table.constraints
    // has rows to exercise. EXCLUDE needs btree_gist; skip to keep fixture
    // dependency-free.
    `CREATE TABLE ${FIXTURE_SCHEMA}.products (
       id SERIAL PRIMARY KEY,
       sku TEXT NOT NULL,
       price NUMERIC NOT NULL,
       CONSTRAINT products_sku_unique UNIQUE (sku),
       CONSTRAINT products_price_positive CHECK (price > 0)
     )`,

    // Partition fixture: declarative range partitioning so describe_table
    // returns partition_of (on a child) and partitions (on the parent).
    `CREATE TABLE ${FIXTURE_SCHEMA}.events (
       id BIGSERIAL,
       occurred_at DATE NOT NULL,
       payload TEXT,
       PRIMARY KEY (id, occurred_at)
     ) PARTITION BY RANGE (occurred_at)`,
    `CREATE TABLE ${FIXTURE_SCHEMA}.events_2026 PARTITION OF ${FIXTURE_SCHEMA}.events
       FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`,

    `INSERT INTO ${FIXTURE_SCHEMA}.users (email, metadata) VALUES
       ('a@example.com', '{"role":"admin"}'::jsonb),
       ('b@example.com', '{"role":"user"}'::jsonb),
       ('c@example.com', NULL)`,
    `INSERT INTO ${FIXTURE_SCHEMA}.posts (user_id, title, body) VALUES
       (1, 'hello', 'world'),
       (1, 'second', NULL),
       (2, 'another', 'post body')`,
  ];

  for (const sql of statements) {
    const res = await runInternal(sql);
    if (!res.ok) {
      throw new Error(`Fixture setup failed on statement:\n${sql}\n\nError: ${res.error}`);
    }
  }

  // Best-effort: enable HypoPG so pg_explain hypothetical_indexes tests can
  // exercise the positive path. If the binary isn't installed (e.g. PGDG
  // hasn't packaged it for this PG major yet), the test falls back to
  // exercising the "extension not installed" error path.
  await runInternal(`CREATE EXTENSION IF NOT EXISTS hypopg`);
}

/** Clean up the fixture schema and close the pool. */
export async function teardownFixtures(): Promise<void> {
  try {
    await runInternal(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
  } finally {
    await shutdown();
  }
}
