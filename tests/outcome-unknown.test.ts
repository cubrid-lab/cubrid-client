/**
 * `outcomeUnknown` on the errors of the driver (#254): whether a request of the
 * failed operation may have taken effect on the server without the driver
 * knowing. Each case injects a failure at one boundary, over TCP, into a fake
 * CAS: before anything is sent, with a request in flight, after a reply that
 * says what happened, and at the END_TRAN of a commit. Every case also checks
 * that no SQL reached the server twice.
 */

import assert from "node:assert/strict";
import { createServer, type Socket as NetSocket, type Server } from "node:net";
import test from "node:test";
import {
  blob,
  ConnectionError,
  type CubridErrorDetails,
  createClient,
  createPool,
  QueryError,
  ReadTimeoutError,
  SqlSyntaxError,
  TransactionError,
} from "../src/index.js";
import { CASFunctionCode } from "../src/protocol/constants.js";
import { EXECUTE_ARRAY_FRAMES } from "./fixtures/dml-frames.js";

// ---------------------------------------------------------------------------
// The public declaration
// ---------------------------------------------------------------------------

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const declared: [
  Equal<CubridErrorDetails["outcomeUnknown"], boolean | undefined>,
  Equal<QueryError["outcomeUnknown"], boolean | undefined>,
  Equal<SqlSyntaxError["outcomeUnknown"], boolean | undefined>,
  Equal<TransactionError["outcomeUnknown"], boolean | undefined>,
  Equal<ConnectionError["outcomeUnknown"], boolean | undefined>,
  Equal<ReadTimeoutError["outcomeUnknown"], boolean | undefined>,
] = [true, true, true, true, true, true];

test("outcomeUnknown is an optional, read-only boolean on every public error class", () => {
  assert.deepEqual(declared, [true, true, true, true, true, true]);

  const error = new QueryError("failed", { outcomeUnknown: true });
  assert.equal(error.outcomeUnknown, true);
  // @ts-expect-error the error details are read-only
  error.outcomeUnknown = false;

  // Constructed without it, an error gains no property: absent means "not determined".
  assert.equal("outcomeUnknown" in new TransactionError("failed"), false);
  assert.equal(new ConnectionError("x", { outcomeUnknown: false }).outcomeUnknown, false);
});

// ---------------------------------------------------------------------------
// A fake CAS that can fail at any request
// ---------------------------------------------------------------------------

const CAS_INFO = Buffer.from([0x01, 0x02, 0x03, 0x04]);
/** CAS_INFO[0] = 0: the server says no transaction is open. */
const CAS_INFO_OUT_TRAN = Buffer.from([0x00, 0x02, 0x03, 0x04]);

/** Leave the request unanswered. */
const STALL = Symbol("stall");
/** Close the socket once the request arrives, without a reply. */
const CLOSE = Symbol("close");
/** Send half of a reply, then close the socket. */
const PARTIAL = Symbol("partial");
/** Announce a reply far over any maxReplyBytes, then send nothing. */
const OVERSIZE = Symbol("oversize");

type Step =
  | Buffer
  | { casInfo: Buffer; reply: Buffer }
  | typeof STALL
  | typeof CLOSE
  | typeof PARTIAL
  | typeof OVERSIZE;

interface FakeCas {
  port: number;
  /** Function codes of the requests each connection received, in order. */
  requests: number[][];
  /** How often `text` reached the server, over every connection. */
  sent: (text: string) => number;
  /** Resolves once `count` requests have arrived over every connection. */
  received: (count: number) => Promise<void>;
  close: () => Promise<void>;
}

function frame(payload: Buffer, casInfo: Buffer = CAS_INFO): Buffer {
  const header = Buffer.alloc(4);
  header.writeInt32BE(payload.length, 0);
  return Buffer.concat([header, casInfo, payload]);
}

function openDatabaseFrame(): Buffer {
  const brokerInfo = Buffer.alloc(8);
  brokerInfo[4] = 7; // protocol 7, as the captured frames
  const sessionId = Buffer.alloc(4);
  sessionId.writeInt32BE(1, 0);
  return frame(Buffer.concat([Buffer.alloc(4), brokerInfo, sessionId]));
}

/**
 * `scripts[n]` answers the requests of the nth connection in order; a missing
 * entry answers with result code 0, which a CLOSE_REQ_HANDLE or END_TRAN takes
 * as success.
 */
