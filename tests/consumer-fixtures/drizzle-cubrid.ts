// 1.x compile fixture for cubrid-lab/drizzle-cubrid (#300).
//
// Pinned source: cubrid-lab/drizzle-cubrid `main` at
// 0035410ba87b5fbe0eb3d7f35df003fae1fd68d0 (2026-11-23; npm 0.3.2 is tag v0.3.2,
// 3af52582d9932fa1e5bd03de9591d39c32182c9b). It accepts
// `cubrid-client >=1.4.0 <2.0.0` (peer) and develops against `^1.6.0`.
// docs/CONSUMER_INVENTORY.md lists every call with a file:line link.
//
// The interfaces below are copied from drizzle-cubrid (MIT; comments removed) so
// that this file states exactly what drizzle-cubrid types against. It reaches
// cubrid-client only through these structural interfaces, whose members are
// optional and detected at run time, so a plain assignability check would still
// pass after a method disappeared. Each surface is therefore checked against
// `Required<...>` of the interface, and every call drizzle-cubrid makes through
// it is also made directly on the 1.x types. `npm run typecheck` (source types)
// and `npm run types:packed` (packed ESM and CJS declarations) compile this
// file; nothing here runs. A 1.x change that breaks drizzle-cubrid fails here.

import type {
  CubridClient,
  CubridPool,
  PoolConnection,
  QueryParam,
  QueryResultRow,
} from "../../src/index.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
  TransactionError,
} from "../../src/index.js";

// ----------------------------------------- drizzle-cubrid/legacy: src/session.ts:88-128

type QueryRow = Record<string, unknown>;

interface CubridExecuteResult {
  affectedRows: number;
  lastInsertId?: number | bigint;
}

interface CubridTransactionOptions {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
}

interface CubridQueryable {
  query<T extends QueryRow = QueryRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  query<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly unknown[] | undefined,
    options: { rowMode: "array" },
  ): Promise<T[]>;
  queryPrepared?<T extends QueryRow = QueryRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  queryPrepared?<T extends readonly unknown[] = unknown[]>(
    sql: string,
    params: readonly unknown[] | undefined,
    options: { rowMode: "array" },
  ): Promise<T[]>;
  executePrepared?(sql: string, params?: readonly unknown[]): Promise<CubridExecuteResult>;
  transaction?<T>(
    callback: (tx: CubridQueryable) => Promise<T>,
    options?: CubridTransactionOptions,
  ): Promise<T>;
  execute?(sql: string, params?: readonly unknown[]): Promise<CubridExecuteResult>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

// ------------------------------- drizzle-cubrid (native): src/native/session.ts:80-264

interface CubridArrayRowOptions {
  rowMode: "array";
}

interface CubridAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

interface CubridStreamCallOptions {
  signal?: CubridAbortSignal;
  fetchSize?: number;
  consumerTimeout?: number;
  rowMode: "array";
}

interface CubridDmlResult {
  affectedRows: number;
  lastInsertId?: number | bigint;
}

interface CubridWriteOptions {
  generatedKeys: true;
}

type CubridIsolationLevel = "read committed" | "repeatable read" | "serializable";

interface CubridNativeClient {
  query(
    sql: string,
    params?: readonly unknown[],
    options?: CubridArrayRowOptions,
  ): Promise<unknown[]>;
  queryPrepared?(
    sql: string,
    params?: readonly unknown[],
    options?: CubridArrayRowOptions,
  ): Promise<unknown[]>;
  execute?(
    sql: string,
    params?: readonly unknown[],
    options?: CubridWriteOptions,
  ): Promise<CubridDmlResult>;
  executePrepared?(
    sql: string,
    params?: readonly unknown[],
    options?: CubridWriteOptions,
  ): Promise<CubridDmlResult>;
  stream?(
    sql: string,
    params: readonly unknown[] | undefined,
    options: CubridStreamCallOptions,
  ): AsyncIterable<unknown[]>;
  transaction?<T>(
    callback: (tx: CubridNativeClient) => Promise<T>,
    options?: { isolationLevel?: CubridIsolationLevel },
  ): Promise<T>;
}

// The transaction client `transaction()` hands to its callback, as 1.x types it.
type ClientTx = Parameters<Parameters<CubridClient["transaction"]>[0]>[0];
type PoolTx = Parameters<Parameters<CubridPool["transaction"]>[0]>[0];

// ------------------------------------------------------ which 1.x values are accepted

// drizzle-cubrid/legacy src/driver.ts:147-164: `TClient extends CubridQueryable = CubridClient`.
// The legacy session uses every member when present (src/session.ts:188-225).
export function legacySurfaces(client: CubridClient, pool: CubridPool, conn: PoolConnection) {
  const a: Required<CubridQueryable> = client;
  // A pool and a leased connection have no client-level BEGIN/COMMIT/ROLLBACK;
  // drizzle-cubrid then uses transaction() (src/session.ts:540-600).
  const b: Required<Omit<CubridQueryable, "beginTransaction" | "commit" | "rollback">> = pool;
  const c: CubridQueryable = conn;
  return [a, b, c];
}

