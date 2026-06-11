#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isWritesAllowed, shutdown } from "./api.js";
import { wrapToolHandler } from "./mcp-wrapper.js";
import { adminTools } from "./tools/admin.js";
import { explainTools } from "./tools/explain.js";
import { healthTools } from "./tools/health.js";
import { queryTools } from "./tools/query.js";
import { schemaTools } from "./tools/schemas.js";
import { statsTools } from "./tools/stats.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;

// Resolve package.json by walking up from this file rather than assuming a
// fixed `../package.json`. A deeper tsc emit layout (e.g. dist/src/index.js)
// would crash startup with a hard-coded relative require; walking up finds
// package.json wherever it actually sits.
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

// ─── No subcommand - start the MCP server ───

const allTools = [...queryTools, ...schemaTools, ...explainTools, ...healthTools, ...statsTools, ...adminTools];

const server = new McpServer({
  name: "@yawlabs/postgres-mcp",
  version,
});

for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    tool.annotations,
    wrapToolHandler(tool.handler as (input: unknown) => Promise<unknown>),
  );
}

const transport = new StdioServerTransport();
// Non-TLA connect: the single-binary build bundles this as CJS via esbuild,
// which cannot emit top-level await. Keep the post-connect banner inside .then()
// so it still fires only after the transport is live.
server
  .connect(transport)
  .then(() => {
    // Startup banner on stderr - stdio MCP protocol uses stdout, so stderr is free for logs.
    const writesNote = isWritesAllowed() ? "writes ENABLED" : "read-only";
    console.error(`@yawlabs/postgres-mcp v${version} ready (${allTools.length} tools, ${writesNote})`);
  })
  .catch((err: unknown) => {
    process.stderr.write(`postgres-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

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