async function fakeCas(scripts: Step[][]): Promise<FakeCas> {
  const requests: number[][] = [];
  const bytes: Buffer[] = [];
  const sockets: NetSocket[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const total = (): number => requests.reduce((sum, each) => sum + each.length, 0);

  const server: Server = createServer((socket) => {
    sockets.push(socket);
    const received: number[] = [];
    requests.push(received);
    const script = scripts[requests.length - 1] ?? [];
    let pending = Buffer.alloc(0);
    socket.on("error", () => {});

    socket.once("data", () => {
      socket.write(Buffer.alloc(4));
      socket.once("data", () => {
        socket.write(openDatabaseFrame());
        socket.on("data", (chunk: Buffer) => {
          bytes.push(chunk);
          pending = Buffer.concat([pending, chunk]);
          // A request is DATA_LENGTH, CAS_INFO and DATA_LENGTH bytes of payload.
          while (pending.length >= 8 && pending.length >= 8 + pending.readInt32BE(0)) {
            const size = 8 + pending.readInt32BE(0);
            const functionCode = pending[8] ?? -1;
            pending = pending.subarray(size);
            const index = received.push(functionCode) - 1;
            for (const waiter of [...waiters]) {
              if (total() >= waiter.count) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve();
              }
            }
            answer(socket, script[index] ?? Buffer.alloc(4));
          }
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    port: typeof address === "object" && address ? address.port : 0,
    requests,
    sent: (text) => {
      const all = Buffer.concat(bytes);
      const needle = Buffer.from(text);
      let count = 0;
      for (let at = all.indexOf(needle); at !== -1; at = all.indexOf(needle, at + 1)) {
        count += 1;
      }
      return count;
    },
    received: (count) =>
      total() >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function answer(socket: NetSocket, step: Step): void {
  if (step === STALL) {
    return;
  }
  if (step === CLOSE) {
    socket.destroy();
    return;
  }
  if (step === PARTIAL) {
    const whole = frame(INSERT_OK);
    socket.write(whole.subarray(0, whole.length >> 1), () => socket.destroy());
    return;
  }
  if (step === OVERSIZE) {
    const header = Buffer.alloc(4);
    header.writeInt32BE(1 << 30, 0);
    socket.write(header);
    return;
  }
  socket.write(Buffer.isBuffer(step) ? frame(step) : frame(step.reply, step.casInfo));
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** A PREPARE_AND_EXECUTE reply for an INSERT of one row, handle 1, protocol 7. */
function insertReply(): Buffer {
  const handle = Buffer.alloc(4);
  handle.writeInt32BE(1, 0);
  const counts = Buffer.alloc(4);
  counts.writeInt32BE(1, 0);
  const resultCount = Buffer.alloc(4);
  resultCount.writeInt32BE(1, 0);
  const resultInfo = Buffer.alloc(21);
  resultInfo.writeInt8(20, 0);
  resultInfo.writeInt32BE(1, 1);
  return Buffer.concat([
    handle,
    Buffer.alloc(4), // result cache lifetime
    Buffer.from([20]), // INSERT
    Buffer.alloc(4), // bind count
    Buffer.from([0]), // not updatable
    Buffer.alloc(4), // no columns
    counts, // total tuple count
    Buffer.from([0]), // cache reusable
    resultCount,
    resultInfo,
    Buffer.alloc(5), // includes_column_info and shard_id
  ]);
}

const INSERT_OK = insertReply();
const OK = Buffer.alloc(4);

/** An error reply: the DBMS indicator -2, the server's code and its message. */
function serverError(code: number, message: string): Buffer {
  const text = Buffer.from(`${message}\0`);
  const head = Buffer.alloc(8);
  head.writeInt32BE(-2, 0);
  head.writeInt32BE(code, 4);
  return Buffer.concat([head, text]);
}

const hex = (value: string): Buffer => Buffer.from(value, "hex");

/** `INSERT INTO c_em (id, v) VALUES (?, ?)`: handle 3, two markers. */
const PREPARE_TWO_MARKERS = hex(EXECUTE_ARRAY_FRAMES.prepareInsert);

const STATEMENT = (marker: string): string => `INSERT INTO t (v) VALUES ('${marker}')`;

function clientFor(port: number, options: { readTimeout?: number; maxReplyBytes?: number } = {}) {
  return createClient({
    host: "127.0.0.1",
    port,
    database: "testdb",
    user: "dba",
    ...options,
  });
}

/** The rejection of `promise`, which must reject. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

function assertOutcome(error: unknown, outcomeUnknown: boolean): asserts error is Error {
  assert.ok(error instanceof Error, `not an Error: ${String(error)}`);
  assert.equal((error as CubridErrorDetails).outcomeUnknown, outcomeUnknown, error.message);
}

async function withCas(scripts: Step[][], run: (cas: FakeCas) => Promise<void>): Promise<void> {
  const cas = await fakeCas(scripts);
  try {
    await run(cas);
  } finally {
    await cas.close();
  }
}

// ---------------------------------------------------------------------------
// Before anything is sent: false
// ---------------------------------------------------------------------------

test("before send: a statement queued behind destroy() is false, the one in flight true", async () => {
  await withCas([[STALL]], async (cas) => {
    const client = clientFor(cas.port);
    const running = failure(client.query(STATEMENT("in-flight")));
    const queued = failure(client.query(STATEMENT("queued")));
    await cas.received(1);
    client.destroy();

    const inFlight = await running;
    assert.ok(inFlight instanceof QueryError);
    assert.equal(inFlight.kind, "connection-lost");
    assertOutcome(inFlight, true);
    assertOutcome(await queued, false);
    assertOutcome(await failure(client.query(STATEMENT("later"))), false);

    assert.equal(cas.sent("in-flight"), 1);
    assert.equal(cas.sent("queued"), 0);
    assert.equal(cas.sent("later"), 0);
  });
});

test("before send: no connection, a closed client and a statement after an unknown one are false", async () => {
  await withCas([[STALL]], async (cas) => {
    // Nothing listens on this port once the server is gone.
    const refusedPort = await fakeCas([]).then(async (other) => {
      await other.close();
      return other.port;
    });
    const unreachable = clientFor(refusedPort);
    assertOutcome(await failure(unreachable.query("SELECT 1")), false);
    await unreachable.close();

    const client = clientFor(cas.port, { readTimeout: 200 });
    const timedOut = failure(client.query(STATEMENT("first")));
    const waiting = failure(client.query(STATEMENT("waiting")));
    const first = await timedOut;
    assert.ok(first instanceof ReadTimeoutError);
    assertOutcome(first, true);
    // It waited behind a request with an unknown outcome, so it was refused unsent.
    assertOutcome(await waiting, false);
    assert.equal(cas.sent("waiting"), 0);

    await client.close();
    assertOutcome(await failure(client.query("SELECT 1")), false);
    assertOutcome(await failure(client.transaction(async () => undefined)), false);
  });
});

// ---------------------------------------------------------------------------
// In flight: true
// ---------------------------------------------------------------------------

for (const [name, step, options] of [
  ["no reply before readTimeout", STALL, { readTimeout: 200 }],
  ["the socket closed without a reply", CLOSE, {}],
  ["half a reply, then the socket closed", PARTIAL, {}],
  ["a reply over maxReplyBytes", OVERSIZE, { maxReplyBytes: 1 << 20 }],
] as const) {
  test(`in flight: ${name} is true, and the statement is not sent again`, async () => {
    await withCas([[step], [INSERT_OK, OK]], async (cas) => {
      const client = clientFor(cas.port, options);
      try {
        const error = await failure(client.query(STATEMENT("lost")));
        if (step === STALL) {
          assert.ok(error instanceof ReadTimeoutError);
        } else {
          assert.ok(error instanceof QueryError);
        }
        assertOutcome(error, true);

        // The session was retired: the next statement opens a new one and runs once.
        await client.query(STATEMENT("next"));
        assert.deepEqual(cas.requests, [
          [CASFunctionCode.PREPARE_AND_EXECUTE],
          [CASFunctionCode.PREPARE_AND_EXECUTE, CASFunctionCode.CLOSE_REQ_HANDLE],
        ]);
        assert.equal(cas.sent("lost"), 1);
      } finally {
        await client.close();
      }
    });
  });
}

test("in flight: an abort rejects with the caller's reason unchanged; transaction() reports true", async () => {
  await withCas([[STALL], [STALL]], async (cas) => {
    const client = clientFor(cas.port);
    try {
      const controller = new AbortController();
      const reason = new Error("caller gave up");
      const aborted = failure(client.query(STATEMENT("plain"), [], { signal: controller.signal }));
      await cas.received(1);
      controller.abort(reason);
      const error = await aborted;
      assert.equal(error, reason);
      // The caller's object is never marked.
      assert.equal("outcomeUnknown" in reason, false);

      const inTransaction = new AbortController();
      const transaction = failure(
        client.transaction(async (tx) => {
          await tx.query(STATEMENT("aborted-in-tx"), [], { signal: inTransaction.signal });
        }),
      );
      await cas.received(2);
      inTransaction.abort();
      const failed = await transaction;
      assert.ok(failed instanceof TransactionError);
      assert.equal((failed.cause as Error).name, "AbortError");
      assertOutcome(failed, true);

      assert.equal(cas.sent("plain"), 1);
      assert.equal(cas.sent("aborted-in-tx"), 1);
      // No ROLLBACK reached the retired session, and nothing was replayed elsewhere.
      assert.deepEqual(cas.requests, [
        [CASFunctionCode.PREPARE_AND_EXECUTE],
        [CASFunctionCode.PREPARE_AND_EXECUTE],
      ]);
    } finally {
      await client.close();
    }
  });
});

test("in flight: prepared EXECUTE, executeMany and a LOB upload are true", async () => {
  await withCas(
    [
      [PREPARE_TWO_MARKERS, STALL],
      [PREPARE_TWO_MARKERS, STALL],
      [PREPARE_TWO_MARKERS, STALL],
    ],
    async (cas) => {
      const client = clientFor(cas.port, { readTimeout: 200 });
      const sql = "INSERT INTO c_em (id, v) VALUES (?, ?)";
      try {
        assertOutcome(await failure(client.executePrepared(sql, [1, "a"])), true);
        assertOutcome(await failure(client.executeMany(sql, [[2, "b"]])), true);
        assertOutcome(
          await failure(client.executePrepared(sql, [3, blob(Buffer.from("x"))])),
          true,
        );

        assert.deepEqual(cas.requests, [
          [CASFunctionCode.PREPARE, CASFunctionCode.EXECUTE],
          [CASFunctionCode.PREPARE, CASFunctionCode.EXECUTE_ARRAY],
          // The LOB_NEW reply was lost, so EXECUTE was never sent.
          [CASFunctionCode.PREPARE, CASFunctionCode.LOB_NEW],
        ]);
      } finally {
        await client.close();
      }
    },
  );
});

test("in flight: a stream read and a stream cut by destroy() are true", async () => {
  await withCas([[STALL], [STALL]], async (cas) => {
    const timed = clientFor(cas.port, { readTimeout: 200 });
    try {
      const error = await failure(
        (async () => {
          for await (const _row of timed.stream("SELECT v FROM t")) {
            // never reached
          }
        })(),
      );
      assert.ok(error instanceof ReadTimeoutError);
      assertOutcome(error, true);
    } finally {
      await timed.close();
    }

    const destroyed = clientFor(cas.port);
    const reading = failure(
      (async () => {
        for await (const _row of destroyed.stream("SELECT v FROM t")) {
          // never reached
        }
      })(),
    );
    await cas.received(2);
    destroyed.destroy();
    assertOutcome(await reading, true);
  });
});

test("in flight: a pool statement is true; a refused lease is false", async () => {
  await withCas([[STALL]], async (cas) => {
    const pool = createPool({
      host: "127.0.0.1",
      port: cas.port,
      database: "testdb",
      user: "dba",
      readTimeout: 200,
    });
    assertOutcome(await failure(pool.query(STATEMENT("pooled"))), true);
    await pool.close();
    const closed = await failure(pool.query(STATEMENT("after close")));
    assert.ok(closed instanceof ConnectionError);
    assertOutcome(closed, false);
    assert.equal(cas.sent("pooled"), 1);
    assert.equal(cas.sent("after close"), 0);
  });
});

// ---------------------------------------------------------------------------
// After a reply that says what happened: false
// ---------------------------------------------------------------------------

test("after reply: a server error is false and keeps its code and kind", async () => {
  await withCas([[serverError(-493, "Syntax error")]], async (cas) => {
    const client = clientFor(cas.port);
    try {
      const error = await failure(client.query("SELEC 1"));
      assert.ok(error instanceof SqlSyntaxError);
      assert.equal(error.code, -493);
      assert.equal(error.kind, "syntax");
      assertOutcome(error, false);
    } finally {
      await client.close();
    }
  });
});

test("after reply: a failure after the PREPARE reply is false, even when the handle release is lost", async () => {
  await withCas([[PREPARE_TWO_MARKERS, STALL]], async (cas) => {
    const client = clientFor(cas.port, { readTimeout: 200 });
    try {
      // One marker in the SQL, two in the server's reply: refused before EXECUTE.
      const error = await failure(client.executePrepared("INSERT INTO c_em (id) VALUES (?)", [1]));
      assert.ok(error instanceof QueryError);
      assert.match(((error.cause as Error).cause as Error).message, /Parameter count mismatch/);
      assertOutcome(error, false);
      // The CLOSE_REQ_HANDLE went unanswered; it is cleanup, not part of the outcome.
      assert.deepEqual(cas.requests, [[CASFunctionCode.PREPARE, CASFunctionCode.CLOSE_REQ_HANDLE]]);
    } finally {
      await client.close();
    }
  });
});

test("after reply: an executeMany set the server rejected is false, with every set's outcome", async () => {
  await withCas(
    [[PREPARE_TWO_MARKERS, hex(EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate), OK, OK]],
    async (cas) => {
      const client = clientFor(cas.port);
      try {
        const error = await failure(
          client.executeMany("INSERT INTO c_em (id, v) VALUES (?, ?)", [
            [6, "f"],
            [1, "dup"],
            [7, "g"],
          ]),
        );
        assert.ok(error instanceof QueryError);
        assert.equal(error.kind, "unique-violation");
        assert.equal(error.batch?.rolledBack, true);
        assertOutcome(error, false);
      } finally {
        await client.close();
      }
    },
  );
});

test("after reply: transaction() rolled back after a syntax error is false with the cause's code", async () => {
  await withCas([[serverError(-493, "Syntax error"), OK]], async (cas) => {
    const client = clientFor(cas.port);
    try {
      const error = await failure(client.transaction((tx) => tx.query("SELEC 1")));
      assert.ok(error instanceof TransactionError);
      assert.equal(error.code, -493);
      assert.equal(error.kind, "syntax");
      assertOutcome(error, false);
      assert.deepEqual(cas.requests, [
        [CASFunctionCode.PREPARE_AND_EXECUTE, CASFunctionCode.END_TRAN],
      ]);
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The commit boundary
// ---------------------------------------------------------------------------

test("commit: a lost END_TRAN reply is true, and COMMIT is sent once", async () => {
  await withCas(
    [
      [INSERT_OK, OK, STALL],
      [INSERT_OK, OK, CLOSE],
    ],
    async (cas) => {
      const timed = clientFor(cas.port, { readTimeout: 200 });
      try {
        await timed.beginTransaction();
        await timed.query(STATEMENT("manual"));
        const error = await failure(timed.commit());
        assert.ok(error instanceof ReadTimeoutError);
        assertOutcome(error, true);
      } finally {
        await timed.close();
      }

      const client = clientFor(cas.port);
      try {
        const error = await failure(
          client.transaction(async (tx) => {
            await tx.query(STATEMENT("callback"));
          }),
        );
        assert.ok(error instanceof TransactionError);
        assertOutcome(error, true);
      } finally {
        await client.close();
      }

      const commit = [
        CASFunctionCode.PREPARE_AND_EXECUTE,
        CASFunctionCode.CLOSE_REQ_HANDLE,
        CASFunctionCode.END_TRAN,
      ];
      assert.deepEqual(cas.requests, [commit, commit]);
      assert.equal(cas.sent("manual"), 1);
      assert.equal(cas.sent("callback"), 1);
    },
  );
});

test("commit: an END_TRAN error reply is false", async () => {
  await withCas([[INSERT_OK, OK, serverError(-1, "commit refused"), OK]], async (cas) => {
    const client = clientFor(cas.port);
    try {
      await client.beginTransaction();
      await client.query(STATEMENT("refused"));
      const error = await failure(client.commit());
      assert.ok(error instanceof TransactionError);
      assert.equal(error.code, -1);
      assertOutcome(error, false);
    } finally {
      await client.rollback().catch(() => undefined);
      await client.close();
    }
  });
});

test("commit: refused unsent after a statement was lost, the transaction is still true", async () => {
  await withCas([[CLOSE], [CLOSE]], async (cas) => {
    const client = clientFor(cas.port);
    try {
      await client.beginTransaction();
      assertOutcome(await failure(client.query(STATEMENT("lost-manual"))), true);
      // COMMIT is never sent, but the server may have kept the statement's work.
      assertOutcome(await failure(client.commit()), true);

      const error = await failure(
        client.transaction(async (tx) => {
          await tx.query(STATEMENT("lost-callback"));
        }),
      );
      assert.ok(error instanceof TransactionError);
      assertOutcome(error, true);

      assert.deepEqual(cas.requests, [
        [CASFunctionCode.PREPARE_AND_EXECUTE],
        [CASFunctionCode.PREPARE_AND_EXECUTE],
      ]);
    } finally {
      await client.close();
    }
  });
});

test("commit: refused unsent when the server ended the transaction, with every reply in hand, is false", async () => {
  await withCas([[{ casInfo: CAS_INFO_OUT_TRAN, reply: INSERT_OK }, OK]], async (cas) => {
    const client = clientFor(cas.port);
    try {
      await client.beginTransaction();
      const statement = await failure(client.query(STATEMENT("ended")));
      assertOutcome(statement, false);
      const commit = await failure(client.commit());
      assert.ok(commit instanceof TransactionError);
      assertOutcome(commit, false);
      // The session was dropped on that reply, before its handle release, and
      // COMMIT never reached it.
      assert.deepEqual(cas.requests, [[CASFunctionCode.PREPARE_AND_EXECUTE]]);
    } finally {
      await client.close();
    }
  });
});

test("scope: a lost COMMIT reply is true, a refused one after a server error false", async () => {
  await withCas(
    [
      [INSERT_OK, OK, CLOSE],
      [serverError(-493, "Syntax error"), OK],
    ],
    async (cas) => {
      const client = clientFor(cas.port);
      try {
        const lost = await client.beginTransactionScope();
        await lost.query(STATEMENT("scoped"));
        const error = await failure(lost.commit());
        assert.ok(error instanceof TransactionError);
        assertOutcome(error, true);

        const refused = await client.beginTransactionScope();
        // Nothing observed this failure, so commit() rolls back instead.
        void refused.query("SELEC 1");
        const rolledBack = await failure(refused.commit());
        assert.ok(rolledBack instanceof TransactionError);
        assert.equal(rolledBack.kind, "syntax");
        assertOutcome(rolledBack, false);
        assert.equal(cas.sent("scoped"), 1);
      } finally {
        await client.close();
      }
    },
  );
});

test("before send: a value or marker count refused when called is false", async () => {
  await withCas([], async (cas) => {
    const client = clientFor(cas.port);
    try {
      assertOutcome(await failure(client.query("SELECT ?", [1, 2])), false);
      assertOutcome(
        await failure(client.executePrepared("SELECT ?", [Symbol("refused") as never])),
        false,
      );
      assertOutcome(
        await failure(client.executeMany("INSERT INTO t VALUES (?)", [[1], [1, 2]])),
        false,
      );
      assert.deepEqual(cas.requests, []);
    } finally {
      await client.close();
    }
  });
});

test("commit: a rollback() after a commit() with an unknown outcome is still true", async () => {
  await withCas(
    [
      [INSERT_OK, OK, CLOSE],
      [INSERT_OK, OK, CLOSE],
    ],
    async (cas) => {
      const client = clientFor(cas.port);
      try {
        await client.beginTransaction();
        await client.query(STATEMENT("manual"));
        assertOutcome(await failure(client.commit()), true);
        assertOutcome(await failure(client.rollback()), true);

        const scope = await client.beginTransactionScope();
        await scope.query(STATEMENT("scoped"));
        assertOutcome(await failure(scope.commit()), true);
        // The usual catch block: the refusal repeats what the transaction's outcome is.
        assertOutcome(await failure(scope.rollback()), true);

        assert.equal(cas.sent("manual"), 1);
        assert.equal(cas.sent("scoped"), 1);
      } finally {
        await client.close();
      }
    },
  );
});

test("commit: a damaged GET_LAST_INSERT_ID reply inside a transaction makes it true", async () => {
  await withCas([[serverError(-493, "Syntax error"), Buffer.from([0])]], async (cas) => {
    const client = clientFor(cas.port);
    try {
      await client.beginTransaction();
      // A failed statement leaves the session's insert id unknown, so the next INSERT reads it first.
      assertOutcome(await failure(client.query("SELEC 1")), false);
      assertOutcome(await failure(client.execute(STATEMENT("never"))), true);
      assertOutcome(await failure(client.commit()), true);
      assert.deepEqual(cas.requests, [
        [CASFunctionCode.PREPARE_AND_EXECUTE, CASFunctionCode.GET_LAST_INSERT_ID],
      ]);
      assert.equal(cas.sent("never"), 0);
    } finally {
      await client.close();
    }
  });
});
