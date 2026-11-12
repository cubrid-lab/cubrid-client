/**
 * CubridClient.close() and transaction() callbacks (#246): close() waits for
 * every callback already running, with its COMMIT or ROLLBACK and connection
 * close, refuses the ones that have not started, and returns one promise to
 * every caller. destroy() ends that wait.
 *
 * Every connection here is a fake whose operations log to one list in the order
 * they happen, so each test asserts the exact sequence, that each statement was
 * sent once (no replay) and that every connection opened was closed once.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "../src/client/create-client.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import type { ConnectionLike } from "../src/types/client.js";
import type { QueryParams } from "../src/types/query.js";

interface Gate {
  promise: Promise<void>;
  open: () => void;
  fail: (error: Error) => void;
}

function gate(): Gate {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // Rejected before anything awaits it in some tests.
  promise.catch(() => undefined);
  return { promise, open, fail };
}

/** Lets every pending callback, and the ones they schedule, run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type Operation = "begin" | "query" | "commit" | "rollback" | "close";

class LoggedConnection implements ConnectionLike {
  readonly calls: Operation[] = [];
  /** Operations that wait for the gate before they complete. */
  readonly gates = new Map<Operation, Gate>();
  destroyed = false;
  private lost: Error | undefined;

  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {}

  hold(operation: Operation): Gate {
    const held = gate();
    this.gates.set(operation, held);
    return held;
  }

  private async run(operation: Operation, detail = ""): Promise<void> {
    if (this.lost) {
      throw this.lost;
    }
    this.calls.push(operation);
    this.log.push(`${this.name}:${operation}${detail}`);
    const held = this.gates.get(operation);
    if (held) {
      this.gates.delete(operation);
      await held.promise;
    }
    if (this.lost) {
      throw this.lost;
    }
  }

  async connect(): Promise<void> {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    _params?: QueryParams,
  ): Promise<T[]> {
    await this.run("query", ` ${sql}`);
    return [] as T[];
  }

  beginTransaction(): Promise<void> {
    return this.run("begin");
  }

  commit(): Promise<void> {
    return this.run("commit");
  }

  rollback(): Promise<void> {
    return this.run("rollback");
  }

  close(): Promise<void> {
    return this.run("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.lost = new Error("Connection lost.");
    this.log.push(`${this.name}:destroy`);
    for (const held of this.gates.values()) {
      held.fail(this.lost);
    }
    this.gates.clear();
  }
}

interface Harness {
  client: ReturnType<typeof createClient>;
  log: string[];
  connections: LoggedConnection[];
  /** Holds the next factory call until the gate opens. */
  holdFactory: () => Gate;
  /** Holds `operation` on the next connection opened. */
  holdNext: (operation: Operation) => Gate;
}

function harness(): Harness {
  const log: string[] = [];
  const connections: LoggedConnection[] = [];
  let factoryGate: Gate | undefined;
  const nextHolds = new Map<Operation, Gate>();
  const client = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
    connectionFactory: async () => {
      const connection = new LoggedConnection(`c${connections.length + 1}`, log);
      connections.push(connection);
      for (const [operation, held] of nextHolds) {
        connection.gates.set(operation, held);
      }
      nextHolds.clear();
      log.push(`${connection.name}:open`);
      const held = factoryGate;
      factoryGate = undefined;
      if (held) {
        await held.promise;
        log.push(`${connection.name}:opened`);
      }
      return connection;
    },
  });
  return {
    client,
    log,
    connections,
    holdFactory: () => {
      factoryGate = gate();
      return factoryGate;
    },
    holdNext: (operation) => {
      const held = gate();
      nextHolds.set(operation, held);
      return held;
    },
  };
}

/** Records in `log` when `promise` settles, and never rejects. */
function track(log: string[], name: string, promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => {
      log.push(`${name}:resolved`);
    },
    (error: unknown) => {
      log.push(`${name}:rejected`);
      throw error;
    },
  ) as Promise<void>;
}

