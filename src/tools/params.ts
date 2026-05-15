import { z } from "zod";

/**
 * Any JSON value that can legally be bound as a postgres parameter. Covers
 * scalars, arrays (for postgres array columns / ANY), and objects (for
 * json/jsonb columns - pg serializes these automatically).
 */
export const paramValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(paramValue), z.record(z.string(), paramValue)]),
);

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
  .max(63)
  .refine((v) => Buffer.byteLength(v, "utf8") <= 63, {
    message:
      "Identifier exceeds PostgreSQL's 63-byte NAMEDATALEN limit (multi-byte characters count as multiple bytes).",
  });
