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
 * - CAS_INFO[0] is 1 inside a transaction and 0 after it ends. CHECK_CAS always
 *   replies 1, even on an idle session.
 */

import assert from "node:assert/strict";
import { createServer, type Socket as NetSocket, type Server } from "node:net";
import test from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { createClient } from "../src/client/create-client.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { QueryError } from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
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
  rows: Pick<Row[], "length" | "slice">;
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

/** The same rows made on demand, so the fake's own memory does not grow with a result. */
function lazyRows(owner: string, count: number, padding: string): Cursor["rows"] {
  return {
    length: count,
    slice: (start = 0, end = count) =>
      Array.from({ length: Math.max(0, Math.min(end, count) - start) }, (_unused, index) => ({
        id: `${owner}-${start + index}`,
        owner: `${owner}${padding}`,
      })),
  };
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

function executeReply(
  handle: number,
  statementType: number,
  columns: string[],
  total: number,
  inline: Buffer | null,
): Buffer {
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
  /** The error reply `failFetchOf` sends. */
  fetchError = errorReply(-1000, "fetch rejected for this test");
  /** Answer this owner's next FETCH with a reply that stops mid-row. */
  malformFetchOf: string | null = null;
  /** Leave this owner's next FETCH unanswered. */
  stallAtFetchOf: string | null = null;
  /** Answer this owner's next FETCH only when `releaseFetch()` is called. */
  pauseFetchOf: string | null = null;
  /** Sends the reply of the paused FETCH. */
  releaseFetch: () => void = () => {};
  /** Rows of a SELECT by owner, instead of ROW_COUNT, made on demand. */
  readonly rowCounts = new Map<string, number>();
  /** Added to the `owner` value of those rows, to make them wide. */
  rowPadding = "";
  /** Drop the socket at the first FETCH of this owner. */
  dropAtFetchOf: string | null = null;
  /** Leave the execute of this owner unanswered. */
  stallAtExecuteOf: string | null = null;
  /** Answer CHECK_CAS as a CAS does once its database server is gone. */
  failCheckCas = false;
  /** Close the socket instead of answering the next CHECK_CAS. */
  dropAtCheckCas = false;
  /** Close the socket instead of answering the next CLOSE_REQ_HANDLE. */
  dropAtClose = false;
  /** Report no open transaction in the next reply to this function code. */
  reportOutOfTransactionTo: number | null = null;
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
    const reported = this.reportOutOfTransactionTo === this.requests.at(-1)?.code;
    if (reported) {
      this.reportOutOfTransactionTo = null;
    }
    this.reply(session, payload, session.inTransaction && !reported ? 1 : 0);
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
        if (this.dropAtClose) {
          this.dropAtClose = false;
          session.socket.destroy();
          break;
        }
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
        if (this.dropAtCheckCas) {
          this.dropAtCheckCas = false;
          session.socket.destroy();
          break;
        }
        this.reply(
          session,
          this.failCheckCas ? Buffer.from("ffffffff0000232700", "hex") : Buffer.alloc(0),
          1,
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
      : this.rowCounts.has(owner ?? "")
        ? lazyRows(owner ?? "", this.rowCounts.get(owner ?? "") ?? 0, this.rowPadding)
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
      this.replyWithStatus(session, this.fetchError);
      return;
    }

    if (cursor.owner === this.malformFetchOf) {
      this.malformFetchOf = null;
      this.replyWithStatus(session, Buffer.concat([int32(0), int32(1), Buffer.alloc(2)]));
      return;
    }

    if (cursor.owner === this.stallAtFetchOf) {
      this.stallAtFetchOf = null;
      return;
    }

    const page = cursor.rows.slice(start, start + size);
    if (
      start + size >= cursor.rows.length &&
      session.inTransaction &&
      this.isAutocommitCursor(session)
    ) {
      this.endTransaction(session);
    }

    const reply = Buffer.concat([int32(0), encodeRows(page, start + 1)]);
    if (cursor.owner === this.pauseFetchOf) {
      this.pauseFetchOf = null;
      this.releaseFetch = () => this.replyWithStatus(session, reply);
      return;
    }

    this.replyWithStatus(session, reply);
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

test("concurrent SELECTs that need FETCH each return exactly their own rows", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const owners = ["a", "b", "c", "d", "e", "f"];

    const results = await Promise.all(owners.map((owner) => client.query(selectFor(owner))));

    owners.forEach((owner, index) => {
      assert.deepEqual(results[index], rowsOf(owner));
    });
    assert.ok(cas.of(CASFunctionCode.FETCH).length >= owners.length, "the rows must need FETCH");
    assert.equal(cas.refusedFetches, 0);
  });
});

test("repeated Promise.all rounds on one client keep returning exact rows", {
  timeout: 10000,
}, async () => {
  await withClient(async (client) => {
    for (let round = 0; round < 10; round += 1) {
      const owners = [`a${round}`, `b${round}`, `c${round}`];
      const results = await Promise.all(owners.map((owner) => client.query(selectFor(owner))));
      owners.forEach((owner, index) => {
        assert.deepEqual(results[index], rowsOf(owner));
      });
    }
  });
});

