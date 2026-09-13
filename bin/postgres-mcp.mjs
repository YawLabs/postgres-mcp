#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/postgres-mcp.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * the Node process already running this file. It never serves on an oam older
 * than the floor below. The server itself (`dist/index.js`) is
 * runtime-agnostic -- it is a pre-bundled ESM file using only `node:` builtins
 * that oam implements -- so neither path changes behavior.
 *
 * WHY THE FALLBACK COSTS NOTHING
 * The fallback does NOT re-exec node. npm already started a node process to
 * run this launcher, so falling back is a plain `import()` of the server into
 * THIS process: zero extra spawn, zero extra startup, byte-identical behavior
 * to invoking `dist/index.js` directly. Finding the candidates is stat-only,
 * so users without oam pay only for a handful of `existsSync` calls, never a
 * subprocess.
 *
 * WHAT THE OAM PATH COSTS
 * The spawn, not the runtime. windows-arm64, 1.4 MB bundle, warmed binaries,
 * mean of 12 runs: oam run 306ms, node 358ms -- oam is the FASTER of the two.
 * But reaching oam from here means node has already booted, and that hop
 * (~100ms) outweighs oam's ~52ms advantage: launcher -> node 370ms,
 * launcher -> oam 409ms. So the two land within ~40ms through the npm bin.
 * A one-time cost per MCP session either way, not per tool call. Those figures
 * were taken with a single `oam --version` probe; every oam binary discovery
 * finds is now probed, so each extra copy on the machine adds one subprocess.
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
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- the installed locations, then PATH -- is asked for its
 * version, and the NEWEST one at or above the floor wins; a tie keeps search
 * order. Taking the first binary found instead let a stale copy early in the
 * search order hide a current one later: with oam 0.9.0 in ~/.oam/bin and
 * 0.15.2 on PATH, a launcher that stops at the first hit runs 0.9.0.
 *
 * An OAM_BIN that does not exist, is below the floor, or will not run is named
 * on stderr and discovery carries on. It used to stop everything: a typo in
 * OAM_BIN meant Node, with no hint why.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does, and so does oam's sidecar
 * regression matrix. This launcher used to discover oam and spawn it anyway,
 * so one server cost two runtime boots: measured on Windows, oam.exe with a
 * NESTED oam.exe + conhost.exe underneath it. Now, when `process.versions.oam`
 * clears the same MINIMUM OAM VERSION a discovered binary has to, the server is
 * imported into THIS process exactly as the Node fallback is -- no discovery,
 * no `oam --version` probe, no second oam. OAM_BIN is a discovery input, so it
 * is not consulted on that path: the host has already chosen which oam runs.
 *
 * POSTGRES_MCP_SANDBOX=1 takes the discovery path instead, deliberately:
 * `--permission` is a process-level flag that only a FRESH oam can apply, so
 * serving in-process there would drop the sandbox, and with it the net grant
 * pinned to DATABASE_URL, without a word -- a security downgrade dressed up as
 * an optimisation.
 *
 * The discovery path does NOT guarantee a fresh oam, sandboxed or otherwise.
 * Discovery can still fail -- no usable binary, or a spawn that errors -- and
 * under POSTGRES_MCP_RUNTIME=auto (the default) the fallback then serves
 * WITHOUT `--permission`: in THIS process on Node or on an oam at or above the
 * floor, and nothing it prints says the sandbox was dropped. Only
 * POSTGRES_MCP_RUNTIME=oam turns those failures into a hard exit.
 *
 * A host oam BELOW the floor never serves, sandbox or not. It hands the server
 * off to the newest usable oam, or to Node found on PATH, or exits with an
 * error when there is neither.
 *
 * Every spawn from an oam host PIPES stdio rather than inheriting it. Before
 * 0.9.0 oam treated `stdio: 'inherit'` as `'pipe'`, so an inherited handoff
 * from such a host connected the child to pipes nobody reads and the MCP
 * handshake never answered. Piping the streams explicitly completes it, to
 * both oam and Node. A Node host keeps `inherit`, which hands over the same
 * fds untouched.
 *
 * THE `--permission` SANDBOX (opt-in)
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
 * The latest oam release, 0.15.2 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is passed over.
 * Below 0.9.0 `child_process.execFile` ran its arguments through a SHELL,
 * `exec` accepted `timeout` and ignored it, `spawnSync` truncated at
 * `maxBuffer` while reporting success, and `stdio: 'inherit'`/`'ignore'` both
 * behaved as `'pipe'`. This server spawns nothing, so those bugs were not
 * reachable here. What it does depend on is the sandbox: per oam's changelog
 * `--permission` did not cover all of `fs` and `child_process` until 0.9.1,
 * and the port grant was not exact until 0.15.0.
 * An older oam is not an error under `auto`: the launcher uses a newer one or
 * falls back. The binaries it passed over, and any oam.cmd / oam.bat shim, are
 * named on stderr only when NO usable oam is found; when a newer oam is used,
 * nothing is printed about the older copies. An unusable OAM_BIN is the
 * exception: it is always named.
 *
 * SELECTION
 *   POSTGRES_MCP_RUNTIME=auto   newest usable oam, else Node (default)
 *   POSTGRES_MCP_RUNTIME=oam    newest usable oam, else exit with an error
 *                               (already running on oam at the floor satisfies
 *                               it, unless the sandbox forces a spawn)
 *   POSTGRES_MCP_RUNTIME=node   Node: in THIS process on Node, handed off to
 *                               Node on PATH when THIS process is oam
 *   POSTGRES_MCP_SANDBOX=1      run oam under --permission
 *   OAM_BIN=/path/to/oam        use this oam when it is usable, before discovery
 * The runtime value is case-insensitive; anything else behaves like `auto`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam this launcher will run on. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 15, 2];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn(), conversely, needs a
