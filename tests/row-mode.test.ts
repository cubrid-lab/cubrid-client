/**
 * rowMode: "array" on the client, pool and transaction surfaces (#255), offline.
 * The decoding itself is covered in protocol.test.ts and native-adapter.test.ts;
 * this file covers the option plumbing, the check of custom connections, and the
 * public typings, which `npm run typecheck` compiles.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NativeCubridAdapter } from "../src/adapters/native.js";
import type { CubridClient } from "../src/client/client.js";
import { createClient } from "../src/client/create-client.js";
import { type CubridPool, createPool } from "../src/client/pool.js";
import { CubridTransaction } from "../src/client/transaction.js";
import { QueryError } from "../src/errors/query-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import type {
  ArrayRowOptions,
  ConnectionLike,
  Queryable,
  QueryOptions,
  ResultTransactionClient,
  Streamable,
  StreamOptions,
  TransactionClient,
  TransactionScope,
} from "../src/types/client.js";
import type { PoolConnection } from "../src/types/pool.js";
import type { QueryParams } from "../src/types/query.js";
import type { ArrayQueryResult, QueryResult, QueryResultRow } from "../src/types/result.js";

/** A custom connection that returns `rows` for every query and records the options. */
class RowsConnection implements ConnectionLike {
  options: Array<{ rowMode?: unknown } | undefined> = [];

  constructor(private readonly rows: unknown[]) {}

  async connect(): Promise<void> {}

  async query<T extends QueryResultRow = QueryResultRow>(
    _sql: string,
    _params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    this.options.push(options as { rowMode?: unknown } | undefined);
    return this.rows as T[];
  }

  async queryResult<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return { rows: await this.query<T>(sql, params, options), columns: [] };
  }

  async queryPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    _params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.query<T>(sql, undefined, options);
  }

  async queryResultPrepared<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    _params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.queryResult<T>(sql, undefined, options);
  }

  async *stream<T extends QueryResultRow = QueryResultRow>(
    _sql: string,
    _params?: QueryParams,
    options?: StreamOptions,
  ): AsyncGenerator<T, void, undefined> {
    this.options.push(options as { rowMode?: unknown } | undefined);
    for (const row of this.rows) {
      yield row as T;
    }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async close(): Promise<void> {}
}

const ARRAY: ArrayRowOptions = { rowMode: "array" };

function clientOver(connection: ConnectionLike): CubridClient {
  return createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: () => connection,
  });
}

function poolOver(connection: ConnectionLike): CubridPool {
  return createPool({
    host: "localhost",
    database: "demodb",
    user: "dba",
    max: 1,
    connectionFactory: () => connection,
  });
}

/** A QueryError, or a TransactionError inside a transaction, as for any failed statement. */
function refusedArrays(error: unknown): boolean {
  assert.ok(error instanceof QueryError || error instanceof TransactionError);
  assert.equal(
    (error.cause as Error).message,
    'Underlying connection does not support rowMode "array".',
  );
  return true;
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const row of rows) {
    all.push(row);
  }
  return all;
}

test("rowMode reaches a custom connection, which may return arrays", async () => {
  const connection = new RowsConnection([[1, 2]]);
  const client = clientOver(connection);

  assert.deepEqual(await client.query("SELECT a.id, b.id", undefined, ARRAY), [[1, 2]]);
  assert.deepEqual(await client.queryResult("SELECT 1", [], ARRAY), {
    rows: [[1, 2]],
    columns: [],
  });
  assert.deepEqual(await client.queryPrepared("SELECT 1", [], ARRAY), [[1, 2]]);
  assert.deepEqual((await client.queryResultPrepared("SELECT 1", [], ARRAY)).rows, [[1, 2]]);
  assert.deepEqual(await collect(client.stream("SELECT 1", undefined, ARRAY)), [[1, 2]]);
  assert.ok(connection.options.every((options) => options?.rowMode === "array"));
  await client.close();
});

