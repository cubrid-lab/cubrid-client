import test from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/client/create-client.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
} from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import type { ClientLogger, ConnectionLike } from "../src/types/client.js";

const PASSWORD = "s3cret-pw";
const PARAM = "bound-value-42";
const ROW_VALUE = "row-data-xyz";
const SQL_LITERAL = "literal-in-sql";

type Entry = { level: string; message: string; fields: Record<string, unknown> };

function recorder(): { logger: ClientLogger; entries: Entry[] } {
  const entries: Entry[] = [];
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown>): void => {
      entries.push({ level, message, fields });
    };
  return { logger: { debug: at("debug"), info: at("info"), error: at("error") }, entries };
}

function fakeConnection(fail?: Error): ConnectionLike {
  return {
    async connect() {},
    async query<T extends Record<string, unknown>>() {
      if (fail) {
        throw fail;
      }
      return [{ v: ROW_VALUE }] as unknown as T[];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    async close() {},
  };
}

function client(logger: unknown, connection: ConnectionLike) {
  return createClient({
    host: "db.example",
    database: "demodb",
    user: "dba",
    password: PASSWORD,
    logger,
    connectionFactory: () => connection,
  });
}

test("logger receives redacted query and connection events", async () => {
  const { logger, entries } = recorder();
  const c = client(logger, fakeConnection());

  const rows = await c.query(`SELECT '${SQL_LITERAL}' WHERE a = ?`, [PARAM]);
  assert.deepEqual(rows, [{ v: ROW_VALUE }]);

  assert.equal(entries[0]?.level, "info");
  assert.deepEqual(entries[0]?.fields, {
    operation: "connection",
    host: "db.example",
    port: 33000,
    database: "demodb",
  });
  const query = entries[1];
  assert.equal(query?.level, "debug");
  assert.equal(query?.fields.operation, "query");
  assert.equal(query?.fields.paramCount, 1);
  assert.equal(query?.fields.rowCount, 1);
  assert.equal(typeof query?.fields.durationMs, "number");

  const serialized = JSON.stringify(entries);
  for (const secret of [PASSWORD, PARAM, ROW_VALUE, SQL_LITERAL]) {
    assert.ok(!serialized.includes(secret), `${secret} leaked`);
  }
});

test("logger receives an error event without the error message", async () => {
  const { logger, entries } = recorder();
  const c = client(logger, fakeConnection(new Error(`bad ${PARAM} ${SQL_LITERAL}`)));

  await assert.rejects(() => c.query("SELECT 1", [PARAM]));

  const failure = entries.find((e) => e.level === "error");
  assert.equal(failure?.fields.operation, "query");
  assert.equal(failure?.fields.errorName, "Error");
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes(PARAM) && !serialized.includes(SQL_LITERAL));
});

test("logger sees one completion when a transaction callback commits by itself", async () => {
  const { logger, entries } = recorder();

  await client(logger, fakeConnection()).transaction(async (tx) => {
    await tx.commit();
    await assert.rejects(tx.commit());
    await assert.rejects(tx.query("SELECT 1"));
  });

  assert.deepEqual(
    entries.map((entry) => entry.fields.operation),
    ["connection", "beginTransaction", "commit", "close"],
  );
});

test("logger reports the rollback and close of a failed transaction", async () => {
  const { logger, entries } = recorder();
  const connection = fakeConnection();
  connection.rollback = () => Promise.reject(new Error("rollback"));
  connection.close = () => Promise.reject(new Error("close"));

  await assert.rejects(
    client(logger, connection).transaction(async () => {
      throw new Error("original");
    }),
    (error: unknown) =>
      error instanceof TransactionError &&
      (error.cause as Error).message === "original" &&
      error.rollbackError?.message === "rollback" &&
      error.closeError?.message === "close",
  );

  assert.deepEqual(
    entries.map((entry) => [entry.level, entry.fields.operation]),
    [
      ["info", "connection"],
      ["debug", "beginTransaction"],
      ["error", "rollback"],
      ["error", "close"],
    ],
  );
});

test("logger covers transactions", async () => {
  const { logger, entries } = recorder();
  await client(logger, fakeConnection()).transaction(async (tx) => {
    await tx.query("SELECT 1");
  });
  const ops = entries.map((e) => e.fields.operation);
  assert.deepEqual(ops, ["connection", "beginTransaction", "query", "commit", "close"]);
});

