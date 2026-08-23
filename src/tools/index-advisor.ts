import { z } from "zod";
import { type ApiResponse, getServerVersionNum, PG16, PG18, runInternal, withSharedClient } from "../api.js";
import { warningsField } from "./output.js";
import { identSchema } from "./params.js";
import { compareVersions } from "./stats.js";

/**
 * The runner `withSharedClient` hands its callback. Derived from the helper's
 * own signature rather than re-declared, so a change to the api.ts contract
 * surfaces here as a type error instead of a silently-diverging local copy.
 */
type SharedRunner = Parameters<Parameters<typeof withSharedClient>[0]>[0];

/**
 * Savepoint wrapped around every statement issued inside the advisor's
 * transaction.
 *
 * Deliberately NOT `__pgmcp_sp`: api.ts reserves that name for
 * `runUserQueryBounded` and documents that hook-owned state must not collide
 * with it. This tool drives its own transaction rather than riding
 * `runReadOnly`, but reusing the reserved name would still be a trap for the
 * next person who wires these two paths together.
 *
 * The savepoint is what keeps ONE bad statement from killing the whole run: a
 * failed EXPLAIN aborts the transaction (SQLSTATE 25P02 on every subsequent
 * statement), so without a rollback target the first unplannable entry from
 * pg_stat_statements would take every later candidate down with it.
 */
const ADVISOR_SAVEPOINT = "__pgmcp_advisor_sp";

/**
 * Only btree candidates are generated. hash/gin/gist/brin all need knowledge
 * this tool does not have (operator class fit, the query's containment vs.
 * equality semantics, whether the column is a tsvector), and a wrong access
 * method produces an index the planner silently never uses. `pg_explain`'s
 * `hypothetical_indexes` is the escape hatch for costing a non-btree guess by
 * hand.
 */
const CANDIDATE_ACCESS_METHOD = "btree";

/** PostgreSQL caps identifiers at NAMEDATALEN-1 = 63 BYTES, not characters. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * How a column earned its place in a candidate, which decides where it sits in
 * the key. The three roles are ordered: every equality column, then at most one
 * range column, then sort columns.
 *
 * `range` is capped at one because a btree stops filtering after its first
 * inequality -- columns to the right of a range predicate can only be read, not
 * searched. Adding a second range column widens the index for nothing.
 */
export type PredicateRole = "equality" | "range" | "sort";

/** A relation as the planner named it, plus what each of its columns was used for. */
export interface RelationPredicates {
  schema: string;
  table: string;
  /** Column name to the set of roles it appeared in across this statement's plan. */
  columns: Map<string, Set<PredicateRole>>;
}

/** One workload entry: the SQL to plan and how heavily it should count. */
interface WorkloadStatement {
  sql: string;
  /**
   * Execution count from pg_stat_statements, or 1 for a caller-supplied
   * statement. Used only as a MULTIPLIER on estimated cost -- a query run a
   * million times deserves an index more than an identical one run twice.
   */
  weight: number;
  /**
   * The SAME count as `weight`, kept as the raw decimal string postgres sent.
   *
   * Both exist because only one of them can be lossless. `calls` is a bigint,
   * and every bigint counter in this codebase is serialized as text so a value
   * past 2^53 survives the round trip; `weight` is a float multiplier on a
   * float cost, where that precision is irrelevant. Reporting `String(weight)`
   * instead would quietly re-round the very number this field exists to
   * preserve.
   */
  calls: string;
}

/** Per-column statistics used to order a candidate's key columns. */
export interface ColumnStats {
  /**
   * Fraction of rows that are distinct, normalized to 0..1 (1 = unique).
   * pg_stats reports n_distinct as a negative FRACTION or a positive ABSOLUTE
   * count depending on the column, so the raw value cannot be compared across
   * columns without this normalization. 0 means "unknown" (never analyzed) and
   * sorts last rather than first -- an unanalyzed column is not evidence of low
   * selectivity, so it must not win a leading position by default.
   */
  distinctRatio: number;
}

/** A proposed index, before HypoPG has been asked whether it actually helps. */
export interface IndexCandidate {
  schema: string;
  table: string;
  /** Key columns in index order: equality first, then one range, then sort. */
  columns: string[];
  /**
   * True when the LEADING column appears in at least one filter or join
   * predicate somewhere in the workload. False means the leading column is only
   * ever an ORDER BY / GROUP BY key -- which is what the PG18 skip-scan gate
   * turns on. See {@link applySkipScanGate}.
   */
  leadingConstrained: boolean;
  /** Indices into the workload array for statements whose plan touched this relation. */
  statements: number[];
  /** Sequential scans on this table since the last stats reset; orders the candidate list. */
  seqScans: number;
}

/** What the greedy search decided about one accepted candidate. */
export interface AcceptedCandidate {
  candidate: IndexCandidate;
  /** Weighted workload cost before this index (i.e. with all previously accepted ones). */
  costBefore: number;
  /** Weighted workload cost after. */
  costAfter: number;
  /** Per-statement costs this index changed, keyed by workload index. */
  perStatement: Map<number, { before: number; after: number }>;
}

/** Outcome of {@link greedySearch}, independent of how candidates were costed. */
export interface GreedyResult {
  accepted: AcceptedCandidate[];
  /** EXPLAIN round trips actually spent. Never exceeds the budget it was given. */
  explainsUsed: number;
  /** True when the search stopped because the budget ran out, not because it converged. */
  budgetExhausted: boolean;
}

/**
 * Quote a single SQL identifier, doubling any embedded quote so a name like
 * `weird"col` becomes `"weird""col"`. Same helper as explain.ts, duplicated
 * rather than shared because the two files quote for different consumers: that
 * one builds text for hypopg_create_index, this one also builds the CREATE
 * INDEX a human will paste into psql.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote `schema.table` as two independently-quoted pieces. */
function quoteQualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Escape a value for literal use inside a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * character in half.
 *
 * Postgres truncates an over-long index name server-side, so this is not about
 * preventing an error -- it is about the name in `create_statement` matching
 * the name the server will actually assign. A JS `slice(0, 63)` counts
 * CHARACTERS, so a name built from multi-byte column names would render longer
 * than 63 bytes and the emitted statement would disagree with reality.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * Identifier-shaped tokens in a planner-emitted condition string.
 *
 * This is the honest core of candidate generation, and the reason it is NOT a
 * SQL parser. We never parse the user's SQL. We read what the PLANNER reports
 * for a query it already parsed and resolved -- `Filter`, `Index Cond`,
 * `Hash Cond`, `Sort Key` -- and pull out anything shaped like an identifier.
 * The extraction is deliberately over-eager: `(status = 'active'::text)` yields
 * `status`, `active`, and `text`. Every token is then intersected with the
 * relation's REAL column list from pg_attribute, so a token that is not a
 * column of the table under consideration is dropped. A false token can
 * therefore never invent a column -- at worst it proposes an index on a real
 * column that happens to share a name with a type or a literal, and HypoPG
 * costs that candidate and discards it for not helping.
 *
 * Both quoted and bare forms are matched, because the planner quotes only the
 * identifiers that require it.
 */