test("rowMode array: a custom connection that returns objects is refused, on every surface", async () => {
  const connection = new RowsConnection([{ id: 2 }]);
  const client = clientOver(connection);
  const pool = poolOver(connection);

  for (const target of [client, pool]) {
    await assert.rejects(target.query("SELECT 1", undefined, ARRAY), refusedArrays);
    await assert.rejects(target.queryResult("SELECT 1", undefined, ARRAY), refusedArrays);
    await assert.rejects(target.queryPrepared("SELECT 1", undefined, ARRAY), refusedArrays);
    await assert.rejects(target.queryResultPrepared("SELECT 1", undefined, ARRAY), refusedArrays);
    await assert.rejects(collect(target.stream("SELECT 1", undefined, ARRAY)), refusedArrays);
    // Object mode is untouched by the check.
    assert.deepEqual(await target.query("SELECT 1"), [{ id: 2 }]);
  }

  await pool.connection(async (leased) => {
    await assert.rejects(leased.query("SELECT 1", undefined, ARRAY), refusedArrays);
    await assert.rejects(collect(leased.stream("SELECT 1", undefined, ARRAY)), refusedArrays);
  });
  await client.transaction(async (tx) => {
    await assert.rejects(tx.query("SELECT 1", undefined, ARRAY), refusedArrays);
    await assert.rejects(tx.queryResultPrepared("SELECT 1", undefined, ARRAY), refusedArrays);
  });
  const scope = await client.beginTransactionScope();
  await assert.rejects(scope.queryResult("SELECT 1", undefined, ARRAY), refusedArrays);
  await scope.rollback();
  const transaction = new CubridTransaction(connection);
  await assert.rejects(transaction.queryPrepared("SELECT 1", undefined, ARRAY), refusedArrays);

  await pool.close();
  await client.close();
});

test("rowMode array: no rows cannot be wrong, so an empty result passes", async () => {
  const client = clientOver(new RowsConnection([]));

  assert.deepEqual(await client.query("SELECT 1", undefined, ARRAY), []);
  assert.deepEqual(await collect(client.stream("SELECT 1", undefined, ARRAY)), []);
  await client.close();
});

test("an invalid rowMode rejects before the connection is used", async () => {
  const connection = new RowsConnection([[1]]);
  const client = clientOver(connection);
  const invalid = { rowMode: "arrays" } as unknown as ArrayRowOptions;

  await assert.rejects(client.query("SELECT 1", undefined, invalid), TypeError);
  await assert.rejects(client.queryResultPrepared("SELECT 1", undefined, invalid), TypeError);
  assert.throws(() => client.stream("SELECT 1", undefined, invalid), TypeError);
  await client.transaction(async (tx) => {
    await assert.rejects(tx.query("SELECT 1", undefined, invalid), TypeError);
  });
  assert.deepEqual(connection.options, []);
  await client.close();
});

// ---------------------------------------------------------------------------
// Compile-time checks. Never run: `npm run typecheck` compiles them.
// ---------------------------------------------------------------------------

type Equal<A, B> =
  (<V>() => V extends A ? 1 : 2) extends <V>() => V extends B ? 1 : 2 ? true : false;
function expectType<T>(_value: T): void {}
function assertEqual<_ extends true>(): void {}

type Row = { id: number };

