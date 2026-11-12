import assert from "node:assert/strict";
import test from "node:test";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { CubridClient } from "../src/client/client.js";
import { createClient } from "../src/client/create-client.js";
import { CubridTransaction } from "../src/client/transaction.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import {
  CasReplyError,
  ConnectionLostError,
  ExecuteManyError,
} from "../src/errors/internal-errors.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
} from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import { mapError } from "../src/internals/map-error.js";
import { normalizeConfig } from "../src/internals/normalize-config.js";
import { MalformedReplyError, UnsupportedValueError } from "../src/protocol/protocol.js";
import type {
  BatchTransactionClient,
  ClientOptions,
  ConnectionLike,
  ExecuteManyResult,
  ExecuteResult,
  PreparedTransactionClient,
  QueryOptions,
  TransactionClient,
  TransactionOptions,
} from "../src/types/client.js";
import type { QueryParams } from "../src/types/query.js";
import type { QueryResult, QueryResultRow } from "../src/types/result.js";

class FakeConnection implements ConnectionLike {
  queries: Array<{ sql: string; params: QueryParams | undefined }> = [];
  beginCalls = 0;
  commitCalls = 0;
  rollbackCalls = 0;
  closeCalls = 0;
  nextRows: Array<Record<string, unknown>> = [];
  queryError?: Error;
  beginError?: Error;
  commitError?: Error;
  rollbackError?: Error;
  closeError?: Error;
  ping?: () => Promise<string>;

  async connect(): Promise<void> {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    this.queries.push({ sql, params });

    if (this.queryError) {
      throw this.queryError;
    }

    return this.nextRows as T[];
  }

  async beginTransaction(): Promise<void> {
    this.beginCalls += 1;

    if (this.beginError) {
      throw this.beginError;
    }
  }

  async commit(): Promise<void> {
    this.commitCalls += 1;

    if (this.commitError) {
      throw this.commitError;
    }
  }

  async rollback(): Promise<void> {
    this.rollbackCalls += 1;

    if (this.rollbackError) {
      throw this.rollbackError;
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;

    if (this.closeError) {
      throw this.closeError;
    }
  }
}

function baseOptions(overrides: Partial<ClientOptions> = {}): ClientOptions {
  return {
    host: "localhost",
    database: "demodb",
    user: "dba",
    ...overrides,
  };
}

test("normalizeConfig applies default values", () => {
  assert.deepEqual(normalizeConfig(baseOptions()), {
    host: "localhost",
    port: 33000,
    database: "demodb",
    user: "dba",
    password: "",
    connectionTimeout: undefined,
    maxConnectionRetryCount: undefined,
    ssl: undefined,
    logger: undefined,
  });
});

test("normalizeConfig keeps a valid readTimeout", () => {
  assert.equal(normalizeConfig({ ...baseOptions(), readTimeout: 2500 }).readTimeout, 2500);
  assert.equal(normalizeConfig({ ...baseOptions(), readTimeout: 0 }).readTimeout, 0);
});

test("normalizeConfig keeps a valid maxLobBytes and adds none by default", () => {
  assert.equal(normalizeConfig({ ...baseOptions(), maxLobBytes: 1024 }).maxLobBytes, 1024);
  assert.ok(!("maxLobBytes" in normalizeConfig(baseOptions())));
});

// #252: the broker keeps 31 bytes of each OpenDatabase field and stops at a NUL.
for (const field of ["database", "user", "password"] as const) {
  test(`normalizeConfig keeps a 31-byte ${field}, also when multibyte`, () => {
    for (const value of ["x".repeat(31), `${"\u00e9".repeat(15)}a`, `x${"\uac00".repeat(10)}`]) {
      assert.equal(Buffer.byteLength(value), 31);
      assert.equal(normalizeConfig(baseOptions({ [field]: value }))[field], value);
    }
  });

  for (const [label, value] of [
    ["32-byte", "s".repeat(32)],
    ["33-byte", "s".repeat(33)],
    ["32-byte multibyte (16 characters)", "\u00e9".repeat(16)],
    ["33-byte multibyte (31 bytes cut mid-character)", `${"s".repeat(30)}\uac00`],
    ["long", "s".repeat(200)],
  ] as const) {
    test(`createClient rejects a ${label} ${field}, naming the field and limit but not the value`, () => {
      assert.throws(
        () => createClient(baseOptions({ [field]: value })),
        (error: unknown) => {
          assert.ok(error instanceof RangeError);
          assert.equal(error.message, `${field} must be at most 31 bytes in UTF-8.`);
          assert.ok(!error.message.includes("sss"));
          assert.ok(!error.message.includes("\u00e9"));
          return true;
        },
      );
    });
  }

  test(`createClient rejects a ${field} with an embedded NUL`, () => {
    assert.throws(() => createClient(baseOptions({ [field]: "se\0cret" })), {
      name: "RangeError",
      message: `${field} must not contain a NUL character.`,
    });
  });
}

test("createClient checks credentials before the connection factory is reached", () => {
  let created = 0;
  assert.throws(
    () =>
      createClient(
        baseOptions({
          password: "p".repeat(32),
          connectionFactory: () => {
            created += 1;
            return new FakeConnection();
          },
        }),
      ),
    RangeError,
  );
  assert.equal(created, 0);
});

test("normalizeConfig keeps a valid fetchSize and adds none by default", () => {
  assert.equal(normalizeConfig({ ...baseOptions(), fetchSize: 500 }).fetchSize, 500);
  assert.ok(!("fetchSize" in normalizeConfig(baseOptions())));
});

for (const fetchSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
  test(`createClient and stream() reject fetchSize ${fetchSize}`, () => {
    assert.throws(() => createClient({ ...baseOptions(), fetchSize }), RangeError);
    const client = createClient(baseOptions({ connectionFactory: () => new FakeConnection() }));
    assert.throws(() => client.stream("SELECT 1", undefined, { fetchSize }), RangeError);
  });
}

for (const consumerTimeout of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
  test(`stream() rejects consumerTimeout ${consumerTimeout}`, () => {
    const client = createClient(baseOptions({ connectionFactory: () => new FakeConnection() }));
    assert.throws(() => client.stream("SELECT 1", undefined, { consumerTimeout }), RangeError);
  });
}

for (const maxLobBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
  test(`createClient rejects maxLobBytes ${maxLobBytes}`, () => {
    assert.throws(() => createClient({ ...baseOptions(), maxLobBytes }), RangeError);
  });
}

test("normalizeConfig keeps a valid maxReplyBytes and adds none by default (#251)", () => {
  for (const maxReplyBytes of [1024 * 1024, 2 ** 31 - 1]) {
    assert.equal(normalizeConfig({ ...baseOptions(), maxReplyBytes }).maxReplyBytes, maxReplyBytes);
  }
  assert.ok(!("maxReplyBytes" in normalizeConfig(baseOptions())));
});

for (const maxReplyBytes of [
  0,
  -1,
  1024 * 1024 - 1,
  2 ** 31,
  1.5 * 1024 * 1024 + 0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
]) {
  test(`createClient and the adapter reject maxReplyBytes ${maxReplyBytes} (#251)`, () => {
    assert.throws(() => createClient({ ...baseOptions(), maxReplyBytes }), {
      name: "RangeError",
      message: "maxReplyBytes must be an integer from 1048576 to 2147483647 bytes.",
    });
    assert.throws(
      () => new NativeCubridAdapter({ ...baseOptions(), port: 33000, password: "", maxReplyBytes }),
      RangeError,
    );
  });
}

for (const readTimeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
  test(`createClient rejects readTimeout ${readTimeout}`, () => {
    assert.throws(() => createClient({ ...baseOptions(), readTimeout }), RangeError);
  });
}

test("normalizeConfig keeps a valid maxConnectionRetryCount", () => {
  assert.equal(
    normalizeConfig({ ...baseOptions(), maxConnectionRetryCount: 3 }).maxConnectionRetryCount,
    3,
  );
  assert.equal(
    normalizeConfig({ ...baseOptions(), maxConnectionRetryCount: 0 }).maxConnectionRetryCount,
    0,
  );
});

for (const maxConnectionRetryCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`createClient rejects maxConnectionRetryCount ${maxConnectionRetryCount}`, () => {
    assert.throws(() => createClient({ ...baseOptions(), maxConnectionRetryCount }), RangeError);
  });
}

test("ReadTimeoutError is a ConnectionError and survives every mapError kind", () => {
  const timeout = new ReadTimeoutError(250);

  assert.ok(timeout instanceof ConnectionError);
  assert.equal(timeout.name, "ReadTimeoutError");
  assert.equal(timeout.timeoutMs, 250);
  for (const kind of ["connection", "query", "transaction"] as const) {
    assert.equal(mapError(kind, timeout, "wrapped"), timeout);
  }
});

test("mapError returns package-owned error classes", () => {
  assert.ok(mapError("connection", new Error("x"), "a") instanceof ConnectionError);
  assert.ok(mapError("query", new Error("x"), "a") instanceof QueryError);
  assert.ok(mapError("transaction", "x", "a") instanceof TransactionError);
});

test("createClient returns a CubridClient instance", () => {
  const client = createClient(baseOptions());
  assert.ok(client instanceof CubridClient);
});

test("client query returns typed rows from the shared connection", async () => {
  const connection = new FakeConnection();
  connection.nextRows = [{ id: 1, name: "Alice" }];
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  const rows = await client.query<{ id: number; name: string }>("SELECT id, name FROM users");

  assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
  assert.equal(connection.queries.length, 1);
});

test("client query maps connection errors to QueryError", async () => {
  const connection = new FakeConnection();
  connection.queryError = new Error("broken");
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await assert.rejects(
    client.query("SELECT 1"),
    (error: unknown) =>
      error instanceof QueryError &&
      error.cause instanceof Error &&
      error.cause.message === "broken",
  );
});

test("client retries connection after initial factory failure", async () => {
  let attempts = 0;
  const connection = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first connect failed");
        return connection;
      },
    }),
  );

  await assert.rejects(client.query("SELECT 1"), (error: unknown) => error instanceof QueryError);

  connection.nextRows = [{ id: 1 }];
  const rows = await client.query("SELECT 1");
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(attempts, 2);
});

test("transaction commits on success and closes the dedicated connection", async () => {
  const transactional = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => transactional,
    }),
  );

  const result = await client.transaction(async (tx) => {
    await tx.query("INSERT INTO users (name) VALUES (?)", ["Alice"]);
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(transactional.beginCalls, 1);
  assert.equal(transactional.commitCalls, 1);
  assert.equal(transactional.rollbackCalls, 0);
  assert.equal(transactional.closeCalls, 1);
});

test("scoped transaction keeps an unrelated concurrent query off its physical session", async () => {
  const shared = new FakeConnection();
  const scoped = new FakeConnection();
  let connectionsCreated = 0;
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        connectionsCreated += 1;
        return connectionsCreated === 1 ? shared : scoped;
      },
    }),
  );

  // Bind the ordinary API to its shared connection before starting a callback
  // transaction. The scoped callback must receive a different connection.
  await client.query("SELECT shared before");
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseTransaction!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });

  const work = client.transaction(async (tx) => {
    await tx.query("INSERT INTO ledger VALUES (1)");
    signalEntered();
    await hold;
    await tx.query("INSERT INTO ledger VALUES (2)");
  });

  await entered;
  try {
    // This is a separate caller using the regular client during the
    // transaction. Its query must not execute on the scoped connection.
    await client.query("SELECT unrelated while transaction is open");
    assert.deepEqual(
      shared.queries.map(({ sql }) => sql),
      ["SELECT shared before", "SELECT unrelated while transaction is open"],
    );
    assert.deepEqual(
      scoped.queries.map(({ sql }) => sql),
      ["INSERT INTO ledger VALUES (1)"],
    );
    assert.equal(shared.beginCalls, 0);
    assert.equal(shared.commitCalls, 0);
    assert.equal(scoped.beginCalls, 1);
    assert.equal(scoped.commitCalls, 0);
  } finally {
    releaseTransaction();
  }

  await work;
  assert.deepEqual(
    scoped.queries.map(({ sql }) => sql),
    ["INSERT INTO ledger VALUES (1)", "INSERT INTO ledger VALUES (2)"],
  );
  assert.equal(scoped.commitCalls, 1);
  assert.equal(scoped.closeCalls, 1);
  assert.equal(connectionsCreated, 2);
  await client.close();
});

