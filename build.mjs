/**
 * Bundles the MCP server into a single self-contained file.
 *
 * Why: `npx` has to install all runtime dependencies on every cold start.
 * With node_modules containing the MCP SDK, pg, and zod, this takes minutes
 * on Windows. By bundling everything into one file and declaring zero runtime
 * dependencies, npx downloads only the tarball and runs immediately.
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/index.js",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  // Node built-ins are provided by the runtime. pg-native is an optional
  // binary addon we never use; cloudflare:sockets is referenced by pg's
  // Cloudflare Workers adapter which we don't target.
  external: ["node:*", "pg-native", "cloudflare:sockets"],
  // pg and its deps do `require("events")` / `require("net")` etc. without
  // the `node:` prefix. In an ESM bundle that becomes a dynamic-require call
  // that fails at runtime. Inject a real `require` via createRequire so those
  // calls resolve against Node's built-in module loader.
  banner: {
    js: "import { createRequire as ___createRequire } from 'node:module'; const require = ___createRequire(import.meta.url);",
  },
  sourcemap: true,
  minify: false,
});