test("one query finishes its requests before the next query starts", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await Promise.all(["a", "b", "c"].map((owner) => client.query(selectFor(owner))));

    assert.deepEqual(ownerRuns(cas.requests), ["a", "b", "c"]);
    assert.equal(cas.peakOpenCursors, 1);
  });
});

test("parameterized concurrent queries probe the backslash mode once per session and keep their rows", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const owners = ["a", "b", "c"];

    const results = await Promise.all(
      owners.map((owner) =>
        client.query("SELECT id, owner FROM items WHERE owner = ? AND note = ?", [owner, "x\\y"]),
      ),
    );

    owners.forEach((owner, index) => {
      assert.deepEqual(results[index], rowsOf(owner));
    });
    const probes = cas.requests.filter((request) => request.sql?.includes("CHAR_LENGTH"));
    const statements = cas.requests.filter((request) => request.sql?.includes("note = "));
    assert.equal(statements.length, owners.length);
    for (const statement of statements) {
      const onSession = probes.filter((probe) => probe.session === statement.session);
      assert.equal(onSession.length, 1, "each statement's own session is probed before it");
    }
  });
});

test("parameters that both backslash modes render alike are sent without a probe", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.query("SELECT id, owner FROM items WHERE owner = ? AND n = ?", ["a", 7]);

    assert.equal(cas.requests.filter((request) => request.sql?.includes("CHAR_LENGTH")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Statements that end the server transaction
// ---------------------------------------------------------------------------

test("an autocommit INSERT issued mid-SELECT does not close that SELECT's cursor", {
  timeout: 10000,
}, async () => {
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

test("a ping issued mid-SELECT does not close that SELECT's cursor", {
  timeout: 10000,
}, async () => {
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

test("a ping commits only outside a transaction, by its exact bytes", {
  timeout: 10000,
}, async () => {
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
      ["00000001" + "01000000" + "20", "00000006" + "01000000" + "0f" + "00000001" + "00"],
    );

    await client.query("INSERT INTO t VALUES (2)");
    const inserts = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.equal(inserts.at(-1)?.session, inserts.at(-2)?.session);
    assert.equal(cas.of(CASFunctionCode.END_TRAN).length, 0);
  });
});

test("getServerVersion keeps a transaction open, by its exact bytes", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.beginTransaction();
    await client.query("INSERT INTO t VALUES (1)");
    cas.frames.length = 0;

    assert.equal(await client.getServerVersion(), "11.4.0.0000");
    assert.deepEqual(
      cas.frames.map((frame) => frame.toString("hex")),
      ["00000001" + "01000000" + "20", "00000006" + "01000000" + "0f" + "00000001" + "00"],
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

test("a failing statement rejects alone and the queries around it keep their rows", {
  timeout: 10000,
}, async () => {
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

test("a FETCH error closes the failing query's handle and no other", {
  timeout: 10000,
}, async () => {
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
    assert.equal(
      closes.some((request) => request.handle === fetchOfA?.handle),
      true,
    );
    assert.equal(cas.refusedFetches, 0);
  });
});

// ---------------------------------------------------------------------------
// Reconnects never carry a request onto another session, and nothing is retried
// ---------------------------------------------------------------------------

test("a lost socket rejects the queries waiting on it without sending them anywhere", {
  timeout: 10000,
}, async () => {
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
    assert.deepEqual(
      executions.map((request) => request.owner),
      ["a"],
    );
    assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).length, 0);
  });
});

test("an INSERT queued on a new client is not sent after the first query loses its socket", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    cas.dropAtFetchOf = "a";

    const [lost, queued] = await Promise.allSettled([
      client.query(selectFor("a")),
      client.query("INSERT INTO items VALUES (1)"),
    ]);

    assert.equal(lost.status, "rejected");
    assert.equal(queued.status, "rejected");
    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(
      executions.map((request) => request.owner),
      ["a"],
    );
  });
});

test("an INSERT queued on a new client is not sent after the first query times out", {
  timeout: 10000,
}, async () => {
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
    assert.deepEqual(
      executions.map((request) => request.owner),
      ["a"],
    );
  }, 100);
});

test("a ping that reconnects does not release the INSERT queued behind a lost socket", {
  timeout: 10000,
}, async () => {
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
    assert.deepEqual(
      executions.map((request) => request.owner),
      ["a"],
    );
  });
});

test("an INSERT waiting behind a malformed reply is not sent, and the next query recovers", {
  timeout: 10000,
}, async () => {
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

test("db.query() exposes a malformed reply by its name further down the cause chain", {
  timeout: 10000,
}, async () => {
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

test("a ping that reconnects does not release the INSERT queued behind a malformed reply", {
  timeout: 10000,
}, async () => {
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
    assert.deepEqual(
      executions.map((request) => request.owner),
      ["a"],
    );
  });
});

test("a query queued behind a failed first connect still gets its own attempt", {
  timeout: 10000,
}, async () => {
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

test("the next query after a lost socket runs once on a new session, with nothing replayed", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    cas.dropAtFetchOf = "a";
    await assert.rejects(client.query(selectFor("a")));

    assert.deepEqual(await client.query(selectFor("b")), rowsOf("b"));

    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(
      executions.map((request) => [request.owner, request.session]),
      [
        ["a", 1],
        ["b", 2],
      ],
    );
    assert.deepEqual(
      cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).map((request) => request.session),
      [2],
    );
  });
});

