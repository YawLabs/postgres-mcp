/**
 * Opt-in audit trail for the SQL this server runs on the operator's database.
 *
 * Off by default. A database MCP server that starts recording every query
 * nobody asked for is its own privacy incident, so silence stays the default
 * and each knob below has to be set deliberately.
 *
 * Config (repeated in api.ts's config block, which is where operators look):
 *   - POSTGRES_AUDIT_LOG       - "1" | "true" | "stderr" turns the audit log on,
 *                                writing to stderr; "0" | "false" | "off" is the
 *                                explicit off. Case-insensitive.
 *   - POSTGRES_AUDIT_LOG_FILE  - append the JSON lines to this path instead of
 *                                stderr. Setting it alone turns auditing on.
 *   - POSTGRES_AUDIT_REDACT    - "1" | "true" to log the statement's first
 *                                keyword plus a sha256 of its text, never the
 *                                SQL itself.
 *
 * Every one of these rejects an unrecognized value by throwing at startup
 * instead of falling back to off. `POSTGRES_AUDIT_LOG=yes` leaving the trail
 * silently empty -- or `POSTGRES_AUDIT_REDACT=yes` silently writing full SQL
 * to disk -- is exactly the failure the strictness prevents: a security
 * control that quietly disables itself is worse than none, because the
 * operator believes they have a trail.
 *
 * Default destination is stderr because a stdio MCP server owns stdout for
 * protocol framing -- an audit line written there lands mid-JSON-RPC frame and
 * kills the session.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";

/**
 * `internal` marks catalog/introspection SQL this server composes itself;
 * `user` marks SQL that arrived from the agent. Without the distinction an
 * operator reading the log cannot tell an agent's DELETE from the dozen
 * catalog lookups a single pg_schemas call fans out into.
 */
export type AuditSource = "user" | "internal";

export interface AuditConfig {
  enabled: boolean;
  /** Path to append to, or null for the stderr sink. */
  file: string | null;
  redact: boolean;
}

export interface AuditMeta {
  source: AuditSource;
  sql: string;
  /**
   * COUNT, never the values. Bound parameters routinely carry exactly the
   * material an audit log must not accumulate -- credentials, tokens, email
   * addresses, whole PII rows on an INSERT.
   */
  paramCount: number;
}

type AuditSink = (line: string) => void;

let enabled = false;
let redactSql = false;
let sink: AuditSink | null = null;
let auditFd: number | null = null;
let initialized = false;
// One warning per process. A sink that fails once (full disk, closed pipe)
// usually fails on every subsequent line, and an audit failure that floods
// stderr turns a degraded log into an unusable server.
let sinkFailureReported = false;

const OFF_VALUES = ["0", "false", "off"];

/**
 * Returns true/false for a recognized value, null when the var is absent or
 * empty (a shell that exports the name with no value). Anything else throws --
 * see the module header for why a typo must not read as "off".
 */
function parseStrictFlag(name: string, raw: string | undefined, onValues: string[]): boolean | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (onValues.includes(value)) return true;
  if (OFF_VALUES.includes(value)) return false;
  const expected = [...onValues, ...OFF_VALUES].map((v) => JSON.stringify(v)).join(", ");
  throw new Error(
    `[postgres-mcp] ${name}=${JSON.stringify(raw)} is not a recognized value; expected one of ${expected}. ` +
      "Refusing to start rather than run with the audit trail silently off.",
  );
}

