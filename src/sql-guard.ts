/**
 * Lexical checks on SQL headed for a read-only path.
 *
 * NOT a parser, and NOT the security boundary. The boundary is the role in
 * DATABASE_URL: anything that role may do, a sufficiently creative statement
 * can reach (a user-defined wrapper around a blocked function is enough). These
 * checks exist to refuse the well-known ways out of `BEGIN READ ONLY` cheaply
 * and with a useful message.
 *
 * The leading-keyword check is sound only because user SQL is sent on the
 * extended protocol, which refuses a string holding more than one statement:
 * the first keyword is then THE statement. A caller that sends SQL on the
 * simple protocol cannot rely on it.
 */

/** A refusal or abort raised by this server rather than by postgres. */
export class GuardError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "GuardError";
    this.code = code;
  }
}

/** Audit `sqlstate` value of a statement refused before it was sent. */
export const BLOCKED_CODE = "PGMCP_BLOCKED";

/**
 * Statements `BEGIN READ ONLY` does not stop, or that end or reshape the
 * transaction guarding the call:
 *   - session and role state: SET (SET ROLE, SET statement_timeout), RESET,
 *     DISCARD, LOAD
 *   - arbitrary code and row-cap bypass: DO, CALL, PREPARE, EXECUTE, DEALLOCATE
 *   - transaction control: BEGIN, START, COMMIT, END, ABORT, ROLLBACK,
 *     SAVEPOINT, RELEASE
 *   - cursors, which would sidestep the row cap: DECLARE, FETCH, MOVE, CLOSE
 *   - COPY, including COPY ... TO PROGRAM
 *   - allowed in a read-only transaction but heavy or lock-taking: LOCK,
 *     VACUUM, ANALYZE, CLUSTER, REINDEX, CHECKPOINT
 *   - LISTEN, UNLISTEN, NOTIFY
 */
const BLOCKED_KEYWORDS: ReadonlySet<string> = new Set([
  "ABORT",
  "ANALYSE",
  "ANALYZE",
  "BEGIN",
  "CALL",
  "CHECKPOINT",
  "CLOSE",
  "CLUSTER",
  "COMMIT",
  "COPY",
  "DEALLOCATE",
  "DECLARE",
  "DISCARD",
  "DO",
  "END",
  "EXECUTE",
  "FETCH",
  "LISTEN",
  "LOAD",
  "LOCK",
  "MOVE",
  "NOTIFY",
  "PREPARE",
  "REINDEX",
  "RELEASE",
  "RESET",
  "ROLLBACK",
  "SAVEPOINT",
  "SET",
  "START",
  "UNLISTEN",
  "VACUUM",
]);

/**
 * Functions whose effect lands outside the transaction, or that run SQL from a
 * string where neither check here can see it. Matched only as a call, so a
 * column or table with one of these names still works -- unless it is written
 * after a dot, because `(arg).fn` is a call too (see findBlockedFunction).
 * `dblink*` and `pg_stat_reset*` are handled separately because those families
 * are open-ended.
 */
const BLOCKED_FUNCTIONS: ReadonlySet<string> = new Set([
  // Changes role or timeouts without the SET keyword.
  "set_config",
  // The capability pg_kill keeps behind ALLOW_WRITES.
  "pg_cancel_backend",
  "pg_terminate_backend",
  // Server files and configuration.
  "lo_export",
  "lo_import",
  "pg_ls_dir",
  "pg_read_binary_file",
  "pg_read_file",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_stat_file",
  // WAL-level effects that a rollback does not undo.
  "pg_create_restore_point",
  "pg_logical_emit_message",
  "pg_switch_wal",
  // Other effects a rollback does not undo: promotion, discarded statistics,
  // and replication slots created, dropped, advanced or consumed.
  "pg_copy_logical_replication_slot",
  "pg_copy_physical_replication_slot",
  "pg_create_logical_replication_slot",
  "pg_create_physical_replication_slot",
  "pg_drop_replication_slot",
  "pg_logical_slot_get_binary_changes",
  "pg_logical_slot_get_changes",
  "pg_promote",
  "pg_replication_slot_advance",
  "pg_stat_statements_reset",
  "pg_sync_replication_slots",
  // Execute SQL passed as text, which would hide any of the above in a string.
  // connectby and crosstab* (tablefunc) and xpath_table (xml2) are
  // PUBLIC-executable wherever their extension is installed.
  "connectby",
  "crosstab",
  "crosstab2",
  "crosstab3",
  "crosstab4",
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "ts_rewrite",
  "ts_stat",
  "xpath_table",
]);