test("a query issued right after close rejects and leaves no session open", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    assert.deepEqual(await client.query(selectFor("a")), rowsOf("a"));

    const [closed, late] = await Promise.allSettled([client.close(), client.query(selectFor("b"))]);

    assert.equal(closed.status, "fulfilled");
    assert.equal(late.status, "rejected");
    await assert.rejects(client.query(selectFor("c")));

    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(
      executions.map((request) => request.owner),
      ["a"],
    );
    for (let waited = 0; cas.sockets.size > 0 && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cas.sockets.size, 0);
  });
});

test("the session released by one query's commit never receives another query's FETCH", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await Promise.all(["a", "b"].map((owner) => client.query(selectFor(owner))));

    const executedOn = new Map(
      cas
        .of(CASFunctionCode.PREPARE_AND_EXECUTE)
        .map((request) => [request.owner, request.session]),
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
    assert.deepEqual(
      executions.map((request) => [request.owner, request.autocommit]),
      [
        ["a", false],
        ["b", true],
      ],
    );
    assert.equal(cas.of(CASFunctionCode.END_TRAN)[0]?.tranType, EndTranType.ROLLBACK);
  });
});

test("beginTransaction applies only to statements issued after it", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await Promise.all([
      client.query(selectFor("a")),
      client.beginTransaction(),
      client.query(selectFor("b")),
      client.rollback(),
    ]);

    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.deepEqual(
      executions.map((request) => [request.owner, request.autocommit]),
      [
        ["a", true],
        ["b", false],
      ],
    );
  });
});

test("a failed statement inside transaction() rolls back after its siblings finish", {
  timeout: 10000,
}, async () => {
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

    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected", "fulfilled"],
    );
    const order = cas.requests.map((request) => request.code);
    assert.ok(order.lastIndexOf(CASFunctionCode.FETCH) < order.indexOf(CASFunctionCode.END_TRAN));
    assert.equal(cas.of(CASFunctionCode.END_TRAN)[0]?.tranType, EndTranType.ROLLBACK);
    assert.equal(cas.refusedFetches, 0);
  });
});

test("close waits for a running query instead of cutting off its FETCHes", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const running = client.query(selectFor("a"));
    const closing = client.close();

    assert.deepEqual(await running, rowsOf("a"));
    await closing;
    assert.ok(cas.of(CASFunctionCode.FETCH).length > 0);
  });
});

// ---------------------------------------------------------------------------
// One session across autocommit statements, verified with CHECK_CAS
// ---------------------------------------------------------------------------

test("consecutive autocommit statements stay on one session, with one CHECK_CAS between them", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.query("INSERT INTO items VALUES (1)");
    await client.query(selectFor("a"));
    await client.query("INSERT INTO items VALUES (2)");

    assert.deepEqual([...new Set(cas.requests.map((request) => request.session))], [1]);
    const statements = cas.requests.filter(
      ({ code }) =>
        code === CASFunctionCode.PREPARE_AND_EXECUTE || code === CASFunctionCode.CHECK_CAS,
    );
    assert.deepEqual(
      statements.map(({ code }) => code),
      [
        CASFunctionCode.PREPARE_AND_EXECUTE,
        CASFunctionCode.CHECK_CAS,
        CASFunctionCode.PREPARE_AND_EXECUTE,
        CASFunctionCode.CHECK_CAS,
        CASFunctionCode.PREPARE_AND_EXECUTE,
      ],
    );
  });
});

test("the backslash mode is measured once across autocommit statements", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.query("INSERT INTO items VALUES (?)", ["a\\b"]);
    await client.query("INSERT INTO items VALUES (?)", ["c\\d"]);

    const executions = cas.of(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.equal(executions.filter(({ sql }) => sql?.includes("CHAR_LENGTH")).length, 1);
    assert.equal(executions.length, 3);
  });
});

test("statements queued behind a probe that finds the CAS gone run once on the new session", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.query("INSERT INTO items VALUES (0)");
    cas.dropAtCheckCas = true;

    const results = await Promise.allSettled([
      client.query("INSERT INTO items VALUES (1)"),
      client.query("INSERT INTO items VALUES (2)"),
      client.query("INSERT INTO items VALUES (3)"),
    ]);

    assert.deepEqual(
      results.map(({ status }) => status),
      ["fulfilled", "fulfilled", "fulfilled"],
    );
    assert.deepEqual(cas.of(CASFunctionCode.CHECK_CAS)[0]?.session, 1);
    assert.deepEqual(
      cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).map(({ session, sql }) => [session, sql]),
      [
        [1, "INSERT INTO items VALUES (0)"],
        [2, "INSERT INTO items VALUES (1)"],
        [2, "INSERT INTO items VALUES (2)"],
        [2, "INSERT INTO items VALUES (3)"],
      ],
    );
  });
});

