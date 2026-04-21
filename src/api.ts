/**
 * PostgreSQL connection pool with read-only enforcement.
 *
 * Config:
 *   - DATABASE_URL                    — postgres connection string (required)
 *   - ALLOW_WRITES                    — set to "1" or "true" to allow DML/DDL (default: read-only)
 *   - POSTGRES_STATEMENT_TIMEOUT_MS   — per-statement timeout (default: 30000)
 *   - POSTGRES_MAX_ROWS               — max rows returned by pg_query (default: 1000)
 *   - POSTGRES_POOL_MAX               — max pool connections (default: 5). Set to 1 for
 *                                       single-threaded backends (pglite-socket, PgBouncer
 *                                       transaction mode) that can't handle concurrent queries.
 *
 * Safety model:
 *   User-provided SQL runs in a `BEGIN READ ONLY` transaction by default, so
 *   postgres itself rejects any write. Enable writes via ALLOW_WRITES=1 — the
 *   tool handlers also surface this hint in their descriptions/errors so an
 *   LLM doesn't blindly retry a blocked write.
 */

import pg from "pg";

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

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
    statement_timeout: getStatementTimeoutMs(),
    max: getPoolMax(),
    idleTimeoutMillis: 10_000,
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
  fields: { name: string; dataTypeID: number }[];
  command: string;
  truncated?: boolean;
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

function toQueryResult(result: pg.QueryResult, maxRows: number): QueryResult {
  const truncated = result.rows.length > maxRows;
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
  return {
    rows,
    rowCount: result.rowCount,
    fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    command: result.command,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Run user-provided SQL in a READ ONLY transaction. Always rolls back. */
export async function runReadOnly(sql: string, params: unknown[] = []): Promise<ApiResponse<QueryResult>> {
  const client = await getPool().connect();
  const maxRows = getMaxRows();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query(sql, params);
    await client.query("ROLLBACK");
    return { ok: true, data: toQueryResult(result, maxRows) };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Already rolled back or connection broken — swallow.
    }
    return { ok: false, error: formatPgError(err) };
  } finally {
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
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return { ok: true, data: toQueryResult(result, maxRows) };
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
  if (pool) {
    await pool.end();
    pool = null;
  }
}