test("transaction wraps callback failures in TransactionError", async () => {
  const connection = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await assert.rejects(
    client.transaction(async () => {
      throw new Error("boom");
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "boom",
  );

  assert.equal(connection.rollbackCalls, 1);
  assert.equal(connection.closeCalls, 1);
});

test("transaction rollback failure does not hide the original error", async () => {
  const connection = new FakeConnection();
  connection.rollbackError = new Error("rollback");
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await assert.rejects(
    client.transaction(async () => {
      throw new Error("original");
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "original",
  );
});

// ---------------------------------------------------------------------------
// transaction() callback lifecycle: one terminal outcome, nothing after it
// ---------------------------------------------------------------------------

/** Records the order of connection calls, which the counters above cannot show. */
class RecordingConnection extends FakeConnection {
  calls: string[] = [];
  releaseQuery: (() => void) | undefined;
  queryGate: Promise<void> | undefined;

  holdQueries(): void {
    this.queryGate = new Promise((resolve) => {
      this.releaseQuery = resolve;
    });
  }

  override async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    this.calls.push(`query:${sql}`);
    await this.queryGate;
    this.calls.push(`queried:${sql}`);
    return super.query<T>(sql, params);
  }

  override async beginTransaction(): Promise<void> {
    this.calls.push("begin");
    return super.beginTransaction();
  }

  override async commit(): Promise<void> {
    this.calls.push("commit");
    return super.commit();
  }

  override async rollback(): Promise<void> {
    this.calls.push("rollback");
    return super.rollback();
  }

  override async close(): Promise<void> {
    this.calls.push("close");
    return super.close();
  }
}

function transactionClient(connection: ConnectionLike) {
  return createClient(baseOptions({ connectionFactory: () => connection }));
}

function rejectsWith(message: string) {
  return (error: unknown) => error instanceof TransactionError && error.message === message;
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Node reports an unhandled rejection after the microtask queue drains. */
async function collectUnhandledRejections(run: () => Promise<void>) {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);

  try {
    await run();
    await macrotask();
    await macrotask();
  } finally {
    process.off("unhandledRejection", record);
  }

  return { unhandled };
}

const ALREADY_COMMITTED = "Transaction has already been committed.";
const ALREADY_ROLLED_BACK = "Transaction has already been rolled back.";
const ALREADY_COMPLETING = "Transaction is already completing.";
const ALREADY_FAILED = "Transaction has already failed.";

test("transaction hands the callback a CubridTransaction and commits before closing", async () => {
  const connection = new RecordingConnection();

  await transactionClient(connection).transaction(async (tx) => {
    assert.ok(tx instanceof CubridTransaction);
    await tx.query("INSERT");
  });

  assert.deepEqual(connection.calls, [
    "begin",
    "query:INSERT",
    "queried:INSERT",
    "commit",
    "close",
  ]);
});

test("transaction connection factory failure propagates before anything can be closed", async () => {
  const failure = new Error("factory");
  const client = createClient(
    baseOptions({
      connectionFactory: () => Promise.reject(failure),
    }),
  );

  await assert.rejects(
    client.transaction(async () => "unused"),
    (error: unknown) => error === failure,
  );
});

test("transaction begin failure skips the callback and any completion", async () => {
  const connection = new RecordingConnection();
  connection.beginError = new Error("begin");
  let callbackCalls = 0;

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      callbackCalls += 1;
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.message === "Transaction failed." &&
      error.cause === connection.beginError &&
      error.rollbackError === undefined &&
      error.closeError === undefined,
  );

  assert.equal(callbackCalls, 0);
  assert.deepEqual(connection.calls, ["begin", "close"]);
});

test("transaction begin failure survives a close failure", async () => {
  const connection = new FakeConnection();
  connection.beginError = new Error("begin");
  connection.closeError = new Error("close");

  await assert.rejects(
    transactionClient(connection).transaction(async () => "unused"),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === connection.beginError &&
      error.closeError === connection.closeError,
  );
});

test("transaction callback that throws synchronously still rolls back once", async () => {
  const connection = new RecordingConnection();
  const failure = new Error("sync");

  await assert.rejects(
    transactionClient(connection).transaction(() => {
      throw failure;
    }),
    (error: unknown) => error instanceof TransactionError && error.cause === failure,
  );

  assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
});

test("transaction keeps the callback error as cause when rollback fails too", async () => {
  const connection = new FakeConnection();
  connection.rollbackError = new Error("rollback");
  const failure = new Error("original");

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw failure;
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === failure &&
      error.rollbackError === connection.rollbackError &&
      error.closeError === undefined,
  );

  assert.equal(connection.rollbackCalls, 1);
  assert.equal(connection.closeCalls, 1);
});

test("transaction keeps the callback error as cause when close fails too", async () => {
  const connection = new FakeConnection();
  connection.closeError = new Error("close");
  const failure = new Error("original");

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw failure;
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === failure &&
      error.rollbackError === undefined &&
      error.closeError === connection.closeError,
  );

  assert.equal(connection.closeCalls, 1);
});

test("transaction reports every failure when callback, rollback and close all fail", async () => {
  const connection = new FakeConnection();
  connection.rollbackError = new Error("rollback");
  connection.closeError = new Error("close");
  const failure = new Error("original");

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw failure;
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === failure &&
      error.rollbackError === connection.rollbackError &&
      error.closeError === connection.closeError,
  );
});

test("transaction turns non-Error rollback and close rejections into Errors", async () => {
  const connection = new FakeConnection();
  connection.rollback = () => Promise.reject("rollback text");
  connection.close = () => Promise.reject("close text");

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw new Error("original");
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.rollbackError?.message === "rollback text" &&
      error.closeError?.message === "close text",
  );
});

test("transaction keeps a server error's details alongside its cleanup failures", async () => {
  const connection = new FakeConnection();
  connection.queryError = new QueryError("deadlock", {
    code: -72,
    origin: "server",
    kind: "deadlock",
  });
  connection.rollbackError = new Error("rollback");
  connection.closeError = new Error("close");

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      await tx.query("UPDATE");
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.message === "Transaction failed." &&
      error.code === -72 &&
      error.origin === "server" &&
      error.kind === "deadlock" &&
      error.rollbackError === connection.rollbackError &&
      error.closeError === connection.closeError,
  );
});

test("transaction rethrows a ReadTimeoutError unchanged when cleanup also fails", async () => {
  const connection = new FakeConnection();
  connection.rollbackError = new Error("rollback");
  connection.closeError = new Error("close");
  const timeout = new ReadTimeoutError(50);
  const ownProperties = Object.keys(timeout);

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw timeout;
    }),
    (error: unknown) => error === timeout,
  );

  assert.deepEqual(Object.keys(timeout), ownProperties);
  assert.equal(connection.rollbackCalls, 1);
  assert.equal(connection.closeCalls, 1);
});

test("transaction rolls back once after the automatic commit fails", async () => {
  const connection = new RecordingConnection();
  connection.commitError = new Error("commit");

  await assert.rejects(
    transactionClient(connection).transaction(async () => "lost"),
    (error: unknown) => error instanceof TransactionError && error.cause === connection.commitError,
  );

  assert.deepEqual(connection.calls, ["begin", "commit", "rollback", "close"]);
});

test("transaction reports commit, rollback and close failures together", async () => {
  const connection = new FakeConnection();
  connection.commitError = new Error("commit");
  connection.rollbackError = new Error("rollback");
  connection.closeError = new Error("close");

  await assert.rejects(
    transactionClient(connection).transaction(async () => "lost"),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === connection.commitError &&
      error.rollbackError === connection.rollbackError &&
      error.closeError === connection.closeError,
  );
});

test("transaction close failure after a successful commit keeps its 1.x rejection", async () => {
  const connection = new RecordingConnection();
  connection.closeError = new ConnectionError("close");

  await assert.rejects(
    transactionClient(connection).transaction(async () => "committed"),
    (error: unknown) => error === connection.closeError,
  );

  assert.deepEqual(connection.calls, ["begin", "commit", "close"]);
});

test("manual commit is the single commit and keeps the callback result", async () => {
  const connection = new RecordingConnection();

  const result = await transactionClient(connection).transaction(async (tx) => {
    await tx.commit();
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(connection.calls, ["begin", "commit", "close"]);
});

test("manual rollback stops the automatic commit and keeps the callback result", async () => {
  const connection = new RecordingConnection();

  const result = await transactionClient(connection).transaction(async (tx) => {
    await tx.rollback();
    return "declined";
  });

  assert.equal(result, "declined");
  assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
});

test("error after manual commit rejects without a rollback that could not undo it", async () => {
  const connection = new RecordingConnection();
  const failure = new Error("after commit");

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      await tx.commit();
      throw failure;
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === failure &&
      error.rollbackError === undefined,
  );

  assert.deepEqual(connection.calls, ["begin", "commit", "close"]);
});

test("error after manual rollback does not roll back a second time", async () => {
  const connection = new RecordingConnection();
  const failure = new Error("after rollback");

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      await tx.rollback();
      throw failure;
    }),
    (error: unknown) => error instanceof TransactionError && error.cause === failure,
  );

  assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
});

test("failed manual commit rolls back once and rejects when it propagates", async () => {
  const connection = new RecordingConnection();
  connection.commitError = new Error("commit");

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      await tx.commit();
    }),
    (error: unknown) => error instanceof TransactionError && error.cause === connection.commitError,
  );

  assert.deepEqual(connection.calls, ["begin", "commit", "rollback", "close"]);
});

test("swallowed manual commit failure still rejects the transaction", async () => {
  const connection = new RecordingConnection();
  connection.commitError = new Error("commit");
  connection.rollbackError = new Error("rollback");

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      await tx.commit().catch(() => undefined);
      await assert.rejects(tx.commit(), rejectsWith(ALREADY_FAILED));
      await assert.rejects(tx.rollback(), rejectsWith(ALREADY_FAILED));
      await assert.rejects(tx.query("LATE"), rejectsWith(ALREADY_FAILED));
      return "must not be returned";
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === connection.commitError &&
      error.rollbackError === connection.rollbackError,
  );

  assert.deepEqual(connection.calls, ["begin", "commit", "rollback", "close"]);
});

test("swallowed manual rollback failure never turns into a commit", async () => {
  const connection = new RecordingConnection();
  connection.rollbackError = new Error("rollback");

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      await tx.rollback().catch(() => undefined);
      return "must not be returned";
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === connection.rollbackError &&
      error.rollbackError === connection.rollbackError,
  );

  assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
});

test("callback error stays the cause after a swallowed manual rollback failure", async () => {
  const connection = new RecordingConnection();
  connection.rollbackError = new Error("rollback");
  const failure = new Error("original");

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      await tx.rollback().catch(() => undefined);
      throw failure;
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause === failure &&
      error.rollbackError === connection.rollbackError,
  );

  assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
});

for (const [first, second, message] of [
  ["commit", "commit", ALREADY_COMMITTED],
  ["commit", "rollback", ALREADY_COMMITTED],
  ["rollback", "commit", ALREADY_ROLLED_BACK],
  ["rollback", "rollback", ALREADY_ROLLED_BACK],
] as const) {
  test(`${second} after manual ${first} rejects and sends nothing`, async () => {
    const connection = new RecordingConnection();

    await transactionClient(connection).transaction(async (tx) => {
      await tx[first]();
      await assert.rejects(tx[second](), rejectsWith(message));
    });

    assert.deepEqual(connection.calls, ["begin", first, "close"]);
  });

  if (first === second) {
    test(`query after manual ${first} rejects and sends nothing`, async () => {
      const connection = new RecordingConnection();

      await transactionClient(connection).transaction(async (tx) => {
        await tx[first]();
        await assert.rejects(tx.query("LATE"), rejectsWith(message));
      });

      assert.deepEqual(connection.calls, ["begin", first, "close"]);
    });
  }
}

test("calls made while a completion is running are rejected, not raced", async () => {
  const connection = new RecordingConnection();

  await transactionClient(connection).transaction(async (tx) => {
    const commit = tx.commit();
    // Issued in the same tick, so the commit cannot have finished yet.
    const competing = [tx.commit(), tx.rollback(), tx.query("LATE")];

    for (const call of competing) {
      await assert.rejects(call, rejectsWith(ALREADY_COMPLETING));
    }

    await commit;
  });

  assert.deepEqual(connection.calls, ["begin", "commit", "close"]);
});

test("a tx kept after transaction() resolved rejects every call", async () => {
  const connection = new RecordingConnection();
  let leaked: TransactionClient | undefined;

  await transactionClient(connection).transaction(async (tx) => {
    leaked = tx;
  });

  assert.ok(leaked);
  await assert.rejects(leaked.query("LATE"), rejectsWith(ALREADY_COMMITTED));
  await assert.rejects(leaked.commit(), rejectsWith(ALREADY_COMMITTED));
  await assert.rejects(leaked.rollback(), rejectsWith(ALREADY_COMMITTED));
  assert.deepEqual(connection.calls, ["begin", "commit", "close"]);
});

test("a tx kept after transaction() rejected rejects every call", async () => {
  const connection = new RecordingConnection();
  let leaked: TransactionClient | undefined;

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      leaked = tx;
      throw new Error("boom");
    }),
  );

  assert.ok(leaked);
  await assert.rejects(leaked.query("LATE"), rejectsWith(ALREADY_ROLLED_BACK));
  await assert.rejects(leaked.commit(), rejectsWith(ALREADY_ROLLED_BACK));
  await assert.rejects(leaked.rollback(), rejectsWith(ALREADY_ROLLED_BACK));
  assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
});

