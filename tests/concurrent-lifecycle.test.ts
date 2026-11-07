/**
 * Overlapping query lifecycles on one CAS connection.
 *
 * One db.query() is several CAS requests: PREPARE_AND_EXECUTE, any number of
 * FETCHes, then CLOSE_REQ_HANDLE. CASConnection keeps those frames from
 * overlapping, but what matters here is what a broker does with a statement
 * that runs between them. The fake CAS below reproduces what CUBRID 10.2, 11.0,
 * 11.2 and 11.4 did in the live probes behind tests/integration.test.ts:
 *
 * - Query handle numbers are per session and start at 1, so the same number on
 *   a newer session is someone else's result.
 * - In autocommit mode the transaction ends on the reply to DML, to an error, to
 *   GET_DB_VERSION, to a SELECT that fit its first reply, and to the last FETCH
 *   of a SELECT. Every other cursor on the session closes with it.
 * - Fetching a handle closed that way fails with -1012. Fetching a number that
 *   session never issued fails with -1006.
 * - CAS_INFO[0] is 1 inside a transaction and 0 after it ends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket as NetSocket } from "node:net";

import { createClient } from "../src/client/create-client.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { CASFunctionCode, EndTranType } from "../src/protocol/constants.js";

const CAS_ER_NO_MORE_DATA = -1012;
const CAS_ER_SRV_HANDLE = -1006;
const STATEMENT_INSERT = 20;
const STATEMENT_SELECT = 21;
const COLUMN_STRING = 2;
const HANDSHAKE_BYTES = 10 + 628;

/** Rows one reply can carry, so that ROW_COUNT needs FETCH like wide live rows do. */
const PAGE_SIZE = 100;
const ROW_COUNT = 250;

interface Row {
  id: string;
  owner: string;
}

interface Cursor {
  owner: string;
  rows: Row[];
}

interface WireRequest {
  session: number;
  code: number;
  handle?: number;
  sql?: string;
  autocommit?: boolean;
  owner?: string;
  tranType?: number;
}

interface Session {
  id: number;
  socket: NetSocket;
  cursors: Map<number, Cursor>;
  closedByTransactionEnd: Set<number>;
  inTransaction: boolean;
}

function rowsOf(owner: string, count = ROW_COUNT): Row[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: `${owner}-${index}`, owner }));
}

