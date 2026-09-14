import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { adminTools } from "./admin.js";
import { explainTools } from "./explain.js";
import { healthTools } from "./health.js";
import { indexAdvisorTools } from "./index-advisor.js";
import { ioTools } from "./io.js";
import { queryTools } from "./query.js";
import { schemaTools } from "./schemas.js";
import { statsTools } from "./stats.js";

// Mirrors `allTools` in index.ts, like tools.test.ts does and for the same
// reason: index.ts starts the server on import, so it cannot be imported here.
const allTools = [
  ...queryTools,
  ...schemaTools,
  ...explainTools,
  ...indexAdvisorTools,
  ...healthTools,
  ...statsTools,
  ...ioTools,
  ...adminTools,
];

/**
 * The README's "Per-tool gating in the host" section splits every tool into
 * an Auto-allow list and an Always prompt list, and says the split follows
 * each tool's `readOnlyHint`. Nothing enforced that: three tools shipped in
 * neither list and one sat in the wrong one (#34). This test reads the two
 * lines back and checks them against the annotations, so the next tool that
 * is added without a home, or whose hint changes, fails here.
 *
 * Runs from dist/tools/, two levels below the repo root.
 */
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/**
 * Split on top-level commas only: a comma inside a parenthetical note belongs
 * to the note.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const BARE_NAME = /^`(pg_[a-z_*]+)`$/;

/**
 * The tool names a gating line lists. Two shapes occur, and a note can quote
 * anything, including another tool's name, so quoting alone is not listing:
 *
 *   `name` (a note, which may quote `things`), `name`, ...
 *   ... plus the introspection tools (`name`, `name`, ...)
 *
 * An entry that starts with a bare backticked name lists that name. A
 * parenthetical is a nested list only when EVERY comma-separated item in it is
 * a bare backticked name; anything else is a note, and its contents are
 * ignored. `pg_list_*` expands against the registered tools.
 */
function listedNames(line: string): string[] {
  const names: string[] = [];
  const visit = (segment: string): void => {
    for (const entry of splitTopLevel(segment)) {
      const lead = entry.match(/^`(pg_[a-z_*]+)`/);
      if (lead?.[1]) names.push(lead[1]);
      for (const group of entry.matchAll(/\(([^()]*)\)/g)) {
        const items = splitTopLevel(group[1] ?? "");
        if (items.length > 0 && items.every((item) => BARE_NAME.test(item))) visit(group[1] ?? "");
      }
    }
  };
  visit(line.replace(/^- \*\*[^*]+\*\*/, ""));
  return names.flatMap((name) =>
    name.endsWith("*") ? allTools.map((t) => t.name).filter((n) => n.startsWith(name.slice(0, -1))) : [name],
  );
}

/**
 * Looked up inside each test, not at describe time: an assertion that throws
 * while a suite is being collected is printed as `not ok` but counted in no
 * total, so it must fail a TEST to fail the run.
 */
function gatingLine(label: string): string {
  const line = readme.split("\n").find((l) => l.startsWith(`- **${label}:**`));
  assert.ok(line, `README.md has no "- **${label}:**" line; the per-tool gating section moved or was reworded`);
  return line;
}
const lists = () => ({
  autoAllow: listedNames(gatingLine("Auto-allow")),
  alwaysPrompt: listedNames(gatingLine("Always prompt")),
});

describe("README per-tool gating lists", () => {
  it("parse to a plausible number of names, so a reworded line cannot make this test vacuous", () => {
    const { autoAllow, alwaysPrompt } = lists();
    assert.ok(autoAllow.length >= 10, `Auto-allow parsed to ${autoAllow.length} names: ${autoAllow.join(", ")}`);
    assert.ok(
      alwaysPrompt.length >= 2,
      `Always prompt parsed to ${alwaysPrompt.length} names: ${alwaysPrompt.join(", ")}`,
    );
  });

  it("name only registered tools", () => {
    const { autoAllow, alwaysPrompt } = lists();
    const registered = new Set<string>(allTools.map((t) => t.name));
    for (const name of [...autoAllow, ...alwaysPrompt]) {
      assert.ok(registered.has(name), `README lists \`${name}\`, which is not a registered tool`);
    }
  });

  for (const tool of allTools) {
    it(`places ${tool.name} in exactly one list, the one its readOnlyHint says`, () => {
      const { autoAllow, alwaysPrompt } = lists();
      const inAuto = autoAllow.filter((n) => n === tool.name).length;
      const inPrompt = alwaysPrompt.filter((n) => n === tool.name).length;
      assert.equal(
        inAuto + inPrompt,
        1,
        `${tool.name} appears ${inAuto}x in Auto-allow and ${inPrompt}x in Always prompt; every tool must appear exactly once`,
      );
      const expected = tool.annotations.readOnlyHint ? "Auto-allow" : "Always prompt";
      const actual = inAuto === 1 ? "Auto-allow" : "Always prompt";
      assert.equal(
        actual,
        expected,
        `${tool.name} is listed under ${actual} but declares readOnlyHint: ${tool.annotations.readOnlyHint}`,
      );
    });
  }
});
