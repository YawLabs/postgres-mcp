import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identSchema, MAX_PARAM_DEPTH, paramsArray } from "./params.js";

describe("identSchema", () => {
  it("accepts plain ASCII identifiers", () => {
    assert.equal(identSchema.parse("users"), "users");
    assert.equal(identSchema.parse("public"), "public");
  });

  it("accepts quoted-style identifiers (mixed case, spaces, dashes)", () => {
    assert.equal(identSchema.parse("My Table"), "My Table");
    assert.equal(identSchema.parse("weird-col"), "weird-col");
  });

  it("rejects empty strings", () => {
    assert.throws(() => identSchema.parse(""));
  });

  it("accepts exactly 63 ASCII bytes (the NAMEDATALEN boundary)", () => {
    const sixtyThree = "a".repeat(63);
    assert.equal(identSchema.parse(sixtyThree), sixtyThree);
  });

  it("rejects 64-char ASCII identifiers (1 byte over)", () => {
    const sixtyFour = "a".repeat(64);
    assert.throws(() => identSchema.parse(sixtyFour));
  });

  // The reason this test file exists: previous identSchema used `.max(63)` on
  // JS char length, but postgres caps identifiers at 63 BYTES. A multi-byte
  // string of 32 JS chars is 64 UTF-8 bytes and postgres would silently
  // truncate it -- causing later "relation does not exist" errors with no
  // obvious cause. The refine() enforces the byte cap so the user sees a
  // clear validation error at the call boundary instead.
  it("rejects multi-byte identifiers exceeding 63 bytes (e.g. 32 'é' chars = 64 bytes)", () => {
    const multi = "é".repeat(32);
    assert.equal(multi.length, 32, "sanity: JS char length is well under 63");
    assert.equal(Buffer.byteLength(multi, "utf8"), 64, "sanity: byte length is 1 over the limit");
    assert.throws(() => identSchema.parse(multi));
  });

  it("accepts multi-byte identifiers within the byte limit (31 'é' chars = 62 bytes)", () => {
    const multi = "é".repeat(31);
    assert.equal(Buffer.byteLength(multi, "utf8"), 62);
    assert.equal(identSchema.parse(multi), multi);
  });

  it("rejects 4-byte emoji that overflow the byte cap", () => {
    // '😀' is 4 bytes in UTF-8. 16 chars * 4 = 64 bytes -> reject.
    const emoji = "😀".repeat(16);
    assert.equal(Buffer.byteLength(emoji, "utf8"), 64);
    assert.throws(() => identSchema.parse(emoji));
  });
});

describe("paramsArray nesting-depth cap", () => {
  // Iterative builder so a deep test value doesn't blow the test runner's
  // own stack during construction. `kind` controls whether each level is
  // an array, an object, or alternates -- the depth check counts both.
  function nest(kind: "array" | "object" | "mix", depth: number): unknown {
    let v: unknown = "leaf";
    for (let i = 0; i < depth; i++) {
      const useArray = kind === "array" || (kind === "mix" && i % 2 === 0);
      v = useArray ? [v] : { k: v };
    }
    return v;
  }

  it("accepts scalar params (depth 0)", () => {
    assert.doesNotThrow(() => paramsArray.parse(["a", 1, true, null]));
  });

  it("accepts shallow nesting (array of depth 5)", () => {
    assert.doesNotThrow(() => paramsArray.parse([nest("array", 5)]));
  });

  it("accepts nesting at the cap (depth MAX_PARAM_DEPTH)", () => {
    assert.doesNotThrow(() => paramsArray.parse([nest("array", MAX_PARAM_DEPTH)]));
    assert.doesNotThrow(() => paramsArray.parse([nest("object", MAX_PARAM_DEPTH)]));
    assert.doesNotThrow(() => paramsArray.parse([nest("mix", MAX_PARAM_DEPTH)]));
  });

  // The reason this test exists: previously `paramValue` was unbounded
  // recursion through z.lazy. A pathologically nested request would
  // either OOM the parse or surface a `Maximum call stack size exceeded`
  // RangeError. The refine returns a clear validation error instead.
  it("rejects nesting one level past the cap", () => {
    assert.throws(() => paramsArray.parse([nest("array", MAX_PARAM_DEPTH + 1)]), /maximum nesting depth/i);
  });

  it("rejects object nesting one level past the cap", () => {
    assert.throws(() => paramsArray.parse([nest("object", MAX_PARAM_DEPTH + 1)]), /maximum nesting depth/i);
  });

  it("counts mixed array/object nesting toward the cap", () => {
    assert.throws(() => paramsArray.parse([nest("mix", MAX_PARAM_DEPTH + 1)]), /maximum nesting depth/i);
  });

  // Locks the per-element semantics: even if other params are shallow,
  // one over-cap entry rejects the whole array. Prevents a smuggling
  // attempt that pads the array with scalars to defeat the check.
  it("rejects the whole array when any single element exceeds the cap", () => {
    assert.throws(
      () => paramsArray.parse(["scalar", 42, nest("array", MAX_PARAM_DEPTH + 1), "trailing"]),
      /maximum nesting depth/i,
    );
  });
});
