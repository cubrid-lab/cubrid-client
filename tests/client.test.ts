import test from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/client/create-client.js";
import { CubridClient } from "../src/client/client.js";
import { CubridTransaction } from "../src/client/transaction.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { CasReplyError, ConnectionLostError } from "../src/errors/internal-errors.js";
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
import { MalformedReplyError, UnsupportedValueError } from "../src/protocol/protocol.js";
import { normalizeConfig } from "../src/internals/normalize-config.js";
import type {
  ClientOptions,
  ConnectionLike,
  ExecuteResult,
  PreparedTransactionClient,
  TransactionClient,
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

for (const maxLobBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
  test(`createClient rejects maxLobBytes ${maxLobBytes}`, () => {
    assert.throws(() => createClient({ ...baseOptions(), maxLobBytes }), RangeError);
  });
}

for (const readTimeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
  test(`createClient rejects readTimeout ${readTimeout}`, () => {
    assert.throws(() => createClient({ ...baseOptions(), readTimeout }), RangeError);
  });
}

test("normalizeConfig keeps a valid maxConnectionRetryCount", () => {
  assert.equal(normalizeConfig({ ...baseOptions(), maxConnectionRetryCount: 3 }).maxConnectionRetryCount, 3);
  assert.equal(normalizeConfig({ ...baseOptions(), maxConnectionRetryCount: 0 }).maxConnectionRetryCount, 0);
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

  const rows = await client.query<{ id: number; name: string }>(
    "SELECT id, name FROM users",
  );

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

  await assert.rejects(
    client.query("SELECT 1"),
    (error: unknown) => error instanceof QueryError,
  );

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

  assert.deepEqual(connection.calls, ["begin", "query:INSERT", "queried:INSERT", "commit", "close"]);
});

test("transaction connection factory failure propagates before anything can be closed", async () => {
  const failure = new Error("factory");
  const client = createClient(
    baseOptions({
      connectionFactory: () => Promise.reject(failure),
    }),
  );

  await assert.rejects(client.transaction(async () => "unused"), (error: unknown) => error === failure);
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
  ["an object whose toString throws", {
    toString() {
      throw new Error("no string form");
    },
  }],
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
      error instanceof ConnectionError &&
      error.message === "Health check failed.",
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
      error instanceof ConnectionError &&
      error.message === "Failed to get the server version.",
  );
});

test("client getServerVersion rejects when the connection cannot report a version", async () => {
  const client = createClient(baseOptions({ connectionFactory: () => new FakeConnection() }));

  await assert.rejects(
    client.getServerVersion(),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.message === "Failed to get the server version.",
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
    queryResult: (async () => ({ rows: [], columns: [] })) as NonNullable<ConnectionLike["queryResult"]>,
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
      error instanceof ConnectionError &&
      error.message === "Health check failed.",
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
  assert.equal(
    (mapError("query", error, "Query failed.") as QueryError).sqlState,
    "23000",
  );
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
    (error: Error) => error instanceof QueryError && error.cause instanceof Error &&
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
    await assert.rejects(run(keptTx as StatementTransaction, "LATE"), rejectsWith(ALREADY_COMMITTED));
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
  await assert.rejects(client.transaction(async () => undefined), TransactionError);
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
      (error: Error) => error instanceof QueryError && error.cause instanceof Error &&
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
