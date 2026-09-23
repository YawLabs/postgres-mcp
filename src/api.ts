/**
 * PostgreSQL connection pool with read-only enforcement.
 *
 * Config:
 *   - DATABASE_URL                         - postgres connection string (required)
 *   - ALLOW_WRITES                         - set to "1" or "true" to allow DML/DDL (default: read-only)
 *   - POSTGRES_STATEMENT_TIMEOUT_MS        - per-statement timeout (default: 30000)
 *   - POSTGRES_CONNECTION_TIMEOUT_MS       - TCP connect timeout (default: 10000). Without
 *                                            this, a dead host hangs until the OS gives up
 *                                            (~2 minutes on most platforms).
 *   - POSTGRES_MAX_ROWS                    - max rows returned by pg_query (default: 1000)
 *   - POSTGRES_POOL_MAX                    - max pool connections (default: 5). Set to 1 for
 *                                            single-threaded backends (pglite-socket, PgBouncer
 *                                            transaction mode) that can't handle concurrent queries.
 *   - POSTGRES_SSL_REJECT_UNAUTHORIZED     - "false" to disable TLS cert verification (for managed
 *                                            databases using private-CA certs: Supabase, Neon,
 *                                            RDS with a custom CA). Connection is still encrypted.
 *   - POSTGRES_APPLICATION_NAME            - value reported in pg_stat_activity.application_name
 *                                            (default: "postgres-mcp"). An `application_name` in
 *                                            DATABASE_URL wins over this: pg's ConnectionParameters
 *                                            does `Object.assign({}, config, parse(connectionString))`,
 *                                            so parsed DSN keys override explicit config. A DSN with
 *                                            no application_name emits no such key, so it cannot
 *                                            clobber this default with undefined.
 *   - POSTGRES_AUDIT_LOG                   - "1", "true", or "stderr" to write one JSON line per
 *                                            statement to stderr (default: off). Bound parameter
 *                                            VALUES are never logged in any mode -- only their
 *                                            count. The server refuses to start on an empty or
 *                                            unrecognized value rather than read it as off.
 *                                            See audit.ts.
 *   - POSTGRES_AUDIT_LOG_FILE              - append the audit lines to this path instead of stderr.
 *                                            Setting it alone turns auditing on. The server refuses
 *                                            to start when the file cannot be opened, rather than
 *                                            run with the trail silently disabled.
 *   - POSTGRES_AUDIT_REDACT                - "1" or "true" to log each statement's first keyword
 *                                            plus a sha256 of its text instead of the SQL, for
 *                                            operators who want the trail without the literals.
 *                                            An empty or unrecognized value stops the server too,
 *                                            even with auditing off: read as off, it would log
 *                                            full SQL.
 *
 * Safety model:
 *   User-provided SQL runs in a `BEGIN READ ONLY` transaction by default, so
 *   postgres itself rejects any write. Enable writes via ALLOW_WRITES=1 - the
 *   tool handlers also surface this hint in their descriptions/errors so an
 *   LLM doesn't blindly retry a blocked write.
 */

import pg from "pg";
import { auditQuery, initAudit } from "./audit.js";

// Open the audit sink at module load rather than lazily on the first query: a
// POSTGRES_AUDIT_LOG_FILE that cannot be opened has to kill the process at
// startup, while the operator is still watching, instead of surfacing as one
// failed tool call much later -- or never, if no query is ever run. index.ts
// imports this module before the transport connects, so module load is
// startup. The call is idempotent, so tool modules importing api.ts do not
// re-open the sink.
initAudit();

// pg 8.14+ supports `queryMode: 'extended'` on QueryConfig to force the
// extended query protocol even when `values` is empty. @types/pg has not yet
// exposed this field, so we widen the type locally. Remove once DefinitelyTyped
// catches up.
type UserQueryConfig = pg.QueryConfig & { queryMode?: "extended" | "simple" };

let pool: pg.Pool | null = null;

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    const hint =
      process.platform === "win32"
        ? " On Windows, env vars set in bash/WSL profiles are not visible to MCP servers launched via cmd." +
          ' Add "env": {"DATABASE_URL": "postgres://..."} to your .mcp.json.'
        : "";
    throw new Error(`DATABASE_URL is not set. Provide a PostgreSQL connection string.${hint}`);
  }
  return url;
}

