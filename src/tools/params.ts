import { z } from "zod";

/**
 * Any JSON value that can legally be bound as a postgres parameter. Covers
 * scalars, arrays (for postgres array columns / ANY), and objects (for
 * json/jsonb columns - pg serializes these automatically).
 */
export const paramValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(paramValue),
    z.record(z.string(), paramValue),
  ]),
);

/**
 * Max nesting depth allowed inside a single parameter value (arrays and
 * objects each count as one level). 32 comfortably exceeds anything a
 * realistic jsonb payload uses while keeping the Zod `.refine` walk
 * cheap and bounding stack use for the iterative depth check below.
 */
export const MAX_PARAM_DEPTH = 32;

/**
 * Iterative depth check -- explicit work stack instead of recursion so we
 * never overflow JS's call stack for adversarial input. Returns true when
 * every node in `value` sits at or below `maxDepth` levels from the root.
 * Strings, numbers, booleans, and null are leaves.
 */
function isWithinDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const [v, d] = next;
    if (d > maxDepth) return false;
    if (Array.isArray(v)) {
      for (const item of v) stack.push([item, d + 1]);
    } else if (v !== null && typeof v === "object") {
      for (const item of Object.values(v)) stack.push([item, d + 1]);
    }
  }
  return true;
}

/**
 * Top-level params array with a nesting-depth guard. Zod's recursive parse
 * for `paramValue` will itself eat call stack on deep input -- in practice
 * JSON.parse caps recursion well below Node's stack limit, but a clear
 * validation error here beats a `Maximum call stack size exceeded`
 * RangeError out of the request path. Used in place of
 * `z.array(paramValue).optional()` by `pg_query`, `pg_readonly`, and
 * `pg_explain` so every parameterized tool inherits the cap.
 */
export const paramsArray = z.array(paramValue).refine((arr) => arr.every((v) => isWithinDepth(v, MAX_PARAM_DEPTH)), {
  message: `Parameter value exceeds maximum nesting depth of ${MAX_PARAM_DEPTH}`,
});

/**
 * Postgres identifier (schema / table / column name).
 *
 * Postgres caps identifiers at NAMEDATALEN-1 = 63 BYTES, not characters --
 * a JS-length-63 string with multi-byte chars (e.g. `café_logs`) is 64+ UTF-8
 * bytes and postgres silently truncates it. The truncated form can collide
 * with a different table and produce a "relation does not exist" much later
 * with no signal as to why. We reject byte-overflow here so the user sees a
 * clear validation error up front.
 *
 * Quoted identifiers (`"My Table"`, `weird-name`) are legal -- inputs are
 * always parameter-bound via $1/$2, so arbitrary-string values are safe
 * against injection.
 */
export const identSchema = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v, "utf8") <= 63, {
    message:
      "Identifier exceeds PostgreSQL's 63-byte NAMEDATALEN limit (multi-byte characters count as multiple bytes).",
  });
