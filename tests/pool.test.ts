/**
 * createPool() (#92). Offline: fake connections and, at the end, a stub CAS
 * over real TCP. The pool must hand a connection to callers in arrival order,
 * never open more than `max`, and reuse a session only when it is clean: no
 * open transaction, nothing still running, no request with an unknown outcome
 * and no transaction settings other than the pool's (ADR 0008).
 */

import assert from "node:assert/strict";
import { createServer, type Socket as NetSocket, type Server } from "node:net";
import test, { type TestContext } from "node:test";

import { type CubridPool, createPool } from "../src/client/pool.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { QueryError } from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import { SESSION_STATE, type SessionState } from "../src/internals/session-state.js";
import type {
  ClientLogFields,
  ConnectionLike,
  ExecuteResult,
  TransactionOptions,
} from "../src/types/client.js";
import { blob, clob, LobParamError, type PreparedQueryParam } from "../src/types/lob.js";
import type { PoolConnection, PoolOptions } from "../src/types/pool.js";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback and I/O event run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Whether `promise` has settled by now. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flush();
  return settled;
}

function hasKind(kind: string) {
  return (error: unknown) => error instanceof ConnectionError && error.kind === kind;
}

/** Counts statements running at once across every fake connection. */
interface Concurrency {
  running: number;
  peak: number;
}

/** A connection that cannot report its session state, like a 1.x custom one. */
class FakeConnection implements ConnectionLike {
  readonly calls: string[] = [];
  closed = false;
  connectGate?: Promise<void>;
  connectError?: Error;
  gate?: Promise<void>;
  queryError?: Error | undefined;
  pingError?: Error | undefined;
  rollbackError?: Error;
  concurrency?: Concurrency;

  constructor(readonly id: number) {}

  async connect(): Promise<void> {
    this.calls.push("connect");
    await this.connectGate;
    if (this.connectError) throw this.connectError;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<T[]> {
    this.calls.push(`query:${sql}`);
    const concurrency = this.concurrency;
    if (concurrency) {
      concurrency.running += 1;
      concurrency.peak = Math.max(concurrency.peak, concurrency.running);
      await flush();
      concurrency.running -= 1;
    }
    await this.gate;
    if (this.queryError) {
      const error = this.queryError;
      this.queryError = undefined;
      throw error;
    }
    return [{ id: this.id, sql }] as unknown as T[];
  }

  async execute(sql: string): Promise<ExecuteResult> {
    this.calls.push(`execute:${sql}`);
    return { affectedRows: 1 };
  }

  readonly preparedParams: Array<readonly PreparedQueryParam[] | undefined> = [];

  async executePrepared(
    sql: string,
    params?: readonly PreparedQueryParam[],
  ): Promise<ExecuteResult> {
    this.calls.push(`executePrepared:${sql}`);
    this.preparedParams.push(params);
    return { affectedRows: 1 };
  }

  beginError?: Error;

  async beginTransaction(): Promise<void> {
    this.calls.push("begin");
    if (this.beginError) throw this.beginError;
  }

  async commit(): Promise<void> {
    this.calls.push("commit");
  }

  async rollback(): Promise<void> {
    this.calls.push("rollback");
    if (this.rollbackError) throw this.rollbackError;
  }

  async close(): Promise<void> {
    this.calls.push("close");
    this.closed = true;
  }

  async ping(): Promise<string> {
    this.calls.push("ping");
    if (this.pingError) throw this.pingError;
    return "11.4.0.0";
  }

  async setTransactionOptions(options: TransactionOptions): Promise<void> {
    this.calls.push(`options:${JSON.stringify(options)}`);
  }

  async *stream<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): AsyncGenerator<T, void, undefined> {
    this.calls.push(`stream:${sql}`);
    for (let row = 0; row < 3; row += 1) {
      await flush();
      yield { id: this.id, row } as unknown as T;
    }
  }
}

/** A connection that reports its session state, as NativeCubridAdapter does. */
class StatefulConnection extends FakeConnection {
  state: SessionState = { inTransaction: false, busy: false, failedExchanges: 0, connected: true };

  [SESSION_STATE](): SessionState {
    return { ...this.state };
  }

  override async beginTransaction(): Promise<void> {
    await super.beginTransaction();
    this.state.inTransaction = true;
  }

  override async commit(): Promise<void> {
    await super.commit();
    this.state.inTransaction = false;
  }

  override async rollback(): Promise<void> {
    await super.rollback();
    this.state.inTransaction = false;
  }
}

interface SetupOptions {
  stateful?: boolean;
  prepare?: (connection: FakeConnection) => void;
}

function setup(
  options: Partial<PoolOptions> = {},
  { stateful = true, prepare }: SetupOptions = {},
) {
  const connections: FakeConnection[] = [];
  const events: ClientLogFields[] = [];
  const record = (_message: string, fields: ClientLogFields): void => {
    if (fields.operation?.startsWith("pool.")) {
      events.push(fields);
    }
  };
  const pool = createPool({
    host: "localhost",
    database: "demodb",
    user: "dba",
    logger: { info: record, error: record },
    ...options,
    connectionFactory: () => {
      const id = connections.length;
      const connection = stateful ? new StatefulConnection(id) : new FakeConnection(id);
      prepare?.(connection);
      connections.push(connection);
      return connection;
    },
  });
  const destroyed = (): Array<string | undefined> =>
    events.filter((event) => event.operation === "pool.destroy").map((event) => event.reason);
  return { pool, connections, events, destroyed };
}