test("transaction waits for a manual commit the callback did not await", async () => {
  const connection = new RecordingConnection();
  connection.holdQueries();

  const finished = transactionClient(connection).transaction(async (tx) => {
    void tx.query("INSERT");
    void tx.commit();
    return "ok";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(connection.calls, ["begin", "query:INSERT"]);

  connection.releaseQuery?.();
  assert.equal(await finished, "ok");
  assert.deepEqual(connection.calls, [
    "begin",
    "query:INSERT",
    "queried:INSERT",
    "commit",
    "close",
  ]);
});

test("automatic commit runs after a query the callback did not await", async () => {
  const connection = new RecordingConnection();
  connection.holdQueries();

  const finished = transactionClient(connection).transaction(async (tx) => {
    void tx.query("INSERT");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(connection.calls, ["begin", "query:INSERT"]);

  connection.releaseQuery?.();
  await finished;
  assert.deepEqual(connection.calls, [
    "begin",
    "query:INSERT",
    "queried:INSERT",
    "commit",
    "close",
  ]);
});

test("rollback runs after a sibling query still running when the callback failed", async () => {
  const connection = new RecordingConnection();
  connection.holdQueries();
  const failure = new Error("sibling failed");

  const finished = transactionClient(connection).transaction(async (tx) => {
    await Promise.all([tx.query("INSERT"), Promise.reject(failure)]);
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(connection.calls, ["begin", "query:INSERT"]);

  connection.releaseQuery?.();
  await assert.rejects(
    finished,
    (error: unknown) => error instanceof TransactionError && error.cause === failure,
  );
  assert.deepEqual(connection.calls, [
    "begin",
    "query:INSERT",
    "queried:INSERT",
    "rollback",
    "close",
  ]);
});

test("a failed query the callback caught does not block its commit", async () => {
  const connection = new RecordingConnection();
  connection.queryError = new Error("duplicate key");

  const result = await transactionClient(connection).transaction(async (tx) => {
    await tx.query("INSERT").catch(() => undefined);
    return "handled";
  });

  assert.equal(result, "handled");
  assert.equal(connection.commitCalls, 1);
  assert.equal(connection.rollbackCalls, 0);
});

test("completion the callback did not await raises no unhandled rejection", async () => {
  for (const method of ["commit", "rollback"] as const) {
    const connection = new RecordingConnection();
    connection.commitError = new Error("commit");
    connection.rollbackError = new Error("rollback");
    const expected = method === "commit" ? connection.commitError : connection.rollbackError;

    const { unhandled } = await collectUnhandledRejections(() =>
      assert.rejects(
        transactionClient(connection).transaction(async (tx) => {
          void tx[method]();
          await macrotask();
          await macrotask();
        }),
        (error: unknown) => error instanceof TransactionError && error.cause === expected,
      ),
    );

    assert.deepEqual(unhandled, []);
    assert.deepEqual(
      connection.calls,
      method === "commit"
        ? ["begin", "commit", "rollback", "close"]
        : ["begin", "rollback", "close"],
    );
  }
});

test("query that fails while the commit waits rolls back instead of committing", async () => {
  const connection = new RecordingConnection();
  connection.holdQueries();
  connection.queryError = new Error("not awaited");

  const { unhandled } = await collectUnhandledRejections(async () => {
    const finished = transactionClient(connection).transaction(async (tx) => {
      void tx.query("INSERT");
      return "must not be returned";
    });

    await macrotask();
    connection.releaseQuery?.();

    await assert.rejects(
      finished,
      (error: unknown) =>
        error instanceof TransactionError &&
        error.message === "Transaction failed." &&
        error.cause instanceof TransactionError &&
        error.cause.cause === connection.queryError,
    );
  });

  assert.deepEqual(unhandled, []);
  assert.deepEqual(connection.calls, [
    "begin",
    "query:INSERT",
    "queried:INSERT",
    "rollback",
    "close",
  ]);
});

test("query that times out while the commit waits is rethrown as-is", async () => {
  const connection = new RecordingConnection();
  connection.holdQueries();
  const timeout = new ReadTimeoutError(50);
  connection.queryError = timeout;

  const { unhandled } = await collectUnhandledRejections(async () => {
    const finished = transactionClient(connection).transaction(async (tx) => {
      void tx.query("INSERT");
    });

    await macrotask();
    connection.releaseQuery?.();
    await assert.rejects(finished, (error: unknown) => error === timeout);
  });

  assert.deepEqual(unhandled, []);
  assert.equal(connection.commitCalls, 0);
  assert.equal(connection.rollbackCalls, 1);
});

test("manual commit does not commit past a query that fails while it waits", async () => {
  const connection = new RecordingConnection();
  connection.holdQueries();
  connection.queryError = new Error("not awaited");

  const { unhandled } = await collectUnhandledRejections(async () => {
    const finished = transactionClient(connection).transaction(async (tx) => {
      void tx.query("INSERT");
      const commit = tx.commit();
      connection.releaseQuery?.();
      await assert.rejects(
        commit,
        (error: unknown) =>
          error instanceof TransactionError && error.cause === connection.queryError,
      );
      return "must not be returned";
    });

    await assert.rejects(finished, TransactionError);
  });

  assert.deepEqual(unhandled, []);
  assert.equal(connection.commitCalls, 0);
  assert.equal(connection.rollbackCalls, 1);
});

test("query that fails during a rollback keeps the callback error as cause", async () => {
  const connection = new RecordingConnection();
  connection.holdQueries();
  connection.queryError = new Error("not awaited");
  const failure = new Error("original");

  const { unhandled } = await collectUnhandledRejections(async () => {
    const finished = transactionClient(connection).transaction(async (tx) => {
      void tx.query("INSERT");
      throw failure;
    });

    await macrotask();
    connection.releaseQuery?.();
    await assert.rejects(
      finished,
      (error: unknown) => error instanceof TransactionError && error.cause === failure,
    );
  });

  assert.deepEqual(unhandled, []);
  assert.equal(connection.rollbackCalls, 1);
});

for (const turns of [0, 1, 2]) {
  test(`query rejecting ${turns} microtask turns before the callback returns rolls back`, async () => {
    const connection = new FakeConnection();
    connection.queryError = new Error("not awaited");

    const { unhandled } = await collectUnhandledRejections(() =>
      assert.rejects(
        transactionClient(connection).transaction(async (tx) => {
          void tx.query("INSERT");

          for (let turn = 0; turn < turns; turn += 1) {
            await Promise.resolve();
          }

          return "must not be returned";
        }),
        (error: unknown) =>
          error instanceof TransactionError &&
          error.cause instanceof TransactionError &&
          error.cause.cause === connection.queryError,
      ),
    );

    assert.deepEqual(unhandled, []);
    assert.equal(connection.commitCalls, 0);
    assert.equal(connection.rollbackCalls, 1);
    assert.equal(connection.closeCalls, 1);
  });
}

for (const turns of [0, 1, 2, 3, 4, 5, 6]) {
  test(`query rejecting ${turns} microtask turns before the callback throws raises no unhandled rejection`, async () => {
    const connection = new FakeConnection();
    connection.queryError = new Error("not awaited");
    const failure = new Error("callback");

    const { unhandled } = await collectUnhandledRejections(() =>
      assert.rejects(
        transactionClient(connection).transaction(async (tx) => {
          void tx.query("INSERT");

          for (let turn = 0; turn < turns; turn += 1) {
            await Promise.resolve();
          }

          throw failure;
        }),
        (error: unknown) => error instanceof TransactionError && error.cause === failure,
      ),
    );

    assert.deepEqual(unhandled, []);
    assert.equal(connection.commitCalls, 0);
    assert.equal(connection.rollbackCalls, 1);
    assert.equal(connection.closeCalls, 1);
  });
}

test("query caught by try and catch still commits when the callback returns at once", async () => {
  const connection = new FakeConnection();
  connection.queryError = new Error("duplicate key");

  const result = await transactionClient(connection).transaction(async (tx) => {
    try {
      await tx.query("INSERT");
    } catch {
      return "handled";
    }

    return "not reached";
  });

  assert.equal(result, "handled");
  assert.equal(connection.commitCalls, 1);
  assert.equal(connection.rollbackCalls, 0);
});

test("query caught by a chained handler still commits when its promise is returned", async () => {
  const connection = new FakeConnection();
  connection.queryError = new Error("duplicate key");

  const result = await transactionClient(connection).transaction((tx) =>
    tx.query("INSERT").catch(() => "handled"),
  );

  assert.equal(result, "handled");
  assert.equal(connection.commitCalls, 1);
  assert.equal(connection.rollbackCalls, 0);
});

test("query caught right before a manual commit does not block that commit", async () => {
  const connection = new FakeConnection();
  connection.queryError = new Error("duplicate key");

  await transactionClient(connection).transaction(async (tx) => {
    try {
      await tx.query("INSERT");
    } catch {
      await tx.commit();
    }
  });

  assert.equal(connection.commitCalls, 1);
  assert.equal(connection.rollbackCalls, 0);
});

test("query that failed and settled before the callback returned cannot stop the commit", async () => {
  const connection = new RecordingConnection();
  connection.queryError = new Error("settled early");

  const result = await transactionClient(connection).transaction(async (tx) => {
    // Never awaited. Only the handler keeps this test free of an unhandled rejection.
    tx.query("INSERT").catch(() => undefined);
    await macrotask();
    return "committed";
  });

  assert.equal(result, "committed");
  assert.equal(connection.commitCalls, 1);
  assert.equal(connection.rollbackCalls, 0);
});

for (const [label, value] of [
  ["a null-prototype object", Object.create(null)],
  [
    "an object whose toString throws",
    {
      toString() {
        throw new Error("no string form");
      },
    },
  ],
] as const) {
  test(`transaction closes its connection when the callback throws ${label}`, async () => {
    const connection = new RecordingConnection();

    await assert.rejects(
      transactionClient(connection).transaction(async () => {
        throw value;
      }),
      (error: unknown) =>
        error instanceof TransactionError &&
        error.cause instanceof Error &&
        error.cause.cause === value,
    );

    assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
  });
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

test("transaction closes its connection when the callback throws a revoked proxy", async () => {
  const connection = new RecordingConnection();
  const value = revokedProxy();
  let cause: unknown;

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw value;
    }),
    (error: unknown) => {
      cause = error instanceof TransactionError ? error.cause : undefined;
      return error instanceof TransactionError;
    },
  );

  assert.ok(cause instanceof Error);
  assert.ok(cause.cause === value);
  assert.deepEqual(connection.calls, ["begin", "rollback", "close"]);
});

test("transaction closes its connection when rollback and close reject a revoked proxy", async () => {
  const connection = new FakeConnection();
  const value = revokedProxy();
  connection.rollback = () => Promise.reject(value);
  connection.close = async () => {
    connection.closeCalls += 1;
    throw value;
  };

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw new Error("original");
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      (error.cause as Error).message === "original" &&
      error.rollbackError?.cause === value &&
      error.closeError?.cause === value,
  );

  assert.equal(connection.closeCalls, 1);
});

test("mapError tolerates a revoked proxy for every error kind", () => {
  for (const kind of ["connection", "query", "transaction"] as const) {
    const mapped = mapError(kind, revokedProxy(), "message");
    assert.equal(mapped.message, "message");
    assert.ok(mapped.cause instanceof Error);
  }
});

test("transaction closes its connection when rollback rejects with an unprintable value", async () => {
  const connection = new FakeConnection();
  const value = Object.create(null);
  connection.rollback = () => Promise.reject(value);
  connection.close = async () => {
    connection.closeCalls += 1;
    throw value;
  };

  await assert.rejects(
    transactionClient(connection).transaction(async () => {
      throw new Error("original");
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      (error.cause as Error).message === "original" &&
      error.rollbackError?.cause === value &&
      error.closeError?.cause === value,
  );

  assert.equal(connection.closeCalls, 1);
});

test("client close closes the shared connection", async () => {
  const connection = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await client.query("SELECT 1");
  await client.close();

  assert.equal(connection.closeCalls, 1);
});

test("a query started in the same tick as close rejects without opening a connection", async () => {
  let opened = 0;
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        opened += 1;
        return new FakeConnection();
      },
    }),
  );

  const closing = client.close();
  const query = client.query("SELECT 1");

  await assert.rejects(query, (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.match((error.cause as Error).message, /closed/);
    return true;
  });
  await closing;
  assert.equal(opened, 0);
});

test("a query after close rejects and leaves no connection open", async () => {
  const connections: FakeConnection[] = [];
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        const connection = new FakeConnection();
        connections.push(connection);
        return connection;
      },
    }),
  );

  await client.query("SELECT 1");
  const closing = client.close();
  const sameTick = client.query("SELECT 2");
  await closing;
  const later = client.query("SELECT 3");

  await assert.rejects(sameTick, QueryError);
  await assert.rejects(later, QueryError);
  await assert.rejects(client.ping(), ConnectionError);
  await assert.rejects(client.beginTransaction(), TransactionError);
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.closeCalls, 1);
  assert.equal(connections[0]?.queries.length, 1);
});

test("client close maps close errors to ConnectionError", async () => {
  const connection = new FakeConnection();
  connection.closeError = new Error("close");
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await client.query("SELECT 1");

  await assert.rejects(
    client.close(),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.cause instanceof Error &&
      error.cause.message === "close",
  );
});

test("transaction wrapper maps query failures to TransactionError", async () => {
  const connection = new FakeConnection();
  connection.queryError = new Error("query");
  const tx = new CubridTransaction(connection);

  await assert.rejects(
    tx.query("SELECT 1"),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "query",
  );
});

test("transaction wrapper forwards commit and rollback", async () => {
  const connection = new FakeConnection();
  const tx = new CubridTransaction(connection);

  await tx.commit();
  await tx.rollback();

  assert.equal(connection.commitCalls, 1);
  assert.equal(connection.rollbackCalls, 1);
});

