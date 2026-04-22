import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminTools } from "./admin.js";
import { explainTools } from "./explain.js";
import { healthTools } from "./health.js";
import { queryTools } from "./query.js";
import { schemaTools } from "./schemas.js";
import { statsTools } from "./stats.js";

const allTools = [...queryTools, ...schemaTools, ...explainTools, ...healthTools, ...statsTools, ...adminTools];

describe("Tool definitions", () => {
  it("should have no duplicate tool names", () => {
    const names = allTools.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(
      names.length,
      unique.size,
      `Duplicate tool names found: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`,
    );
  });

  it("should have the expected total tool count", () => {
    assert.equal(allTools.length, 19);
  });

  for (const tool of allTools) {
    describe(tool.name, () => {
      it("should have a name prefixed with pg_", () => {
        assert.match(tool.name, /^pg_/);
      });

      it("should have a non-empty description", () => {
        assert.ok(tool.description.length > 0);
      });

      it("should have an input schema", () => {
        assert.ok(tool.inputSchema);
        assert.ok(typeof tool.inputSchema.shape === "object");
      });

      it("should have a handler function", () => {
        assert.equal(typeof tool.handler, "function");
      });

      it("should have annotations with required hints", () => {
        assert.ok(tool.annotations);
        assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
        assert.equal(typeof tool.annotations.destructiveHint, "boolean");
        assert.equal(typeof tool.annotations.idempotentHint, "boolean");
        assert.equal(typeof tool.annotations.openWorldHint, "boolean");
      });
    });
  }
});
