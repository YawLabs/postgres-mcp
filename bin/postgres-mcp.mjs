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
 * The spawn, not the runtime. windows-arm64, 1.4 MB bundle, warmed binaries,
 * mean of 12 runs: oam run 306ms, node 358ms -- oam is the FASTER of the two.
 * But reaching oam from here means node has already booted, and that hop
 * (~100ms) outweighs oam's ~52ms advantage: launcher -> node 370ms,
 * launcher -> oam 409ms. So the two land within ~40ms through the npm bin.
 * A one-time cost per MCP session either way, not per tool call.
 *
 * The `oam compile` standalone binary sidesteps this entirely (298ms, no
 * launcher, no spawn) and is the right answer if startup actually matters.
 *
 * DO NOT re-measure this by timing a freshly built binary. On Windows a
 * binary that is not in the on-access scanner's cache gets rescanned on every
 * exec, while `node` from PATH was cached long ago -- the comparison then
 * measures the scanner and dumps the whole penalty on the new binary. That
 * mistake produced the numbers published in 0.9.0 (node ~650-900ms, oam
 * ~980-1290ms), which were wrong in both magnitude and direction. Warm every
 * candidate first, or stage it out of the build directory.
 *
 * THE `--permission` SANDBOX (oam 0.9.0+, opt-in)
 * `POSTGRES_MCP_SANDBOX=1` runs the server under oam's permission model.
 *
 * The database host is not knowable ahead of time, so the net grant is DERIVED
 * from DATABASE_URL at launch: the one endpoint this server may reach is the one
 * it was configured to reach. Both host and port are pinned, because grants are
 * prefix-matched and a bare host would also admit every other port on it.
 * Filesystem and child-process stay denied.
 *
 * Opt-in, not default. A denied environment variable is ABSENT from process.env
 * rather than throwing, so an under-granted DATABASE_URL would look like "not
 * configured" instead of "denied". The env list is derived from the shipped
 * bundle and includes the pg driver's own reads (PGSSLMODE, PGCONNECT_TIMEOUT
 * and friends) -- a hand-written list misses those.
 *
 * MINIMUM OAM VERSION
 * 0.9.0. Below it `child_process.execFile` ran its arguments through a SHELL,
 * `exec` accepted `timeout` and ignored it, `spawnSync` truncated at
 * `maxBuffer` while reporting success, and `stdio: 'inherit'`/`'ignore'` both
 * behaved as `'pipe'`. This server spawns nothing, so the floor is
 * enforced for consistency across @yawlabs/*-mcp rather than because this
 * launcher was exposed.
 * An older oam is not an error: the launcher falls back to Node and says so on
 * stderr. Pinning the floor here is what makes that fallback automatic.
 *
 * SELECTION
 *   POSTGRES_MCP_RUNTIME=oam    require oam; fail loudly if it is missing
 *   POSTGRES_MCP_RUNTIME=node   never use oam
 *   POSTGRES_MCP_RUNTIME=auto   prefer oam, silently fall back (default)
 *   POSTGRES_MCP_SANDBOX=1      run oam under --permission (oam 0.9.0+)
 *   OAM_BIN=/path/to/oam        explicit binary, checked before any discovery
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam whose `child_process` matches Node. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 9, 0];

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

/**
 * `oam --version` -> [major, minor, patch], or null when it cannot be read.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    // Not executable, wrong arch, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * The `--permission` grant list, or [] when the sandbox is not requested.
 *
 * These are oam's PROCESS-level flags: they belong before the `run` subcommand,
 * not after it. `oam run --permission file.js` is rejected outright, which is a
 * good failure but only because it is loud -- ordering here is load-bearing.
 *
 * Net grants prefix-match `host` for fetch and `host:port` for sockets.
 * A denied environment variable is ABSENT from process.env rather than throwing,
 * so the env list below is derived from what the bundle actually reads; trimming
 * it produces silent misbehaviour, not a clear denial.
 */
function sandboxFlags() {
  if (process.env.POSTGRES_MCP_SANDBOX !== "1") return [];

  // Derived, not hardcoded: the only endpoint this server may reach is the one
  // it was configured to reach. Grants are prefix-matched against "host:port"
  // for sockets, so host alone would also admit any other port on that host --
  // pin both. A DSN we cannot parse falls back to a bare grant rather than a
  // broken one, because a wrong narrow grant fails at connect time.
  const dsn = process.env.DATABASE_URL ?? null;
  let netFlag = "--allow-net";
  if (dsn) {
    try {
      const u = new URL(dsn);
      if (u.hostname) netFlag = `--allow-net=${u.hostname}:${u.port || 5432}`;
    } catch {
      // Unparseable DATABASE_URL: leave the grant open. The server will fail on
      // its own connection error, which names the real problem.
    }
  }

  const env = ["ALLOW_WRITES","DATABASE_URL","NODE_PG_FORCE_NATIVE","PGCONNECT_TIMEOUT","PGSSLMODE","POSTGRES_CONNECTION_TIMEOUT_MS","POSTGRES_MAX_ROWS","POSTGRES_POOL_MAX","POSTGRES_SSL_REJECT_UNAUTHORIZED","POSTGRES_STATEMENT_TIMEOUT_MS","USER","USERNAME"];

  const flags = ["--permission", netFlag, `--allow-env=${env.join(",")}`];
  return flags;
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
  } else if (!atLeast(oamVersion(oam), OAM_MIN)) {
    // Discovery itself stays stat-only; this is the first subprocess, and it
    // runs only once we have already decided to spawn oam anyway. Measured 26ms
    // median (n=12, windows-arm64), paid once per MCP session.
    const min = OAM_MIN.join(".");
    if (mode === "oam") {
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        `postgres-mcp: POSTGRES_MCP_RUNTIME=oam but ${oam} is older than oam ${min}.\n` +
          `Run \`oam self-update\`, or use POSTGRES_MCP_RUNTIME=node.\n`,
      );
      process.exit(1);
    }
    // auto: an old oam is a reason to prefer Node, not to fail. Say so, because
    // a silent downgrade is how someone keeps running an oam they meant to
    // update. stderr is safe -- MCP frames travel on stdout.
    process.stderr.write(`postgres-mcp: oam at ${oam} is older than ${min}; using Node instead.\n`);
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after
    // it lands in process.argv for the server, so `postgres-mcp version` and
    // any host-supplied flags survive the hop unchanged.
    const child = spawn(oam, [...sandboxFlags(), "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
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