export function getAuditConfig(): AuditConfig {
  // "stderr" is accepted as an on-value so the destination can be read off the
  // variable itself; it selects the same sink as "1".
  const flag = parseStrictFlag("POSTGRES_AUDIT_LOG", process.env.POSTGRES_AUDIT_LOG, ["1", "true", "stderr"]);
  const redact = parseStrictFlag("POSTGRES_AUDIT_REDACT", process.env.POSTGRES_AUDIT_REDACT, ["1", "true"]) ?? false;

  let file: string | null = null;
  const rawFile = process.env.POSTGRES_AUDIT_LOG_FILE;
  if (rawFile !== undefined) {
    // Trailing whitespace in a path is a copy-paste artifact, never intent.
    file = rawFile.trim();
    if (file === "") {
      throw new Error(
        "[postgres-mcp] POSTGRES_AUDIT_LOG_FILE is set but empty (an unexpanded variable in the MCP config?). " +
          "Refusing to start: falling back to stderr here would hand the operator a trail they cannot find.",
      );
    }
    if (flag === false) {
      throw new Error(
        `[postgres-mcp] POSTGRES_AUDIT_LOG_FILE=${JSON.stringify(rawFile)} is set while ` +
          `POSTGRES_AUDIT_LOG=${JSON.stringify(process.env.POSTGRES_AUDIT_LOG)} turns auditing off. ` +
          "Refusing to guess which one you meant -- unset one of them.",
      );
    }
  }

  return { enabled: flag === true || file !== null, file, redact };
}

/**
 * Reads the env and opens the sink. Idempotent, and called at api.ts module
 * load so a misconfigured audit log kills the process at startup, while the
 * operator is still watching, rather than at the first tool call -- or never.
 */
export function initAudit(): void {
  if (initialized) return;
  const config = getAuditConfig();
  if (!config.enabled) {
    initialized = true;
    return;
  }

  if (config.file !== null) {
    let fd: number;
    try {
      // Append, and hold the descriptor for the life of the process: reopening
      // per line costs a syscall pair on every query and lets a mid-session
      // rename silently redirect the trail to a file nobody is watching.
      fd = openSync(config.file, "a");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[postgres-mcp] audit log file ${JSON.stringify(config.file)} could not be opened for append: ${message}. ` +
          "Refusing to start: degrading to no audit trail leaves the operator believing one exists.",
      );
    }
    auditFd = fd;
    sink = (line) => {
      writeSync(fd, line);
    };
  } else {
    // process.stderr.write, not writeSync(2, ...): stderr can be a non-blocking
    // pipe, where the sync form surfaces EAGAIN as a throw and drops the line
    // instead of applying backpressure.
    sink = (line) => {
      process.stderr.write(line);
    };
  }

  redactSql = config.redact;
  enabled = true;
  initialized = true;
}

export function isAuditEnabled(): boolean {
  return enabled;
}

// The tool name is not reachable from the execution paths in api.ts -- by the
// time SQL arrives there the MCP handler frame is gone. A caller that knows it
// (the MCP tool wrapper) runs the handler inside this context and every
// statement underneath is tagged; callers that do not simply omit the field.
const toolContext = new AsyncLocalStorage<string>();

export function runWithAuditTool<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  // Skip the async-context frame entirely when auditing is off, so the opt-in
  // control costs nothing on the default path.
  if (!enabled) return fn();
  return toolContext.run(tool, fn);
}

/**
 * First keyword of the statement, for the redacted mode. Deliberately letters
 * only: a value-bearing prefix (a leading literal, a comment carrying part of
 * the payload) must not slip into the log through this field, so anything that
 * does not start with a bare word reports UNKNOWN.
 */
function firstKeyword(sql: string): string {
  const keyword = /^[\s(]*([A-Za-z]+)/.exec(sql)?.[1];
  return keyword === undefined ? "UNKNOWN" : keyword.toUpperCase();
}

function sqlFields(sql: string): Record<string, string> {
  if (!redactSql) return { sql };
  return {
    sqlKeyword: firstKeyword(sql),
    // Full text hashed, not truncated: the digest is what lets an operator
    // correlate repeated statements, and match a line against a known query,
    // without the log holding the literals that statement embedded.
    sqlSha256: createHash("sha256").update(sql).digest("hex"),
  };
}

/** pg carries SQLSTATE on `code`; a socket error or a thrown non-Error has none. */
function sqlstateOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

interface AuditRecord extends AuditMeta {
  ok: boolean;
  durationMs: number;
  rowCount: number | null;
  sqlstate?: string;
}

function record(entry: AuditRecord): void {
  if (!enabled || sink === null) return;
  // Bind the sink before building the line: resetAuditForTests() (and any
  // future re-init) nulls the module variable, and the null check above would
  // not protect a later dereference.
  const currentSink = sink;
  try {
    const tool = toolContext.getStore();
    const line = {
      ts: new Date().toISOString(),
      ...(tool !== undefined ? { tool } : {}),
      source: entry.source,
      ...sqlFields(entry.sql),
      params: entry.paramCount,
      // Sub-millisecond statements are the norm against a local socket; three
      // decimals keeps them from all reporting 0.
      ms: Math.round(entry.durationMs * 1000) / 1000,
      // Always present, null on failure, so a log consumer can project a fixed
      // schema over the file instead of special-casing a missing key.
      rows: entry.rowCount,
      ok: entry.ok,
      // SQLSTATE only, never the error message: postgres quotes the offending
      // values back at you ("Key (email)=(a@b.com) already exists"), which is
      // the same PII the parameter-count rule above exists to keep out.
      ...(entry.sqlstate !== undefined ? { sqlstate: entry.sqlstate } : {}),
    };
    currentSink(`${JSON.stringify(line)}\n`);
  } catch (err) {
    reportSinkFailure(err);
  }
}

function reportSinkFailure(err: unknown): void {
  if (sinkFailureReported) return;
  sinkFailureReported = true;
  try {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[postgres-mcp] audit log write failed (further audit-write failures are suppressed): ${message}`);
  } catch {
    // The warning itself went through a broken stderr. There is nothing left to
    // report it on, and throwing from here would reach the query this must not
    // break.
  }
  // Auditing deliberately stays enabled: a full disk that gets cleared, or a
  // transient EAGAIN, should resume logging rather than leave the rest of the
  // session untracked because of one bad write.
}