function selectFor(owner: string): string {
  return `SELECT id, owner FROM items WHERE owner = '${owner}'`;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function text(value: string): Buffer {
  return Buffer.concat([int32(value.length + 1), Buffer.from(value, "utf-8"), Buffer.from([0])]);
}

function errorReply(code: number, message: string): Buffer {
  return Buffer.concat([int32(-1), int32(code), Buffer.from(message, "utf-8"), Buffer.from([0])]);
}

function columnMetadata(name: string): Buffer {
  const noFlags = Buffer.alloc(7);
  return Buffer.concat([
    Buffer.from([COLUMN_STRING, 0, 0]),
    int32(255),
    text(name),
    text(name),
    text(""),
    Buffer.from([1]),
    text(""),
    noFlags,
  ]);
}

function encodeRows(rows: Row[], firstPosition: number): Buffer {
  const parts: Buffer[] = [int32(rows.length)];
  rows.forEach((row, index) => {
    parts.push(int32(firstPosition + index), Buffer.alloc(8));
    for (const value of [row.id, row.owner]) {
      parts.push(int32(value.length + 1), Buffer.from(value, "utf-8"), Buffer.from([0]));
    }
  });
  return Buffer.concat(parts);
}

function executeReply(handle: number, statementType: number, columns: string[], total: number, inline: Buffer | null): Buffer {
  const resultInfo = Buffer.alloc(21);
  resultInfo.writeInt8(statementType, 0);
  resultInfo.writeInt32BE(total, 1);

  return Buffer.concat([
    int32(handle),
    int32(0),
    Buffer.from([statementType]),
    int32(0),
    Buffer.from([0]),
    int32(columns.length),
    ...columns.map(columnMetadata),
    int32(total),
    Buffer.from([0]),
    int32(1),
    resultInfo,
    ...(inline ? [int32(0), inline] : []),
  ]);
}

/** A CAS that keeps real per-session handle and transaction state. */
class FakeCas {
  readonly requests: WireRequest[] = [];
  /** Every CAS request as sent: DATA_LENGTH, CAS_INFO and payload. */
  readonly frames: Buffer[] = [];
  readonly sockets = new Set<NetSocket>();
  /** Most cursors with undelivered rows that were ever open at once. */
  peakOpenCursors = 0;
  /** FETCHes the server refused, whatever the client went on to do with them. */
  refusedFetches = 0;
  /** Reply to FETCHes of this owner with a server error. */
  failFetchOf: string | null = null;
  /** Drop the socket at the first FETCH of this owner. */
  dropAtFetchOf: string | null = null;
  /** Leave the execute of this owner unanswered. */
  stallAtExecuteOf: string | null = null;
  /** Answer CHECK_CAS as a CAS does once its database server is gone. */
  failCheckCas = false;
  /** Answer this owner's next SELECT with a reply that stops mid-header. */
  malformExecuteOf: string | null = null;
  /** Close this many incoming connections before their handshake. */
  refuseConnections = 0;

  private server!: Server;
  private sessionCount = 0;

  async start(): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  of(code: number): WireRequest[] {
    return this.requests.filter((request) => request.code === code);
  }

  private accept(socket: NetSocket): void {
    if (this.refuseConnections > 0) {
      this.refuseConnections -= 1;
      socket.destroy();
      return;
    }

    this.sessionCount += 1;
    this.sockets.add(socket);
    const session: Session = {
      id: this.sessionCount,
      socket,
      cursors: new Map(),
      closedByTransactionEnd: new Set(),
      inTransaction: false,
    };
    let pending = Buffer.alloc(0);
    let handshakeLeft = HANDSHAKE_BYTES;
    let brokerAnswered = false;

    socket.on("error", () => {});
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      if (handshakeLeft > 0) {
        if (!brokerAnswered && pending.length >= 10) {
          brokerAnswered = true;
          socket.write(int32(0));
        }
        const consumed = Math.min(handshakeLeft, pending.length);
        handshakeLeft -= consumed;
        pending = pending.subarray(consumed);
        if (handshakeLeft === 0) {
          this.reply(session, Buffer.alloc(16), 1);
        }
      }

      while (pending.length >= 8 && pending.length >= 8 + pending.readInt32BE(0)) {
        const end = 8 + pending.readInt32BE(0);
        const payload = pending.subarray(8, end);
        this.frames.push(Buffer.from(pending.subarray(0, end)));
        pending = pending.subarray(end);
        this.handle(session, payload);
      }
    });
  }

  private reply(session: Session, payload: Buffer, status: number): void {
    const casInfo = Buffer.from([status, 0, 0, 0]);
    session.socket.write(Buffer.concat([int32(payload.length), casInfo, payload]));
  }

  private replyWithStatus(session: Session, payload: Buffer): void {
    this.reply(session, payload, session.inTransaction ? 1 : 0);
  }

  private endTransaction(session: Session): void {
    for (const handle of session.cursors.keys()) {
      session.closedByTransactionEnd.add(handle);
    }
    session.cursors.clear();
    session.inTransaction = false;
  }

  private openHandle(session: Session, cursor: Cursor): number {
    let handle = 1;
    while (session.cursors.has(handle)) {
      handle += 1;
    }
    session.closedByTransactionEnd.delete(handle);
    session.cursors.set(handle, cursor);
    this.peakOpenCursors = Math.max(this.peakOpenCursors, session.cursors.size);
    return handle;
  }

  private handle(session: Session, payload: Buffer): void {
    const code = payload[0]!;

    switch (code) {
      case CASFunctionCode.PREPARE_AND_EXECUTE:
        this.prepareAndExecute(session, payload);
        break;
      case CASFunctionCode.FETCH:
        this.fetch(session, payload);
        break;
      case CASFunctionCode.CLOSE_REQ_HANDLE: {
        const handle = payload.readInt32BE(5);
        this.requests.push({ session: session.id, code, handle });
        session.cursors.delete(handle);
        this.replyWithStatus(session, int32(0));
        break;
      }
      case CASFunctionCode.END_TRAN:
        this.requests.push({ session: session.id, code, tranType: payload[5]! });
        this.endTransaction(session);
        this.replyWithStatus(session, int32(0));
        break;
      case CASFunctionCode.GET_DB_VERSION:
        this.requests.push({ session: session.id, code, autocommit: payload[5] === 1 });
        if (payload[5] === 1) {
          this.endTransaction(session);
        }
        this.replyWithStatus(session, Buffer.concat([int32(0), Buffer.from("11.4.0.0000\0")]));
        break;
      case CASFunctionCode.CHECK_CAS:
        this.requests.push({ session: session.id, code });
        this.replyWithStatus(
          session,
          this.failCheckCas ? Buffer.from("ffffffff0000232700", "hex") : Buffer.alloc(0),
        );
        break;
      default:
        this.requests.push({ session: session.id, code });
    }
  }

  private prepareAndExecute(session: Session, payload: Buffer): void {
    const sqlLength = payload.readInt32BE(9);
    const sql = payload.toString("utf-8", 13, 13 + sqlLength - 1);
    const autocommit = payload[13 + sqlLength + 9] === 1;
    const owner = /owner = '(\w+)'/.exec(sql)?.[1];
    this.requests.push({
      session: session.id,
      code: CASFunctionCode.PREPARE_AND_EXECUTE,
      sql,
      autocommit,
      ...(owner !== undefined && { owner }),
    });
    session.inTransaction = true;

    if (owner !== undefined && owner === this.stallAtExecuteOf) {
      this.stallAtExecuteOf = null;
      return;
    }

    if (owner !== undefined && owner === this.malformExecuteOf) {
      this.malformExecuteOf = null;
      // A handle and a statement type, then the reply stops mid-header.
      const truncated = Buffer.concat([int32(1), int32(0), Buffer.from([STATEMENT_SELECT])]);
      this.replyWithStatus(session, truncated);
      return;
    }

    if (sql.startsWith("FAIL")) {
      if (autocommit) {
        this.endTransaction(session);
      }
      this.replyWithStatus(session, errorReply(-493, "syntax error"));
      return;
    }

    if (sql.startsWith("INSERT")) {
      const handle = this.openHandle(session, { owner: "", rows: [] });
      if (autocommit) {
        this.endTransaction(session);
      }
      this.replyWithStatus(session, executeReply(handle, STATEMENT_INSERT, [], 1, null));
      return;
    }

    const rows = sql.includes("CHAR_LENGTH")
      ? [{ id: "2", owner: "probe" }]
      : rowsOf(owner ?? "nobody");
    const handle = this.openHandle(session, { owner: owner ?? "", rows });
    const inline = rows.slice(0, PAGE_SIZE);

    if (autocommit && inline.length === rows.length) {
      this.endTransaction(session);
    }

    this.replyWithStatus(
      session,
      executeReply(handle, STATEMENT_SELECT, ["id", "owner"], rows.length, encodeRows(inline, 1)),
    );
  }

  private fetch(session: Session, payload: Buffer): void {
    const handle = payload.readInt32BE(5);
    const start = payload.readInt32BE(13) - 1;
    const size = Math.min(payload.readInt32BE(21), PAGE_SIZE);
    const cursor = session.cursors.get(handle);
    this.requests.push({
      session: session.id,
      code: CASFunctionCode.FETCH,
      handle,
      ...(cursor && { owner: cursor.owner }),
    });

    if (!cursor) {
      this.refusedFetches += 1;
      const code = session.closedByTransactionEnd.has(handle)
        ? CAS_ER_NO_MORE_DATA
        : CAS_ER_SRV_HANDLE;
      this.replyWithStatus(session, errorReply(code, ""));
      return;
    }

    if (cursor.owner === this.dropAtFetchOf) {
      this.dropAtFetchOf = null;
      session.socket.destroy();
      return;
    }

    if (cursor.owner === this.failFetchOf) {
      this.replyWithStatus(session, errorReply(-1000, "fetch rejected for this test"));
      return;
    }

    const page = cursor.rows.slice(start, start + size);
    if (start + size >= cursor.rows.length && session.inTransaction && this.isAutocommitCursor(session)) {
      this.endTransaction(session);
    }

    this.replyWithStatus(session, Buffer.concat([int32(0), encodeRows(page, start + 1)]));
  }

  /** Whether the latest statement on this session ran in autocommit mode. */
  private isAutocommitCursor(session: Session): boolean {
    const statements = this.requests.filter(
      (request) => request.session === session.id && request.sql !== undefined,
    );
    return statements.at(-1)?.autocommit === true;
  }
}

