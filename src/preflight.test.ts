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
  standard_conforming_strings: true,
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
      [{ standard_conforming_strings: false }, /standard_conforming_strings=off/],
    ];
    for (const [patch, expected] of cases) {
      assert.match(analyzeRole({ ...leastPrivilege, ...patch }, false).join("\n"), expected);
    }
  });

  it("reports a superuser as one finding, not as the memberships pg_has_role invents for it", () => {
    // pg_has_role() is true for a superuser on every role, so the SQL returns
    // all five dangerous memberships and SET reach it does not hold (measured
    // on PG18 as `postgres`: MEMBER = t, the pg_auth_members row absent).
    const findings = analyzeRole(
      {
        ...leastPrivilege,
        superuser: true,
        can_set_superuser: true,
        dangerous_memberships: ["pg_read_server_files", "pg_write_all_data"],
        settable_roles: ["app_owner"],
        settable_count: 1,
      },
      false,
    );
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.match(findings[0] ?? "", /SUPERUSER/);
  });

  it("warns about standard_conforming_strings=off for a superuser too", () => {
    // A session setting, not a privilege: the statement guard misreads
    // backslashes whatever the role, so the SUPERUSER gate must not hide it.
    const findings = analyzeRole({ ...leastPrivilege, superuser: true, standard_conforming_strings: false }, false);
    assert.equal(findings.length, 2, JSON.stringify(findings));
    assert.match(findings[0] ?? "", /SUPERUSER/);
    assert.match(findings[1] ?? "", /standard_conforming_strings=off/);
  });

  it("reads standard_conforming_strings, which the statement guard assumes is on", () => {
    assert.match(
      ROLE_PREFLIGHT_SQL,
      /current_setting\('standard_conforming_strings'\) = 'on' AS standard_conforming_strings/,
    );
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

  it("keeps predefined pg_ roles in the SET ROLE scan unless their privileges are already inherited", () => {
    // pg_monitor/pg_read_all_data matter when INHERIT is off; an unconditional
    // left(rolname,3) <> 'pg_' filter silently dropped that reach. Inherited
    // ones are dropped: SET ROLE into them adds nothing, and the README's
    // `GRANT pg_read_all_data TO mcp_reader` would otherwise always warn.
    // Pin the whole WHERE clause of both scans, so a filter re-added under any
    // spelling fails here.
    const scans = [
      ...ROLE_PREFLIGHT_SQL.matchAll(/FROM pg_catalog\.pg_roles r, priv\s+WHERE ([\s\S]*?)\s+(?:ORDER BY|\) AS)/g),
    ]
      .map((m) => (m[1] ?? "").replace(/\s+/g, " "))
      .filter((where) => !where.includes("r.rolsuper"));
    const expected =
      "r.oid <> me.oid AND pg_catalog.pg_has_role(r.oid, priv.name) " +
      "AND NOT (left(r.rolname::text, 3) = 'pg_' AND pg_catalog.pg_has_role(r.oid, 'USAGE'))";
    assert.deepEqual(scans, [expected, expected], "settable_roles and settable_count must share one filter");
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
