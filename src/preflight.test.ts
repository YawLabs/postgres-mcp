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
      [{ risky_functions: ["dblink_exec"] }, /dblink_exec/],
      [{ can_write_tables: true }, /write privileges/],
    ];
    for (const [patch, expected] of cases) {
      assert.match(analyzeRole({ ...leastPrivilege, ...patch }, false).join("\n"), expected);
    }
  });

  it("does not warn about table writes when writes were asked for", () => {
    assert.deepEqual(analyzeRole({ ...leastPrivilege, can_write_tables: true }, true), []);
  });

  it("checks SET reach with the privilege the server version supports", () => {
    assert.match(ROLE_PREFLIGHT_SQL, /160000 THEN 'SET' ELSE 'MEMBER'/);
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