async function withClient(
  run: (client: ReturnType<typeof createClient>, cas: FakeCas) => Promise<void>,
  readTimeout = 2000,
): Promise<void> {
  const cas = new FakeCas();
  const port = await cas.start();
  const client = createClient({
    host: "127.0.0.1",
    port,
    database: "testdb",
    user: "dba",
    readTimeout,
  });

  try {
    await run(client, cas);
  } finally {
    await client.close().catch(() => {});
    await cas.stop();
  }
}

/** Owners in wire order of their requests, with adjacent repeats collapsed. */
function ownerRuns(requests: WireRequest[]): string[] {
  const runs: string[] = [];
  for (const { owner } of requests) {
    if (owner !== undefined && runs.at(-1) !== owner) {
      runs.push(owner);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Results stay with the query that asked for them
// ---------------------------------------------------------------------------

test("concurrent SELECTs that need FETCH each return exactly their own rows", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const owners = ["a", "b", "c", "d", "e", "f"];

    const results = await Promise.all(owners.map((owner) => client.query(selectFor(owner))));

    owners.forEach((owner, index) => assert.deepEqual(results[index], rowsOf(owner)));
    assert.ok(cas.of(CASFunctionCode.FETCH).length >= owners.length, "the rows must need FETCH");
    assert.equal(cas.refusedFetches, 0);
  });
});

