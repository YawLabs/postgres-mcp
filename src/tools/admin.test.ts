import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { adminTools } from "./admin.js";

const pgKill = adminTools.find((t) => t.name === "pg_kill")!;

describe("pg_kill ALLOW_WRITES gate", () => {
  const original = process.env.ALLOW_WRITES;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_WRITES;
    else process.env.ALLOW_WRITES = original;
  });

  it("refuses when ALLOW_WRITES is unset", async () => {
    delete process.env.ALLOW_WRITES;
    const res = (await pgKill.handler({ pid: 1, mode: "cancel" })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /ALLOW_WRITES/);
  });

  it("refuses when ALLOW_WRITES is '0' (strict opt-in)", async () => {
    process.env.ALLOW_WRITES = "0";
    const res = (await pgKill.handler({ pid: 1, mode: "terminate" })) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /ALLOW_WRITES/);
  });
});
