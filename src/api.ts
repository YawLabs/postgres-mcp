/**
 * PostgreSQL connection pool with read-only enforcement.
 *
 * Config:
 *   - DATABASE_URL                         — postgres connection string (required)
 *   - ALLOW_WRITES                         — set to "1" or "true" to allow DML/DDL (default: read-only)
 *   - POSTGRES_STATEMENT_TIMEOUT_MS        — per-statement timeout (default: 30000)
 *   - POSTGRES_CONNECTION_TIMEOUT_MS       — TCP connect timeout (default: 10000). Without
 *                                            this, a dead host hangs until the OS gives up
 *                                            (~2 minutes on most platforms).
 *   - POSTGRES_MAX_ROWS                    — max rows returned by pg_query (default: 1000)
 *   - POSTGRES_POOL_MAX                    — max pool connections (default: 5). Set to 1 for
 *                                            single-threaded backends (pglite-socket, PgBouncer
 *                                            transaction mode) that can't handle concurrent queries.
 *   - POSTGRES_SSL_REJECT_UNAUTHORIZED     — "false" to disable TLS cert verification (for managed
 *                                            databases using private-CA certs: Supabase, Neon,
 *                                            RDS with a custom CA). Connection is still encrypted.
 *
 * Safety model:
 *   User-provided SQL runs in a `BEGIN READ ONLY` transaction by default, so
 *   postgres itself rejects any write. Enable writes via ALLOW_WRITES=1 — the
 *   tool handlers also surface this hint in their descriptions/errors so an
 *   LLM doesn't blindly retry a blocked write.
 */

import pg from "pg";

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

