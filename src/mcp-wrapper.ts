/**
 * MCP response shaping for tool handlers.
 *
 * Tool handlers return the internal `{ ok, data?, error? }` shape (see
 * api.ts:ApiResponse). The MCP protocol wants a
 * `{ content, structuredContent?, isError? }` envelope. This module is the
 * single place that translation happens, so the mapping is testable in
 * isolation (index.ts wires it up but cannot be imported under test -- it has a
 * top-level `server.connect`).
 *
 * A success carries the payload TWICE: once as `structuredContent` (the typed
 * object the SDK validates against the tool's outputSchema) and once as the
 * serialized `content` text block. That duplication is deliberate -- the spec
 * says a server SHOULD keep mirroring the JSON in text, and every client
 * written before structured output reads `content` and nothing else, so
 * dropping it would break them all for a field they cannot yet use.
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
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type ToolHandler = (input: unknown) => Promise<unknown>;

/**
 * Re-parse the serialized payload into the object MCP carries as
 * `structuredContent`.
 *
 * Parsing our own output instead of handing `response.data` back directly is
 * what stops the two halves of the envelope from disagreeing. `structuredContent`
 * is a LIVE object -- the SDK validates it against the tool's outputSchema and
 * then hands it to the transport to serialize -- while `content` is a string
 * produced here, and a raw handler value can hold things that survive only one
 * of those trips. A bigint is the concrete case: the replacer below renders it
 * as a decimal string in the text, but left in the live object it throws "Do not
 * know how to serialize a BigInt" inside the transport, OUTSIDE this module's
 * try/catch, where nothing is left to shape it into an error envelope. Fields
 * holding `undefined` (dropped by JSON) and anything with a `toJSON` have the
 * same two-renderings problem. The round trip costs one extra parse per call and
 * buys the guarantee that the schema describing the text also describes the
 * object.
 *
 * A bare array is wrapped as `{ rows: [...] }`: structuredContent must be a JSON
 * object, and the list tools (pg_list_schemas, pg_list_tables, pg_search_columns,
 * ...) resolve to arrays. The `content` text keeps the unwrapped array, so no
 * client reading it today sees a changed payload. tools/output.ts:rowsOutput is
 * the schema half of this wrap -- change one and the other has to follow, or the
 * SDK rejects every one of those tools' responses.
 *
 * Returns undefined when the payload is neither object nor array. A handler
 * resolving to a bare number/string/boolean has no object form, and inventing a
 * key for it would advertise a shape no tool's outputSchema declares.
 */
function toStructuredContent(serialized: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(serialized);
  if (Array.isArray(parsed)) return { rows: parsed };
  if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  return undefined;
}

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
 *
 * No error path sets `structuredContent`. The SDK skips output validation
 * entirely once `isError` is set, so a structured body there would be an
 * unvalidated object shaped like nothing in the tool's outputSchema -- and the
 * error text, which is all an error response has to say, is already in `content`.
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
      const envelope: McpToolResponse = {
        content: [{ type: "text" as const, text }],
      };
      // Assigned conditionally rather than always: the SDK treats the key's
      // presence as "this tool answered structurally", so a `structuredContent`
      // explicitly set to undefined for a non-object payload is the same as
      // omitting it -- but writing it out makes it look like the payload had a
      // structured form when it did not.
      const structured = toStructuredContent(text);
      if (structured !== undefined) envelope.structuredContent = structured;
      return envelope;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}
