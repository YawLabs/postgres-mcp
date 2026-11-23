// SERIALIZATION: see the note at the top of query.integration.test.ts. This file
// swaps process.env and rebuilds the shared pool between tests.
//
// Every exploit here is contained: a dedicated schema, loopback only, and no
// statement reaches outside the test database.

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import pg from "pg";
import { getApplicationName, getPool, runReadOnly, shutdown } from "../api.js";
import { runRolePreflight } from "../preflight.js";
import { explainTools } from "../tools/explain.js";
import { queryTools } from "../tools/query.js";
import { integrationEnabled } from "./fixtures.js";

const SCHEMA = "pgmcp_security_test";
const LIMITED_ROLE = "pgmcp_security_reader";
const LIMITED_PASSWORD = "not-a-real-secret";
// Role-check cases. Each holds a database-level grant, so it is dropped with
// DROP OWNED first (see dropRole).
const README_ROLE = "pgmcp_security_readme";
const NOINHERIT_ROLE = "pgmcp_security_noinherit";
const ADVISORY_KEY = 730_001;
const LIMIT_KEYS = [
  "POSTGRES_MAX_ROWS",
  "POSTGRES_MAX_RESULT_BYTES",
  "POSTGRES_POOL_MAX",
  "POSTGRES_QUERY_DEADLINE_MS",
  "POSTGRES_STATEMENT_TIMEOUT_MS",
] as const;

const pgReadonly = queryTools.find((t) => t.name === "pg_readonly");
const pgExplain = explainTools.find((t) => t.name === "pg_explain");
if (!pgReadonly || !pgExplain) throw new Error("pg_readonly and pg_explain must be defined");

type Res = { ok: boolean; error?: string; data?: { rows: Record<string, unknown>[]; plan?: unknown } };
const readonly = async (sql: string): Promise<Res> => (await pgReadonly.handler({ sql })) as Res;