test("a CAS that goes to another client after its reply does not fail the statements behind it", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.query("INSERT INTO items VALUES (0)");
    cas.dropAtClose = true;

    const results = await Promise.allSettled([
      client.query("INSERT INTO items VALUES (1)"),
      client.query("INSERT INTO items VALUES (2)"),
    ]);

    assert.deepEqual(
      results.map(({ status }) => status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).length, 3);
    assert.equal(cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).at(-1)?.session, 2);
  });
});

async function openTransactionWithWork(client: ReturnType<typeof createClient>): Promise<void> {
  await client.beginTransaction();
  await client.query("INSERT INTO items VALUES (1)");
}

async function assertNothingCommits(
  client: ReturnType<typeof createClient>,
  cas: FakeCas,
): Promise<void> {
  await assert.rejects(client.query("INSERT INTO items VALUES (3)"), QueryError);
  await assert.rejects(client.commit(), TransactionError);
  assert.deepEqual(cas.of(CASFunctionCode.END_TRAN), []);
}

for (const [name, code, statement] of [
  ["execute", CASFunctionCode.PREPARE_AND_EXECUTE, "INSERT INTO items VALUES (2)"],
  ["FETCH", CASFunctionCode.FETCH, selectFor("a")],
  ["handle release", CASFunctionCode.CLOSE_REQ_HANDLE, selectFor("a")],
] as const) {
  test(`a ${name} reply that reports no open transaction fails the transaction`, {
    timeout: 10000,
  }, async () => {
    await withClient(async (client, cas) => {
      await openTransactionWithWork(client);
      cas.reportOutOfTransactionTo = code;

      await assert.rejects(client.query(statement), QueryError);

      await assertNothingCommits(client, cas);
    });
  });
}

test("a ping reply that reports no open transaction is not hidden by the replies after it", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await openTransactionWithWork(client);
    cas.reportOutOfTransactionTo = CASFunctionCode.GET_DB_VERSION;

    await client.ping();

    await assertNothingCommits(client, cas);
    // The next statement was refused before it was sent, not undone afterwards.
    assert.equal(cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).length, 1);
  });
});

test("commit refuses a transaction that a ping reply reported as over", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await openTransactionWithWork(client);
    cas.reportOutOfTransactionTo = CASFunctionCode.GET_DB_VERSION;
    await client.ping();

    await assert.rejects(client.commit(), TransactionError);

    assert.deepEqual(cas.of(CASFunctionCode.END_TRAN), []);
  });
});

test("a ping before a transaction's first statement does not count against it", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.query("INSERT INTO items VALUES (0)");
    await client.beginTransaction();
    await client.ping();

    await client.query("INSERT INTO items VALUES (1)");
    await client.commit();

    assert.equal(cas.of(CASFunctionCode.END_TRAN).at(-1)?.tranType, EndTranType.COMMIT);
  });
});

test("FETCH stays on its session without a probe when the execute reply says OUT_TRAN", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.query("INSERT INTO items VALUES (1)");
    await client.ping();
    cas.requests.length = 0;
    cas.reportOutOfTransactionTo = CASFunctionCode.PREPARE_AND_EXECUTE;

    assert.deepEqual(await client.query(selectFor("a")), rowsOf("a"));

    const after = cas.requests.map(({ code }) => code);
    const execute = after.indexOf(CASFunctionCode.PREPARE_AND_EXECUTE);
    assert.ok(after.includes(CASFunctionCode.FETCH));
    assert.equal(after.slice(execute).includes(CASFunctionCode.CHECK_CAS), false);
    assert.equal(cas.refusedFetches, 0);
  });
});

// ---------------------------------------------------------------------------
// stream(): a cursor that stays open between the consumer's reads
// ---------------------------------------------------------------------------

const STREAM_SELECT = selectFor("s");
const STREAM_ROWS = rowsOf("s");

/** Reads `count` rows by hand, leaving the stream open. */
async function readRows(
  rows: AsyncGenerator<Record<string, unknown>, void, undefined>,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await rows.next();
  }
}

/** Resolves on a later event loop turn, by when anything that was going to happen has. */
function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertStreamReleased(cas: FakeCas, handles = 1): void {
  assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).length, handles);
  assert.equal(cas.refusedFetches, 0);
}

function isStreamBusy(error: { kind?: string; message: string }): boolean {
  assert.equal(error.kind, "stream-busy");
  assert.match(error.message, /can never run/);
  return true;
}

test("stream: yields every row in order across FETCHes and releases the handle", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const rows: unknown[] = [];

    for await (const row of client.stream(STREAM_SELECT)) {
      rows.push(row);
    }

    assert.deepEqual(rows, STREAM_ROWS);
    assert.equal(cas.of(CASFunctionCode.FETCH).length, 2);
    assertStreamReleased(cas);
    // The last FETCH ended the autocommit transaction, so nothing has to.
    assert.equal(cas.of(CASFunctionCode.END_TRAN).length, 0);
  });
});

