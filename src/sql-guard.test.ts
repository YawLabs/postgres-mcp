import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReadOnlyStatement, findBlockedFunction, GuardError, leadingKeyword } from "./sql-guard.js";

describe("leadingKeyword", () => {
  it("skips whitespace, line comments, nested block comments and parentheses", () => {
    assert.equal(leadingKeyword("  \n\t\f\vselect 1"), "SELECT");
    assert.equal(leadingKeyword("-- a\n-- b\r\nDO $$ $$"), "DO");
    assert.equal(leadingKeyword("/* a /* nested */ still comment */ SET ROLE x"), "SET");
    assert.equal(leadingKeyword("( ( /* c */ select 1))"), "SELECT");
  });

  it("does not end a nested comment at the first close", () => {
    // A scanner without nesting would read `SELECT` as the first word here.
    assert.equal(leadingKeyword("/* /* */ SELECT */ DO $$ $$"), "DO");
  });

  it("returns null when no bare word comes first", () => {
    assert.equal(leadingKeyword(""), null);
    assert.equal(leadingKeyword("/* never closed DO"), null);
    assert.equal(leadingKeyword('"DO"'), null);
    assert.equal(leadingKeyword("'x'"), null);
  });

  it("skips leading statement separators, so the keyword after them decides", () => {
    // Postgres parses `; SET ROLE x` as one statement with stmt_location past
    // the semicolon (measured against the PG18 grammar); stopping at the `;`
    // returned null and read as pass.
    assert.equal(leadingKeyword("; SET ROLE postgres"), "SET");
    assert.equal(leadingKeyword(" ;\n DO $$ $$"), "DO");
    assert.equal(leadingKeyword(";; ANALYZE t"), "ANALYZE");
    // A trailing separator runs off the end: nothing follows, so nothing to block.
    assert.equal(leadingKeyword("SELECT 1;"), "SELECT");
    assert.equal(leadingKeyword(";"), null);
  });
});

describe("assertReadOnlyStatement: keywords", () => {
  const blocked = [
    "DO $$ BEGIN NULL; END $$",
    "do $$ begin null; end $$",
    "/* x */ DO $$ $$",
    "-- x\nDO $$ $$",
    "/* a /* b */ c */ DO $$ $$",
    // A leading statement separator: postgres parses the keyword after it as
    // THE statement (stmt_location past the `;`), so it must decide too.
    "; SET ROLE postgres",
    "; DO $$ $$",
    ";\nCOPY t TO PROGRAM 'x'",
    ";; ANALYZE t",
    "PREPARE p AS SELECT 1",
    "EXECUTE p",
    "DEALLOCATE ALL",
    "SET ROLE postgres",
    "SET statement_timeout = 0",
    "RESET ROLE",
    "LOAD 'x'",
    "DISCARD ALL",
    "BEGIN",
    "START TRANSACTION",
    "COMMIT",
    "END",
    "ABORT",
    "ROLLBACK",
    "SAVEPOINT s",
    "RELEASE s",
    "DECLARE c CURSOR FOR SELECT 1",
    "FETCH 1 FROM c",
    "MOVE c",
    "CLOSE c",
    "COPY t TO PROGRAM 'x'",
    "CALL p()",
    "LOCK TABLE t",
    "VACUUM t",
    "ANALYZE t",
    "CLUSTER t",
    "REINDEX TABLE t",
    "CHECKPOINT",
    "LISTEN c",
    "UNLISTEN c",
    "NOTIFY c",
  ];
  for (const sql of blocked) {
    it(`refuses ${JSON.stringify(sql)}`, () => {
      assert.throws(
        () => assertReadOnlyStatement(sql),
        (err: unknown) =>
          err instanceof GuardError && err.code === "PGMCP_BLOCKED" && /read-only mode/.test(err.message),
      );
    });
  }

  const allowed = [
    "SELECT 1",
    "(SELECT 1)",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "VALUES (1)",
    "TABLE t",
    "SHOW statement_timeout",
    "EXPLAIN SELECT 1",
    "EXPLAIN (ANALYZE) SELECT 1",
    "/* DO */ SELECT 1",
    "-- SET ROLE x\nSELECT 1",
    "SELECT 'SET ROLE x'",
    "INSERT INTO t VALUES (1)", // Postgres refuses this one, with its own message.
  ];
  for (const sql of allowed) {
    it(`allows ${JSON.stringify(sql)}`, () => {
      assert.doesNotThrow(() => assertReadOnlyStatement(sql));
    });
  }
});

describe("findBlockedFunction", () => {
  it("finds calls however they are spelled", () => {
    assert.equal(findBlockedFunction("SELECT dblink_exec('x', 'y')"), "dblink_exec");
    assert.equal(findBlockedFunction("SELECT * FROM public.dblink('x', 'y') AS t(a int)"), "dblink");
    assert.equal(findBlockedFunction("SELECT DBLINK_EXEC ('x')"), "dblink_exec");
    assert.equal(findBlockedFunction('SELECT "dblink_exec"(1)'), "dblink_exec");
    assert.equal(findBlockedFunction("SELECT set_config /* c */ ('role', 'x', true)"), "set_config");
    assert.equal(findBlockedFunction("SELECT pg_catalog.pg_read_file('x')"), "pg_read_file");
    assert.equal(findBlockedFunction("SELECT query_to_xml('select 1', true, true, '')"), "query_to_xml");
  });

  it("refuses a unicode-escaped identifier used as a function", () => {
    assert.match(findBlockedFunction('SELECT U&"dblink\\005fexec"(1)') ?? "", /^U&"/);
    assert.equal(findBlockedFunction('SELECT U&"col" FROM t'), null);
  });

  it("ignores strings, dollar quotes, comments and non-call uses", () => {
    assert.equal(findBlockedFunction("SELECT 'dblink_exec(1)'"), null);
    assert.equal(findBlockedFunction("SELECT 'it''s dblink_exec(1)'"), null);
    assert.equal(findBlockedFunction("SELECT E'a\\' dblink_exec(1)'"), null);
    assert.equal(findBlockedFunction("SELECT $$dblink_exec(1)$$"), null);
    assert.equal(findBlockedFunction("SELECT $q$ $$ dblink_exec(1) $q$"), null);
    assert.equal(findBlockedFunction("SELECT 1 /* dblink_exec(1) */"), null);
    assert.equal(findBlockedFunction("SELECT dblink_exec FROM t"), null);
    assert.equal(findBlockedFunction("SELECT set_configuration(1)"), null);
  });

  it("resumes scanning after a string and after a parameter", () => {
    assert.equal(findBlockedFunction("SELECT 'x', dblink('y')"), "dblink");
    assert.equal(findBlockedFunction("SELECT $1, set_config('a', $2, true)"), "set_config");
    assert.equal(findBlockedFunction("SELECT E'a\\'b', dblink('y')"), "dblink");
  });

  it("is enforced by assertReadOnlyStatement with a fix in the message", () => {
    assert.throws(() => assertReadOnlyStatement("SELECT dblink_exec('x', 'DELETE FROM t')"), /real boundary/);
  });
});