// ---------------------------------------------------------------------------
// CubridClient.beginTransaction / commit / rollback / close coverage
// ---------------------------------------------------------------------------

test("client beginTransaction delegates to shared connection", async () => {
  const connection = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await client.beginTransaction();

  assert.equal(connection.beginCalls, 1);
});

test("client beginTransaction maps failures to TransactionError", async () => {
  const connection = new FakeConnection();
  connection.beginError = new Error("begin");
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await assert.rejects(
    client.beginTransaction(),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "begin",
  );
});

test("client commit delegates to shared connection", async () => {
  const connection = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await client.query("SELECT 1");
  await client.commit();

  assert.equal(connection.commitCalls, 1);
});

test("client commit maps failures to TransactionError", async () => {
  const connection = new FakeConnection();
  connection.commitError = new Error("commit");
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await client.query("SELECT 1");

  await assert.rejects(
    client.commit(),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "commit",
  );
});

test("client rollback delegates to shared connection", async () => {
  const connection = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await client.query("SELECT 1");
  await client.rollback();

  assert.equal(connection.rollbackCalls, 1);
});

test("client rollback maps failures to TransactionError", async () => {
  const connection = new FakeConnection();
  connection.rollbackError = new Error("rollback");
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await client.query("SELECT 1");

  await assert.rejects(
    client.rollback(),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "rollback",
  );
});

test("client close is a no-op when no connection was opened", async () => {
  const client = createClient(
    baseOptions({
      connectionFactory: () => new FakeConnection(),
    }),
  );

  // close without ever querying - should not throw
  await client.close();
});

// ---------------------------------------------------------------------------
// CubridClient.ping()
// ---------------------------------------------------------------------------

test("client ping delegates to connection.ping", async () => {
  const connection = new FakeConnection();
  connection.ping = async () => "11.2.9.0866";
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  const version = await client.ping();
  assert.equal(version, "11.2.9.0866");
});

test("client ping wraps error as ConnectionError", async () => {
  const connection = new FakeConnection();
  connection.ping = async () => {
    throw new Error("ping failed");
  };
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await assert.rejects(
    client.ping(),
    (error: unknown) =>
      error instanceof ConnectionError && error.message === "Health check failed.",
  );
});

test("client getServerVersion returns the connection's version string with one request", async () => {
  const connection = new FakeConnection();
  let pings = 0;
  connection.ping = async () => {
    pings += 1;
    return "11.2.9.0866";
  };
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  assert.equal(await client.getServerVersion(), "11.2.9.0866");
  assert.equal(pings, 1);
});

test("client getServerVersion wraps a failure as ConnectionError", async () => {
  const connection = new FakeConnection();
  connection.ping = async () => {
    throw new Error("version failed");
  };
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await assert.rejects(
    client.getServerVersion(),
    (error: unknown) =>
      error instanceof ConnectionError && error.message === "Failed to get the server version.",
  );
});

test("client getServerVersion rejects when the connection cannot report a version", async () => {
  const client = createClient(baseOptions({ connectionFactory: () => new FakeConnection() }));

  await assert.rejects(
    client.getServerVersion(),
    (error: unknown) =>
      error instanceof ConnectionError && error.message === "Failed to get the server version.",
  );
});

test("client queryResult returns the connection's rows and columns", async () => {
  const expected = {
    rows: [{ id: 1 }],
    columns: [{ name: "id", type: "INT", precision: 10, scale: 0, nullable: false }],
  };
  const connection = Object.assign(new FakeConnection(), {
    queryResult: (async () => expected) as NonNullable<ConnectionLike["queryResult"]>,
  });
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  assert.deepEqual(await client.queryResult("SELECT id FROM t"), expected);
});

test("client queryResult fails with a QueryError when the connection lacks it", async () => {
  const client = createClient(baseOptions({ connectionFactory: () => new FakeConnection() }));

  await assert.rejects(
    client.queryResult("SELECT 1"),
    (error: unknown) => error instanceof QueryError && error.message === "Query failed.",
  );
});

test("transaction queryResult delegates and reports a missing capability as TransactionError", async () => {
  const withResult = Object.assign(new FakeConnection(), {
    queryResult: (async () => ({ rows: [], columns: [] })) as NonNullable<
      ConnectionLike["queryResult"]
    >,
  });
  const ok = createClient(baseOptions({ connectionFactory: () => withResult }));
  assert.deepEqual(await ok.transaction((tx) => tx.queryResult("SELECT 1")), {
    rows: [],
    columns: [],
  });

  const without = createClient(baseOptions({ connectionFactory: () => new FakeConnection() }));
  await assert.rejects(
    without.transaction((tx) => tx.queryResult("SELECT 1")),
    (error: unknown) => error instanceof TransactionError,
  );
});

test("client ping throws when connection has no ping method", async () => {
  const connection = new FakeConnection();
  const client = createClient(
    baseOptions({
      connectionFactory: () => connection,
    }),
  );

  await assert.rejects(
    client.ping(),
    (error: unknown) =>
      error instanceof ConnectionError && error.message === "Health check failed.",
  );
});

// ---------------------------------------------------------------------------
// Structured error details. The indicator -2 is DBMS_ERROR_INDICATOR on the wire
// and -1 is CAS_ERROR_INDICATOR; the codes are the ones live servers reported.
// ---------------------------------------------------------------------------

const serverError = (code: number): CasReplyError =>
  new CasReplyError(`CUBRID query failed (${code}): message`, -2, code);

test("mapError gives every measured server code its class and kind", () => {
  const cases: Array<[number, string, new (...args: never[]) => QueryError]> = [
    [-670, "unique-violation", ConstraintError],
    [-886, "unique-violation", ConstraintError],
    [-631, "not-null-violation", ConstraintError],
    [-922, "foreign-key-violation", ConstraintError],
    [-924, "foreign-key-violation", ConstraintError],
    [-1284, "foreign-key-violation", ConstraintError],
    [-493, "syntax", SqlSyntaxError],
    [-72, "deadlock", DeadlockError],
    [-967, "deadlock", DeadlockError],
    [-968, "deadlock", DeadlockError],
    [-74, "lock-timeout", LockTimeoutError],
    [-75, "lock-timeout", LockTimeoutError],
  ];

  for (const [code, kind, errorClass] of cases) {
    const error = mapError("query", serverError(code), "Query failed.") as QueryError;
    assert.ok(error instanceof errorClass, `${code} is a ${errorClass.name}`);
    assert.ok(error instanceof QueryError, `${code} stays a QueryError`);
    assert.equal(error.code, code);
    assert.equal(error.origin, "server");
    assert.equal(error.kind, kind);
    assert.equal(error.sqlState, undefined);
    assert.equal(error.message, "Query failed.");
  }
});

test("mapError keeps classified codes without a subclass as a plain QueryError", () => {
  for (const [code, kind] of [
    [-494, "semantic"],
    [-4, "interrupted"],
    [-111, "connection-lost"],
    [-171, "authentication"],
    [-165, "authentication"],
  ] as const) {
    const error = mapError("query", serverError(code), "Query failed.") as QueryError;
    assert.equal(error.constructor, QueryError);
    assert.equal(error.kind, kind);
    assert.equal(error.code, code);
  }
});

test("a server code without a measured meaning keeps its code and has no kind", () => {
  // -73 and -76 are lock timeouts by name in the headers but were never observed.
  for (const code of [-73, -76, -181, -427, -677]) {
    const error = mapError("query", serverError(code), "Query failed.") as QueryError;
    assert.equal(error.constructor, QueryError);
    assert.equal(error.code, code);
    assert.equal(error.origin, "server");
    assert.equal("kind" in error, false);
  }
});

test("a CAS code is never classified as the server error with the same number", () => {
  const fromCas = new CasReplyError("CUBRID fetch failed (-670): ", -1, -670);
  const error = mapError("query", fromCas, "Query failed.") as QueryError;

  assert.equal(error.constructor, QueryError);
  assert.equal(error.code, -670);
  assert.equal(error.origin, "cas");
  assert.equal("kind" in error, false);
});

test("an unknown reply indicator keeps the code without claiming an origin", () => {
  const error = mapError("query", new CasReplyError("x", -3, -670), "Query failed.") as QueryError;

  assert.equal(error.code, -670);
  assert.equal("origin" in error, false);
  assert.equal("kind" in error, false);
});

test("details survive every wrapping layer and the original cause stays reachable", () => {
  const original = serverError(-670);
  const adapter = mapError("query", original, "Failed to execute CUBRID query.");
  const statement = mapError("transaction", adapter, "Transaction query failed.");
  const outer = mapError("transaction", statement, "Transaction failed.") as TransactionError;

  assert.ok(outer instanceof TransactionError);
  assert.equal(outer.code, -670);
  assert.equal(outer.origin, "server");
  assert.equal(outer.kind, "unique-violation");
  assert.ok(adapter instanceof ConstraintError);
  assert.equal(outer.cause, statement);
  assert.equal(statement.cause, adapter);
  assert.equal(adapter.cause, original);
});

test("a ConnectionError carries the code that refused it through to a QueryError", () => {
  const refused = mapError(
    "connection",
    new CasReplyError("CUBRID connection failed (-171): password", -2, -171),
    "Failed to connect to CUBRID.",
  ) as ConnectionError;
  const query = mapError("query", refused, "Query failed.") as QueryError;

  assert.ok(refused instanceof ConnectionError);
  assert.equal(refused.code, -171);
  assert.equal(refused.kind, "authentication");
  assert.equal(query.code, -171);
  assert.equal(query.kind, "authentication");
  assert.equal(query.cause, refused);
});

test("details are found through an error the application wrapped", () => {
  const wrapped = new Error("could not save", {
    cause: mapError("query", serverError(-670), "Failed to execute CUBRID query."),
  });
  const error = mapError("transaction", wrapped, "Transaction failed.") as TransactionError;

  assert.equal(error.code, -670);
  assert.equal(error.kind, "unique-violation");
  assert.equal(error.cause, wrapped);
});

test("a cyclic cause chain ends the search instead of hanging", () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;

  assert.equal("code" in (mapError("query", first, "Query failed.") as QueryError), false);
});

test("a code on a foreign error is not reported as a CUBRID code", () => {
  const nodeError = Object.assign(new Error("reset"), { code: "ECONNRESET", kind: "deadlock" });
  const foreign = Object.assign(new Error("other driver"), { code: -670 });

  for (const cause of [nodeError, foreign]) {
    const error = mapError("query", cause, "Query failed.") as QueryError;
    assert.equal(error.constructor, QueryError);
    assert.equal("code" in error, false);
    assert.equal("kind" in error, false);
  }
});

test("a lost connection has a kind but no code", () => {
  const lost = new ConnectionLostError("Connection closed while reading");
  const query = mapError("query", lost, "Query failed.") as QueryError;
  const transaction = mapError("transaction", query, "Transaction failed.") as TransactionError;

  assert.equal(query.constructor, QueryError);
  assert.equal(query.kind, "connection-lost");
  assert.equal(transaction.kind, "connection-lost");
  assert.equal("code" in transaction, false);
  assert.equal("origin" in transaction, false);
});

test("a client read timeout is not a server error", () => {
  const timeout = new ReadTimeoutError(50);

  assert.equal(timeout.kind, "read-timeout");
  assert.equal("code" in timeout, false);
  assert.equal("origin" in timeout, false);
  assert.ok(!(timeout instanceof QueryError));
  assert.equal(mapError("query", timeout, "Query failed."), timeout);
});

test("a lock timeout is not a client read timeout", () => {
  const error = mapError("query", serverError(-75), "Query failed.");

  assert.ok(error instanceof LockTimeoutError);
  assert.ok(!(error instanceof ReadTimeoutError));
  assert.ok(!(error instanceof ConnectionError));
});

test("errors without details gain no properties", () => {
  const error = mapError("query", new Error("x"), "Query failed.");

  assert.deepEqual(Object.keys(error), ["name"]);
});

test("application code can construct errors with details", () => {
  const cause = new Error("x");
  const error = new ConstraintError("taken", {
    cause,
    code: -670,
    origin: "server",
    sqlState: "23000",
    kind: "unique-violation",
  });

  assert.equal(error.cause, cause);
  assert.equal(error.name, "ConstraintError");
  assert.equal(error.sqlState, "23000");
  assert.equal(new TransactionError("x", { sqlState: "40001" }).sqlState, "40001");
  assert.equal(new ConnectionError("x", { sqlState: "08006" }).sqlState, "08006");
  assert.equal((mapError("query", error, "Query failed.") as QueryError).sqlState, "23000");
});

test("a connection factory error reaches callers of client.query with its details", async () => {
  const client = new CubridClient(normalizeConfig(baseOptions()), async () => {
    throw new ConnectionError("refused", { code: -171, origin: "server", kind: "authentication" });
  });

  await assert.rejects(
    () => client.query("SELECT 1"),
    (error: unknown) =>
      error instanceof QueryError && error.code === -171 && error.kind === "authentication",
  );
});