export function extractIdentifiers(condition: string): string[] {
  const out: string[] = [];
  // Quoted identifiers first: their contents may include spaces and operators
  // that the bare-identifier pass below would shred into fragments.
  const quoted = /"((?:[^"]|"")*)"/g;
  let m = quoted.exec(condition);
  while (m !== null) {
    if (m[1] !== undefined) out.push(m[1].replace(/""/g, '"'));
    m = quoted.exec(condition);
  }
  // Bare identifiers, scanned with quoted runs blanked out so a quoted name is
  // not also reported in fragments.
  const withoutQuoted = condition.replace(quoted, " ");
  const bare = /[A-Za-z_][A-Za-z0-9_$]*/g;
  let b = bare.exec(withoutQuoted);
  while (b !== null) {
    out.push(b[0]);
    b = bare.exec(withoutQuoted);
  }
  return out;
}

/**
 * Decide whether `column` is used with an equality or an inequality operator in
 * a planner condition string.
 *
 * A heuristic, and labelled as one: it looks for the column token immediately
 * beside a comparison operator on either side, so both `col > x` and `x < col`
 * read as a range. When no operator sits next to the token -- the column
 * appears inside a function call, a CASE, or an operator this does not know --
 * it returns "equality", because equality is the placement that costs least
 * when wrong. An equality column sits in the key prefix, where a btree can
 * still use it for a range scan; mis-labelling a true equality column as a
 * range would push every later column past the index's first inequality and
 * make them unsearchable.
 */
export function classifyRole(column: string, condition: string): "equality" | "range" {
  const escaped = escapeRegex(column);
  const token = `(?:"${escaped}"|\\b${escaped}\\b)`;
  // `<>` and `!=` are inequality operators but they are not RANGE predicates --
  // a btree cannot use them to bound a scan at all. Treating them as `range`
  // would burn the single range slot on a column the index can never narrow on.
  //
  // The two lookarounds are what exclude `<>`, and both halves are needed: a
  // bare `<` alternative matches the first character of `<>`, and a bare `>`
  // alternative matches its second (which is how `'x' <> col` slipped through
  // as a range even after the `<` was guarded). `<=` and `>=` are listed first
  // so the alternation prefers them over the guarded single-character forms.
  const rangeOps = "(?:<=|>=|<(?!>)|(?<!<)>|~~)";
  if (new RegExp(`${token}\\s*${rangeOps}`).test(condition)) return "range";
  if (new RegExp(`${rangeOps}\\s*${token}`).test(condition)) return "range";
  if (new RegExp(`${token}\\s+BETWEEN\\b`, "i").test(condition)) return "range";
  return "equality";
}

/** Plan-node keys whose value is a condition string attributable to THIS node's relation. */
const SCAN_CONDITION_KEYS = ["Filter", "Index Cond", "Recheck Cond", "TID Cond"] as const;

/**
 * Plan-node keys whose value is a condition string belonging to the node's
 * SUBTREE rather than to the node itself. A `Hash Cond` lives on the join node,
 * not on either scanned relation, and with VERBOSE it is qualified by ALIAS --
 * so the alias cannot be mapped back to a table name without tracking the
 * query's alias scope. Attributing these to every relation beneath the node and
 * letting the column-membership check sort it out is the deliberate trade: it
 * can propose an index on the wrong side of a join when two tables share a
 * column name, and HypoPG then declines to keep it.
 */
const SUBTREE_CONDITION_KEYS = ["Hash Cond", "Merge Cond", "Join Filter"] as const;

/** Plan-node keys carrying an ARRAY of ordering expressions, attributed to the subtree. */
const SUBTREE_SORT_KEYS = ["Sort Key", "Group Key", "Presorted Key"] as const;

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  Schema?: string;
  "Total Cost"?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/**
 * Unwrap `EXPLAIN (FORMAT JSON)` output to its root plan node.
 *
 * node-pg hands back parsed json for a json column, so the value is normally
 * `[{ "Plan": {...} }]`. This is defensive about shape because the alternative
 * -- indexing straight into the nested object -- throws a TypeError on a string
 * or an empty array, and a malformed plan should degrade to "no candidates from
 * this statement", never take the tool down.
 */
function planRootNode(plan: unknown): PlanNode | undefined {
  const wrapper = Array.isArray(plan) ? plan[0] : plan;
  if (!wrapper || typeof wrapper !== "object") return undefined;
  const inner = (wrapper as { Plan?: unknown }).Plan;
  if (!inner || typeof inner !== "object") return undefined;
  return inner as PlanNode;
}

/**
 * Total estimated cost of a parsed plan, or null when the shape is not what
 * FORMAT JSON promises. Null is a "skip this statement" signal, never a 0 -- a
 * zero baseline would make every candidate look like it made things worse.
 */