describe("integration: security limits", { skip: !integrationEnabled() }, () => {
  const originalUrl = process.env.DATABASE_URL ?? "";
  const savedEnv = new Map(LIMIT_KEYS.map((k) => [k, process.env[k]]));
  let admin: pg.Client;

  const urlFor = (role: string): string => {
    const url = new URL(originalUrl);
    url.username = role;
    url.password = LIMITED_PASSWORD;
    return url.toString();
  };
  // DROP OWNED also revokes the role's grants on shared objects (the
  // database's CONNECT), which would otherwise block DROP ROLE. It errors on a
  // role that does not exist, hence the lookup.
  const dropRole = async (role: string): Promise<void> => {
    const found = await admin.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role]);
    if (found.rowCount === 0) return;
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE ${role}`);
  };

  before(async () => {
    admin = new pg.Client({ connectionString: originalUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${LIMITED_ROLE}`);
    await dropRole(README_ROLE);
    await dropRole(NOINHERIT_ROLE);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`CREATE TABLE ${SCHEMA}.t (id int)`);
    await admin.query(`INSERT INTO ${SCHEMA}.t VALUES (1)`);
    // Stays alive through cancels, the way a hostile or careless function can.
    await admin.query(`
      CREATE FUNCTION ${SCHEMA}.stubborn() RETURNS int LANGUAGE plpgsql AS $$
      DECLARE stop_at timestamptz := clock_timestamp() + interval '20 seconds';
      BEGIN
        WHILE clock_timestamp() < stop_at LOOP
          BEGIN
            PERFORM pg_sleep(0.05);
          EXCEPTION WHEN query_canceled THEN NULL;
          END;
        END LOOP;
        RETURN 1;
      END $$`);
    await admin.query(`CREATE ROLE ${LIMITED_ROLE} LOGIN PASSWORD '${LIMITED_PASSWORD}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${LIMITED_ROLE}`);
    await admin.query(`GRANT SELECT ON ${SCHEMA}.t TO ${LIMITED_ROLE}`);
  });

  afterEach(async () => {
    await shutdown();
    process.env.DATABASE_URL = originalUrl;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  after(async () => {
    await shutdown();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${LIMITED_ROLE}`);
    await dropRole(README_ROLE);
    await dropRole(NOINHERIT_ROLE);
    await admin.end();
  });

  it("pg_explain does not run a statement dressed up as an option", async () => {
    for (const sql of [`ANALYZE SELECT ${SCHEMA}.stubborn()`, `(ANALYZE) SELECT ${SCHEMA}.stubborn()`]) {
      const started = Date.now();
      const res = (await pgExplain.handler({ sql })) as Res;
      assert.equal(res.ok, false, sql);
      assert.ok(Date.now() - started < 2_000, "the statement ran");
    }
    // The second layer on its own: postgres refuses ANALYZE after ANY option
    // list, which is the property the tool relies on (it now always sends
    // `EXPLAIN (COSTS ON) ...` as the filler).
    const direct = await runReadOnly("EXPLAIN (COSTS ON) ANALYZE SELECT 1");
    assert.equal(direct.ok, false);
    assert.match(direct.error ?? "", /42601/);
  });

  it("a plain pg_explain still returns a plan", async () => {
    const res = (await pgExplain.handler({ sql: `SELECT * FROM ${SCHEMA}.t` })) as Res;
    assert.equal(res.ok, true, res.error);
    assert.match(String(res.data?.plan), /Seq Scan/);
  });

  it("pg_readonly refuses the escapes without reaching the server", async () => {
    for (const sql of [
      "SET ROLE postgres",
      "/* x */ DO $$ BEGIN NULL; END $$",
      "PREPARE p AS SELECT 1",
      "COMMIT",
      `COPY ${SCHEMA}.t TO PROGRAM 'not-run'`,
      "SELECT set_config('statement_timeout', '0', true)",
      "SELECT dblink_exec('dbname=x', 'DELETE FROM t')",
    ]) {
      const res = await readonly(sql);
      assert.equal(res.ok, false, sql);
      assert.match(res.error ?? "", /Blocked in read-only mode/, sql);
    }
    const count = await admin.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.t`);
    assert.equal(count.rows[0].n, 1);
  });

  it("the deadline ends a statement that survives statement_timeout, on the server too", async () => {
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "200";
    process.env.POSTGRES_QUERY_DEADLINE_MS = "700";
    const started = Date.now();
    const res = await readonly(`SELECT ${SCHEMA}.stubborn()`);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /client-side deadline/);
    assert.match(res.error ?? "", /was terminated/);
    assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms`);

    let running = 1;
    for (let i = 0; i < 40 && running > 0; i++) {
      const seen = await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE '%stubborn()%' AND pid <> pg_backend_pid()",
      );
      running = seen.rows[0].n;
      if (running > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(running, 0, "the backend outlived the deadline");

    const after = await readonly("SELECT 1 AS one");
    assert.equal(after.ok, true, "the pool must recover");
  });

  it("the byte limit stops a few huge rows, and the pool recovers", async () => {
    process.env.POSTGRES_MAX_ROWS = "5";
    process.env.POSTGRES_MAX_RESULT_BYTES = "2000000";
    const res = await readonly("SELECT repeat('x', 20000000) FROM generate_series(1, 5)");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /POSTGRES_MAX_RESULT_BYTES/);
    const direct = await readonly("EXPLAIN SELECT 1");
    assert.equal(direct.ok, true, direct.error);
    const small = await readonly("SELECT repeat('x', 1000) AS v");
    assert.equal(small.ok, true, small.error);
  });

  it("session state does not outlive a call on a pooled connection", async () => {
    process.env.POSTGRES_POOL_MAX = "1";
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "4321";
    const held = await readonly(`SELECT pg_advisory_lock(${ADVISORY_KEY})`);
    assert.equal(held.ok, true, held.error);
    const locks = await admin.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1",
      [ADVISORY_KEY],
    );
    assert.equal(locks.rows[0].n, 0, "the advisory lock survived the call");

    // The reset must keep what the connection was opened with.
    const timeout = await readonly("SHOW statement_timeout");
    assert.equal(timeout.data?.rows[0]?.statement_timeout, "4321ms");
    // Expected value derived as query.integration.test.ts does: an
    // application_name in DATABASE_URL outranks the pool option, which is
    // POSTGRES_APPLICATION_NAME or the "postgres-mcp" default.
    const dsnAppName = /[?&]application_name=([^&]*)/.exec(process.env.DATABASE_URL ?? "")?.[1];
    const expectedName = dsnAppName === undefined ? getApplicationName() : decodeURIComponent(dsnAppName);
    const name = await getPool().query("SHOW application_name");
    assert.equal(name.rows[0].application_name, expectedName);
  });

  it("the role check flags this superuser and passes a least-privilege role", async () => {
    const superuserLines: string[] = [];
    await runRolePreflight(false, (l) => superuserLines.push(l));
    assert.match(superuserLines.join("\n"), /NOT effectively read-only/);
    assert.match(superuserLines.join("\n"), /SUPERUSER/);
    await shutdown();

    const limited = new URL(originalUrl);
    limited.username = LIMITED_ROLE;
    limited.password = LIMITED_PASSWORD;
    process.env.DATABASE_URL = limited.toString();
    const limitedLines: string[] = [];
    await runRolePreflight(false, (l) => limitedLines.push(l));
    assert.match(limitedLines.join("\n"), /none of the elevated attributes/, limitedLines.join("\n"));
    await shutdown();

    await admin.query(`GRANT pg_signal_backend TO ${LIMITED_ROLE}`);
    await admin.query(`GRANT INSERT ON ${SCHEMA}.t TO ${LIMITED_ROLE}`);
    const riskyLines: string[] = [];
    await runRolePreflight(false, (l) => riskyLines.push(l));
    assert.match(riskyLines.join("\n"), /pg_signal_backend/);
    assert.match(riskyLines.join("\n"), /write privileges/);
  });

  // The README's "Read-only agent" recipe, statement for statement. A plain
  // GRANT of a predefined role also grants SET on it (PG16+), and the check
  // used to name pg_read_all_data as a SET ROLE target -- so the documented
  // least-privilege setup could never get the clean verdict.
  it("the README least-privilege recipe gets the clean verdict", async () => {
    const db = (await admin.query("SELECT current_database() AS db")).rows[0].db as string;
    await admin.query(`CREATE ROLE ${README_ROLE} LOGIN PASSWORD '${LIMITED_PASSWORD}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(db)} TO ${README_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${README_ROLE}`);
    await admin.query(`GRANT pg_read_all_data TO ${README_ROLE}`);

    process.env.DATABASE_URL = urlFor(README_ROLE);
    const lines: string[] = [];
    await runRolePreflight(false, (l) => lines.push(l));
    assert.deepEqual(lines, [
      `[postgres-mcp] role check: "${README_ROLE}" has none of the elevated attributes or grants checked for.`,
    ]);
  });

  // The other side of that filter: without INHERIT, the predefined role's
  // privileges are reachable ONLY through SET ROLE, which is exactly the reach
  // the check exists to report.
  it("a NOINHERIT member of pg_monitor is still told it can SET ROLE to it", async () => {
    await admin.query(`CREATE ROLE ${NOINHERIT_ROLE} LOGIN NOINHERIT PASSWORD '${LIMITED_PASSWORD}'`);
    await admin.query(`GRANT pg_monitor TO ${NOINHERIT_ROLE}`);

    process.env.DATABASE_URL = urlFor(NOINHERIT_ROLE);
    const lines: string[] = [];
    await runRolePreflight(false, (l) => lines.push(l));
    const text = lines.join("\n");
    assert.match(text, /NOT effectively read-only/, text);
    assert.match(text, /can SET ROLE to [^\n]*\bpg_monitor\b/, text);
  });
});
