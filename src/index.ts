#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isWritesAllowed, shutdown } from "./api.js";
import { adminTools } from "./tools/admin.js";
import { explainTools } from "./tools/explain.js";
import { healthTools } from "./tools/health.js";
import { queryTools } from "./tools/query.js";
import { schemaTools } from "./tools/schemas.js";
import { statsTools } from "./tools/stats.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : ((await import("node:module")).createRequire(import.meta.url)("../package.json") as { version: string }).version;

// ─── CLI subcommands (run instead of MCP server) ───

const subcommand = process.argv[2];

if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
}

// ─── No subcommand — start the MCP server ───

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
    async (input: Record<string, unknown>) => {
      try {
        const result = await (tool.handler as (input: unknown) => Promise<unknown>)(input);
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
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Startup banner on stderr — stdio MCP protocol uses stdout, so stderr is free for logs.
const writesNote = isWritesAllowed() ? "writes ENABLED" : "read-only";
console.error(`@yawlabs/postgres-mcp v${version} ready (${allTools.length} tools, ${writesNote})`);

// Clean shutdown: release pool connections when the transport closes.
const cleanup = async () => {
  try {
    await shutdown();
  } catch {
    // Best-effort — process is exiting.
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
