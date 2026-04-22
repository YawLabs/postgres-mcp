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
}

/** Clean up the fixture schema and close the pool. */
export async function teardownFixtures(): Promise<void> {
  try {
    await runInternal(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
  } finally {
    await shutdown();
  }
}