export function getStatementTimeoutMs(): number {
  const raw = process.env.POSTGRES_STATEMENT_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

export function getConnectionTimeoutMs(): number {
  const raw = process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
  if (!raw) return 10_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

export function getMaxRows(): number {
  const raw = process.env.POSTGRES_MAX_ROWS;
  if (!raw) return 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
}

export function getPoolMax(): number {
  const raw = process.env.POSTGRES_POOL_MAX;
  if (!raw) return 5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

export function isWritesAllowed(): boolean {
  const v = process.env.ALLOW_WRITES;
  return v === "1" || v === "true";
}

export function getApplicationName(): string {
  const raw = process.env.POSTGRES_APPLICATION_NAME;
  return raw && raw.trim() !== "" ? raw : "postgres-mcp";
}

/**
 * `server_version_num` cut points, as postgres reports them: major * 10000.
 * Used to gate catalog columns that do not exist on older servers. Naming a
 * constant beats an inline 160000 -- the number alone reads as a row count.
 */
export const PG12 = 120_000;
export const PG13 = 130_000;
export const PG16 = 160_000;
export const PG17 = 170_000;
export const PG18 = 180_000;
export const PG19 = 190_000;

/**
 * SQL predicate excluding PostgreSQL's own schemas from a user-facing listing.
 *
 * ONE definition because there used to be two, and they disagreed. Some queries
 * wrote `NOT LIKE 'pg_%'` while others wrote `NOT LIKE 'pg_toast%' AND NOT LIKE
 * 'pg_temp_%'`. The gap between them is far wider than the literal reading
 * suggests: in SQL LIKE, `_` is a single-character WILDCARD, so `pg_%` matches
 * "pg" followed by ANY character -- it swallows `pgagent`, `pgboss`,
 * `pgbouncer`, `pglogical`, `pganalyze`, every user schema whose name merely
 * starts with "pg". The literal reading -- a genuinely `pg_`-prefixed schema
 * that is neither toast nor temp -- describes a case that cannot occur:
 * postgres rejects `CREATE SCHEMA pg_anything` with `unacceptable schema name
 * ... The prefix "pg_" is reserved for system schemas`, so the only real
 * `pg_`-prefixed schemas are the server's own pg_toast / pg_temp_N. That split
 * let `pg_list_schemas` (the permissive form) advertise a schema like `pgagent`
 * that `pg_search_columns` and the stats tools (the broad form) then silently
 * returned nothing for -- a user sees the schema, asks about it, and gets an
 * empty result with no reason given.
 *
 * The permissive spelling is the one kept: it names exactly what it excludes,
 * and a discovery tool must never surface a schema the analysis tools refuse to
 * answer about. `pg_catalog` and `information_schema` are matched by identity;
 * `pg_toast*` and `pg_temp_*` by prefix because their names carry a numeric
 * suffix per backend.
 *
 * `column` is interpolated into SQL and MUST be a literal from this codebase
 * (`n.nspname`, `schemaname`, `s.schemaname`) -- never a caller-supplied value.
 */
export function userSchemaFilter(column: string): string {
  return (
    `${column} NOT IN ('pg_catalog', 'information_schema') ` +
    `AND ${column} NOT LIKE 'pg_toast%' ` +
    `AND ${column} NOT LIKE 'pg_temp_%'`
  );
}

/**
 * Minimal structural type satisfied by both `pg.Pool` and `pg.PoolClient`, so
 * the version probe can run on a shared client (inside `withSharedClient`)
 * or on the pool directly.
 */
interface VersionProbeRunner {
  query<R extends pg.QueryResultRow>(sql: string): Promise<pg.QueryResult<R>>;
}

// Cached server_version_num. Only a successful, positive read is cached --
// see getServerVersionNum for why failures deliberately are not.
let serverVersionNum: number | null = null;

// Bumped by shutdown(). A probe suspended on its await when shutdown lands
// would otherwise republish the OLD server's version into the cache the NEW
// pool uses -- gating catalog queries against the wrong server, which is the
// exact failure the reset in shutdown() exists to prevent. Same hazard
// resolveTypeNames guards by binding a local before its first await; this
// counter is the equivalent for a scalar.
let poolGeneration = 0;

/** The probe's statement, named so the audit line and the query cannot drift apart. */
const VERSION_PROBE_SQL = "SELECT current_setting('server_version_num') AS v";

/**
 * Returns `server_version_num` (e.g. 180000 for PG 18), or 0 when it cannot
 * be determined.
 *
 * 0 is the "assume oldest" sentinel: every caller gates with `>= PGxx`, so an
 * unknown version falls through to the conservative pre-feature query rather
 * than emitting SQL that references a column the server does not have. That
 * fails to a slightly poorer answer, never to a broken one.
 *
 * Failures are NOT cached. Caching 0 would pin the process to degraded output
 * for its whole lifetime after one transient hiccup (a pool blip during the
 * very first tool call), and the probe is a single cheap GUC read -- retrying
 * on the next call costs far less than being permanently wrong.
 *
 * Concurrency: two callers racing before the cache is populated both run the
 * probe and both write the same value. Harmless duplicate work, same tradeoff
 * as the typeNameCache bootstrap above.
 *
 * Audited as an `internal` line, like the catalog SQL runInternal sends, and
 * for the same reason (#42): the callers that gate on the version run this
 * probe BEFORE anything else reaches the database, and a failure here comes
 * back as the 0 sentinel with no error attached. Unaudited, a refused
 * connection under pg_explain with a version-floored option, or under any of
 * the tools that probe before checking out their shared connection, wrote no
 * line at all -- the call answered "the server version could not be
 * determined" and the trail showed nothing was attempted. On a healthy server
 * the line appears once per process, since a successful reading is cached;
 * while the server is unreachable it appears on every probing call, since a
 * failure is not. `getPool()` sits inside the audited step so a missing
 * DATABASE_URL is recorded too, as runInternal records it.
 */
export async function getServerVersionNum(client?: VersionProbeRunner): Promise<number> {
  if (serverVersionNum !== null) return serverVersionNum;
  // Snapshot BEFORE the await -- see poolGeneration.
  const generation = poolGeneration;
  try {
    const res = await auditQuery(
      { source: "internal", sql: VERSION_PROBE_SQL, paramCount: 0 },
      async () => {
        const runner: VersionProbeRunner = client ?? getPool();
        return runner.query<{ v: string }>(VERSION_PROBE_SQL);
      },
      (r) => r.rowCount ?? r.rows.length,
    );
    const parsed = Number.parseInt(res.rows[0]?.v ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      // Only publish if no shutdown() landed while we were suspended. If one
      // did, this reading describes a pool that no longer exists; return it to
      // THIS caller (it was true when asked) but do not cache it for the next.
      if (generation === poolGeneration) serverVersionNum = parsed;
      return parsed;
    }
    return 0;
  } catch {
    return 0;
  }
}

export function getSslConfig(): { rejectUnauthorized: boolean } | undefined {
  const raw = process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
  if (raw === undefined) return undefined;
  if (raw === "0" || raw === "false") return { rejectUnauthorized: false };
  if (raw === "1" || raw === "true") return { rejectUnauthorized: true };
  // Env var IS set but doesn't match a recognized form (e.g. `Flase`, `yes`,
  // empty string). Returning undefined here would silently fall through to
  // pg's default behavior, which is indistinguishable from "env var unset"
  // and lets a typo connect with unintended TLS posture. Surface the
  // misconfiguration on stderr (stdio MCP uses stdout for protocol, so
  // stderr is safe for logs).
  console.error(
    `[postgres-mcp] POSTGRES_SSL_REJECT_UNAUTHORIZED=${JSON.stringify(raw)} not recognized; expected "0", "false", "1", or "true". Deferring to the pg driver / connection-string default.`,
  );
  return undefined;
}

/**
 * Returns the singleton pool, creating it on first call.
 *
 * Env-var snapshot semantics: every option below is read ONCE, when the pool
 * is constructed. Changing `DATABASE_URL`, `POSTGRES_STATEMENT_TIMEOUT_MS`,
 * `POSTGRES_CONNECTION_TIMEOUT_MS`, `POSTGRES_POOL_MAX`, or
 * `POSTGRES_SSL_REJECT_UNAUTHORIZED` after the first tool call has no effect
 * until `shutdown()` runs and a subsequent call rebuilds the pool.
 *
 * Two values are intentionally re-read on every request and are NOT snapshotted
 * here: `getMaxRows()` and `isWritesAllowed()`. The per-request re-read matters
 * for in-process callers (tests set `process.env.ALLOW_WRITES` between calls)
 * and keeps the flag out of the pool snapshot above. It does NOT give an
 * operator a live toggle: a stdio MCP server's environment is fixed at spawn
 * by the host's config, so changing `ALLOW_WRITES` (or `POSTGRES_MAX_ROWS`)
 * on a running server requires the MCP host to restart it.
 */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const ssl = getSslConfig();
  pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
    // Identify this server in pg_stat_activity. Without it, agent traffic is
    // anonymous to whoever is watching the database -- while pg_health itself
    // reports application_name for every OTHER session. See getApplicationName
    // for why a DSN-supplied application_name still wins.
    application_name: getApplicationName(),
    statement_timeout: getStatementTimeoutMs(),
    connectionTimeoutMillis: getConnectionTimeoutMs(),
    max: getPoolMax(),
    // MCP sessions can have minutes-long gaps between tool calls. A short
    // idleTimeout forces a reconnect on every tool call. 60s keeps the pool
    // warm without holding connections indefinitely.
    idleTimeoutMillis: 60_000,
    ...(ssl ? { ssl } : {}),
  });
  // pg's Pool emits 'error' for idle client failures. Log to stderr so the
  // stdio MCP protocol channel (stdout) stays clean.
  pool.on("error", (err) => {
    console.error(`[postgres-mcp] pool error: ${err.message}`);
  });
  return pool;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  /**
   * For DML, the number of rows AFFECTED -- which is not necessarily
   * `rows.length`. An `INSERT ... RETURNING` of 10 rows truncated to 3 reports
   * `rowCount: 10`, `rows.length: 3`, `truncated: true`.
   *
   * For a truncated row-returning statement (the cursor path) the true total
   * is unknowable by design -- the whole point of the bounded fetch is not to
   * materialize it -- so `rowCount` matches `rows.length` there.
   */
  rowCount: number | null;
  fields: { name: string; dataTypeID: number; dataTypeName?: string }[];
  /**
   * Postgres command tag, present ONLY when the statement ran on the direct
   * exec path (DDL, DML without RETURNING) -- there it is the real tag
   * (`CREATE TABLE`, `INSERT`, ...).
   *
   * Omitted on the cursor path. A statement wrapped in `DECLARE ... CURSOR
   * FOR` reports the tag of the `FETCH`, not of the user's statement, and
   * postgres does not surface the inner tag through a cursor. Reporting
   * `"FETCH"` for every SELECT was actively misleading, and there is no
   * source of truth to substitute -- so the field is absent rather than
   * wrong. Treat absent as "row-returning statement, command unknown".
   */
  command?: string;
  truncated?: boolean;
}