test("transaction() exposes the server code on the TransactionError it rejects with", async () => {
  const connection = new FakeConnection();
  connection.query = async () => {
    throw mapError("query", serverError(-670), "Failed to execute CUBRID query.");
  };
  const client = new CubridClient(normalizeConfig(baseOptions()), async () => connection);

  await assert.rejects(
    () => client.transaction((tx) => tx.query("INSERT INTO t VALUES (1)")),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.code === -670 &&
      error.kind === "unique-violation" &&
      error.origin === "server",
  );
  assert.equal(connection.rollbackCalls, 1);
});

test("decode failures stay reachable by name and never gain server details", () => {
  // Callers walk the cause chain for these two names, a stable 1.x contract.
  for (const failure of [
    new UnsupportedValueError("column c: unsupported CAS type 29"),
    new MalformedReplyError("Malformed CAS packet", { cause: new RangeError("short") }),
  ]) {
    const adapter = mapError("query", failure, "Failed to execute CUBRID query.");
    const inTransaction = mapError("transaction", adapter, "Transaction query failed.");

    for (const [outer, type] of [
      [mapError("query", adapter, "Query failed."), QueryError],
      [mapError("transaction", inTransaction, "Transaction failed."), TransactionError],
    ] as const) {
      assert.ok(outer instanceof type);
      assert.equal(outer.constructor, type);

      let current: unknown = outer;
      while (current instanceof Error && current.name !== failure.name) {
        current = current.cause;
      }

      assert.equal(current, failure);
      assert.equal("code" in outer, false);
      assert.equal("origin" in outer, false);
      assert.equal("kind" in outer, false);
    }
  }
});

// ---------------------------------------------------------------------------
// execute() — affected rows and last insert ID
// ---------------------------------------------------------------------------

function executingConnection(result: ExecuteResult): {
  connection: ConnectionLike;
  executed: Array<{ sql: string; params: QueryParams | undefined }>;
} {
  const executed: Array<{ sql: string; params: QueryParams | undefined }> = [];
  const base = new FakeConnection();
  const connection: ConnectionLike = {
    connect: () => base.connect(),
    query: () => Promise.resolve([]),
    execute: async (sql, params) => {
      executed.push({ sql, params });
      return result;
    },
    beginTransaction: () => base.beginTransaction(),
    commit: () => base.commit(),
    rollback: () => base.rollback(),
    close: () => base.close(),
  };
  return { connection, executed };
}

test("client.execute returns the connection's affected rows and insert id", async () => {
  const { connection, executed } = executingConnection({ affectedRows: 1, lastInsertId: 7 });
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  const result = await client.execute("INSERT INTO users (name) VALUES (?)", ["Alice"]);

  assert.deepEqual(result, { affectedRows: 1, lastInsertId: 7 });
  assert.deepEqual(executed, [{ sql: "INSERT INTO users (name) VALUES (?)", params: ["Alice"] }]);
});

test("client and transaction pass generatedKeys through to the connection", async () => {
  const seen: unknown[] = [];
  const base = new FakeConnection();
  const connection: ConnectionLike = {
    connect: () => base.connect(),
    query: () => Promise.resolve([]),
    execute: async (_sql, _params, options) => {
      seen.push(options?.generatedKeys);
      return { affectedRows: 1, lastInsertId: 1 };
    },
    executePrepared: async (_sql, _params, options) => {
      seen.push(options?.generatedKeys);
      return { affectedRows: 1 };
    },
    beginTransaction: () => base.beginTransaction(),
    commit: () => base.commit(),
    rollback: () => base.rollback(),
    close: () => base.close(),
  };
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await client.execute("INSERT INTO t (v) VALUES (1)", [], { generatedKeys: true });
  await client.executePrepared("INSERT INTO t (v) VALUES (?)", [1], { generatedKeys: true });
  await client.transaction((tx) =>
    tx.execute("INSERT INTO t (v) VALUES (1)", [], { generatedKeys: true }),
  );
  await client.execute("INSERT INTO t (v) VALUES (1)");

  assert.deepEqual(seen, [true, true, true, undefined]);
});

test("tx.execute runs on the transaction's own connection", async () => {
  const { connection, executed } = executingConnection({ affectedRows: 2 });
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  const result = await client.transaction((tx) => tx.execute("DELETE FROM users"));

  assert.deepEqual(result, { affectedRows: 2 });
  assert.equal(executed.length, 1);
});

test("client.execute wraps a failure in QueryError", async () => {
  const { connection } = executingConnection({ affectedRows: 0 });
  connection.execute = () => Promise.reject(new Error("boom"));
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await assert.rejects(() => client.execute("DELETE FROM users"), QueryError);
});

test("tx.execute wraps a failure in TransactionError", async () => {
  const { connection } = executingConnection({ affectedRows: 0 });
  connection.execute = () => Promise.reject(new Error("boom"));
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await assert.rejects(
    () => client.transaction((tx) => tx.execute("DELETE FROM users")),
    TransactionError,
  );
});

test("execute reports a connection that lacks it, and query keeps working", async () => {
  const connection = new FakeConnection();
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await assert.rejects(
    () => client.execute("DELETE FROM users"),
    (error: Error) =>
      error instanceof QueryError &&
      error.cause instanceof Error &&
      /does not support execute/.test(error.cause.message),
  );
  assert.deepEqual(await client.query("SELECT 1"), []);
  await assert.rejects(
    () => client.transaction((tx) => tx.execute("DELETE FROM users")),
    TransactionError,
  );
});

test("a 1.x class implementing TransactionClient without execute still compiles", () => {
  // Type-level check: `execute` must not become mandatory on TransactionClient.
  class LegacyTransaction implements TransactionClient {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T[]> {
      return [];
    }
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
  }
  const legacy: TransactionClient = new LegacyTransaction();
  assert.equal(typeof legacy.commit, "function");
  assert.equal("execute" in legacy, false);
});

// ---------------------------------------------------------------------------
// Every statement method of a callback transaction has the same guards
// ---------------------------------------------------------------------------

type StatementTransaction = Parameters<
  Parameters<ReturnType<typeof createClient>["transaction"]>[0]
>[0];

const TRANSACTION_STATEMENTS: Array<
  [string, (tx: StatementTransaction, sql: string) => Promise<unknown>]
> = [
  ["query", (tx, sql) => tx.query(sql)],
  ["queryResult", (tx, sql) => tx.queryResult(sql)],
  ["execute", (tx, sql) => tx.execute(sql)],
  ["queryPrepared", (tx, sql) => tx.queryPrepared(sql)],
  ["queryResultPrepared", (tx, sql) => tx.queryResultPrepared(sql)],
  ["executePrepared", (tx, sql) => tx.executePrepared(sql)],
];

/** Sends all three statement methods through the recorded, gated query(). */
class RecordingStatementConnection extends RecordingConnection {
  async queryResult<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    return { rows: await this.query<T>(sql, params), columns: [] };
  }

  async execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    await this.query(sql, params);
    return { affectedRows: 1 };
  }

  async queryPrepared<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    return this.query<T>(sql, params);
  }

  async queryResultPrepared<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    return this.queryResult<T>(sql, params);
  }

  async executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    return this.execute(sql, params);
  }
}

/** Fails all three statement methods in the same number of microtask turns as query(). */
class FailingStatementConnection extends FakeConnection {
  async queryResult<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    this.queries.push({ sql, params });

    if (this.queryError) {
      throw this.queryError;
    }

    return { rows: [], columns: [] };
  }

  async execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    this.queries.push({ sql, params });

    if (this.queryError) {
      throw this.queryError;
    }

    return { affectedRows: 0 };
  }

  async queryPrepared<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    return (await this.queryResult<T>(sql, params)).rows;
  }

  async queryResultPrepared<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>> {
    return this.queryResult<T>(sql, params);
  }

  async executePrepared(sql: string, params?: QueryParams): Promise<ExecuteResult> {
    return this.execute(sql, params);
  }
}

for (const [name, run] of TRANSACTION_STATEMENTS) {
  test(`tx.${name} after each kind of completion rejects and sends nothing`, async () => {
    const committed = new RecordingStatementConnection();
    await transactionClient(committed).transaction(async (tx) => {
      await tx.commit();
      await assert.rejects(run(tx, "LATE"), rejectsWith(ALREADY_COMMITTED));
    });
    assert.deepEqual(committed.calls, ["begin", "commit", "close"]);

    const rolledBack = new RecordingStatementConnection();
    await transactionClient(rolledBack).transaction(async (tx) => {
      await tx.rollback();
      await assert.rejects(run(tx, "LATE"), rejectsWith(ALREADY_ROLLED_BACK));
    });
    assert.deepEqual(rolledBack.calls, ["begin", "rollback", "close"]);

    const completing = new RecordingStatementConnection();
    await transactionClient(completing).transaction(async (tx) => {
      const commit = tx.commit();
      await assert.rejects(run(tx, "LATE"), rejectsWith(ALREADY_COMPLETING));
      await commit;
    });
    assert.deepEqual(completing.calls, ["begin", "commit", "close"]);

    const failed = new RecordingStatementConnection();
    failed.commitError = new Error("commit");
    await assert.rejects(
      transactionClient(failed).transaction(async (tx) => {
        await tx.commit().catch(() => undefined);
        await assert.rejects(run(tx, "LATE"), rejectsWith(ALREADY_FAILED));
      }),
      TransactionError,
    );
    assert.deepEqual(failed.calls, ["begin", "commit", "rollback", "close"]);

    const kept = new RecordingStatementConnection();
    let keptTx: StatementTransaction | undefined;
    await transactionClient(kept).transaction(async (tx) => {
      keptTx = tx;
    });
    await assert.rejects(
      run(keptTx as StatementTransaction, "LATE"),
      rejectsWith(ALREADY_COMMITTED),
    );
    assert.deepEqual(kept.calls, ["begin", "commit", "close"]);
  });

  test(`automatic commit runs after a tx.${name} the callback did not await`, async () => {
    const connection = new RecordingStatementConnection();
    connection.holdQueries();

    const finished = transactionClient(connection).transaction(async (tx) => {
      void run(tx, "INSERT");
    });

    await macrotask();
    assert.deepEqual(connection.calls, ["begin", "query:INSERT"]);
    connection.releaseQuery?.();
    await finished;

    assert.deepEqual(connection.calls, [
      "begin",
      "query:INSERT",
      "queried:INSERT",
      "commit",
      "close",
    ]);
  });

  test(`tx.${name} that fails while the commit waits rolls back`, async () => {
    const connection = new RecordingStatementConnection();
    connection.holdQueries();
    connection.queryError = new Error("not awaited");

    const { unhandled } = await collectUnhandledRejections(async () => {
      const finished = transactionClient(connection).transaction(async (tx) => {
        void run(tx, "INSERT");
      });

      await macrotask();
      connection.releaseQuery?.();

      await assert.rejects(
        finished,
        (error: unknown) =>
          error instanceof TransactionError &&
          error.cause instanceof TransactionError &&
          error.cause.cause === connection.queryError,
      );
    });

    assert.deepEqual(unhandled, []);
    assert.deepEqual(connection.calls, [
      "begin",
      "query:INSERT",
      "queried:INSERT",
      "rollback",
      "close",
    ]);
  });

  for (const turns of [0, 1, 2]) {
    test(`tx.${name} rejecting ${turns} microtask turns before the callback returns rolls back`, async () => {
      const connection = new FailingStatementConnection();
      connection.queryError = new Error("not awaited");

      const { unhandled } = await collectUnhandledRejections(() =>
        assert.rejects(
          transactionClient(connection).transaction(async (tx) => {
            void run(tx, "INSERT");

            for (let turn = 0; turn < turns; turn += 1) {
              await Promise.resolve();
            }
          }),
          TransactionError,
        ),
      );

      assert.deepEqual(unhandled, []);
      assert.equal(connection.commitCalls, 0);
      assert.equal(connection.rollbackCalls, 1);
      assert.equal(connection.closeCalls, 1);
    });
  }

  test(`tx.${name} rejecting before the callback throws raises no unhandled rejection`, async () => {
    const connection = new FailingStatementConnection();
    connection.queryError = new Error("not awaited");
    const failure = new Error("callback");

    const { unhandled } = await collectUnhandledRejections(() =>
      assert.rejects(
        transactionClient(connection).transaction(async (tx) => {
          void run(tx, "INSERT");
          await Promise.resolve();
          throw failure;
        }),
        (error: unknown) => error instanceof TransactionError && error.cause === failure,
      ),
    );

    assert.deepEqual(unhandled, []);
    assert.equal(connection.rollbackCalls, 1);
    assert.equal(connection.closeCalls, 1);
  });

  test(`tx.${name} caught by the callback still commits`, async () => {
    const connection = new FailingStatementConnection();
    connection.queryError = new Error("handled");

    const result = await transactionClient(connection).transaction(async (tx) => {
      try {
        await run(tx, "INSERT");
      } catch {
        return "handled";
      }

      return "not reached";
    });

    assert.equal(result, "handled");
    assert.equal(connection.commitCalls, 1);
    assert.equal(connection.rollbackCalls, 0);
    assert.equal(connection.closeCalls, 1);
  });
}

test("Promise.all of every statement method commits once after all of them", async () => {
  const connection = new RecordingStatementConnection();

  const results = await transactionClient(connection).transaction((tx) =>
    Promise.all(TRANSACTION_STATEMENTS.map(([name, run]) => run(tx, name))),
  );

  assert.equal(results.length, TRANSACTION_STATEMENTS.length);
  assert.deepEqual(connection.calls.slice(-2), ["commit", "close"]);
  assert.equal(connection.commitCalls, 1);
  assert.equal(connection.rollbackCalls, 0);
});

