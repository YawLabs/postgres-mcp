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

const nodeArgs = ["--test"];
if (integrationOnly) {
  // Three integration files each set up / tear down the same fixture schema.
  // Running them in parallel races on the shared schema; serialize.
  nodeArgs.push("--test-concurrency=1");
}
nodeArgs.push(...files);

const child = spawn(process.execPath, nodeArgs, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
