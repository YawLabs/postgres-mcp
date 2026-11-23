/**
 * The stubbed-pool scaffolding the tool unit tests share: run a real handler
 * against a fake postgres with no network.
 *
 * DATABASE_URL is pointed at a host that does not exist so getPool()
 * construction succeeds, and the two pool seams are replaced:
 * `pg.Pool.prototype.connect` (withSharedClient / acquireClient checkouts) and
 * `pg.Pool.prototype.query` (runInternal and the getServerVersionNum probe,
 * which go through the POOL rather than a checked-out client). A suite has to
 * stub every seam its handler reaches: one left alone sends real traffic at
 * the fake host and hangs the suite on a connect timeout.
 *
 * shutdown() runs on the way IN and on the way OUT because api.ts caches the
 * pool, `serverVersionNum` and the type-name cache at module scope. Without
 * the reset one case's stubbed version leaks into the next and every
 * version-gated case becomes order-dependent.
 *
 * Compiled with the rest of src/ but never shipped (package.json `files`
 * names only dist/index.js) and never run as a test (the runner collects
 * `*.test.js` only).
 */

import { afterEach, beforeEach } from "node:test";
import pg from "pg";
import { shutdown } from "../api.js";

export const STUB_DATABASE_URL = "postgres://stub-host/stubdb";

/**
 * Points the pool at the stub host and returns the function that puts back
 * both pool seams and DATABASE_URL as they were found.
 */
export async function installStubbedPool(): Promise<() => Promise<void>> {
  const originalConnect = pg.Pool.prototype.connect;
  const originalQuery = pg.Pool.prototype.query;
  const originalDbUrl = process.env.DATABASE_URL;
  await shutdown();
  process.env.DATABASE_URL = STUB_DATABASE_URL;
  return async () => {
    pg.Pool.prototype.connect = originalConnect;
    pg.Pool.prototype.query = originalQuery;
    await shutdown();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  };
}

/**
 * Registers the install / restore pair as beforeEach / afterEach of the
 * enclosing describe(). Call it before the suite's own hooks: node:test runs
 * both kinds in registration order, so the pool is restored and shut down
 * ahead of any teardown the suite adds.
 */
export function useStubbedPool(): void {
  let restore: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    restore = await installStubbedPool();
  });
  afterEach(async () => {
    await restore?.();
    restore = undefined;
  });
}

/** The scoped form of useStubbedPool, for a single case or a per-case helper. */
export async function withStubbedPool<T>(fn: () => Promise<T>): Promise<T> {
  const restore = await installStubbedPool();
  try {
    return await fn();
  } finally {
    await restore();
  }
}

/** Every `getPool().connect()` resolves (or rejects with) whatever `next` returns. */
export function stubConnect(next: () => unknown): void {
  pg.Pool.prototype.connect = function connectStub(this: pg.Pool) {
    return Promise.resolve(next());
  } as unknown as typeof pg.Pool.prototype.connect;
}

/**
 * Every pool-level query goes to `answer`, with a non-string query config
 * read as "".
 */
export function stubPoolQuery(answer: (sql: string, params: unknown[]) => Promise<unknown>): void {
  pg.Pool.prototype.query = function queryStub(this: pg.Pool, sql: unknown, params: unknown[] = []) {
    return answer(typeof sql === "string" ? sql : "", params);
  } as unknown as typeof pg.Pool.prototype.query;
}

/**
 * A checked-out client that answers with `query` and accepts the listener
 * calls every checkout makes.
 */
export function stubClient<Q extends (sql: string, params?: unknown[]) => Promise<unknown>>(query: Q) {
  return {
    query,
    release() {
      /* no-op */
    },
    // acquireClient() attaches an 'error' listener for the checked-out lifetime.
    on() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
}