test("a rollback after one Promise.all statement failed waits for the others", async () => {
  const connection = new RecordingStatementConnection();
  connection.holdQueries();
  const original = connection.query.bind(connection);
  const failure = new Error("first");
  connection.query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> => {
    if (sql === "FAIL") {
      throw failure;
    }

    return original<T>(sql, params);
  };

  const finished = transactionClient(connection).transaction((tx) =>
    Promise.all([tx.execute("FAIL"), tx.queryResult("SLOW")]),
  );

  await macrotask();
  assert.deepEqual(connection.calls, ["begin", "query:SLOW"]);
  connection.releaseQuery?.();

  await assert.rejects(
    finished,
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof TransactionError &&
      error.cause.cause === failure,
  );
  assert.deepEqual(connection.calls, ["begin", "query:SLOW", "queried:SLOW", "rollback", "close"]);
});

test("transaction on a closed client rejects and opens no connection", async () => {
  let opened = 0;
  let called = false;
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        opened += 1;
        return new FakeConnection();
      },
    }),
  );

  await client.close();

  await assert.rejects(
    client.transaction(async () => {
      called = true;
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "Client is closed.",
  );

  assert.equal(opened, 0);
  assert.equal(called, false);
});

test("transaction called in the same tick as close opens no connection", async () => {
  let opened = 0;
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        opened += 1;
        return new FakeConnection();
      },
    }),
  );

  const closed = client.close();
  await assert.rejects(
    client.transaction(async () => undefined),
    TransactionError,
  );
  await closed;

  assert.equal(opened, 0);
});

test("close does not stop a transaction already running on its own connection", async () => {
  const connection = new RecordingConnection();
  const client = transactionClient(connection);

  const result = await client.transaction(async (tx) => {
    await client.close();
    await tx.query("INSERT");
    return "committed";
  });

  assert.equal(result, "committed");
  assert.deepEqual(connection.calls, [
    "begin",
    "query:INSERT",
    "queried:INSERT",
    "commit",
    "close",
  ]);
});

test("the prepared methods never fall back to SQL literals on a connection without them", async () => {
  const connection = new FakeConnection();
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  for (const [name, run] of [
    ["queryPrepared", () => client.queryPrepared("SELECT ?", [1])],
    ["queryResultPrepared", () => client.queryResultPrepared("SELECT ?", [1])],
    ["executePrepared", () => client.executePrepared("DELETE FROM t WHERE a = ?", [1])],
  ] as const) {
    await assert.rejects(
      run,
      (error: Error) =>
        error instanceof QueryError &&
        error.cause instanceof Error &&
        error.cause.message === `Underlying connection does not support ${name}.`,
    );
  }
  const inTransaction: Array<(tx: PreparedTransactionClient) => Promise<unknown>> = [
    (tx) => tx.queryPrepared("SELECT ?", [1]),
    (tx) => tx.queryResultPrepared("SELECT ?", [1]),
    (tx) => tx.executePrepared("DELETE FROM t WHERE a = ?", [1]),
  ];
  for (const run of inTransaction) {
    await assert.rejects(() => client.transaction(run), TransactionError);
  }
});

test("the prepared methods reach the connection's own on a client and in a transaction", async () => {
  const calls: string[] = [];
  const connection = Object.assign(new FakeConnection(), {
    async queryPrepared<T>(sql: string): Promise<T[]> {
      calls.push(`queryPrepared ${sql}`);
      return [];
    },
    async queryResultPrepared<T>(sql: string): Promise<QueryResult<T & QueryResultRow>> {
      calls.push(`queryResultPrepared ${sql}`);
      return { rows: [], columns: [] };
    },
    async executePrepared(sql: string): Promise<ExecuteResult> {
      calls.push(`executePrepared ${sql}`);
      return { affectedRows: 1 };
    },
  });
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await client.queryPrepared("a");
  await client.queryResultPrepared("b");
  assert.deepEqual(await client.executePrepared("c"), { affectedRows: 1 });
  await client.transaction(async (tx) => {
    await tx.queryPrepared("d");
    await tx.queryResultPrepared("e");
    await tx.executePrepared("f");
  });

  assert.deepEqual(calls, [
    "queryPrepared a",
    "queryResultPrepared b",
    "executePrepared c",
    "queryPrepared d",
    "queryResultPrepared e",
    "executePrepared f",
  ]);
  assert.deepEqual(connection.queries, []);
});

// ---------------------------------------------------------------------------
// Isolation level and lock timeout options
// ---------------------------------------------------------------------------

class ConfigurableConnection extends RecordingConnection {
  options: TransactionOptions[] = [];
  optionsError?: Error;

  async setTransactionOptions(options: TransactionOptions): Promise<void> {
    this.calls.push("setTransactionOptions");
    this.options.push(options);

    if (this.optionsError) {
      throw this.optionsError;
    }
  }
}

test("normalizeConfig keeps valid transaction settings and adds none by default", () => {
  const config = normalizeConfig({
    ...baseOptions(),
    isolationLevel: "repeatable read",
    lockTimeout: 0,
  });

  assert.equal(config.isolationLevel, "repeatable read");
  assert.equal(config.lockTimeout, 0);
  assert.ok(!("isolationLevel" in normalizeConfig(baseOptions())));
  assert.ok(!("lockTimeout" in normalizeConfig(baseOptions())));
});

for (const isolationLevel of ["READ COMMITTED", "read uncommitted", "snapshot", 4, ""]) {
  test(`createClient and new CubridClient reject isolationLevel ${String(isolationLevel)}`, () => {
    const options = { ...baseOptions(), isolationLevel } as unknown as ClientOptions;

    assert.throws(() => createClient(options), RangeError);
    assert.throws(() => new CubridClient(options as never, () => new FakeConnection()), RangeError);
  });
}

// -2 matters most: the server would accept it and silently wait forever.
for (const lockTimeout of [-2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "1000"]) {
  test(`createClient rejects lockTimeout ${String(lockTimeout)}`, () => {
    assert.throws(
      () => createClient({ ...baseOptions(), lockTimeout } as unknown as ClientOptions),
      RangeError,
    );
  });
}

for (const lockTimeout of [-1, 0, 1, 2 ** 31 - 1]) {
  test(`createClient accepts lockTimeout ${lockTimeout} and keeps it`, () => {
    assert.ok(createClient({ ...baseOptions(), lockTimeout }) instanceof CubridClient);
    assert.equal(normalizeConfig({ ...baseOptions(), lockTimeout }).lockTimeout, lockTimeout);
  });
}

test("transaction() rejects invalid options before opening a connection", async () => {
  let opened = 0;
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        opened += 1;
        return new ConfigurableConnection();
      },
    }),
  );

  await assert.rejects(
    client.transaction(async () => undefined, {
      isolationLevel: "dirty read" as "serializable",
    }),
    RangeError,
  );
  await assert.rejects(
    client.transaction(async () => undefined, { lockTimeout: -2 }),
    RangeError,
  );

  assert.equal(opened, 0);
});

test("transaction() applies its options on its own connection before the transaction begins", async () => {
  const shared = new ConfigurableConnection();
  const dedicated = new ConfigurableConnection();
  const connections = [shared, dedicated];
  const client = createClient(baseOptions({ connectionFactory: () => connections.shift()! }));

  await client.query("SELECT 1");
  await client.transaction(async (tx) => tx.query("SELECT 2"), { isolationLevel: "serializable" });

  assert.deepEqual(shared.options, []);
  assert.deepEqual(dedicated.options, [{ isolationLevel: "serializable" }]);
  assert.deepEqual(dedicated.calls.slice(0, 2), ["setTransactionOptions", "begin"]);
});

test("client settings apply to the shared connection and to each transaction connection", async () => {
  const shared = new ConfigurableConnection();
  const dedicated = new ConfigurableConnection();
  const connections = [shared, dedicated];
  const client = createClient(
    baseOptions({
      isolationLevel: "repeatable read",
      lockTimeout: 2000,
      connectionFactory: () => connections.shift()!,
    }),
  );

  await client.query("SELECT 1");
  await client.query("SELECT 2");
  await client.transaction(async () => undefined);

  const expected = { isolationLevel: "repeatable read", lockTimeout: 2000 };
  assert.deepEqual(shared.options, [expected]);
  assert.deepEqual(dedicated.options, [expected]);

  // A client without settings calls nothing, so 1.x connections behave as before.
  const plain = new ConfigurableConnection();
  const plainClient = transactionClient(plain);
  await plainClient.query("SELECT 1");
  await plainClient.transaction(async () => undefined);
  assert.ok(!plain.calls.includes("setTransactionOptions"));
});

test("transaction() options override the client's, key by key", async () => {
  const shared = new ConfigurableConnection();
  const dedicated = new ConfigurableConnection();
  const connections = [dedicated, shared];
  const client = createClient(
    baseOptions({
      isolationLevel: "repeatable read",
      lockTimeout: 2000,
      connectionFactory: () => connections.shift()!,
    }),
  );

  await client.transaction(async () => undefined, { lockTimeout: 0 });
  await client.query("SELECT 1");

  assert.deepEqual(dedicated.options, [{ isolationLevel: "repeatable read", lockTimeout: 0 }]);
  assert.deepEqual(shared.options, [{ isolationLevel: "repeatable read", lockTimeout: 2000 }]);
});

test("an undefined option keeps the client's value", async () => {
  const connection = new ConfigurableConnection();
  const client = createClient(
    baseOptions({ isolationLevel: "serializable", connectionFactory: () => connection }),
  );

  await client.transaction(async () => undefined, {
    isolationLevel: undefined,
  } as unknown as TransactionOptions);

  assert.deepEqual(connection.options, [{ isolationLevel: "serializable" }]);
});

test("a transaction option on a connection that cannot apply it fails before the callback runs", async () => {
  const connection = new RecordingConnection();
  const client = transactionClient(connection);
  let ran = false;

  await assert.rejects(
    client.transaction(
      async () => {
        ran = true;
      },
      { isolationLevel: "serializable" },
    ),
    (error: unknown) =>
      error instanceof TransactionError &&
      /does not support transaction options/.test(String(error.cause)),
  );

  assert.equal(ran, false);
  assert.deepEqual(connection.calls, ["close"]);
});

test("a client setting on a connection that cannot apply it fails every statement", async () => {
  const connections = [new RecordingConnection(), new RecordingConnection()];
  const opened = [...connections];
  const client = createClient(
    baseOptions({ lockTimeout: 1000, connectionFactory: () => connections.shift()! }),
  );

  await assert.rejects(
    client.query("SELECT 1"),
    (error: unknown) =>
      error instanceof QueryError &&
      /does not support transaction options/.test(String(error.cause)),
  );
  await assert.rejects(client.query("SELECT 2"), QueryError);

  for (const connection of opened) {
    assert.deepEqual(connection.calls, ["close"]);
  }
});

test("a failed setTransactionOptions on the shared connection is retried on a new one", async () => {
  const failing = new ConfigurableConnection();
  failing.optionsError = new Error("refused");
  const working = new ConfigurableConnection();
  const connections = [failing, working];
  const client = createClient(
    baseOptions({ lockTimeout: 1000, connectionFactory: () => connections.shift()! }),
  );

  await assert.rejects(client.query("SELECT 1"), QueryError);
  await client.query("SELECT 2");

  assert.deepEqual(failing.calls, ["setTransactionOptions", "close"]);
  assert.deepEqual(working.calls.slice(0, 2), ["setTransactionOptions", "query:SELECT 2"]);
});

test("a failed setTransactionOptions rejects transaction() without a rollback and closes", async () => {
  const connection = new ConfigurableConnection();
  connection.optionsError = new Error("refused");
  const client = transactionClient(connection);

  await assert.rejects(
    client.transaction(async () => undefined, { lockTimeout: 1000 }),
    TransactionError,
  );

  assert.deepEqual(connection.calls, ["setTransactionOptions", "close"]);
});

/** A connection whose stream() records what the client asked of it. */
class StreamingConnection extends FakeConnection {
  streamCalls: unknown[][] = [];
  returned = false;
  failure?: Error;
  failureOnReturn?: Error;

  stream<T extends Record<string, unknown>>(...args: unknown[]): AsyncIterable<T> {
    this.streamCalls.push(args);
    const { failure, failureOnReturn } = this;
    const onReturn = (): void => {
      this.returned = true;
    };
    let index = 0;

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (failure && index === 1) {
            throw failure;
          }
          index += 1;
          return index > 2
            ? { done: true as const, value: undefined }
            : { done: false as const, value: { n: index } as unknown as T };
        },
        return: async () => {
          onReturn();
          if (failureOnReturn) {
            throw failureOnReturn;
          }
          return { done: true as const, value: undefined };
        },
      }),
    };
  }
}

test("stream forwards its arguments and yields the connection's rows", async () => {
  const connection = new StreamingConnection();
  const client = createClient(baseOptions({ connectionFactory: () => connection }));
  const options = { fetchSize: 7 };
  const rows: unknown[] = [];

  for await (const row of client.stream("SELECT n FROM t", [1], options)) {
    rows.push(row);
  }

  assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(connection.streamCalls, [["SELECT n FROM t", [1], options]]);
  assert.equal(connection.returned, false);
});

