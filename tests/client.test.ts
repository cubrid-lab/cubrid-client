import test from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/client/create-client.js";
import { CubridClient } from "../src/client/client.js";
import { CubridTransaction } from "../src/client/transaction.js";
import { NodeCubridAdapter } from "../src/adapters/node-cubrid.js";
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
import { mapResult } from "../src/internals/map-result.js";
import { normalizeConfig } from "../src/internals/normalize-config.js";
import type {
  ClientConfig,
  ClientOptions,
  ConnectionLike,
} from "../src/types/client.js";
import type { QueryParams } from "../src/types/query.js";
import type {
  NodeCubridDriver,
  NodeCubridRawConnection,
} from "../src/adapters/node-cubrid.js";

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

class FakeRawConnection implements NodeCubridRawConnection {
  connectCalls = 0;
  queryAllAsObjectsCalls = 0;
  queryAllCalls = 0;
  executeCalls = 0;
  executedStatements: string[] = [];
  autoCommitValues: boolean[] = [];
  commitCalls = 0;
  rollbackCalls = 0;
  endCalls = 0;
  queryAllAsObjectsResult: Record<string, unknown>[] = [];
  queryAllResult: unknown;
  connectError?: Error;
  queryError?: Error;
  autoCommitError?: Error;
  commitError?: Error;
  rollbackError?: Error;
  endError?: Error;
  useQueryAllAsObjects = true;

  async connect(): Promise<void> {
    this.connectCalls += 1;

    if (this.connectError) {
      throw this.connectError;
    }
  }

  queryAllAsObjects: NodeCubridRawConnection["queryAllAsObjects"] = async () => {
    this.queryAllAsObjectsCalls += 1;

    if (!this.useQueryAllAsObjects) {
      throw new Error("queryAllAsObjects should not be called");
    }

    if (this.queryError) {
      throw this.queryError;
    }

    return this.queryAllAsObjectsResult;
  };

  queryAll: NodeCubridRawConnection["queryAll"] = async () => {
    this.queryAllCalls += 1;

    if (this.queryError) {
      throw this.queryError;
    }

    return this.queryAllResult;
  };

  execute: NodeCubridRawConnection["execute"] = async (sql: string) => {
    this.executeCalls += 1;
    this.executedStatements.push(sql);
  };

