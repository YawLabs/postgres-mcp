/**
 * MCP response shaping for tool handlers.
 *
 * Tool handlers return the internal `{ ok, data?, error? }` shape (see
 * api.ts:ApiResponse). The MCP protocol wants a
 * `{ content, structuredContent?, isError? }` envelope. This module is the
 * single place that translation happens, so the mapping is testable in
 * isolation (index.ts wires it up but cannot be imported under test -- it
 * starts the stdio server at module top level, through `serveStdio`).
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
 *
 * A third failure does NOT reach this module at all, and used to. A call naming
 * an unknown or disabled tool fails inside the SDK's own dispatch, before any
 * handler runs -- and as of SDK v2 that REJECTS with ProtocolError(-32602)
 * instead of resolving `{ isError: true }` the way v1 did. Nothing here can
 * reshape it, so a caller that read "no such tool" as a soft error now gets a
 * JSON-RPC error frame instead of a result. index.test.ts pins that over the
 * wire, because no unit test of this module can observe it.
 */

import { errorMessage } from "./api.js";
import { runWithAuditTool } from "./audit.js";

// The SDK's `CallToolResult` carries an index signature (`[x: string]: unknown`)
// alongside `content` / `isError`, so this interface has to as well. Dropping it
// does not merely loosen the type, it breaks the build: `registerTool`'s callback
// returns `CallToolResult | InputRequiredResult`, and without the index signature
// TypeScript matches this shape against the InputRequiredResult arm and reports a
// missing `resultType` -- an error that names neither `content` nor this file.
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
 * of those trips. A bigint is the concrete case: jsonReplacer renders it
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
 * key for it would advertise a shape no tool's outputSchema declares. No tool
 * returns one today, and one that did would be rejected by the SDK: index.ts
 * registers an outputSchema for every tool, which makes structuredContent
 * mandatory on a success.
 */
function toStructuredContent(serialized: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(serialized);
  if (Array.isArray(parsed)) return { rows: parsed };
  if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  return undefined;
}

/**
 * JSON.stringify replacer for a tool payload: the values JSON has no form for,
 * rendered the way PostgreSQL writes them instead of crashing or turning into
 * something else. A `function`, not an arrow: `this` is the holder, and
 * `this[key]` is the value BEFORE its `toJSON` ran, which is the only place a
 * Buffer is still recognisable as one.
 *
 *   - bigint: JSON.stringify throws on it. pg can hand one back (int8 with a
 *     custom type parser), so it becomes its decimal string instead of the
 *     whole response crashing into the catch as an opaque "Do not know how to
 *     serialize a BigInt".
 *   - NaN / Infinity / -Infinity: pg parses float4/float8 with parseFloat, and
 *     JSON renders all three as `null` -- which reads as SQL NULL. They become
 *     the strings "NaN" / "Infinity" / "-Infinity", the same spelling a
 *     `numeric` NaN already arrives in.
 *   - Buffer (bytea): `toJSON` gives `{ type: "Buffer", data: [...] }`, one
 *     array element -- and with the indent, one line -- per byte. It becomes
 *     the `\x`-prefixed hex string PostgreSQL itself prints for bytea.
 */
function jsonReplacer(this: unknown, key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  const raw = (this as Record<string, unknown>)[key];
  if (Buffer.isBuffer(raw)) return `\\x${raw.toString("hex")}`;
  return value;
}

/**
 * Wrap a tool handler so it always resolves to an MCP response envelope.
 *
 * - `{ ok: true, data }` -> `data` serialized verbatim (including 0/false/''/[]).
 * - `{ ok: true }` with `data` absent, null or undefined -> isError envelope.
 *   No handler returns that, and there is nothing honest to send for one: every
 *   tool declares an outputSchema, so a made-up body (this used to substitute
 *   `{ success: true }`) is rejected by the SDK with a validation error that
 *   names neither the handler nor the cause.
 * - `{ ok: false, error }` -> `{ content: [text("Error: <error>")], isError: true }`
 * - handler throws        -> `{ content: [text("Error: <message>")], isError: true }`
 * - malformed result (null / not an object / no `ok` property) -> isError envelope
 *   with a distinct message, rather than silently mapping to 'Unknown error'.
 *
 * No error path sets `structuredContent`. The SDK skips output validation
 * entirely once `isError` is set, so a structured body there would be an
 * unvalidated object shaped like nothing in the tool's outputSchema -- and the
 * error text, which is all an error response has to say, is already in `content`.
 *
 * `toolName` is what puts the `tool` field on every audit line the handler's SQL
 * produces. This is the ONLY place it can be supplied: by the time a statement
 * reaches api.ts the MCP frame is gone, so audit.ts reads the name out of an
 * AsyncLocalStorage that something upstream has to establish, and this wrapper
 * is that upstream. Without it an operator reading the trail sees the statements
 * but not which tool issued them. `runWithAuditTool` short-circuits to a plain
 * call when auditing is off, so the default path pays nothing for the frame.
 */
export function wrapToolHandler(handler: ToolHandler, toolName: string): (input: unknown) => Promise<McpToolResponse> {
  return async (input: unknown): Promise<McpToolResponse> => {
    try {
      const result = await runWithAuditTool(toolName, () => handler(input));

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

      if (response.data === null || response.data === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: tool handler returned a malformed result (ok without data)",
            },
          ],
          isError: true,
        };
      }

      // Circular refs still throw and are caught below.
      const text = JSON.stringify(response.data, jsonReplacer, 2);
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
      // errorMessage, not err.message: a refused connection can arrive as an
      // AggregateError with an empty message (see api.ts:errorMessage).
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage(err)}` }],
        isError: true,
      };
    }
  };
}