/** Holds the only connection of a `max: 1` pool until `release()` is called. */
async function holdConnection(pool: CubridPool) {
  const gate = deferred();
  const held = pool.connection(async (connection) => {
    await connection.query("HOLD");
    await gate.promise;
  });
  await flush();
  return {
    release: async () => {
      gate.resolve();
      await held;
    },
  };
}

/**
 * Fake setTimeout and, with `withDate`, Date. Node.js 20.11 and later take an
 * options object; Node.js 18 takes a list of timer names and cannot mock Date.
 */
function useFakeTimers(t: TestContext, withDate: boolean): boolean {
  const apis = withDate ? ["setTimeout", "Date"] : ["setTimeout"];
  const enable = t.mock.timers.enable.bind(t.mock.timers) as (options: unknown) => void;
  try {
    enable({ apis });
    return true;
  } catch {
    if (withDate) {
      return false;
    }
    enable(apis);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const BASE = { host: "localhost", database: "demodb", user: "dba" } as const;

for (const [name, value] of [
  ["max", 0],
  ["max", 1.5],
  ["max", Number.NaN],
  ["min", -1],
  ["min", 11],
  ["acquireTimeoutMs", 0],
  ["acquireTimeoutMs", 2 ** 31],
  ["maxWaitingClients", -1],
  ["maxWaitingClients", 0.5],
  ["maxWaitingClients", Number.NaN],
  ["idleTimeoutMs", -1],
  ["idleTimeoutMs", Number.POSITIVE_INFINITY],
  ["maxLifetimeMs", 0],
  ["validateAfterIdleMs", -1],
] as const) {
  test(`createPool() refuses ${name} ${value} with a RangeError`, () => {
    assert.throws(() => createPool({ ...BASE, [name]: value }), RangeError);
  });
}

test("createPool() accepts the documented limits and opens nothing without min", () => {
  let opened = 0;
  const pool = createPool({
    ...BASE,
    max: 3,
    min: 0,
    maxWaitingClients: Number.POSITIVE_INFINITY,
    idleTimeoutMs: 0,
    maxLifetimeMs: 1,
    validateAfterIdleMs: 0,
    connectionFactory: () => {
      opened += 1;
      return new FakeConnection(opened);
    },
  });
  assert.equal(opened, 0);
  assert.deepEqual(pool.stats(), { total: 0, idle: 0, active: 0, pending: 0, waiting: 0 });
});

test("createPool() validates the client options too", () => {
  assert.throws(() => createPool({ ...BASE, isolationLevel: "dirty" as never }), RangeError);
  assert.throws(() => createPool({ ...BASE, readTimeout: -1 }), RangeError);
});

// ---------------------------------------------------------------------------
// Order and limits
// ---------------------------------------------------------------------------

test("pool: waiting callers are served in arrival order, and a release goes straight to the first", async () => {
  const { pool, connections } = setup({ max: 1 });
  const holder = await holdConnection(pool);

  const order: string[] = [];
  const waiting = ["B", "C", "D"].map((sql) =>
    pool.query(sql).then(() => {
      order.push(sql);
    }),
  );
  await flush();
  assert.equal(pool.stats().waiting, 3);

  await holder.release();
  // The connection was handed to B on release, not parked as idle where a caller
  // arriving now could take it ahead of C and D.
  assert.deepEqual(pool.stats(), { total: 1, idle: 0, active: 1, pending: 0, waiting: 2 });
  const late = pool.query("E").then(() => {
    order.push("E");
  });
  assert.equal(pool.stats().waiting, 3);

  await Promise.all([...waiting, late]);
  assert.deepEqual(order, ["B", "C", "D", "E"]);
  assert.equal(connections.length, 1);
  await pool.close();
});

test("pool: 1000 concurrent callers never open more than max connections", async () => {
  const concurrency: Concurrency = { running: 0, peak: 0 };
  const { pool, connections } = setup(
    { max: 5 },
    {
      prepare: (connection) => {
        connection.concurrency = concurrency;
      },
    },
  );

  let peakTotal = 0;
  const calls = Array.from({ length: 1000 }, (_, index) =>
    pool.query(`SELECT ${index}`).then((rows) => {
      peakTotal = Math.max(peakTotal, pool.stats().total);
      return rows;
    }),
  );
  peakTotal = Math.max(peakTotal, pool.stats().total);
  const results = await Promise.all(calls);

  assert.equal(results.length, 1000);
  assert.ok(connections.length <= 5, `opened ${connections.length}`);
  assert.ok(concurrency.peak <= 5, `peak ${concurrency.peak}`);
  assert.ok(peakTotal <= 5, `total ${peakTotal}`);
  assert.deepEqual(pool.stats(), {
    total: connections.length,
    idle: connections.length,
    active: 0,
    pending: 0,
    waiting: 0,
  });
  await pool.close();
});

test("pool: a caller waiting longer than acquireTimeoutMs rejects with kind pool-timeout", async (t) => {
  useFakeTimers(t, false);
  const { pool, events } = setup({ max: 1, acquireTimeoutMs: 100 });
  const holder = await holdConnection(pool);

  const waiting = pool.query("B");
  t.mock.timers.tick(99);
  assert.equal(await isSettled(waiting), false);
  t.mock.timers.tick(1);
  await assert.rejects(waiting, hasKind("pool-timeout"));
  assert.equal(pool.stats().waiting, 0);
  assert.ok(events.some((event) => event.operation === "pool.acquire-timeout"));

  await holder.release();
  assert.equal(pool.stats().idle, 1);
  await pool.close();
});

test("pool: a signal aborted while waiting leaves the line, and nothing is stranded", async () => {
  const { pool, connections } = setup({ max: 1 });
  const holder = await holdConnection(pool);

  const controller = new AbortController();
  const reason = new Error("caller gave up");
  const waiting = pool.query("B", [], { signal: controller.signal });
  const behind = pool.query("C");
  await flush();
  controller.abort(reason);
  await assert.rejects(waiting, (error: unknown) => error === reason);
  assert.equal(pool.stats().waiting, 1);

  await holder.release();
  await behind;
  assert.ok(!connections[0]!.calls.includes("query:B"));
  assert.deepEqual(pool.stats(), { total: 1, idle: 1, active: 0, pending: 0, waiting: 0 });
  await pool.close();
});

test("pool: a signal aborted while its connection opens rejects; the connection is kept", async () => {
  const gate = deferred();
  const { pool, connections } = setup(
    { max: 1 },
    {
      prepare: (connection) => {
        connection.connectGate = gate.promise;
      },
    },
  );

  const controller = new AbortController();
  const waiting = pool.query("A", [], { signal: controller.signal });
  await flush();
  assert.equal(pool.stats().pending, 1);
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error === controller.signal.reason);

  gate.resolve();
  await flush();
  assert.deepEqual(pool.stats(), { total: 1, idle: 1, active: 0, pending: 0, waiting: 0 });
  assert.ok(!connections[0]!.calls.includes("query:A"));
  await pool.close();
});

test("pool: an already aborted signal rejects before anything is leased", async () => {
  const { pool, connections } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pool.query("A", [], { signal: controller.signal }));
  await assert.rejects(pool.connection(async () => 1, { signal: controller.signal }));
  assert.equal(connections.length, 0);
  await pool.close();
});