  async setAutoCommitMode(enabled: boolean): Promise<void> {
    this.autoCommitValues.push(enabled);

    if (this.autoCommitError) {
      throw this.autoCommitError;
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

  async end(): Promise<void> {
    this.endCalls += 1;

    if (this.endError) {
      throw this.endError;
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

function baseConfig(): ClientConfig {
  return normalizeConfig(baseOptions());
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

test("mapResult maps driver column payloads to object rows", () => {
  assert.deepEqual(
    mapResult({
      ColumnNames: ["id", "name"],
      ColumnValues: [[1, "Alice"], [2, "Bob"]],
    }),
    [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ],
  );
});

test("mapResult returns an empty array for unsupported payloads", () => {
  assert.deepEqual(mapResult(undefined), []);
  assert.deepEqual(mapResult({ ok: true }), []);
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

test("node-cubrid adapter executes object queries", async () => {
  const raw = new FakeRawConnection();
  raw.queryAllAsObjectsResult = [{ id: 1 }];
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  const rows = await adapter.query<{ id: number }>("SELECT id FROM athlete");

  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(raw.queryAllAsObjectsCalls, 1);
});

test("node-cubrid adapter falls back to queryAll mapping when needed", async () => {
  const raw = new FakeRawConnection();
  raw.useQueryAllAsObjects = false;
  raw.queryAllResult = {
    ColumnNames: ["id", "name"],
    ColumnValues: [[1, "Alice"]],
  };
  raw.queryAllAsObjects = undefined as unknown as NodeCubridRawConnection["queryAllAsObjects"];
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  const rows = await adapter.query("SELECT id, name FROM users");

  assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
  assert.equal(raw.queryAllCalls, 1);
});

test("node-cubrid adapter connects only once across multiple queries", async () => {
  const raw = new FakeRawConnection();
  raw.queryAllAsObjectsResult = [{ id: 1 }];
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  await adapter.query("SELECT 1");
  await adapter.query("SELECT 2");

  assert.equal(raw.connectCalls, 1);
  assert.equal(raw.queryAllAsObjectsCalls, 2);
});

test("node-cubrid adapter throws when no query method is available", async () => {
  const raw = new FakeRawConnection();
  raw.queryAllAsObjects = undefined as unknown as NodeCubridRawConnection["queryAllAsObjects"];
  raw.queryAll = undefined as unknown as NodeCubridRawConnection["queryAll"];
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  await assert.rejects(
    adapter.query("SELECT 1"),
    (error: unknown) => error instanceof QueryError,
  );
});

test("node-cubrid adapter maps connection failures", async () => {
  const raw = new FakeRawConnection();
  raw.connectError = new Error("connect");
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  await assert.rejects(
    adapter.connect(),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.cause instanceof Error &&
      error.cause.message === "connect",
  );
});

test("node-cubrid adapter maps query failures", async () => {
  const raw = new FakeRawConnection();
  raw.queryError = new Error("query");
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  await assert.rejects(
    adapter.query("SELECT 1"),
    (error: unknown) =>
      error instanceof QueryError &&
      error.cause instanceof Error &&
      error.cause.message === "query",
  );
});

test("node-cubrid adapter begins transactions through auto-commit control", async () => {
  const raw = new FakeRawConnection();
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  await adapter.beginTransaction();

  assert.deepEqual(raw.autoCommitValues, [false]);
});

test("node-cubrid adapter maps beginTransaction failures", async () => {
  const raw = new FakeRawConnection();
  raw.autoCommitError = new Error("begin");
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  await assert.rejects(
    adapter.beginTransaction(),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "begin",
  );
});

test("node-cubrid adapter maps commit and rollback failures", async () => {
  const commitRaw = new FakeRawConnection();
  commitRaw.commitError = new Error("commit");
  const rollbackRaw = new FakeRawConnection();
  rollbackRaw.rollbackError = new Error("rollback");

  const commitAdapter = new NodeCubridAdapter(baseConfig(), async () => ({
    createConnection: () => commitRaw,
  }));
  const rollbackAdapter = new NodeCubridAdapter(baseConfig(), async () => ({
    createConnection: () => rollbackRaw,
  }));

  await assert.rejects(
    commitAdapter.commit(),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "commit",
  );

  await assert.rejects(
    rollbackAdapter.rollback(),
    (error: unknown) =>
      error instanceof TransactionError &&
      error.cause instanceof Error &&
      error.cause.message === "rollback",
  );
});

test("node-cubrid adapter closes raw connections and maps close failures", async () => {
  const raw = new FakeRawConnection();
  const adapter = new NodeCubridAdapter(baseConfig(), async () => ({
    createConnection: () => raw,
  }));

  await adapter.connect();
  await adapter.close();

  assert.equal(raw.endCalls, 1);

  const broken = new FakeRawConnection();
  broken.endError = new Error("end");
  const brokenAdapter = new NodeCubridAdapter(baseConfig(), async () => ({
    createConnection: () => broken,
  }));

  await brokenAdapter.connect();

  await assert.rejects(
    brokenAdapter.close(),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.cause instanceof Error &&
      error.cause.message === "end",
  );
});

test("node-cubrid adapter routes DDL/DML to execute instead of queryAllAsObjects", async () => {
  const raw = new FakeRawConnection();
  raw.queryAllAsObjectsResult = [{ id: 1 }];
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  // DDL statements should use execute(), not queryAllAsObjects()
  await adapter.query("CREATE TABLE test_ddl (id INT)");
  assert.equal(raw.executeCalls, 1);
  assert.equal(raw.queryAllAsObjectsCalls, 0);

  // DML statements should also use execute()
  await adapter.query("INSERT INTO test_ddl (id) VALUES (1)");
  assert.equal(raw.executeCalls, 2);

  await adapter.query("UPDATE test_ddl SET id = 2 WHERE id = 1");
  assert.equal(raw.executeCalls, 3);

  await adapter.query("DELETE FROM test_ddl WHERE id = 2");
  assert.equal(raw.executeCalls, 4);

  await adapter.query("DROP TABLE test_ddl");
  assert.equal(raw.executeCalls, 5);

  // SELECT should still use queryAllAsObjects()
  await adapter.query("SELECT 1");
  assert.equal(raw.queryAllAsObjectsCalls, 1);
  assert.equal(raw.executeCalls, 5);
});

test("node-cubrid adapter DDL/DML returns empty array", async () => {
  const raw = new FakeRawConnection();
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  const result = await adapter.query("CREATE TABLE ddl_test (id INT)");
  assert.deepEqual(result, []);
});

test("node-cubrid adapter handles DDL with leading whitespace", async () => {
  const raw = new FakeRawConnection();
  const driver: NodeCubridDriver = {
    createConnection: () => raw,
  };
  const adapter = new NodeCubridAdapter(baseConfig(), async () => driver);

  await adapter.query("  \n  INSERT INTO t (id) VALUES (1)");
  assert.equal(raw.executeCalls, 1);
  assert.equal(raw.queryAllAsObjectsCalls, 0);
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
// mapResult edge case: array input passthrough
// ---------------------------------------------------------------------------

test("mapResult passes through array input unchanged", () => {
  const input = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(mapResult(input), input);
});

// ---------------------------------------------------------------------------
// NodeCubridAdapter close when no connection exists
// ---------------------------------------------------------------------------

test("node-cubrid adapter close is a no-op when no connection was created", async () => {
  const adapter = new NodeCubridAdapter(baseConfig(), async () => ({
    createConnection: () => new FakeRawConnection(),
  }));

  // close without ever connecting - should not throw
  await adapter.close();
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