test("stream rejects on its first read when the connection does not support it", async () => {
  const client = createClient(baseOptions({ connectionFactory: () => new FakeConnection() }));

  await assert.rejects(
    () => client.stream("SELECT 1").next(),
    (error: Error) => {
      assert.ok(error instanceof QueryError);
      assert.match((error.cause as Error).message, /does not support stream/);
      return true;
    },
  );
});

test("stream wraps a failed read and a failed release in QueryError", async () => {
  const connection = new StreamingConnection();
  connection.failure = new Error("read failed");
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await assert.rejects(
    async () => {
      for await (const row of client.stream("SELECT 1")) {
        assert.ok(row);
      }
    },
    (error: Error) => error instanceof QueryError && error.cause === connection.failure,
  );
  assert.equal(connection.returned, false);

  const releasing = new StreamingConnection();
  releasing.failureOnReturn = new Error("release failed");
  const other = createClient(baseOptions({ connectionFactory: () => releasing }));

  await assert.rejects(
    async () => {
      for await (const row of other.stream("SELECT 1")) {
        assert.ok(row);
        break;
      }
    },
    (error: Error) => error instanceof QueryError && error.cause === releasing.failureOnReturn,
  );
});

test("stream reports an abort with the signal's own reason", async () => {
  const connection = new StreamingConnection();
  const controller = new AbortController();
  const reason = new Error("stopped by the caller");
  connection.failure = reason;
  controller.abort(reason);
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await assert.rejects(
    async () => {
      for await (const row of client.stream("SELECT 1", undefined, { signal: controller.signal })) {
        assert.ok(row);
      }
    },
    (error) => error === reason,
  );
});

test("stream closes the connection's iterator on break and on a loop body failure", async () => {
  const connection = new StreamingConnection();
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  for await (const row of client.stream("SELECT 1")) {
    assert.ok(row);
    break;
  }
  assert.equal(connection.returned, true);

  connection.returned = false;
  const failure = new Error("the loop failed");
  await assert.rejects(
    async () => {
      for await (const row of client.stream("SELECT 1")) {
        assert.ok(row);
        throw failure;
      }
    },
    (error) => error === failure,
  );
  assert.equal(connection.returned, true);
});

test("stream after close() rejects on its first read and opens no connection", async () => {
  let opened = 0;
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        opened += 1;
        return new StreamingConnection();
      },
    }),
  );
  await client.close();

  await assert.rejects(() => client.stream("SELECT 1").next(), QueryError);
  assert.equal(opened, 0);
});

// ---------------------------------------------------------------------------
// Per-query options: AbortSignal and readTimeout (#150)
// ---------------------------------------------------------------------------

const QUERY_METHODS = [
  "query",
  "queryResult",
  "execute",
  "queryPrepared",
  "queryResultPrepared",
  "executePrepared",
] as const;

type QueryMethod = (typeof QUERY_METHODS)[number];
type QueryRunner = (
  method: QueryMethod,
  sql: string,
  params?: QueryParams,
  options?: QueryOptions,
) => Promise<unknown>;

/** Calls `method` on anything that has the six statement methods. */
function runner(target: unknown): QueryRunner {
  return (method, sql, params, options) =>
    (
      target as Record<
        QueryMethod,
        (sql: string, params?: QueryParams, options?: QueryOptions) => Promise<unknown>
      >
    )[method](sql, params, options);
}

/** A connection whose six statement methods record their arguments. */
class OptionsConnection extends FakeConnection {
  calls: Array<[string, string, QueryParams | undefined, QueryOptions | undefined]> = [];
  failure?: unknown;

  private run(
    method: string,
    sql: string,
    params: QueryParams | undefined,
    options: QueryOptions | undefined,
    result: unknown,
  ): Promise<never> {
    this.calls.push([method, sql, params, options]);
    return this.failure === undefined
      ? Promise.resolve(result as never)
      : Promise.reject(this.failure);
  }

  override query<T extends Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.run("query", sql, params, options, []);
  }

  queryResult<T extends Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.run("queryResult", sql, params, options, { rows: [], columns: [] });
  }

  execute(sql: string, params?: QueryParams, options?: QueryOptions): Promise<ExecuteResult> {
    return this.run("execute", sql, params, options, { affectedRows: 0 });
  }

  queryPrepared<T extends Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<T[]> {
    return this.run("queryPrepared", sql, params, options, []);
  }

  queryResultPrepared<T extends Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    return this.run("queryResultPrepared", sql, params, options, { rows: [], columns: [] });
  }

  executePrepared(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<ExecuteResult> {
    return this.run("executePrepared", sql, params, options, { affectedRows: 0 });
  }
}

/** Runs `use` on the client, on a transaction() `tx` and on a scope handle. */
async function onEveryQueryable(
  connection: OptionsConnection,
  use: (run: QueryRunner, where: string) => Promise<void>,
): Promise<void> {
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await use(runner(client), "client");
  await client
    .transaction(async (tx) => {
      await use(runner(tx), "transaction");
    })
    .catch((error: unknown) => {
      // A rejected statement fails the transaction; `use` already checked it.
      assert.ok(error instanceof TransactionError);
    });
  const scope = await client.beginTransactionScope();
  await use(runner(scope), "scope");
  await scope.rollback();
  await client.close();
}

test("every statement method forwards its QueryOptions to the connection", async () => {
  const connection = new OptionsConnection();
  const options: QueryOptions = { signal: new AbortController().signal, readTimeout: 250 };

  await onEveryQueryable(connection, async (run) => {
    for (const method of QUERY_METHODS) {
      await run(method, "SELECT 1", [1], options);
    }
  });

  assert.equal(connection.calls.length, QUERY_METHODS.length * 3);
  for (const [index, [method, sql, params, forwarded]] of connection.calls.entries()) {
    assert.equal(method, QUERY_METHODS[index % QUERY_METHODS.length]);
    assert.equal(sql, "SELECT 1");
    assert.deepEqual(params, [1]);
    assert.equal(forwarded, options);
  }
});

test("an already aborted signal rejects with its reason and reaches no connection", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before it started");
  controller.abort(reason);
  let opened = 0;
  const client = createClient(
    baseOptions({
      connectionFactory: () => {
        opened += 1;
        return new OptionsConnection();
      },
    }),
  );

  for (const method of QUERY_METHODS) {
    await assert.rejects(
      runner(client)(method, "SELECT 1", [], { signal: controller.signal }),
      (error) => error === reason,
    );
  }
  assert.equal(opened, 0);

  const connection = new OptionsConnection();
  await onEveryQueryable(connection, async (run, where) => {
    if (where === "client") return;
    for (const method of QUERY_METHODS) {
      await assert.rejects(
        run(method, "SELECT 1", [], { signal: controller.signal }),
        (error) => error === reason,
      );
    }
  });
  assert.deepEqual(connection.calls, []);
});

test("an abort reason from the connection is passed through unchanged", async () => {
  const controller = new AbortController();
  const reason = new DOMException("stopped", "AbortError");
  const connection = new OptionsConnection();
  connection.failure = reason;

  await onEveryQueryable(connection, async (run) => {
    // The connection fails with the reason while the signal is not aborted yet:
    // only the caller's own abort keeps its identity.
    for (const method of QUERY_METHODS) {
      await assert.rejects(
        run(method, "SELECT 1", [], { signal: controller.signal }),
        (error) => error !== reason && (error as Error).cause === reason,
      );
    }
  });

  const live = new AbortController();
  const aborting = new OptionsConnection();
  aborting.failure = reason;
  aborting.query = (async () => {
    live.abort(reason);
    throw reason;
  }) as OptionsConnection["query"];
  const client = createClient(baseOptions({ connectionFactory: () => aborting }));
  await assert.rejects(
    client.query("SELECT 1", [], { signal: live.signal }),
    (error) => error === reason,
  );
});

test("an abort reason from a transaction's connection is passed through unchanged", async () => {
  const live = new AbortController();
  const reason = new Error("stopped by the caller");
  const connection = new OptionsConnection();
  connection.query = (async () => {
    live.abort(reason);
    throw reason;
  }) as OptionsConnection["query"];
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  let seen: unknown;
  await client
    .transaction(async (tx) => {
      seen = await tx.query("SELECT 1", [], { signal: live.signal }).catch((error) => error);
    })
    .catch(() => undefined);
  assert.equal(seen, reason);

  const second = new AbortController();
  connection.query = (async () => {
    second.abort(reason);
    throw reason;
  }) as OptionsConnection["query"];
  const scope = await client.beginTransactionScope();
  await assert.rejects(
    scope.query("SELECT 1", [], { signal: second.signal }),
    (error) => error === reason,
  );
  await scope.rollback();
  await client.close();
});

for (const [name, options, type] of [
  ["a negative readTimeout", { readTimeout: -1 }, RangeError],
  ["a NaN readTimeout", { readTimeout: Number.NaN }, RangeError],
  ["an infinite readTimeout", { readTimeout: Number.POSITIVE_INFINITY }, RangeError],
  ["a readTimeout over 2^31-1", { readTimeout: 2 ** 31 }, RangeError],
  ["a string readTimeout", { readTimeout: "100" }, RangeError],
  ["a signal that is not an AbortSignal", { signal: { aborted: false } }, TypeError],
  ["options that are not an object", "fast", TypeError],
  ["null options", null, TypeError],
] as const) {
  test(`every statement method refuses ${name} at once and sends nothing`, async () => {
    const connection = new OptionsConnection();

    await onEveryQueryable(connection, async (run) => {
      for (const method of QUERY_METHODS) {
        await assert.rejects(run(method, "SELECT 1", [], options as unknown as QueryOptions), type);
      }
    });

    assert.deepEqual(connection.calls, []);
  });
}

test("readTimeout 0 and an unaborted signal are valid query options", async () => {
  const connection = new OptionsConnection();
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await client.query("SELECT 1", [], { readTimeout: 0 });
  await client.query("SELECT 1", [], { signal: new AbortController().signal });
  await client.query("SELECT 1", [], {});

  assert.equal(connection.calls.length, 3);
});

test("the logging wrapper forwards QueryOptions", async () => {
  const connection = new OptionsConnection();
  const client = createClient(
    baseOptions({ connectionFactory: () => connection, logger: { debug: () => undefined } }),
  );
  const options: QueryOptions = { readTimeout: 10 };

  for (const method of QUERY_METHODS) {
    await runner(client)(method, "SELECT 1", [], options);
  }

  assert.deepEqual(
    connection.calls.map(([method, , , forwarded]) => [method, forwarded]),
    QUERY_METHODS.map((method) => [method, options]),
  );
});

// ---------------------------------------------------------------------------
// executeMany(): forwarded to the connection, never emulated (#86)
// ---------------------------------------------------------------------------

test("executeMany reaches the connection's own on a client, in transaction() and in a scope", async () => {
  const calls: string[] = [];
  const connection = Object.assign(new FakeConnection(), {
    async executeMany(sql: string, paramSets: readonly QueryParams[]): Promise<ExecuteManyResult> {
      calls.push(`${sql} ${paramSets.length}`);
      return { affectedRows: paramSets.length, results: paramSets.map(() => 1) };
    },
  });
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  assert.deepEqual(await client.executeMany("a", [[1], [2]]), {
    affectedRows: 2,
    results: [1, 1],
  });
  await client.transaction(async (tx) => {
    await tx.executeMany("b", [[1]]);
  });
  const scope = await client.beginTransactionScope();
  await scope.executeMany("c", [[1], [2], [3]]);
  await scope.commit();

  assert.deepEqual(calls, ["a 2", "b 1", "c 3"]);
  assert.deepEqual(connection.queries, []);
});

test("executeMany never falls back to one statement per set on a connection without it", async () => {
  const connection = new FakeConnection();
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await assert.rejects(
    client.executeMany("INSERT INTO t VALUES (?)", [[1]]),
    (error: Error) =>
      error instanceof QueryError &&
      error.cause instanceof Error &&
      error.cause.message === "Underlying connection does not support executeMany.",
  );
  const inTransaction = (tx: BatchTransactionClient) =>
    tx.executeMany("INSERT INTO t VALUES (?)", [[1]]);
  await assert.rejects(() => client.transaction(inTransaction), TransactionError);
  assert.deepEqual(connection.queries, []);
});

test("tx.executeMany after the transaction completed rejects and sends nothing", async () => {
  let sent = 0;
  const connection = Object.assign(new FakeConnection(), {
    async executeMany(): Promise<ExecuteManyResult> {
      sent += 1;
      return { affectedRows: 0, results: [] };
    },
  });
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  await client.transaction(async (tx) => {
    await tx.commit();
    await assert.rejects(tx.executeMany("INSERT INTO t VALUES (?)", [[1]]), TransactionError);
  });
  assert.equal(sent, 0);
});

