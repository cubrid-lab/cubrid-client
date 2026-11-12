/**
 * #112: `beginTransactionScope()` returns a handle that owns a dedicated
 * connection, so unrelated statements on the client can never join it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../src/client/create-client.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import type {
  ClientOptions,
  ConnectionLike,
  ExecuteResult,
  TransactionOptions,
  TransactionScope,
} from "../src/types/client.js";
import type { QueryParams } from "../src/types/query.js";

/** One physical connection; `log` is shared so cross-connection order is visible. */
class ScopeConnection implements ConnectionLike {
  readonly calls: string[] = [];
  readonly options: TransactionOptions[] = [];
  beginError?: Error;
  commitError?: Error;
  rollbackError?: Error;
  closeError?: Error;
  queryError?: Error | undefined;
  gate?: Promise<void>;

  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {}

  private record(call: string): void {
    this.calls.push(call);
    this.log.push(`${this.name}:${call}`);
  }

  async connect(): Promise<void> {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    _params?: QueryParams,
  ): Promise<T[]> {
    this.record(`query:${sql}`);
    await this.gate;
    if (this.queryError) {
      throw this.queryError;
    }
    return [] as T[];
  }

  async execute(sql: string): Promise<ExecuteResult> {
    this.record(`execute:${sql}`);
    return { affectedRows: 1 };
  }

  async setTransactionOptions(options: TransactionOptions): Promise<void> {
    this.record("options");
    this.options.push(options);
  }

  async beginTransaction(): Promise<void> {
    this.record("begin");
    if (this.beginError) throw this.beginError;
  }

  async commit(): Promise<void> {
    this.record("commit");
    if (this.commitError) throw this.commitError;
  }

  async rollback(): Promise<void> {
    this.record("rollback");
    if (this.rollbackError) throw this.rollbackError;
  }

  async close(): Promise<void> {
    this.record("close");
    if (this.closeError) throw this.closeError;
  }
}

function rejectsWith(message: string) {
  return (error: unknown) => error instanceof TransactionError && error.message === message;
}

function setup(overrides: Partial<ClientOptions> = {}) {
  const log: string[] = [];
  const connections: ScopeConnection[] = [];
  const client = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    ...overrides,
    connectionFactory: () => {
      const connection = new ScopeConnection(`c${connections.length}`, log);
      connections.push(connection);
      return connection;
    },
  });
  return { client, connections, log };
}

test("scope: statements run on a dedicated connection; client queries stay on the shared one", async () => {
  const { client, connections } = setup();
  await client.query("SELECT shared");
  const [shared] = connections;

  const tx = await client.beginTransactionScope();
  const own = connections[1]!;

  // An unrelated caller runs while the scope is open, interleaved with it.
  await Promise.all([
    tx.query("INSERT a"),
    client.query("SELECT unrelated"),
    tx.execute("UPDATE b"),
  ]);
  await tx.commit();

  assert.deepEqual(shared!.calls, ["query:SELECT shared", "query:SELECT unrelated"]);
  assert.deepEqual(own.calls, ["begin", "query:INSERT a", "execute:UPDATE b", "commit", "close"]);
  assert.equal(shared!.calls.includes("begin"), false);
});

test("scope: two scopes never share a connection", async () => {
  const { client, connections } = setup();

  const first = await client.beginTransactionScope();
  const second = await client.beginTransactionScope();
  await Promise.all([first.query("A"), second.query("B")]);
  await Promise.all([first.rollback(), second.commit()]);

  assert.equal(connections.length, 2);
  assert.deepEqual(connections[0]!.calls, ["begin", "query:A", "rollback", "close"]);
  assert.deepEqual(connections[1]!.calls, ["begin", "query:B", "commit", "close"]);
});

test("scope: exactly one outcome; later calls reject without reaching the connection", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();
  await tx.commit();
  const own = connections[0]!;
  const sent = own.calls.length;

  await assert.rejects(tx.query("SELECT late"), TransactionError);
  await assert.rejects(tx.execute("UPDATE late"), TransactionError);
  await assert.rejects(tx.commit(), TransactionError);
  await assert.rejects(tx.rollback(), TransactionError);

  assert.equal(own.calls.length, sent);
});