function getStatementTimeoutMs(): number {
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

export function getSslConfig(): { rejectUnauthorized: boolean } | undefined {
  const raw = process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED;
  if (raw === undefined) return undefined;
  if (raw === "0" || raw === "false") return { rejectUnauthorized: false };
  if (raw === "1" || raw === "true") return { rejectUnauthorized: true };
  return undefined;
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  const ssl = getSslConfig();
  pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
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
  rowCount: number | null;
  fields: { name: string; dataTypeID: number; dataTypeName?: string }[];
  command: string;
  truncated?: boolean;
}

// pg_type oid -> typname. Bootstrapped on first user query, then miss-filled
// for any new oid (e.g. a CREATE TYPE during the session). Cleared on
// shutdown(). The cache is small (a few hundred rows on a stock cluster).
let typeNameCache: Map<number, string> | null = null;

async function resolveTypeNames(client: pg.PoolClient, oids: number[]): Promise<Record<number, string>> {
  if (oids.length === 0) return {};
  if (!typeNameCache) {
    typeNameCache = new Map();
    const res = await client.query<{ oid: number; typname: string }>("SELECT oid, typname FROM pg_catalog.pg_type");
    for (const row of res.rows) typeNameCache.set(row.oid, row.typname);
  }
  const missing = oids.filter((o) => !typeNameCache?.has(o));
  if (missing.length > 0) {
    const res = await client.query<{ oid: number; typname: string }>(
      "SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1)",
      [missing],
    );
    for (const row of res.rows) typeNameCache.set(row.oid, row.typname);
  }
  const out: Record<number, string> = {};
  for (const oid of oids) {
    const n = typeNameCache.get(oid);
    if (n !== undefined) out[oid] = n;
  }
  return out;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

function formatPgError(err: unknown): string {
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
 * Not every statement is cursorable -- DDL, DML without RETURNING, and
 * a few utility commands fail at DECLARE with SQLSTATE 0A000. We wrap
 * the attempt in a SAVEPOINT so a DECLARE failure doesn't abort the
 * outer transaction; on the fallback path we execute the SQL directly,
 * accepting that those statements never produce a runaway result set
 * anyway (DDL returns no rows, DML without RETURNING returns no rows).
 */
async function runUserQueryBounded(
  client: pg.PoolClient,
  sql: string,
  params: unknown[],
  maxRows: number,
): Promise<pg.QueryResult> {
  await client.query("SAVEPOINT __pgmcp_sp");
  try {
    await client.query({
      text: `DECLARE __pgmcp_cur NO SCROLL CURSOR FOR ${sql}`,
      values: params,
      queryMode: "extended",
    } as UserQueryConfig);
    const fetched = await client.query(`FETCH ${maxRows + 1} FROM __pgmcp_cur`);
    try {
      await client.query("CLOSE __pgmcp_cur");
    } catch {
      // CLOSE on a still-open cursor should not fail in normal flow;
      // a stale-cursor edge here doesn't change correctness because the
      // outer txn rollback below releases the cursor too.
    }
    await client.query("RELEASE SAVEPOINT __pgmcp_sp");
    return fetched;
  } catch {
    // Cursorable-or-not is decided at parse/plan time inside DECLARE.
    // Fall back to a direct execute for the non-cursorable case (DDL,
    // DML-without-RETURNING, utility commands). The savepoint rollback
    // is what lets the outer transaction stay alive.
    await client.query("ROLLBACK TO SAVEPOINT __pgmcp_sp");
    await client.query("RELEASE SAVEPOINT __pgmcp_sp");
    return client.query({
      text: sql,
      values: params,
      queryMode: "extended",
    } as UserQueryConfig);
  }
}

function toQueryResult(result: pg.QueryResult, maxRows: number, typeNames: Record<number, string> = {}): QueryResult {
  const truncated = result.rows.length > maxRows;
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
  return {
    rows,
    rowCount: result.rowCount,
    fields: result.fields.map((f) => {
      const name = typeNames[f.dataTypeID];
      return name !== undefined
        ? { name: f.name, dataTypeID: f.dataTypeID, dataTypeName: name }
        : { name: f.name, dataTypeID: f.dataTypeID };
    }),
    command: result.command,
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
/** Optional in-transaction hooks. `setup` runs after BEGIN, before user SQL.
 *  `teardown` runs in `finally` (always executed) so it can clean up
 *  session-scoped state (e.g. HypoPG hypothetical indexes) even on error. */
export interface RunHooks {
  setup?: (client: pg.PoolClient) => Promise<void>;
  teardown?: (client: pg.PoolClient) => Promise<void>;
}

export async function runReadOnly(
  sql: string,
  params: unknown[] = [],
  hooks: RunHooks = {},
): Promise<ApiResponse<QueryResult>> {
  const client = await getPool().connect();
  const maxRows = getMaxRows();
  try {
    await client.query("BEGIN READ ONLY");
    if (hooks.setup) await hooks.setup(client);
    const result = await runUserQueryBounded(client, sql, params, maxRows);
    await client.query("ROLLBACK");
    const typeNames = await resolveTypeNames(client, [...new Set(result.fields.map((f) => f.dataTypeID))]);
    return { ok: true, data: toQueryResult(result, maxRows, typeNames) };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Already rolled back or connection broken — swallow.
    }
    return { ok: false, error: formatPgError(err) };
  } finally {
    if (hooks.teardown) {
      try {
        await hooks.teardown(client);
      } catch {
        // Teardown is best-effort — never let it shadow a real error.
      }
    }
    client.release();
  }
}

/** Run user-provided SQL in a read-write transaction. Requires ALLOW_WRITES=1. */
export async function runReadWrite(sql: string, params: unknown[] = []): Promise<ApiResponse<QueryResult>> {
  if (!isWritesAllowed()) {
    return {
      ok: false,
      error: "Write blocked: ALLOW_WRITES is not set. Set ALLOW_WRITES=1 in the MCP server env to enable DML/DDL.",
    };
  }
  const client = await getPool().connect();
  const maxRows = getMaxRows();
  try {
    await client.query("BEGIN");
    const result = await runUserQueryBounded(client, sql, params, maxRows);
    await client.query("COMMIT");
    const typeNames = await resolveTypeNames(client, [...new Set(result.fields.map((f) => f.dataTypeID))]);
    return { ok: true, data: toQueryResult(result, maxRows, typeNames) };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore — best effort.
    }
    return { ok: false, error: formatPgError(err) };
  } finally {
    client.release();
  }
}

/**
 * Run SQL in a read-write transaction that always rolls back. Used by
 * EXPLAIN ANALYZE on write statements: postgres needs the write to execute
 * so ANALYZE can report actual row counts and timing, but the user asked
 * for a plan — not to commit the mutation. Requires ALLOW_WRITES=1 because
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
  const client = await getPool().connect();
  const maxRows = getMaxRows();
  try {
    await client.query("BEGIN");
    if (hooks.setup) await hooks.setup(client);
    const result = await runUserQueryBounded(client, sql, params, maxRows);
    await client.query("ROLLBACK");
    const typeNames = await resolveTypeNames(client, [...new Set(result.fields.map((f) => f.dataTypeID))]);
    return { ok: true, data: toQueryResult(result, maxRows, typeNames) };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Already rolled back or connection broken — swallow.
    }
    return { ok: false, error: formatPgError(err) };
  } finally {
    if (hooks.teardown) {
      try {
        await hooks.teardown(client);
      } catch {
        // Teardown is best-effort.
      }
    }
    client.release();
  }
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
    const result = await getPool().query<T>(sql, params);
    return { ok: true, data: result.rows };
  } catch (err) {
    return { ok: false, error: formatPgError(err) };
  }
}

export async function shutdown(): Promise<void> {
  typeNameCache = null;
  if (!pool) return;
  // pool.end() waits for in-flight queries with no upper bound. If a query is
  // wedged below the statement_timeout (network hang, frozen NFS, etc.), the
  // process appears stuck on exit. Cap the wait so cleanup is bounded and the
  // signal handler can still call process.exit().
  const ending = pool;
  pool = null;
  try {
    await Promise.race([
      ending.end(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("pool shutdown timed out after 5s")), 5_000)),
    ]);
  } catch {
    // Best-effort -- if pool.end() lost the race, the underlying TCP sockets
    // get reaped when the process exits.
  }
}
