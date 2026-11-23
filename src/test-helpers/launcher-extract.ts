/**
 * Read the launcher's own functions out of bin/postgres-mcp.mjs for tests.
 *
 * The launcher cannot be imported -- importing it launches a server -- so its
 * declarations are pulled out of the source as text and evaluated. Each one is
 * matched loudly: a rename or reformat fails the caller instead of quietly
 * testing nothing.
 *
 * Shared by src/index.test.ts and the launcher sandbox integration test, so
 * the two cannot drift apart on how a declaration is found or which oam the
 * oam-dependent cases run on.
 *
 * Compiled with the rest of src/ but never shipped (package.json `files`
 * names only dist/index.js) and never run as a test (the runner collects
 * `*.test.js` only).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs from dist/test-helpers/, two levels below the repo root. */
export const LAUNCHER = fileURLToPath(new URL("../../bin/postgres-mcp.mjs", import.meta.url));

export const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
export const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\r?\n\}/;
export const PICK_NEWEST_DECL = /function pickNewest\(candidates\) \{[\s\S]*?\r?\n\}/;
export const SANDBOX_ENDPOINT_DECL = /function sandboxEndpoint\(dsn, pghost, pgport\) \{[\s\S]*?\r?\n\}/;
export const SANDBOX_ENV_DECL = /const SANDBOX_ENV = \[[^\]]*\];/;
export const SANDBOX_FLAGS_DECL = /function sandboxFlags\(grant\) \{[\s\S]*?\r?\n\}/;

/** Pull named declarations out of the launcher source, loudly. */
export function extractFromLauncher(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      assert.ok(match, `could not extract ${pattern} from bin/postgres-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

export type Candidate = { path: string; version: number[] | null };
export type PickNewest = (candidates: Candidate[]) => Candidate | null;

/** Evaluate the REAL `pickNewest` source, with the floor it closes over. */
export function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extractFromLauncher([OAM_MIN_DECL, ATLEAST_DECL, PICK_NEWEST_DECL]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

/**
 * The newest oam at or above the launcher's floor among OAM_BIN and every oam
 * on PATH, or null. Chosen with the launcher's own pickNewest: a below-floor
 * oam would only make the launcher refuse, and the first binary on PATH may be
 * an older copy the launcher would pass over.
 */
export function resolveOam(): string | null {
  const name = process.platform === "win32" ? "oam.exe" : "oam";
  const paths = [
    process.env.OAM_BIN,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, name)),
  ].filter((c): c is string => Boolean(c) && existsSync(c as string));
  const candidates = paths.map((path) => {
    const out = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).stdout ?? "";
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return { path, version: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null };
  });
  return loadPickNewest().pickNewest(candidates)?.path ?? null;
}
