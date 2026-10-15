#!/usr/bin/env node
// Build a self-contained single-file binary of @yawlabs/postgres-mcp with
// `oam compile`.
//
// NOTE ON INVOCATION: this repo has NO .github/ -- the release.yml that used
// to run a binary build on tag push was dropped when registry publish moved
// into release.sh. Nothing runs this automatically today; it is a manual,
// run-it-on-each-host step, and the resulting bin/<platform>-<arch>/ artifact
// is staged by stage-release-asset.mjs.
//
// Strategy: esbuild bundles src/index.ts + ALL its dependencies (including
// the externals tsup leaves out -- @modelcontextprotocol/sdk and undici)
// into ONE CommonJS file with zero remaining node_modules resolution, then
// `oam compile` embeds that bundle into oam's runtime carrier and emits the
// finished executable in one step. The result runs with no Node, no
// node_modules, and no PATH dependency.
//
// CRITICAL: the bundle handed to `oam compile` MUST be CJS. `oam compile` runs
// the embedded file as CommonJS, so feeding it the ESM bundle that build.mjs
// writes to dist/index.js produces a binary that dies at startup with
// `SyntaxError: Cannot use import statement outside a module`. We re-bundle
// as CJS here rather than reusing dist/index.js.
//
// This script ONLY reads node_modules (via esbuild's resolver) and writes to
// build-tmp/ and bin/<platform>-<arch>/. It does NOT mutate package.json,
// package-lock.json, src/, or node_modules, and it never runs `npm install`.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const { version } = pkg;
// Binary name = the package's first `bin` command, so this script is
// copy-paste generic across @yawlabs/* servers -- no per-repo rename.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split('/').pop();
// Bundle the SERVER, derived from `main` -- deliberately NOT from `bin`.
//
// `bin` points at bin/postgres-mcp.mjs, the npm launcher that picks a runtime
// (oam or node) at launch time. A compiled standalone binary IS its runtime,
// so there is nothing to select and embedding the launcher would only add a
// spawn. `main` always names the server's own dist entry.
//
// This used to read `bin`, which silently broke the moment `bin` was repointed
// at the launcher in 0.9.0: the mapping produced `bin/postgres-mcp.ts`, a file
// that does not exist. Nothing caught it because this script is a manual,
// per-host step that neither `npm test` nor `release.sh` runs.
const serverDist = pkg.main ?? 'dist/index.js';
const srcEntry = serverDist.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.[cm]?js$/, '.ts');
if (!existsSync(join(repoRoot, srcEntry))) {
  console.error(`build-binary-oam: derived source entry '${srcEntry}' does not exist (from package.json main='${serverDist}')`);
  process.exit(1);
}

/** Locate an oam binary, or exit with a clear message. */
function requireOam() {
  const candidates = [
    process.env.OAM_BIN,
    ...(process.env.PATH ?? '')
      .split(isWin ? ';' : ':')
      .filter(Boolean)
      .map((d) => join(d, isWin ? 'oam.exe' : 'oam')),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  console.error(
    'build-binary-oam: no oam binary was found.\n' + 'Install from https://oamjs.org or set OAM_BIN=/path/to/oam.',
  );
  process.exit(1);
}

const platformDir = `${process.platform}-${process.arch}`;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
const bundlePath = join(tmpDir, 'oam-bundle.cjs');
const exeName = isWin ? `${binName}.exe` : binName;
const outExe = join(binDir, exeName);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1. Bundle everything into one CJS file (externals included) via esbuild's
// JS API. NOT the CLI bin: on Linux/macOS esbuild swaps node_modules/esbuild/
// bin/esbuild for the NATIVE binary (only Windows keeps it a JS shim), so
// `node bin/esbuild` would feed a binary to the JS parser and die. The API
// also takes the __VERSION__ define as data -- no shell-quoting games.
await esbuild.build({
  entryPoints: [join(repoRoot, srcEntry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // esbuild leaves import.meta.url EMPTY in cjs output, so a server that reads
  // it (e.g. createRequire(import.meta.url) to find package.json) crashes at
  // load with createRequire(undefined). Polyfill it to the carrier's own path
  // (__filename is the executable in the compiled binary). Version reads
  // should still prefer the __VERSION__ define; this is the safety net for
  // everything else.
  banner: { js: "const __binImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), 'import.meta.url': '__binImportMetaUrl' },
  // Optional native addons some servers pull transitively (ssh2 -> cpu-features)
  // are require()'d inside try/catch; mark them external so esbuild doesn't
  // choke on the .node binary -- they degrade gracefully when absent.
  external: ['cpu-features'],
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. `oam compile` takes the pre-bundled file and emits the executable
// directly (oam signs its own output where the platform requires it).
const oam = requireOam();
rmSync(outExe, { force: true });
run(oam, ['compile', bundlePath, '--output', outExe]);
if (!isWin) chmodSync(outExe, 0o755);

// 3. Smoke: `compile` succeeding is not proof the artifact executes, so run
// it on every platform.
run(outExe, ['version']);

console.log('');
console.log(`OK  ${outExe}  (oam compile)`);
console.log(`    ${fmtSize(outExe)}`);
console.log('');
console.log('Verify with:');
// `version` / `--version` is the ONLY subcommand this server implements
// (src/index.ts). Do not add a `doctor` line here from the sibling-repo
// template -- it would print an instruction that exits as a stdio server.
console.log(`    "${outExe}" --version`);
