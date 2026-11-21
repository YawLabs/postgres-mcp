import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { analyzeRole, ROLE_PREFLIGHT_SQL, type RoleFacts, runRolePreflight } from "./preflight.js";

const leastPrivilege: RoleFacts = {
  role: "mcp_reader",
  superuser: false,
  create_role: false,
  create_db: false,
  replication: false,
  bypass_rls: false,
  dangerous_memberships: [],
  settable_roles: [],
  settable_count: 0,
  can_set_superuser: false,
  risky_functions: [],
  can_write_tables: false,
};

describe("analyzeRole", () => {
  it("finds nothing wrong with a least-privilege role", () => {
    assert.deepEqual(analyzeRole(leastPrivilege, false), []);
  });

  it("names each risk", () => {
    const cases: [Partial<RoleFacts>, RegExp][] = [
      [{ superuser: true }, /SUPERUSER/],
      [{ can_set_superuser: true }, /SET ROLE to a superuser/],
      [{ dangerous_memberships: ["pg_execute_server_program"] }, /pg_execute_server_program/],
      [{ settable_roles: ["app_owner"] }, /SET ROLE to app_owner/],
      [{ create_role: true }, /CREATEROLE/],
      [{ bypass_rls: true }, /BYPASSRLS/],
      [{ risky_functions: ["dblink_connect_u"] }, /dblink_connect_u/],
      [{ can_write_tables: true }, /write privileges/],
    ];
    for (const [patch, expected] of cases) {
      assert.match(analyzeRole({ ...leastPrivilege, ...patch }, false).join("\n"), expected);
    }
  });

  it("does not warn about table writes when writes were asked for", () => {
    assert.deepEqual(analyzeRole({ ...leastPrivilege, can_write_tables: true }, true), []);
  });

  it("says how many SET ROLE targets were cut off by the LIMIT", () => {
    // 2 listed out of 25 total: the finding must not read as a complete list.
    const out = analyzeRole({ ...leastPrivilege, settable_roles: ["role_a", "role_b"], settable_count: 25 }, false);
    assert.match(out.join("\n"), /SET ROLE to role_a, role_b \(and 23 more\)/);
  });

  it("checks SET reach with the privilege the server version supports", () => {
    assert.match(ROLE_PREFLIGHT_SQL, /160000 THEN 'SET' ELSE 'MEMBER'/);
  });

  it("counts all SET ROLE targets past the LIMIT 20 for truncation detection", () => {
    // settable_count is a full-count column in the SQL (no LIMIT), so
    // analyzeRole can append "(and N more)" instead of printing 20 names as if
    // the list were complete.
    assert.match(ROLE_PREFLIGHT_SQL, /AS settable_roles,\s*\(\s*SELECT count\(\*\)::int/);
    assert.match(ROLE_PREFLIGHT_SQL, /LIMIT 20/);
  });

  it("keeps granted-by-default dblink functions out of the risky list", () => {
    // EXECUTE on plain dblink* is PUBLIC by default, so has_function_privilege is
    // true for every role -- a guaranteed false WARNING on the recommended
    // least-privilege role. dblink_connect_u stays (denied to PUBLIC) and is
    // asserted by "names each risk" above; the sqlList literals are inlined in
    // ROLE_PREFLIGHT_SQL, so assert the plain entries' absence there.
    for (const gone of ["dblink", "dblink_connect", "dblink_exec", "dblink_send_query"]) {
      assert.doesNotMatch(ROLE_PREFLIGHT_SQL, new RegExp(`'${gone}'`));
    }
  });

  it("keeps predefined pg_ roles in the SET ROLE scan", () => {
    // pg_monitor/pg_read_all_data matter when INHERIT is off; the old
    // left(rolname,3) <> 'pg_' filter silently dropped that reach.
    assert.doesNotMatch(ROLE_PREFLIGHT_SQL, /rolname, 3/);
  });
});

describe("runRolePreflight", () => {
  const original = process.env.DATABASE_URL;
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://stub-host/stubdb";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  async function run(query: Parameters<typeof runRolePreflight>[2]): Promise<string> {
    const lines: string[] = [];
    await runRolePreflight(false, (l) => lines.push(l), query);
    return lines.join("\n");
  }

  it("warns loudly about a superuser and starts anyway", async () => {
    const out = await run(async () => ({ ok: true, data: [{ ...leastPrivilege, role: "root", superuser: true }] }));
    assert.match(out, /WARNING: this server is NOT effectively read-only\. Role "root"/);
    assert.match(out, /SUPERUSER/);
    assert.match(out, /Configuring access/);
  });

  it("stays quiet about a clean role, without claiming it is safe", async () => {
    const out = await run(async () => ({ ok: true, data: [leastPrivilege] }));
    assert.doesNotMatch(out, /WARNING/);
    assert.match(out, /none of the elevated attributes or grants checked for/);
  });

  it("says the role is unverified when the check fails or throws", async () => {
    assert.match(await run(async () => ({ ok: false, error: "connect refused" })), /skipped \(connect refused\)/);
    assert.match(
      await run(async () => {
        throw new Error("boom");
      }),
      /skipped \(boom\)/,
    );
  });

  it("does not touch the database without a DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const out = await run(async () => assert.fail("must not query"));
    assert.match(out, /DATABASE_URL is not set/);
  });
});
