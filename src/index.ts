#!/usr/bin/env node

import { writeSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isWritesAllowed, shutdown } from "./api.js";
import { wrapToolHandler } from "./mcp-wrapper.js";
import { adminTools } from "./tools/admin.js";
import { explainTools } from "./tools/explain.js";
import { healthTools } from "./tools/health.js";
import { indexAdvisorTools } from "./tools/index-advisor.js";
import { ioTools } from "./tools/io.js";
import { queryTools } from "./tools/query.js";
import { schemaTools } from "./tools/schemas.js";
import { statsTools } from "./tools/stats.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;

// Resolve package.json by walking up from this file rather than assuming a
// fixed `../package.json`. A deeper tsc emit layout (e.g. dist/src/index.js)
// would crash startup with a hard-coded relative require; walking up finds
// package.json wherever it actually sits.
//
// Reachability: BOTH shipped artifacts (the esbuild npm bundle and the SEA
// binary) define __VERSION__, so this fallback only runs for a raw `tsc`
// output -- i.e. local dev. It is deliberately kept rather than deleted:
// `npm run build` runs tsc first, and dist/*.js is what the test suite
// imports. Nothing here is exercised by a published package.
async function readPackageVersion(): Promise<string> {
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const require = createRequire(import.meta.url);

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      return (require(candidate) as { version: string }).version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error("could not locate package.json walking up from the emitted module path");
}

const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : await readPackageVersion();

// ─── CLI subcommands (run instead of MCP server) ───

const subcommand = process.argv[2];

if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
}

// Reject an unrecognized bare subcommand instead of silently falling through
// to the stdio server. `postgres-mcp doctor` used to print nothing and hang
// looking like a crash, because the server was sitting there waiting for MCP
// framing on stdin. Only bare words are rejected -- a leading `-` is left
// alone so flags an MCP host may pass still reach the server untouched.
if (subcommand !== undefined && !subcommand.startsWith("-")) {
  // A connection string passed positionally is the one shape that used to
  // "work" (it was ignored, and DATABASE_URL supplied the real DSN), so a
  // generic "unknown subcommand" would read as a regression to anyone with
  // that in their MCP config. Name the actual fix instead.
  const looksLikeDsn = /^postgres(ql)?:\/\//i.test(subcommand);
  const message = looksLikeDsn
    ? `postgres-mcp: connection strings are not accepted as an argument.\n` +
      `Set DATABASE_URL in the MCP server env instead:\n` +
      `  "env": { "DATABASE_URL": "postgres://..." }\n`
    : `postgres-mcp: unknown subcommand '${subcommand}'\n` +
      `Usage:\n` +
      `  postgres-mcp            start the MCP server on stdio\n` +
      `  postgres-mcp version    print the version and exit\n`;
  // writeSync, not process.stderr.write: stderr is ASYNCHRONOUS for TTYs and
  // pipes on Windows, and process.exit() truncates pending async writes -- so
  // the usage text could be cut off exactly where a human reads it. Setting
  // process.exitCode and returning is not an option at module top level; the
  // rest of this file would keep evaluating and start the server anyway.
  writeSync(2, message);
  process.exit(1);
}

// ─── No subcommand - start the MCP server ───

const allTools = [
  ...queryTools,
  ...schemaTools,
  ...explainTools,
  ...indexAdvisorTools,
  ...healthTools,
  ...statsTools,
  ...ioTools,
  ...adminTools,
];

