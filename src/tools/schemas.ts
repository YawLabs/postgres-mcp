import { z } from "zod";
import { getServerVersionNum, PG18, runInternal, withSharedClient } from "../api.js";
import { identSchema } from "./params.js";

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
      "view/foreign), and estimated row count (from `reltuples`; null = no ANALYZE yet on PG 14+; " +
      "0 may mean empty or unanalyzed on PG <= 13). " +
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
      // Zod defaults re-applied for direct (non-MCP) callers, which bypass the
      // schema. Matches the precedent in pg_explain / pg_table_bloat.
      const {
        schema = "public",
        includeViews = false,
        limit = 500,
        offset = 0,
      } = input as {
        schema?: string;
        includeViews?: boolean;
        limit?: number;
        offset?: number;
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
           NULLIF(round(c.reltuples), -1)::float8 AS estimated_rows
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
    description:
      "Describe a relation: kind (table / view / materialized_view / partitioned_table / foreign_table), " +
      "columns (name, type, nullable, default, `generated`, `identity`), primary key, foreign keys " +
      "(outgoing), `referenced_by` (other tables whose FKs point at this one), `constraints` " +
      "(CHECK / UNIQUE non-PK / EXCLUDE), indexes, and partition info (`partition_of` parent, " +
      "`partitions` children). Works on views and materialized views too -- PK/FK/constraint/index " +
      "lists will simply be empty for a plain view. Use `kind` to disambiguate before assuming you " +
      "can write to the relation. Generated columns (`generated`: 'stored' / 'virtual') and " +
      "`identity`: 'always' columns are NOT writable -- omit them from INSERT/UPDATE column lists; " +
      "a generated column's expression is reported as `generation_expression`, never as " +
      "`default_value`. On PostgreSQL 18+ constraints also report `validated` / `enforced` / " +
      "`has_period`, and columns report `not_null_validated` -- a NOT VALID not-null constraint " +
      "means `nullable: false` can still hide NULLs.",
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
      // Zod default re-applied for direct callers -- see pg_list_tables above.
      // `table` has no default (it's required), so it stays as-is.
      const { schema = "public", table } = input as { schema?: string; table: string };

      // The catalog shape depends on the server version, and naming a column
      // the server doesn't have is a hard "column does not exist" error -- the
      // whole sub-query fails and reports as an empty list, so the gate has to
      // be on the version, not on a NULL check. One cached GUC read (see
      // getServerVersionNum); 0 = unknown, which falls through to the
      // conservative pre-18 queries.
      const serverVersion = await getServerVersionNum();
      const isPg18 = serverVersion >= PG18;

      // Identify the relation kind first so the response signals "this is a
      // view" -- without this, an LLM sees columns + empty PK/FK/indexes and
      // can't tell whether it's looking at a real table or a view.
      const kindQuery = `
        SELECT
          CASE c.relkind
            WHEN 'r' THEN 'table'
            WHEN 'p' THEN 'partitioned_table'
            WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'materialized_view'
            WHEN 'f' THEN 'foreign_table'
            ELSE c.relkind::text
          END AS kind
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
      `;

      // PG18 made NOT NULL a real pg_constraint row (contype 'n') that can be
      // NOT VALID -- attnotnull's own docs now read "a (possibly invalid)
      // not-null constraint". So `nullable: false` no longer proves the column
      // is NULL-free, and an agent that skips a null check on it meets rows it
      // believed could not exist. No matching row means nothing is pending
      // validation (the column is nullable, or its NOT NULL comes from a PK),
      // hence COALESCE to true. Omitted below PG18, where a not-null
      // constraint cannot be invalid and the question does not arise.
      const notNullValidatedCol = isPg18
        ? `,
          (SELECT COALESCE(bool_and(nn.convalidated), true)
             FROM pg_catalog.pg_constraint nn
            WHERE nn.contype = 'n'
              AND nn.conrelid = a.attrelid
              AND nn.conkey = ARRAY[a.attnum]) AS not_null_validated`
        : "";

      // pg_attrdef stores generation expressions alongside plain defaults, so
      // routing on attgenerated is what keeps a generated column's expression
      // out of `default_value`: reported there it reads as "optional, has a
      // default" and the agent writes an INSERT postgres rejects. Identity
      // columns have no pg_attrdef row at all, so without attidentity they
      // look like an ordinary NOT NULL column with no default and the agent
      // supplies a value into GENERATED ALWAYS AS IDENTITY. Both catalog
      // fields are "char" and use '' (never NULL) for "not set", so the test
      // is against ''. attgenerated = 'v' only occurs on PG18+; 's' since PG12.
      const columnsQuery = `
        SELECT
          a.attname AS name,
          pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
          NOT a.attnotnull AS nullable${notNullValidatedCol},
          CASE WHEN a.attgenerated = '' THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) END AS default_value,
          CASE WHEN a.attgenerated <> '' THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) END AS generation_expression,
          CASE a.attgenerated WHEN 's' THEN 'stored' WHEN 'v' THEN 'virtual' END AS generated,
          CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by_default' END AS identity,
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

      // Slice indkey to its first `indnkeyatts` entries -- those are the KEY
      // columns. PostgreSQL 11+ allows `PRIMARY KEY (a) INCLUDE (b)`, and the
      // covering column `b` is also present in `indkey` (indkey is
      // 0-based, hence [0:indnkeyatts - 1]). Matching on the full vector
      // reported INCLUDE columns as part of the primary key, which an agent
      // would then use to build a wrong upsert conflict target or a wrong
      // row identity. unnest WITH ORDINALITY (same pattern as the FK queries
      // below) preserves declared key order.
      const primaryKeyQuery = `
        SELECT a.attname AS column_name
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(i.indkey[0:i.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, ord) ON TRUE
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = $1
          AND c.relname = $2
          AND i.indisprimary
        ORDER BY k.ord
      `;

      // convalidated / conenforced / conperiod decide what a constraint
      // actually does, and none of it shows up in the column lists: a NOT VALID
      // or NOT ENFORCED foreign key looks like a live referential guarantee an
      // agent can lean on while enforcing nothing, and a temporal
      // (PERIOD / WITHOUT OVERLAPS) key renders as an ordinary equality key.
      // conenforced and conperiod are PG18-only columns, so they are gated out
      // rather than defaulted -- naming them on an older server errors the
      // whole sub-query out to an empty list. convalidated predates them and is
      // always selected.
      const constraintMetaCols = isPg18
        ? `,
          con.convalidated AS validated,
          con.conenforced AS enforced,
          con.conperiod AS has_period`
        : `,
          con.convalidated AS validated`;
      // The FK query aggregates, so every added non-aggregated column must also
      // reach its GROUP BY -- postgres recognizes no functional dependency on a
      // system catalog's OID, so omitting one is a plan-time error.
      const constraintMetaGroupBy = isPg18
        ? ", con.convalidated, con.conenforced, con.conperiod"
        : ", con.convalidated";

      const foreignKeysQuery = `
        SELECT
          con.conname AS constraint_name,
          array_agg(att.attname::text ORDER BY u.attposition) AS columns,
          cl.relname AS foreign_table,
          fn.nspname AS foreign_schema,
          array_agg(fatt.attname::text ORDER BY u.attposition) AS foreign_columns${constraintMetaCols}
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_class cl ON cl.oid = con.confrelid
        JOIN pg_catalog.pg_namespace fn ON fn.oid = cl.relnamespace
        -- Pairing local conkey[i] to foreign confkey[i] by ordinality relies on
        -- the postgres invariant that conkey[i] references confkey[i]. unnest
        -- WITH ORDINALITY preserves array order; reordering or dropping
        -- WITH ORDINALITY would silently mispair composite-FK columns.
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, attposition) ON TRUE
        JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fu(attnum, attposition) ON fu.attposition = u.attposition
        JOIN pg_catalog.pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = fu.attnum
        WHERE n.nspname = $1
          AND c.relname = $2
          AND con.contype = 'f'
        GROUP BY con.conname, cl.relname, fn.nspname${constraintMetaGroupBy}
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

      // CHECK / UNIQUE-non-PK / EXCLUDE constraints. PK and FK are handled by
      // their dedicated queries above; we don't double-list them here.
      const constraintsQuery = `
        SELECT
          con.conname AS name,
          CASE con.contype
            WHEN 'c' THEN 'check'
            WHEN 'u' THEN 'unique'
            WHEN 'x' THEN 'exclude'
            ELSE con.contype::text
          END AS type,
          pg_catalog.pg_get_constraintdef(con.oid, true) AS definition${constraintMetaCols}
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = $2
          AND con.contype IN ('c', 'u', 'x')
        ORDER BY con.contype, con.conname
      `;

      // Reverse FKs: tables whose foreign keys point AT this one. Answers
      // "what depends on this table?" -- a routine question before a
      // destructive change. None of the surveyed competing MCP servers
      // expose this; in psql you'd run \d+ on the parent and squint.
      const referencedByQuery = `
        SELECT
          con.conname AS constraint_name,
          srcn.nspname AS schema,
          src.relname AS "table",
          array_agg(srcatt.attname::text ORDER BY u.attposition) AS columns,
          array_agg(refatt.attname::text ORDER BY u.attposition) AS referenced_columns${constraintMetaCols}
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
        JOIN pg_catalog.pg_namespace srcn ON srcn.oid = src.relnamespace
        JOIN pg_catalog.pg_class ref ON ref.oid = con.confrelid
        JOIN pg_catalog.pg_namespace refn ON refn.oid = ref.relnamespace
        -- Pairing local conkey[i] to foreign confkey[i] by ordinality relies on
        -- the postgres invariant that conkey[i] references confkey[i]. unnest
        -- WITH ORDINALITY preserves array order; reordering or dropping
        -- WITH ORDINALITY would silently mispair composite-FK columns.
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, attposition) ON TRUE
        JOIN pg_catalog.pg_attribute srcatt ON srcatt.attrelid = con.conrelid AND srcatt.attnum = u.attnum
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fu(attnum, attposition) ON fu.attposition = u.attposition
        JOIN pg_catalog.pg_attribute refatt ON refatt.attrelid = con.confrelid AND refatt.attnum = fu.attnum
        WHERE refn.nspname = $1
          AND ref.relname = $2
          AND con.contype = 'f'
        GROUP BY con.conname, srcn.nspname, src.relname${constraintMetaGroupBy}
        ORDER BY srcn.nspname, src.relname, con.conname
      `;

      // Partition parent (when $1.$2 is a partition) and partition children
      // (when $1.$2 is a partitioned_table). pg_inherits covers both classic
      // inheritance and declarative partitioning; we only return rows when
      // the JOIN with pg_partitioned_table / partition-bound-spec confirms
      // partition rather than plain inheritance.
      const partitionParentQuery = `
        SELECT
          parn.nspname AS schema,
          par.relname AS "table"
        FROM pg_catalog.pg_inherits i
        JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
        JOIN pg_catalog.pg_namespace childn ON childn.oid = child.relnamespace
        JOIN pg_catalog.pg_class par ON par.oid = i.inhparent
        JOIN pg_catalog.pg_namespace parn ON parn.oid = par.relnamespace
        WHERE childn.nspname = $1
          AND child.relname = $2
          AND child.relispartition
      `;

      const partitionChildrenQuery = `
        SELECT
          childn.nspname AS schema,
          child.relname AS "table",
          pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS bound
        FROM pg_catalog.pg_inherits i
        JOIN pg_catalog.pg_class par ON par.oid = i.inhparent
        JOIN pg_catalog.pg_namespace parn ON parn.oid = par.relnamespace
        JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
        JOIN pg_catalog.pg_namespace childn ON childn.oid = child.relnamespace
        WHERE parn.nspname = $1
          AND par.relname = $2
          AND child.relispartition
        ORDER BY childn.nspname, child.relname
      `;

      // 9-way fanout against pg_catalog. We share one connection so this
      // single tool call cannot saturate the pool (default max 5) and starve
      // a concurrent call. pg's PoolClient serializes queries internally, so
      // `Promise.all` here serializes too -- the structure is preserved for
      // readability, not for parallelism.
      return withSharedClient(async (run) => {
        const [kindRes, cols, pk, fks, idxs, constraints, referencedBy, partitionParent, partitionChildren] =
          await Promise.all([
            run<{ kind: string }>(kindQuery, [schema, table]),
            run(columnsQuery, [schema, table]),
            run<{ column_name: string }>(primaryKeyQuery, [schema, table]),
            run(foreignKeysQuery, [schema, table]),
            run(indexesQuery, [schema, table]),
            run(constraintsQuery, [schema, table]),
            run(referencedByQuery, [schema, table]),
            run<{ schema: string; table: string }>(partitionParentQuery, [schema, table]),
            run(partitionChildrenQuery, [schema, table]),
          ]);

        if (!cols.ok) return cols;
        if (!cols.data || cols.data.length === 0) {
          // JSON.stringify each piece so a name containing `"` or other
          // odd chars renders unambiguously rather than producing a broken
          // `Table "evil"name"."x" not found` message.
          return {
            ok: false,
            error: `Table ${JSON.stringify(schema)}.${JSON.stringify(table)} not found.`,
          };
        }
        const kind = kindRes.ok ? (kindRes.data?.[0]?.kind ?? "table") : "table";

        // Surface partial failures instead of collapsing them to empty arrays --
        // an empty `foreign_keys` could mean "no FKs" or "fetch failed", and an
        // LLM will treat the former and the latter identically without this hint.
        const warnings: string[] = [];
        // An unknown server version degrades to the pre-18 query shape (see
        // getServerVersionNum's "assume oldest" contract). Unannounced, the
        // absent PG18 fields read as "this server is older than 18" rather than
        // "we could not tell".
        if (serverVersion === 0) {
          // Names BOTH gated groups: the version probe also drops the
          // column-level `not_null_validated`, and a warning that mentions
          // only constraints reads as "your columns are complete" when they
          // are not.
          warnings.push(
            "server version unknown; PG18-only fields omitted (constraint `enforced`/`has_period`, column `not_null_validated`)",
          );
        }
        // `kind` is reported as a top-level field, so a silent default to
        // "table" would mislabel a view or materialized view. Emit a warning
        // when the fetch failed so the caller sees the kind isn't trustworthy.
        if (!kindRes.ok) warnings.push(`kind fetch failed, reported as "table": ${kindRes.error}`);
        // ok-but-empty: the query succeeded but returned no row (e.g. a race
        // where the relation was dropped between the cols fetch and this one).
        // The `?? "table"` default would then silently mislabel the relation.
        else if ((kindRes.data?.length ?? 0) === 0) warnings.push(`kind unavailable, reported as "table"`);
        if (!pk.ok) warnings.push(`primary_key fetch failed: ${pk.error}`);
        if (!fks.ok) warnings.push(`foreign_keys fetch failed: ${fks.error}`);
        if (!idxs.ok) warnings.push(`indexes fetch failed: ${idxs.error}`);
        if (!constraints.ok) warnings.push(`constraints fetch failed: ${constraints.error}`);
        if (!referencedBy.ok) warnings.push(`referenced_by fetch failed: ${referencedBy.error}`);
        if (!partitionParent.ok) warnings.push(`partition_of fetch failed: ${partitionParent.error}`);
        if (!partitionChildren.ok) warnings.push(`partitions fetch failed: ${partitionChildren.error}`);

        const parentRow = partitionParent.ok ? partitionParent.data?.[0] : undefined;

        return {
          ok: true,
          data: {
            schema,
            table,
            kind,
            columns: cols.data,
            primary_key: pk.ok ? (pk.data ?? []).map((r) => r.column_name) : [],
            foreign_keys: fks.ok ? fks.data : [],
            referenced_by: referencedBy.ok ? referencedBy.data : [],
            constraints: constraints.ok ? constraints.data : [],
            indexes: idxs.ok ? idxs.data : [],
            ...(parentRow ? { partition_of: parentRow } : {}),
            ...(partitionChildren.ok && (partitionChildren.data ?? []).length > 0
              ? { partitions: partitionChildren.data }
              : {}),
            ...(warnings.length > 0 ? { _warnings: warnings } : {}),
          },
        };
      });
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
      // Zod defaults re-applied for direct callers -- see pg_list_tables above.
      const { schema = "public", includeMaterialized = true } = input as {
        schema?: string;
        includeMaterialized?: boolean;
      };
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
      // Zod default re-applied for direct callers -- see pg_list_tables above.
      const { schema = "public" } = input as { schema?: string };
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
      // Zod default re-applied for direct callers -- see pg_list_tables above.
      const { pattern, schema, limit = 100 } = input as { pattern: string; schema?: string; limit?: number };
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