test("stream: sends nothing before the first read, and a FETCH only when a window runs out", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const rows = client.stream(STREAM_SELECT);
    await settle();
    assert.equal(cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).length, 0);

    await readRows(rows, PAGE_SIZE);
    await settle();
    assert.equal(cas.of(CASFunctionCode.FETCH).length, 0);

    await readRows(rows, 1);
    await settle();
    assert.equal(cas.of(CASFunctionCode.FETCH).length, 1);

    await rows.return();
  });
});

test("stream: memory stays bounded by one reply over a result far larger than the heap limit asserted", {
  timeout: 60000,
}, async () => {
  setFlagsFromString("--expose-gc");
  const collectGarbage = runInNewContext("gc") as () => void;
  const ROW_TOTAL = 300_000;
  const WIDTH = 1024;
  const HEAP_GROWTH_LIMIT = 16 * 1024 * 1024;

  await withClient(async (client, cas) => {
    cas.rowCounts.set("big", ROW_TOTAL);
    cas.rowPadding = "x".repeat(WIDTH);

    collectGarbage();
    const baseline = process.memoryUsage().heapUsed;
    let peak = 0;
    let read = 0;

    for await (const row of client.stream(selectFor("big"))) {
      read += 1;
      assert.equal((row as unknown as Row).owner.length, WIDTH + 3);

      if (read % 20_000 === 0) {
        // The fake keeps every request it saw, which is not the client's memory.
        cas.requests.length = 0;
        cas.frames.length = 0;
        collectGarbage();
        peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
      }
    }

    assert.equal(read, ROW_TOTAL);
    assert.ok(ROW_TOTAL * WIDTH > 16 * HEAP_GROWTH_LIMIT);
    assert.ok(peak < HEAP_GROWTH_LIMIT, `heap grew by ${peak} bytes`);
  });
});

test("stream: break closes the handle and ends the autocommit transaction that held its lock", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    for await (const row of client.stream(STREAM_SELECT)) {
      assert.ok(row);
      break;
    }

    assertStreamReleased(cas);
    assert.deepEqual(
      cas.of(CASFunctionCode.END_TRAN).map(({ tranType }) => tranType),
      [EndTranType.COMMIT],
    );

    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
    assert.equal(cas.sockets.size, 1);
  });
});

test("stream: a throw from the loop body keeps its error and releases the handle", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const failure = new Error("the consumer failed");

    await assert.rejects(
      async () => {
        for await (const row of client.stream(STREAM_SELECT)) {
          assert.ok(row);
          throw failure;
        }
      },
      (error) => error === failure,
    );

    assertStreamReleased(cas);
    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
  });
});

test("stream: return() and throw() on the iterator release the handle", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const returned = client.stream(STREAM_SELECT);
    await readRows(returned, 1);
    assert.deepEqual(await returned.return(), { done: true, value: undefined });
    assertStreamReleased(cas, 1);

    const thrown = client.stream(STREAM_SELECT);
    await readRows(thrown, 1);
    const failure = new Error("stop reading");
    await assert.rejects(
      () => thrown.throw(failure),
      (error) => error === failure,
    );
    assertStreamReleased(cas, 2);

    assert.deepEqual(await thrown.next(), { done: true, value: undefined });
  });
});

test("stream: return() before the first read never sends the statement", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const rows = client.stream(STREAM_SELECT);
    await rows.return();
    await client.query(selectFor("next"));

    assert.equal(cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).length, 1);
  });
});

test("stream: a break inside a transaction leaves the transaction to its owner", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.beginTransaction();
    await client.query("INSERT INTO items VALUES (1)");

    for await (const row of client.stream(STREAM_SELECT)) {
      assert.ok(row);
      break;
    }

    assert.equal(cas.of(CASFunctionCode.END_TRAN).length, 0);
    await client.commit();
    assert.deepEqual(
      cas.of(CASFunctionCode.END_TRAN).map(({ tranType }) => tranType),
      [EndTranType.COMMIT],
    );
  });
});

test("stream: a statement issued meanwhile waits until the stream is drained", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const rows = client.stream(STREAM_SELECT);
    await readRows(rows, 1);

    const other = client.query(selectFor("other"));
    await settle();
    assert.equal(cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).length, 1);

    await readRows(rows, ROW_COUNT);
    assert.deepEqual(await rows.next(), { done: true, value: undefined });
    assert.deepEqual(await other, rowsOf("other"));

    assert.deepEqual(ownerRuns(cas.requests), ["s", "other"]);
    assert.equal(cas.peakOpenCursors, 1);
    assert.equal(cas.refusedFetches, 0);
  });
});

test("stream: a statement issued meanwhile runs as soon as the stream closes early", {
  timeout: 10000,
}, async () => {
  await withClient(async (client) => {
    const rows = client.stream(STREAM_SELECT);
    await readRows(rows, 1);

    const other = client.query(selectFor("other"));
    await rows.return();

    assert.deepEqual(await other, rowsOf("other"));
  });
});

test("stream: a query awaited inside the loop rejects instead of hanging, and sends nothing", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await assert.rejects(
      async () => {
        for await (const row of client.stream(STREAM_SELECT, undefined, { consumerTimeout: 30 })) {
          await client.query(`SELECT ${String(row.id)} FROM items`);
        }
      },
      (error: QueryError) => error instanceof QueryError && isStreamBusy(error),
    );

    assert.equal(cas.of(CASFunctionCode.PREPARE_AND_EXECUTE).length, 1);
    assertStreamReleased(cas);
    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
  });
});

