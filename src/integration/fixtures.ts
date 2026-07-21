/**
 * Shared fixture for integration tests. Creates a predictable schema
 * (`test_fixture`) with tables, views, functions, indexes, FKs, and a
 * quoted-name identifier so we can exercise every tool against a real DB.
 *
 * Gated on POSTGRES_MCP_INTEGRATION=1 so `npm test` without a DB stays fast.
 */

import { runInternal, shutdown } from "../api.js";

export const FIXTURE_SCHEMA = "test_fixture";

// Cluster-scoped role names used by pg_list_roles.member_of regression
// coverage. Roles can't live inside a schema, so they're cleaned up in
// teardownFixtures rather than dropped along with the schema CASCADE.
export const FIXTURE_GROUP_ROLE = "mcp_test_group";
export const FIXTURE_MEMBER_ROLE = "mcp_test_member";

// Limited-privilege login role used by the pg_replication_status _warnings
// partial-failure test. The role has CONNECT only -- no pg_monitor, no
// REPLICATION attribute. On a standalone cluster only ONE of the handler's
// three sub-queries is actually privilege-gated for this role: the
// wal_position fetch, pg_current_wal_lsn(). The slots (pg_replication_slots)
// and replicas (pg_stat_replication) sub-queries return empty rows even to a
// non-pg_monitor role on an instance with no slots / no replicas, so they
// succeed rather than warn. To force a real permission-denied the test also
// REVOKEs PUBLIC EXECUTE on pg_current_wal_lsn(); the role then hits 42501 on
// that one sub-query, and the handler must surface it via the _warnings array
// (rather than the pre-0.6.1 short-circuit return on first failure) while the
// slots/replicas results stay readable. Password is fixed so the test can
// construct the limited DATABASE_URL deterministically.
export const FIXTURE_LIMITED_ROLE = "mcp_test_restricted";
export const FIXTURE_LIMITED_PASSWORD = "restricted_pw";

export function integrationEnabled(): boolean {
  return process.env.POSTGRES_MCP_INTEGRATION === "1";
}

export const FDW_SERVER_NAME = "mcp_test_fdw_server";

/**
 * Best-effort: set up a self-referential postgres_fdw foreign table so the
 * suite can exercise the foreign-table branches of pg_describe_table and
 * pg_advisor. Returns true if the foreign table was created, false if
 * postgres_fdw is unavailable or DATABASE_URL can't be parsed.
 *
 * The SERVER and USER MAPPING are cluster-level objects and must be cleaned
 * up explicitly in teardownFixtures (DROP SCHEMA CASCADE removes the foreign
 * table but not the server).
 */
