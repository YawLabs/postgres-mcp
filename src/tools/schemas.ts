import { z } from "zod";
import { runInternal } from "../api.js";

// Postgres identifier max length is 63 bytes. Quoted identifiers (e.g. "My Table",
// "weird-name") are legal, so no regex restriction — inputs are parameter-bound
// via $1/$2 in every query below, which makes arbitrary-string values safe.
const identSchema = z.string().min(1).max(63);

export const schemaTools = [
  {
    name: "pg_list_schemas",
    description:
      "List non-system schemas in the database. Excludes `pg_catalog`, `information_schema`, " +
      "and other `pg_*` internals.",
    annotations: {
      title: "List schemas",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return runInternal<{ schema_name: string; owner: string }>(
        `SELECT
           n.nspname AS schema_name,
           pg_catalog.pg_get_userbyid(n.nspowner) AS owner
         FROM pg_catalog.pg_namespace n
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%'
           AND n.nspname NOT LIKE 'pg_temp_%'
         ORDER BY n.nspname`,
      );
    },
  },

  {
    name: "pg_list_tables",
    description:
      "List tables (and optionally views) in a schema. Returns name, type (table/view/materialized " +
      "view/foreign), and estimated row count (from `reltuples`; approximate — 0 until ANALYZE runs). " +
      "Paginate via `limit`/`offset` on very large schemas.",
    annotations: {
      title: "List tables in a schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.default("public").describe("Schema name (defaults to 'public')."),
      includeViews: z.boolean().default(false).describe("If true, include views and materialized views."),
      limit: z.number().int().min(1).max(10_000).default(500).describe("Max rows to return (default 500, max 10000)."),
      offset: z.number().int().min(0).default(0).describe("Rows to skip for pagination (default 0)."),
    }),
    handler: async (input: unknown) => {
      const { schema, includeViews, limit, offset } = input as {
        schema: string;
        includeViews: boolean;
        limit: number;
        offset: number;
      };
      const kinds = includeViews ? "('r', 'v', 'm', 'f', 'p')" : "('r', 'f', 'p')";
      return runInternal<{ name: string; type: string; estimated_rows: number }>(
        `SELECT
           c.relname AS name,
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized_view'
             WHEN 'f' THEN 'foreign_table'
             WHEN 'p' THEN 'partitioned_table'
             ELSE c.relkind::text
           END AS type,
           c.reltuples::bigint AS estimated_rows
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relkind IN ${kinds}
         ORDER BY c.relname
         LIMIT $2 OFFSET $3`,
        [schema, limit, offset],
      );
    },
  },

  {
    name: "pg_describe_table",
    description: "Describe a table: columns (name, type, nullable, default), primary key, foreign keys, and indexes.",
    annotations: {
      title: "Describe table",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.default("public").describe("Schema name (defaults to 'public')."),
      table: identSchema.describe("Table name."),
    }),
    handler: async (input: unknown) => {
      const { schema, table } = input as { schema: string; table: string };

      const columnsQuery = `
        SELECT
          a.attname AS name,
          pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
          NOT a.attnotnull AS nullable,
          pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
          a.attnum AS ordinal_position
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1
          AND c.relname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum
      `;

      const primaryKeyQuery = `
        SELECT a.attname AS column_name
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = $1
          AND c.relname = $2
          AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
      `;

      const foreignKeysQuery = `
        SELECT
          con.conname AS constraint_name,
          array_agg(att.attname::text ORDER BY u.attposition) AS columns,
          cl.relname AS foreign_table,
          fn.nspname AS foreign_schema,
          array_agg(fatt.attname::text ORDER BY u.attposition) AS foreign_columns
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_class cl ON cl.oid = con.confrelid
        JOIN pg_catalog.pg_namespace fn ON fn.oid = cl.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, attposition) ON TRUE
        JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fu(attnum, attposition) ON fu.attposition = u.attposition
        JOIN pg_catalog.pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = fu.attnum
        WHERE n.nspname = $1
          AND c.relname = $2
          AND con.contype = 'f'
        GROUP BY con.conname, cl.relname, fn.nspname
        ORDER BY con.conname
      `;

      const indexesQuery = `
        SELECT
          i.relname AS name,
          pg_catalog.pg_get_indexdef(ix.indexrelid) AS definition,
          ix.indisunique AS is_unique,
          ix.indisprimary AS is_primary
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
        JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = $2
        ORDER BY i.relname
      `;

      const [cols, pk, fks, idxs] = await Promise.all([
        runInternal(columnsQuery, [schema, table]),
        runInternal<{ column_name: string }>(primaryKeyQuery, [schema, table]),
        runInternal(foreignKeysQuery, [schema, table]),
        runInternal(indexesQuery, [schema, table]),
      ]);

      if (!cols.ok) return cols;
      if (!cols.data || cols.data.length === 0) {
        return { ok: false, error: `Table "${schema}"."${table}" not found.` };
      }

      // Surface partial failures instead of collapsing them to empty arrays —
      // an empty `foreign_keys` could mean "no FKs" or "fetch failed", and an
      // LLM will treat the former and the latter identically without this hint.
      const warnings: string[] = [];
      if (!pk.ok) warnings.push(`primary_key fetch failed: ${pk.error}`);
      if (!fks.ok) warnings.push(`foreign_keys fetch failed: ${fks.error}`);
      if (!idxs.ok) warnings.push(`indexes fetch failed: ${idxs.error}`);

      return {
        ok: true,
        data: {
          schema,
          table,
          columns: cols.data,
          primary_key: pk.ok ? (pk.data ?? []).map((r) => r.column_name) : [],
          foreign_keys: fks.ok ? fks.data : [],
          indexes: idxs.ok ? idxs.data : [],
          ...(warnings.length > 0 ? { _warnings: warnings } : {}),
        },
      };
    },
  },

  {
    name: "pg_list_views",
    description:
      "List views and materialized views in a schema with their SQL definitions. Use this over " +
      "`pg_list_tables` with `includeViews: true` when you want the view body, not just names.",
    annotations: {
      title: "List views with definitions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.default("public").describe("Schema name (defaults to 'public')."),
      includeMaterialized: z.boolean().default(true).describe("If true, include materialized views."),
    }),
    handler: async (input: unknown) => {
      const { schema, includeMaterialized } = input as { schema: string; includeMaterialized: boolean };
      const kinds = includeMaterialized ? "('v', 'm')" : "('v')";
      return runInternal<{ name: string; type: string; definition: string }>(
        `SELECT
           c.relname AS name,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' END AS type,
           pg_catalog.pg_get_viewdef(c.oid, true) AS definition
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relkind IN ${kinds}
         ORDER BY c.relname`,
        [schema],
      );
    },
  },

  {
    name: "pg_list_functions",
    description:
      "List functions, procedures, and aggregates in a schema. Returns name, arguments, return type, " +
      "kind (function/procedure/aggregate/window), and implementation language.",
    annotations: {
      title: "List functions and procedures",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: identSchema.default("public").describe("Schema name (defaults to 'public')."),
    }),
    handler: async (input: unknown) => {
      const { schema } = input as { schema: string };
      return runInternal<{
        name: string;
        arguments: string;
        return_type: string;
        kind: string;
        language: string;
      }>(
        `SELECT
           p.proname AS name,
           pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
           pg_catalog.pg_get_function_result(p.oid) AS return_type,
           CASE p.prokind
             WHEN 'f' THEN 'function'
             WHEN 'p' THEN 'procedure'
             WHEN 'a' THEN 'aggregate'
             WHEN 'w' THEN 'window'
             ELSE p.prokind::text
           END AS kind,
           l.lanname AS language
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_catalog.pg_language l ON l.oid = p.prolang
         WHERE n.nspname = $1
         ORDER BY p.proname, p.oid`,
        [schema],
      );
    },
  },

  {
    name: "pg_list_extensions",
    description:
      "List installed PostgreSQL extensions. Returns name, version, schema, and description. " +
      "Useful to check for pgvector, postgis, pg_stat_statements, uuid-ossp, etc. before writing " +
      "queries that rely on them.",
    annotations: {
      title: "List installed extensions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return runInternal<{ name: string; version: string; schema: string; description: string | null }>(
        `SELECT
           e.extname AS name,
           e.extversion AS version,
           n.nspname AS schema,
           d.description
         FROM pg_catalog.pg_extension e
         JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
         LEFT JOIN pg_catalog.pg_description d ON d.objoid = e.oid AND d.classoid = 'pg_extension'::regclass
         ORDER BY e.extname`,
      );
    },
  },

  {
    name: "pg_search_columns",
    description:
      "Search for columns by name across all user schemas. Supports SQL LIKE patterns " +
      "(`%` matches any substring, `_` matches one character). Case-insensitive. " +
      "Use this instead of iterating `pg_describe_table` when the user asks 'which tables have X'.",
    annotations: {
      title: "Search columns by name",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      pattern: z.string().min(1).describe("LIKE pattern. Use '%' for wildcard: 'user_id', '%email%', 'created_%'."),
      schema: identSchema.optional().describe("Limit to this schema. If omitted, searches all user schemas."),
      limit: z.number().int().min(1).max(1000).default(100).describe("Max rows to return (default 100)."),
    }),
    handler: async (input: unknown) => {
      const { pattern, schema, limit } = input as { pattern: string; schema?: string; limit: number };
      const schemaFilter = schema
        ? "AND n.nspname = $3"
        : "AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%'";
      const params: unknown[] = [pattern, limit];
      if (schema) params.push(schema);
      return runInternal<{ schema: string; table: string; column: string; type: string; nullable: boolean }>(
        `SELECT
           n.nspname AS schema,
           c.relname AS "table",
           a.attname AS "column",
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE a.attname ILIKE $1
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           ${schemaFilter}
         ORDER BY n.nspname, c.relname, a.attnum
         LIMIT $2`,
        params,
      );
    },
  },
] as const;