// Native src/native/db.ts:205-208: `drizzle<TClient extends CubridNativeClient>(client)`,
// called with a CubridClient (tests/native/dml.test-d.ts:36-37) and a CubridPool
// (tests/native/relational.test-d.ts:11,28; tests/faults.test.ts:279).
export function nativeSurfaces(client: CubridClient, pool: CubridPool, conn: PoolConnection) {
  const a: Required<CubridNativeClient> = client;
  const b: Required<CubridNativeClient> = pool;
  const c: Required<Omit<CubridNativeClient, "transaction">> = conn;
  return [a, b, c];
}

// The callback's `tx` is used as the same interface (src/session.ts:551,
// src/native/session.ts:577). Transaction clients have no nested transaction()
// and no BEGIN; the legacy session commits through the driver, not tx.commit().
export function transactionClients(clientTx: ClientTx, poolTx: PoolTx) {
  const a: Required<Omit<CubridQueryable, "transaction" | "beginTransaction">> = clientTx;
  const b: Required<Omit<CubridQueryable, "transaction" | "beginTransaction">> = poolTx;
  const c: Required<Omit<CubridNativeClient, "transaction">> = clientTx;
  const d: Required<Omit<CubridNativeClient, "transaction">> = poolTx;
  return [a, b, c, d];
}

// ------------------------------------------- the calls drizzle-cubrid makes, made directly

declare const params: QueryParam[];
declare const signal: AbortSignal;

async function statementCalls(db: CubridClient | CubridPool | ClientTx | PoolTx): Promise<void> {
  // src/session.ts:362,530 and src/native/session.ts:456: object rows.
  const rows: QueryResultRow[] = await db.query("SELECT 1", params);
  // src/session.ts:370,518 and src/native/session.ts:456-458: positional rows.
  const arrayRows: unknown[][] = await db.query("SELECT 1", params, { rowMode: "array" });
  const preparedRows: QueryResultRow[] = await db.queryPrepared("SELECT 1", params);
  const preparedArrayRows: unknown[][] = await db.queryPrepared("SELECT 1", params, {
    rowMode: "array",
  });
  // src/session.ts:359,418 and src/native/session.ts:531-541 with src/native/dml.ts:294.
  const literal: CubridDmlResult = await db.execute("DELETE FROM t", params);
  const literalKeys: CubridDmlResult = await db.execute("INSERT INTO t VALUES (?)", params, {
    generatedKeys: true,
  });
  const prepared: CubridDmlResult = await db.executePrepared("DELETE FROM t", params);
  const preparedKeys: CubridDmlResult = await db.executePrepared(
    "INSERT INTO t VALUES (?)",
    params,
    { generatedKeys: true },
  );
  // src/native/session.ts:498-521: `iterator()` positional rows, with the options it
  // forwards (src/native/session.ts:185-188).
  for await (const row of db.stream("SELECT 1", params, {
    rowMode: "array",
    signal,
    fetchSize: 100,
    consumerTimeout: 5000,
  })) {
    const values: readonly unknown[] = row;
    void values;
    break;
  }
  // src/timezone.ts:43 and src/native/timezone.ts:44 read a public string `timezone` first.
  const zone: string = db.timezone;
  void [rows, arrayRows, preparedRows, preparedArrayRows, literal, literalKeys, prepared];
  void [preparedKeys, zone];
}

async function transactionCalls(db: CubridClient | CubridPool): Promise<number> {
  // src/session.ts:570 and src/native/session.ts:591, with and without options;
  // src/native/session.ts:636 asks for 'repeatable read'.
  const a = await db.transaction(async (tx) => {
    await tx.query("SELECT 1", params);
    return 1;
  });
  const b = await db.transaction(async () => 2, { isolationLevel: "repeatable read" });
  return a + b;
}

// src/session.ts:601-632: the deprecated client-level fallback, still called when
// the value has no transaction().
async function clientLevelTransaction(client: CubridClient): Promise<void> {
  await client.beginTransaction();
  await client.commit();
  await client.rollback();
}

// src/native/session.ts:52-77: a TransactionError is recognised with instanceof and
// rebuilt as the error class the same statement has outside a transaction.
function asQueryError(error: unknown): unknown {
  if (!(error instanceof TransactionError)) return error;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key !== "transactionError" && key !== "rollbackError" && key !== "name") {
      details[key] = value;
    }
  }
  const options = { ...details, cause: error.cause };
  const kind = details.kind;
  const converted =
    kind === "unique-violation" || kind === "not-null-violation" || kind === "foreign-key-violation"
      ? new ConstraintError("Query failed.", options)
      : kind === "syntax"
        ? new SqlSyntaxError("Query failed.", options)
        : kind === "deadlock"
          ? new DeadlockError("Query failed.", options)
          : kind === "lock-timeout"
            ? new LockTimeoutError("Query failed.", options)
            : new QueryError("Query failed.", options);
  const base: QueryError = converted;
  return base;
}

export const drizzleCubridCalls = [
  statementCalls,
  transactionCalls,
  clientLevelTransaction,
  asQueryError,
];