test("pool: a caller over maxWaitingClients rejects at once with kind pool-full", async () => {
  const { pool } = setup({ max: 1, maxWaitingClients: 1 });
  const holder = await holdConnection(pool);

  const waiting = pool.query("B");
  await assert.rejects(pool.query("C"), hasKind("pool-full"));
  assert.equal(pool.stats().waiting, 1);

  await holder.release();
  await waiting;
  await pool.close();
});

test("pool: a failed open rejects only the caller it was opened for", async () => {
  let attempts = 0;
  const { pool } = setup(
    { max: 1 },
    {
      prepare: (connection) => {
        attempts += 1;
        if (attempts === 1) {
          connection.connectError = new Error("broker refused");
        }
      },
    },
  );

  const first = pool.query("A");
  const second = pool.query("B");
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof ConnectionError);
    assert.equal((error.cause as Error).message, "broker refused");
    return true;
  });
  assert.deepEqual(await second, [{ id: 1, sql: "B" }]);
  await pool.close();
});

test("pool: min connections open in the background, and a failure there is only logged", async () => {
  let attempts = 0;
  const { pool, connections } = setup(
    { min: 2 },
    {
      prepare: (connection) => {
        attempts += 1;
        if (attempts === 2) {
          connection.connectError = new Error("one failed");
        }
      },
    },
  );
  assert.equal(pool.stats().pending, 2);
  await flush();
  assert.deepEqual(pool.stats(), { total: 1, idle: 1, active: 0, pending: 0, waiting: 0 });
  assert.equal(connections[1]!.closed, true);
  await pool.close();
});

// ---------------------------------------------------------------------------
// Every way out releases the connection
// ---------------------------------------------------------------------------

test("pool: every way a lease ends returns a clean connection", async () => {
  const { pool, connections, destroyed } = setup({ max: 1 });
  const idle = (): void => {
    assert.deepEqual(pool.stats(), { total: 1, idle: 1, active: 0, pending: 0, waiting: 0 });
  };

  assert.equal(
    await pool.connection(async (connection) => (await connection.query("A")).length),
    1,
  );
  idle();
  await assert.rejects(
    pool.connection(async () => {
      throw new Error("callback failed");
    }),
    /callback failed/,
  );
  idle();

  await pool.query("B");
  idle();
  connections[0]!.queryError = new Error("statement failed");
  await assert.rejects(pool.query("C"), QueryError);
  idle();
  await pool.execute("D");
  idle();

  const rows: unknown[] = [];
  for await (const row of pool.stream("S")) {
    rows.push(row);
  }
  assert.equal(rows.length, 3);
  idle();
  for await (const _row of pool.stream("S")) {
    break;
  }
  idle();
  await assert.rejects(async () => {
    for await (const _row of pool.stream("S")) {
      throw new Error("loop failed");
    }
  }, /loop failed/);
  idle();

  assert.equal(await pool.transaction(async (tx) => (await tx.query("T")).length), 1);
  idle();
  await assert.rejects(
    pool.transaction(async () => {
      throw new Error("rolled back");
    }),
    TransactionError,
  );
  idle();

  const committed = await pool.beginTransactionScope();
  await committed.execute("U");
  await committed.commit();
  idle();
  const rolledBack = await pool.beginTransactionScope();
  await rolledBack.rollback();
  idle();

  assert.equal(await pool.ping(), "11.4.0.0");
  idle();
  assert.equal(await pool.getServerVersion(), "11.4.0.0");
  idle();

  assert.equal(connections.length, 1);
  assert.deepEqual(destroyed(), []);
  await pool.close();
});

