/**
 * Runs tests/jdbc-parity/corpus.json through the public cubrid-client API and
 * returns the same normalized JSON as JdbcRunner.java. Keep the two in step:
 *
 * - integers, BIGINT and integral doubles become decimal text, every other
 *   double the text `f64:` plus its IEEE-754 bits, NUMERIC its decimal text;
 * - bytes become `0x` plus lowercase hex, LOBs their content;
 * - DATE, TIME, DATETIME and TIMESTAMP become wall-clock field text, read with
 *   `timezone: "utc"` on this side and `-Duser.timezone=UTC` on the JDBC side;
 * - collections become arrays, SQL NULL `null`;
 * - a failed statement becomes `{ error: <server error code> }`.
 *
 * Next to each value is its representation (`reps`): the JavaScript type here
 * and the Java class there. compare.ts checks those pairs against the tables
 * in corpus.json, so a type change cannot hide behind equal text.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ColumnInfo, CubridClient, QueryParam, TransactionScope } from "../../src/index.js";
import { createClient } from "../../src/index.js";

export interface ParamSpec {
  t: "int" | "bigint" | "double" | "string" | "null" | "datetime" | "bytes";
  v?: number | string;
}

export interface StepSpec {
  op:
    | "version"
    | "query"
    | "exec"
    | "queryPrepared"
    | "execPrepared"
    | "begin"
    | "commit"
    | "rollback";
  conn?: "a" | "b";
  sql?: string;
  params?: ParamSpec[];
  digest?: boolean;
}

export interface CaseSpec {
  id: string;
  area: string;
  setup?: string[];
  cleanup?: string[];
  steps?: StepSpec[];
  unverified?: string;
  knownLimitation?: Declaration & { issue: string };
  expectedDefect?: Declaration & { issue: string | null };
}

/**
 * A difference recorded in the corpus. `steps` (1-based) limits it to those
 * steps, so a new difference elsewhere in the case is still unexpected.
 */
export interface Declaration {
  reason: string;
  steps?: number[];
}

export interface Corpus {
  representations: {
    equivalent: Array<[string, string]>;
    intentional: Array<{ jdbc: string; ts: string; reason: string }>;
  };
  cases: CaseSpec[];
}

export type Rep = string | Rep[];
export type Normalized = string | null | Normalized[];

export type StepResult =
  | { version: string }
  | { ok: true }
  | { affected: number }
  | { error: number | null; clientError?: string }
  | { columns: string[]; rows: Normalized[][]; reps: Rep[][] }
  | { columns: string[]; count: number; sha256: string; columnReps: string[][] };

export interface CaseResult {
  id: string;
  status: "ran" | "skipped" | "failed";
  failure?: string;
  steps?: StepResult[];
}

export interface RunnerOutput {
  runner: "jdbc" | "ts";
  driverVersion: string;
  serverVersion: string;
  runtime: string;
  cases: CaseResult[];
}

export interface Target {
  host: string;
  port: number;
  database: string;
}