test("scope: a commit racing a second commit sends COMMIT once and closes once", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();

  const results = await Promise.allSettled([tx.commit(), tx.commit(), tx.rollback()]);

  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  assert.equal(results[2]!.status, "rejected");
  assert.deepEqual(connections[0]!.calls, ["begin", "commit", "close"]);
});

test("scope: commit waits for a statement still running, then refuses if nothing observed its failure", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();
  const own = connections[0]!;
  let release!: () => void;
  own.gate = new Promise((resolve) => {
    release = resolve;
  });
  own.queryError = new Error("constraint violated");

  // Not observed (ADR 0009): no handler was ever attached to it.
  void tx.query("INSERT dup");
  const committing = tx.commit();
  release();

  await assert.rejects(committing, (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.message, "Failed to commit.");
    return true;
  });
  // Never committed: the work is rolled back and the connection closed.
  assert.deepEqual(own.calls, ["begin", "query:INSERT dup", "rollback", "close"]);
});

test("scope: commit waits for a statement still running and commits past a failure the caller observed", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();
  const [own] = connections;
  assert.ok(own);
  let release!: () => void;
  own.gate = new Promise((resolve) => {
    release = resolve;
  });
  own.queryError = new Error("constraint violated");

  const handled = tx.query("INSERT dup").catch(() => "handled");
  const committing = tx.commit();
  release();
  await committing;

  assert.equal(await handled, "handled");
  assert.deepEqual(own.calls, ["begin", "query:INSERT dup", "commit", "close"]);
});

test("scope: a refused COMMIT rolls back, closes, and reports both failures", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();
  const own = connections[0]!;
  own.commitError = new Error("commit refused");
  own.rollbackError = new Error("rollback refused");
  own.closeError = new Error("close refused");

  await assert.rejects(tx.commit(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal((error.cause as Error).message, "commit refused");
    assert.equal(error.rollbackError?.message, "rollback refused");
    assert.equal(error.closeError?.message, "close refused");
    return true;
  });
  assert.deepEqual(own.calls, ["begin", "commit", "rollback", "close"]);
});

test("scope: a failed close after a successful commit does not report a failed commit", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();
  connections[0]!.closeError = new Error("socket already gone");

  await tx.commit();

  assert.deepEqual(connections[0]!.calls, ["begin", "commit", "close"]);
});

test("scope: a failed begin closes the connection and returns no handle", async () => {
  const log: string[] = [];
  const connection = new ScopeConnection("c0", log);
  connection.beginError = new Error("begin refused");
  const client = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: () => connection,
  });

  await assert.rejects(client.beginTransactionScope(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.message, "Failed to begin transaction.");
    assert.equal((error.cause as Error).message, "begin refused");
    return true;
  });
  assert.deepEqual(connection.calls, ["begin", "close"]);
});

test("scope: options apply to its own connection before BEGIN, client settings first", async () => {
  const { client, connections } = setup({ lockTimeout: 2000 });

  await client.beginTransactionScope({ isolationLevel: "serializable" });

  assert.deepEqual(connections[0]!.options, [
    { lockTimeout: 2000, isolationLevel: "serializable" },
  ]);
  assert.deepEqual(connections[0]!.calls, ["options", "begin"]);
});

test("scope: invalid options throw RangeError before any connection opens", async () => {
  const { client, connections } = setup();

  await assert.rejects(client.beginTransactionScope({ lockTimeout: -2 }), RangeError);
  await assert.rejects(
    client.beginTransactionScope({ isolationLevel: "dirty read" as "serializable" }),
    RangeError,
  );
  assert.equal(connections.length, 0);
});