test("pool: a connection() handle rejects every call once its callback settled", async () => {
  const { pool, connections } = setup();
  let leaked: PoolConnection | undefined;
  await pool.connection(async (connection) => {
    leaked = connection;
  });

  await assert.rejects(leaked!.query("LATE"), ConnectionError);
  await assert.rejects(leaked!.execute("LATE"), ConnectionError);
  await assert.rejects(async () => {
    for await (const _row of leaked!.stream("LATE")) {
      // never reached
    }
  }, ConnectionError);
  assert.ok(!connections[0]!.calls.some((call) => call.endsWith("LATE")));
  await pool.close();
});

test("pool: a stream holds its connection while a query inside the loop takes another", async () => {
  const { pool, connections } = setup({ max: 2 });
  const seen: Array<[unknown, unknown]> = [];

  for await (const row of pool.stream<{ id: number }>("S")) {
    assert.equal(pool.stats().active, 1);
    const [inner] = await pool.query<{ id: number }>("Q");
    seen.push([row.id, inner?.id]);
  }

  assert.deepEqual(seen, [
    [0, 1],
    [0, 1],
    [0, 1],
  ]);
  assert.equal(connections.length, 2);
  assert.deepEqual(pool.stats(), { total: 2, idle: 2, active: 0, pending: 0, waiting: 0 });
  await pool.close();
});

// ---------------------------------------------------------------------------
// Reuse invariant (ADR 0008)
// ---------------------------------------------------------------------------

for (const [reason, change] of [
  [
    "in-transaction",
    (state: SessionState) => {
      state.inTransaction = true;
    },
  ],
  [
    "busy",
    (state: SessionState) => {
      state.busy = true;
    },
  ],
  [
    "failed-exchange",
    (state: SessionState) => {
      state.failedExchanges += 1;
    },
  ],
  [
    "error",
    (state: SessionState) => {
      state.connected = false;
    },
  ],
] as const) {
  test(`pool: a session left ${reason} is closed, not reused`, async () => {
    const { pool, connections, destroyed } = setup();
    await pool.connection(async (connection) => {
      await connection.query("A");
      change((connections[0] as StatefulConnection).state);
    });

    assert.deepEqual(destroyed(), [reason]);
    assert.equal(connections[0]!.closed, true);
    assert.deepEqual(await pool.query("B"), [{ id: 1, sql: "B" }]);
    await pool.close();
  });
}

test("pool: a statement still running when connection() returns makes the connection busy", async () => {
  const gate = deferred();
  const { pool, connections, destroyed } = setup();
  let running: Promise<unknown> | undefined;
  await pool.connection(async (connection) => {
    connections[0]!.gate = gate.promise;
    running = connection.query("UNAWAITED");
  });
  assert.deepEqual(destroyed(), ["busy"]);
  gate.resolve();
  await running;
  await pool.close();
});

test("pool: failed exchanges counted before a lease are not blamed on it", async () => {
  const { pool, connections, destroyed } = setup();
  await pool.query("A");
  (connections[0] as StatefulConnection).state.failedExchanges = 5;
  // Read at the start of the next lease, so the count from before is not blamed on it.
  await pool.query("B");
  assert.deepEqual(destroyed(), []);
  await pool.close();
});

test("pool: a custom connection without session state is reused only after a lease without failures", async () => {
  const { pool, connections, destroyed } = setup({}, { stateful: false });
  await pool.query("A");
  await pool.transaction(async (tx) => {
    await tx.query("T");
  });
  assert.deepEqual(destroyed(), []);

  connections[0]!.queryError = new Error("failed");
  await assert.rejects(pool.query("B"), QueryError);
  assert.deepEqual(destroyed(), ["error"]);
  assert.equal(connections[0]!.closed, true);
  await pool.close();
});

test("pool: a transaction whose rollback failed is closed, not reused", async () => {
  const { pool, connections, destroyed } = setup();
  await pool.query("A");
  connections[0]!.rollbackError = new Error("rollback refused");
  await assert.rejects(
    pool.transaction(async () => {
      throw new Error("callback failed");
    }),
    (error: unknown) =>
      error instanceof TransactionError && error.rollbackError?.message === "rollback refused",
  );
  assert.deepEqual(destroyed(), ["in-transaction"]);
  await pool.close();
});

test("pool: per-call transaction options other than the pool's close the connection afterwards", async () => {
  const { pool, connections, destroyed } = setup({ isolationLevel: "repeatable read" });

  await pool.transaction(async (tx) => tx.query("SAME"), { isolationLevel: "repeatable read" });
  assert.deepEqual(destroyed(), []);
  // Applied once, when the connection was opened.
  assert.deepEqual(
    connections[0]!.calls.filter((call) => call.startsWith("options")),
    ['options:{"isolationLevel":"repeatable read"}'],
  );

  await pool.transaction(async (tx) => tx.query("OTHER"), { lockTimeout: 0 });
  assert.deepEqual(destroyed(), ["options"]);
  assert.ok(
    connections[0]!.calls.includes('options:{"isolationLevel":"repeatable read","lockTimeout":0}'),
  );

  const scope = await pool.beginTransactionScope({ isolationLevel: "serializable" });
  await scope.commit();
  assert.deepEqual(destroyed(), ["options", "options"]);
  await pool.close();
});

