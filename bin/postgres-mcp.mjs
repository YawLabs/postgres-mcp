#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/postgres-mcp.
 *
 * Prefers the oam runtime (https://oamjs.org) and falls back to the Node
 * process already running this file. The server itself (`dist/index.js`) is
 * runtime-agnostic -- it is a pre-bundled ESM file using only `node:` builtins
 * that oam implements -- so neither path changes behavior.
 *
 * WHY THE FALLBACK COSTS NOTHING
 * The fallback does NOT re-exec node. npm already started a node process to
 * run this launcher, so falling back is a plain `import()` of the server into
 * THIS process: zero extra spawn, zero extra startup, byte-identical behavior
 * to invoking `dist/index.js` directly. Users without oam pay only the cost of
 * resolving a few paths (a handful of `existsSync` calls, no subprocess).
 *
 * WHAT THE OAM PATH COSTS
 * Taking the oam path means node has already booted, so the total is node's
 * startup plus oam's. Measured on windows-arm64 against the 1.4 MB bundle:
 * node alone ~650-900ms, oam alone ~980-1290ms, so the oam path lands near
 * ~1.8s. This is a ONE-TIME cost per MCP session, not per tool call -- hosts
 * spawn the server once and keep it -- but it is a real regression against
 * plain node and the reason `POSTGRES_MCP_RUNTIME=node` exists.
 *
 * SELECTION
 *   POSTGRES_MCP_RUNTIME=oam    require oam; fail loudly if it is missing
 *   POSTGRES_MCP_RUNTIME=node   never use oam
 *   POSTGRES_MCP_RUNTIME=auto   prefer oam, silently fall back (default)
 *   OAM_BIN=/path/to/oam        explicit binary, checked before any discovery
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn(), conversely, needs a
// real filesystem path. Keeping both avoids converting at each call site and
// getting it backwards on one of them.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/**
 * Locate an oam binary, or null. Ordered cheapest-and-most-explicit first;
 * every branch is a stat, never a subprocess, so the miss case (the common one
 * for users who have never heard of oam) stays sub-millisecond.
 */
function findOam() {
  // 1. Explicit override wins and is never second-guessed.
  const override = process.env.OAM_BIN;
  if (override) return existsSync(override) ? override : null;

  // 2. PATH. Resolved manually rather than by spawning `which`/`where`, which
  //    would cost a subprocess on every launch just to decide whether to spawn.
  const pathExt = isWin ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? pathExt : [""]) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : "oam");
      if (existsSync(candidate)) return candidate;
    }
  }

  // 3. The per-user locations oamjs.org's installers write to. Checked because
  //    an MCP host launched from a GUI often has a PATH that does not include
  //    them, so PATH-only discovery would miss an oam the user really has.
  const installed = isWin
    ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe)]
    : [join(homedir(), ".oam", "bin", exe)];
  for (const candidate of installed) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  await import(SERVER_URL.href);
}

const mode = (process.env.POSTGRES_MCP_RUNTIME ?? "auto").toLowerCase();

if (mode === "node") {
  await runInProcess();
} else {
  const oam = findOam();

  if (!oam) {
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else. writeSync because stderr is async for
      // TTYs/pipes on Windows and process.exit truncates pending writes.
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        "postgres-mcp: POSTGRES_MCP_RUNTIME=oam but no oam binary was found.\n" +
          "Install from https://oamjs.org, set OAM_BIN=/path/to/oam, or use POSTGRES_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after
    // it lands in process.argv for the server, so `postgres-mcp version` and
    // any host-supplied flags survive the hop unchanged.
    const child = spawn(oam, ["run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path.
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });

    // If oam cannot be executed at all (deleted between the stat and the
    // spawn, wrong arch, permission), fall back rather than failing the whole
    // server. `spawned` guards against falling back AFTER the child has begun
    // running, which would double-start the server.
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      if (spawned) return;
      if (mode === "oam") {
        process.stderr.write(`postgres-mcp: failed to launch oam (${err.message})\n`);
        process.exit(1);
      }
      void runInProcess();
    });

    // Forward termination so the server's own SIGINT/SIGTERM cleanup (pool
    // drain) runs in the child instead of the child being orphaned. Signals
    // are a no-op on Windows but harmless to register.
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        if (!child.killed) child.kill(sig);
      });
    }

    child.on("exit", (code, signal) => {
      // Mirror the child's fate: a signal death becomes 128+n so callers see a
      // conventional shell exit status rather than a bare 0.
      if (signal) {
        process.exit(128 + (constants.signals[signal] ?? 15));
      }
      process.exit(code ?? 0);
    });
  }
}