test("repeated Promise.all rounds on one client keep returning exact rows", { timeout: 10000 }, async () => {
  await withClient(async (client) => {
    for (let round = 0; round < 10; round += 1) {
      const owners = [`a${round}`, `b${round}`, `c${round}`];
      const results = await Promise.all(owners.map((owner) => client.query(selectFor(owner))));
      owners.forEach((owner, index) => assert.deepEqual(results[index], rowsOf(owner)));
    }
  });
});

test("one query finishes its requests before the next query starts", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await Promise.all(["a", "b", "c"].map((owner) => client.query(selectFor(owner))));

    assert.deepEqual(ownerRuns(cas.requests), ["a", "b", "c"]);
    assert.equal(cas.peakOpenCursors, 1);
  });
});

test("parameterized concurrent queries probe the backslash mode once per session and keep their rows", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const owners = ["a", "b", "c"];

    const results = await Promise.all(
      owners.map((owner) =>
        client.query("SELECT id, owner FROM items WHERE owner = ? AND note = ?", [owner, "x\\y"]),
      ),
    );

    owners.forEach((owner, index) => assert.deepEqual(results[index], rowsOf(owner)));
    const probes = cas.requests.filter((request) => request.sql?.includes("CHAR_LENGTH"));
    const statements = cas.requests.filter((request) => request.sql?.includes("note = "));
    assert.equal(statements.length, owners.length);
    for (const statement of statements) {
      const onSession = probes.filter((probe) => probe.session === statement.session);
      assert.equal(onSession.length, 1, "each statement's own session is probed before it");
    }
  });
});

