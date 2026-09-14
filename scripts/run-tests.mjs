#!/usr/bin/env node
/**
 * Cross-platform test runner. Passing a directory to `node --test` hangs on
 * Windows (works on Linux) and globs like `dist/**\/*.test.js` only expand
 * in bash with globstar - PowerShell leaves them as literal paths. This
 * script enumerates test files with Node's stdlib and passes explicit paths.
 *
 * Usage:
 *   node scripts/run-tests.mjs [dir]        - all *.test.js under dir
 *   node scripts/run-tests.mjs [dir] --integration  - only *.integration.test.js, serialized
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const integrationOnly = args.includes("--integration");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? "dist");

const allFiles = readdirSync(dir, { recursive: true, encoding: "utf-8" })
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(dir, f));

const files = integrationOnly ? allFiles.filter((f) => f.includes(".integration.")) : allFiles;

if (files.length === 0) {
  console.error(`No test files found in ${dir}${integrationOnly ? " (--integration filter)" : ""}`);
  process.exit(1);
}

// Always serialize. Integration files race on the shared `test_fixture` schema;
// unit files mutate `process.env` (ALLOW_WRITES, POSTGRES_MAX_ROWS, ...) which
// is process-wide, so parallel files flap on env values written by another file.
//
// Two reporters. The first is what `node --test` would have picked on its own
// (spec on a terminal, tap otherwise), so the output people read is unchanged.
// The second writes TAP to a file that is scanned after the run, because
// `node --test` exits 0 when a describe() callback throws: the suite is printed
// as `not ok` but counted in none of the totals (`# fail 0`), so every test in
// that file silently never runs. Measured on Node 22.22 with a two-line file.
// A top-level `not ok` in the TAP is what catches it.
const tapDir = mkdtempSync(join(tmpdir(), "postgres-mcp-tap-"));
const tapFile = join(tapDir, "results.tap");
const nodeArgs = [
  "--test",
  "--test-concurrency=1",
  `--test-reporter=${process.stdout.isTTY ? "spec" : "tap"}`,
  "--test-reporter-destination=stdout",
  "--test-reporter=tap",
  `--test-reporter-destination=${tapFile}`,
  ...files,
];

const child = spawn(process.execPath, nodeArgs, { stdio: "inherit" });
child.on("exit", (code) => {
  let suiteFailures = [];
  try {
    suiteFailures = readFileSync(tapFile, "utf8")
      .split("\n")
      .filter((line) => /^not ok /.test(line) && !/# TODO/.test(line));
  } catch {
    // No TAP file means node never got as far as running anything; the exit
    // code already says so.
  }
  rmSync(tapDir, { recursive: true, force: true });
  if ((code ?? 1) === 0 && suiteFailures.length > 0) {
    console.error(`\n${suiteFailures.length} suite(s) failed before any of their tests ran:`);
    for (const line of suiteFailures) console.error(`  ${line}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
