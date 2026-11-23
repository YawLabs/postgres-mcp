/**
 * Startup check of what the DATABASE_URL role can actually do.
 *
 * `BEGIN READ ONLY` limits one transaction; it says nothing about the role. A
 * superuser under that wrapper can still reach the filesystem and other
 * sessions, so calling the server "read-only" without looking at the role
 * overstates it. This reports; it never refuses to start, because local
 * development against a superuser is common and legitimate. Every finding goes
 * to stderr (stdout is the MCP channel).
 */

import { type ApiResponse, formatPgError, runInternal, userSchemaFilter } from "./api.js";

/** Predefined roles that reach past table data. */
const DANGEROUS_ROLES = [
  "pg_execute_server_program",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_write_all_data",
  "pg_signal_backend",
];

/**
 * Functions worth naming when this role may execute them. Plain dblink
 * (`dblink`, `dblink_connect`, `dblink_exec`, `dblink_send_query`) is deliberately
 * absent: the contrib extension grants EXECUTE on all of them to PUBLIC by
 * default, so `has_function_privilege(..., 'EXECUTE')` is true for EVERY role --
 * including the README's blessed least-privilege one -- and the check would warn
 * on the recommended config, making the clean verdict unreachable on any
 * database with dblink installed (a warning that always fires trains users to
 * ignore warnings). `dblink_connect_u` is the exception: it is denied to PUBLIC
 * by default (measured: public_exec = f), so seeing it still is a real finding.
 * The call-level risk of plain dblink is covered by the statement guard
 * (src/sql-guard.ts), which refuses direct dblink* calls outright.
 */
const RISKY_FUNCTIONS = ["dblink_connect_u", "lo_export", "lo_import", "pg_read_binary_file", "pg_read_file"];

const sqlList = (items: string[]): string => items.map((i) => `'${i}'`).join(", ");

/**
 * Which other roles count as SET ROLE targets; shared by the list and its
 * count so the two cannot drift. Predefined roles (the reserved `pg_` prefix:
 * pg_monitor, pg_read_all_data, ...) stay in only while their privileges are
 * NOT already inherited: with INHERIT off, SET reach into them is exactly the
 * risk, but a plain `GRANT pg_read_all_data TO mcp_reader` -- the README's
 * least-privilege recipe -- also grants SET, and warning about a role whose
 * privileges the session already holds made the clean verdict unreachable for
 * the recommended setup. Ordinary roles are always listed, inherited or not:
 * SET ROLE changes current_user, which row-level security policies can key on.
 */
const SETTABLE_WHERE = `r.oid <> me.oid AND pg_catalog.pg_has_role(r.oid, priv.name)
      AND NOT (left(r.rolname::text, 3) = 'pg_' AND pg_catalog.pg_has_role(r.oid, 'USAGE'))`;

/**
 * One statement, so one audit line. `pg_has_role(..., 'SET')` exists from
 * PostgreSQL 16; before that membership is what allows SET ROLE. The privilege
 * name is a runtime value, so the CASE works on every version.
 */
export const ROLE_PREFLIGHT_SQL = `
WITH me AS (SELECT r.* FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
priv AS (
  SELECT CASE WHEN current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END AS name
)
SELECT
  me.rolname::text AS role,
  me.rolsuper AS superuser,
  me.rolcreaterole AS create_role,
  me.rolcreatedb AS create_db,
  me.rolreplication AS replication,
  me.rolbypassrls AS bypass_rls,
  ARRAY(
    SELECT r.rolname::text FROM pg_catalog.pg_roles r
    WHERE r.rolname IN (${sqlList(DANGEROUS_ROLES)}) AND pg_catalog.pg_has_role(r.oid, 'MEMBER')
    ORDER BY 1
  ) AS dangerous_memberships,
  ARRAY(
    -- LIMIT 20 caps the list; settable_count is computed over the FULL set
    -- (no LIMIT) so analyzeRole can flag truncation instead of printing 20 names
    -- that read as complete.
    SELECT r.rolname::text FROM pg_catalog.pg_roles r, priv
    WHERE ${SETTABLE_WHERE}
    ORDER BY 1 LIMIT 20
  ) AS settable_roles,
  (
    SELECT count(*)::int FROM pg_catalog.pg_roles r, priv
    WHERE ${SETTABLE_WHERE}
  ) AS settable_count,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r, priv
    WHERE r.oid <> me.oid AND r.rolsuper AND pg_catalog.pg_has_role(r.oid, priv.name)
  ) AS can_set_superuser,
  ARRAY(
    SELECT DISTINCT p.proname::text FROM pg_catalog.pg_proc p
    WHERE p.proname IN (${sqlList(RISKY_FUNCTIONS)}) AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
    ORDER BY 1
  ) AS risky_functions,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND ${userSchemaFilter("n.nspname")}
      AND pg_catalog.has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
  ) AS can_write_tables,
  current_setting('standard_conforming_strings') = 'on' AS standard_conforming_strings
FROM me`;