function assertEachClosedOnce(connections: LoggedConnection[]): void {
  for (const connection of connections) {
    assert.equal(
      connection.calls.filter((call) => call === "close").length,
      1,
      `${connection.name} closed once`,
    );
  }
}

function isClientClosed(error: unknown): boolean {
  return (
    error instanceof TransactionError &&
    error.cause instanceof Error &&
    error.cause.message === "Client is closed."
  );
}

test("close() during the connection factory sends nothing on the connection and closes it", async () => {
  const { client, log, connections, holdFactory } = harness();
  const factory = holdFactory();
  let started = false;

  const transaction = track(
    log,
    "tx",
    client.transaction(async (tx) => {
      started = true;
      await tx.query("INSERT 1");
    }),
  );
  await settle();
  const closing = track(log, "closeCall", client.close());
  await settle();
  assert.ok(!log.includes("closeCall:resolved"), "close() waits for the opening connection");

  factory.open();
  await assert.rejects(transaction, isClientClosed);
  await closing;

  assert.equal(started, false);
  assert.deepEqual(log, ["c1:open", "c1:opened", "c1:close", "tx:rejected", "closeCall:resolved"]);
  assertEachClosedOnce(connections);
});

test("close() during BEGIN never starts the callback and rolls back", async () => {
  const { client, log, connections, holdNext } = harness();
  const begin = holdNext("begin");
  let started = false;

  const transaction = track(
    log,
    "tx",
    client.transaction(async () => {
      started = true;
    }),
  );
  await settle();
  assert.equal(log.at(-1), "c1:begin");
  const closing = track(log, "closeCall", client.close());
  await settle();
  assert.ok(!log.includes("closeCall:resolved"), "close() waits for BEGIN");

  begin.open();
  await assert.rejects(transaction, isClientClosed);
  await closing;

  assert.equal(started, false);
  assert.deepEqual(log, [
    "c1:open",
    "c1:begin",
    "c1:rollback",
    "c1:close",
    "tx:rejected",
    "closeCall:resolved",
  ]);
  assertEachClosedOnce(connections);
});

test("close() during an active query waits for the callback and its COMMIT", async () => {
  const { client, log, connections } = harness();
  const ready = gate();
  let release!: Gate;

  const transaction = track(
    log,
    "tx",
    client.transaction(async (tx) => {
      release = (connections[0] as LoggedConnection).hold("query");
      ready.open();
      await tx.query("INSERT 1");
      return "done";
    }),
  );
  await ready.promise;
  await settle();

  const closing = track(log, "closeCall", client.close());
  // The gate is shut in the same tick.
  await assert.rejects(
    client.transaction(async () => undefined),
    isClientClosed,
  );
  await assert.rejects(client.beginTransactionScope(), isClientClosed);
  await settle();
  assert.ok(!log.includes("closeCall:resolved"), "close() waits for the running callback");

  release.open();
  await transaction;
  await closing;

  assert.deepEqual(log, [
    "c1:open",
    "c1:begin",
    "c1:query INSERT 1",
    "c1:commit",
    "c1:close",
    "tx:resolved",
    "closeCall:resolved",
  ]);
  assert.equal(connections.length, 1, "the refused calls opened nothing");
  assertEachClosedOnce(connections);
});

test("close() during a callback that fails waits for its ROLLBACK and keeps the error", async () => {
  const { client, log, connections } = harness();
  const ready = gate();
  const proceed = gate();
  const failure = new Error("callback failed");

  const transaction = track(
    log,
    "tx",
    client.transaction(async (tx) => {
      await tx.query("INSERT 1");
      ready.open();
      await proceed.promise;
      throw failure;
    }),
  );
  await ready.promise;
  const closing = track(log, "closeCall", client.close());
  await settle();
  assert.ok(!log.includes("closeCall:resolved"));

  proceed.open();
  await assert.rejects(
    transaction,
    (error: unknown) => error instanceof TransactionError && error.cause === failure,
  );
  await closing;

  assert.deepEqual(log, [
    "c1:open",
    "c1:begin",
    "c1:query INSERT 1",
    "c1:rollback",
    "c1:close",
    "tx:rejected",
    "closeCall:resolved",
  ]);
  assertEachClosedOnce(connections);
});