// real filesystem path. Keeping both avoids converting at each call site and
// getting it backwards on one of them.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess.
 *
 * The per-user locations oamjs.org's installers write to come BEFORE PATH, so
 * when two binaries report the same version the installed copy wins the tie --
 * a dev build on PATH is replaced underneath running processes by cargo. They
 * are checked at all because an MCP host launched from a GUI often has a PATH
 * that does not include them. Both forms are checked on Windows: the installer
 * defaults to %LOCALAPPDATA%\oam\bin there, but oam's docs name ~/.oam/bin
 * first and OAM_INSTALL_DIR can pick either.
 *
 * PATH is resolved manually rather than by spawning `which`/`where`, which
 * would cost a subprocess on every launch just to decide whether to spawn.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would hand back a path this launcher cannot execute.
 * Discovery has to agree with execution. A skipped shim is still reported when
 * no usable oam is found -- see findOamShim.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` output ("oam 0.15.1") and the host's own
 * `process.versions.oam` ("0.15.1") -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
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
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the server runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam and
 *                  Node was asked for
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam. `sandbox` is whether a spawn would carry flags
 * only a fresh oam can apply; see ALREADY RUNNING ON OAM above for why that
 * alone forces discovery, and why discovery can still end in-process. The
 * floor is OAM_MIN itself, not a parameter, so a host oam and a discovered one
 * can never be held to different minimums.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam, sandbox }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  if (sandbox) return "discover";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
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
  //
  // Most of the PG* names below CANNOT be found by grepping the bundle for
  // `process.env.PGFOO`, which is why they were missing: pg builds them at
  // runtime as `process.env['PG' + key.toUpperCase()]`
  // (connection-parameters.js:15), so PGUSER / PGDATABASE / PGHOST / PGPORT /
  // PGPASSWORD / PGOPTIONS / PGBINARY / PGCLIENT_ENCODING / PGREPLICATION all
  // exist only as a computed string. Their absence bites precisely when
  // DATABASE_URL is not self-contained -- `postgres:///mydb` leaning on PGHOST,
  // or password-free DSNs leaning on PGPASSWORD -- and it bites in the silent
  // direction: the var is stripped, pg falls back to its own default, and the
  // connection fails with something that names neither the sandbox nor the
  // variable. Only the two spelled literally in pg's source (PGSSLMODE at
  // connection-parameters.js:26, PGCONNECT_TIMEOUT at :127) plus the explicit
  // third arguments (PGAPPNAME, PGSSLNEGOTIATION) are greppable.
  // POSTGRES_AUDIT_LOG_FILE is granted as a VARIABLE here, but the sandbox
  // still denies the filesystem, so the file sink cannot actually open its
  // target under POSTGRES_MCP_SANDBOX=1. The audit module fails loudly on an
  // unopenable sink rather than silently dropping the trail, so the combination
  // refuses to start -- which is the correct outcome (an audit control that
  // quietly disables itself is worse than none), but it is a surprising one to
  // hit at runtime. Use the stderr sink under the sandbox.
  const env = ["ALLOW_WRITES","DATABASE_URL","NODE_PG_FORCE_NATIVE","PGAPPNAME","PGBINARY","PGCLIENT_ENCODING","PGCONNECT_TIMEOUT","PGDATABASE","PGHOST","PGOPTIONS","PGPASSWORD","PGPORT","PGREPLICATION","PGSSLMODE","PGSSLNEGOTIATION","PGUSER","POSTGRES_APPLICATION_NAME","POSTGRES_AUDIT_LOG","POSTGRES_AUDIT_LOG_FILE","POSTGRES_AUDIT_REDACT","POSTGRES_CONNECTION_TIMEOUT_MS","POSTGRES_MAX_ROWS","POSTGRES_POOL_MAX","POSTGRES_SSL_REJECT_UNAUTHORIZED","POSTGRES_STATEMENT_TIMEOUT_MS","USER","USERNAME"];

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
 * cannot spawn. Looked up and reported only when no usable oam was found,
 * rather than ignored, because "no oam binary was found" reads as "install
 * oam" -- the one thing that will not help. When a usable oam is chosen, a shim
 * beside it is not mentioned. Windows only; there is no such shim concept on
 * POSIX.
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

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Why a candidate was passed over, for stderr. `version` null is NOT "old":
 * oamVersion returns null when the binary could not be run at all (not
 * executable, wrong arch, wedged, deleted between the stat and the probe) or
 * when its --version output did not parse, and telling that user to update
 * oam sends them after the one cause it definitely is not.
 */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable discovered
 * binary. Returns the choice (or null) plus stderr notes: `overrideNote` about
 * an unusable OAM_BIN, and `skipped` describing what was found and rejected
 * when nothing was usable.
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) return { chosen: { path: override, version }, overrideNote, skipped: [] };
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
    }
  }
  const overrideKey = override ? pathKey(override) : null;
  const candidates = discoverOamPaths()
    .filter((path) => pathKey(path) !== overrideKey)
    .map((path) => ({ path, version: oamVersion(path) }));
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  return { chosen, overrideNote, skipped };
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

