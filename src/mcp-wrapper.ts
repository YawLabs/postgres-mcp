/**
 * MCP response shaping for tool handlers.
 *
 * Tool handlers return the internal `{ ok, data?, error? }` shape (see
 * api.ts:ApiResponse). The MCP protocol wants a `{ content, isError? }`
 * envelope. This module is the single place that translation happens, so the
 * mapping is testable in isolation (index.ts wires it up but cannot be
 * imported under test -- it has a top-level `server.connect`).
 *
 * Two failure shapes converge here:
 *   1. A handler that returns `{ ok: false, error }` (the normal failure
 *      contract, e.g. runInternal catching a query error).
 *   2. A handler that THROWS -- notably `withSharedClient`, whose connect
 *      failures propagate as exceptions rather than `{ ok: false }`
 *      (see api.ts:withSharedClient). The try/catch below shapes either
 *      into an `isError` envelope so the process never crashes.
 */

// The MCP SDK's `server.tool` callback return type carries an index signature
// (`[x: string]: unknown`) alongside `content` / `isError`. Keep that here so
// the wrapped function stays assignable to `server.tool` in index.ts.
export interface McpToolResponse {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type ToolHandler = (input: unknown) => Promise<unknown>;

/**
 * Wrap a tool handler so it always resolves to an MCP response envelope.
 *
 * - `{ ok: true, data }`  -> `{ content: [text(JSON.stringify(data))] }`
 * - `{ ok: true }` (no data) -> serializes `{ success: true }`
 * - `{ ok: false, error }` -> `{ content: [text("Error: <error>")], isError: true }`
 * - handler throws        -> `{ content: [text("Error: <message>")], isError: true }`
 */
export function wrapToolHandler(handler: ToolHandler): (input: Record<string, unknown>) => Promise<McpToolResponse> {
  return async (input: Record<string, unknown>): Promise<McpToolResponse> => {
    try {
      const result = await handler(input);
      const response = result as { ok: boolean; data?: unknown; error?: string };

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${response.error || "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }

      const text = JSON.stringify(response.data ?? { success: true }, null, 2);
      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}