export interface RoleFacts {
  role: string;
  superuser: boolean;
  create_role: boolean;
  create_db: boolean;
  replication: boolean;
  bypass_rls: boolean;
  dangerous_memberships: string[];
  settable_roles: string[];
  /** Full count before LIMIT 20; exceeds settable_roles.length when truncated. */
  settable_count: number;
  can_set_superuser: boolean;
  risky_functions: string[];
  can_write_tables: boolean;
  /** The statement guard (src/sql-guard.ts) reads string literals assuming this is on. */
  standard_conforming_strings: boolean;
}

/** What is wrong with this role for an agent, one finding per entry. */
export function analyzeRole(facts: RoleFacts, writesAllowed: boolean): string[] {
  const findings: string[] = [];
  if (facts.superuser) {
    findings.push("is a SUPERUSER: it can run server programs, read server files and bypass every permission check");
  }
  // The privilege findings below are gated on !superuser: pg_has_role() answers
  // true for a superuser on every role, so the SQL reports memberships and SET
  // reach it does not hold, and the SUPERUSER line already covers all of it.
  if (!facts.superuser && facts.can_set_superuser) findings.push("can SET ROLE to a superuser");
  if (!facts.superuser && facts.dangerous_memberships.length > 0) {
    findings.push(`is a member of ${facts.dangerous_memberships.join(", ")}`);
  }
  if (!facts.superuser && facts.settable_roles.length > 0) {
    // The SQL lists at most 20 (LIMIT 20); settable_count is the untruncated
    // total, so say how many were elided rather than implying the list is whole.
    const omitted = facts.settable_count - facts.settable_roles.length;
    const more = omitted > 0 ? ` (and ${omitted} more)` : "";
    findings.push(`can SET ROLE to ${facts.settable_roles.join(", ")}${more}`);
  }
  const attributes = [
    facts.create_role && "CREATEROLE",
    facts.create_db && "CREATEDB",
    facts.replication && "REPLICATION",
    facts.bypass_rls && "BYPASSRLS",
  ].filter((a): a is string => typeof a === "string");
  if (!facts.superuser && attributes.length > 0) findings.push(`has ${attributes.join(", ")}`);
  if (!facts.superuser && facts.risky_functions.length > 0) {
    findings.push(`can execute ${facts.risky_functions.join(", ")}`);
  }
  if (!writesAllowed && !facts.superuser && facts.can_write_tables) {
    findings.push(
      "holds write privileges on tables, which only the transaction wrapper is holding back (dblink or a " +
        "SECURITY DEFINER function can step outside it)",
    );
  }
  // Not gated on !superuser: this is a session setting the statement guard
  // depends on whatever the role, and a superuser connection still relies on
  // the guard for its read-only checks.
  if (facts.standard_conforming_strings === false) {
    findings.push(
      "connects with standard_conforming_strings=off, so the read-only statement checks misread a backslash in a " +
        "string literal and a blocked call can hide behind one (`ALTER ROLE ... SET standard_conforming_strings = on`)",
    );
  }
  return findings;
}

type RoleQuery = (sql: string) => Promise<ApiResponse<RoleFacts[]>>;

/**
 * Log the verdict on stderr. Never throws and never blocks startup: an
 * unreachable database is reported here and again by the first tool call.
 * `log` and `query` are injectable for tests.
 */
export async function runRolePreflight(
  writesAllowed: boolean,
  log: (line: string) => void = (line) => console.error(line),
  query: RoleQuery = (sql) => runInternal<RoleFacts & Record<string, unknown>>(sql),
): Promise<void> {
  const unverified = (why: string): void =>
    log(`[postgres-mcp] role check skipped (${why}). What this server can do is unverified: it depends on the role.`);
  if (!process.env.DATABASE_URL?.trim()) {
    unverified("DATABASE_URL is not set");
    return;
  }
  let facts: RoleFacts | undefined;
  try {
    const res = await query(ROLE_PREFLIGHT_SQL);
    if (!res.ok) {
      unverified(res.error ?? "the check failed");
      return;
    }
    facts = res.data?.[0];
  } catch (err) {
    unverified(formatPgError(err));
    return;
  }
  if (!facts) {
    unverified("current_user was not found in pg_roles");
    return;
  }
  const findings = analyzeRole(facts, writesAllowed);
  if (findings.length === 0) {
    log(`[postgres-mcp] role check: "${facts.role}" has none of the elevated attributes or grants checked for.`);
    return;
  }
  log(`[postgres-mcp] WARNING: this server is NOT effectively read-only. Role "${facts.role}":`);
  for (const finding of findings) log(`[postgres-mcp] WARNING:   - ${finding}`);
  log(
    "[postgres-mcp] WARNING: BEGIN READ ONLY and the statement checks do not contain this role. Fine for local " +
      'development; for anything else connect as a least-privilege role (README, "Configuring access"), and do not ' +
      "auto-allow pg_readonly until you have.",
  );
}