// pg_type oid -> typname. Bootstrapped on first user query, then miss-filled
// for any new oid (e.g. a CREATE TYPE during the session). Cleared on
// shutdown(). The cache is small (a few hundred rows on a stock cluster).
//
// Staleness: postgres only reuses a pg_type oid after the cluster-wide 32-bit
// OID counter wraps -- billions of catalog inserts. A DROP TYPE / CREATE TYPE
// with the same name within a session gets a NEW oid, which the miss-fill path
// picks up. The stale entry under the old oid stays in the map until shutdown
// but is never read back (no result row references the dead oid), so it's
// wasted memory, not a correctness bug.
//
// Concurrency: the null check and the `new Map()` assignment in
// resolveTypeNames are synchronous (no await between them), so the bootstrap
// SELECT runs at most once per cache lifetime. The actual race with
// POSTGRES_POOL_MAX>1: a second concurrent caller sees an empty-but-non-null
// map, skips the bootstrap, and runs the targeted `WHERE oid = ANY($1)`
// miss-fill for its oids -- harmless duplicate targeted work; both callers
// merge entries into the same shared Map.
let typeNameCache: Map<number, string> | null = null;

/**
 * Anything that can run the two catalog reads below: a checked-out client, or
 * the pool itself when the checkout's connection is already gone.
 */
interface TypeNameRunner {
  query<R extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

async function resolveTypeNames(client: TypeNameRunner, oids: number[]): Promise<Record<number, string>> {
  if (oids.length === 0) return {};
  // Bind the map to a local BEFORE the first await. `shutdown()` sets the
  // module-scoped `typeNameCache` back to null, and it can land while we're
  // suspended on one of the queries below (SIGTERM, or a test calling
  // shutdown() between tool calls) -- dereferencing the module variable after
  // an await would then throw on null. The local keeps this call's writes
  // going somewhere valid; a post-shutdown cache is simply garbage-collected
  // instead of being re-published.
  let cache = typeNameCache;
  if (!cache) {
    cache = new Map();
    typeNameCache = cache;
    const res = await client.query<{ oid: number; typname: string }>("SELECT oid, typname FROM pg_catalog.pg_type");
    for (const row of res.rows) cache.set(row.oid, row.typname);
  }
  const missing = oids.filter((o) => !cache.has(o));
  if (missing.length > 0) {
    const res = await client.query<{ oid: number; typname: string }>(
      "SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1)",
      [missing],
    );
    for (const row of res.rows) cache.set(row.oid, row.typname);
  }
  const out: Record<number, string> = {};
  for (const oid of oids) {
    const n = cache.get(oid);
    if (n !== undefined) out[oid] = n;
  }
  return out;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function formatPgError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const errObj = err as Error & { code?: string; detail?: string; hint?: string };
  const parts: string[] = [err.message];
  if (errObj.code) parts.push(`(code: ${errObj.code})`);
  if (errObj.detail) parts.push(`detail: ${errObj.detail}`);
  if (errObj.hint) parts.push(`hint: ${errObj.hint}`);

  // Read-only enforcement: postgres returns SQLSTATE 25006 for writes inside
  // a READ ONLY transaction. Rewrite that to something the LLM can act on.
  if (errObj.code === "25006") {
    return `Write blocked: this server is in read-only mode. Set ALLOW_WRITES=1 in the MCP server env to enable DML/DDL. Original error: ${err.message}`;
  }

  return parts.join(" ");
}

/**
 * The SQLSTATEs with which postgres says "this statement cannot be a cursor",
 * and so the only DECLARE failures that may fall back to a direct run.
 *
 * Measured on PostgreSQL 15, 17 and 18 over 69 statement classes, identical on
 * all three: `42601` for everything the DECLARE grammar rejects (DDL, DML with
 * or without RETURNING, MERGE, EXPLAIN, SHOW, SET, utility commands, a
 * multi-statement string, an empty one), and `0A000` for a data-modifying CTE.
 * Every other DECLARE failure in that set -- 42P01, 42703, 42883, 22012, 42P18,
 * 08P01 -- failed the same way on a direct run, so rethrowing it changes no
 * outcome.
 *
 * It used to be "any DECLARE failure", which also caught the failures that are
 * about the ATTEMPT and not the statement. DECLARE plans the query and locks
 * every relation it reads, so a statement blocked on a table lock is blocked
 * inside DECLARE -- and a cancel (57014) landing there was swallowed: the SQL
 * was sent again, outside the row cap, and the caller later got rows back from
 * a query that had been cancelled. A statement timeout got a second full
 * timeout the same way (3000 ms configured, 6003 ms measured), and a terminate
 * had its 57P01 replaced by the error of a ROLLBACK TO sent down the dead
 * socket, leaving the audit line with no SQLSTATE.
 */
const NOT_CURSORABLE_SQLSTATES: ReadonlySet<string> = new Set(["42601", "0A000"]);

function isNotCursorable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_CURSORABLE_SQLSTATES.has(code);
}