test("parameters that both backslash modes render alike are sent without a probe", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.query("SELECT id, owner FROM items WHERE owner = ? AND n = ?", ["a", 7]);

    assert.equal(cas.requests.filter((request) => request.sql?.includes("CHAR_LENGTH")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Statements that end the server transaction
// ---------------------------------------------------------------------------

test("an autocommit INSERT issued mid-SELECT does not close that SELECT's cursor", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const [before, inserted, after] = await Promise.all([
      client.query(selectFor("a")),
      client.query("INSERT INTO items VALUES (1)"),
      client.query(selectFor("b")),
    ]);

    assert.deepEqual(before, rowsOf("a"));
    assert.deepEqual(inserted, []);
    assert.deepEqual(after, rowsOf("b"));
    assert.equal(cas.refusedFetches, 0);
  });
});

test("a ping issued mid-SELECT does not close that SELECT's cursor", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const [rows, version] = await Promise.all([client.query(selectFor("a")), client.ping()]);

    assert.deepEqual(rows, rowsOf("a"));
    assert.equal(version, "11.4.0.0000");
    assert.equal(cas.refusedFetches, 0);
  });
});

// ---------------------------------------------------------------------------
// Errors and cleanup stay inside the failing query
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A ping never ends a transaction
// ---------------------------------------------------------------------------

test("a ping commits only outside a transaction, by its exact bytes", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.ping();
    assert.deepEqual(
      cas.frames.map((frame) => frame.toString("hex")),
      ["00000006" + "01000000" + "0f" + "00000001" + "01"],
    );

    await client.beginTransaction();
    await client.query("INSERT INTO t VALUES (1)");
    cas.frames.length = 0;

    assert.equal(await client.ping(), "11.4.0.0000");
    assert.deepEqual(
      cas.frames.map((frame) => frame.toString("hex")),
      [
        "00000001" + "01000000" + "20",
        "00000006" + "01000000" + "0f" + "00000001" + "00",
      ],
    );

    await client.query("INSERT INTO t VALUES (2)");
    const inserts = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.equal(inserts.at(-1)?.session, inserts.at(-2)?.session);
    assert.equal(cas.of(CASFunctionCode.END_TRAN).length, 0);
  });
});

test("getServerVersion keeps a transaction open, by its exact bytes", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.beginTransaction();
    await client.query("INSERT INTO t VALUES (1)");
    cas.frames.length = 0;

    assert.equal(await client.getServerVersion(), "11.4.0.0000");
    assert.deepEqual(
      cas.frames.map((frame) => frame.toString("hex")),
      [
        "00000001" + "01000000" + "20",
        "00000006" + "01000000" + "0f" + "00000001" + "00",
      ],
    );

    await client.query("INSERT INTO t VALUES (2)");
    const inserts = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.equal(inserts.at(-1)?.session, inserts.at(-2)?.session);
    assert.equal(cas.of(CASFunctionCode.END_TRAN).length, 0);
  });
});

test("a ping inside a transaction fails when CHECK_CAS does", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.beginTransaction();
    await client.query("INSERT INTO t VALUES (1)");
    cas.failCheckCas = true;

    await assert.rejects(client.ping(), (error: Error) => {
      assert.ok(error instanceof ConnectionError);
      assert.match(error.message, /Health check failed/);
      return true;
    });
    assert.equal(cas.of(CASFunctionCode.GET_DB_VERSION).length, 0);
  });
});

test("a failing statement rejects alone and the queries around it keep their rows", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const [first, failed, last] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query("FAIL here"),
      client.query(selectFor("b")),
    ]);

    assert.equal(first.status, "fulfilled");
    assert.deepEqual(first.status === "fulfilled" && first.value, rowsOf("a"));
    assert.equal(failed.status, "rejected");
    assert.equal(last.status, "fulfilled");
    assert.deepEqual(last.status === "fulfilled" && last.value, rowsOf("b"));
    assert.equal(cas.refusedFetches, 0);
  });
});

