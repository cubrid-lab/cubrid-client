/**
 * destroy(): tearing a connection down without waiting for the request in
 * flight, and the default socket limits (#245). Every broker here is a local
 * fake that completes the handshake and then never answers.
 */

import assert from "node:assert/strict";
import { createServer, Socket as NetSocket, type Server } from "node:net";
import test from "node:test";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { createClient } from "../src/client/create-client.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { ConnectionLostError } from "../src/errors/internal-errors.js";
import { QueryError } from "../src/errors/query-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import { SESSION_STATE, type SessionState } from "../src/internals/session-state.js";
import {
  CASConnection,
  type CASConnectionConfig,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  KEEP_ALIVE_INITIAL_DELAY_MS,
} from "../src/protocol/connection.js";
import { SIZE_BROKER_INFO, SIZE_CAS_INFO, SIZE_DATA_LENGTH } from "../src/protocol/constants.js";
import type { ClientLogFields, ConnectionLike } from "../src/types/client.js";

// The host running these tests may be heavily loaded, so "promptly" is generous
// next to the stalls it is measured against, which never end.
const PROMPT_MS = 2000;

const CONFIG: CASConnectionConfig = {
  host: "127.0.0.1",
  port: 0,
  database: "testdb",
  user: "dba",
  password: "",
};

function frame(body: Buffer): Buffer {
  const header = Buffer.alloc(SIZE_DATA_LENGTH);
  header.writeInt32BE(body.length - SIZE_CAS_INFO, 0);
  return Buffer.concat([header, body]);
}

function openDatabaseReply(): Buffer {
  const responseCode = Buffer.alloc(4);
  const brokerInfo = Buffer.alloc(SIZE_BROKER_INFO);
  brokerInfo[4] = 7;
  const sessionId = Buffer.alloc(4);
  sessionId.writeInt32BE(1, 0);
  return frame(Buffer.concat([Buffer.from([1, 2, 3, 4]), responseCode, brokerInfo, sessionId]));
}