/**
 * Run user SQL with a memory-bounded fetch.
 *
 * Without this wrapper, node-pg materializes the entire result set into
 * Node memory before our `MAX_ROWS` slice runs -- so a payload like
 * `SELECT * FROM big1 CROSS JOIN big2` could OOM the MCP process before
 * the `statement_timeout` fired. Truncation was output-only, not
 * fetch-bounded.
 *
 * The fix: wrap the user SQL in a server-side `DECLARE ... CURSOR FOR`,
 * fetch only `maxRows + 1` rows, close the cursor. Postgres now does the
 * heavy lifting and we never hold more than the response size in Node.
 *
 * Not every statement is cursorable -- DECLARE only takes a SELECT-shaped
 * statement. We wrap the attempt in a SAVEPOINT so a DECLARE failure doesn't
 * abort the outer transaction; on the fallback path we execute the SQL
 * directly, accepting that those statements never produce a runaway result
 * set anyway (DDL returns no rows, DML without RETURNING returns no rows).
 */
async function runUserQueryBounded(
  client: pg.PoolClient,
  sql: string,
  params: unknown[],
  maxRows: number,
): Promise<{ result: pg.QueryResult; viaCursor: boolean }> {
  await client.query("SAVEPOINT __pgmcp_sp");
  // Track where in the pipeline we are. If DECLARE itself fails the user SQL
  // has not executed yet, so a direct exec cannot double-execute anything --
  // but it is only RIGHT when postgres said the statement cannot be a cursor
  // (see NOT_CURSORABLE_SQLSTATES). If DECLARE succeeded and a later step
  // (FETCH / CLOSE / RELEASE) threw, the user SQL already ran; re-running it
  // could double-execute side effects.
  let declareSucceeded = false;
  try {
    await client.query({
      text: `DECLARE __pgmcp_cur NO SCROLL CURSOR FOR ${sql}`,
      values: params,
      queryMode: "extended",
    } as UserQueryConfig);
    declareSucceeded = true;
    const fetched = await client.query(`FETCH ${maxRows + 1} FROM __pgmcp_cur`);
    try {
      await client.query("CLOSE __pgmcp_cur");
    } catch {
      // CLOSE on a still-open cursor should not fail in normal flow;
      // a stale-cursor edge here doesn't change correctness because the
      // outer txn rollback below releases the cursor too.
    }
    await client.query("RELEASE SAVEPOINT __pgmcp_sp");
    // viaCursor: `fetched.command` is the FETCH tag, not the user statement's.
    // Callers use this to omit `command` rather than report a wrong one.
    return { result: fetched, viaCursor: true };
  } catch (err) {
    if (declareSucceeded) {
      // FETCH / CLOSE / RELEASE failed -- the user SQL already executed
      // inside the cursor. Re-throw so the outer transaction rolls back
      // instead of silently re-executing the statement.
      throw err;
    }
    if (!isNotCursorable(err)) {
      // DECLARE failed for a reason that is not about cursorability: a cancel
      // or timeout, a terminate, a deadlock, a dead socket, or a statement that
      // is simply wrong. Surface THAT error, once. Sending the SQL again would
      // swallow the interrupt, and nothing more may be sent on this connection
      // if it is gone -- the caller's transaction cleanup handles both.
      throw err;
    }
    // Not cursorable, and no user SQL has run. Roll back the savepoint and
    // retry on the direct-exec path.
    await client.query("ROLLBACK TO SAVEPOINT __pgmcp_sp");
    await client.query("RELEASE SAVEPOINT __pgmcp_sp");
    // Direct exec: the command tag postgres returns here IS the user's
    // statement tag (CREATE TABLE, INSERT, ...), so it's safe to surface.
    const direct = await client.query({
      text: sql,
      values: params,
      queryMode: "extended",
    } as UserQueryConfig);
    return { result: direct, viaCursor: false };
  }
}

/**
 * One audit line for one agent statement (no-op unless POSTGRES_AUDIT_LOG /
 * POSTGRES_AUDIT_LOG_FILE is set). It exists as its own wrapper so all three
 * user-SQL paths record the statement identically -- one path quietly missing
 * the audit is the failure an inline call at each site invites, and a partial
 * trail is the kind an operator only discovers during an incident.
 *
 * `run` is EVERYTHING the statement needs in order to execute -- checking the
 * connection out of the pool, `BEGIN`, the hook savepoint and `setup`, and
 * only then the statement itself through runUserQueryBounded -- not just that
 * last step. The line is written whichever of them fails, so a call that got
 * no connection, or whose `BEGIN` or hypothetical-index setup was refused,
 * still records the SQL the agent asked to run: `ok: false`, with the code of
 * the failure where there is one. Auditing only the statement left exactly
 * those calls silent, and only them: runInternal connects inside its audited
 * step, so against a refused connection every tool that starts with a catalog
 * query wrote its `ok: false` line while pg_query, pg_readonly and pg_explain
 * -- the tools the trail exists for -- wrote nothing (#42). A pg_explain whose
 * hypothetical index could not be created was the same shape: five statements
 * sent, an error returned, and one line, the `ok: true` HypoPG check.
 *
 * Because the span is a single wrapper, a failure is logged once: nothing
 * inside it audits on its own (hooks query the client directly). The cost is
 * that `ms` on a `user` line runs from the checkout to the statement's
 * completion, so it includes waiting for a pooled connection and the
 * transaction setup, as `internal` lines already could.
 *
 * `source: "user"` separates agent-supplied SQL from the internal catalog
 * queries runInternal / withSharedClient record.
 */
async function auditUserStatement<T extends { result: pg.QueryResult }>(
  sql: string,
  params: unknown[],
  run: () => Promise<T>,
): Promise<T> {
  return auditQuery(
    { source: "user", sql, paramCount: params.length },
    run,
    // Rows as postgres reported them: the affected-row count on the
    // direct-exec path, and on the cursor path the bounded FETCH count
    // (maxRows + 1 at most) -- the true total is unknowable there by design,
    // exactly as QueryResult.rowCount documents.
    ({ result }) => result.rowCount ?? result.rows.length,
  );
}