function isBlockedFunction(name: string): boolean {
  return (
    BLOCKED_FUNCTIONS.has(name) || name === "dblink" || name.startsWith("dblink_") || name.startsWith("pg_stat_reset")
  );
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch >= "\u0080";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9") || ch === "$";
}

/**
 * Index of the first character after any whitespace and comments. Block
 * comments NEST in PostgreSQL, unlike most SQL dialects, so a scanner stopping
 * at the first close would treat the tail of a nested comment as code, and one
 * that ignores comments would miss a keyword hidden behind them. An
 * unterminated comment runs to the end, which is how the server reads it.
 */
function skipTrivia(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (isSpace(ch)) {
      i++;
    } else if (ch === ";") {
      // A leading statement separator: postgres parses `; SET ROLE x` as one
      // statement whose stmt_location sits past the `;` (measured on PG18), so
      // returning null there read as pass -- leadingKeyword found no keyword
      // and assertReadOnlyStatement treated the statement as allowed. The
      // keyword that decides whether this is blocked is the one AFTER the
      // semicolon. A trailing `;` runs off the end and returns `sql.length`.
      i++;
    } else if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
    } else {
      return i;
    }
  }
  return i;
}

function wordEnd(sql: string, start: number): number {
  let i = start;
  while (i < sql.length && isIdentPart(sql[i] as string)) i++;
  return i;
}

/**
 * The statement's first bare word, uppercased, after whitespace, comments,
 * statement separators (`;`) and opening parentheses; null when something else
 * comes first. A quoted identifier is not a keyword, so it never matches.
 */
export function leadingKeyword(sql: string): string | null {
  let i = skipTrivia(sql, 0);
  while (sql[i] === "(") i = skipTrivia(sql, i + 1);
  const ch = sql[i];
  if (ch === undefined || !isIdentStart(ch)) return null;
  return sql.slice(i, wordEnd(sql, i)).toUpperCase();
}

/**
 * Index of the quote that continues a string literal closed just before
 * `start`, or -1. PostgreSQL joins two literals separated only by whitespace
 * holding a newline (line comments allowed, block comments not), and reads the
 * second segment in the FIRST one's mode: after `E'a'`, a backslash-quote on
 * the next line is an escaped quote, not the end of a one-backslash string
 * (measured on PG18). The newline is not required here: without one the server
 * reports a syntax error, so how that text is read cannot matter.
 */
function continuationQuote(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (isSpace(ch)) {
      i++;
    } else if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
    } else {
      break;
    }
  }
  return sql[i] === "'" ? i : -1;
}

/**
 * Index just past a string literal whose body starts at `start`, the opening
 * quote consumed. Continuation segments are part of the literal.
 */
function skipString(sql: string, start: number, backslashEscapes: boolean): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === "\\") {
      i += 2;
    } else if (ch === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
      } else {
        const next = continuationQuote(sql, i + 1);
        if (next === -1) return i + 1;
        i = next + 1;
      }
    } else {
      i++;
    }
  }
  return i;
}

/** The `$tag$` opening at `i`, or null. `$1` is a parameter, not a tag. */
function dollarTag(sql: string, i: number): string | null {
  let j = i + 1;
  const first = sql[j];
  if (first !== "$") {
    if (first === undefined || !isIdentStart(first)) return null;
    while (j < sql.length && sql[j] !== "$" && isIdentPart(sql[j] as string)) j++;
    if (sql[j] !== "$") return null;
  }
  return sql.slice(i, j + 1);
}

/** A double-quoted identifier's body, the opening quote consumed. */
function readQuoted(sql: string, start: number): { end: number; name: string } {
  let name = "";
  let i = start;
  while (i < sql.length) {
    if (sql[i] === '"') {
      if (sql[i + 1] !== '"') return { end: i + 1, name };
      name += '"';
      i += 2;
    } else {
      name += sql[i];
      i++;
    }
  }
  return { end: i, name };
}