export function loadCorpus(path: string): Corpus {
  return JSON.parse(readFileSync(path, "utf8")) as Corpus;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatDate(d: Date, type: string | undefined): string {
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (type === "DATE") return date;
  if (type === "TIME") return time;
  return `${date} ${time}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function normalizeNumber(n: number): string {
  if (Number.isSafeInteger(n)) return String(n === 0 ? 0 : n);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  return `f64:${view.getBigUint64(0).toString(16).padStart(16, "0")}`;
}

/** `type` is the column's CUBRID type, or the element type inside a collection. */
export function normalize(value: unknown, type: string | undefined): Normalized {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return normalizeNumber(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  if (value instanceof Date) return formatDate(value, type);
  if (Array.isArray(value)) return value.map((element) => normalize(element, type));
  return `unhandled:${String(value)}`;
}

export function rep(value: unknown): Rep {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return ["Array", ...value.map(rep)];
  if (Buffer.isBuffer(value)) return "Buffer";
  if (typeof value === "object") return (value as object).constructor.name;
  return typeof value;
}

function bindValue(p: ParamSpec): QueryParam {
  switch (p.t) {
    case "int":
    case "double":
      return p.v as number;
    case "bigint":
      return BigInt(p.v as string);
    case "string":
      return p.v as string;
    case "null":
      return null;
    case "datetime":
      return new Date(`${(p.v as string).replace(" ", "T")}Z`);
    case "bytes":
      return Buffer.from(p.v as string, "hex");
  }
}

function readRows(
  columns: ColumnInfo[],
  rows: Array<Record<string, unknown>>,
  digest: boolean,
): StepResult {
  const names = columns.map((c) => c.name.toLowerCase());
  const normalized: Normalized[][] = [];
  const reps: Rep[][] = [];
  const sha = createHash("sha256");
  const columnReps = columns.map(() => new Set<string>());
  for (const row of rows) {
    // A repeated column name keeps only its last value in a row object, so the
    // corpus avoids repeated names.
    const values = columns.map((c) => row[c.name]);
    const line = columns.map((c, i) => normalize(values[i], c.elementType ?? c.type));
    if (digest) {
      sha.update(`${JSON.stringify(line)}\n`);
      for (const [i, v] of values.entries()) columnReps[i]?.add(JSON.stringify(rep(v)));
    } else {
      normalized.push(line);
      reps.push(values.map(rep));
    }
  }
  if (digest) {
    return {
      columns: names,
      count: rows.length,
      sha256: sha.digest("hex"),
      columnReps: columnReps.map((set) => [...set].sort()),
    };
  }
  return { columns: names, rows: normalized, reps };
}

interface Session {
  client: CubridClient;
  scope?: TransactionScope | undefined;
}

async function runStep(step: StepSpec, session: Session): Promise<StepResult> {
  const target = session.scope ?? session.client;
  const params = (step.params ?? []).map(bindValue);
  try {
    switch (step.op) {
      case "version":
        return { version: await session.client.getServerVersion() };
      case "begin":
        session.scope = await session.client.beginTransactionScope();
        return { ok: true };
      case "commit":
      case "rollback": {
        const scope = session.scope;
        session.scope = undefined;
        if (!scope) throw new Error(`${step.op} without begin`);
        await (step.op === "commit" ? scope.commit() : scope.rollback());
        return { ok: true };
      }
      case "exec":
        return { affected: (await target.execute(step.sql as string)).affectedRows };
      case "execPrepared":
        return {
          affected: (await target.executePrepared(step.sql as string, params)).affectedRows,
        };
      case "query": {
        const result = await target.queryResult(step.sql as string);
        return readRows(result.columns, result.rows, step.digest === true);
      }
      case "queryPrepared": {
        const result = await target.queryResultPrepared(step.sql as string, params);
        return readRows(result.columns, result.rows, step.digest === true);
      }
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return { error: code };
    return { error: null, clientError: String((error as Error).message) };
  }
}

async function runCase(spec: CaseSpec, a: Session, b: Session): Promise<CaseResult> {
  if (spec.unverified !== undefined) return { id: spec.id, status: "skipped" };
  const steps: StepResult[] = [];
  try {
    for (const sql of spec.setup ?? []) await a.client.execute(sql);
    for (const step of spec.steps ?? []) {
      steps.push(await runStep(step, step.conn === "b" ? b : a));
    }
    return { id: spec.id, status: "ran", steps };
  } catch (error) {
    return { id: spec.id, status: "failed", failure: String(error), steps };
  } finally {
    if (a.scope) {
      await a.scope.rollback().catch(() => {});
      a.scope = undefined;
    }
    for (const sql of spec.cleanup ?? []) {
      await a.client.execute(sql).catch(() => {});
    }
  }
}

export async function runTs(corpus: Corpus, target: Target): Promise<RunnerOutput> {
  const options = { ...target, user: "dba", password: "", timezone: "utc" as const };
  const a: Session = { client: createClient(options) };
  const b: Session = { client: createClient(options) };
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  try {
    const serverVersion = await a.client.getServerVersion();
    const cases: CaseResult[] = [];
    for (const spec of corpus.cases) {
      const started = Date.now();
      cases.push(await runCase(spec, a, b));
      process.stderr.write(
        `ts   ${spec.id.padEnd(40)} ${String(Date.now() - started).padStart(6)} ms\n`,
      );
    }
    return {
      runner: "ts",
      driverVersion: `cubrid-client ${pkg.version}`,
      serverVersion,
      runtime: `Node.js ${process.version}`,
      cases,
    };
  } finally {
    await Promise.allSettled([a.client.close(), b.client.close()]);
  }
}