// Type-name resolution is decorative: a failure here must not lose the user's
// successful query result. Fall back to an empty map so fields still carry
// dataTypeID, just without the human-readable dataTypeName.
//
// Exported only for unit-test access -- the failure mode (pg_type query
// throws) is hard to engineer against a real database without
// permission-restricted roles, so a unit test passes a stub client that
// rejects. Not part of the public API; do not rely on this from outside
// the package.
export async function safeResolveTypeNames(
  client: TypeNameRunner,
  fields: { dataTypeID: number }[],
): Promise<Record<number, string>> {
  try {
    return await resolveTypeNames(client, [...new Set(fields.map((f) => f.dataTypeID))]);
  } catch (err) {
    console.error(`[postgres-mcp] type-name resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

// `viaCursor` is REQUIRED, deliberately: defaulting it would make "surface the
// FETCH tag / rewrite rowCount" the silent fallback for any future call site
// that forgets to pass it, which is exactly the bug this parameter exists to
// prevent.
function toQueryResult(
  result: pg.QueryResult,
  maxRows: number,
  typeNames: Record<number, string>,
  viaCursor: boolean,
): QueryResult {
  const truncated = result.rows.length > maxRows;
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
  return {
    rows,
    // Cursor path only: we deliberately FETCH maxRows + 1 to detect
    // truncation, so `result.rowCount` is one MORE than what we return --
    // consumers saw rowCount=1001 next to 1000 rows. Report what's in `rows`.
    //
    // The direct-exec path must NOT be rewritten. There `rowCount` is the
    // affected-row count, which is independent of how many rows came back:
    // `INSERT ... RETURNING` is non-cursorable (DECLARE rejects it with
    // 42601), so a 10-row insert truncated to 3 must still report 10 rows
    // affected. Collapsing it to rows.length told the caller 3 rows were
    // written when 10 were committed.
    rowCount: truncated && viaCursor ? rows.length : result.rowCount,
    fields: result.fields.map((f) => {
      const name = typeNames[f.dataTypeID];
      return name !== undefined
        ? { name: f.name, dataTypeID: f.dataTypeID, dataTypeName: name }
        : { name: f.name, dataTypeID: f.dataTypeID };
    }),
    // See QueryResult.command -- omitted on the cursor path because the tag
    // there describes the FETCH, not the user's statement.
    ...(viaCursor ? {} : { command: result.command }),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Run user-provided SQL in a READ ONLY transaction. Always rolls back.
 *
 * The user SQL is sent with `queryMode: 'extended'` so pg uses the extended
 * query protocol unconditionally (even when `params` is an empty array).
 * The extended protocol limits a request to a single statement, which blocks
 * the stacked-query injection pattern that defeated the archived reference
 * server -- payloads like `COMMIT; DROP SCHEMA x CASCADE;` would otherwise
 * end the READ ONLY transaction mid-stream and run DDL in autocommit.
 * See: https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/
 */
/**
 * Optional in-transaction hooks. `setup` runs after BEGIN, before user SQL.
 * `teardown` runs in `finally` (always executed) so it can clean up
 * session-scoped state (e.g. HypoPG hypothetical indexes) even on error.
 *
 * **teardown runs INSIDE the transaction, after a `ROLLBACK TO` the savepoint
 * taken before `setup`.** The path is BEGIN -> SAVEPOINT -> setup -> user SQL
 * -> (`finally`) ROLLBACK TO -> teardown -> ROLLBACK. The ROLLBACK TO is what
 * lets teardown run whatever the user's SQL did to the transaction: a failed
 * statement leaves it aborted, and an aborted transaction refuses everything
 * but ROLLBACK / ROLLBACK TO with SQLSTATE 25P02. Inside matters for
 * session-scoped state behind a transaction-mode pooler (PgBouncer, which the
 * README lists as supported): a backend is pinned to this connection only
 * until the transaction ends, so a `hypopg_reset()` sent after the ROLLBACK
 * could reach a different backend than the one holding the indexes, and
 * report success. Anything `setup` did that IS transactional is undone by
 * the ROLLBACK TO before teardown sees it.
 *
 * A teardown that fails leaves the session in a state the next borrower of
 * this pooled connection would inherit. It is retried once (a cancel or a
 * statement timeout landing on a trivially fast cleanup is the realistic
 * transient), after another `ROLLBACK TO` the hook savepoint -- which survives
 * a ROLLBACK TO, and clears the abort the failure caused. If the retry fails
 * too, the session's own backend is terminated from inside the transaction
 * and the connection is destroyed instead of reused; stderr says so at every
 * step. The call's own result is never replaced by a teardown failure. See
 * {@link terminateOwnBackend} for why the backend itself is ended.
 *
 * **Reserved savepoint names:** `runUserQueryBounded` opens
 * `SAVEPOINT __pgmcp_sp` around the user SQL and `RELEASE`s it at the end,
 * and the hook savepoint above is `__pgmcp_hooks`. Hooks MUST NOT create a
 * savepoint with either name -- the inner `RELEASE` would unwind hook-owned
 * state too. If you need a savepoint inside a hook, pick any other name.
 */
export interface RunHooks {
  setup?: (client: pg.PoolClient) => Promise<void>;
  teardown?: (client: pg.PoolClient) => Promise<void>;
  /**
   * Whether `setup` left session state that `teardown` has to remove. Read
   * when the transaction is finished: `false` skips the teardown -- there is
   * nothing to undo, and a cleanup that cannot run (HypoPG present but not
   * callable by this role) must not escalate to terminating a backend that
   * holds nothing. Absent means "assume it did".
   */
  sessionStateCreated?: () => boolean;
}

/** See {@link RunHooks}: taken before `setup`, rolled back to before `teardown`. */
const HOOK_SAVEPOINT = "__pgmcp_hooks";

/**
 * Check a client out of the pool with an `error` listener attached for as long
 * as it is checked out.
 *
 * pg-pool listens for `error` on IDLE clients (and forwards it to the pool's
 * own `error` event, logged in getPool), but it removes that listener when a
 * client is checked out and only re-adds it on release. node-pg emits `error`
 * on the client when its socket dies -- a backend terminated by a DBA, an
 * `idle_in_transaction_session_timeout`, a network drop -- and an
 * EventEmitter with no `error` listener THROWS from the emit, out of the
 * socket callback, as an uncaught exception that ends this process. Measured
 * on PostgreSQL 15: `pg_terminate_backend` on a checked-out client raised two
 * uncaught exceptions with no listener and none with one, and the query in
 * flight was rejected either way.
 *
 * The listener only logs. pg has already rejected the query in flight and
 * marked the client unqueryable, and pg-pool destroys an unqueryable client on
 * release, so there is nothing else for it to do. `release(err)` destroys the
 * client instead of pooling it, for a caller that left session state behind.
 *
 * This is the ONLY place a client may be checked out. It is exported for the
 * one tool that needs the raw client rather than a runner -- pg_kill, whose
 * NOTICE listener has to sit on the connection the signal runs on. pg_kill
 * used to call `getPool().connect()` itself and so had no listener: a
 * connection that dropped during its round trip ended the process (7 of 7),
 * where the same drop under pg_readonly returned an error and kept serving. A
 * test pins `getPool().connect()` to this function.
 */
export interface Checkout {
  client: pg.PoolClient;
  /** Hand the connection back, or destroy it when a reason is given. */
  release: (discard?: Error) => void;
  /**
   * Tell the listener this process is about to end the backend itself, so the
   * socket closing afterwards is reported as that and not as a surprise.
   */
  expectClose: () => void;
}

export async function acquireClient(): Promise<Checkout> {
  const client = await getPool().connect();
  let closeExpected = false;
  const onError = (err: Error): void => {
    if (closeExpected) {
      console.error(`[postgres-mcp] connection closed after this process terminated its own backend: ${err.message}`);
      return;
    }
    console.error(`[postgres-mcp] connection error on a checked-out client: ${err.message}`);
  };
  client.on("error", onError);
  return {
    client,
    expectClose: () => {
      closeExpected = true;
    },
    release: (discard) => {
      if (discard) console.error(`[postgres-mcp] discarding pooled connection: ${discard.message}`);
      // Removed after release. pg-pool re-attaches its own idle listener as
      // the first thing release() does, so the order is not load-bearing; it
      // just keeps the checkout's listener on for the whole checkout.
      client.release(discard);
      client.removeListener("error", onError);
    },
  };
}

/**
 * The statement that makes a discard reach the backend through any pooler.
 *
 * `release(err)` ends this process's socket. Connected straight to Postgres
 * that is the backend, and session state dies with it. Behind a
 * transaction-mode pooler (PgBouncer, which the README lists as supported) it
 * is only the link to the pooler: the backend goes back into the pooler's
 * pool with whatever a failed cleanup left on it -- HypoPG hypothetical
 * indexes, for the callers here -- and hands it to its next client, which
 * plans against indexes that do not exist. Nothing sent AFTER the transaction
 * ends can fix that, because the pooler may route it to a different backend.
 *
 * Terminating the session's own backend from INSIDE the transaction is pinned
 * to the right one, needs no privilege (any role may end its own session --
 * measured as a non-superuser on PostgreSQL 15 and 18, inside `BEGIN READ
 * ONLY`, after a `ROLLBACK TO` had cleared an aborted state), and the pooler
 * sees the server connection close and drops it. The caller's statement is
 * refused with SQLSTATE 57P01 and the socket closes, which is the point.
 * Reserved for a cleanup that already failed twice on a live connection: the
 * backend is otherwise worth keeping, and on a dead socket there is no
 * backend left to reach.
 */
export const TERMINATE_OWN_BACKEND_SQL = "SELECT pg_terminate_backend(pg_backend_pid())";

/**
 * Whether an error came back from a live server -- a SQLSTATE means Postgres
 * answered -- rather than from a socket that is gone. A SQLSTATE is exactly
 * five characters from `[0-9A-Z]`. That shape matters: node-pg hands a socket
 * failure to the query in flight as the raw Node error, whose `code` is a
 * string too (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`), and a plain "Connection
 * terminated unexpectedly" or "not queryable" error carries no code at all.
 */
export function isServerError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

/** SQLSTATE of a server error, or undefined for anything else. */
export function sqlState(err: unknown): string | undefined {
  return isServerError(err) ? (err as { code: string }).code : undefined;
}

/**
 * Send {@link TERMINATE_OWN_BACKEND_SQL} and say whether the backend is gone.
 *
 * The server's answer to it IS a rejection -- SQLSTATE 57P01 "terminating
 * connection due to administrator command", then the socket closes -- so that
 * means it worked. A connection error in its place means the socket closed
 * after the statement went out, which is also the backend ending. Any other
 * SQLSTATE is a refusal: the statement was refused (an aborted transaction,
 * 25P02) or the role may not (42501), and the backend is still there.
 */
async function terminateOwnBackend(
  client: pg.PoolClient,
): Promise<{ terminated: true } | { terminated: false; error: string }> {
  try {
    await client.query(TERMINATE_OWN_BACKEND_SQL);
    return { terminated: true };
  } catch (err) {
    const code = sqlState(err);
    if (code === "57P01" || code === undefined) return { terminated: true };
    return { terminated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** What {@link finishTransaction} leaves the checkout in. */
interface FinishOutcome {
  /** Why the connection must be destroyed rather than pooled, if it must. */
  discard?: Error;
  /**
   * The connection can no longer run anything: the backend was terminated, or
   * the socket died during cleanup. Whatever still has to run after this
   * (type-name resolution) goes through the pool instead.
   */
  connectionEnded: boolean;
}

/**
 * End a transaction one of the user-SQL runners opened: ROLLBACK TO the hook
 * savepoint, run `teardown` inside the still-open transaction, then ROLLBACK.
 * See {@link RunHooks} for why this order and what happens when teardown fails.
 */
async function finishTransaction(
  checkout: Checkout,
  state: { began: boolean; hookSavepoint: boolean },
  hooks: RunHooks,
): Promise<FinishOutcome> {
  const { client } = checkout;
  if (!state.began) return { connectionEnded: false };
  let failure: Error | undefined;
  let lastError: unknown;
  const attempt = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      lastError = err;
      const message = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
      // Every failure is logged; the first one is the discard reason.
      if (failure) console.error(`[postgres-mcp] ${message}`);
      failure ??= new Error(message);
      return false;
    }
  };
  const rollbackTo = (what: string) => attempt(what, () => client.query(`ROLLBACK TO SAVEPOINT ${HOOK_SAVEPOINT}`));
  // A dead socket answers nothing; the failure's shape says which it was.
  const connectionEnded = () => failure !== undefined && !isServerError(lastError);

  // The hook savepoint is taken before setup, so without it setup never ran.
  // And setup may have run and created nothing -- HypoPG present but not
  // callable by this role fails the first create with 42883. In both cases
  // there is nothing for teardown to undo; sending it anyway would only fail
  // (25P02, or the same 42883) and, worse, escalate over a clean backend.
  const teardown = hooks.teardown;
  const dirty = teardown !== undefined && state.hookSavepoint && (hooks.sessionStateCreated?.() ?? true);
  if (teardown && dirty) {
    const cleaned =
      (await rollbackTo("hook savepoint rollback")) && (await attempt("teardown", () => teardown(client)));
    if (!cleaned && isServerError(lastError)) {
      // A live server refused the cleanup. The failure aborted the
      // transaction; the hook savepoint survived the earlier ROLLBACK TO, so
      // it can clear the abort again for one retry.
      const firstFailure = failure?.message ?? "unknown";
      const retried =
        (await rollbackTo("hook savepoint rollback (retry)")) &&
        (await attempt("teardown (retry)", () => teardown(client)));
      if (retried) {
        console.error(
          `[postgres-mcp] teardown failed (${firstFailure}) and succeeded on retry; the connection is kept`,
        );
        failure = undefined;
      } else if (isServerError(lastError)) {
        // Refused twice by a live server. Discarding the connection is not
        // enough behind a pooler (see TERMINATE_OWN_BACKEND_SQL), so the
        // backend itself is ended -- from inside the transaction, which the
        // retry's failure aborted again, so one more ROLLBACK TO first.
        checkout.expectClose();
        let refusal: string | undefined;
        if (await rollbackTo("hook savepoint rollback (before terminate)")) {
          const outcome = await terminateOwnBackend(client);
          if (outcome.terminated) {
            console.error("[postgres-mcp] terminated own backend after a cleanup that failed twice");
            // No ROLLBACK: the backend, and with it the transaction, is gone.
            return {
              discard: new Error(`teardown failed twice, backend terminated: ${firstFailure}`),
              connectionEnded: true,
            };
          }
          refusal = outcome.error;
        } else {
          refusal = `the transaction could not be cleared first: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
        }
        console.error(`[postgres-mcp] own backend NOT terminated -- ${refusal}`);
        await attempt("ROLLBACK", () => client.query("ROLLBACK"));
        return {
          discard: new Error(
            `teardown failed twice and the backend could not be terminated (${refusal}); connection discarded: ${firstFailure}`,
          ),
          connectionEnded: connectionEnded(),
        };
      }
    }
  }
  await attempt("ROLLBACK", () => client.query("ROLLBACK"));
  return { discard: failure, connectionEnded: connectionEnded() };
}

/**
 * The shared body of {@link runReadOnly} and {@link runReadWriteRollback}:
 * open the transaction, run the hooks and the user SQL inside it, end it, and
 * only THEN resolve type names -- the pg_type read is a catalog query that
 * needs no transaction, and running it before the ROLLBACK would hold the
 * user statement's locks (row locks, for an EXPLAIN ANALYZE of DML) across an
 * extra round trip on a cold cache.
 */
async function runUserSqlInTransaction(
  begin: string,
  sql: string,
  params: unknown[],
  hooks: RunHooks,
): Promise<ApiResponse<QueryResult>> {
  const maxRows = getMaxRows();
  const state = { began: false, hookSavepoint: false };
  // Assigned inside the audited span, so it is still undefined when the pool
  // refused a connection: nothing to finish or release then.
  let checkout: Checkout | undefined;
  let outcome: { result: pg.QueryResult; viaCursor: boolean } | undefined;
  let failed: ApiResponse<QueryResult> | undefined;
  try {
    // The checkout and the transaction setup sit INSIDE the audited span; see
    // auditUserStatement for why. Whatever fails in here is the statement's
    // one `ok: false` line.
    outcome = await auditUserStatement(sql, params, async () => {
      checkout = await acquireClient();
      const { client } = checkout;
      await client.query(begin);
      state.began = true;
      if (hooks.teardown) {
        await client.query(`SAVEPOINT ${HOOK_SAVEPOINT}`);
        state.hookSavepoint = true;
      }
      if (hooks.setup) await hooks.setup(client);
      return runUserQueryBounded(client, sql, params, maxRows);
    });
  } catch (err) {
    failed = { ok: false, error: formatPgError(err) };
  }
  // No connection: the pool refused one, or DATABASE_URL is unset. Returned
  // like every other failure, as runInternal returns its own. It propagated
  // as an exception while the checkout sat before the try; the MCP wrapper
  // shaped both into the same error envelope.
  if (checkout === undefined) return failed ?? { ok: false, error: "no connection" };
  const { client, release } = checkout;
  const finished = await finishTransaction(checkout, state, hooks);
  try {
    if (failed || !outcome) return failed ?? { ok: false, error: "no result" };
    // A checkout whose connection is gone cannot answer the catalog read; any
    // pooled connection can.
    const typeNames = await safeResolveTypeNames(finished.connectionEnded ? getPool() : client, outcome.result.fields);
    return { ok: true, data: toQueryResult(outcome.result, maxRows, typeNames, outcome.viaCursor) };
  } finally {
    release(finished.discard);
  }
}

export async function runReadOnly(
  sql: string,
  params: unknown[] = [],
  hooks: RunHooks = {},
): Promise<ApiResponse<QueryResult>> {
  return runUserSqlInTransaction("BEGIN READ ONLY", sql, params, hooks);
}

/** Run user-provided SQL in a read-write transaction. Requires ALLOW_WRITES=1. */
export async function runReadWrite(sql: string, params: unknown[] = []): Promise<ApiResponse<QueryResult>> {
  if (!isWritesAllowed()) {
    return {
      ok: false,
      error: "Write blocked: ALLOW_WRITES is not set. Set ALLOW_WRITES=1 in the MCP server env to enable DML/DDL.",
    };
  }
  const maxRows = getMaxRows();
  // Assigned inside the audited span (see runUserSqlInTransaction), so a
  // refused connection leaves it undefined: nothing to roll back or release.
  let checkout: Checkout | undefined;
  try {
    const { client, result, viaCursor } = await auditUserStatement(sql, params, async () => {
      checkout = await acquireClient();
      const { client } = checkout;
      await client.query("BEGIN");
      const bounded = await runUserQueryBounded(client, sql, params, maxRows);
      return { client, ...bounded };
    });
    await client.query("COMMIT");
    const typeNames = await safeResolveTypeNames(client, result.fields);
    return { ok: true, data: toQueryResult(result, maxRows, typeNames, viaCursor) };
  } catch (err) {
    if (checkout !== undefined) {
      try {
        await checkout.client.query("ROLLBACK");
      } catch {
        // Ignore - best effort.
      }
    }
    return { ok: false, error: formatPgError(err) };
  } finally {
    checkout?.release();
  }
}

/**
 * Run SQL in a read-write transaction that always rolls back. Used by
 * EXPLAIN ANALYZE on write statements: postgres needs the write to execute
 * so ANALYZE can report actual row counts and timing, but the user asked
 * for a plan - not to commit the mutation. Requires ALLOW_WRITES=1 because
 * we still need to lift the READ ONLY guard to let the write run at all.
 */
export async function runReadWriteRollback(
  sql: string,
  params: unknown[] = [],
  hooks: RunHooks = {},
): Promise<ApiResponse<QueryResult>> {
  if (!isWritesAllowed()) {
    return {
      ok: false,
      error: "Write blocked: ALLOW_WRITES is not set. Set ALLOW_WRITES=1 in the MCP server env to enable DML/DDL.",
    };
  }
  return runUserSqlInTransaction("BEGIN", sql, params, hooks);
}

/**
 * Run an internal, trusted read-only query (used by introspection tools).
 * Does not wrap in a READ ONLY transaction because the SQL is fixed and
 * parameterized by us, not the caller.
 */
export async function runInternal<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<ApiResponse<T[]>> {
  try {
    // source: "internal" -- catalog SQL this server composes, not agent SQL.
    // Without the distinction one pg_schemas call reads in the audit log like
    // a dozen statements the agent issued.
    const result = await auditQuery(
      { source: "internal", sql, paramCount: params.length },
      () => getPool().query<T>(sql, params),
      (r) => r.rowCount ?? r.rows.length,
    );
    return { ok: true, data: result.rows };
  } catch (err) {
    return { ok: false, error: formatPgError(err) };
  }
}

/**
 * Run multiple internal queries on a single shared connection. Use this in
 * place of `Promise.all([runInternal(...), runInternal(...), ...])` whenever
 * a handler issues 3+ catalog queries -- otherwise one tool call's fan-out
 * can saturate the pool (default max 5) and starve concurrent calls. The
 * client is shared, so queries inside the callback serialize naturally even
 * when called via `Promise.all`.
 *
 * Behavior note: connect failures (pool exhausted, bad DATABASE_URL) propagate
 * as exceptions out of this helper, whereas `runInternal` and the user-SQL
 * runners catch the same failures and return `{ok: false}`. The MCP wrapper
 * in index.ts handles both shapes, but don't assume drop-in equivalence
 * between the two.
 *
 * Audit note: a connect failure here writes NO audit line, and that is the
 * deliberate exception (#42). runInternal logs its refused connection as the
 * `ok: false` line of the statement it was about to run, and the user-SQL
 * runners log the agent's statement the same way, because in both the
 * statement is known when the connection is asked for. Here the connection
 * is checked out BEFORE the callback composes its first statement, so there
 * is nothing truthful to put in `sql` -- a placeholder would be a
 * non-statement in the field every consumer, and the redacted mode's hash,
 * reads as one. Nothing agent-supplied is lost: every caller sends only
 * server-composed catalog SQL through this helper, and the one that carries
 * agent input, pg_index_advisor's workload statements, reaches the database
 * through runInternal first, whose line records the failure. Connecting
 * lazily on the first `runOnClient` would attribute the failure to a real
 * statement, but it would also turn the exception above into a per-statement
 * `{ok: false}` that a caller's partial-failure handling (pg_health's "never
 * an early return") would report as a degraded success. The README's "What
 * the trail does not show" names the tools this covers.
 */
/**
 * Per-call options for {@link withSharedClient}'s runner.
 *
 * `extended` forces the EXTENDED query protocol even when `params` is empty.
 * pg otherwise picks the protocol from the values array -- `requiresPreparation()`
 * ends in `values.length > 0` -- so a zero-parameter call goes out on the SIMPLE
 * protocol, which accepts MULTIPLE statements in one message. That is the
 * stacked-query hole runReadOnly closes for user SQL (see its doc comment); any
 * caller on this helper that interpolates non-catalog SQL into its statement
 * needs the same guard and must pass this flag.
 *
 * Note the extended protocol also requires the bind parameter COUNT to match the
 * statement's placeholders, so it cannot be used to run a statement whose `$n`
 * placeholders are deliberately left unbound (EXPLAIN GENERIC_PLAN). Callers in
 * that position use it as a single-statement VALIDATOR and then run the
 * validated text normally -- see tools/index-advisor.ts:assertSingleStatement.
 */
export interface RunOnClientOptions {
  extended?: boolean;
}

/** Second argument to a {@link withSharedClient} callback. */
export interface SharedClientControls {
  /**
   * Destroy the connection when the callback returns instead of handing it back
   * to the pool. For a caller that created session state a ROLLBACK does not
   * undo (HypoPG hypothetical indexes are the case in this codebase) and then
   * failed to clean it up: a pooled connection would pass that state on to
   * whichever call borrows it next. The first reason wins; later calls are
   * no-ops, and the reason is logged to stderr when the connection is dropped.
   *
   * What it isolates is THIS process's connection. Behind a transaction-mode
   * pooler (PgBouncer) that connection ends at the pooler, and the server
   * backend behind it lives on with whatever state was left there. A caller
   * that could not clean the backend up from inside its transaction should
   * send {@link TERMINATE_OWN_BACKEND_SQL} there, before the transaction ends,
   * and then discard.
   */
  discard(reason: Error): void;
  /**
   * Say that this process is about to end its own backend, so the socket
   * closing afterwards is logged as that and not as a connection error.
   */
  expectClose(): void;
}

/**
 * A failed statement on the shared runner carries the SQLSTATE a live server
 * answered with (`code`, and `serverError: true`), or neither when the socket
 * is gone. A caller deciding whether a cleanup is worth retrying, whether
 * there is a backend left to terminate, or whether a terminate worked (57P01
 * is the server's answer to one) needs the difference; see {@link isServerError}.
 */
export type SharedRunnerResult<R> = ApiResponse<R[]> & { serverError?: boolean; code?: string };

export async function withSharedClient<T>(
  fn: (
    runOnClient: <R extends pg.QueryResultRow = pg.QueryResultRow>(
      sql: string,
      params?: unknown[],
      options?: RunOnClientOptions,
    ) => Promise<SharedRunnerResult<R>>,
    controls: SharedClientControls,
  ) => Promise<T>,
): Promise<T> {
  const { client, release, expectClose } = await acquireClient();
  let discardReason: Error | undefined;
  const controls: SharedClientControls = {
    discard(reason) {
      discardReason ??= reason;
    },
    expectClose,
  };
  try {
    const runOnClient = async <R extends pg.QueryResultRow = pg.QueryResultRow>(
      sql: string,
      params: unknown[] = [],
      options: RunOnClientOptions = {},
    ): Promise<SharedRunnerResult<R>> => {
      try {
        // Same "internal" tagging as runInternal -- these run on a shared
        // client but are the same class of server-composed catalog SQL.
        const result = await auditQuery(
          { source: "internal", sql, paramCount: params.length },
          () =>
            options.extended
              ? client.query<R>({ text: sql, values: params, queryMode: "extended" } as UserQueryConfig)
              : client.query<R>(sql, params),
          (r) => r.rowCount ?? r.rows.length,
        );
        return { ok: true, data: result.rows };
      } catch (err) {
        const code = sqlState(err);
        return { ok: false, error: formatPgError(err), serverError: code !== undefined, code };
      }
    };
    return await fn(runOnClient, controls);
  } finally {
    release(discardReason);
  }
}

export async function shutdown(): Promise<void> {
  typeNameCache = null;
  // Reset alongside the pool: a rebuilt pool may point at a different
  // DATABASE_URL (tests do exactly this), and a stale version would then gate
  // catalog queries against the wrong server.
  serverVersionNum = null;
  // Invalidate any probe still in flight so it cannot republish the version of
  // the pool being torn down here.
  poolGeneration++;
  if (!pool) return;
  // pool.end() waits for in-flight queries with no upper bound. If a query is
  // wedged below the statement_timeout (network hang, frozen NFS, etc.), the
  // process appears stuck on exit. Cap the wait so cleanup is bounded and the
  // signal handler can still call process.exit().
  const ending = pool;
  pool = null;
  // The loser of this race has to be cleaned up explicitly. An un-cleared
  // setTimeout holds the event loop open for its full 5s, so a process that
  // has nothing left to do still waits -- invisible under index.ts (a
  // process.exit follows immediately) but a 5s hang for any in-process
  // embedder or test teardown that calls shutdown() and expects to continue.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ending.end(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("pool shutdown timed out after 5s")), 5_000);
      }),
    ]);
  } catch {
    // Best-effort -- if pool.end() lost the race, the underlying TCP sockets
    // get reaped when the process exits.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