test("stream: each kind of statement is refused with its own error class and the stream survives", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const rows = client.stream(STREAM_SELECT, undefined, { consumerTimeout: 10 });
    await readRows(rows, 1);

    const refused = [
      await client.execute("INSERT INTO items VALUES (1)").catch((error: Error) => error),
      await client.beginTransaction().catch((error: Error) => error),
      await client.commit().catch((error: Error) => error),
      await client.rollback().catch((error: Error) => error),
      await client.ping().catch((error: Error) => error),
    ] as Array<QueryError & { kind?: string }>;

    assert.ok(refused[0] instanceof QueryError);
    assert.ok(refused[1] instanceof TransactionError);
    assert.ok(refused[2] instanceof TransactionError);
    assert.ok(refused[3] instanceof TransactionError);
    assert.ok(refused[4] instanceof ConnectionError);
    refused.forEach(isStreamBusy);

    assert.equal(cas.requests.length, 1);
    const left: unknown[] = [];
    for await (const row of rows) {
      left.push(row);
    }
    assert.equal(left.length, ROW_COUNT - 1);
  });
});

test("stream: a statement keeps waiting while the consumer keeps reading", {
  timeout: 10000,
}, async () => {
  await withClient(async (client) => {
    const CONSUMER_TIMEOUT = 150;
    const PAUSE = 30;
    const started = Date.now();
    const rows = client.stream(STREAM_SELECT, undefined, { consumerTimeout: CONSUMER_TIMEOUT });
    await readRows(rows, 1);
    const other = client.query(selectFor("other"));

    // Every pause is short, but together they outlast the limit several times.
    while (Date.now() - started < CONSUMER_TIMEOUT * 3) {
      await settle(PAUSE);
      await readRows(rows, 1);
    }
    await rows.return();

    assert.deepEqual(await other, rowsOf("other"));
  });
});

test("stream: consumerTimeout 0 refuses a statement at once", { timeout: 10000 }, async () => {
  await withClient(async (client) => {
    const rows = client.stream(STREAM_SELECT, undefined, { consumerTimeout: 0 });
    await readRows(rows, 1);
    const started = Date.now();

    await assert.rejects(() => client.query("SELECT 1 FROM items"), isStreamBusy);

    assert.ok(Date.now() - started < 1000);
    await rows.return();
  });
});

test("stream: a statement's limit runs from when it was issued, not from the consumer's last read", {
  timeout: 10000,
}, async () => {
  await withClient(async (client) => {
    const rows = client.stream(STREAM_SELECT, undefined, { consumerTimeout: 200 });
    await readRows(rows, 1);
    await settle(150);

    const other = client.query(selectFor("other"));
    await settle(100);
    await rows.return();

    assert.deepEqual(await other, rowsOf("other"));
  });
});

test("stream: an abandoned iterator cannot hang later statements or close()", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const rows = client.stream(STREAM_SELECT, undefined, { consumerTimeout: 10 });
    await readRows(rows, 1);

    await assert.rejects(() => client.query("SELECT 1 FROM items"), isStreamBusy);
    await client.close();

    assertStreamReleased(cas);
    await assert.rejects(
      () => rows.next(),
      (error: QueryError) => error instanceof QueryError && error.kind === "connection-lost",
    );
  });
});

test("stream: a result that fits its last window releases the turn before the consumer reads it", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    cas.rowCounts.set("small", 3);
    const seen: unknown[] = [];

    for await (const row of client.stream(selectFor("small"), undefined, { consumerTimeout: 0 })) {
      seen.push(row, await client.query(selectFor("next")));
    }

    assert.equal(seen.length, 6);
    assert.equal(cas.refusedFetches, 0);
  });
});

test("stream: a second stream waits for the first and never overlaps it", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const collect = async (owner: string): Promise<unknown[]> => {
      const rows: unknown[] = [];
      for await (const row of client.stream(selectFor(owner))) {
        rows.push(row);
      }
      return rows;
    };

    const [first, second] = await Promise.all([collect("a"), collect("b")]);

    assert.deepEqual(first, rowsOf("a"));
    assert.deepEqual(second, rowsOf("b"));
    assert.deepEqual(ownerRuns(cas.requests), ["a", "b"]);
    assert.equal(cas.peakOpenCursors, 1);
  });
});

test("stream: a query issued first runs first", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const earlier = client.query(selectFor("earlier"));
    const rows = client.stream(STREAM_SELECT);
    await rows.next();

    assert.deepEqual(await earlier, rowsOf("earlier"));
    await rows.return();
    assert.deepEqual(ownerRuns(cas.requests), ["earlier", "s"]);
  });
});

