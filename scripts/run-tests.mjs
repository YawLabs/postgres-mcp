#!/usr/bin/env node
/**
 * Cross-platform test runner. Passing a directory to `node --test` hangs on
 * Windows (works on Linux) and globs like `dist/**\/*.test.js` only expand
 * in bash with globstar — PowerShell leaves them as literal paths. This
 * script enumerates test files with Node's stdlib and passes explicit paths.
 *
 * Usage:
 *   node scripts/run-tests.mjs [dir]        — all *.test.js under dir
 *   node scripts/run-tests.mjs [dir] --integration  — only *.integration.test.js, serialized
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
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
const nodeArgs = ["--test", "--test-concurrency=1", ...files];

const child = spawn(process.execPath, nodeArgs, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