test("a failed set keeps its per-set detail through a transaction and its rollback", async () => {
  const batch = {
    results: [1, null],
    failures: [
      {
        index: 1,
        code: -670,
        origin: "server" as const,
        kind: "unique-violation" as const,
        message: "duplicate",
      },
    ],
    executed: 2,
    rolledBack: false,
  };
  const connection = Object.assign(new FakeConnection(), {
    async executeMany(): Promise<ExecuteManyResult> {
      throw mapError(
        "query",
        new ExecuteManyError(new CasReplyError("duplicate", -2, -670), batch, []),
        "Failed to execute CUBRID batch.",
      );
    },
  });
  const client = createClient(baseOptions({ connectionFactory: () => connection }));

  const scope = await client.beginTransactionScope();
  await assert.rejects(scope.executeMany("INSERT INTO t VALUES (?)", [[1], [1]]), (error) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.kind, "unique-violation");
    assert.deepEqual(error.batch, batch);
    return true;
  });
  await scope.rollback();

  await assert.rejects(
    client.transaction((tx) => tx.executeMany("INSERT INTO t VALUES (?)", [[1], [1]])),
    (error) => {
      assert.ok(error instanceof TransactionError);
      assert.deepEqual(error.batch, batch);
      return true;
    },
  );
  assert.equal(connection.rollbackCalls, 2);
  assert.equal(connection.commitCalls, 0);
});

// ---------------------------------------------------------------------------
// Observed and unobserved statement failures (#244, ADR 0009): the outcome
// depends on whether a handler was attached, never on when a failure arrives
// ---------------------------------------------------------------------------

type Schedule = "early" | "late";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fails every statement whose SQL starts with BAD. In the early schedule it
 * fails at once, well before a callback that waits 10 ms returns; in the late
 * schedule 30 ms after it was issued, after such a callback returned.
 */
class ScheduledConnection extends RecordingConnection {
  readonly failure = new Error("statement failed");

  constructor(private readonly schedule: Schedule) {
    super();
  }

  override async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    if (!sql.startsWith("BAD")) {
      return super.query<T>(sql, params);
    }

    this.calls.push(`query:${sql}`);
    if (this.schedule === "late") {
      await delay(30);
    }
    this.calls.push(`failed:${sql}`);
    throw this.failure;
  }
}

/** Runs `body` in a transaction() callback that returns 10 ms after it, under one schedule. */
async function runScheduled(
  schedule: Schedule,
  body: (tx: StatementTransaction) => Promise<void>,
): Promise<{
  connection: ScheduledConnection;
  outcome: PromiseSettledResult<string>;
  unhandled: unknown[];
}> {
  const connection = new ScheduledConnection(schedule);
  let outcome: PromiseSettledResult<string> | undefined;

  const { unhandled } = await collectUnhandledRejections(async () => {
    [outcome] = await Promise.allSettled([
      transactionClient(connection).transaction(async (tx) => {
        await body(tx);
        await delay(10);
        connection.calls.push("returned");
        return "value";
      }),
    ]);
  });

  assert.ok(outcome);
  return { connection, outcome, unhandled };
}

/** Which of the two happened first, so each schedule is shown to be the one it claims. */
function failedBeforeReturn(connection: ScheduledConnection): boolean {
  const failed = connection.calls.indexOf("failed:BAD INSERT");
  const returned = connection.calls.indexOf("returned");
  assert.ok(failed >= 0 && returned >= 0);
  return failed < returned;
}

/** transaction() rolled back because a statement failed with `raw` and nothing observed it. */
function rejectsUnobserved(raw: unknown) {
  return (error: unknown) =>
    error instanceof TransactionError &&
    error.message === "Transaction failed." &&
    error.cause instanceof TransactionError &&
    error.cause.cause === raw;
}

const COMMITTED = "committed";
const ROLLED_BACK = "rolled back";

const SCHEDULED_CASES: Array<{
  name: string;
  body: (tx: StatementTransaction) => Promise<void>;
  /** Whether the late schedule's failure arrives after the callback returned. */
  detached: boolean;
  expected: typeof COMMITTED | typeof ROLLED_BACK;
}> = [
  {
    name: "awaited and caught, then continued",
    detached: false,
    expected: COMMITTED,
    body: async (tx) => {
      try {
        await tx.query("BAD INSERT");
      } catch {
        await tx.query("UPDATE");
      }
    },
  },
  {
    name: "awaited with .catch()",
    detached: false,
    expected: COMMITTED,
    body: async (tx) => {
      await tx.query("BAD INSERT").catch(() => undefined);
    },
  },
  {
    name: "Promise.allSettled",
    detached: false,
    expected: COMMITTED,
    body: async (tx) => {
      await Promise.allSettled([tx.query("BAD INSERT"), tx.query("OK")]);
    },
  },
  {
    name: "Promise.all, caught",
    detached: false,
    expected: COMMITTED,
    body: async (tx) => {
      await Promise.all([tx.query("BAD INSERT"), tx.query("OK")]).catch(() => undefined);
    },
  },
  {
    name: "a detached .catch()",
    detached: true,
    expected: COMMITTED,
    body: async (tx) => {
      tx.query("BAD INSERT").catch(() => undefined);
    },
  },
  {
    name: "a detached .then(f, g)",
    detached: true,
    expected: COMMITTED,
    body: async (tx) => {
      tx.query("BAD INSERT").then(
        () => undefined,
        () => undefined,
      );
    },
  },
  {
    name: "a detached .then(f).catch(g)",
    detached: true,
    expected: COMMITTED,
    body: async (tx) => {
      tx.query("BAD INSERT")
        .then(() => undefined)
        .catch(() => undefined);
    },
  },
  {
    name: "void tx.query()",
    detached: true,
    expected: ROLLED_BACK,
    body: async (tx) => {
      void tx.query("BAD INSERT");
    },
  },
  {
    name: "a promise kept but never touched",
    detached: true,
    expected: ROLLED_BACK,
    body: async (tx) => {
      const kept = [tx.query("BAD INSERT")];
      assert.equal(kept.length, 1);
    },
  },
];

for (const { name, body, detached, expected } of SCHEDULED_CASES) {
  for (const schedule of ["early", "late"] as const) {
    test(`statement failure ${name}, failing ${schedule}: ${expected}`, async () => {
      const { connection, outcome, unhandled } = await runScheduled(schedule, body);

      if (detached) {
        assert.equal(failedBeforeReturn(connection), schedule === "early");
      }
      assert.deepEqual(unhandled, []);

      if (expected === COMMITTED) {
        assert.deepEqual(outcome, { status: "fulfilled", value: "value" });
        assert.equal(connection.commitCalls, 1);
        assert.equal(connection.rollbackCalls, 0);
      } else {
        assert.equal(outcome.status, "rejected");
        assert.ok(rejectsUnobserved(connection.failure)(outcome.reason));
        assert.equal(connection.commitCalls, 0);
        assert.equal(connection.rollbackCalls, 1);
      }
      // END_TRAN is always the last thing sent, after every statement settled.
      assert.deepEqual(connection.calls.slice(-2), [
        expected === COMMITTED ? "commit" : "rollback",
        "close",
      ]);
      assert.ok(connection.calls.indexOf("failed:BAD INSERT") < connection.calls.length - 2);
    });
  }
}

for (const schedule of ["early", "late"] as const) {
  test(`a detached .then(f) without a rejection handler is not observation (${schedule})`, async () => {
    const { connection, outcome, unhandled } = await runScheduled(schedule, async (tx) => {
      // The derived promise carries the rejection. Nothing attaches a handler to it;
      // the base then() below only keeps this test free of an unhandled rejection,
      // and it bypasses the statement promise's own then(), as no caller code would.
      const derived = tx.query("BAD INSERT").then(() => undefined);
      Promise.prototype.then.call(derived, undefined, () => undefined);
    });

    assert.equal(outcome.status, "rejected");
    assert.ok(rejectsUnobserved(connection.failure)(outcome.reason));
    assert.equal(connection.commitCalls, 0);
    assert.deepEqual(unhandled, []);
  });

  test(`.finally() counts as observation, as await does (${schedule})`, async () => {
    const { connection, outcome, unhandled } = await runScheduled(schedule, async (tx) => {
      tx.query("BAD INSERT")
        .finally(() => undefined)
        .catch(() => undefined);
    });

    assert.deepEqual(outcome, { status: "fulfilled", value: "value" });
    assert.equal(connection.commitCalls, 1);
    assert.deepEqual(unhandled, []);
  });

  test(`a statement returned by the callback is observed and its failure rolls back (${schedule})`, async () => {
    const connection = new ScheduledConnection(schedule);

    await assert.rejects(
      transactionClient(connection).transaction((tx) => tx.query("BAD INSERT")),
      (error: unknown) =>
        error instanceof TransactionError &&
        error.cause instanceof TransactionError &&
        error.cause.cause === connection.failure,
    );
    assert.equal(connection.rollbackCalls, 1);
    assert.equal(connection.commitCalls, 0);
  });

  test(`an unobserved failure, failing ${schedule}, leaves the callback's own error as cause`, async () => {
    const failure = new Error("callback");
    const connection = new ScheduledConnection(schedule);

    const { unhandled } = await collectUnhandledRejections(() =>
      assert.rejects(
        transactionClient(connection).transaction(async (tx) => {
          void tx.query("BAD INSERT");
          await delay(10);
          throw failure;
        }),
        (error: unknown) => error instanceof TransactionError && error.cause === failure,
      ),
    );

    assert.deepEqual(unhandled, []);
    assert.equal(connection.commitCalls, 0);
    assert.equal(connection.rollbackCalls, 1);
  });

  test(`tx.commit() refuses an unobserved failure, failing ${schedule}`, async () => {
    const connection = new ScheduledConnection(schedule);
    let refused: unknown;

    const { unhandled } = await collectUnhandledRejections(() =>
      assert.rejects(
        transactionClient(connection).transaction(async (tx) => {
          void tx.query("BAD INSERT");
          await delay(10);
          refused = await tx.commit().catch((error: unknown) => error);
        }),
        TransactionError,
      ),
    );

    assert.ok(refused instanceof TransactionError);
    assert.equal(refused.cause, connection.failure);
    assert.deepEqual(unhandled, []);
    assert.equal(connection.commitCalls, 0);
    assert.equal(connection.rollbackCalls, 1);
  });

  test(`a statement after an unawaited tx.commit() is refused and the commit stands (${schedule})`, async () => {
    // As in 1.3.0: the caller chose the moment to commit. Slow or fast, the outcome is the same.
    const connection = new ScheduledConnection(schedule);
    connection.holdQueries();
    if (schedule === "early") {
      connection.releaseQuery?.();
    } else {
      setTimeout(() => connection.releaseQuery?.(), 30);
    }
    let late: unknown;

    await transactionClient(connection).transaction(async (tx) => {
      void tx.query("OK").catch(() => undefined);
      const commit = tx.commit();
      await delay(10);
      late = await tx.query("AFTER").catch((error: unknown) => error);
      await commit;
    });

    assert.ok(late instanceof TransactionError);
    // Refused either way; only the message says how far the commit had got.
    assert.match(
      late.message,
      /^Transaction (is already completing|has already been committed)\.$/,
    );
    assert.deepEqual(connection.calls.slice(-2), ["commit", "close"]);
    assert.ok(!connection.calls.includes("query:AFTER"));
  });

  test(`a detached handler sending a fallback after the callback returned never commits without it (${schedule})`, async () => {
    const { connection, outcome, unhandled } = await runScheduled(schedule, async (tx) => {
      tx.query("BAD INSERT")
        .catch(() => tx.query("UPDATE"))
        .catch(() => undefined);
    });

    assert.equal(failedBeforeReturn(connection), schedule === "early");
    assert.deepEqual(unhandled, []);

    if (schedule === "early") {
      // The fallback ran inside the callback, so it is part of the commit.
      assert.deepEqual(outcome, { status: "fulfilled", value: "value" });
      assert.ok(connection.calls.includes("queried:UPDATE"));
      assert.deepEqual(connection.calls.slice(-2), ["commit", "close"]);
    } else {
      // Refused while the client committed for the callback: rolled back, as in 1.3.0.
      assert.equal(outcome.status, "rejected");
      assert.ok(!connection.calls.includes("query:UPDATE"));
      assert.deepEqual(connection.calls.slice(-2), ["rollback", "close"]);
    }
  });
}

test("the cause is the first unobserved failure in issue order, not in settle order", async () => {
  const slow = new Error("issued first, fails last");
  const fast = new Error("issued second, fails first");
  const connection = new FakeConnection();
  connection.query = async (sql: string) => {
    if (sql === "SLOW") {
      await delay(20);
      throw slow;
    }
    throw fast;
  };

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      void tx.query("SLOW");
      void tx.query("FAST");
    }),
    rejectsUnobserved(slow),
  );

  await assert.rejects(
    transactionClient(connection).transaction(async (tx) => {
      tx.query("SLOW").catch(() => undefined);
      void tx.query("FAST");
    }),
    rejectsUnobserved(fast),
  );
  assert.equal(connection.commitCalls, 0);
});

test("a statement promise behaves as a promise: instanceof, await, Promise.resolve", async () => {
  const connection = new FakeConnection();
  connection.nextRows = [{ id: 1 }];

  await transactionClient(connection).transaction(async (tx) => {
    const statement = tx.query("SELECT");
    assert.ok(statement instanceof Promise);
    assert.deepEqual(await Promise.resolve(statement), [{ id: 1 }]);
    assert.deepEqual(await statement, [{ id: 1 }]);
    // A derived promise is still a promise.
    assert.ok(statement.then((rows) => rows.length) instanceof Promise);
  });
  assert.equal(connection.commitCalls, 1);
});