/**
 * Times `run`, records one audit line, and returns/rethrows exactly what `run`
 * produced. Callers keep their signatures and their return shapes -- the audit
 * is a side effect on the way through.
 *
 * `rowCountOf` is consulted only on success, and a throw from it is swallowed:
 * an audit that breaks the query it observes is worse than a missing field.
 */
export async function auditQuery<T>(
  meta: AuditMeta,
  run: () => Promise<T>,
  rowCountOf: (result: T) => number | null,
): Promise<T> {
  if (!enabled) return run();
  // performance.now(), not Date.now(): an NTP step mid-query makes a
  // wall-clock delta negative, and a negative duration in an audit trail reads
  // as tampering.
  const startedAt = performance.now();
  try {
    const result = await run();
    let rowCount: number | null = null;
    try {
      rowCount = rowCountOf(result);
    } catch {
      // A result shape the accessor did not expect. Log the statement without
      // the count rather than losing the line.
    }
    record({ ...meta, ok: true, durationMs: performance.now() - startedAt, rowCount });
    return result;
  } catch (err) {
    record({
      ...meta,
      ok: false,
      durationMs: performance.now() - startedAt,
      rowCount: null,
      sqlstate: sqlstateOf(err),
    });
    throw err;
  }
}

/**
 * Test-only. Closes any open sink and returns the module to its pre-init state
 * so a test can exercise a different env. Not part of the public API.
 *
 * There is deliberately no production counterpart: `shutdown()` in api.ts
 * leaves the audit sink open, because a pool rebuilt after shutdown() must
 * still be audited, and the descriptor is reaped when the process exits.
 */
export function resetAuditForTests(): void {
  if (auditFd !== null) {
    try {
      closeSync(auditFd);
    } catch {
      // Already closed -- nothing to salvage in a test-only reset.
    }
    auditFd = null;
  }
  enabled = false;
  redactSql = false;
  sink = null;
  initialized = false;
  sinkFailureReported = false;
}

/**
 * Test-only. Replaces the sink after `initAudit()` so a test can capture lines
 * or install one that throws. Not part of the public API.
 */
export function setAuditSinkForTests(replacement: AuditSink): void {
  sink = replacement;
}
