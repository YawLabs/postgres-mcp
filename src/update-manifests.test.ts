import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/update-manifests.mjs writes package.json's description (and the
// homepage, version, license and command) into Ruby double-quoted strings in
// the Homebrew formula. These tests pin the escaping that keeps each value a
// plain string (CodeQL js/incomplete-sanitization).
//
// The file sits one level below the repo root in both layouts (src/ for the
// source, dist/ for the compiled node:test run), so the same hop reaches it.
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "update-manifests.mjs");

type Asset = { url: string; sha256: string };
type FormulaInput = {
  className: string;
  cmd: string;
  description?: string;
  homepage: string;
  version: string;
  license?: string;
  assets: { macArm64: Asset; macX64: Asset; linuxX64: Asset };
};

let rubyString: (value: unknown) => string;
let renderFormula: (input: FormulaInput) => string;

before(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs, and
  // importing it must not run main() (no `gh release download`).
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

const asset = (name: string): Asset => ({
  url: `https://github.com/YawLabs/postgres-mcp/releases/download/v1.2.3/${name}`,
  sha256: "a".repeat(64),
});
const baseInput: FormulaInput = {
  className: "PostgresMcp",
  cmd: "postgres-mcp",
  description: "PostgreSQL MCP server",
  homepage: "https://yaw.sh/mcp-servers/postgres-mcp/",
  version: "1.2.3",
  license: "MIT",
  assets: {
    macArm64: asset("postgres-mcp-darwin-arm64"),
    macX64: asset("postgres-mcp-darwin-x64"),
    linuxX64: asset("postgres-mcp-linux-x64"),
  },
};

// The quoted value of a one-line `<key> "..."` stanza, unescaped by Ruby rules.
function stanza(formula: string, key: string): string {
  const line = formula.split("\n").find((l) => l.trimStart().startsWith(`${key} "`));
  assert.ok(line, `no ${key} line in formula`);
  const m = /^\s*\w+ "(.*)"$/.exec(line);
  assert.ok(m, `${key} line is not a single quoted string: ${line}`);
  return parseRubyDq(m[1]);
}

describe("update-manifests rubyString", () => {
  const cases = [
    "PostgreSQL MCP server, read-only by default: query, schema introspection, EXPLAIN plans",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "line one\nline two\r\n",
    "C# support, issue #12",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      assert.equal(parseRubyDq(rubyString(input)), input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    assert.equal(rubyString('a\\"b'), 'a\\\\\\"b');
  });

  it("escapes # only where it would interpolate", () => {
    // `brew style` flags a redundant `\#`, so a plain `#` stays as it is.
    assert.equal(rubyString("C# and #1"), "C# and #1");
    assert.equal(rubyString("#{x} #@y #$z"), "\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    assert.equal(rubyString(undefined), "");
    assert.equal(rubyString(null), "");
  });
});

describe("update-manifests renderFormula", () => {
  it("passes a hostile description through rubyString", () => {
    const description = 'pwn \\" #{system("id")}\nmore';
    const formula = renderFormula({ ...baseInput, description });
    assert.equal(stanza(formula, "desc"), description);
    assert.ok(formula.includes(`  desc "${rubyString(description)}"\n`));
  });

  it("escapes homepage, version and license too", () => {
    const formula = renderFormula({
      ...baseInput,
      homepage: 'https://x.test/"#{1}',
      version: '1.0"#{2}',
      license: 'MIT"#{3}',
    });
    assert.equal(stanza(formula, "homepage"), 'https://x.test/"#{1}');
    assert.equal(stanza(formula, "version"), '1.0"#{2}');
    assert.equal(stanza(formula, "license"), 'MIT"#{3}');
  });

  it("renders the usual stanzas for a normal package", () => {
    const formula = renderFormula(baseInput);
    assert.ok(formula.startsWith("class PostgresMcp < Formula\n"));
    assert.equal(stanza(formula, "desc"), "PostgreSQL MCP server");
    assert.equal(stanza(formula, "license"), "MIT");
    assert.ok(formula.includes('bin.install Dir["*"].first => "postgres-mcp"'));
    assert.ok(formula.includes('shell_output("#{bin}/postgres-mcp --version")'));
  });

  it("uses :cannot_represent for an unlicensed package", () => {
    const formula = renderFormula({ ...baseInput, license: "UNLICENSED" });
    assert.ok(formula.includes("  license :cannot_represent\n"));
  });

  it("rejects a class name that is not a Ruby constant", () => {
    assert.throws(() => renderFormula({ ...baseInput, className: "Foo; system('id')" }), /not a Ruby constant/);
  });
});