test("pool: a connection that fails validation is closed and the caller gets another", async () => {
  const { pool, connections, destroyed } = setup({ validateAfterIdleMs: 0 });
  await pool.query("A");
  connections[0]!.pingError = new Error("gone");

  assert.deepEqual(await pool.query("B"), [{ id: 1, sql: "B" }]);
  assert.deepEqual(destroyed(), ["validation"]);
  assert.ok(connections[1]!.calls.includes("query:B"));
  await pool.close();
});

test("pool: connections idle past idleTimeoutMs close, never below min", async (t) => {
  if (!useFakeTimers(t, true)) {
    t.skip("this Node.js cannot mock Date");
    return;
  }
  const { pool, destroyed } = setup({ min: 1, idleTimeoutMs: 1000 });
  await Promise.all([pool.query("A"), pool.query("B"), pool.query("C")]);
  // The connection opened for `min` was still opening when the queries came.
  const opened = pool.stats().idle;
  assert.ok(opened >= 3);

  t.mock.timers.tick(999);
  await flush();
  assert.deepEqual(destroyed(), []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(
    destroyed(),
    Array.from({ length: opened - 1 }, () => "idle"),
  );
  assert.deepEqual(pool.stats(), { total: 1, idle: 1, active: 0, pending: 0, waiting: 0 });
  await pool.close();
});

test("pool: a connection past maxLifetimeMs closes while idle and when its lease ends", async (t) => {
  if (!useFakeTimers(t, true)) {
    t.skip("this Node.js cannot mock Date");
    return;
  }
  const { pool, destroyed } = setup({ maxLifetimeMs: 1000, idleTimeoutMs: 0 });
  await pool.query("A");
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(destroyed(), ["lifetime"]);

  const gate = deferred();
  const held = pool.connection(async (connection) => {
    await connection.query("B");
    await gate.promise;
  });
  await flush();
  t.mock.timers.tick(1000);
  // A lease is never cut short.
  assert.deepEqual(destroyed(), ["lifetime"]);
  gate.resolve();
  await held;
  assert.deepEqual(destroyed(), ["lifetime", "lifetime"]);
  await pool.close();
});

test("pool: the logger sees pool.create and pool.destroy with a reason", async () => {
  const { pool, events } = setup();
  await pool.connection(async (connection) => {
    await connection.query("A");
  });
  await pool.close();
  assert.deepEqual(
    events.map((event) => [event.operation, event.reason, event.host]),
    [
      ["pool.create", undefined, "localhost"],
      ["pool.destroy", "closed", "localhost"],
    ],
  );
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

test("pool: close() rejects waiting callers and waits for the leases in use", async () => {
  const { pool, connections } = setup({ max: 1 });
  const holder = await holdConnection(pool);
  const waiting = pool.query("B");
  await flush();

  const closing = pool.close();
  await assert.rejects(waiting, hasKind("pool-closed"));
  await assert.rejects(pool.query("C"), hasKind("pool-closed"));
  assert.equal(await isSettled(closing), false);

  await holder.release();
  await closing;
  assert.equal(connections[0]!.closed, true);
  assert.equal(pool.close(), closing);
});

test("pool: close() during an open rejects its caller and closes the connection once open", async () => {
  const gate = deferred();
  const { pool, connections } = setup(
    {},
    {
      prepare: (connection) => {
        connection.connectGate = gate.promise;
      },
    },
  );
  const opening = pool.query("A");
  await flush();

  const closing = pool.close();
  await assert.rejects(opening, hasKind("pool-closed"));
  assert.equal(await isSettled(closing), false);
  gate.resolve();
  await closing;
  assert.equal(connections[0]!.closed, true);
  assert.ok(!connections[0]!.calls.includes("query:A"));
});

test("pool: close() lets a transaction in flight commit, then closes its connection", async () => {
  const gate = deferred();
  const { pool, connections } = setup();
  const transaction = pool.transaction(async (tx) => {
    await tx.query("T");
    await gate.promise;
    return "done";
  });
  await flush();

  const closing = pool.close();
  await assert.rejects(
    pool.transaction(async () => undefined),
    hasKind("pool-closed"),
  );
  await assert.rejects(pool.beginTransactionScope(), (error: unknown) => {
    return error instanceof TransactionError && error.kind === "pool-closed";
  });
  gate.resolve();
  assert.equal(await transaction, "done");
  await closing;
  assert.deepEqual(connections[0]!.calls.slice(-2), ["commit", "close"]);
});

test("pool: close() discards a scope nobody ended and ends an unread stream", async () => {
  const { pool, connections } = setup();
  const scope = await pool.beginTransactionScope();
  await scope.execute("UNCOMMITTED");

  const rows = pool.stream("S")[Symbol.asyncIterator]();
  await rows.next();
  assert.equal(pool.stats().active, 2);

  await pool.close();
  assert.equal(connections[0]!.closed, true);
  assert.equal(connections[1]!.closed, true);
  assert.ok(!connections[0]!.calls.includes("commit"));
  await assert.rejects(scope.query("LATE"), TransactionError);
  await rows.return?.();
});

test("pool: a transaction that fails before BEGIN completes closes its connection as an error", async () => {
  const { pool, destroyed } = setup(
    {},
    {
      prepare: (connection) => {
        connection.beginError = new Error("begin refused");
      },
    },
  );
  await assert.rejects(
    pool.transaction(async () => undefined),
    TransactionError,
  );
  await assert.rejects(pool.beginTransactionScope(), TransactionError);
  assert.deepEqual(destroyed(), ["error", "error"]);
  await pool.close();
});

test("pool: a connection that passes validation is lent as it is", async () => {
  const { pool, connections, destroyed } = setup({ validateAfterIdleMs: 0 });
  await pool.query("A");
  await pool.query("B");
  assert.deepEqual(destroyed(), []);
  assert.equal(connections.length, 1);
  assert.deepEqual(
    connections[0]!.calls.filter((call) => call === "ping"),
    ["ping"],
  );
  await pool.close();
});

test("pool: a custom ping() that throws synchronously fails validation without losing the slot", async () => {
  const { pool, connections, destroyed } = setup(
    { max: 1, validateAfterIdleMs: 0 },
    {
      prepare: (connection) => {
        if (connection.id === 0) {
          connection.ping = () => {
            throw new Error("ping threw");
          };
        }
      },
    },
  );
  await pool.query("A");
  assert.deepEqual(await pool.query("B"), [{ id: 1, sql: "B" }]);
  assert.deepEqual(destroyed(), ["validation"]);
  assert.deepEqual(pool.stats(), { total: 1, idle: 1, active: 0, pending: 0, waiting: 0 });
  await pool.close();
});

test("pool: a custom close() that throws synchronously does not fail the statement", async () => {
  const { pool, connections, destroyed } = setup({}, { stateful: false });
  await pool.query("A");
  connections[0]!.close = () => {
    throw new Error("close threw");
  };
  connections[0]!.queryError = new Error("failed");
  await assert.rejects(pool.query("B"), QueryError);
  assert.deepEqual(destroyed(), ["error"]);
  assert.deepEqual(await pool.query("C"), [{ id: 1, sql: "C" }]);
  await pool.close();
});

test("pool: a caller whose validated connection failed keeps its place at the head of the line", async () => {
  const opening = deferred();
  const { pool, connections } = setup(
    { max: 1, validateAfterIdleMs: 0 },
    {
      prepare: (connection) => {
        if (connection.id === 0) {
          connection.pingError = new Error("gone");
        }
        if (connection.id === 1) {
          connection.connectGate = opening.promise;
        }
      },
    },
  );
  await pool.query("A");

  // FIRST takes connection 0, which fails validation, so it opens connection 1.
  const order: string[] = [];
  const first = pool.query("FIRST").then(() => order.push("FIRST"));
  await flush();
  assert.deepEqual(pool.stats(), { total: 1, idle: 0, active: 0, pending: 1, waiting: 0 });
  // SECOND finds no room and waits behind FIRST rather than taking its slot.
  const second = pool.query("SECOND").then(() => order.push("SECOND"));
  await flush();
  assert.equal(pool.stats().waiting, 1);

  opening.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["FIRST", "SECOND"]);
  assert.deepEqual(
    connections[1]!.calls.filter((call) => call.startsWith("query")),
    ["query:FIRST", "query:SECOND"],
  );
  await pool.close();
});

test("pool: close() during validation rejects the caller and closes the connection", async () => {
  const gate = deferred();
  // The logger wraps each connection when it opens, so the ping is set up front.
  const { pool, connections } = setup(
    { validateAfterIdleMs: 0 },
    {
      prepare: (connection) => {
        connection.ping = async () => {
          await gate.promise;
          return "11.4.0.0";
        };
      },
    },
  );
  await pool.query("A");
  const validating = pool.query("B");
  await flush();
  const closing = pool.close();
  await assert.rejects(validating, hasKind("pool-closed"));
  gate.resolve();
  await closing;
  assert.equal(connections[0]!.closed, true);
  assert.deepEqual(pool.stats(), { total: 0, idle: 0, active: 0, pending: 0, waiting: 0 });
});

test("pool: a connection past its lifetime is not lent from idle", async (t) => {
  if (!useFakeTimers(t, true)) {
    t.skip("this Node.js cannot mock Date");
    return;
  }
  const { pool, connections, destroyed } = setup({ maxLifetimeMs: 1000, idleTimeoutMs: 0 });
  await pool.query("A");
  // Date moves on but the idle timer has not run yet.
  (t.mock.timers as unknown as { setTime(time: number): void }).setTime(Date.now() + 1000);
  assert.deepEqual(await pool.query("B"), [{ id: 1, sql: "B" }]);
  assert.deepEqual(destroyed(), ["lifetime"]);
  assert.ok(!connections[0]!.calls.includes("query:B"));
  await pool.close();
});

test("pool: close() awaited inside a transaction or connection() callback does not wait for itself", async () => {
  const first = setup();
  const result = await first.pool.transaction(async (tx) => {
    await tx.query("T");
    await first.pool.close();
    return "closed inside";
  });
  assert.equal(result, "closed inside");
  assert.equal(first.connections[0]!.closed, true);

  const second = setup();
  await second.pool.connection(async (connection) => {
    await connection.query("C");
    await second.pool.close();
  });
  assert.equal(second.connections[0]!.closed, true);
});

test("pool: two transaction() callbacks that each await close() both resolve (#268)", async () => {
  const { pool, connections } = setup();
  const bothRunning = deferred();
  let running = 0;
  const run = (name: string) =>
    pool.transaction(async (tx) => {
      await tx.query(name);
      running += 1;
      if (running === 2) {
        bothRunning.resolve();
      }
      await bothRunning.promise;
      await pool.close();
      return name;
    });

  const results = await Promise.all([run("A"), run("B")]);
  assert.deepEqual(results, ["A", "B"]);
  assert.equal(connections.length, 2);
  for (const connection of connections) {
    assert.deepEqual(connection.calls.slice(-2), ["commit", "close"]);
  }
  await pool.close();
});

test("pool: close() inside connection() and transaction() callbacks, nested or not, waits for none (#268)", async () => {
  const { pool, connections } = setup();
  const bothRunning = deferred();
  let running = 0;
  const arrive = async (): Promise<void> => {
    running += 1;
    if (running === 2) {
      bothRunning.resolve();
    }
    await bothRunning.promise;
  };

  const leased = pool.connection(async (connection) => {
    await connection.query("C");
    // A transaction inside the connection() callback: both enclose this close().
    return pool.transaction(async (tx) => {
      await tx.query("NESTED");
      await arrive();
      await pool.close();
      return "nested";
    });
  });
  const transaction = pool.transaction(async (tx) => {
    await tx.query("T");
    await arrive();
    await pool.close();
    return "transaction";
  });

  assert.deepEqual(await Promise.all([leased, transaction]), ["nested", "transaction"]);
  assert.equal(connections.length, 3);
  assert.ok(connections.every((connection) => connection.closed));
});

test("pool: close() from outside still waits for a callback that closed the pool from inside (#268)", async () => {
  const { pool, connections } = setup();
  const closedInside = deferred();
  const finish = deferred();
  const transaction = pool.transaction(async (tx) => {
    await tx.query("T");
    await pool.close();
    closedInside.resolve();
    await finish.promise;
    return "done";
  });

  await closedInside.promise;
  const outside = pool.close();
  assert.equal(await isSettled(outside), false);

  finish.resolve();
  assert.equal(await transaction, "done");
  await outside;
  assert.deepEqual(connections[0]!.calls.slice(-2), ["commit", "close"]);
  assert.equal(pool.close(), outside);
});

test("pool: close() from a timer a callback set counts as inside it only while it runs (#268)", async () => {
  // The timer fires while the connection() callback is still running: inside.
  const first = setup();
  const fired = deferred();
  const finish = deferred();
  let insideClose: Promise<void> | undefined;
  const leased = first.pool.connection(async (connection) => {
    await connection.query("C");
    setImmediate(() => {
      insideClose = first.pool.close();
      fired.resolve();
    });
    await finish.promise;
  });
  await fired.promise;
  await insideClose;
  assert.equal(first.connections[0]!.closed, false);
  finish.resolve();
  await leased;
  assert.equal(first.connections[0]!.closed, true);

  // The timer fires after the transaction() callback returned, while COMMIT runs.
  const commitGate = deferred();
  const second = setup(
    {},
    {
      prepare: (connection) => {
        const commit = connection.commit.bind(connection);
        connection.commit = async () => {
          await commitGate.promise;
          await commit();
        };
      },
    },
  );
  const timerFired = deferred();
  let timedClose: Promise<void> | undefined;
  const transaction = second.pool.transaction(async (tx) => {
    await tx.query("T");
    setImmediate(() => {
      timedClose = second.pool.close();
      timerFired.resolve();
    });
  });
  await timerFired.promise;
  assert.ok(timedClose);
  assert.equal(await isSettled(timedClose), false);
  commitGate.resolve();
  await transaction;
  await timedClose;
  assert.deepEqual(second.connections[0]!.calls.slice(-2), ["commit", "close"]);
});

test("pool: executePrepared() hands blob() and clob() values to the connection as they are", async () => {
  const { pool, connections, destroyed } = setup();
  const content = blob(Buffer.from([1, 2, 3]));
  const text = clob("text");

  assert.deepEqual(await pool.executePrepared("INSERT B", [1, content, text]), {
    affectedRows: 1,
  });
  await pool.connection((connection) => connection.executePrepared("INSERT C", [content]));
  await pool.transaction((tx) => tx.executePrepared("INSERT T", [text]));

  const [direct, leased, inTransaction] = connections[0]!.preparedParams;
  assert.equal(direct?.[1], content);
  assert.equal(direct?.[2], text);
  assert.equal(leased?.[0], content);
  assert.equal(inTransaction?.[0], text);
  assert.deepEqual(destroyed(), []);
  await pool.close();
});

test("pool: literal methods refuse blob() and clob() before leasing a connection", async () => {
  const { pool, connections } = setup();
  const content = blob(Buffer.from([1]));
  const refused = (error: unknown) => error instanceof LobParamError;

  await assert.rejects(pool.query("Q", [content as never]), refused);
  await assert.rejects(pool.queryResult("Q", [content as never]), refused);
  await assert.rejects(pool.execute("E", [clob("x") as never]), refused);
  assert.throws(() => pool.stream("S", [content as never]), refused);
  assert.equal(connections.length, 0);

  await pool.connection(async (connection) => {
    await assert.rejects(connection.execute("E", [content as never]), refused);
    assert.throws(() => connection.stream("S", [content as never]), refused);
  });
  assert.ok(!connections[0]!.calls.some((call) => call.startsWith("execute:")));
  await pool.close();
});

// ---------------------------------------------------------------------------
// Stub CAS over TCP: the real adapter inside the pool
// ---------------------------------------------------------------------------

const STALL = Symbol("stall");

/** Reply, then close the socket as a CAS does when it leaves an idle client. */
interface ThenDrop {
  reply: Buffer;
  drop: true;
}

function simpleReply(code: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(code, 0);
  return buffer;
}

/** PREPARE_AND_EXECUTE reply of an INSERT that changed one row. */
function insertReply(): Buffer {
  const head = Buffer.alloc(4 + 4 + 1 + 4 + 1 + 4 + 4 + 1 + 4);
  let offset = head.writeInt32BE(1, 0); // query handle
  offset = head.writeInt32BE(0, offset); // result cache lifetime
  offset = head.writeInt8(20, offset); // statement type INSERT
  offset = head.writeInt32BE(0, offset); // bind count
  offset = head.writeInt8(0, offset); // updatable
  offset = head.writeInt32BE(0, offset); // column count
  offset = head.writeInt32BE(1, offset); // total tuple count
  offset = head.writeInt8(0, offset); // cache reusable
  head.writeInt32BE(1, offset); // result count
  const info = Buffer.alloc(1 + 4 + 8 + 4 + 4);
  info.writeInt8(20, 0);
  info.writeInt32BE(1, 1);
  return Buffer.concat([head, info, Buffer.alloc(1 + 4)]);
}

const INSERT_OK = insertReply();
const CLOSE_OK = simpleReply(0);

/**
 * Stub CAS. `scripts[n]` answers the requests of the nth connection in order;
 * a missing entry answers success. `status` is CAS_INFO[0] of every reply: 0
 * says the transaction ended, as a live broker does after autocommit work.
 */
async function createStubCas(
  scripts: Array<Array<Buffer | ThenDrop | typeof STALL>>,
  status: number,
): Promise<{ server: Server; port: number; requests: number[] }> {
  const requests: number[] = [];
  const frame = (payload: Buffer): Buffer => {
    const header = Buffer.alloc(4);
    header.writeInt32BE(payload.length, 0);
    return Buffer.concat([header, Buffer.from([status, 0, 0, 0]), payload]);
  };
  const server = createServer((socket: NetSocket) => {
    const connection = requests.push(0) - 1;
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(Buffer.alloc(4));
      socket.once("data", () => {
        socket.write(frame(Buffer.alloc(16)));
        socket.on("data", () => {
          const index = requests[connection]!;
          requests[connection] = index + 1;
          const reply = scripts[connection]?.[index] ?? CLOSE_OK;
          if (Buffer.isBuffer(reply)) {
            socket.write(frame(reply));
          } else if (reply !== STALL) {
            socket.write(frame(reply.reply), () => socket.destroy());
          }
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0, requests };
}

function stubPool(port: number, options: Partial<PoolOptions> = {}) {
  const events: ClientLogFields[] = [];
  const record = (_message: string, fields: ClientLogFields): void => {
    if (fields.operation?.startsWith("pool.")) {
      events.push(fields);
    }
  };
  const pool = createPool({
    host: "127.0.0.1",
    port,
    database: "testdb",
    user: "dba",
    readTimeout: 500,
    max: 1,
    logger: { info: record, error: record },
    ...options,
  });
  const destroyed = (): Array<string | undefined> =>
    events.filter((event) => event.operation === "pool.destroy").map((event) => event.reason);
  return { pool, destroyed };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("stub CAS: a CAS that drops an idle pooled session is replaced without losing the connection", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createStubCas(
    [
      [INSERT_OK, { reply: CLOSE_OK, drop: true }],
      [INSERT_OK, CLOSE_OK],
    ],
    0,
  );
  const { pool, destroyed } = stubPool(port);

  try {
    await pool.query("INSERT INTO t VALUES (1)");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The adapter checks a session that said its transaction ended before using
    // it again, finds the CAS gone and opens a new session. Nothing had been
    // sent on the old one, so the pool keeps the connection.
    await pool.query("INSERT INTO t VALUES (2)");
    assert.deepEqual(destroyed(), []);
    assert.equal(requests.length, 2);
    assert.deepEqual(pool.stats(), { total: 1, idle: 1, active: 0, pending: 0, waiting: 0 });
  } finally {
    await pool.close();
    await closeServer(server);
  }
});

test("stub CAS: a dropped session found by validation is closed and replaced", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createStubCas(
    [
      [INSERT_OK, { reply: CLOSE_OK, drop: true }],
      [INSERT_OK, CLOSE_OK],
    ],
    1,
  );
  const { pool, destroyed } = stubPool(port, { validateAfterIdleMs: 0 });

  try {
    await pool.query("INSERT INTO t VALUES (1)");
    await new Promise((resolve) => setTimeout(resolve, 50));

    await pool.query("INSERT INTO t VALUES (2)");
    assert.deepEqual(destroyed(), ["validation"]);
    assert.deepEqual(requests, [2, 2]);
  } finally {
    await pool.close();
    await closeServer(server);
  }
});

test("stub CAS: a statement with an unknown outcome closes its connection", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createStubCas([[STALL], [INSERT_OK, CLOSE_OK]], 1);
  const { pool, destroyed } = stubPool(port, { readTimeout: 200 });

  try {
    await assert.rejects(pool.query("INSERT INTO t VALUES (1)"), ReadTimeoutError);
    assert.deepEqual(destroyed(), ["failed-exchange"]);

    await pool.query("INSERT INTO t VALUES (2)");
    assert.deepEqual(requests, [1, 2]);
  } finally {
    await pool.close();
    await closeServer(server);
  }
});