test("a throwing or non-conforming logger never affects requests", async () => {
  let calls = 0;
  const throwing = {
    debug() {
      calls += 1;
      throw new Error("logger broke");
    },
    info() {
      calls += 1;
      throw new Error("logger broke");
    },
  };
  assert.deepEqual(await client(throwing, fakeConnection()).query("SELECT 1"), [{ v: ROW_VALUE }]);
  assert.equal(calls, 2);
  assert.deepEqual(await client("not a logger", fakeConnection()).query("SELECT 1"), [
    { v: ROW_VALUE },
  ]);
  assert.deepEqual(await client({}, fakeConnection()).query("SELECT 1"), [{ v: ROW_VALUE }]);
});

test("queryResult is logged with its row count and only when the connection supports it", async () => {
  const { logger, entries } = recorder();
  const withResult = {
    ...fakeConnection(),
    queryResult: (async () => ({
      rows: [{ v: 1 }, { v: 2 }],
      columns: [],
    })) as NonNullable<ConnectionLike["queryResult"]>,
  };
  await client(logger, withResult).queryResult("SELECT v FROM t", [1]);
  const last = entries.at(-1)?.fields;
  assert.equal(last?.operation, "queryResult");
  assert.equal(last?.rowCount, 2);
  assert.equal(last?.paramCount, 1);
  await assert.rejects(() => client(logger, fakeConnection()).queryResult("SELECT 1"));
});

test("ping is exposed only when the connection supports it", async () => {
  const { logger, entries } = recorder();
  const withPing = { ...fakeConnection(), ping: async () => "11.4" };
  assert.equal(await client(logger, withPing).ping(), "11.4");
  assert.equal(entries.at(-1)?.fields.operation, "ping");
  await assert.rejects(() => client(logger, fakeConnection()).ping());
});

test("no logger leaves the connection untouched", async () => {
  const connection = fakeConnection();
  let seen: ConnectionLike | undefined;
  const c = createClient({
    host: "h",
    database: "d",
    user: "u",
    connectionFactory: () => (seen = connection),
  });
  await c.query("SELECT 1");
  assert.equal(seen, connection);
});

