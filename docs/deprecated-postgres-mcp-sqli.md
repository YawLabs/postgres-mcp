# The Postgres MCP everyone's still using has a known SQLi

In May 2025, Anthropic archived `@modelcontextprotocol/server-postgres`. In July, they marked it deprecated on npm. They haven't shipped a replacement. A year later, the deprecated package is still pulling roughly 500,000 downloads per month - a lot of agents pointed at code that's known-broken and isn't going to get fixed.

The break in question is a stacked-query SQL injection. Datadog Security Labs published [the case study](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) in 2025. The reference server's defense was a `BEGIN READ ONLY` transaction wrapper around user SQL. The defense doesn't work, because the simple query protocol the server uses accepts multi-statement strings. A payload like:

```sql
SELECT 1; COMMIT; DROP SCHEMA public CASCADE;
```

closes the wrapping transaction with the embedded `COMMIT;`, then runs the `DROP` in autocommit, outside the read-only guard. Postgres has no idea anything is wrong - you sent it a multi-statement string, it ran the statements in order.

## Why this matters even if your agent is trustworthy

The attack surface isn't the LLM. It's the SQL string the LLM constructs. Any path that lets an attacker influence that string - prompt injection via a retrieved document, malicious content in a row the agent reads back, a poisoned tool description from another MCP server - becomes a path to the database. The MCP server is the last layer before the database; its job is to refuse to execute multi-statement SQL, not to trust the agent's judgment.

A few of the popular community forks paper over this with string parsers ("split on semicolons; reject anything with more than one statement"). String parsers against Postgres's lexer are a losing game. Dollar-quoted strings, escape sequences, comment handling, identifier quoting - reproducing it correctly is a multi-year project that every fork has to redo. There's a better fix.

## The structural fix

Send user SQL through the extended query protocol.

The extended protocol - the one node-pg uses when you pass `values` to `client.query()` - limits each request to a single statement at the wire level. Postgres itself rejects multi-statement payloads with `42601: cannot insert multiple commands into a prepared statement`. This is a property of the protocol, not a parser anyone has to maintain.

[`@yawlabs/postgres-mcp`](https://www.npmjs.com/package/@yawlabs/postgres-mcp) does exactly this:

```typescript
// src/api.ts
await client.query({
  text: sql,
  values: params,
  queryMode: 'extended',
});
```

`queryMode: 'extended'` forces the extended protocol even when `params` is an empty array. (In pg versions before 8.14, the driver would silently fall back to the simple protocol on empty `values`, defeating the guard - the project pins `pg ^8.14.0` for exactly this reason.)

The regression test asserts both halves: the payload is rejected, and the schema survives the attempt:

```typescript
it("rejects stacked-query injection that defeated the reference server", async () => {
  const payload = `SELECT 1; COMMIT; DROP SCHEMA ${FIXTURE_SCHEMA} CASCADE;`;
  const res = await pgQuery.handler({ sql: payload });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /cannot insert multiple commands|42601/i);

  // Belt-and-suspenders: even if the rejection message changes, the schema
  // must still exist -- no DROP landed.
  const check = await pgQuery.handler({
    sql: `SELECT count(*)::int AS c FROM ${FIXTURE_SCHEMA}.users`,
  });
  assert.ok(check.ok);
});
```

The same test runs with `ALLOW_WRITES=1` on too, verifying the extended-protocol guard sits upstream of the read-only wrapper - so even when reads-only is lifted, the injection is still blocked.

## What else changes if you migrate

A few other things worth knowing:

**Memory-bounded fetch.** The reference server's `MAX_ROWS` slice happened after node-pg had already materialized the full result into Node memory. A `SELECT * FROM big1 CROSS JOIN big2` could OOM the MCP process before `statement_timeout` fired. `postgres-mcp` wraps user SQL in a server-side `DECLARE ... CURSOR FOR` and fetches only `MAX_ROWS + 1` rows. Postgres does the heavy lifting; Node never holds more than the response.

**EXPLAIN ANALYZE that doesn't persist.** If you ask the reference server for an `EXPLAIN ANALYZE` of an `INSERT`, it inserts the row. `postgres-mcp` wraps the analyze in a transaction that always rolls back, so the plan comes back with real timing and row counts, but the mutation doesn't.

**Perf diagnostics the reference server never had.** `pg_top_queries` (from `pg_stat_statements`), `pg_seq_scan_tables`, `pg_unused_indexes`, `pg_table_bloat`, `pg_inspect_locks`, `pg_replication_status`. The "why is this slow?" question now answers in one tool call.

**`pg_advisor`.** Rolled-up DBA lints in one call: sequence exhaustion (the classic "BIGINT, eventually" incident class), tables without primary keys, public tables without RLS. Good "what should I be looking at?" starting point.

**HypoPG integration.** Ask the planner "what would the plan be if these indexes existed?" without creating them on disk. Requires the HypoPG extension.

**Reverse foreign keys.** `pg_describe_table` returns `referenced_by` - other tables whose FKs point at this one. None of the surveyed forks expose this; in psql you'd run `\d+` on every candidate and squint.

## Migration

If your `.mcp.json` currently looks like this:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgres://..."]
    }
  }
}
```

The replacement is:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@yawlabs/postgres-mcp"],
      "env": {
        "DATABASE_URL": "postgres://..."
      }
    }
  }
}
```

Two differences: the connection string moves from a CLI argument to a `DATABASE_URL` env var, and the package name changes. Read-only is on by default; opt into writes per-server with `ALLOW_WRITES=1`.

## Maintenance

`@yawlabs/postgres-mcp` is maintained by [Yaw Labs](https://yaw.sh). CI runs the integration test matrix on every push against PG17 and PG18. Releases go through a tag-triggered GitHub Action that publishes with `--provenance`. Source: [github.com/YawLabs/postgres-mcp](https://github.com/YawLabs/postgres-mcp).

If you find a security issue, please report it via the repo's private vulnerability reporting (see `SECURITY.md`) rather than a public issue.