test("stream: abort releases the handle and the turn while the consumer is away", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const controller = new AbortController();
    const reason = new Error("no longer wanted");
    const rows = client.stream(STREAM_SELECT, undefined, { signal: controller.signal });
    await readRows(rows, 1);

    const other = client.query(selectFor("other"));
    controller.abort(reason);

    assert.deepEqual(await other, rowsOf("other"));
    assertStreamReleased(cas, 2);
    assert.deepEqual(ownerRuns(cas.requests), ["s", "other"]);
    assert.deepEqual(
      cas.of(CASFunctionCode.END_TRAN).map(({ tranType }) => tranType),
      [EndTranType.COMMIT],
    );

    await assert.rejects(
      () => rows.next(),
      (error) => error === reason,
    );
    assert.deepEqual(await rows.next(), { done: true, value: undefined });
  });
});

test("stream: abort during a FETCH waits for its reply and then releases the handle on the same session", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const controller = new AbortController();
    const rows = client.stream(STREAM_SELECT, undefined, { signal: controller.signal });
    await readRows(rows, PAGE_SIZE);

    cas.pauseFetchOf = "s";
    let settled = false;
    const next = rows.next().finally(() => {
      settled = true;
    });
    await settle();
    controller.abort();
    await settle();
    assert.equal(settled, false);

    cas.releaseFetch();
    await assert.rejects(() => next, { name: "AbortError" });

    assertStreamReleased(cas);
    assert.equal(cas.sockets.size, 1);
    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
  });
});

test("stream: an aborted signal sends nothing", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    const rows = client.stream(STREAM_SELECT, undefined, { signal: AbortSignal.abort() });

    await assert.rejects(() => rows.next(), { name: "AbortError" });
    assert.equal(cas.requests.length, 0);
  });
});

test("stream: aborting a stream that waits for its turn rejects at once and sends nothing", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const first = client.stream(selectFor("a"));
    await readRows(first, 1);

    const controller = new AbortController();
    const queued = client.stream(selectFor("b"), undefined, { signal: controller.signal });
    const next = queued.next();
    // Long enough for the statement to reach the queue behind the open stream.
    await settle();
    controller.abort();

    await assert.rejects(() => next, { name: "AbortError" });
    await first.return();
    await client.query(selectFor("c"));
    assert.deepEqual(ownerRuns(cas.requests), ["a", "c"]);
  });
});

test("stream: a finished stream stops listening to its signal", { timeout: 10000 }, async () => {
  await withClient(async (client) => {
    const controller = new AbortController();
    let listeners = 0;
    const { addEventListener, removeEventListener } = controller.signal;
    controller.signal.addEventListener = function (this: AbortSignal, ...args: unknown[]) {
      listeners += 1;
      return Reflect.apply(addEventListener, this, args);
    } as typeof addEventListener;
    controller.signal.removeEventListener = function (this: AbortSignal, ...args: unknown[]) {
      listeners -= 1;
      return Reflect.apply(removeEventListener, this, args);
    } as typeof removeEventListener;

    for await (const row of client.stream(STREAM_SELECT, undefined, {
      signal: controller.signal,
    })) {
      assert.equal(listeners, 1);
      assert.ok(row);
      break;
    }

    assert.equal(listeners, 0);
  });
});

test("stream: rows before a failed FETCH are delivered, then the error, with the handle released", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    cas.failFetchOf = "s";
    const rows: unknown[] = [];

    await assert.rejects(
      async () => {
        for await (const row of client.stream(STREAM_SELECT)) {
          rows.push(row);
        }
      },
      (error: QueryError) => error instanceof QueryError && error.code === -1000,
    );

    assert.equal(rows.length, PAGE_SIZE);
    assertStreamReleased(cas, 1);
    assert.equal(cas.of(CASFunctionCode.END_TRAN).length, 1);
    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
  });
});

test("stream: a read timeout on a FETCH rejects with ReadTimeoutError and drops the session", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    cas.stallAtFetchOf = "s";

    await assert.rejects(async () => {
      for await (const row of client.stream(STREAM_SELECT)) {
        assert.ok(row);
      }
    }, ReadTimeoutError);

    assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).length, 0);
    await settle();
    assert.equal(cas.sockets.size, 0);

    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
  }, 100);
});

test("stream: waiting for the consumer does not count towards readTimeout", {
  timeout: 10000,
}, async () => {
  await withClient(async (client) => {
    const rows = client.stream(STREAM_SELECT);
    await readRows(rows, 1);
    await settle(150);

    await readRows(rows, ROW_COUNT - 1);
    assert.deepEqual(await rows.next(), { done: true, value: undefined });
  }, 50);
});

test("stream: a lost socket during a FETCH fails the stream as connection-lost and the next query reconnects", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    cas.dropAtFetchOf = "s";

    await assert.rejects(
      async () => {
        for await (const row of client.stream(STREAM_SELECT)) {
          assert.ok(row);
        }
      },
      (error: QueryError) => error instanceof QueryError && error.kind === "connection-lost",
    );

    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
    assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).at(-1)?.session, 2);
  });
});

