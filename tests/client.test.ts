import test from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/client/create-client.js";
import { CubridClient } from "../src/client/client.js";
import { CubridTransaction } from "../src/client/transaction.js";
import { NodeCubridAdapter } from "../src/adapters/node-cubrid.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { QueryError } from "../src/errors/query-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import { mapError } from "../src/internals/map-error.js";
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
    logger: undefined,
  });
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
