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

  it("refuses a unicode-escaped identifier carrying a UESCAPE clause", () => {
    // The clause sits between the name and the parenthesis, and its literal
    // can be any string form (measured on PG18: all of these are calls).
    const bypasses = [
      `SELECT U&"pg_terminate_backend" UESCAPE '!' (123)`,
      `SELECT U&"dblink!005fexec" UESCAPE '!'('a','b')`,
      `SELECT U&"dblink!005fexec" /* c */ uescape -- x\n '!' /* d */ ('a')`,
      `SELECT u&"dblink!005fexec" UESCAPE E'!' ('a')`,
      `SELECT U&"dblink!005fexec" UESCAPE $$!$$ ('a')`,
      `SELECT U&"dblink!005fexec" UESCAPE '!'\n'' ('a')`,
    ];
    for (const sql of bypasses) assert.match(findBlockedFunction(sql) ?? "", /^U&"/, sql);
    // A unicode-escaped string keeps its UESCAPE clause: only identifiers name functions.
    assert.equal(findBlockedFunction("SELECT U&'d!0061t!+000061' UESCAPE '!'"), null);
  });

  it("finds a call written in attribute notation, with no parenthesis", () => {
    // PostgreSQL runs `(arg).fn` as `fn(arg)` (measured on PG18).
    assert.equal(findBlockedFunction("SELECT ('/etc/passwd'::text).pg_read_file"), "pg_read_file");
    assert.equal(findBlockedFunction('SELECT (123) . /* c */ "pg_cancel_backend"'), "pg_cancel_backend");
    assert.equal(findBlockedFunction("SELECT (t.x).pg_ls_dir FROM t"), "pg_ls_dir");
    assert.equal(findBlockedFunction("SELECT (ARRAY['x'])[1].lo_import"), "lo_import");
    assert.equal(findBlockedFunction("SELECT t.dblink_exec FROM t"), "dblink_exec");
    assert.match(findBlockedFunction(`SELECT ('x'::text).U&"pg_read!005ffile" UESCAPE '!'`) ?? "", /^U&"/);
    assert.match(findBlockedFunction(`SELECT ('x'::text).U&"pg_read\\005ffile"`) ?? "", /^U&"/);
    // The dot must be the token directly before the name.
    assert.equal(findBlockedFunction("SELECT t.a, dblink_exec FROM t"), null);
    assert.equal(findBlockedFunction("SELECT t.pg_read_file_count FROM t"), null);
  });

  it("reads a continued E-string in E mode, so its backslash-quote does not end it", () => {
    // PostgreSQL joins literals across a newline and keeps the first one's
    // mode (measured on PG18): the second segment below is an escaped quote,
    // and the call after it is live code.
    const hidden = (gap: string, fn: string) => `SELECT E'a'${gap}'\\'' || ${fn} || '...'`;
    assert.equal(findBlockedFunction(hidden("\n", "set_config('role','x',false)")), "set_config");
    assert.equal(findBlockedFunction(hidden("\r", "pg_read_file('/etc/passwd')")), "pg_read_file");
    assert.equal(findBlockedFunction(hidden(" -- c\n", "pg_terminate_backend(123)")), "pg_terminate_backend");
    assert.equal(findBlockedFunction(hidden("\n-- c\n\t", "dblink('y')")), "dblink");
    assert.equal(findBlockedFunction(hidden("\n'b'\n", "dblink('y')")), "dblink");
    // A benign continuation stays one literal, in either mode.
    assert.equal(findBlockedFunction("SELECT E'a'\n'\\' dblink_exec(1)'"), null);
    assert.equal(findBlockedFunction("SELECT 'a'\n'dblink_exec(1)'"), null);
    // A plain string's continuation is plain too: the backslash is a character.
    assert.equal(findBlockedFunction("SELECT 'a'\n'\\' || dblink('y')"), "dblink");
  });

  it("covers functions that run SQL from text or act outside the transaction", () => {
    const calls: [string, string][] = [
      ["SELECT * FROM crosstab('select pg_terminate_backend(1)') AS t(a int, b int)", "crosstab"],
      ["SELECT * FROM crosstab2('select 1')", "crosstab2"],
      ["SELECT * FROM connectby('t', 'k', 'p', '1', 0) AS t(k text, p text, l int)", "connectby"],
      ["SELECT * FROM xpath_table('k', 'x', 't', '/a', 'true') AS t(k int, a text)", "xpath_table"],
      ["SELECT pg_stat_reset()", "pg_stat_reset"],
      ["SELECT pg_stat_reset_shared('bgwriter')", "pg_stat_reset_shared"],
      ["SELECT pg_stat_statements_reset()", "pg_stat_statements_reset"],
      ["SELECT pg_promote()", "pg_promote"],
      ["SELECT pg_create_physical_replication_slot('s')", "pg_create_physical_replication_slot"],
      ["SELECT pg_drop_replication_slot('s')", "pg_drop_replication_slot"],
      ["SELECT pg_replication_slot_advance('s', '0/0')", "pg_replication_slot_advance"],
      ["SELECT * FROM pg_logical_slot_get_changes('s', NULL, NULL)", "pg_logical_slot_get_changes"],
      ["SELECT pg_backup_start('x')", "pg_backup_start"],
      ["SELECT * FROM pg_backup_stop()", "pg_backup_stop"],
      ["SELECT pg_start_backup('x')", "pg_start_backup"],
      ["SELECT * FROM pg_stop_backup(false)", "pg_stop_backup"],
      ["SELECT pg_log_standby_snapshot()", "pg_log_standby_snapshot"],
      ["SELECT pg_wal_replay_pause()", "pg_wal_replay_pause"],
      ["SELECT pg_wal_replay_resume()", "pg_wal_replay_resume"],
      ["SELECT pg_replication_origin_advance('o', '0/0')", "pg_replication_origin_advance"],
      ["SELECT pg_replication_origin_session_setup('o')", "pg_replication_origin_session_setup"],
    ];
    for (const [sql, name] of calls) assert.equal(findBlockedFunction(sql), name, sql);
    // The catalog views with neighbouring names stay readable.
    assert.equal(findBlockedFunction("SELECT * FROM pg_catalog.pg_replication_slots"), null);
    assert.equal(findBlockedFunction("SELECT s.stats_reset FROM pg_catalog.pg_stat_replication_slots s"), null);
    assert.equal(findBlockedFunction("SELECT * FROM pg_logical_slot_peek_changes('s', NULL, NULL)"), null);
    // Read-only progress probes, and the transactional origin create/drop.
    assert.equal(findBlockedFunction("SELECT pg_replication_origin_progress('o', false)"), null);
    assert.equal(findBlockedFunction("SELECT pg_replication_origin_create('o')"), null);
    assert.equal(findBlockedFunction("SELECT pg_is_wal_replay_paused()"), null);
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

  it("does not send a blocked VACUUM to pg_query, which cannot run it either", () => {
    // pg_query always opens a transaction and VACUUM is refused inside one.
    assert.throws(
      () => assertReadOnlyStatement("VACUUM t"),
      (err: unknown) =>
        err instanceof GuardError && /psql or a maintenance job/.test(err.message) && !/ALLOW_WRITES/.test(err.message),
    );
    assert.throws(() => assertReadOnlyStatement("SET ROLE x"), /`pg_query` with ALLOW_WRITES=1/);
  });
});