test("scope: close() discards a scope nobody ended by closing its connection; later calls reject", async () => {
  const { client, connections } = setup();
  const tx: TransactionScope = await client.beginTransactionScope();
  await tx.query("INSERT a");
  const ended = await client.beginTransactionScope();
  await ended.commit();

  await client.close();

  // No ROLLBACK is queued behind the scope's statements: the server discards
  // the uncommitted work when the connection closes.
  assert.deepEqual(connections[0]!.calls, ["begin", "query:INSERT a", "close"]);
  assert.deepEqual(connections[1]!.calls, ["begin", "commit", "close"]);
  await assert.rejects(
    tx.query("SELECT late"),
    rejectsWith("Transaction was discarded because the client was closed."),
  );
  await assert.rejects(tx.commit(), TransactionError);
  await assert.rejects(tx.rollback(), TransactionError);
});

test("scope: close() does not wait for a scope statement that never settles", async () => {
  const { client, connections } = setup();
  await client.query("SELECT shared");
  const tx = await client.beginTransactionScope();
  const own = connections[1]!;
  // Waiting for a lock held by the shared connection's session, say.
  own.gate = new Promise(() => undefined);
  void tx.query("UPDATE r").catch(() => undefined);

  await client.close();

  assert.deepEqual(own.calls, ["begin", "query:UPDATE r", "close"]);
  assert.deepEqual(connections[0]!.calls.at(-1), "close");
});

test("scope: close() ignores a failed close of a scope nobody ended, and can run twice", async () => {
  const { client, connections } = setup();
  await client.beginTransactionScope();
  connections[0]!.closeError = new Error("socket already gone");

  await client.close();
  await client.close();

  assert.deepEqual(connections[0]!.calls, ["begin", "close"]);
});

test("scope: a failed explicit rollback is the cause, not also the rollbackError", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();
  connections[0]!.rollbackError = new Error("rollback refused");

  await assert.rejects(tx.rollback(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.message, "Failed to rollback.");
    assert.equal((error.cause as Error).message, "rollback refused");
    assert.equal(error.rollbackError, undefined);
    return true;
  });
  assert.deepEqual(connections[0]!.calls, ["begin", "rollback", "close"]);
});

test("scope: a failed statement the caller already saw does not block commit", async () => {
  const { client, connections } = setup();
  const tx = await client.beginTransactionScope();
  connections[0]!.queryError = new Error("duplicate key");

  await assert.rejects(tx.query("INSERT dup"), TransactionError);
  connections[0]!.queryError = undefined;
  await tx.commit();

  assert.deepEqual(connections[0]!.calls, ["begin", "query:INSERT dup", "commit", "close"]);
});

test("scope: failed transaction options close the connection and return no handle", async () => {
  const log: string[] = [];
  const connection = new ScopeConnection("c0", log);
  connection.setTransactionOptions = async () => {
    connection.calls.push("options");
    throw new Error("options refused");
  };
  const client = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: () => connection,
  });

  await assert.rejects(client.beginTransactionScope({ lockTimeout: 0 }), TransactionError);
  assert.deepEqual(connection.calls, ["options", "close"]);
});

test("scope: beginTransactionScope() after close() rejects and opens nothing", async () => {
  const { client, connections } = setup();
  await client.close();

  await assert.rejects(client.beginTransactionScope(), TransactionError);
  assert.equal(connections.length, 0);
});

test("scope: close() during the BEGIN of a scope closes that connection too", async () => {
  const log: string[] = [];
  let releaseBegin!: () => void;
  const connection = new ScopeConnection("c0", log);
  const beginGate = new Promise<void>((resolve) => {
    releaseBegin = resolve;
  });
  connection.beginTransaction = async () => {
    connection.calls.push("begin");
    await beginGate;
  };
  const client = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: () => connection,
  });

  const beginning = client.beginTransactionScope();
  beginning.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = client.close();
  releaseBegin();

  // close() resolves only once the scope's connection is closed too.
  await closing;
  assert.deepEqual(connection.calls, ["begin", "close"]);
  await assert.rejects(beginning, TransactionError);
});

test("scope: a deprecated manual transaction is unaffected and stays on the shared connection", async () => {
  const { client, connections } = setup();

  await client.beginTransaction();
  await client.query("INSERT a");
  await client.commit();

  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0]!.calls, ["begin", "query:INSERT a", "commit"]);
});
