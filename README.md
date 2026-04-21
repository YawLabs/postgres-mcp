# @yawlabs/postgres-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/postgres-mcp)](https://www.npmjs.com/package/@yawlabs/postgres-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/YawLabs/postgres-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/postgres-mcp/actions/workflows/ci.yml) [![Release](https://github.com/YawLabs/postgres-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/YawLabs/postgres-mcp/actions/workflows/release.yml)

**Query a PostgreSQL database from Claude Code, Cursor, and any MCP client.** Read-only by default — writes opt in via a single env var — so an agent can't silently drop your tables.

Built and maintained by [Yaw Labs](https://yaw.sh).

## Why this one?

The official Anthropic `@modelcontextprotocol/server-postgres` was [deprecated on npm](https://www.npmjs.com/package/@modelcontextprotocol/server-postgres) in early 2026. This one picks up where it left off, with a few extras:

- **Read-only by default** — user SQL runs in a `BEGIN READ ONLY` transaction, so postgres itself (not string parsing) blocks writes. Opt in to writes with `ALLOW_WRITES=1`.
- **Schema introspection built in** — `pg_list_schemas`, `pg_list_tables`, `pg_describe_table` return columns, primary keys, foreign keys, and indexes without you having to remember the `pg_catalog` joins.
- **`EXPLAIN` as a first-class tool** — text or JSON format, with optional `ANALYZE`. ANALYZE for non-SELECT statements requires `ALLOW_WRITES=1` since it actually runs the query.
- **Health snapshot** — `pg_health` returns version, db size, connection counts, and the 10 longest-running active queries in one call. Use it as a connection smoke-test and to catch runaway queries.
- **Instant startup** — ships as a single bundled file with zero runtime dependencies. No multi-minute `node_modules` install on every npx cold start.
- **Result truncation** — large result sets are capped at `POSTGRES_MAX_ROWS` (default 1000) with a `truncated: true` flag, so a stray `SELECT * FROM events` doesn't blow out the model context.
- **Parameterized queries** — `pg_query` accepts a `params` array for `$1`, `$2`, etc. No string-interpolated SQL.

## Quick start

**1. Create `.mcp.json` in your project root**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@yawlabs/postgres-mcp"],
      "env": {
        "DATABASE_URL": "postgres://user:password@host:5432/dbname"
      }
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/postgres-mcp"],
      "env": {
        "DATABASE_URL": "postgres://user:password@host:5432/dbname"
      }
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**2. Restart and approve**

Restart Claude Code (or your MCP client) and approve the postgres MCP server when prompted.

**3. (Optional) Enable writes**

Read-only is the default. If you want the agent to be able to `INSERT`, `UPDATE`, `DELETE`, or run DDL, add `ALLOW_WRITES=1` to the `env` block:

```json
"env": {
  "DATABASE_URL": "postgres://...",
  "ALLOW_WRITES": "1"
}
```

Prefer scoping this to dev/test databases — for production, leave writes off and use migration tools out-of-band.

## Tools

| Tool | Description |
|------|-------------|
| `pg_query` | Run a SQL query. Read-only by default; writes require `ALLOW_WRITES=1`. Supports parameterized queries via `params`. |
| `pg_list_schemas` | List non-system schemas. |
| `pg_list_tables` | List tables (and optionally views) in a schema with estimated row counts. |
| `pg_describe_table` | Columns, primary key, foreign keys, and indexes for a table. |
| `pg_explain` | `EXPLAIN` or `EXPLAIN ANALYZE` for a SQL statement. Text or JSON output. |
| `pg_health` | Server version, database size, connection count, active queries, table count. |

## Configuration

All env vars are read from the MCP server's environment:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | (required) | PostgreSQL connection string. |
| `ALLOW_WRITES` | unset | Set to `1` or `true` to allow DML/DDL via `pg_query` and `pg_explain` ANALYZE of writes. |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout. |
| `POSTGRES_MAX_ROWS` | `1000` | Cap on rows returned by `pg_query`. |

SSL is handled by the `pg` driver based on the connection string — use `?sslmode=require` (or equivalent) in `DATABASE_URL` for cloud-hosted databases.

## License

MIT © 2026 YawLabs