/**
 * Build a fully-registered server instance.
 *
 * A FACTORY rather than one long-lived instance, because serveStdio owns the
 * era decision: it constructs a server only once the opening message reveals
 * which era the client speaks, and it can call this MORE THAN ONCE for a single
 * connection -- a modern `server/discover` probe builds an instance
 * optimistically, and a legacy `initialize` arriving next discards that one and
 * builds another. So nothing here may carry a side effect that has to happen
 * exactly once: no banner, no pool warm-up, no counter. Tool registration is
 * pure in-memory work, and api.ts's pg pool is module-level and lazy, so every
 * instance this returns shares the one pool however often it runs.
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: "@yawlabs/postgres-mcp",
    version,
  });

  // `server.tool()` was deprecated through SDK 1.x and is GONE in v2.
  // registerTool takes the same information as a config object and is the only
  // form that can carry `outputSchema`, which is what makes the structured tool
  // output wired below reachable at all.
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        // `title` at the top level is where the current spec puts a tool's
        // display name; `annotations.title` is the older location. Emit BOTH --
        // dropping the annotations copy would regress hosts that only read it,
        // and omitting the top-level one leaves newer hosts showing the raw
        // `pg_*` name.
        title: tool.annotations.title,
        description: tool.description,
        // The zod object itself, NOT `.shape`. v2 still accepts a raw shape,
        // but only through an overload marked `@deprecated` that auto-wraps it
        // in `z.object()`; handing the schema over directly skips that wrap and
        // is the form the v1-to-v2 codemod's raw-shape warning asks for.
        inputSchema: tool.inputSchema,
        // Declaring outputSchema is not free: from here on the SDK REJECTS any
        // successful result whose `structuredContent` fails to parse against it,
        // so a schema that overstates the response turns a working tool into a
        // hard failure. mcp-wrapper.ts is what supplies the structuredContent;
        // tools/output.ts documents the optional-vs-nullable rule the per-tool
        // schemas follow to stay inside that contract.
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      wrapToolHandler(tool.handler as (input: unknown) => Promise<unknown>),
    );
  }

  return server;
}

// serveStdio, NOT a hand-wired `new McpServer().connect(new StdioServerTransport())`.
// The hand-wired form speaks exactly one protocol era -- the 2025 one -- and the
// 2026-07-28 spec's compatibility matrix makes a modern client against a
// legacy-only server a hard failure rather than a downgrade. serveStdio reads
// the opening message, pins the connection to the era the client actually spoke,
// and serves either one from this single factory (`legacy: 'serve'` is its
// default). The process-level tests in index.test.ts drive the 2025 handshake,
// so their staying green is what proves the legacy era still works after the
// port to v2.
//
// It also returns SYNCHRONOUSLY, which is what keeps the single-binary build
// working: that one is bundled as CJS by esbuild, which cannot emit top-level
// await, so an awaited connect here would break it. Nothing is lost by having no
// promise to wait on -- serveStdio starts the transport itself, and `start()`
// only attaches the stdin/stdout listeners, which it has already done by the
// time this call returns. The banner below still prints with the transport live.
serveStdio(createServer, {
  // Out-of-band errors only. A tool handler's failure never reaches here
  // (mcp-wrapper.ts shapes those into an isError envelope), and this must NOT
  // exit the way the old connect().catch() did: serveStdio reports routine
  // protocol events through this callback too -- a stray response arriving
  // before an era was negotiated, a client claiming a revision this SDK does not
  // implement. Exiting on one of those would let a single malformed frame from
  // one client kill the server.
  onerror: (err: Error) => {
    process.stderr.write(`postgres-mcp: ${err.message}\n`);
  },
});

// Startup banner on stderr - stdio MCP protocol uses stdout, so stderr is free for logs.
const writesNote = isWritesAllowed() ? "writes ENABLED" : "read-only";
console.error(`@yawlabs/postgres-mcp v${version} ready (${allTools.length} tools, ${writesNote})`);

// Clean shutdown: release pool connections when the transport closes.
// SIGINT, SIGTERM, and stdin 'end' can all fire near-simultaneously (e.g. a
// client closes stdin and the shell also sends SIGTERM). Guard so the second
// trigger returns early instead of double-running shutdown() / racing exit().
let exiting = false;
const cleanup = async () => {
  if (exiting) return;
  exiting = true;
  try {
    await shutdown();
  } catch {
    // Best-effort - process is exiting.
  }
};
process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0));
});
// MCP clients typically disconnect by closing our stdin rather than sending a
// signal. Without this, the pg pool's 60s idle timeout keeps node alive long
// after the client is gone; proactively clean up and exit.
process.stdin.on("end", () => {
  void cleanup().finally(() => process.exit(0));
});