for (const outcome of ["commit", "rollback"] as const) {
  test(`close() during an explicit tx.${outcome}() waits for it and the connection close`, async () => {
    const { client, log, connections } = harness();
    const ready = gate();
    let release!: Gate;

    const transaction = track(
      log,
      "tx",
      client.transaction(async (tx) => {
        await tx.query("INSERT 1");
        release = (connections[0] as LoggedConnection).hold(outcome);
        const ending = tx[outcome]();
        ready.open();
        await ending;
      }),
    );
    await ready.promise;
    await settle();
    assert.equal(log.at(-1), `c1:${outcome}`);

    const closing = track(log, "closeCall", client.close());
    await settle();
    assert.ok(!log.includes("closeCall:resolved"), `close() waits for ${outcome}`);

    release.open();
    await transaction;
    await closing;

    assert.deepEqual(log, [
      "c1:open",
      "c1:begin",
      "c1:query INSERT 1",
      `c1:${outcome}`,
      "c1:close",
      "tx:resolved",
      "closeCall:resolved",
    ]);
    assertEachClosedOnce(connections);
  });
}

test("close() while close() is running returns the same promise and closes each connection once", async () => {
  const { client, log, connections } = harness();
  await client.query("SELECT 1");
  const ready = gate();
  let release!: Gate;

  const transaction = client.transaction(async (tx) => {
    release = (connections[1] as LoggedConnection).hold("query");
    ready.open();
    await tx.query("INSERT 1");
  });
  await ready.promise;

  const first = client.close();
  const second = client.close();
  assert.equal(first, second);
  await settle();
  const third = client.close();
  assert.equal(first, third);

  release.open();
  await transaction;
  await first;
  assert.equal(client.close(), first);

  assert.deepEqual(
    log.filter((entry) => entry.startsWith("c2:")),
    ["c2:open", "c2:begin", "c2:query INSERT 1", "c2:commit", "c2:close"],
  );
  assert.equal(log.filter((entry) => entry === "c2:query INSERT 1").length, 1, "no replay");
  assertEachClosedOnce(connections);
});

test("a failed close() is returned again rather than retried, until destroy()", async () => {
  const { client, connections } = harness();
  await client.query("SELECT 1");
  const shared = connections[0] as LoggedConnection;
  shared.hold("close").fail(new Error("close failed"));

  const first = client.close();
  await assert.rejects(first, ConnectionError);
  assert.equal(client.close(), first);
  assert.deepEqual(shared.calls, ["query", "close"]);

  await client.destroy();
  await client.close();
});

test("close() inside a callback does not wait for that callback, which then commits", async () => {
  const { client, log, connections } = harness();
  let closing: Promise<void> | undefined;

  const result = await client.transaction(async (tx) => {
    await tx.query("INSERT 1");
    closing = client.close();
    await closing;
    await tx.query("INSERT 2");
    return "done";
  });
  await closing;

  assert.equal(result, "done");
  assert.deepEqual(log, [
    "c1:open",
    "c1:begin",
    "c1:query INSERT 1",
    "c1:query INSERT 2",
    "c1:commit",
    "c1:close",
  ]);
  assertEachClosedOnce(connections);
});

test("two callbacks that both await close() do not wait for each other, and both commit", async () => {
  const { client, log, connections } = harness();
  const bothRunning = gate();
  let running = 0;
  const body =
    (name: string) => async (tx: Parameters<Parameters<typeof client.transaction>[0]>[0]) => {
      await tx.query(name);
      running += 1;
      if (running === 2) {
        bothRunning.open();
      }
      await bothRunning.promise;
      await client.close();
      await tx.query(`${name} after close`);
    };

  await Promise.all([client.transaction(body("A")), client.transaction(body("B"))]);
  await client.close();

  assert.equal(log.filter((entry) => entry.endsWith(":commit")).length, 2);
  for (const connection of connections) {
    assert.deepEqual(connection.calls, ["begin", "query", "query", "commit", "close"]);
  }
});