interface SilentBroker {
  server: Server;
  port: number;
  /** TCP connections accepted. */
  connections: () => number;
  /** Request frames received after OPEN_DATABASE, across connections. */
  requests: () => number;
  /** Server side of every accepted connection. */
  sockets: NetSocket[];
  /** Resolves once `count` requests have arrived. */
  requested: (count: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A broker that completes the handshake (unless `stage` says otherwise), reads
 * requests and never answers one. `stage: "redirect"` never sends the redirect
 * port; `stage: "open"` never answers OPEN_DATABASE.
 */
async function silentBroker(stage: "request" | "redirect" | "open" = "request") {
  let connections = 0;
  let requests = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const sockets: NetSocket[] = [];
  const counted = (): void => {
    for (const waiter of [...waiters]) {
      if (requests >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };

  const server = createServer((socket) => {
    connections += 1;
    sockets.push(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      if (stage === "redirect") {
        return;
      }
      socket.write(Buffer.alloc(4));
      socket.once("data", () => {
        if (stage === "open") {
          return;
        }
        socket.write(openDatabaseReply());
        socket.on("data", () => {
          requests += 1;
          counted();
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    port,
    connections: () => connections,
    requests: () => requests,
    sockets,
    requested: (count: number) =>
      requests >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } satisfies SilentBroker;
}

/** Waits until `predicate` holds, polling, for state a fake server updates. */
async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** When the test last called destroy(); `ms` of an outcome counts from then. */
let destroyStarted = Number.NaN;

/**
 * Records the outcome of `promise` without leaving its rejection unhandled, and
 * how long after the last destroy() it settled, so setup time never counts.
 */
function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  return promise.then(
    (value) => ({ value, ms: Date.now() - destroyStarted }),
    (error: unknown) => ({ error, ms: Date.now() - destroyStarted }),
  );
}

/** Fails the test on any unhandled rejection while `run` and a few ticks after it run. */
async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
}

const REQUEST_HEADER = Buffer.alloc(8);
const REQUEST_PAYLOAD = Buffer.from([0x01]);

function isLost(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ConnectionLostError, String(error));
    assert.equal(error.kind, "connection-lost");
    assert.match(error.message, pattern);
    return true;
  };
}

// ---------------------------------------------------------------------------
// CASConnection.destroy()
// ---------------------------------------------------------------------------

test("destroy() settles a request the server never answers, and the queue behind it", async () => {
  const broker = await silentBroker();
  try {
    await withoutUnhandledRejections(async () => {
      const cas = new CASConnection({ ...CONFIG, port: broker.port });
      await cas.connect();

      const inFlight = outcome(cas.sendAndRecv(REQUEST_HEADER, REQUEST_PAYLOAD));
      const queued = [
        outcome(cas.sendAndRecv(REQUEST_HEADER, REQUEST_PAYLOAD)),
        outcome(cas.sendAndRecv(REQUEST_HEADER, REQUEST_PAYLOAD)),
      ];
      const closing = outcome(cas.close());
      await broker.requested(1);

      destroyStarted = Date.now();
      cas.destroy();

      const first = await inFlight;
      assert.ok(first.ms < PROMPT_MS, `in-flight request settled after ${first.ms}ms`);
      isLost(/destroyed.*outcome of a request in flight is unknown/)(first.error);
      for (const settled of await Promise.all(queued)) {
        isLost(/destroyed before this request was sent/)(settled.error);
      }
      const closed = await closing;
      assert.equal(closed.error, undefined);

      // Only the in-flight request reached the server, and only it is counted.
      assert.equal(broker.requests(), 1);
      assert.equal(cas.failedExchanges, 1);
      assert.equal(cas.isConnected, false);
      assert.equal(cas.isDestroyed, true);
      // The server side sees the socket close.
      await until(
        () => broker.sockets[0]?.destroyed === true || broker.sockets[0]?.readableEnded === true,
      );
    });
  } finally {
    await broker.close();
  }
});

test("a destroyed CASConnection never opens another session or reads a late reply", async () => {
  const broker = await silentBroker();
  try {
    await withoutUnhandledRejections(async () => {
      const cas = new CASConnection({ ...CONFIG, port: broker.port });
      await cas.connect();
      const generation = cas.connectionGeneration;
      const pending = outcome(cas.sendAndRecv(REQUEST_HEADER, REQUEST_PAYLOAD));
      await broker.requested(1);

      destroyStarted = Date.now();
      cas.destroy();
      destroyStarted = Date.now();
      cas.destroy();
      await pending;

      // A reply the server sends now has no socket to arrive on.
      broker.sockets[0]?.write(frame(Buffer.from([0, 0, 0, 0])));

      await assert.rejects(cas.connect(), isLost(/before this request was sent/));
      await assert.rejects(cas.ensureSession(), isLost(/before this request was sent/));
      await assert.rejects(
        cas.sendAndRecv(REQUEST_HEADER, REQUEST_PAYLOAD),
        isLost(/before this request was sent/),
      );
      await assert.rejects(cas.setSessionParameters([]), isLost(/before this request was sent/));
      assert.equal(
        await cas.sendAndRecvOnSession(generation, REQUEST_HEADER, REQUEST_PAYLOAD),
        null,
      );
      assert.equal(await cas.releaseOnSession(generation, REQUEST_HEADER, REQUEST_PAYLOAD), null);
      await cas.discardSession();
      await cas.close();
      await cas.close();
      destroyStarted = Date.now();
      cas.destroy();

      assert.equal(broker.connections(), 1);
      assert.equal(broker.requests(), 1);
      assert.equal(cas.connectionGeneration, generation);
      assert.equal(cas.failedExchanges, 1);
    });
  } finally {
    await broker.close();
  }
});

test("destroy() racing close(): close() first, then destroy(), then close() again", async () => {
  const broker = await silentBroker();
  try {
    const cas = new CASConnection({ ...CONFIG, port: broker.port });
    await cas.connect();
    const pending = outcome(cas.sendAndRecv(REQUEST_HEADER, REQUEST_PAYLOAD));
    let hookRan = false;
    const closing = outcome(
      cas.close(async () => {
        hookRan = true;
      }),
    );
    await broker.requested(1);

    destroyStarted = Date.now();
    cas.destroy();

    assert.ok((await pending).error instanceof ConnectionLostError);
    const closed = await closing;
    assert.equal(closed.error, undefined);
    assert.ok(closed.ms < PROMPT_MS);
    // No socket was left for a close frame.
    assert.equal(hookRan, false);
    await cas.close();
  } finally {
    await broker.close();
  }
});

for (const stage of ["redirect", "open"] as const) {
  test(`destroy() stops a connect waiting for the ${stage === "redirect" ? "redirect port" : "OPEN_DATABASE reply"}`, async () => {
    const broker = await silentBroker(stage);
    try {
      await withoutUnhandledRejections(async () => {
        const cas = new CASConnection({ ...CONFIG, port: broker.port, maxConnectionRetryCount: 3 });
        const connecting = outcome(cas.connect());
        await until(() => broker.connections() === 1);
        await new Promise((resolve) => setTimeout(resolve, 20));

        destroyStarted = Date.now();
        cas.destroy();

        const settled = await connecting;
        // Well before the 10-second handshake limit, and not as a read timeout.
        assert.ok(settled.ms < PROMPT_MS, `connect settled after ${settled.ms}ms`);
        assert.ok(settled.error instanceof ConnectionLostError, String(settled.error));
        assert.equal(cas.isConnected, false);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(broker.connections(), 1);
      });
    } finally {
      await broker.close();
    }
  });
}

test("destroy() stops a connect waiting between retries, and no attempt follows", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const attempts: string[] = [];
  const connect = NetSocket.prototype.connect;
  NetSocket.prototype.connect = function (this: NetSocket, ...args: unknown[]) {
    attempts.push("connect");
    return (connect as (...a: unknown[]) => NetSocket).apply(this, args);
  } as typeof connect;

  try {
    const cas = new CASConnection({ ...CONFIG, port, maxConnectionRetryCount: 5 });
    const connecting = outcome(cas.connect());
    await until(() => attempts.length >= 2);

    destroyStarted = Date.now();
    cas.destroy();

    const settled = await connecting;
    assert.ok(settled.ms < PROMPT_MS);
    assert.ok(settled.error instanceof ConnectionLostError, String(settled.error));
    const made = attempts.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(attempts.length, made);
  } finally {
    NetSocket.prototype.connect = connect;
  }
});

test("destroy() stops a TCP connect that has not completed", async () => {
  // TEST-NET-1 (RFC 5737) drops packets, so the connect would wait for its limit.
  const cas = new CASConnection({
    ...CONFIG,
    host: "192.0.2.1",
    port: 33000,
    connectionTimeout: 0,
  });
  const connecting = outcome(cas.connect());
  await new Promise((resolve) => setTimeout(resolve, 50));

  destroyStarted = Date.now();
  cas.destroy();

  const settled = await connecting;
  assert.ok(settled.ms < PROMPT_MS, `connect settled after ${settled.ms}ms`);
  // A connect that failed at once on this host (no route) is fine too; it must not hang.
  assert.ok(settled.error instanceof Error);
});

// ---------------------------------------------------------------------------
// Socket defaults
// ---------------------------------------------------------------------------

test("connectionTimeout defaults to 10 seconds per TCP connect, and 0 disables it", async () => {
  assert.equal(DEFAULT_CONNECTION_TIMEOUT_MS, 10_000);
  const timeouts: number[] = [];
  const setTimeoutOriginal = NetSocket.prototype.setTimeout;
  NetSocket.prototype.setTimeout = function (this: NetSocket, ms: number, ...rest: unknown[]) {
    timeouts.push(ms);
    return (setTimeoutOriginal as (...a: unknown[]) => NetSocket).call(this, ms, ...rest);
  } as typeof setTimeoutOriginal;

  const broker = await silentBroker();
  try {
    for (const [connectionTimeout, expected] of [
      [undefined, 10_000],
      [250, 250],
      [0, undefined],
    ] as const) {
      timeouts.length = 0;
      const cas = new CASConnection({
        ...CONFIG,
        port: broker.port,
        ...(connectionTimeout !== undefined && { connectionTimeout }),
      });
      await cas.connect();
      // The limit is armed before connecting and cleared once connected.
      assert.equal(timeouts[0] === 0 ? undefined : timeouts[0], expected);
      assert.equal(timeouts.at(-1), 0);
      await cas.close();
    }
  } finally {
    NetSocket.prototype.setTimeout = setTimeoutOriginal;
    await broker.close();
  }
});

test("each socket gets TCP_NODELAY and keepalive once connected", async () => {
  const calls: string[] = [];
  const { setNoDelay, setKeepAlive } = NetSocket.prototype;
  NetSocket.prototype.setNoDelay = function (this: NetSocket, noDelay?: boolean) {
    calls.push(`noDelay:${noDelay}`);
    return setNoDelay.call(this, noDelay);
  };
  NetSocket.prototype.setKeepAlive = function (this: NetSocket, enable?: boolean, delay?: number) {
    calls.push(`keepAlive:${enable}:${delay}`);
    return setKeepAlive.call(this, enable, delay);
  };

  const broker = await silentBroker();
  try {
    const cas = new CASConnection({ ...CONFIG, port: broker.port });
    await cas.connect();
    await cas.close();

    assert.equal(KEEP_ALIVE_INITIAL_DELAY_MS, 60_000);
    assert.ok(calls.includes("noDelay:true"), calls.join());
    assert.ok(calls.includes(`keepAlive:true:${KEEP_ALIVE_INITIAL_DELAY_MS}`), calls.join());
  } finally {
    NetSocket.prototype.setNoDelay = setNoDelay;
    NetSocket.prototype.setKeepAlive = setKeepAlive;
    await broker.close();
  }
});

// ---------------------------------------------------------------------------
// NativeCubridAdapter.destroy()
// ---------------------------------------------------------------------------

function adapterConfig(port: number) {
  return { ...CONFIG, port };
}

test("adapter destroy() rejects the running and the queued statements, and later calls send nothing", async () => {
  const broker = await silentBroker();
  try {
    await withoutUnhandledRejections(async () => {
      const adapter = new NativeCubridAdapter(adapterConfig(broker.port));
      const running = outcome(adapter.query("SELECT 1"));
      const queued = [
        outcome(adapter.query("SELECT 2")),
        outcome(adapter.execute("DELETE FROM t")),
      ];
      const closing = outcome(adapter.close());
      await broker.requested(1);

      destroyStarted = Date.now();
      adapter.destroy();

      const first = await running;
      assert.ok(first.ms < PROMPT_MS);
      assert.ok(first.error instanceof QueryError, String(first.error));
      assert.equal(first.error.kind, "connection-lost");
      for (const settled of await Promise.all(queued)) {
        assert.ok(settled.error instanceof QueryError, String(settled.error));
        assert.equal(settled.error.kind, "connection-lost");
        assert.match(String((settled.error as Error).cause), /nothing was sent/);
      }
      assert.equal((await closing).error, undefined);

      await assert.rejects(adapter.query("SELECT 3"), (error: unknown) => {
        assert.ok(error instanceof QueryError);
        assert.equal(error.kind, "connection-lost");
        return true;
      });
      await assert.rejects(adapter.connect(), (error: unknown) => {
        assert.ok(error instanceof ConnectionError);
        assert.equal(error.kind, "connection-lost");
        return true;
      });
      await assert.rejects(adapter.beginTransaction(), TransactionError);
      await assert.rejects(adapter.ping(), ConnectionError);
      await adapter.close();
      destroyStarted = Date.now();
      adapter.destroy();

      const state = (adapter as unknown as { [SESSION_STATE](): SessionState })[SESSION_STATE]();
      assert.equal(state.connected, false);
      assert.equal(broker.connections(), 1);
      assert.equal(broker.requests(), 1);
    });
  } finally {
    await broker.close();
  }
});

test("adapter destroy() reaches the connection a running close() is waiting on", async () => {
  const broker = await silentBroker();
  try {
    const adapter = new NativeCubridAdapter(adapterConfig(broker.port));
    const running = outcome(adapter.query("SELECT 1"));
    await broker.requested(1);
    // close() is queued behind the statement; destroy() must still reach its CAS.
    const closing = outcome(adapter.close());

    destroyStarted = Date.now();
    adapter.destroy();

    assert.ok((await running).error instanceof QueryError);
    const closed = await closing;
    assert.equal(closed.error, undefined);
    assert.ok(closed.ms < PROMPT_MS);
    await assert.rejects(adapter.query("SELECT 2"), QueryError);
    assert.equal(broker.connections(), 1);
  } finally {
    await broker.close();
  }
});

test("adapter destroy() ends an open stream", async () => {
  const broker = await silentBroker();
  try {
    await withoutUnhandledRejections(async () => {
      const adapter = new NativeCubridAdapter(adapterConfig(broker.port));
      const rows = adapter.stream("SELECT 1")[Symbol.asyncIterator]();
      const first = outcome(rows.next());
      await broker.requested(1);

      destroyStarted = Date.now();
      adapter.destroy();

      const settled = await first;
      assert.ok(settled.ms < PROMPT_MS);
      assert.ok(settled.error instanceof QueryError, String(settled.error));
      assert.equal(settled.error.kind, "connection-lost");
    });
  } finally {
    await broker.close();
  }
});

// ---------------------------------------------------------------------------
// CubridClient.destroy()
// ---------------------------------------------------------------------------

function clientFor(port: number) {
  return createClient({ host: "127.0.0.1", port, database: "testdb", user: "dba" });
}

test("client destroy() settles the shared connection's statements and close()", async () => {
  const broker = await silentBroker();
  try {
    await withoutUnhandledRejections(async () => {
      const client = clientFor(broker.port);
      const running = outcome(client.query("SELECT 1"));
      const queued = [outcome(client.query("SELECT 2")), outcome(client.execute("DELETE FROM t"))];
      await broker.requested(1);
      const closing = outcome(client.close());

      destroyStarted = Date.now();
      const destroyed = outcome(client.destroy());

      assert.equal((await destroyed).error, undefined);
      for (const settled of [await running, ...(await Promise.all(queued))]) {
        assert.ok(settled.ms < PROMPT_MS);
        assert.ok(settled.error instanceof QueryError, String(settled.error));
        assert.equal(settled.error.kind, "connection-lost");
      }
      const closed = await closing;
      assert.equal(closed.error, undefined);

      destroyStarted = Date.now();
      await client.destroy();
      await client.close();
      await assert.rejects(client.query("SELECT 3"), (error: Error) => {
        assert.match(String(error.cause), /Client is closed/);
        return true;
      });
      assert.equal(broker.connections(), 1);
      assert.equal(broker.requests(), 1);
    });
  } finally {
    await broker.close();
  }
});

test("client destroy() during the first handshake rejects the statement waiting for it", async () => {
  const broker = await silentBroker("redirect");
  try {
    const client = clientFor(broker.port);
    const running = outcome(client.query("SELECT 1"));
    await until(() => broker.connections() === 1);

    destroyStarted = Date.now();
    await client.destroy();

    const settled = await running;
    assert.ok(settled.ms < PROMPT_MS, `settled after ${settled.ms}ms`);
    assert.ok(settled.error instanceof QueryError, String(settled.error));
    assert.equal(settled.error.kind, "connection-lost");
  } finally {
    await broker.close();
  }
});

test("client destroy() fails a transaction() callback and a scope, and sends no COMMIT", async () => {
  const broker = await silentBroker();
  try {
    await withoutUnhandledRejections(async () => {
      const client = clientFor(broker.port);
      let callbackFailure: unknown;
      const transaction = outcome(
        client.transaction(async (tx) => {
          try {
            await tx.query("SELECT 1");
          } catch (error) {
            callbackFailure = error;
            throw error;
          }
        }),
      );
      await broker.requested(1);
      const scope = await client.beginTransactionScope();
      const scoped = outcome(scope.query("SELECT 2"));
      await broker.requested(2);

      destroyStarted = Date.now();
      await client.destroy();

      const failed = await transaction;
      assert.ok(failed.ms < PROMPT_MS);
      assert.ok(failed.error instanceof TransactionError, String(failed.error));
      assert.equal(failed.error.kind, "connection-lost");
      assert.equal((callbackFailure as { kind?: string }).kind, "connection-lost");
      const scopeFailed = await scoped;
      assert.equal((scopeFailed.error as { kind?: string }).kind, "connection-lost");
      await assert.rejects(scope.commit(), TransactionError);

      // One request each, and nothing after: no COMMIT, no ROLLBACK, no replay.
      assert.equal(broker.connections(), 2);
      assert.equal(broker.requests(), 2);
    });
  } finally {
    await broker.close();
  }
});

test("client destroy() closes a custom connection without destroy() and does not wait for it", async () => {
  let closeCalls = 0;
  const connection: ConnectionLike = {
    connect: async () => {},
    query: () => new Promise(() => {}),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    close: () => {
      closeCalls += 1;
      return new Promise(() => {});
    },
  };
  const client = createClient({
    host: "127.0.0.1",
    database: "testdb",
    user: "dba",
    connectionFactory: () => connection,
  });
  void client.query("SELECT 1");
  await new Promise((resolve) => setTimeout(resolve, 10));

  destroyStarted = Date.now();
  const destroyed = await outcome(client.destroy());

  assert.equal(destroyed.error, undefined);
  assert.ok(destroyed.ms < PROMPT_MS);
  await until(() => closeCalls === 1);
  await client.close();
  assert.equal(closeCalls, 1);
});

test("the logging wrapper forwards destroy() only when the connection has one", async () => {
  const fields: ClientLogFields[] = [];
  const logger = { info: (_message: string, field: ClientLogFields) => fields.push(field) };
  let destroyed = 0;
  const base: ConnectionLike = {
    connect: async () => {},
    query: async () => [],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    close: async () => {},
  };

  const without = createClient({
    host: "h",
    database: "d",
    user: "u",
    logger,
    connectionFactory: () => ({ ...base }),
  });
  await without.query("SELECT 1");
  await without.destroy();

  const withDestroy = createClient({
    host: "h",
    database: "d",
    user: "u",
    logger,
    connectionFactory: () => ({
      ...base,
      destroy: () => {
        destroyed += 1;
      },
    }),
  });
  await withDestroy.query("SELECT 1");
  await withDestroy.destroy();
  await withDestroy.destroy();

  assert.equal(destroyed, 1);
  assert.equal(fields.filter((field) => field.operation === "destroy").length, 1);
});

test("destroy() while close() is sending CON_CLOSE still lets close() resolve", async () => {
  const broker = await silentBroker();
  try {
    const cas = new CASConnection({ ...CONFIG, port: broker.port });
    await cas.connect();
    let release = (): void => {};
    const hook = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const inHook = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const closing = outcome(
      cas.close(async () => {
        entered();
        await hook;
      }),
    );
    await inHook;

    destroyStarted = Date.now();
    cas.destroy();
    release();

    assert.equal((await closing).error, undefined);
  } finally {
    await broker.close();
  }
});
