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
  // Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
  // run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and
  // for spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking
  // the full PATHEXT list would hand back a path this launcher cannot execute.
  // Discovery has to agree with execution. A skipped shim is still reported --
  // see findOamShim.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
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

  // Every variable the SHIPPED BUNDLE reads, including the pg driver's own
  // lookups. Adding a config env var to src/ without adding it here is a silent
  // regression under the sandbox, not a loud one: oam removes an undeclared var
  // from process.env rather than denying access, so the server reads undefined
  // and quietly takes its default. POSTGRES_APPLICATION_NAME is read by
  // getApplicationName() in src/api.ts; PGAPPNAME is pg's own env fallback for
  // the same setting (connection-parameters.js: val('application_name', config,
  // 'PGAPPNAME')), so omitting it would drop a name set the driver's way.
  // POSTGRES_AUDIT_LOG_FILE is granted as a VARIABLE here, but the sandbox
  // still denies the filesystem, so the file sink cannot actually open its
  // target under POSTGRES_MCP_SANDBOX=1. The audit module fails loudly on an
  // unopenable sink rather than silently dropping the trail, so the combination
  // refuses to start -- which is the correct outcome (an audit control that
  // quietly disables itself is worse than none), but it is a surprising one to
  // hit at runtime. Use the stderr sink under the sandbox.
  const env = ["ALLOW_WRITES","DATABASE_URL","NODE_PG_FORCE_NATIVE","PGAPPNAME","PGCONNECT_TIMEOUT","PGSSLMODE","POSTGRES_APPLICATION_NAME","POSTGRES_AUDIT_LOG","POSTGRES_AUDIT_LOG_FILE","POSTGRES_AUDIT_REDACT","POSTGRES_CONNECTION_TIMEOUT_MS","POSTGRES_MAX_ROWS","POSTGRES_POOL_MAX","POSTGRES_SSL_REJECT_UNAUTHORIZED","POSTGRES_STATEMENT_TIMEOUT_MS","USER","USERNAME"];

  const flags = ["--permission", netFlag, `--allow-env=${env.join(",")}`];
  return flags;
}

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Reported rather than ignored, because "no oam binary was found"
 * reads as "install oam" -- the one thing that will not help. Windows only;
 * there is no such shim concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // A server may gate its bootstrap on being the process ENTRY POINT --
  // `import.meta.url === pathToFileURL(process.argv[1]).href` -- so that its own
  // test file can import the module for unit tests without connecting a stdio
  // transport. Importing the server here would leave argv[1] pointing at THIS
  // launcher, the guard would read false, and the server would load but never
  // serve: the MCP handshake just hangs.
  //
  // Point argv[1] at the server first, so the in-process path is
  // indistinguishable from having executed the file directly. The spawn path
  // needs no equivalent -- there argv[1] is already the server.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

const mode = (process.env.POSTGRES_MCP_RUNTIME ?? "auto").toLowerCase();