test("an async or thenable logger that rejects or throws is contained", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    let calls = 0;
    const asyncLogger = {
      async debug() {
        calls += 1;
        throw new Error("async logger broke");
      },
      async info() {
        calls += 1;
        throw new Error("async logger broke");
      },
    };
    const thenable = {
      debug() {
        calls += 1;
        return {
          then() {
            throw new Error("then broke");
          },
        };
      },
    };
    assert.deepEqual(await client(asyncLogger, fakeConnection()).query("SELECT 1"), [
      { v: ROW_VALUE },
    ]);
    assert.deepEqual(await client(thenable, fakeConnection()).query("SELECT 1"), [
      { v: ROW_VALUE },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a throwing or rejecting connection factory is logged and rethrown unchanged", async () => {
  const boom = new Error(`no connect ${PASSWORD}`);
  for (const factory of [
    () => {
      throw boom;
    },
    () => Promise.reject(boom),
  ]) {
    const { logger, entries } = recorder();
    const c = createClient({
      host: "db.example",
      database: "demodb",
      user: "dba",
      password: PASSWORD,
      logger,
      connectionFactory: factory,
    });
    await assert.rejects(
      () => c.query("SELECT 1"),
      (error: Error) => error.cause === boom,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, "error");
    assert.equal(entries[0]?.message, "cubrid-client: connection failed");
    assert.equal(entries[0]?.fields.operation, "connection");
    assert.equal(entries[0]?.fields.errorName, "Error");
    assert.equal(typeof entries[0]?.fields.durationMs, "number");
    assert.ok(!JSON.stringify(entries).includes(PASSWORD));
  }
});

test("errorName reports a fixed class name, never a custom Error.name", async () => {
  const cases: Array<[Error, string]> = [
    [Object.assign(new Error("x"), { name: PARAM }), "Error"],
    [Object.assign(new TypeError("x"), { name: PARAM }), "TypeError"],
    [new ReadTimeoutError(5), "ReadTimeoutError"],
    [new QueryError("x"), "QueryError"],
    [new ConstraintError("x"), "ConstraintError"],
    [new SqlSyntaxError("x"), "SqlSyntaxError"],
    [new DeadlockError("x"), "DeadlockError"],
    [new LockTimeoutError("x"), "LockTimeoutError"],
    [Object.assign(new ConstraintError("x"), { name: PARAM }), "ConstraintError"],
  ];
  for (const [error, expected] of cases) {
    const { logger, entries } = recorder();
    await assert.rejects(() => client(logger, fakeConnection(error)).query("SELECT 1"));
    const failure = entries.find((e) => e.level === "error");
    assert.equal(failure?.fields.errorName, expected);
    assert.ok(!JSON.stringify(entries).includes(PARAM));
  }

  const { logger, entries } = recorder();
  const factoryError = Object.assign(new Error("x"), { name: PARAM });
  const c = createClient({
    host: "h",
    database: "d",
    user: "u",
    logger,
    connectionFactory: () => Promise.reject(factoryError),
  });
  await assert.rejects(() => c.query("SELECT 1"));
  assert.equal(entries[0]?.fields.errorName, "Error");
  assert.ok(!JSON.stringify(entries).includes(PARAM));
});

test("logger reports execute without SQL, parameters or the insert id", async () => {
  const { logger, entries } = recorder();
  const connection = fakeConnection();
  connection.execute = async () => ({ affectedRows: 5, lastInsertId: 99 });
  const c = client(logger, connection);

  await c.execute(`INSERT INTO t VALUES ('${SQL_LITERAL}', ?)`, [PARAM]);

  const entry = entries.find((e) => e.fields.operation === "execute");
  assert.ok(entry);
  assert.equal(entry.level, "debug");
  assert.equal(entry.fields.paramCount, 1);
  // Only these fields may appear: no SQL, parameters, row counts or ids.
  assert.deepEqual(Object.keys(entry.fields).sort(), ["durationMs", "operation", "paramCount"]);
  const logged = JSON.stringify(entries);
  assert.equal(logged.includes(SQL_LITERAL), false);
  assert.equal(logged.includes(PARAM), false);
});

test("logger reports setTransactionOptions and the wrapper keeps the method", async () => {
  const { logger, entries } = recorder();
  const connection = fakeConnection();
  let applied: unknown;
  connection.setTransactionOptions = async (options) => {
    applied = options;
  };
  const c = client(logger, connection);

  await c.transaction(async () => undefined, { isolationLevel: "serializable" });

  assert.deepEqual(applied, { isolationLevel: "serializable" });
  const entry = entries.find((e) => e.fields.operation === "setTransactionOptions");
  assert.equal(entry?.level, "debug");
});

test("the logging wrapper does not claim setTransactionOptions for a connection without it", async () => {
  const { logger } = recorder();
  const c = client(logger, fakeConnection());

  await assert.rejects(
    c.transaction(async () => undefined, { isolationLevel: "serializable" }),
    (error: unknown) =>
      error instanceof TransactionError &&
      /does not support transaction options/.test(String(error.cause)),
  );
});

test("logger reports the prepared methods without SQL, parameters or rows", async () => {
  const { logger, entries } = recorder();
  const connection = fakeConnection();
  connection.queryPrepared = async <T>() => [{ v: ROW_VALUE }] as unknown as T[];
  connection.queryResultPrepared = async <T>() => ({
    rows: [{ v: ROW_VALUE }] as unknown as T[],
    columns: [],
  });
  connection.executePrepared = async () => ({ affectedRows: 5, lastInsertId: 99 });
  const c = client(logger, connection);
  const sql = `SELECT '${SQL_LITERAL}', ?`;

  await c.queryPrepared(sql, [PARAM]);
  await c.queryResultPrepared(sql, [PARAM]);
  await c.executePrepared(sql, [PARAM]);

  for (const [operation, rowCount] of [
    ["queryPrepared", 1],
    ["queryResultPrepared", 1],
    ["executePrepared", undefined],
  ] as const) {
    const entry = entries.find((e) => e.fields.operation === operation);
    assert.ok(entry);
    assert.equal(entry.fields.paramCount, 1);
    assert.equal(entry.fields.rowCount, rowCount);
  }
  const logged = JSON.stringify(entries);
  assert.equal(logged.includes(SQL_LITERAL), false);
  assert.equal(logged.includes(PARAM), false);
  assert.equal(logged.includes(ROW_VALUE), false);
});
