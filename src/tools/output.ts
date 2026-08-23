import { z } from "zod";

/**
 * Shared pieces of the `outputSchema` every tool in this directory declares.
 *
 * The schemas here are the SERVER side of MCP structured tool output: the SDK
 * validates each tool's `structuredContent` against them on every call and
 * fails the call outright when the parse fails (see
 * McpServer.validateToolOutput). So a schema that is merely aspirational --
 * one claiming a field the handler does not always emit -- does not degrade
 * the response, it destroys it. Two rules follow, and both are load-bearing:
 *
 *   - A field the handler omits on some servers is `.optional()`, NEVER
 *     `.nullable()`. Absence is a deliberate signal throughout this codebase
 *     (pg_io_stats drops `in_flight` below PG18, pg_advisor drops
 *     `frozen_page_fraction`, pg_top_queries drops `dealloc`), because a null
 *     reads as a measured "nothing there" while a missing key forces the
 *     caller to notice the server could not answer. Declaring one of those
 *     nullable-but-required would both lose that distinction AND reject the
 *     response on the very servers the gate exists for.
 *   - A field postgres can return as SQL NULL is `.nullable()` and required.
 *     Marking it optional instead would tell a caller the key might be missing
 *     when it never is.
 */

/**
 * `_warnings`: the partial-failure channel used by every multi-query tool here
 * (pg_health, pg_describe_table, pg_advisor, pg_replication_status,
 * pg_io_stats, and the stats envelope). Present ONLY when at least one
 * sub-query failed -- the handlers spread it in conditionally -- so it is
 * optional rather than an always-empty array.
 */
export const warningsField = z.array(z.string()).optional();

/**
 * Output envelope for a tool whose handler resolves to a BARE ARRAY.
 *
 * MCP requires `structuredContent` to be a JSON object, so mcp-wrapper.ts
 * wraps an array payload as `{ rows: [...] }` while leaving the `content` text
 * block as the unwrapped array it has always been. This helper is the schema
 * half of that wrapping: any tool returning a bare array MUST declare its
 * output through here, or the SDK will reject a `{ rows: ... }` object against
 * a schema that describes the array itself. Keeping the wrap in exactly two
 * named places (here and mcp-wrapper.ts:toStructuredContent) is what keeps
 * them from drifting apart.
 */
export function rowsOutput<Row extends z.ZodType>(row: Row): z.ZodObject<{ rows: z.ZodArray<Row> }> {
  return z.object({ rows: z.array(row) });
}