/**
 * The first blocked function this statement calls, or null. String literals,
 * dollar quotes and comments are skipped, so naming one in a filter value is
 * fine.
 *
 * A name counts as a call when `(` follows it, and also when it follows a dot:
 * PostgreSQL runs `(arg).fn` as `fn(arg)`, for a scalar argument too (measured
 * on PG18: `SELECT (123).pg_cancel_backend` signals). The cost is refusing a
 * qualified column that happens to carry a blocked name.
 *
 * A `U&"..."` identifier is refused outright when it is called either way or
 * carries a `UESCAPE` clause: its escapes can spell any name, and the clause
 * sits between the name and the parenthesis.
 *
 * Assumes standard_conforming_strings=on, the default since PostgreSQL 9.1;
 * the startup role check (src/preflight.ts) warns when it is off.
 */
export function findBlockedFunction(sql: string): string | null {
  const calledAfter = (end: number): boolean => sql[skipTrivia(sql, end)] === "(";
  // Whether the previous token was a `.`, making this one an attribute-notation call.
  let afterDot = false;
  let i = 0;
  while (i < sql.length) {
    i = skipTrivia(sql, i);
    const ch = sql[i];
    if (ch === undefined) break;
    const viaDot = afterDot;
    afterDot = false;
    if (ch === "'") {
      i = skipString(sql, i + 1, false);
    } else if (ch === '"') {
      const { end, name } = readQuoted(sql, i + 1);
      const lowered = name.toLowerCase();
      if ((viaDot || calledAfter(end)) && isBlockedFunction(lowered)) return lowered;
      i = end;
    } else if (ch === "$") {
      const tag = dollarTag(sql, i);
      if (tag === null) {
        i++;
      } else {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
      }
    } else if (isIdentStart(ch)) {
      const end = wordEnd(sql, i);
      const word = sql.slice(i, end).toLowerCase();
      const next = sql[end];
      if (word === "u" && next === "&" && sql[end + 1] === '"') {
        const quoted = readQuoted(sql, end + 2);
        const after = skipTrivia(sql, quoted.end);
        const uescape = sql.slice(after, wordEnd(sql, after)).toLowerCase() === "uescape";
        if (viaDot || uescape || sql[after] === "(") return `U&"${quoted.name}"`;
        i = quoted.end;
      } else if (word === "u" && next === "&" && sql[end + 1] === "'") {
        i = skipString(sql, end + 2, false);
      } else if (next === "'" && (word === "e" || word === "b" || word === "x" || word === "n")) {
        i = skipString(sql, end + 1, word === "e");
      } else {
        if ((viaDot || calledAfter(end)) && isBlockedFunction(word)) return word;
        i = end;
      }
    } else {
      afterDot = ch === ".";
      i++;
    }
  }
  return null;
}

/**
 * Refuse a statement a read-only path must not run. Throws {@link GuardError}
 * with a message saying what to do instead.
 */
export function assertReadOnlyStatement(sql: string): void {
  const keyword = leadingKeyword(sql);
  if (keyword !== null && BLOCKED_KEYWORDS.has(keyword)) {
    // pg_query always opens a transaction, and VACUUM is refused inside one
    // (25001), so sending the agent there would trade this error for another.
    const instead =
      keyword === "VACUUM"
        ? "VACUUM cannot run through this server: `pg_query` always opens a transaction, and PostgreSQL refuses " +
          "VACUUM inside one. Run it with psql or a maintenance job."
        : "To run this statement deliberately, use `pg_query` with ALLOW_WRITES=1, or a migration tool.";
    throw new GuardError(
      `Blocked in read-only mode: \`${keyword}\` statements can change session state, leave the read-only ` +
        "transaction, or bypass the row cap and timeout, so they are not run here. Send a SELECT, WITH, VALUES, " +
        "TABLE, SHOW or EXPLAIN. For a setting the agent needs on every call, configure it on the role " +
        `(\`ALTER ROLE ... SET ...\`) or in DATABASE_URL. ${instead}`,
      BLOCKED_CODE,
    );
  }
  const fn = findBlockedFunction(sql);
  if (fn !== null) {
    throw new GuardError(
      `Blocked in read-only mode: \`${fn}\` acts outside the read-only transaction or runs SQL from text. ` +
        "Remove the call. If the agent really needs it, use `pg_query` with ALLOW_WRITES=1 and a role granted " +
        "only that capability. This check is a convenience: the DATABASE_URL role is the real boundary.",
      BLOCKED_CODE,
    );
  }
}
