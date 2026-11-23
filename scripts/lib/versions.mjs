/**
 * Helpers the release scripts share: check-oam-floor.mjs, check-yaw-mcp-floor.mjs
 * and update-manifests.mjs each carried their own copy, and the copies had
 * already drifted (one parseVersion threw on a non-string, one main-module
 * check returned false where the others fell back to resolve()). Not shipped in
 * the npm package: nothing under bin/ or dist/ imports it.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `[major, minor, patch]` from the start of `text` ("v" optional), or null. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 for two parseVersion() triples, compared numerically. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * True when `argv1` (process.argv[1]) names the module at `moduleUrl`. Node
 * realpaths the main module's URL (unless --preserve-symlinks-main) but leaves
 * argv[1] as typed, so from a junctioned or symlinked checkout a plain resolve()
 * of the two differed: the script's main() never ran, and it printed nothing
 * and exited 0, a silence that reads as a pass. Both sides are realpath'd,
 * falling back to resolve() for a path that cannot be.
 */
export function isMainModule(argv1, moduleUrl) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}