if (mode === "node") {
  await runInProcess();
} else {
  const oam = findOam();
  // Read the version ONCE, and only when discovery found something: the
  // gate below has to tell "too old" apart from "could not be read at all",
  // and re-probing inside the branch would cost a second subprocess.
  const found = oam ? oamVersion(oam) : null;

  if (!oam) {
    // An oam-named .cmd/.bat on PATH is a real install in a shape this
    // launcher cannot spawn. Naming it turns "no oam binary was found" --
    // which reads as "install oam", the one thing that will not help --
    // into something the user can act on.
    const oamShim = findOamShim();
    const shimNote = oamShim
      ? `Found ${oamShim}, but Node cannot execute a .cmd/.bat directly.\n` +
        "Install the native oam binary, or point OAM_BIN at one.\n"
      : "";
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else. writeSync because stderr is async for
      // TTYs/pipes on Windows and process.exit truncates pending writes.
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        "postgres-mcp: POSTGRES_MCP_RUNTIME=oam but no runnable oam binary was found.\n" + shimNote +
          "Install from https://oamjs.org, set OAM_BIN=/path/to/oam, or use POSTGRES_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their oam install is a shape this launcher skips.
    if (oamShim) await errSync(`postgres-mcp: ${shimNote}Using Node instead.\n`);
    await runInProcess();
  } else if (!atLeast(found, OAM_MIN)) {
    const min = OAM_MIN.join(".");
    // Two different causes reach this branch and they need different
    // remedies. `found === null` is NOT "old": oamVersion returns null when
    // the binary could not be run at all (not executable, wrong arch, a
    // .cmd/.bat Node refuses, deleted between the stat and the probe) or
    // when its --version output did not parse. Telling that user to
    // `oam self-update` sends them after the one cause it definitely is not.
    const detail = found
      ? `${oam} is oam ${found.join(".")}, older than ${min}`
      : `${oam} could not be run, or did not report a version this launcher understands`;
    const remedy = found
      ? "Run \`oam self-update\`, or use POSTGRES_MCP_RUNTIME=node.\n"
      : "Check that it is an executable oam binary for this platform, or use POSTGRES_MCP_RUNTIME=node.\n";
    if (mode === "oam") {
      await errSync(`postgres-mcp: POSTGRES_MCP_RUNTIME=oam but ${detail}.\n${remedy}`);
      process.exit(1);
    }
    // auto: neither cause is worth failing over -- prefer Node. Say so,
    // because a silent downgrade is how someone keeps running an oam they
    // meant to update, or never learns their oam is unexecutable.
    await errSync(`postgres-mcp: ${detail}; using Node instead.\n`);
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after
    // it lands in process.argv for the server, so `postgres-mcp version` and
    // any host-supplied flags survive the hop unchanged.
    // Every "oam could not be executed" outcome lands here: the synchronous
    // throw from spawn() and the async 'error' event mean the same thing and
    // must degrade the same way, so the handling lives in one place.
    // errSync rather than process.stderr.write because stderr is async for
    // TTYs and pipes on Windows and the process.exit below truncates pending
    // writes.
    const launchFailed = async (err) => {
      if (mode === "oam") {
        await errSync(`postgres-mcp: failed to launch oam (${err?.message ?? err})\n`);
        process.exit(1);
      }
      await runInProcess();
    };

    // ONE reporter shared by both launchFailed call sites, so the sync-throw
    // path and the 'error'-event path cannot drift apart. Either can reject:
    // runInProcess() is a bare import() that rejects when dist/index.js is
    // missing, and at ESM top level an unhandled rejection is an uncaught
    // exception -- the exact failure this handling exists to prevent.
    const fallbackFailed = (e) => {
      process.stderr.write(`postgres-mcp: fallback to Node failed (${e?.message ?? e})\n`);
      process.exitCode = 1;
    };

    let child = null;
    try {
      child = spawn(oam, [...sandboxFlags(), "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
        // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
        // stdin/stdout is untouched and the host's stdin-close still reaches the
        // server's shutdown path.
        stdio: "inherit",
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      // spawn() THROWS for some failures instead of emitting 'error', and the
      // 'error' listener is registered AFTER this call, so it can never observe
      // one -- an uncaught throw here kills the launcher with a raw stack trace
      // instead of falling back to Node.
      await launchFailed(err).catch(fallbackFailed);
    }

    if (child) {

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
        // Handle the rejection instead of discarding it: a failing in-process
        // fallback would otherwise escape as an unhandled rejection, replacing
        // this launcher's diagnostic with a raw stack trace.
        launchFailed(err).catch(fallbackFailed);
      });

      // Forward termination so the server's own shutdown path runs in the child
      // rather than the child being orphaned.
      //
      // Registering ANY handler for these suppresses Node's default
      // terminate-on-signal, so the parent's exit has to be arranged explicitly.
      // `child.killed` only records that kill() was CALLED, never that the child
      // is gone, so gating on it swallows every signal after the first and wedges
      // the launcher with no escape hatch.
      //
      // Escalation is driven by a TIMER, not by counting signals. Counting is
      // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
      // apart, and a terminal Ctrl-C reaches the whole process group, so reading
      // "a second signal" as impatience hard-kills a child that is already
      // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
      // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
      // a wall-clock step cannot mis-gate the window either.
      //
      // POSIX vs Windows, and why we do NOT forward on Windows.
      // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
      // is what lets the child run its shutdown. On Windows there are no POSIX
      // signals: child.kill IGNORES the name and calls TerminateProcess -- an
      // immediate hard kill (verified: a child with a SIGTERM handler never runs
      // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
      // graceful shutdown the console's own Ctrl-C just started, skipping the
      // child's process.on("exit") cleanup. The console has already notified the
      // child, so on Windows the timer below is the only kill we issue.
      const ESCALATE_AFTER_MS = 2000;
      let escalation = null;
      for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
          // No try/catch: kill() on an already-exited child returns false, it does
          // not throw. It throws only for a signal the platform does not know,
          // which SIGINT/SIGTERM/SIGKILL never are.
          if (!isWin) child.kill(sig);
          if (escalation) return; // already counting down; further signals are noise
          escalation = setTimeout(() => {
            // Still here after its grace window. Stop waiting on it.
            child.kill("SIGKILL");
            process.exit(128 + (constants.signals[sig] ?? 15));
          }, ESCALATE_AFTER_MS);
        });
      }

      child.on("exit", (code, signal) => {
        if (escalation) clearTimeout(escalation);
        // Mirror the child's fate: a signal death becomes 128+n so callers see a
        // conventional shell exit status rather than a bare 0.
        if (signal) {
          process.exit(128 + (constants.signals[signal] ?? 15));
        }
        process.exit(code ?? 0);
      });
    }
  }
}