export async function setupFdwFixture(): Promise<boolean> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return false;

  let url: URL;
  try {
    // URL constructor rejects the postgres:// scheme; swap to http:// for parsing only.
    url = new URL(dbUrl.replace(/^postgres(?:ql)?:\/\//, "http://"));
  } catch {
    return false;
  }

  const host = url.hostname || "localhost";
  const port = url.port || "5432";
  const dbname = url.pathname.slice(1) || "postgres";
  const user = decodeURIComponent(url.username) || "postgres";
  const password = decodeURIComponent(url.password);

  // Single-quote-escape each value so embedded quotes don't break the OPTIONS clause.
  const q = (s: string) => s.replace(/'/g, "''");

  // Omit the password option entirely for trust-auth setups (empty password in
  // DATABASE_URL). Passing password='' to a trust-auth cluster causes some FDW
  // versions to reject the mapping with "authentication failed".
  const userMappingOpts = password
    ? ` OPTIONS (user '${q(user)}', password '${q(password)}')`
    : ` OPTIONS (user '${q(user)}')`;

  const statements = [
    `CREATE EXTENSION IF NOT EXISTS postgres_fdw`,
    `DROP SERVER IF EXISTS ${FDW_SERVER_NAME} CASCADE`,
    `CREATE SERVER ${FDW_SERVER_NAME} FOREIGN DATA WRAPPER postgres_fdw` +
      ` OPTIONS (host '${q(host)}', port '${q(port)}', dbname '${q(dbname)}')`,
    `CREATE USER MAPPING FOR CURRENT_USER SERVER ${FDW_SERVER_NAME}` + userMappingOpts,
    // A foreign table with no defined PK -- exercises pg_describe_table.
    `CREATE FOREIGN TABLE ${FIXTURE_SCHEMA}.remote_users` +
      ` (id integer NOT NULL, email text NOT NULL)` +
      ` SERVER ${FDW_SERVER_NAME}` +
      ` OPTIONS (schema_name '${q(FIXTURE_SCHEMA)}', table_name 'users')`,
  ];

  for (const sql of statements) {
    const res = await runInternal(sql);
    if (!res.ok) {
      console.error(`[FDW fixture] statement failed, skipping FDW tests:\n  ${sql.slice(0, 120)}\n  error: ${(res as { error?: string }).error ?? "unknown"}`);
      return false;
    }
  }
  return true;
}

/**
 * Guard for tests that mutate pg_catalog grants (e.g. REVOKE EXECUTE on a
 * built-in function). A hard process kill between REVOKE and GRANT leaves the
 * cluster broken until manually repaired, so these tests only run when the
 * caller explicitly opts in with POSTGRES_MCP_DESTRUCTIVE_TESTS=1 -- meaning
 * the cluster is disposable (CI, ephemeral Docker, etc.).
 */
export function destructiveTestsEnabled(): boolean {
  return process.env.POSTGRES_MCP_DESTRUCTIVE_TESTS === "1";
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

    // A quoted/awkward identifier - proves the validateIdent loosening works.
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

    // Advisor fixture: a heap table with no primary key. Used by the
    // pg_advisor tables_without_primary_key check.
    `CREATE TABLE ${FIXTURE_SCHEMA}.no_pk_table (id INT, label TEXT)`,

    // Advisor fixture: a partitioned table parent with NO primary key.
    // pg_advisor must flag this (relkind='p' coverage). The negative case
    // is covered by `events` above, which is also partitioned but DOES
    // have a PK.
    `CREATE TABLE ${FIXTURE_SCHEMA}.no_pk_partitioned (id INT, occurred_at DATE)
       PARTITION BY RANGE (occurred_at)`,

    // Materialized view fixture: covers the `includeMaterialized` true /
    // false branches of pg_list_views and the relkind='m' bucket of
    // pg_list_tables (when includeViews is true).
    `CREATE MATERIALIZED VIEW ${FIXTURE_SCHEMA}.user_post_counts_mv AS
       SELECT u.id, u.email, COUNT(p.id) AS post_count
       FROM ${FIXTURE_SCHEMA}.users u
       LEFT JOIN ${FIXTURE_SCHEMA}.posts p ON p.user_id = u.id
       GROUP BY u.id, u.email`,

    // Advisor fixture: a sequence advanced to 80% of its max so pg_advisor
    // sequence_exhaustion has a positive case to flag. MAXVALUE 1000 keeps
    // the arithmetic obvious; setval(800) puts it well past the 50% default
    // threshold and tests the numeric-precision formula 0.5.2 introduced.
    `CREATE SEQUENCE ${FIXTURE_SCHEMA}.near_full_seq MAXVALUE 1000`,
    `SELECT setval('${FIXTURE_SCHEMA}.near_full_seq', 800)`,

    `INSERT INTO ${FIXTURE_SCHEMA}.users (email, metadata) VALUES
       ('a@example.com', '{"role":"admin"}'::jsonb),
       ('b@example.com', '{"role":"user"}'::jsonb),
       ('c@example.com', NULL)`,
    `INSERT INTO ${FIXTURE_SCHEMA}.posts (user_id, title, body) VALUES
       (1, 'hello', 'world'),
       (1, 'second', NULL),
       (2, 'another', 'post body')`,

    // Roles fixture for pg_list_roles.member_of regression test. The 0.3.1
    // fix cast member_of to text[] so node-pg returns a JS string[] instead
    // of the raw postgres text form `{a,b}`. Without an actual membership in
    // the cluster, every member_of is `[]` and the cast is never exercised.
    // Drops are idempotent so reruns stay green even after a prior crash.
    `DROP ROLE IF EXISTS ${FIXTURE_MEMBER_ROLE}`,
    `DROP ROLE IF EXISTS ${FIXTURE_GROUP_ROLE}`,
    `CREATE ROLE ${FIXTURE_GROUP_ROLE} NOLOGIN`,
    `CREATE ROLE ${FIXTURE_MEMBER_ROLE} NOLOGIN`,
    `GRANT ${FIXTURE_GROUP_ROLE} TO ${FIXTURE_MEMBER_ROLE}`,

    // Limited login role for the pg_replication_status _warnings test.
    // CONNECT is granted to PUBLIC by default on every postgres database,
    // so we don't need an explicit GRANT here -- the role can connect but
    // can't read any of the replication-monitoring views/functions because
    // it has no pg_monitor / REPLICATION attribute.
    `DROP ROLE IF EXISTS ${FIXTURE_LIMITED_ROLE}`,
    `CREATE ROLE ${FIXTURE_LIMITED_ROLE} LOGIN PASSWORD '${FIXTURE_LIMITED_PASSWORD}'`,
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

  // Best-effort: set up a self-referential FDW foreign table so foreign-table
  // branches of pg_describe_table and pg_advisor can be exercised.
  _fdwAvailable = await setupFdwFixture();
}

// Tracks whether the FDW foreign table fixture was successfully created.
// Reset by each setupFixtures() call so parallel-file runs stay independent.
let _fdwAvailable = false;

/** True when the postgres_fdw foreign table fixture is in place. */
export function fdwFixtureAvailable(): boolean {
  return _fdwAvailable;
}

/** Clean up the fixture schema, drop cluster-scoped roles, close the pool. */
export async function teardownFixtures(): Promise<void> {
  try {
    await runInternal(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    // FDW server is a cluster-level object not removed by schema CASCADE.
    await runInternal(`DROP SERVER IF EXISTS ${FDW_SERVER_NAME} CASCADE`);
    // Order matters: drop the member before the group it belongs to so
    // there's no dangling role-membership row.
    await runInternal(`DROP ROLE IF EXISTS ${FIXTURE_MEMBER_ROLE}`);
    await runInternal(`DROP ROLE IF EXISTS ${FIXTURE_GROUP_ROLE}`);
    await runInternal(`DROP ROLE IF EXISTS ${FIXTURE_LIMITED_ROLE}`);
  } finally {
    await shutdown();
  }
}