test("a FETCH error closes the failing query's handle and no other", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.failFetchOf = "a";

    const [failed, other] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query(selectFor("b")),
    ]);

    assert.equal(failed.status, "rejected");
    assert.equal(other.status, "fulfilled");
    assert.deepEqual(other.status === "fulfilled" && other.value, rowsOf("b"));
    const fetchOfA = cas.of(CASFunctionCode.FETCH).find((request) => request.owner === "a");
    const closes = cas.of(CASFunctionCode.CLOSE_REQ_HANDLE);
    assert.equal(closes.some((request) => request.handle === fetchOfA?.handle), true);
    assert.equal(cas.refusedFetches, 0);
  });
});

// ---------------------------------------------------------------------------
// Reconnects never carry a request onto another session, and nothing is retried
// ---------------------------------------------------------------------------

test("a lost socket rejects the queries waiting on it without sending them anywhere", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.ping();
    cas.dropAtFetchOf = "a";

    const [lost, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query(selectFor("b")),
    ]);

    assert.equal(lost.status, "rejected");
    assert.equal(queued.status, "rejected");
    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => request.owner), ["a"]);
    assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).length, 0);
  });
});

test("an INSERT queued on a new client is not sent after the first query loses its socket", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.dropAtFetchOf = "a";

    const [lost, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query("INSERT INTO items VALUES (1)"),
    ]);

    assert.equal(lost.status, "rejected");
    assert.equal(queued.status, "rejected");
    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => request.owner), ["a"]);
  });
});

test("an INSERT queued on a new client is not sent after the first query times out", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.stallAtExecuteOf = "a";

    const [timedOut, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query("INSERT INTO items VALUES (1)"),
    ]);

    assert.equal(timedOut.status, "rejected");
    assert.ok(timedOut.status === "rejected" && timedOut.reason instanceof ReadTimeoutError);
    assert.equal(queued.status, "rejected");
    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => request.owner), ["a"]);
  }, 100);
});

test("a ping that reconnects does not release the INSERT queued behind a lost socket", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.ping();
    cas.dropAtFetchOf = "a";

    const [lost, health, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.ping(),
      client.query("INSERT INTO items VALUES (1)"),
    ]);

    assert.equal(lost.status, "rejected");
    assert.equal(health.status, "fulfilled");
    assert.equal(queued.status, "rejected");
    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => request.owner), ["a"]);
  });
});

test("an INSERT waiting behind a malformed reply is not sent, and the next query recovers", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.ping();
    cas.malformExecuteOf = "a";

    const [malformed, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query("INSERT INTO items VALUES (1)"),
    ]);

    assert.equal(malformed.status, "rejected");
    assert.equal(queued.status, "rejected");
    const sent = (): (string | undefined)[] =>
      cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).map((request) => request.owner);
    assert.deepEqual(sent(), ["a"]);
    assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).length, 0);

    assert.deepEqual(await client.query(selectFor("b")), rowsOf("b"));
    assert.deepEqual(sent(), ["a", "b"]);
  });
});

test("db.query() exposes a malformed reply by its name further down the cause chain", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.malformExecuteOf = "a";

    await assert.rejects(client.query(selectFor("a")), (error: Error) => {
      assert.equal(error.name, "QueryError");
      assert.equal((error.cause as Error).name, "QueryError");
      assert.equal(((error.cause as Error).cause as Error).name, "MalformedReplyError");
      return true;
    });
  });
});

test("a ping that reconnects does not release the INSERT queued behind a malformed reply", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.ping();
    cas.malformExecuteOf = "a";

    const [malformed, health, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.ping(),
      client.query("INSERT INTO items VALUES (1)"),
    ]);

    assert.equal(malformed.status, "rejected");
    assert.equal(health.status, "fulfilled");
    assert.equal(queued.status, "rejected");
    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => request.owner), ["a"]);
  });
});

test("a query queued behind a failed first connect still gets its own attempt", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.refuseConnections = 1;

    const [refused, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query(selectFor("b")),
    ]);

    assert.equal(refused.status, "rejected");
    assert.equal(queued.status, "fulfilled");
    assert.deepEqual(queued.status === "fulfilled" && queued.value, rowsOf("b"));
  });
});