test("stream: a malformed FETCH reply retires the session without another request on it", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    cas.malformFetchOf = "s";

    await assert.rejects(
      async () => {
        for await (const row of client.stream(STREAM_SELECT)) {
          assert.ok(row);
        }
      },
      (error: QueryError) =>
        (error.cause as Error).cause instanceof Error &&
        ((error.cause as Error).cause as Error).name === "MalformedReplyError",
    );

    assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).length, 0);
    assert.equal(cas.of(CASFunctionCode.END_TRAN).length, 0);
    await settle();
    assert.equal(cas.sockets.size, 0);
    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
  });
});

test("stream: a malformed execute reply retires the session too", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.malformExecuteOf = "s";

    await assert.rejects(() => client.stream(STREAM_SELECT).next(), QueryError);

    await settle();
    assert.equal(cas.sockets.size, 0);
  });
});

test("stream: -72 on a FETCH marks the transaction as rolled back until it is acknowledged", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const deadlock = errorReply(-72, "deadlock victim");
    deadlock.writeInt32BE(-2, 0);
    cas.fetchError = deadlock;
    cas.failFetchOf = "s";

    await client.beginTransaction();
    await assert.rejects(
      async () => {
        for await (const row of client.stream(STREAM_SELECT)) {
          assert.ok(row);
        }
      },
      (error: QueryError) => error.code === -72 && error.kind === "deadlock",
    );

    const sent = cas.requests.length;
    await assert.rejects(() => client.query(selectFor("next")), { code: -72 });
    await assert.rejects(() => client.stream(selectFor("next")).next(), { code: -72 });
    await assert.rejects(() => client.commit(), { code: -72 });
    assert.equal(cas.requests.length, sent);

    assert.deepEqual(await client.query(selectFor("next")), rowsOf("next"));
  });
});

test("stream: a transaction the server ended during the stream is reported, not reused", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    await client.beginTransaction();
    await client.query("INSERT INTO items VALUES (1)");
    cas.reportOutOfTransactionTo = CASFunctionCode.FETCH;

    await assert.rejects(
      async () => {
        for await (const row of client.stream(STREAM_SELECT)) {
          assert.ok(row);
        }
      },
      (error: QueryError) => error.kind === "connection-lost",
    );

    await assert.rejects(() => client.commit(), TransactionError);
  });
});

test("stream: close() ends an open stream and releases its handle first", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    const rows = client.stream(STREAM_SELECT);
    await readRows(rows, 1);

    await client.close();

    assertStreamReleased(cas);
    await assert.rejects(() => rows.next(), QueryError);
    await assert.rejects(() => client.stream(STREAM_SELECT).next(), QueryError);
  });
});

test("stream: a statement that is not a SELECT yields no rows and releases its handle", {
  timeout: 10000,
}, async () => {
  await withClient(async (client, cas) => {
    assert.deepEqual(await client.stream("INSERT INTO items VALUES (1)").next(), {
      done: true,
      value: undefined,
    });

    assertStreamReleased(cas);
  });
});

test("stream: a failing statement rejects the first read", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    await assert.rejects(() => client.stream("FAIL now").next(), { code: -493 });
    assert.equal(cas.of(CASFunctionCode.CLOSE_REQ_HANDLE).length, 0);
  });
});

test("stream: an empty result ends at once", { timeout: 10000 }, async () => {
  await withClient(async (client, cas) => {
    cas.rowCounts.set("none", 0);

    assert.deepEqual(await client.stream(selectFor("none")).next(), {
      done: true,
      value: undefined,
    });
    assertStreamReleased(cas);
  });
});

/** The size of every FETCH on the wire, after DATA_LENGTH, CAS_INFO and the first arguments. */
function fetchSizes(cas: FakeCas): number[] {
  const FETCH_SIZE_OFFSET = 8 + 21;
  return cas.frames
    .filter((frame) => frame[8] === CASFunctionCode.FETCH)
    .map((frame) => frame.readInt32BE(FETCH_SIZE_OFFSET));
}

test("fetchSize: a stream sends its option, and otherwise the client's, and otherwise 100, as query() does", {
  timeout: 10000,
}, async () => {
  const drain = async (rows: AsyncIterable<unknown>): Promise<void> => {
    for await (const row of rows) {
      assert.ok(row);
    }
  };

  await withClient(async (client, cas) => {
    await drain(client.stream(STREAM_SELECT));
    assert.deepEqual(fetchSizes(cas), [100, 100]);

    cas.frames.length = 0;
    await client.query(STREAM_SELECT);
    assert.deepEqual(fetchSizes(cas), [100, 100]);

    cas.frames.length = 0;
    await drain(client.stream(STREAM_SELECT, undefined, { fetchSize: 75 }));
    assert.deepEqual(fetchSizes(cas), [75, 75]);
  });

  const cas = new FakeCas();
  const port = await cas.start();
  const client = createClient({
    host: "127.0.0.1",
    port,
    database: "testdb",
    user: "dba",
    fetchSize: 60,
  });

  try {
    await drain(client.stream(STREAM_SELECT));
    assert.deepEqual(new Set(fetchSizes(cas)), new Set([60]));

    cas.frames.length = 0;
    assert.deepEqual(await client.query(STREAM_SELECT), STREAM_ROWS);
    assert.deepEqual(new Set(fetchSizes(cas)), new Set([60]));
  } finally {
    await client.close();
    await cas.stop();
  }
});