export function planTotalCost(plan: unknown): number | null {
  const root = planRootNode(plan);
  const cost = root?.["Total Cost"];
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

/** Walk a plan tree collecting `schema.table` for every node that scans a relation. */
export function collectRelations(plan: unknown, into: Set<string> = new Set()): Set<string> {
  const walk = (node: PlanNode | undefined): void => {
    if (!node || typeof node !== "object") return;
    const relation = node["Relation Name"];
    const schema = node.Schema;
    if (typeof relation === "string" && typeof schema === "string") into.add(`${schema}.${relation}`);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(planRootNode(plan));
  return into;
}

/**
 * Walk one statement's `EXPLAIN (FORMAT JSON, VERBOSE)` plan and collect, per
 * relation, which columns the planner reported as filters, join keys, or sort
 * keys.
 *
 * `knownColumns` is the catalog's answer for each relation and is what makes
 * the over-eager tokenizer safe -- see {@link extractIdentifiers}. It is keyed
 * `schema.table`; a relation the caller did not supply columns for is skipped
 * entirely rather than guessed at.
 */
export function harvestPlanPredicates(
  plan: unknown,
  knownColumns: Map<string, Set<string>>,
): Map<string, RelationPredicates> {
  const found = new Map<string, RelationPredicates>();

  const record = (key: string, column: string, role: PredicateRole): void => {
    const entry = found.get(key);
    if (!entry) return;
    const roles = entry.columns.get(column);
    if (roles) roles.add(role);
    else entry.columns.set(column, new Set([role]));
  };

  /** Returns the relation keys in this subtree, so parents can attribute join/sort conds. */
  const walk = (node: PlanNode | undefined): string[] => {
    if (!node || typeof node !== "object") return [];

    const subtree: string[] = [];
    const relation = node["Relation Name"];
    // `Schema` is only emitted with VERBOSE, which this tool always passes.
    // Falling back to "public" on a plan captured without it would silently
    // attribute a relation to the wrong schema, so an absent Schema means the
    // node is skipped rather than guessed.
    const schema = node.Schema;
    let selfKey: string | null = null;
    if (typeof relation === "string" && typeof schema === "string") {
      const key = `${schema}.${relation}`;
      if (knownColumns.has(key)) {
        if (!found.has(key)) found.set(key, { schema, table: relation, columns: new Map() });
        subtree.push(key);
        selfKey = key;
      }
    }

    // Scan-level conditions are unambiguous: they belong to the relation this
    // node reads, so they carry no attribution ambiguity beyond the tokenizer's.
    if (selfKey) {
      const cols = knownColumns.get(selfKey);
      for (const key of SCAN_CONDITION_KEYS) {
        const cond = node[key];
        if (typeof cond !== "string") continue;
        for (const tok of extractIdentifiers(cond)) {
          if (cols?.has(tok)) record(selfKey, tok, classifyRole(tok, cond));
        }
      }
    }

    for (const child of node.Plans ?? []) subtree.push(...walk(child));

    // Join and sort expressions: attribute to every relation beneath this node
    // whose real column list contains the token.
    const attributeToSubtree = (cond: string, forcedRole: PredicateRole | null): void => {
      const tokens = extractIdentifiers(cond);
      for (const key of subtree) {
        const cols = knownColumns.get(key);
        if (!cols) continue;
        for (const tok of tokens) {
          if (cols.has(tok)) record(key, tok, forcedRole ?? classifyRole(tok, cond));
        }
      }
    };

    for (const key of SUBTREE_CONDITION_KEYS) {
      const cond = node[key];
      if (typeof cond === "string") attributeToSubtree(cond, null);
    }
    for (const key of SUBTREE_SORT_KEYS) {
      const value = node[key];
      if (!Array.isArray(value)) continue;
      // Sort keys are always role "sort" regardless of what classifyRole would
      // say: `created_at DESC` contains no operator, and an ordering column
      // belongs at the END of the key, never in the equality prefix.
      for (const expr of value) {
        if (typeof expr === "string") attributeToSubtree(expr, "sort");
      }
    }

    return subtree;
  };

  walk(planRootNode(plan));
  return found;
}

/**
 * Normalize pg_stats.n_distinct to a 0..1 selectivity.
 *
 * pg_stats reports it two ways and they are not comparable without this:
 * NEGATIVE values are already a fraction of the table (-1 = every row
 * distinct), POSITIVE values are an absolute distinct count that only means
 * something next to the row count. 0 means "never analyzed" and must sort LAST,
 * not first -- an unanalyzed column is not evidence of poor selectivity, and
 * letting it win a leading key position would be a guess dressed as a
 * measurement.
 */
export function normalizeDistinct(nDistinct: number | null, reltuples: number | null): number {
  if (nDistinct === null || !Number.isFinite(nDistinct) || nDistinct === 0) return 0;
  if (nDistinct < 0) return Math.min(1, -nDistinct);
  if (reltuples === null || !Number.isFinite(reltuples) || reltuples <= 0) return 0;
  return Math.min(1, nDistinct / reltuples);
}

/**
 * Order a relation's harvested columns into a btree key and cut it to
 * `maxColumns`.
 *
 * Equality columns lead, ordered by selectivity (most distinct first) so the
 * index narrows fastest at its root. Then AT MOST ONE range column -- a btree
 * cannot search past its first inequality, so a second range column adds bytes
 * and buys nothing. Sort columns come last, where they can still serve an ORDER
 * BY that follows the filtered prefix.
 *
 * A column that appeared in several roles is placed by its strongest one
 * (equality, then range, then sort), because that is the position from which
 * the index can serve every one of its uses.
 */
export function orderCandidateColumns(
  columns: Map<string, Set<PredicateRole>>,
  stats: Map<string, ColumnStats>,
  maxColumns: number,
): string[] {
  const equality: string[] = [];
  const range: string[] = [];
  const sort: string[] = [];
  for (const [column, roles] of columns) {
    if (roles.has("equality")) equality.push(column);
    else if (roles.has("range")) range.push(column);
    else sort.push(column);
  }
  // Most-selective-first. Ties break on name so the candidate list (and every
  // test that reads it) is deterministic rather than dependent on Map order.
  const bySelectivity = (a: string, b: string): number => {
    const da = stats.get(a)?.distinctRatio ?? 0;
    const db = stats.get(b)?.distinctRatio ?? 0;
    if (da !== db) return db - da;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  equality.sort(bySelectivity);
  range.sort(bySelectivity);
  sort.sort(bySelectivity);
  return [...equality, ...range.slice(0, 1), ...sort].slice(0, maxColumns);
}

/**
 * PostgreSQL 18 added B-tree SKIP SCAN, and it invalidates the single most
 * repeated index heuristic in the field.
 *
 * The classic rule -- "a multi-column btree whose LEADING column the query
 * never constrains cannot be used, so do not propose it" -- was true through
 * PG17. On PG18+ the planner can skip through the distinct values of an
 * unconstrained leading column and still use the columns behind it, so such an
 * index is now a legitimate recommendation, and often the BETTER one: the same
 * index also serves the queries that DO constrain the leading column, where a
 * narrower index would have to be a second index.
 *
 * Applying the old rule on PG18+ silently discards correct recommendations;
 * ignoring it on PG17 and below spends the EXPLAIN budget on candidates the
 * planner is guaranteed to refuse. So the prune is gated on the server version
 * rather than hard-coded either way.
 *
 * Single-column candidates are never pruned: their leading column IS the only
 * column, and if it was harvested at all it came from a predicate or an
 * ordering the index can serve directly.
 */
export function applySkipScanGate(
  candidates: IndexCandidate[],
  serverVersionNum: number,
): { kept: IndexCandidate[]; pruned: IndexCandidate[] } {
  // getServerVersionNum returns 0 when the version could not be read, and 0
  // falls through to the conservative pre-skip-scan prune. That loses a
  // recommendation at worst; the opposite default would spend the whole budget
  // on candidates an old server can never use.
  if (serverVersionNum >= PG18) return { kept: candidates, pruned: [] };
  const kept: IndexCandidate[] = [];
  const pruned: IndexCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.columns.length <= 1 || candidate.leadingConstrained) kept.push(candidate);
    else pruned.push(candidate);
  }
  return { kept, pruned };
}

/** Stable key for de-duplicating candidates and matching them against existing indexes. */
function candidateKey(schema: string, table: string, columns: string[]): string {
  return `${schema} ${table} ${columns.join(" ")}`;
}

/**
 * Build the candidate list from harvested predicates.
 *
 * For each relation, every PREFIX of the ordered key is a candidate, not just
 * the full-width one: a three-column index is not always better than the
 * one-column index on its leading column (it is larger, slower to maintain, and
 * the extra columns may buy nothing), and only HypoPG can say which wins.
 * Generating the prefixes is what lets the greedy search choose.
 *
 * `existingIndexPrefixes` holds, for every real btree index on the table, the
 * key columns of each of its prefixes -- so a candidate an existing index
 * already covers is dropped before it costs an EXPLAIN.
 */
export function buildCandidates(options: {
  /** Per-statement harvest, indexed the same as the workload array. */
  perStatement: Map<string, RelationPredicates>[];
  columnStats: Map<string, Map<string, ColumnStats>>;
  existingIndexPrefixes: Set<string>;
  seqScans: Map<string, number>;
  maxIndexColumns: number;
}): IndexCandidate[] {
  const { perStatement, columnStats, existingIndexPrefixes, seqScans, maxIndexColumns } = options;

  // Union each relation's harvest across every statement. A column filtered in
  // one query and sorted in another should produce ONE index serving both --
  // per-statement candidates would propose two overlapping indexes and let the
  // greedy search pick one, which wastes budget and hides the better union.
  const merged = new Map<string, RelationPredicates>();
  const touchedBy = new Map<string, Set<number>>();
  perStatement.forEach((harvest, index) => {
    for (const [key, predicates] of harvest) {
      let entry = merged.get(key);
      if (!entry) {
        entry = { schema: predicates.schema, table: predicates.table, columns: new Map() };
        merged.set(key, entry);
      }
      for (const [column, roles] of predicates.columns) {
        const existing = entry.columns.get(column);
        if (existing) for (const role of roles) existing.add(role);
        else entry.columns.set(column, new Set(roles));
      }
      const touched = touchedBy.get(key);
      if (touched) touched.add(index);
      else touchedBy.set(key, new Set([index]));
    }
  });

  const candidates: IndexCandidate[] = [];
  const seen = new Set<string>();
  for (const [key, predicates] of merged) {
    const stats = columnStats.get(key) ?? new Map<string, ColumnStats>();
    const ordered = orderCandidateColumns(predicates.columns, stats, maxIndexColumns);
    if (ordered.length === 0) continue;
    const statements = [...(touchedBy.get(key) ?? [])].sort((a, b) => a - b);
    for (let width = 1; width <= ordered.length; width++) {
      const columns = ordered.slice(0, width);
      const dedupeKey = candidateKey(predicates.schema, predicates.table, columns);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      // An existing index whose key STARTS with these columns already answers
      // everything this candidate would. Checking prefixes rather than exact
      // equality is what catches "you already have (a, b), stop proposing (a)".
      if (existingIndexPrefixes.has(dedupeKey)) continue;
      const leadColumn = columns[0];
      const leadRoles = leadColumn === undefined ? undefined : predicates.columns.get(leadColumn);
      candidates.push({
        schema: predicates.schema,
        table: predicates.table,
        columns,
        leadingConstrained: leadRoles !== undefined && (leadRoles.has("equality") || leadRoles.has("range")),
        statements,
        seqScans: seqScans.get(key) ?? 0,
      });
    }
  }

  // Heaviest-sequentially-scanned table first: when the budget cannot cover
  // every candidate, the table postgres is actually reading end-to-end is where
  // an index pays. Narrower candidates break ties ahead of wider ones, because a
  // one-column index that wins is cheaper to maintain than a three-column one.
  candidates.sort((a, b) => {
    if (a.seqScans !== b.seqScans) return b.seqScans - a.seqScans;
    if (a.columns.length !== b.columns.length) return a.columns.length - b.columns.length;
    const ka = candidateKey(a.schema, a.table, a.columns);
    const kb = candidateKey(b.schema, b.table, b.columns);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return candidates;
}

/** Render the CREATE INDEX a human can paste, with a generated name. */
export function renderCreateIndex(candidate: IndexCandidate, concurrently: boolean): string {
  const name = truncateToBytes(
    `idx_${candidate.table}_${candidate.columns.join("_")}`.replace(/[^A-Za-z0-9_]/g, "_"),
    MAX_IDENTIFIER_BYTES,
  );
  const cols = candidate.columns.map(quoteIdent).join(", ");
  return (
    `CREATE INDEX${concurrently ? " CONCURRENTLY" : ""} ${quoteIdent(name)} ` +
    `ON ${quoteQualified(candidate.schema, candidate.table)} ` +
    `USING ${CANDIDATE_ACCESS_METHOD} (${cols})`
  );
}

/**
 * Bounded greedy search over the candidate list.
 *
 * Greedy rather than exhaustive because index selection is a set-cover problem:
 * evaluating every subset of N candidates is 2 to the N EXPLAINs, which on a
 * real workload is not a large number, it is an unbounded one. Greedy takes the
 * single best candidate, keeps it, and re-measures the rest ON TOP of it, so the
 * second pick is chosen knowing what the first already fixed -- which is exactly
 * the interaction a per-candidate ranking misses.
 *
 * `evaluate` is injected rather than called directly so the search's accounting
 * can be tested without a database. It returns the new per-statement costs for
 * the statements it was asked about, or null when the candidate could not be
 * costed at all.
 *
 * The budget is checked BEFORE each evaluation, never after: a search that
 * overshoots its cap and then reports the overshoot has not honored the cap. A
 * candidate that would not fit ends the round, and `budgetExhausted` says the
 * result is a truncated search rather than a converged one.
 */
export async function greedySearch(options: {
  candidates: IndexCandidate[];
  /** Weighted per-statement cost with the currently-accepted set applied. */
  currentCosts: number[];
  weights: number[];
  explainBudget: number;
  /** Minimum fraction of total workload cost a candidate must remove to be accepted (0..1). */
  minImprovement: number;
  maxRecommendations: number;
  evaluate: (candidate: IndexCandidate, statementIndices: number[]) => Promise<Map<number, number> | null>;
}): Promise<GreedyResult> {
  const { candidates, currentCosts, weights, explainBudget, minImprovement, maxRecommendations, evaluate } = options;

  const accepted: AcceptedCandidate[] = [];
  const remaining = [...candidates];
  const costs = [...currentCosts];
  let explainsUsed = 0;
  let budgetExhausted = false;

  const weightedTotal = (): number => costs.reduce((sum, cost, i) => sum + cost * (weights[i] ?? 1), 0);

  while (accepted.length < maxRecommendations && remaining.length > 0) {
    let best: { position: number; costs: Map<number, number>; after: number } | null = null;
    const before = weightedTotal();

    for (let position = 0; position < remaining.length; position++) {
      const candidate = remaining[position];
      if (!candidate) continue;
      // A candidate touching no statement can never change a cost; skipping it
      // here keeps it from burning a zero-value slot in the budget.
      if (candidate.statements.length === 0) continue;
      if (explainsUsed + candidate.statements.length > explainBudget) {
        budgetExhausted = true;
        break;
      }
      explainsUsed += candidate.statements.length;
      const measured = await evaluate(candidate, candidate.statements);
      if (!measured) continue;
      let after = 0;
      for (let i = 0; i < costs.length; i++) {
        const replaced = measured.get(i);
        after += (replaced ?? costs[i] ?? 0) * (weights[i] ?? 1);
      }
      if (!best || after < best.after) best = { position, costs: measured, after };
    }

    if (!best) break;
    // Relative, not absolute: a 500-unit saving is decisive on a 600-cost
    // workload and noise on a 6-million one, and an absolute floor would have to
    // be re-tuned per database to mean the same thing.
    const improvement = before > 0 ? (before - best.after) / before : 0;
    if (improvement < minImprovement) break;

    const candidate = remaining[best.position];
    if (!candidate) break;
    const perStatement = new Map<number, { before: number; after: number }>();
    for (const [index, cost] of best.costs) {
      const previous = costs[index] ?? 0;
      // Report only the statements this index actually moved. A statement whose
      // cost is unchanged is not "helped by" the index, and listing it would
      // overstate the recommendation's reach.
      if (cost < previous) perStatement.set(index, { before: previous, after: cost });
      costs[index] = cost;
    }
    accepted.push({ candidate, costBefore: before, costAfter: best.after, perStatement });
    remaining.splice(best.position, 1);
    if (budgetExhausted) break;
  }

  return { accepted, explainsUsed, budgetExhausted };
}

/** Result of running one EXPLAIN inside the advisor's transaction. */
interface ExplainOutcome {
  ok: boolean;
  cost?: number;
  plan?: unknown;
  error?: string;
}

/**
 * EXPLAIN one statement inside the advisor's transaction, isolating failure
 * behind a savepoint.
 *
 * `GENERIC_PLAN` is what makes a pg_stat_statements workload plannable at all:
 * those entries are NORMALIZED, so the SQL text carries placeholders with no
 * values to bind, and a plain EXPLAIN answers "there is no parameter $1".
 * GENERIC_PLAN asks the planner to plan without them. It landed in PostgreSQL
 * 16, so on an older server a parameterized statement simply cannot be costed
 * and is reported as skipped rather than silently dropped.
 *
 * VERBOSE is not cosmetic: it is the only way FORMAT JSON emits the `Schema`
 * key, and without it every scan node would have to be attributed to a guessed
 * schema. See {@link harvestPlanPredicates}.
 */
async function explainStatement(run: SharedRunner, sql: string, useGenericPlan: boolean): Promise<ExplainOutcome> {
  const flags = ["FORMAT JSON", "VERBOSE"];
  if (useGenericPlan) flags.push("GENERIC_PLAN");
  const explainSql = `EXPLAIN (${flags.join(", ")}) ${sql}`;

  const sp = await run(`SAVEPOINT ${ADVISOR_SAVEPOINT}`);
  if (!sp.ok) return { ok: false, error: sp.error };
  const result = await run<{ "QUERY PLAN": unknown }>(explainSql);
  if (!result.ok) {
    // ROLLBACK TO clears the aborted state but LEAVES the savepoint in place, so
    // the RELEASE is still required -- skipping it leaks one savepoint per
    // failed statement for the life of the transaction.
    await run(`ROLLBACK TO SAVEPOINT ${ADVISOR_SAVEPOINT}`);
    await run(`RELEASE SAVEPOINT ${ADVISOR_SAVEPOINT}`);
    return { ok: false, error: result.error };
  }
  await run(`RELEASE SAVEPOINT ${ADVISOR_SAVEPOINT}`);

  const plan = result.data?.[0]?.["QUERY PLAN"];
  const cost = planTotalCost(plan);
  if (cost === null) return { ok: false, error: "EXPLAIN returned a plan with no readable Total Cost." };
  return { ok: true, cost, plan };
}

/**
 * Create one hypothetical index and return its oid, or null when HypoPG
 * declined. Null is a "skip this candidate" signal: HypoPG refuses index shapes
 * it cannot model (an unsupported opclass, a column type with no btree
 * ordering), and that is a normal outcome for a generated candidate, not a tool
 * failure.
 */
async function createHypotheticalIndex(run: SharedRunner, candidate: IndexCandidate): Promise<number | null> {
  const cols = candidate.columns.map(quoteIdent).join(", ");
  const createSql =
    `CREATE INDEX ON ${quoteQualified(candidate.schema, candidate.table)} ` +
    `USING ${CANDIDATE_ACCESS_METHOD} (${cols})`;
  // Savepoint-wrapped for the same reason every EXPLAIN is: a rejected shape
  // raises, and an aborted transaction would take every later candidate with it.
  const sp = await run(`SAVEPOINT ${ADVISOR_SAVEPOINT}`);
  if (!sp.ok) return null;
  const res = await run<{ indexrelid: string | number | null }>(
    "SELECT (hypopg_create_index($1)).indexrelid AS indexrelid",
    [createSql],
  );
  if (!res.ok) {
    await run(`ROLLBACK TO SAVEPOINT ${ADVISOR_SAVEPOINT}`);
    await run(`RELEASE SAVEPOINT ${ADVISOR_SAVEPOINT}`);
    return null;
  }
  await run(`RELEASE SAVEPOINT ${ADVISOR_SAVEPOINT}`);
  const raw = res.data?.[0]?.indexrelid;
  const oid = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(oid) ? oid : null;
}

/** Shorten a statement for echoing back, so one huge query cannot dominate the response. */
function preview(sql: string, max = 300): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

/** Costs are planner estimates; two decimals is well past their real precision. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export const indexAdvisorTools = [
  {
    name: "pg_index_advisor",
    description:
      "Recommend indexes for a workload, and prove each one pays for itself before recommending it. " +
      "Give it `statements` (the SQL you care about) or let it take the top N from `pg_stat_statements`; " +
      "it plans each statement, generates candidate indexes, costs them with HypoPG hypothetical " +
      "indexes, and returns only the ones that measurably cut estimated cost.\n" +
      "How candidates are generated, and the honest limit: this tool has NO SQL parser and does not " +
      "read your SQL text. It EXPLAINs each statement and harvests the columns the PLANNER reports as " +
      "filters, join keys, and sort keys, then intersects those tokens with the real column list from " +
      "`pg_attribute` -- so a candidate can never name a column that does not exist. The extraction is " +
      "deliberately loose (a token matching a real column name on a different table can slip through); " +
      "HypoPG is the arbiter, and anything that does not lower cost is discarded. Column ORDER within " +
      "each candidate is equality columns first (most selective first, from `pg_stats`), then at most " +
      "one range column, then sort columns.\n" +
      "The search is greedy and BOUNDED. Each accepted index stays in place while the rest are " +
      "re-costed on top of it, so later picks account for what earlier ones already fixed. " +
      "`max_candidates` caps how many candidates are considered and `max_explains` caps total EXPLAIN " +
      "round trips; when a cap stops the search early, `budget_exhausted` is true and the result is a " +
      "truncated search, not a converged one.\n" +
      "PostgreSQL 18 note, and it reverses a rule you have probably internalized: PG18 added B-tree " +
      "SKIP SCAN, so a multi-column index whose LEADING column the query never constrains CAN now be " +
      "used. The classic 'leading column never filtered means the index is useless' heuristic is wrong " +
      "on PG18+. This tool gates that prune on the server version -- on PG18+ such candidates are kept " +
      "and costed (`skip_scan_available: true`, and an accepted one carries `requires_skip_scan`), " +
      "below PG18 they are pruned as unusable and counted in `candidates_pruned_leading_column`.\n" +
      "Requires the HypoPG extension (`CREATE EXTENSION hypopg;`). Hypothetical indexes are " +
      "session-scoped and are reset before the call returns, on the success and the failure path " +
      "alike, so they never touch disk and never leak into a later query plan. Statements are only " +
      "ever EXPLAINed, never executed, inside a `BEGIN READ ONLY` transaction.\n" +
      "Costs are PLANNER ESTIMATES, not measurements: they are the right way to compare two plans for " +
      "the same statement and the wrong way to predict wall-clock time. They are weighted by `calls` " +
      "when the workload came from pg_stat_statements, so a query run a million times outranks an " +
      "identical one run twice. Validate a recommendation with `pg_explain` before creating it, and " +
      "create it with CONCURRENTLY in production (`create_statement_concurrently`).",
    annotations: {
      title: "Recommend indexes for a workload",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      statements: z
        .array(z.string().min(1).max(1_000_000))
        .max(50)
        .optional()
        .describe(
          "The workload to optimize. When omitted, the top `limit` statements from pg_stat_statements " +
            "are used instead (and weighted by their call counts).",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("How many statements to pull from pg_stat_statements. Ignored when `statements` is given."),
      schema: identSchema
        .optional()
        .describe("Only recommend indexes on tables in this schema. Candidates elsewhere are dropped."),
      max_candidates: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Cap on candidate indexes considered. Candidates are ranked by table sequential-scan count first."),
      max_explains: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(150)
        .describe(
          "Cap on EXPLAIN round trips spent searching (baseline plans are not counted). The search stops " +
            "when the next candidate would exceed it and reports `budget_exhausted: true`.",
        ),
      max_index_columns: z
        .number()
        .int()
        .min(1)
        .max(6)
        .default(3)
        .describe("Widest candidate index to consider. Every narrower prefix is considered too."),
      max_recommendations: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Stop after this many accepted indexes, even if more would still help."),
      min_improvement: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .describe(
          "Fraction of total weighted workload cost an index must remove to be accepted (0.1 = 10%). " +
            "Relative rather than absolute so it means the same thing on a small and a large database.",
        ),
    }),
    outputSchema: z.object({
      recommendations: z.array(
        z.object({
          table: z.string().describe("`schema.table`, as the planner reported it."),
          columns: z.array(z.string()).describe("Key columns in index order."),
          using: z.string().describe("Access method. Always btree -- see the tool description."),
          create_statement: z.string(),
          create_statement_concurrently: z
            .string()
            .describe("The production form. CONCURRENTLY cannot run inside a transaction block."),
          estimated_size_bytes: z
            .string()
            .nullable()
            .describe("Bigint as a decimal string, from hypopg_relation_size. Null when the estimate failed."),
          workload_cost_before: z.number().describe("Weighted total workload cost before this index."),
          workload_cost_after: z.number(),
          workload_cost_reduction_pct: z.number(),
          requires_skip_scan: z
            .boolean()
            .describe(
              "True when the leading column is never constrained by the workload, so this index relies on " +
                "PostgreSQL 18 skip scan. Never true below PG18, where such candidates are pruned instead.",
            ),
          helps_statements: z.array(
            z.object({
              statement: z.number().int().describe("Index into the top-level `statements` array."),
              cost_before: z.number(),
              cost_after: z.number(),
            }),
          ),
        }),
      ),
      statements: z
        .array(
          z.object({
            sql: z.string().describe("Truncated to 300 characters."),
            calls: z.string().describe("Bigint as a decimal string. '1' for a caller-supplied statement."),
            baseline_cost: z.number().nullable().describe("Null when the statement could not be planned."),
            planned: z.boolean().describe("False when EXPLAIN failed; see `_warnings` for why."),
          }),
        )
        .describe("The workload as analyzed, in the order `helps_statements.statement` indexes into."),
      baseline_workload_cost: z.number().describe("Weighted total estimated cost before any recommendation."),
      final_workload_cost: z.number().describe("Weighted total after applying every recommendation."),
      candidates_considered: z.number().int(),
      candidates_pruned_leading_column: z
        .number()
        .int()
        .describe("Multi-column candidates dropped by the pre-PG18 leading-column rule. Always 0 on PG18+."),
      explains_used: z.number().int().describe("EXPLAIN round trips spent searching, excluding baseline plans."),
      explain_budget: z.number().int(),
      budget_exhausted: z.boolean().describe("True when `max_explains` stopped the search before it converged."),
      skip_scan_available: z.boolean().describe("True on PostgreSQL 18+, where B-tree skip scan exists."),
      _warnings: warningsField,
    }),
    handler: async (input: unknown) => {
      // Zod defaults re-applied in the destructure: direct (non-MCP) callers --
      // unit tests, library consumers -- never run the schema, and an undefined
      // `max_explains` would make the budget comparison NaN, which is false for
      // every operator and would accept every candidate without bound.
      const {
        statements: providedStatements,
        limit = 10,
        schema: schemaFilter,
        max_candidates = 20,
        max_explains = 150,
        max_index_columns = 3,
        max_recommendations = 5,
        min_improvement = 0.1,
      } = input as {
        statements?: string[];
        limit?: number;
        schema?: string;
        max_candidates?: number;
        max_explains?: number;
        max_index_columns?: number;
        max_recommendations?: number;
        min_improvement?: number;
      };

      if (providedStatements !== undefined && providedStatements.length === 0) {
        return {
          ok: false,
          error:
            "`statements` was supplied but empty. Pass at least one statement, or omit `statements` " +
            "entirely to take the top queries from pg_stat_statements.",
        };
      }

      const warnings: string[] = [];
      const serverVersion = await getServerVersionNum();
      const skipScanAvailable = serverVersion >= PG18;

      // Probed before anything else touches a connection: without HypoPG there
      // is no way to cost a candidate, so every later step would be wasted work
      // ending in this same error. Wording mirrors pg_explain's so the fix reads
      // identically wherever the user first hits it.
      const hypopg = await runInternal<{ installed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'hypopg'
         ) AS installed`,
      );
      if (!hypopg.ok) return hypopg;
      if (!hypopg.data?.[0]?.installed) {
        return {
          ok: false,
          error:
            "pg_index_advisor requires the HypoPG extension. Install with " +
            "`CREATE EXTENSION hypopg;` (a superuser-equivalent role usually). " +
            "HypoPG is read-only at the disk level - it lives entirely in shared memory.",
        };
      }

      // ─── Workload ───

      const workload: WorkloadStatement[] = [];
      if (providedStatements) {
        for (const sql of providedStatements) workload.push({ sql, weight: 1, calls: "1" });
      } else {
        const versionRes = await runInternal<{ version: string }>(
          `SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements'`,
        );
        if (!versionRes.ok) return versionRes;
        if (!versionRes.data || versionRes.data.length === 0) {
          return {
            ok: false,
            error:
              "No workload to analyze: pass `statements` explicitly, or install pg_stat_statements with " +
              "`CREATE EXTENSION pg_stat_statements;` (may require superuser) plus `pg_stat_statements` " +
              "in `shared_preload_libraries` and a restart.",
          };
        }
        // Column names changed in pg_stat_statements 1.8 (PostgreSQL 13):
        // total_time became total_exec_time. Same probe pg_top_queries does.
        const extVersion = versionRes.data[0]?.version ?? "0";
        const totalCol = compareVersions(extVersion, "1.8") >= 0 ? "total_exec_time" : "total_time";
        const topRes = await runInternal<{ query: string; calls: string }>(
          `SELECT query, calls::text AS calls
             FROM pg_stat_statements
            WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
              AND calls > 0
            ORDER BY ${totalCol} DESC NULLS LAST
            LIMIT $1`,
          [limit],
        );
        if (!topRes.ok) return topRes;
        for (const row of topRes.data ?? []) {
          // `calls` is reported to the caller as text (lossless), but the WEIGHT
          // is a multiplier on a float cost -- precision past 2^53 is irrelevant
          // to a ranking, and a NaN from a malformed value would poison every
          // total, so it falls back to 1.
          const parsed = Number(row.calls);
          workload.push({
            sql: row.query,
            weight: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
            calls: row.calls ?? "1",
          });
        }
        if (workload.length === 0) {
          return {
            ok: false,
            error:
              "pg_stat_statements is installed but recorded no statements for this database. " +
              "Run the workload first, or pass `statements` explicitly.",
          };
        }
      }

      // Sequential-scan counts order the candidate list when the budget cannot
      // cover everything: the table postgres is reading end-to-end is where an
      // index pays. A failure here costs only ordering quality, so it degrades
      // to a warning rather than failing the tool.
      const seqScans = new Map<string, number>();
      const seqRes = await runInternal<{ schema: string; table: string; seq_scan: string }>(
        `SELECT schemaname AS schema, relname AS table, COALESCE(seq_scan, 0)::text AS seq_scan
           FROM pg_catalog.pg_stat_user_tables`,
      );
      if (seqRes.ok) {
        for (const row of seqRes.data ?? []) {
          const parsed = Number(row.seq_scan);
          seqScans.set(`${row.schema}.${row.table}`, Number.isFinite(parsed) ? parsed : 0);
        }
      } else {
        warnings.push(
          `sequential-scan counts unavailable (${seqRes.error}); candidates are ordered by width alone, ` +
            "so a tight `max_candidates` may drop the candidate that mattered most",
        );
      }

      return withSharedClient(async (run): Promise<ApiResponse> => {
        // BEGIN READ ONLY is defence in depth, not the primary guarantee:
        // EXPLAIN without ANALYZE never executes the statement. But this tool
        // feeds SQL text it did not write (pg_stat_statements entries) back to
        // the server, and the read-only guard is the posture every other tool
        // here takes with caller-influenced SQL.
        const begun = await run("BEGIN READ ONLY");
        if (!begun.ok) return { ok: false, error: begun.error };

        try {
          // A pooled connection can carry hypothetical indexes from an earlier
          // call whose teardown failed (the teardown below is best-effort, and a
          // killed backend never runs it at all). Resetting on the way IN means
          // a leaked index from a previous call cannot silently lower this
          // call's baseline and make every candidate look worthless.
          await run("SELECT hypopg_reset()");

          // ─── Baseline plans ───

          const baselineCosts: (number | null)[] = [];
          const rawPlans: unknown[] = [];
          const needsGenericPlan: boolean[] = [];

          for (const statement of workload) {
            // A `$n` placeholder means the statement cannot be planned without
            // GENERIC_PLAN. Testing the raw text is a heuristic, but it is safe
            // in BOTH directions: a false positive (a `$1` inside a string
            // literal) adds GENERIC_PLAN to a statement that has no parameters,
            // which postgres accepts and plans identically; a false negative
            // fails the EXPLAIN and lands in `_warnings` rather than corrupting
            // a recommendation.
            const parameterized = /\$\d/.test(statement.sql);
            needsGenericPlan.push(parameterized);
            if (parameterized && serverVersion < PG16) {
              baselineCosts.push(null);
              rawPlans.push(undefined);
              warnings.push(
                "skipped a parameterized statement: planning it needs EXPLAIN GENERIC_PLAN " +
                  "(PostgreSQL 16+) and this server is older, so its placeholders cannot be planned " +
                  `without values -- pass the statement in \`statements\` with literals instead: ${preview(statement.sql, 120)}`,
              );
              continue;
            }
            const outcome = await explainStatement(run, statement.sql, parameterized);
            if (!outcome.ok) {
              baselineCosts.push(null);
              rawPlans.push(undefined);
              warnings.push(`could not plan a statement (${outcome.error}): ${preview(statement.sql, 120)}`);
              continue;
            }
            baselineCosts.push(outcome.cost ?? null);
            rawPlans.push(outcome.plan);
          }

          if (baselineCosts.every((c) => c === null)) {
            return {
              ok: false,
              error:
                "No statement in the workload could be planned, so there is nothing to index for. " +
                `Reasons: ${warnings.join(" | ")}`,
            };
          }

          // ─── Relations in play, and their real columns ───

          // Relation names are read back out of the PLANS, not out of the SQL,
          // and every column a candidate can name comes from pg_attribute. That
          // is what bounds the damage the loose tokenizer can do.
          const relationNames = new Set<string>();
          for (const plan of rawPlans) collectRelations(plan, relationNames);
          if (schemaFilter) {
            for (const key of [...relationNames]) {
              if (!key.startsWith(`${schemaFilter}.`)) relationNames.delete(key);
            }
          }
          if (relationNames.size === 0) {
            return {
              ok: false,
              error: schemaFilter
                ? `No table in schema ${JSON.stringify(schemaFilter)} appears in any of the planned statements.`
                : "The planned statements scan no table (only constants, functions, or CTEs), so no index applies.",
            };
          }

          const schemas = [...new Set([...relationNames].map((k) => k.slice(0, k.indexOf("."))))];
          const tables = [...new Set([...relationNames].map((k) => k.slice(k.indexOf(".") + 1)))];

          const colsRes = await run<{
            schema: string;
            table: string;
            column: string;
            n_distinct: number | null;
            reltuples: number | null;
          }>(
            `SELECT n.nspname AS schema,
                    c.relname  AS table,
                    a.attname  AS column,
                    s.n_distinct::float8 AS n_distinct,
                    c.reltuples::float8  AS reltuples
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
               LEFT JOIN pg_catalog.pg_stats s
                      ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
              WHERE c.relkind IN ('r', 'p', 'm')
                AND a.attnum > 0
                AND NOT a.attisdropped
                AND n.nspname = ANY($1)
                AND c.relname = ANY($2)`,
            [schemas, tables],
          );
          if (!colsRes.ok) return { ok: false, error: colsRes.error };

          const knownColumns = new Map<string, Set<string>>();
          const columnStats = new Map<string, Map<string, ColumnStats>>();
          for (const row of colsRes.data ?? []) {
            const key = `${row.schema}.${row.table}`;
            // The two ANY filters form a cross-product, so they can match a
            // table name that exists in a DIFFERENT schema also named above.
            // Only pairs the planner actually reported survive.
            if (!relationNames.has(key)) continue;
            const cols = knownColumns.get(key) ?? new Set<string>();
            cols.add(row.column);
            knownColumns.set(key, cols);

            const stats = columnStats.get(key) ?? new Map<string, ColumnStats>();
            stats.set(row.column, { distinctRatio: normalizeDistinct(row.n_distinct, row.reltuples) });
            columnStats.set(key, stats);
          }

          // Harvested only now, because the real column lists are what keep the
          // over-eager tokenizer from inventing candidates.
          const harvests = rawPlans.map((plan) =>
            plan === undefined ? new Map<string, RelationPredicates>() : harvestPlanPredicates(plan, knownColumns),
          );

          // ─── Existing indexes, so we never recommend one that exists ───

          const existingIndexPrefixes = new Set<string>();
          const idxRes = await run<{ schema: string; table: string; columns: (string | null)[] }>(
            `SELECT n.nspname AS schema,
                    c.relname  AS table,
                    ARRAY(
                      SELECT a.attname
                        FROM unnest(i.indkey[0:i.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, ord)
                        LEFT JOIN pg_catalog.pg_attribute a
                          ON a.attrelid = c.oid AND a.attnum = k.attnum
                       ORDER BY k.ord
                    ) AS columns
               FROM pg_catalog.pg_index i
               JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
               JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_catalog.pg_am am ON am.oid = ic.relam
              WHERE am.amname = 'btree'
                AND i.indisvalid
                AND n.nspname = ANY($1)
                AND c.relname = ANY($2)`,
            [schemas, tables],
          );
          if (idxRes.ok) {
            for (const row of idxRes.data ?? []) {
              const key = `${row.schema}.${row.table}`;
              if (!relationNames.has(key)) continue;
              const columns: string[] = [];
              // An expression index has indkey 0 for the expression position,
              // which the LEFT JOIN renders as null. Stop at the first null
              // rather than skipping it: the columns AFTER an expression are no
              // longer at the key position this prefix claims, so keeping them
              // would block a candidate the index does not actually cover.
              for (const column of row.columns ?? []) {
                if (typeof column !== "string") break;
                columns.push(column);
              }
              // Every PREFIX of an existing key is covered by that index, so
              // each one blocks a candidate.
              for (let width = 1; width <= columns.length; width++) {
                existingIndexPrefixes.add(`${row.schema} ${row.table} ${columns.slice(0, width).join(" ")}`);
              }
            }
          } else {
            warnings.push(
              `existing indexes could not be read (${idxRes.error}); a recommendation may duplicate an ` +
                "index you already have -- check with pg_describe_table before creating it",
            );
          }

          // ─── Candidates ───

          const generated = buildCandidates({
            perStatement: harvests,
            columnStats,
            existingIndexPrefixes,
            seqScans,
            maxIndexColumns: max_index_columns,
          }).filter((c) => schemaFilter === undefined || c.schema === schemaFilter);

          const { kept, pruned } = applySkipScanGate(generated, serverVersion);
          if (pruned.length > 0) {
            warnings.push(
              `${pruned.length} multi-column candidate(s) were pruned because their leading column is ` +
                "never constrained by this workload and this server predates PostgreSQL 18 B-tree skip " +
                "scan, which is what would make such an index usable",
            );
          }
          const candidates = kept.slice(0, max_candidates);
          if (kept.length > candidates.length) {
            warnings.push(
              `${kept.length} candidates were generated but only ${candidates.length} were considered ` +
                "(`max_candidates`); raise it to search wider",
            );
          }

          // ─── Greedy search over HypoPG ───

          const evaluate = async (
            candidate: IndexCandidate,
            statementIndices: number[],
          ): Promise<Map<number, number> | null> => {
            const created = await createHypotheticalIndex(run, candidate);
            if (created === null) return null;
            try {
              const costs = new Map<number, number>();
              for (const index of statementIndices) {
                const statement = workload[index];
                if (!statement || baselineCosts[index] === null) continue;
                const outcome = await explainStatement(run, statement.sql, needsGenericPlan[index] ?? false);
                // A statement that planned at baseline but fails now is not
                // evidence the index hurt -- it is a transient the search must
                // not act on, so its baseline cost stands.
                if (outcome.ok && outcome.cost !== undefined) costs.set(index, outcome.cost);
              }
              return costs;
            } finally {
              // Drop only THIS candidate. A hypopg_reset() here would also wipe
              // every previously accepted index and silently turn the greedy
              // search into an independent per-candidate ranking.
              await run("SELECT hypopg_drop_index($1)", [created]);
            }
          };

          // A statement that could not be planned gets weight 0, so it
          // contributes nothing to any total rather than contributing a 0 cost
          // that would look like a free win.
          const currentCosts = baselineCosts.map((c) => c ?? 0);
          const weights = workload.map((s, i) => (baselineCosts[i] === null ? 0 : s.weight));
          const search = await greedySearch({
            candidates,
            currentCosts,
            weights,
            explainBudget: max_explains,
            minImprovement: min_improvement,
            maxRecommendations: max_recommendations,
            evaluate,
          });

          if (search.budgetExhausted) {
            warnings.push(
              `the search stopped at the \`max_explains\` budget of ${max_explains} EXPLAIN round trips, ` +
                "so these are the best recommendations found so far, not the best available -- raise " +
                "`max_explains` or narrow `statements` to search further",
            );
          }

          // ─── Size the accepted indexes ───

          // Recreated together at the end rather than measured during the
          // search: hypopg_relation_size needs the index to exist, and creating
          // the accepted set as a set also confirms the final recommendation
          // actually co-exists.
          const sizes: (string | null)[] = [];
          for (const entry of search.accepted) {
            const oid = await createHypotheticalIndex(run, entry.candidate);
            if (oid === null) {
              sizes.push(null);
              continue;
            }
            const sizeRes = await run<{ bytes: string }>("SELECT hypopg_relation_size($1)::text AS bytes", [oid]);
            sizes.push(sizeRes.ok ? (sizeRes.data?.[0]?.bytes ?? null) : null);
          }

          const weightedBaseline = baselineCosts.reduce<number>(
            (sum, cost, i) => sum + (cost ?? 0) * (weights[i] ?? 0),
            0,
          );
          const lastAccepted = search.accepted[search.accepted.length - 1];
          const finalCost = lastAccepted ? lastAccepted.costAfter : weightedBaseline;

          const recommendations = search.accepted.map((entry, i) => {
            const reduction =
              entry.costBefore > 0 ? ((entry.costBefore - entry.costAfter) / entry.costBefore) * 100 : 0;
            return {
              table: `${entry.candidate.schema}.${entry.candidate.table}`,
              columns: entry.candidate.columns,
              using: CANDIDATE_ACCESS_METHOD,
              create_statement: renderCreateIndex(entry.candidate, false),
              create_statement_concurrently: renderCreateIndex(entry.candidate, true),
              estimated_size_bytes: sizes[i] ?? null,
              workload_cost_before: round2(entry.costBefore),
              workload_cost_after: round2(entry.costAfter),
              workload_cost_reduction_pct: round2(reduction),
              // Only ever true on PG18+: applySkipScanGate removes exactly these
              // candidates below that, so the field cannot contradict the gate.
              requires_skip_scan: !entry.candidate.leadingConstrained && entry.candidate.columns.length > 1,
              helps_statements: [...entry.perStatement.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([index, costs]) => ({
                  statement: index,
                  cost_before: round2(costs.before),
                  cost_after: round2(costs.after),
                })),
            };
          });

          return {
            ok: true,
            data: {
              recommendations,
              statements: workload.map((statement, i) => ({
                sql: preview(statement.sql),
                calls: statement.calls,
                baseline_cost: baselineCosts[i] === null ? null : round2(baselineCosts[i] ?? 0),
                planned: baselineCosts[i] !== null,
              })),
              baseline_workload_cost: round2(weightedBaseline),
              final_workload_cost: round2(finalCost),
              candidates_considered: candidates.length,
              candidates_pruned_leading_column: pruned.length,
              explains_used: search.explainsUsed,
              explain_budget: max_explains,
              budget_exhausted: search.budgetExhausted,
              skip_scan_available: skipScanAvailable,
              ...(warnings.length > 0 ? { _warnings: warnings } : {}),
            },
          };
        } finally {
          // HypoPG indexes are SESSION-scoped, not transaction-scoped, so the
          // ROLLBACK below does NOT remove them. This connection goes straight
          // back into the pool, and anything left here would silently alter the
          // plan of the next query that borrows it. The reset therefore has to
          // run on every exit -- the success path, an early `return` from any
          // guard above, and a thrown error alike -- which is exactly what
          // `finally` buys that a trailing statement does not.
          //
          // Best-effort, as explain.ts's teardown is: a failure here must never
          // replace the real result or the real error with a cleanup error.
          try {
            await run("SELECT hypopg_reset()");
          } catch {
            // Connection already broken; the pool discards it, which achieves
            // the same isolation the reset was for.
          }
          try {
            await run("ROLLBACK");
          } catch {
            // Already rolled back, or the connection is gone.
          }
        }
      });
    },
  },
] as const;
