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
 * - `{ ok: true }` / `{ ok: true, data: null|undefined }` -> serializes `{ success: true }`
 *   (the `data ?? { success: true }` nullish coalesce treats absent, null, and
 *   undefined identically); any other data (including 0/false/''/[]) is
 *   serialized verbatim.
 * - `{ ok: false, error }` -> `{ content: [text("Error: <error>")], isError: true }`
 * - handler throws        -> `{ content: [text("Error: <message>")], isError: true }`
 * - malformed result (null / not an object / no `ok` property) -> isError envelope
 *   with a distinct message, rather than silently mapping to 'Unknown error'.
 */
export function wrapToolHandler(handler: ToolHandler): (input: unknown) => Promise<McpToolResponse> {
  return async (input: unknown): Promise<McpToolResponse> => {
    try {
      const result = await handler(input);

      // The handler contract is `{ ok, data?, error? }` (api.ts:ApiResponse),
      // but `handler` is typed loosely. Guard before the blind cast so a future
      // non-conforming handler surfaces a clear error instead of having a
      // missing `ok` read as falsy and collapse into the 'Unknown error' path.
      if (result === null || typeof result !== "object" || !("ok" in result)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: tool handler returned a malformed result (missing ok)",
            },
          ],
          isError: true,
        };
      }

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

      // BigInt is not JSON-serializable -- JSON.stringify throws on it. pg can
      // hand back bigint values (e.g. int8 with a custom type parser), so a
      // replacer stringifies bigints rather than letting the whole response
      // crash into the catch as an opaque "Do not know how to serialize a
      // BigInt". Circular refs still throw and are caught below.
      const text = JSON.stringify(
        response.data ?? { success: true },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      );
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