test("the next query after a lost socket runs once on a new session, with nothing replayed", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.dropAtFetchOf = "a";
    await assert.rejects(client.query(selectFor("a")));

    assert.deepEqual(await client.query(selectFor("b")), rowsOf("b"));

    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => [request.owner, request.session]), [["a", 1], ["b", 2]]);
    assert.deepEqual(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).map((request) => request.session), [2]);
  });
});

test("a query issued right after close rejects and leaves no session open", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    assert.deepEqual(await client.query(selectFor("a")), rowsOf("a"));

    const [closed, late] = await Promise.allSettled([client.close(), client.query(selectFor("b"))]);

    assert.equal(closed.status, "fulfilled");
    assert.equal(late.status, "rejected");
    await assert.rejects(client.query(selectFor("c")));

    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => request.owner), ["a"]);
    for (let waited = 0; cas.sockets.size > 0 && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cas.sockets.size, 0);
  });
});

test("the session released by one query's commit never receives another query's FETCH", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await Promise.all(["a", "b"].map((owner) => client.query(selectFor(owner))));

    const executedOn = new Map(
      cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).map((request) => [request.owner, request.session]),
    );
    for (const fetch of cas.of(CASFunctionCode.FETCH)) {
      assert.equal(fetch.session, executedOn.get(fetch.owner));
    }
    assert.equal(cas.refusedFetches, 0);
  });
});

// ---------------------------------------------------------------------------
// Transactions and close wait their turn
// ---------------------------------------------------------------------------

test("commit issued alongside queries runs after them", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.beginTransaction();

    const [a, b] = await Promise.all([
      client.query(selectFor("a")),
      client.query(selectFor("b")),
      client.commit(),
    ]);

    assert.deepEqual(a, rowsOf("a"));
    assert.deepEqual(b, rowsOf("b"));
    const order = cas.requests.map((request) => request.code);
    assert.ok(order.lastIndexOf(CASFunctionCode.FETCH) < order.indexOf(CASFunctionCode.END_TRAN));
    assert.equal(cas.of(CASFunctionCode.END_TRAN)[0]?.tranType, EndTranType.COMMIT);
  });
});

test("rollback ends only the statements issued before it", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await client.beginTransaction();

    const [inside, , outside] = await Promise.all([
      client.query(selectFor("a")),
      client.rollback(),
      client.query(selectFor("b")),
    ]);

    assert.deepEqual(inside, rowsOf("a"));
    assert.deepEqual(outside, rowsOf("b"));
    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => [request.owner, request.autocommit]), [["a", false], ["b", true]]);
    assert.equal(cas.of(CASFunctionCode.END_TRAN)[0]?.tranType, EndTranType.ROLLBACK);
  });
});

test("beginTransaction applies only to statements issued after it", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await Promise.all([
      client.query(selectFor("a")),
      client.beginTransaction(),
      client.query(selectFor("b")),
      client.rollback(),
    ]);

    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(executions.map((request) => [request.owner, request.autocommit]), [["a", true], ["b", false]]);
  });
});

test("a failed statement inside transaction() rolls back after its siblings finish", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const results: PromiseSettledResult<unknown>[] = [];

    await assert.rejects(
      client.transaction(async (tx) => {
        const pending = [tx.query(selectFor("a")), tx.query("FAIL here"), tx.query(selectFor("b"))];
        void Promise.allSettled(pending).then((settled) => results.push(...settled));
        await Promise.all(pending);
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
    const order = cas.requests.map((request) => request.code);
    assert.ok(order.lastIndexOf(CASFunctionCode.FETCH) < order.indexOf(CASFunctionCode.END_TRAN));
    assert.equal(cas.of(CASFunctionCode.END_TRAN)[0]?.tranType, EndTranType.ROLLBACK);
    assert.equal(cas.refusedFetches, 0);
  });
});

test("close waits for a running query instead of cutting off its FETCHes", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const running = client.query(selectFor("a"));
    const closing = client.close();

    assert.deepEqual(await running, rowsOf("a"));
    await closing;
    assert.ok(cas.of(CASFunctionCode.FETCH).length > 0);
  });
});
