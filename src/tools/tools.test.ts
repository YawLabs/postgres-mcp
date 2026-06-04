import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
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
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) duplicates.add(name);
      else seen.add(name);
    }
    assert.equal(names.length, unique.size, `Duplicate tool names found: ${[...duplicates].join(", ")}`);
  });

  it("should have at least one tool", () => {
    assert.ok(allTools.length > 0);
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
        assert.ok(tool.inputSchema instanceof z.ZodObject);
        assert.ok(tool.inputSchema.shape !== null && typeof tool.inputSchema.shape === "object");
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

      // Schema/handler-drift guard. Every tool's inputSchema is a ZodObject;
      // the handler then does `const { ... } = input as { ... }` and reads
      // the destructured fields without re-validating. A regression that
      // (a) drops the ZodObject wrapper, (b) leaves the schema empty when
      // the handler destructures input, or (c) has a schema whose shape
      // doesn't match the keys the handler reads would compile cleanly
      // and only surface as `undefined` at runtime -- caught by integration
      // tests, but months later and at the call site. The cheap probe:
      // the schema is a ZodObject (already asserted above), the schema
      // actually parses a sample input built to satisfy each field's
      // type, and the parsed output exposes the shape's declared keys.
      //
      // Note: a tool with `z.object({})` (no declared fields, e.g.
      // pg_list_schemas / pg_list_extensions / pg_replication_status) is
      // a legitimate MCP contract -- the protocol supplies no defaults
      // and these tools take no input. The "must have at least one field"
      // assertion is intentionally NOT made; the test below still runs
      // and passes (parses {}, parsed object is {}) for those tools.
      it("inputSchema parses a type-correct sample input and round-trips declared keys", () => {
        const shape = tool.inputSchema.shape as Record<string, z.ZodTypeAny>;
        const fieldNames = Object.keys(shape);

        // Build a per-field sample. We use the public Zod constructor
        // names (instanceof z.ZodString, etc.) rather than reading
        // _def internals, which is brittle across Zod majors (4.x moved
        // _def.typeName to _def.type and dropped .values). Optional
        // fields are filled with a placeholder too; safeParse will
        // reject a value that doesn't match the inner type either way.
        //
        // Number defaults are tricky: the schema may constrain min > 0
        // (e.g. pg_kill.pid has int().min(1), pg_top_queries.limit has
        // int().min(1)) or accept [0, 1] (e.g. pg_advisor.seqExhaustionThreshold,
        // pg_table_bloat.minDeadRatio). Use 1 as a default; it's valid
        // for min(1)+ but rejected by `min(0).max(1)` fields. For those,
        // 0.5 is the safer pick. We try 1 first, then 0.5, then 0, and
        // accept whichever the schema accepts. (The test asserts success;
        // if all three reject, the schema is broken.)
        const sample: Record<string, unknown> = {};
        for (const name of fieldNames) {
          const field = shape[name];
          if (!field) continue;
          if (field.isOptional()) {
            sample[name] = undefined;
            continue;
          }
          // Pick a type-appropriate default. Anything more elaborate
          // (nested objects, unions) would need per-tool fixtures; the
          // point of this test is the schema-can-parse sanity check.
          if (field instanceof z.ZodString) {
            sample[name] = "x";
          } else if (field instanceof z.ZodNumber) {
            // Try values from most-likely-valid to least, since the
            // schema's bound is a runtime property we don't statically
            // know. 1 is the sweet spot for ints with .min(1); 0.5 for
            // [0,1] ranges; 0 as a final fallback.
            sample[name] = field.safeParse(1).success ? 1 : field.safeParse(0.5).success ? 0.5 : 0;
          } else if (field instanceof z.ZodBoolean) {
            sample[name] = false;
          } else if (field instanceof z.ZodArray) {
            sample[name] = [];
          } else if (field instanceof z.ZodObject) {
            sample[name] = {};
          } else if (field instanceof z.ZodEnum) {
            // First allowed value beats a custom placeholder.
            sample[name] = field.options[0] ?? "x";
          } else {
            // z.lazy / z.union / z.record / future types -- fall through
            // with a string placeholder; the schema will reject it and
            // the test surfaces as a failed parse with the right error.
            sample[name] = "x";
          }
        }

        const result = tool.inputSchema.safeParse(sample);
        assert.equal(
          result.success,
          true,
          `${tool.name} inputSchema rejected a type-correct sample: ${result.success ? "" : result.error.message}`,
        );
        if (result.success) {
          for (const name of fieldNames) {
            assert.ok(
              name in result.data,
              `${tool.name} inputSchema parsed output missing declared field "${name}"`,
            );
          }
        }
      });
    });
  }
});