export async function typings(
  client: CubridClient,
  pool: CubridPool,
  leased: PoolConnection,
  scope: TransactionScope,
  either: CubridClient | TransactionClient,
  queryable: CubridClient | Queryable,
  scopeOrTx: TransactionScope | ResultTransactionClient,
  poolOrLeased: CubridPool | PoolConnection,
  streamable: CubridClient | Streamable,
  connection: NativeCubridAdapter | ConnectionLike,
  options: QueryOptions,
  wide: QueryOptions & { rowMode?: "object" | "array" },
): Promise<void> {
  // Array mode: arrays by default, tuples when asked for.
  const rows = await client.query("SELECT 1", undefined, { rowMode: "array" });
  assertEqual<Equal<typeof rows, unknown[][]>>();
  const tuples = await pool.query<[number, string | null]>("SELECT 1", [], { rowMode: "array" });
  assertEqual<Equal<typeof tuples, [number, string | null][]>>();
  const readonlyTuples = await client.queryPrepared<readonly [number]>("SELECT 1", [], {
    rowMode: "array",
  });
  assertEqual<Equal<typeof readonlyTuples, (readonly [number])[]>>();
  const result = await scope.queryResult("SELECT 1", undefined, { rowMode: "array" });
  assertEqual<Equal<typeof result, ArrayQueryResult<unknown[]>>>();
  const prepared = await leased.queryResultPrepared("SELECT 1", [], {
    rowMode: "array",
    signal: AbortSignal.timeout(1),
  });
  assertEqual<Equal<typeof prepared, ArrayQueryResult<unknown[]>>>();
  for await (const row of client.stream("SELECT 1", undefined, { rowMode: "array" })) {
    assertEqual<Equal<typeof row, unknown[]>>();
  }
  for await (const row of leased.stream<[number]>("SELECT 1", undefined, { rowMode: "array" })) {
    assertEqual<Equal<typeof row, [number]>>();
  }
  await client.transaction(async (tx) => {
    // ArrayRowQueryable comes first, so a typed options variable is honoured.
    const inTx = await tx.queryResultPrepared("SELECT 1", [], ARRAY);
    assertEqual<Equal<typeof inTx, ArrayQueryResult<unknown[]>>>();
    const objects = await tx.query<Row>("SELECT 1");
    assertEqual<Equal<typeof objects, Row[]>>();
  });
  await pool.transaction(async (tx) => {
    expectType<unknown[][]>(await tx.query("SELECT 1", undefined, ARRAY));
  });
  // A 1.x callback typed with an older interface is still accepted.
  await client.transaction(async (tx: TransactionClient) => tx.query("SELECT 1"));

  // Object mode and 1.x call sites resolve as before.
  const objects = await client.query<Row>("SELECT 1");
  assertEqual<Equal<typeof objects, Row[]>>();
  const withOptions = await client.queryResult("SELECT 1", [], options);
  assertEqual<Equal<typeof withOptions, QueryResult<QueryResultRow>>>();
  expectType<Row[]>(await client.query<Row>("SELECT 1", [], { signal: AbortSignal.timeout(1) }));
  const asQueryable: Queryable = client;
  const asTransaction: TransactionClient = new CubridTransaction({} as ConnectionLike);
  expectType<Queryable>(asQueryable);
  expectType<TransactionClient>(asTransaction);

  // Unions with the interfaces users implement stay callable, in object mode.
  expectType<Row[]>(await either.query<Row>("SELECT 1"));
  expectType<QueryResultRow[]>(await queryable.query("SELECT 1", [], options));
  expectType<QueryResult<Row>>(await scopeOrTx.queryResult<Row>("SELECT 1"));
  expectType<AsyncIterable<QueryResultRow>>(poolOrLeased.stream("SELECT 1"));
  expectType<QueryResultRow[]>(await poolOrLeased.queryPrepared("SELECT 1", []));
  expectType<AsyncIterable<Row>>(streamable.stream<Row>("SELECT 1"));
  expectType<QueryResultRow[]>(await connection.query("SELECT 1"));

  // @ts-expect-error A row type of objects cannot have array rows.
  await client.query<Row>("SELECT 1", undefined, { rowMode: "array" });
  // @ts-expect-error execute() returns no rows, so it has no rowMode.
  await client.execute("INSERT INTO t VALUES (1)", undefined, { rowMode: "array" });
  // @ts-expect-error executeMany() returns no rows either.
  await pool.executeMany("INSERT INTO t VALUES (?)", [[1]], { rowMode: "array" });
  const widened = { rowMode: "array" };
  // @ts-expect-error A widened `string` is not "array".
  await client.query("SELECT 1", undefined, widened);
  // @ts-expect-error Array mode is not offered through an interface users implement.
  await either.query("SELECT 1", undefined, { rowMode: "array" });
  // Known limitations: a variable typed with both modes, or an untyped one whose
  // rowMode widened to string beside another option, matches the object overload.
  expectType<QueryResultRow[]>(await client.query("SELECT 1", undefined, wide));
  const widenedWithOption = { rowMode: "array", readTimeout: 5000 };
  expectType<QueryResultRow[]>(await client.query("SELECT 1", undefined, widenedWithOption));
}
