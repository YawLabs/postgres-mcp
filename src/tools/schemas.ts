import { z } from "zod";
import { runInternal } from "../api.js";

// Identifier regex: letters, digits, underscores; must start with letter or underscore.
// Quoting here is defensive — introspection queries use parameterized inputs, but this
// catches garbage early with a clearer error.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateIdent(value: string, field: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(`Invalid ${field}: ${JSON.stringify(value)}. Must match ${IDENT_RE}.`);
  }
}

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
      "view/foreign), and estimated row count.",
    annotations: {
      title: "List tables in a schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      schema: z.string().default("public").describe("Schema name (defaults to 'public')."),
      includeViews: z.boolean().default(false).describe("If true, include views and materialized views."),
    }),
    handler: async (input: unknown) => {
      const { schema, includeViews } = input as { schema: string; includeViews: boolean };
      validateIdent(schema, "schema");
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
         ORDER BY c.relname`,
        [schema],
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
      schema: z.string().default("public").describe("Schema name (defaults to 'public')."),
      table: z.string().describe("Table name."),
    }),
    handler: async (input: unknown) => {
      const { schema, table } = input as { schema: string; table: string };
      validateIdent(schema, "schema");
      validateIdent(table, "table");

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
          array_agg(att.attname ORDER BY u.attposition) AS columns,
          cl.relname AS foreign_table,
          fn.nspname AS foreign_schema,
          array_agg(fatt.attname ORDER BY u.attposition) AS foreign_columns
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

      return {
        ok: true,
        data: {
          schema,
          table,
          columns: cols.data,
          primary_key: pk.ok ? (pk.data ?? []).map((r) => r.column_name) : [],
          foreign_keys: fks.ok ? fks.data : [],
          indexes: idxs.ok ? idxs.data : [],
        },
      };
    },
  },
] as const;