test("close() from a timer a callback set waits for its COMMIT once the callback returned", async () => {
  const { client, log, connections } = harness();
  const commit = gate();
  let closing: Promise<void> | undefined;
  const scheduled = gate();

  const transaction = client.transaction(async (tx) => {
    await tx.query("INSERT 1");
    (connections[0] as LoggedConnection).gates.set("commit", commit);
    setTimeout(() => {
      closing = track(log, "closeCall", client.close());
      scheduled.open();
    }, 0);
  });
  await scheduled.promise;
  await settle();
  assert.ok(!log.includes("closeCall:resolved"), "close() waits for the COMMIT in flight");

  commit.open();
  await transaction;
  await closing;
  assert.deepEqual(log, [
    "c1:open",
    "c1:begin",
    "c1:query INSERT 1",
    "c1:commit",
    "c1:close",
    "closeCall:resolved",
  ]);
});

test("a close() that fails inside a callback rejects there, and the callback rolls back", async () => {
  const { client, connections } = harness();
  await client.query("SELECT 1");
  (connections[0] as LoggedConnection).hold("close").fail(new Error("close failed"));

  await assert.rejects(
    client.transaction(async (tx) => {
      await tx.query("INSERT 1");
      await client.close();
    }),
    (error: unknown) => error instanceof TransactionError && error.cause instanceof ConnectionError,
  );
  assert.deepEqual(connections[1]?.calls, ["begin", "query", "rollback", "close"]);
  await assert.rejects(client.close(), ConnectionError);
});

test("close() inside a nested callback waits for neither enclosing callback", async () => {
  const { client, connections } = harness();

  await client.transaction(async (outer) => {
    await outer.query("OUTER");
    await client.transaction(async (inner) => {
      await inner.query("INNER");
      await client.close();
    });
  });

  assert.deepEqual(connections[0]?.calls, ["begin", "query", "commit", "close"]);
  assert.deepEqual(connections[1]?.calls, ["begin", "query", "commit", "close"]);
});

test("close() inside a callback waits for no other callback; close() outside still does", async () => {
  const { client, log, connections } = harness();
  const ready = gate();
  let release!: Gate;

  const other = client.transaction(async (tx) => {
    release = (connections[0] as LoggedConnection).hold("query");
    ready.open();
    await tx.query("OTHER");
  });
  await ready.promise;

  await client.transaction(async (tx) => {
    await tx.query("OWN");
    await client.close();
    log.push("insideClose:resolved");
  });
  const outside = track(log, "outsideClose", client.close());
  await settle();
  assert.ok(log.indexOf("insideClose:resolved") < log.indexOf("c2:commit"));
  assert.ok(!log.includes("outsideClose:resolved"), "close() outside waits for OTHER");
  assert.ok(log.includes("c2:commit"));

  release.open();
  await other;
  await outside;
  assert.ok(log.indexOf("c1:commit") < log.indexOf("outsideClose:resolved"));
  assertEachClosedOnce(connections);
});

test("destroy() ends a close() waiting for a callback, and no COMMIT is sent", async () => {
  const { client, log, connections } = harness();
  const ready = gate();
  const proceed = gate();

  const transaction = client.transaction(async (tx) => {
    await tx.query("INSERT 1");
    ready.open();
    // Work that is not a statement, so destroying the connection cannot end it.
    await proceed.promise;
    await tx.query("INSERT 2");
  });
  await ready.promise;

  const closing = client.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await settle();
  assert.equal(closed, false);

  await client.destroy();
  await closing;
  assert.ok(connections[0]?.destroyed);

  proceed.open();
  await assert.rejects(transaction, TransactionError);
  assert.ok(!log.includes("c1:commit"), "no COMMIT after destroy()");
  assert.ok(!log.includes("c1:query INSERT 2"));
});

test("close() with no transaction() and no shared connection resolves at once", async () => {
  const { client, connections } = harness();
  await client.close();
  await assert.rejects(
    client.transaction(async () => undefined),
    isClientClosed,
  );
  assert.equal(connections.length, 0);
});