// ONE reporter for every failed fallback. runInProcess() is a bare import()
// that rejects when dist/index.js is missing, and at ESM top level an unhandled
// rejection is an uncaught exception -- replacing this launcher's diagnostic
// with a raw stack trace.
const fallbackFailed = (e) => {
  process.stderr.write(`postgres-mcp: fallback failed (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * Spawn the server in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the server
 * on the same stdio.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // THIS process being an oam means one below the floor, one spawning a fresh
  // oam for the sandbox, or one handing off under POSTGRES_MCP_RUNTIME=node.
  // An oam below 0.9.0 does not hand over the fds for `stdio: 'inherit'`, and a
  // current one is served just as well by pipes, so every oam host pipes
  // explicitly; see ALREADY RUNNING ON OAM.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path. Piping preserves both as well: bytes are copied
      // unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(fallbackFailed);
    return;
  }

  // If the runtime cannot be executed at all (deleted between the version probe
  // and the spawn, wrong arch, permission), fall back rather than failing the
  // whole server. `spawned` prevents falling back AFTER the child started.
  //
  // Everything that assumes a live child waits for 'spawn'. A failed spawn
  // still emits 'close' (after 'error', with the negative errno as its code), so
  // an unguarded close handler would process.exit() out from under the fallback
  // onLaunchFailed has just started. Signal handlers registered for a child
  // that never ran would stay on this process too, so an in-process fallback's
  // first SIGINT would arm a 2s process.exit() meant for that child. Piping
  // waits as well, so no stream is ever attached to a child that never ran;
  // until 'spawn', process.stdin has no reader and simply stays paused. (On
  // Windows, piping first did not lose an MCP request the host wrote at launch
  // -- measured -- so that last part is defensive, not a reproduced bug.)
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
    if (piped) {
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    forwardSignals();
  });
  child.on("error", (err) => {
    if (spawned) return;
    onLaunchFailed(err).catch(fallbackFailed);
  });
  // A child that exits before reading everything closes its stdin; the
  // resulting EPIPE is not worth crashing over.
  child.stdin?.on("error", () => {});

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
  function forwardSignals() {
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
  }

  // Piped: wait for 'close', so the child's last stdout bytes are copied out
  // before this process exits. Inherited: 'exit' is enough, the fds were never
  // ours to drain. Either way, only for a child that actually ran -- see the
  // 'spawn' handler above (measured: ENOENT -> 'error', then 'close' with code
  // -4058 on Windows).
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (!spawned) return;
    if (escalation) clearTimeout(escalation);
    // Mirror the child's fate: a signal death becomes 128+n so callers see a
    // conventional shell exit status rather than a bare 0.
    if (signal) {
      process.exit(128 + (constants.signals[signal] ?? 15));
    }
    process.exit(code ?? 0);
  });
}

/**
 * Hand the server to Node on PATH. Only reachable when THIS process is oam --
 * one below the floor, or any oam under POSTGRES_MCP_RUNTIME=node -- so there
 * is no in-process option left.
 */
async function handOffToNode(reason) {
  const node = findNodeOnPath();
  if (!node) {
    // An empty reason is POSTGRES_MCP_RUNTIME=node on a supported oam, where
    // updating oam is not the way out.
    await errSync(
      reason
        ? `postgres-mcp: ${reason}, and no Node was found on PATH to run the server instead.\n` +
            `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`
        : "postgres-mcp: POSTGRES_MCP_RUNTIME=node, but no Node was found on PATH to run the server.\n" +
            "Put Node on PATH, launch this command with node, or unset POSTGRES_MCP_RUNTIME to run on this oam.\n",
    );
    process.exit(1);
  }
  if (reason) await errSync(`postgres-mcp: ${reason}; running on ${node} instead.\n`);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`postgres-mcp: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

const mode = (process.env.POSTGRES_MCP_RUNTIME ?? "auto").toLowerCase();
const hostOam = process.versions.oam;

// True when THIS process is an oam at or above the floor. Such a host reaches
// discovery only under the sandbox, and it may still serve the fallback itself.
const hostIsSupportedOam = atLeast(parseVersion(hostOam ?? ""), OAM_MIN);

/** What the fallback will do, for the stderr note that precedes it. */
const fallbackWhat = hostIsSupportedOam ? `serving on this oam ${hostOam} instead` : "using Node instead";

/**
 * No usable oam, under a mode that allows a fallback. On Node, and on an oam
 * host at or above the floor, the server runs in THIS process. An oam host
 * below the floor never serves, so it hands off to Node on PATH.
 */
async function fallBack(why) {
  if (hostOam === undefined || hostIsSupportedOam) {
    await runInProcess();
    return;
  }
  await handOffToNode(`this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}, and ${why}`);
}

// Computed once: the plan reads whether a spawn would carry --permission off
// the very list the spawn below passes, so the two cannot drift.
const sandbox = sandboxFlags();
const plan = runtimePlan({ mode, hostOam, sandbox: sandbox.length > 0 });

if (plan === "in-process") {
  await runInProcess();
} else if (plan === "handoff-node") {
  await handOffToNode(hostIsSupportedOam ? "" : `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}`);
} else {
  const { chosen, overrideNote, skipped } = chooseOam();

  if (chosen) {
    if (overrideNote) {
      await errSync(`postgres-mcp: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    }
    // `--` separates oam's own flags from the script's argv. Everything after
    // it lands in process.argv for the server, so `postgres-mcp version` and
    // any host-supplied flags survive the hop unchanged. The sandbox flags are
    // PROCESS-level and so go before `run`.
    await launchChild(chosen.path, [...sandbox, "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], async (err) => {
      if (mode === "oam") {
        await errSync(`postgres-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err})\n`);
        process.exit(1);
      }
      await errSync(`postgres-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err}); ${fallbackWhat}.\n`);
      await fallBack("the newer oam could not be launched");
    });
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [`found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`]
        : []),
    ];
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else.
      await errSync(
        `postgres-mcp: POSTGRES_MCP_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          "Install or update from https://oamjs.org, set OAM_BIN=/path/to/oam, or use POSTGRES_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong, their oam is too old to use, or their install is
    // a shape this launcher skips.
    if (notes.length > 0) await errSync(`postgres-mcp: ${notes.join("; ")}; ${fallbackWhat}.\n`);
    await fallBack("no newer oam was found").catch(fallbackFailed);
  }
}
