import { z } from "zod";

/**
 * Any JSON value that can legally be bound as a postgres parameter. Covers
 * scalars, arrays (for postgres array columns / ANY), and objects (for
 * json/jsonb columns — pg serializes these automatically).
 */
export const paramValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(paramValue), z.record(z.string(), paramValue)]),
);
