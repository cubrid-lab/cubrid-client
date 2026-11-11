import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type Socket as NetSocket, type Server } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import { inspect } from "node:util";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { CubridClient } from "../src/client/client.js";
import { createClient } from "../src/client/create-client.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { ConstraintError, DeadlockError, QueryError } from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import { CASFunctionCode, EndTranType } from "../src/protocol/constants.js";
import { writePrepareAndExecute } from "../src/protocol/protocol.js";
import type {
  ClientConfig,
  ExecutableTransactionClient,
  ResultTransactionClient,
} from "../src/types/client.js";
import { blob, clob } from "../src/types/lob.js";
import type { QueryParam } from "../src/types/query.js";
import { CAPTURED_FRAMES } from "./fixtures/collection-frames.js";
import {
  DML_FRAMES,
  EXECUTE_ARRAY_FRAMES,
  LAST_INSERT_ID_FRAMES,
  PREPARED_FRAMES,
} from "./fixtures/dml-frames.js";
import { LOB_FRAMES, LOB_READ_REPLY_LIMIT, LOB_WRITE_FRAMES } from "./fixtures/lob-frames.js";
import { ZONED_FRAMES } from "./fixtures/zoned-frames.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A port nothing listens on: bind an ephemeral port, then release it. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const DEFAULT_CONFIG: ClientConfig = {
  host: "127.0.0.1",
  port: 33000,
  database: "testdb",
  user: "dba",
  password: "",
};

/**
 * Creates a NativeCubridAdapter and injects a fake CAS connection via
 * private field override.  This lets us test adapter logic without TCP.
 */
function createAdapterWithFakeCAS(
  config: ClientConfig = DEFAULT_CONFIG,
  overrides: Partial<FakeCASConnection> = {},
): { adapter: NativeCubridAdapter; fakeCAS: FakeCASConnection } {
  const adapter = new NativeCubridAdapter(config);
  const fakeCAS = new FakeCASConnection(overrides);

  // Inject fake CAS into the private field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).cas = fakeCAS;
  // Pre-set the negotiated backslash mode so param tests skip the probe query.
  // Dedicated tests below exercise negotiation explicitly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).noBackslashEscapes = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).backslashModeGeneration = fakeCAS.connectionGeneration;

  return { adapter, fakeCAS };
}

// ---------------------------------------------------------------------------
// Fake CAS Connection
// ---------------------------------------------------------------------------

class FakeCASConnection {
  connectCalls = 0;
  sendAndRecvCalls = 0;
  sendCalls = 0;
  closeCalls = 0;
  discardCalls = 0;
  destroyed = false;
  _isConnected = true;
  _casInfo = Buffer.alloc(4);
  _protoVersion = 1;
  _sessionId = 42;
  connectionGeneration = 1;

  connectError?: Error;
  sendAndRecvError?: Error;
  sendError?: Error;
  /** Runs once a request has been recorded, with its index, before it is answered. */
  onSendAndRecv?: (index: number) => void;

  /** Every payload passed to sendAndRecv, in order */
  sentPayloads: Buffer[] = [];

  /** Outcomes of sendAndRecv, consumed in FIFO order */
  private responses: Array<Buffer | Error> = [];

  constructor(overrides: Partial<FakeCASConnection> = {}) {
    Object.assign(this, overrides);
  }

  /** Queue a sendAndRecv response */
  queueResponse(buf: Buffer): void {
    this.responses.push(buf);
  }

  /** Queue a failed exchange, which retires the socket like CASConnection. */
  queueExchangeFailure(error: Error): void {
    this.responses.push(error);
  }

  /** Handles released by CLOSE_REQ_HANDLE requests, in order */
  get closedHandles(): number[] {
    return this.sentPayloads
      .filter((payload) => payload[0] === CASFunctionCode.CLOSE_REQ_HANDLE)
      .map((payload) => payload.readInt32BE(5));
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) {
      throw this.connectError;
    }
    this._isConnected = true;
    this.connectionGeneration += 1;
  }

  /** The broker released the CAS: the next request opens a new session. */
  released = false;

  async ensureSession(): Promise<void> {
    if (!this._isConnected || this.released) {
      this.released = false;
      await this.connect();
    }
  }

  async discardSession(): Promise<void> {
    this.discardCalls += 1;
    this._isConnected = false;
  }

  async send(_header: Buffer, _payload: Buffer): Promise<void> {
    this.sendCalls += 1;
    if (this.sendError) {
      throw this.sendError;
    }
  }

  async sendAndRecv(_header: Buffer, payload: Buffer): Promise<Buffer> {
    this.sendAndRecvCalls += 1;
    this.sentPayloads.push(payload);
    this.onSendAndRecv?.(this.sentPayloads.length - 1);
    if (this.sendAndRecvError) {
      throw this.sendAndRecvError;
    }
    const next = this.responses.shift();
    if (next instanceof Error) {
      this._isConnected = false;
      throw next;
    }
    if (next) {
      return next;
    }
    // Default: return a "success" response (response_code = 0)
    return buildSimpleResponse(0);
  }

  async sendAndRecvOnSession(
    generation: number,
    header: Buffer,
    payload: Buffer,
  ): Promise<Buffer | null> {
    if (!this._isConnected || this.connectionGeneration !== generation) {
      return null;
    }
    return this.sendAndRecv(header, payload);
  }

  async releaseOnSession(
    generation: number,
    header: Buffer,
    payload: Buffer,
  ): Promise<Buffer | null> {
    return this.sendAndRecvOnSession(generation, header, payload);
  }

  /** The real connection limits the requests `run` makes; this one only runs it. */
  async runScoped<T>(_scope: unknown, run: () => Promise<T>): Promise<T> {
    return run();
  }

  /** The real connection lets the scope's signal stop this wait; this one only waits. */
  async awaitScoped<T>(pending: Promise<T>): Promise<T> {
    return pending;
  }

  async close(beforeClose?: () => Promise<void>): Promise<void> {
    this.closeCalls += 1;
    // Mirror CASConnection.close(): run the pre-close hook (e.g. CON_CLOSE)
    // only while still connected, swallowing hook errors (best-effort).
    if (this._isConnected && beforeClose) {
      try {
        await beforeClose();
      } catch {
        // Best-effort — ignore close-frame failures.
      }
    }
    this._isConnected = false;
  }

  get casInfo(): Buffer {
    return this._casInfo;
  }
  get protoVersion(): number {
    return this._protoVersion;
  }
  get sessionId(): number {
    return this._sessionId;
  }
  get isConnected(): boolean {
    return this._isConnected;
  }
}

// ---------------------------------------------------------------------------
// Response builders for fake CAS
// ---------------------------------------------------------------------------

/** Build a simple response buffer: [response_code:int32BE] */
function buildSimpleResponse(code: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(code, 0);
  return buf;
}

/**
 * Build a PrepareAndExecute response for a non-SELECT statement.
 *
 * Wire format (after CAS_INFO, which is already stripped by sendAndRecv):
 *   [queryHandle:int32BE]       — responseCode >= 0 = success (IS the queryHandle)
 *   [result_cache_lifetime:int32BE]
 *   [statementType:int8]
 *   [bindCount:int32BE]
 *   [is_updatable:int8]
 *   [columnCount:int32BE]
 *   ...column metadata (skipped for 0 columns)
 *   [totalTupleCount:int32BE]   — Execute portion
 *   [cache_reusable:int8]
 *   [resultCount:int32BE]
 *   ...resultInfos (per resultCount entries)
 */
function buildDMLResponse(statementType: number, totalTupleCount: number): Buffer {
  const parts: Buffer[] = [];

  // queryHandle (responseCode) = 1
  const qh = Buffer.alloc(4);
  qh.writeInt32BE(1, 0);
  parts.push(qh);

  // result_cache_lifetime = 0
  const rcl = Buffer.alloc(4);
  rcl.writeInt32BE(0, 0);
  parts.push(rcl);

  // statementType (1 byte)
  const st = Buffer.alloc(1);
  st.writeInt8(statementType, 0);
  parts.push(st);

  // bindCount = 0
  const bc = Buffer.alloc(4);
  bc.writeInt32BE(0, 0);
  parts.push(bc);

  // isUpdatable = 0
  const iu = Buffer.alloc(1);
  iu.writeInt8(0, 0);
  parts.push(iu);

  // columnCount = 0
  const nc = Buffer.alloc(4);
  nc.writeInt32BE(0, 0);
  parts.push(nc);

  // --- Execute portion ---
  // totalTupleCount
  const ttc = Buffer.alloc(4);
  ttc.writeInt32BE(totalTupleCount, 0);
  parts.push(ttc);

  // cache_reusable = 0
  const cr = Buffer.alloc(1);
  cr.writeInt8(0, 0);
  parts.push(cr);

  // resultCount = 1
  const rcc = Buffer.alloc(4);
  rcc.writeInt32BE(1, 0);
  parts.push(rcc);

  // resultInfo entry: [stmt_type:byte][result_count:int32][OID:8 bytes][cache_sec:int32][cache_usec:int32]
  const ri = Buffer.alloc(1 + 4 + 8 + 4 + 4);
  ri.writeInt8(statementType, 0);
  ri.writeInt32BE(totalTupleCount, 1);
  // OID (8 bytes) at offset 5 — already zeroed
  ri.writeInt32BE(0, 13); // cache time seconds
  ri.writeInt32BE(0, 17); // cache time microseconds
  parts.push(ri);

  // includes_column_info = 0 and shard_id = 0, which protocol 7 always sends
  parts.push(Buffer.alloc(1 + 4));

  return Buffer.concat(parts);
}

/**
 * Build a PrepareAndExecute response for a SELECT with inline rows.
 *
 * Column metadata per column:
 *   [type:uint8] [scale:int16BE] [precision:int32BE]
 *   [nameLen:int32BE][name bytes + \0]
 *   [realNameLen:int32BE][realName bytes + \0]
 *   [tableNameLen:int32BE][tableName bytes + \0]
 *   [isNullable:int8] [defaultValueLen:int32BE][defaultValue bytes + \0]
 *   [isAutoIncrement:int8] [isUniqueKey:int8] [isPrimaryKey:int8]
 *   [is_reverse_index:int8] [is_reverse_unique:int8] [isForeignKey:int8] [is_shared:int8]
 */
function buildSelectResponse(
  columns: Array<{
    name: string;
    type: number;
    precision?: number;
    scale?: number;
    /** Sent as the wire is_non_null byte; NOT NULL unless `false`. */
    notNull?: boolean;
  }>,
  rows: Array<Array<string | null>>,
): Buffer {
  const parts: Buffer[] = [];

  // queryHandle (responseCode) = 1
  const qh = Buffer.alloc(4);
  qh.writeInt32BE(1, 0);
  parts.push(qh);

  // result_cache_lifetime = 0
  const rcl = Buffer.alloc(4);
  rcl.writeInt32BE(0, 0);
  parts.push(rcl);

  // statementType = SELECT (21)
  const st = Buffer.alloc(1);
  st.writeInt8(21, 0);
  parts.push(st);

  // bindCount = 0
  const bc = Buffer.alloc(4);
  bc.writeInt32BE(0, 0);
  parts.push(bc);

  // isUpdatable = 0
  const iu = Buffer.alloc(1);
  iu.writeInt8(0, 0);
  parts.push(iu);

  // numColumns
  const nc = Buffer.alloc(4);
  nc.writeInt32BE(columns.length, 0);
  parts.push(nc);

  // Column metadata
  for (const col of columns) {
    // type (1 byte)
    const ct = Buffer.alloc(1);
    ct.writeUInt8(col.type, 0);
    parts.push(ct);

    // scale (2 bytes)
    const cs = Buffer.alloc(2);
    cs.writeInt16BE(col.scale ?? 0, 0);
    parts.push(cs);

    // precision (4 bytes)
    const cp = Buffer.alloc(4);
    cp.writeInt32BE(col.precision ?? 255, 0);
    parts.push(cp);

    // name (length-prefixed, null-terminated)
    const nameBytes = Buffer.from(col.name, "utf-8");
    const nl = Buffer.alloc(4);
    nl.writeInt32BE(nameBytes.length + 1, 0);
    parts.push(nl);
    parts.push(nameBytes);
    parts.push(Buffer.from([0])); // null terminator

    // realName
    const rnl = Buffer.alloc(4);
    rnl.writeInt32BE(nameBytes.length + 1, 0);
    parts.push(rnl);
    parts.push(Buffer.from(nameBytes));
    parts.push(Buffer.from([0]));

    // tableName = "" (1 byte = just null)
    const tl = Buffer.alloc(4);
    tl.writeInt32BE(1, 0);
    parts.push(tl);
    parts.push(Buffer.from([0]));

    // is_non_null: 1 unless the column says it permits NULL
    parts.push(Buffer.from([col.notNull === false ? 0 : 1]));

    // defaultValue = "" (1 byte null)
    const dl = Buffer.alloc(4);
    dl.writeInt32BE(1, 0);
    parts.push(dl);
    parts.push(Buffer.from([0]));

    // isAutoIncrement, isUniqueKey, isPrimaryKey, is_reverse_index, is_reverse_unique, isForeignKey, is_shared
    parts.push(Buffer.from([0, 0, 0, 0, 0, 0, 0]));
  }

  // --- Execute portion ---
  // totalTupleCount
  const ttc = Buffer.alloc(4);
  ttc.writeInt32BE(rows.length, 0);
  parts.push(ttc);

  // cache_reusable = 0
  const cr = Buffer.alloc(1);
  cr.writeInt8(0, 0);
  parts.push(cr);

  // resultCount = 1
  const rcc = Buffer.alloc(4);
  rcc.writeInt32BE(1, 0);
  parts.push(rcc);

  // resultInfo entry: [stmt_type:byte][result_count:int32][OID:8 bytes][cache_sec:int32][cache_usec:int32]
  const ri = Buffer.alloc(1 + 4 + 8 + 4 + 4);
  ri.writeInt8(21, 0); // SELECT
  ri.writeInt32BE(rows.length, 1);
  // OID (8 bytes) at offset 5 — already zeroed
  ri.writeInt32BE(0, 13); // cache time seconds
  ri.writeInt32BE(0, 17); // cache time microseconds
  parts.push(ri);

  // Inline fetch — fetchCode and tupleCount (only for SELECT)
  if (rows.length > 0) {
    // fetchCode >= 0 means inline data
    const fc = Buffer.alloc(4);
    fc.writeInt32BE(0, 0);
    parts.push(fc);

    // tupleCount
    const tc = Buffer.alloc(4);
    tc.writeInt32BE(rows.length, 0);
    parts.push(tc);

    // Tuples
    for (let i = 0; i < rows.length; i++) {
      // cursorPosition
      const cpp = Buffer.alloc(4);
      cpp.writeInt32BE(i + 1, 0);
      parts.push(cpp);

      // OID (8 bytes zeros)
      parts.push(Buffer.alloc(8));

      // Column values
      for (const val of rows[i]!) {
        if (val === null) {
          // NULL: size = -1
          const ns = Buffer.alloc(4);
          ns.writeInt32BE(-1, 0);
          parts.push(ns);
        } else {
          const valBytes = Buffer.from(val, "utf-8");
          const vs = Buffer.alloc(4);
          vs.writeInt32BE(valBytes.length + 1, 0); // +1 for null terminator
          parts.push(vs);
          parts.push(valBytes);
          parts.push(Buffer.from([0]));
        }
      }
    }
  } else {
    // No inline data
    const fc = Buffer.alloc(4);
    fc.writeInt32BE(-1, 0);
    parts.push(fc);
    const tc = Buffer.alloc(4);
    tc.writeInt32BE(0, 0);
    parts.push(tc);
  }

  return Buffer.concat(parts);
}

/**
 * Build an error response: [response_code:int32BE(<0)][error_code:int32BE][msg\0]
 */
function buildErrorResponse(errorCode: number, message: string): Buffer {
  const msgBytes = Buffer.from(message, "utf-8");
  const buf = Buffer.alloc(4 + 4 + msgBytes.length + 1);
  buf.writeInt32BE(-1, 0); // response_code < 0 = error
  buf.writeInt32BE(errorCode, 4);
  msgBytes.copy(buf, 8);
  buf[8 + msgBytes.length] = 0; // null terminator
  return buf;
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

test("NativeCubridAdapter connect delegates to CAS.connect", async () => {
  const adapter = new NativeCubridAdapter(DEFAULT_CONFIG);
  const fakeCAS = new FakeCASConnection();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).cas = fakeCAS;

  await adapter.connect();
  assert.equal(fakeCAS.connectCalls, 1);
});

test("NativeCubridAdapter connect creates CAS lazily if not set", async () => {
  // Use a port that nothing listens on so connect reliably fails
  const adapter = new NativeCubridAdapter({
    ...DEFAULT_CONFIG,
    port: 19999,
    connectionTimeout: 2000,
  });
  await assert.rejects(
    () => adapter.connect(),
    (err: Error) => {
      assert.ok(err instanceof ConnectionError);
      return true;
    },
  );
});

test("NativeCubridAdapter connect passes maxConnectionRetryCount to the CAS and keeps the cause", async () => {
  // The redirect target is closed, so each attempt reaches the broker once and fails.
  const redirect = await closedPort();
  let connections = 0;
  const broker = createServer((socket) => {
    connections += 1;
    socket.on("error", () => undefined);
    socket.once("data", () => {
      const reply = Buffer.alloc(4);
      reply.writeInt32BE(redirect, 0);
      socket.write(reply);
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const { port } = broker.address() as { port: number };
  const adapter = new NativeCubridAdapter({
    ...DEFAULT_CONFIG,
    port,
    maxConnectionRetryCount: 2,
  });

  try {
    await assert.rejects(
      () => adapter.connect(),
      (err: Error) => {
        assert.ok(err instanceof ConnectionError);
        assert.match((err.cause as Error).message, /Failed to connect/);
        return true;
      },
    );
    assert.equal(connections, 3);
  } finally {
    await new Promise((resolve) => broker.close(resolve));
  }
});

for (const maxConnectionRetryCount of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
  test(`NativeCubridAdapter rejects maxConnectionRetryCount ${maxConnectionRetryCount}`, () => {
    assert.throws(
      () => new NativeCubridAdapter({ ...DEFAULT_CONFIG, maxConnectionRetryCount }),
      RangeError,
    );
  });
}

test("NativeCubridAdapter connect wraps error as ConnectionError", async () => {
  const { adapter } = createAdapterWithFakeCAS(DEFAULT_CONFIG, {
    connectError: new Error("TCP refused"),
  } as Partial<FakeCASConnection>);

  await assert.rejects(
    () => adapter.connect(),
    (err: Error) => {
      assert.ok(err instanceof ConnectionError);
      assert.match(err.message, /Failed to connect/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// query() — DML (INSERT/UPDATE/DELETE)
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query DML returns empty array", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  // PrepareAndExecute response for INSERT
  fakeCAS.queueResponse(buildDMLResponse(20, 1)); // INSERT type=20
  // CloseReqHandle response
  fakeCAS.queueResponse(buildSimpleResponse(0));

  const result = await adapter.query("INSERT INTO t (val) VALUES ('x')");
  assert.deepEqual(result, []);
});

test("NativeCubridAdapter query UPDATE returns empty array", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.queueResponse(buildDMLResponse(22, 1)); // UPDATE type=22
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle

  const result = await adapter.query("UPDATE t SET val = 'y' WHERE val = 'x'");
  assert.deepEqual(result, []);
});

test("NativeCubridAdapter query DELETE returns empty array", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.queueResponse(buildDMLResponse(23, 1)); // DELETE type=23
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle

  const result = await adapter.query("DELETE FROM t WHERE val = 'x'");
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// query() — DDL and CALL (statement codes as observed from CUBRID 10.2 / 11.4)
// ---------------------------------------------------------------------------

for (const [label, code] of [
  ["ALTER_CLASS", 0],
  ["CREATE_CLASS", 4],
  ["CREATE_INDEX", 5],
  ["DROP_CLASS", 9],
  ["GRANT", 17],
] as const) {
  test(`NativeCubridAdapter query DDL statement code ${code} (${label}) returns empty array`, async () => {
    const { adapter, fakeCAS } = createAdapterWithFakeCAS();

    fakeCAS.queueResponse(buildDMLResponse(code, 0));
    fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle

    const result = await adapter.query("DDL");
    assert.deepEqual(result, []);
  });
}

// CALL (code 24) is a non-SELECT statement. The broker reports a result column
// for it, but query() does not read inline rows for it and returns []. Reading
// CALL results is currently unsupported.
test("NativeCubridAdapter query CALL statement code 24 returns empty array (results unsupported)", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.queueResponse(buildDMLResponse(24, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle

  const result = await adapter.query("CALL login('dba', '') ON CLASS db_user");
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// query() — SELECT
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query SELECT returns rows", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  const selectResp = buildSelectResponse(
    [
      { name: "id", type: 2 }, // STRING (values encoded as null-terminated strings)
      { name: "val", type: 2 }, // STRING
    ],
    [
      ["1", "hello"],
      ["2", "world"],
    ],
  );
  fakeCAS.queueResponse(selectResp);
  // CloseReqHandle
  fakeCAS.queueResponse(buildSimpleResponse(0));

  const rows = await adapter.query("SELECT id, val FROM t");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, "1");
  assert.equal(rows[0]!.val, "hello");
  assert.equal(rows[1]!.id, "2");
  assert.equal(rows[1]!.val, "world");
});

test("NativeCubridAdapter query SELECT with NULL values", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  const selectResp = buildSelectResponse([{ name: "val", type: 2 }], [[null]]);
  fakeCAS.queueResponse(selectResp);
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle

  const rows = await adapter.query("SELECT val FROM t");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.val, null);
});

// ---------------------------------------------------------------------------
// Backslash-escape mode negotiation (P0)
// ---------------------------------------------------------------------------

function queueProbeResponse(fakeCAS: FakeCASConnection, charLength: string): void {
  fakeCAS.queueResponse(buildSelectResponse([{ name: "char_length", type: 2 }], [[charLength]]));
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle after probe
}

test("negotiateBackslashEscapes: probe result 2 -> literal mode (true)", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  queueProbeResponse(fakeCAS, "2");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mode = await (adapter as any).negotiateBackslashEscapes(fakeCAS);
  assert.equal(mode, true);
});

test("negotiateBackslashEscapes: probe result 1 -> escape mode (false)", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  queueProbeResponse(fakeCAS, "1");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mode = await (adapter as any).negotiateBackslashEscapes(fakeCAS);
  assert.equal(mode, false);
});

test("negotiateBackslashEscapes: unexpected probe result is rejected, not guessed", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  queueProbeResponse(fakeCAS, "3");
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (adapter as any).negotiateBackslashEscapes(fakeCAS),
    /backslash-escaping mode/,
  );
});

test("ensureBackslashMode negotiates once and caches the result", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).noBackslashEscapes = null; // undo harness pre-set
  queueProbeResponse(fakeCAS, "2");
  const before = fakeCAS.sendAndRecvCalls;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = await (adapter as any).ensureBackslashMode(fakeCAS);
  const afterFirst = fakeCAS.sendAndRecvCalls;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const second = await (adapter as any).ensureBackslashMode(fakeCAS);
  const afterSecond = fakeCAS.sendAndRecvCalls;
  assert.equal(first, true);
  assert.equal(second, true);
  assert.ok(afterFirst > before, "probe should run on first call");
  assert.equal(afterSecond, afterFirst, "probe should not run again (cached)");
});

// ---------------------------------------------------------------------------
// query() — auto-reconnect
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query auto-connects if not connected", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;

  // connect() will be called
  fakeCAS.queueResponse(buildDMLResponse(20, 1)); // INSERT
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle

  const result = await adapter.query("INSERT INTO t (val) VALUES ('z')");
  assert.deepEqual(result, []);
  assert.equal(fakeCAS.connectCalls, 1);
});

// ---------------------------------------------------------------------------
// query() — parameter interpolation
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query interpolates parameters", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.queueResponse(buildDMLResponse(20, 1)); // INSERT
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CloseReqHandle

  const result = await adapter.query("INSERT INTO t (val) VALUES (?)", ["foo"]);
  assert.deepEqual(result, []);
  // The adapter should have called sendAndRecv with the interpolated SQL
  assert.equal(fakeCAS.sendAndRecvCalls, 2); // PrepareAndExecute + CloseReqHandle
});

test("a new session is probed again, so a changed backslash mode escapes its SQL", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(); // measured: literal mode
  const sql = "INSERT INTO t (val) VALUES (?)";
  const sentSql = (): string[] =>
    fakeCAS.sentPayloads
      .filter((payload) => payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE)
      .map((payload) => payload.toString("latin1"));

  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query(sql, ["a\\b"]);
  assert.match(sentSql()[0]!, /'a\\b'/);

  // The server now runs with backslash escapes, and the next request reconnects.
  fakeCAS.released = true;
  queueProbeResponse(fakeCAS, "1");
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query(sql, ["a\\b"]);
  const sent = sentSql();
  assert.match(sent[1]!, /CHAR_LENGTH/);
  assert.match(sent[2]!, /'a\\\\b'/);

  // The same session is not probed again.
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query(sql, ["a\\b"]);
  assert.equal(sentSql().length, 4);

  // A parameter both modes render alike needs no probe on a new session.
  fakeCAS.released = true;
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query(sql, ["plain"]);
  assert.equal(sentSql().length, 5);
});

test("a negative parameter after a minus sign is sent parenthesized, never as a comment", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  const sentSql = (): string[] =>
    fakeCAS.sentPayloads
      .filter((payload) => payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE)
      .map((payload) => payload.toString("latin1"));

  for (const value of [-1, -1n]) {
    fakeCAS.queueResponse(buildDMLResponse(20, 1));
    fakeCAS.queueResponse(buildSimpleResponse(0));
    await adapter.query("UPDATE t SET b = b-? WHERE id = 1", [value]);
  }
  for (const sql of sentSql()) {
    assert.ok(sql.includes("UPDATE t SET b = b-(-1) WHERE id = 1"), sql);
    assert.ok(!sql.includes("--"), sql);
  }
  assert.equal(sentSql().length, 2);
});

test("a value the literal path cannot render is refused before connecting or sending", async () => {
  const refused: unknown[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date(Number.NaN),
    [1, 2],
    { toString: () => "1 OR 1=1" },
    () => 1,
    Symbol("s"),
  ];
  for (const value of refused) {
    const params = [1, value] as unknown as QueryParam[];
    const calls: Array<[string, (adapter: NativeCubridAdapter) => Promise<unknown>]> = [
      ["query", (adapter) => adapter.query("SELECT ?, ?", params)],
      ["queryResult", (adapter) => adapter.queryResult("SELECT ?, ?", params)],
      ["execute", (adapter) => adapter.execute("UPDATE t SET a = ? WHERE id = ?", params)],
      [
        "stream",
        async (adapter) => {
          for await (const _row of adapter.stream("SELECT ?, ?", params)) {
            // unreachable
          }
        },
      ],
    ];
    for (const [name, call] of calls) {
      const { adapter, fakeCAS } = createAdapterWithFakeCAS();
      fakeCAS._isConnected = false;
      await assert.rejects(call(adapter), (error: unknown) => {
        assert.ok(error instanceof QueryError, name);
        assert.ok(error.cause instanceof Error);
        return true;
      });
      assert.equal(fakeCAS.sendAndRecvCalls, 0, name);
      assert.equal(fakeCAS.connectCalls, 0, name);
    }
  }
});

test("too few or too many values are refused before connecting or sending (#243)", async () => {
  const cases: Array<[string, QueryParam[]]> = [
    ["SELECT ?", [1, 2]],
    ["SELECT ?, ?", [1]],
    ["SELECT ?", []],
    ["SELECT 1 // ?", [1]],
    ["SELECT [a?] FROM t", [1]],
  ];
  for (const [sql, params] of cases) {
    const calls: Array<(adapter: NativeCubridAdapter) => Promise<unknown>> = [
      (adapter) => adapter.query(sql, params),
      (adapter) => adapter.execute(sql, params),
      async (adapter) => {
        for await (const _row of adapter.stream(sql, params)) {
          // unreachable
        }
      },
    ];
    for (const call of calls) {
      const { adapter, fakeCAS } = createAdapterWithFakeCAS();
      fakeCAS._isConnected = false;
      await assert.rejects(call(adapter), (error: unknown) => {
        assert.ok(error instanceof QueryError);
        assert.match((error.cause as Error).message, /Parameter count mismatch/);
        return true;
      });
      assert.equal(fakeCAS.sendAndRecvCalls, 0, sql);
      assert.equal(fakeCAS.connectCalls, 0, sql);
    }
  }
});

test("SQL without params is still sent as written", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query("UPDATE t SET a = '?' // ?");
  assert.match(fakeCAS.sentPayloads[0]!.toString("latin1"), /UPDATE t SET a = '\?' \/\/ \?/);
});

test("markers that depend on the backslash mode are counted after the probe, before the SQL is sent", async () => {
  const sql = "SELECT 'it\\'s', ?";
  const userSql = (fakeCAS: FakeCASConnection): string[] =>
    fakeCAS.sentPayloads
      .filter((payload) => payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE)
      .map((payload) => payload.toString("latin1"))
      .filter((text) => !text.includes("CHAR_LENGTH"));

  // no_backslash_escapes=yes: 'it\' is a string and the rest an unterminated one,
  // so there is no marker for the value.
  {
    const { adapter, fakeCAS } = createAdapterWithFakeCAS();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).noBackslashEscapes = null;
    queueProbeResponse(fakeCAS, "2");
    await assert.rejects(adapter.query(sql, ["x' OR 1=1 --"]), (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match((error.cause as Error).message, /Parameter count mismatch/);
      return true;
    });
    assert.deepEqual(userSql(fakeCAS), []);
  }

  // no_backslash_escapes=no: one string and one marker.
  {
    const { adapter, fakeCAS } = createAdapterWithFakeCAS();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).noBackslashEscapes = null;
    queueProbeResponse(fakeCAS, "1");
    fakeCAS.queueResponse(buildSelectResponse([{ name: "v", type: 2 }], [["1"]]));
    fakeCAS.queueResponse(buildSimpleResponse(0));
    await adapter.query(sql, ["x' OR 1=1 --"]);
    const [sent] = userSql(fakeCAS);
    assert.ok(sent?.includes("SELECT 'it\\'s', 'x'' OR 1=1 --'"), sent);
  }
});

test("the values are read once, so a getter cannot pass the mode check and then change", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(); // measured: literal mode
  let reads = 0;
  const params: QueryParam[] = [];
  Object.defineProperty(params, 0, {
    enumerable: true,
    get: () => (++reads === 1 ? "a" : "\\' OR 1=1 -- "),
  });
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query("DELETE FROM t WHERE n = ?", params);

  assert.equal(reads, 1);
  assert.match(fakeCAS.sentPayloads[0]!.toString("latin1"), /DELETE FROM t WHERE n = 'a'/);
});

test("a statement that may set system parameters makes the next bound one probe again", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(); // measured: literal mode
  const sentSql = (): string[] =>
    fakeCAS.sentPayloads
      .filter((payload) => payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE)
      .map((payload) => payload.toString("latin1"));

  fakeCAS.queueResponse(buildDMLResponse(20, 0));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query("SET SYSTEM PARAMETERS 'no_backslash_escapes=no'");

  queueProbeResponse(fakeCAS, "1");
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query("UPDATE t SET v = ?", ["a\\'b"]);
  const sent = sentSql();
  assert.match(sent[1]!, /CHAR_LENGTH/);
  assert.ok(sent[2]!.includes("UPDATE t SET v = 'a\\\\''b'"), sent[2]);
});

// ---------------------------------------------------------------------------
// query() — error handling
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query wraps CAS error as QueryError", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.sendAndRecvError = new Error("wire protocol failure");

  await assert.rejects(
    () => adapter.query("SELECT 1"),
    (err: Error) => {
      assert.ok(err instanceof QueryError);
      assert.match(err.message, /Failed to execute CUBRID query/);
      return true;
    },
  );
});

test("NativeCubridAdapter query wraps protocol error as QueryError", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.queueResponse(buildErrorResponse(-493, "Syntax error"));

  await assert.rejects(
    () => adapter.query("INVALID SQL"),
    (err: Error) => {
      assert.ok(err instanceof QueryError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// beginTransaction()
// ---------------------------------------------------------------------------

test("NativeCubridAdapter beginTransaction sets autoCommit false", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  await adapter.beginTransaction();

  // Verify autoCommit is false via private field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).autoCommit, false);
  // Should not have called sendAndRecv (no CAS command for beginTransaction)
  assert.equal(fakeCAS.sendAndRecvCalls, 0);
});

test("NativeCubridAdapter beginTransaction auto-connects if not connected", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;

  await adapter.beginTransaction();
  assert.equal(fakeCAS.connectCalls, 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).autoCommit, false);
});

test("NativeCubridAdapter beginTransaction wraps connect error as TransactionError", async () => {
  const { adapter } = createAdapterWithFakeCAS(DEFAULT_CONFIG, {
    _isConnected: false,
    connectError: new Error("connect failed"),
  } as Partial<FakeCASConnection>);

  await assert.rejects(
    () => adapter.beginTransaction(),
    (err: Error) => {
      assert.ok(err instanceof TransactionError);
      assert.match(err.message, /Failed to start transaction/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// commit()
// ---------------------------------------------------------------------------

test("NativeCubridAdapter commit sends END_TRAN COMMIT", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  // Set up a transaction state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).autoCommit = false;

  fakeCAS.queueResponse(buildSimpleResponse(0)); // EndTran response

  await adapter.commit();

  assert.equal(fakeCAS.sendAndRecvCalls, 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).autoCommit, true); // Restored after commit
});

test("NativeCubridAdapter commit throws when not connected", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;

  await assert.rejects(
    () => adapter.commit(),
    (err: Error) => {
      assert.ok(err instanceof TransactionError);
      assert.match(err.message, /Failed to commit/);
      return true;
    },
  );
});

test("NativeCubridAdapter commit wraps protocol error as TransactionError", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.sendAndRecvError = new Error("network failure");

  await assert.rejects(
    () => adapter.commit(),
    (err: Error) => {
      assert.ok(err instanceof TransactionError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// rollback()
// ---------------------------------------------------------------------------

test("NativeCubridAdapter rollback sends END_TRAN ROLLBACK", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).autoCommit = false;

  fakeCAS.queueResponse(buildSimpleResponse(0)); // EndTran response

  await adapter.rollback();

  assert.equal(fakeCAS.sendAndRecvCalls, 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).autoCommit, true); // Restored after rollback
});

test("NativeCubridAdapter rollback throws when not connected", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;

  await assert.rejects(
    () => adapter.rollback(),
    (err: Error) => {
      assert.ok(err instanceof TransactionError);
      assert.match(err.message, /Failed to roll back/);
      return true;
    },
  );
});

test("NativeCubridAdapter rollback wraps protocol error as TransactionError", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  fakeCAS.sendAndRecvError = new Error("network failure");

  await assert.rejects(
    () => adapter.rollback(),
    (err: Error) => {
      assert.ok(err instanceof TransactionError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

test("NativeCubridAdapter close is a no-op when no CAS exists", async () => {
  const adapter = new NativeCubridAdapter(DEFAULT_CONFIG);
  // No CAS was created, close should not throw
  await adapter.close();
});

test("NativeCubridAdapter close sends CON_CLOSE and destroys socket", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  await adapter.close();

  // Should have called send (for CON_CLOSE) and close
  assert.equal(fakeCAS.sendCalls, 1);
  assert.equal(fakeCAS.closeCalls, 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).cas, null); // CAS reference cleared
});

test("NativeCubridAdapter close still closes if CON_CLOSE send fails", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.sendError = new Error("send failed");

  await adapter.close();

  // send was called but failed — close should still be called
  assert.equal(fakeCAS.sendCalls, 1);
  assert.equal(fakeCAS.closeCalls, 1);
});

test("NativeCubridAdapter close skips CON_CLOSE when not connected", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;

  await adapter.close();

  // Should NOT have tried to send CON_CLOSE
  assert.equal(fakeCAS.sendCalls, 0);
  // But should still call close
  assert.equal(fakeCAS.closeCalls, 1);
});

test("NativeCubridAdapter close wraps error as ConnectionError", async () => {
  const { adapter } = createAdapterWithFakeCAS();

  // Override close to throw
  const fakeCAS = new FakeCASConnection();
  fakeCAS.closeCalls = 0;
  const originalClose = fakeCAS.close.bind(fakeCAS);
  fakeCAS.close = async () => {
    await originalClose();
    throw new Error("socket destroy failed");
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).cas = fakeCAS;

  await assert.rejects(
    () => adapter.close(),
    (err: Error) => {
      assert.ok(err instanceof ConnectionError);
      assert.match(err.message, /Failed to close/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// getOrCreateCAS — connectionTimeout forwarding
// ---------------------------------------------------------------------------

test("NativeCubridAdapter forwards connectionTimeout to CAS config", async () => {
  const config: ClientConfig = {
    ...DEFAULT_CONFIG,
    port: 19999, // Use non-connectable port to avoid real connection
    connectionTimeout: 5000,
  };
  const adapter = new NativeCubridAdapter(config);

  // Trigger getOrCreateCAS by calling connect (will fail but creates CAS)
  try {
    await adapter.connect();
  } catch {
    // Expected — no server on port 19999
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cas = (adapter as any).cas;
  assert.ok(cas, "CAS should have been created");
  // The CAS config should have connectionTimeout
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((cas as any).config.connectionTimeout, 5000);
});

test("NativeCubridAdapter omits connectionTimeout when undefined", async () => {
  const config: ClientConfig = {
    ...DEFAULT_CONFIG,
    port: 19999, // Use non-connectable port to avoid real connection
    // connectionTimeout NOT set
  };
  const adapter = new NativeCubridAdapter(config);

  try {
    await adapter.connect();
  } catch {
    // Expected
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cas = (adapter as any).cas;
  assert.ok(cas);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((cas as any).config.connectionTimeout, undefined);
});

// ---------------------------------------------------------------------------
// query() — closeQueryHandle error is swallowed
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query swallows closeQueryHandle error", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  let callCount = 0;
  const originalSendAndRecv = fakeCAS.sendAndRecv.bind(fakeCAS);
  fakeCAS.sendAndRecv = async (header: Buffer, payload: Buffer) => {
    callCount++;
    if (callCount === 1) {
      // First call: PrepareAndExecute — return DML response
      return buildDMLResponse(20, 1);
    }
    // Second call: CloseReqHandle — throw error (should be swallowed)
    throw new Error("close failed");
  };

  // Should not throw despite CloseReqHandle failure
  const result = await adapter.query("INSERT INTO t (val) VALUES ('x')");
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// createClient integration
// ---------------------------------------------------------------------------

test("NativeCubridAdapter is used by default in createClient", async () => {
  const { createClient } = await import("../src/client/create-client.js");
  const client = createClient({
    host: "127.0.0.1",
    port: 33000,
    database: "testdb",
    user: "dba",
  });

  // The client should exist (we can't easily test the internal adapter type
  // without connecting, but we verify createClient doesn't crash)
  assert.ok(client);
});

// ---------------------------------------------------------------------------
// query() — fetchRemaining (multi-fetch)
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query SELECT fetches remaining rows", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  // Build a SELECT response where totalTupleCount > inline rows
  // This triggers fetchRemaining()
  const selectResp = buildSelectResponse(
    [{ name: "id", type: 2 }], // STRING column
    [["1"]], // Only 1 inline row
  );
  // Patch totalTupleCount to be 2 (more than inline rows)
  // totalTupleCount is at a fixed offset in the response.
  // We'll need to patch it. Let's find the offset.
  // Build fresh and modify totalTupleCount:
  // queryHandle(4) + cacheLifetime(4) + stmtType(1) + bindCount(4) + isUpdatable(1) + colCount(4)
  // + colMeta(...) + totalTupleCount(4)
  // For 1 column named "id":
  //   type(1) + scale(2) + precision(4) + nameLen(4) + "id\0"(3) + realNameLen(4) + "id\0"(3)
  //   + tableNameLen(4) + "\0"(1) + isNullable(1) + defaultLen(4) + "\0"(1) + flags(7) = 39
  const colMetaSize = 1 + 2 + 4 + 4 + 3 + 4 + 3 + 4 + 1 + 1 + 4 + 1 + 7;
  const ttcOffset = 4 + 4 + 1 + 4 + 1 + 4 + colMetaSize;
  selectResp.writeInt32BE(2, ttcOffset); // totalTupleCount = 2

  fakeCAS.queueResponse(selectResp);

  // Build fetch response for the remaining row
  // parseFetch expects: [responseCode:int32][tupleCount:int32][rows...]
  const fetchParts: Buffer[] = [];

  // responseCode = 0 (success)
  const frc = Buffer.alloc(4);
  frc.writeInt32BE(0, 0);
  fetchParts.push(frc);

  // tupleCount = 1
  const ftc = Buffer.alloc(4);
  ftc.writeInt32BE(1, 0);
  fetchParts.push(ftc);

  // Row: cursorPosition + OID + value
  const cpp = Buffer.alloc(4);
  cpp.writeInt32BE(2, 0);
  fetchParts.push(cpp);
  fetchParts.push(Buffer.alloc(8)); // OID
  const valBytes = Buffer.from("2", "utf-8");
  const vs = Buffer.alloc(4);
  vs.writeInt32BE(valBytes.length + 1, 0);
  fetchParts.push(vs, valBytes, Buffer.from([0]));

  fakeCAS.queueResponse(Buffer.concat(fetchParts));

  // CloseReqHandle
  fakeCAS.queueResponse(buildSimpleResponse(0));

  const rows = await adapter.query("SELECT id FROM t");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, "1");
  assert.equal(rows[1]!.id, "2");
  // 3 sendAndRecv calls: PrepareAndExecute + Fetch + CloseReqHandle
  assert.equal(fakeCAS.sendAndRecvCalls, 3);
});

test("NativeCubridAdapter never sends a FETCH to a session other than the one holding its handle", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));
  // The session is replaced between the execute and its FETCH.
  fakeCAS.sendAndRecvOnSession = async () => null;

  await assert.rejects(adapter.query("SELECT 1"), (error: Error) => {
    assert.ok(error instanceof QueryError);
    assert.equal(error.kind, "connection-lost");
    return true;
  });

  assert.equal(fakeCAS.sendAndRecvCalls, 1);
});

test("NativeCubridAdapter rejects zero-tuple FETCH before the advertised total", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  // Build a SELECT response where totalTupleCount > inline rows
  const selectResp = buildSelectResponse([{ name: "id", type: 2 }], [["1"]]);
  const colMetaSize = 1 + 2 + 4 + 4 + 3 + 4 + 3 + 4 + 1 + 1 + 4 + 1 + 7;
  const ttcOffset = 4 + 4 + 1 + 4 + 1 + 4 + colMetaSize;
  selectResp.writeInt32BE(3, ttcOffset); // totalTupleCount = 3 (but fetch returns 0)

  fakeCAS.queueResponse(selectResp);

  // Fetch returns 0 tuples (empty)
  const emptyFetch = Buffer.alloc(8);
  emptyFetch.writeInt32BE(0, 0); // responseCode = 0
  emptyFetch.writeInt32BE(0, 4); // tupleCount = 0
  fakeCAS.queueResponse(emptyFetch);

  // CloseReqHandle
  fakeCAS.queueResponse(buildSimpleResponse(0));

  // A successful zero-row FETCH cannot complete a query that advertises 3 rows.
  await assert.rejects(adapter.query("SELECT id FROM t"), QueryError);
});

// ---------------------------------------------------------------------------
// query() — auto-connect failure during query
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query wraps connect failure as QueryError", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, {
    _isConnected: false,
    connectError: new Error("connect failed in query"),
  } as Partial<FakeCASConnection>);

  await assert.rejects(
    () => adapter.query("SELECT 1"),
    (err: Error) => {
      assert.ok(err instanceof QueryError);
      assert.match(err.message, /Failed to execute CUBRID query/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Connection loss during a transaction (#107)
// ---------------------------------------------------------------------------

test("NativeCubridAdapter query refuses to reconnect inside a transaction", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  await adapter.beginTransaction();
  fakeCAS._isConnected = false;

  await assert.rejects(adapter.query("SELECT 1"), (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.match((error.cause as Error).message, /Connection lost during transaction/);
    return true;
  });
  assert.equal(fakeCAS.connectCalls, 0);
});

for (const method of ["commit", "rollback"] as const) {
  test(`NativeCubridAdapter ${method} on a lost connection allows later autocommit queries`, async () => {
    const { adapter, fakeCAS } = createAdapterWithFakeCAS();
    await adapter.beginTransaction();
    fakeCAS._isConnected = false;

    await assert.rejects(adapter[method](), TransactionError);

    fakeCAS.queueResponse(buildDMLResponse(20, 1));
    fakeCAS.queueResponse(buildSimpleResponse(0));
    await adapter.query("INSERT INTO t VALUES (1)");
    assert.equal(fakeCAS.connectCalls, 1);
  });

  test(`NativeCubridAdapter ${method} failing mid-exchange allows later autocommit queries`, async () => {
    const { adapter, fakeCAS } = createAdapterWithFakeCAS();
    await adapter.beginTransaction();
    fakeCAS.sendAndRecv = async () => {
      fakeCAS._isConnected = false;
      throw new Error("Invalid CAS frame length -1");
    };

    await assert.rejects(adapter[method](), TransactionError);

    fakeCAS.sendAndRecv = FakeCASConnection.prototype.sendAndRecv;
    fakeCAS.queueResponse(buildDMLResponse(20, 1));
    fakeCAS.queueResponse(buildSimpleResponse(0));
    await adapter.query("INSERT INTO t VALUES (1)");
    assert.equal(fakeCAS.connectCalls, 1);
  });

  test(`NativeCubridAdapter ${method} rejected by a live server keeps the transaction open`, async () => {
    const { adapter, fakeCAS } = createAdapterWithFakeCAS();
    await adapter.beginTransaction();
    fakeCAS.queueResponse(buildErrorResponse(-1, "server refused"));

    await assert.rejects(adapter[method](), TransactionError);

    fakeCAS.queueResponse(buildSimpleResponse(0));
    await adapter[method]();
  });
}

async function beginWithOneInsert() {
  const created = createAdapterWithFakeCAS();
  await created.adapter.beginTransaction();
  created.fakeCAS.queueResponse(buildDMLResponse(20, 1));
  created.fakeCAS.queueResponse(buildSimpleResponse(0));
  await created.adapter.query("INSERT INTO t VALUES ('a')");
  return created;
}

test("committing on a lost session reports the lost connection", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS._isConnected = false;

  await assert.rejects(adapter.commit(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.kind, "connection-lost");
    assert.equal(error.code, undefined);
    return true;
  });
});

test("committing with no transaction on a closed connection loses nothing", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;

  await assert.rejects(adapter.commit(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.kind, undefined);
    return true;
  });
});

test("NativeCubridAdapter does not resume a failed first transaction statement after ping", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  await adapter.beginTransaction();

  fakeCAS.sendAndRecv = async () => {
    fakeCAS.sendAndRecvCalls++;
    fakeCAS._isConnected = false;
    throw new Error("simulated socket loss during first INSERT");
  };
  await assert.rejects(adapter.query("INSERT INTO t VALUES (1)"), QueryError);

  // Explicit reconnect (as ping() would do) must not move this transaction.
  await fakeCAS.connect();
  const callsBefore = fakeCAS.sendAndRecvCalls;
  await assert.rejects(adapter.query("INSERT INTO t VALUES (2)"), (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.match(String(error), /Failed to execute CUBRID query/);
    return true;
  });
  await assert.rejects(adapter.commit(), TransactionError);
  assert.equal(fakeCAS.sendAndRecvCalls, callsBefore);
});

test("NativeCubridAdapter does not commit part of a transaction after ping reconnects", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS._isConnected = false;
  await fakeCAS.connect(); // what ping() does on a retired connection
  const callsBefore = fakeCAS.sendAndRecvCalls;

  await assert.rejects(adapter.query("INSERT INTO t VALUES ('c')"), QueryError);
  await assert.rejects(adapter.commit(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.match((error.cause as Error).message, /Connection lost during transaction/);
    return true;
  });

  assert.equal(fakeCAS.sendAndRecvCalls, callsBefore);
});

test("NativeCubridAdapter rejects commit when the server session changed during it", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS.sendAndRecv = async () => {
    fakeCAS.connectionGeneration += 1;
    return buildSimpleResponse(0);
  };

  await assert.rejects(adapter.commit(), TransactionError);
});

test("NativeCubridAdapter allows a released CAS to reconnect on the first statement", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  await adapter.beginTransaction();

  const responses = [buildDMLResponse(20, 1), buildSimpleResponse(0), buildSimpleResponse(0)];
  fakeCAS.sendAndRecv = async () => {
    if (responses.length === 3) {
      fakeCAS.connectionGeneration += 1;
    }
    return responses.shift()!;
  };

  await adapter.query("INSERT INTO t VALUES ('a')");
  await adapter.commit();
});

test("NativeCubridAdapter close ends an open transaction", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  await adapter.beginTransaction();
  await adapter.close();

  (adapter as unknown as { cas: FakeCASConnection }).cas = fakeCAS;
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query("INSERT INTO t VALUES (1)");
});

test("NativeCubridAdapter discards a statement that ran on a replaced session", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS.sendAndRecv = async () => {
    fakeCAS.connectionGeneration += 1;
    return buildDMLResponse(20, 1);
  };

  await assert.rejects(adapter.query("INSERT INTO t VALUES ('c')"), QueryError);

  assert.equal(fakeCAS.discardCalls, 1);
  assert.equal(fakeCAS.isConnected, false);
});

test("NativeCubridAdapter beginTransaction refuses to hide a lost transaction", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS._isConnected = false;

  await assert.rejects(adapter.beginTransaction(), TransactionError);
  assert.equal(fakeCAS.connectCalls, 0);

  await assert.rejects(adapter.rollback(), TransactionError);
  await adapter.beginTransaction();
  assert.equal(fakeCAS.connectCalls, 1);
});

// ---------------------------------------------------------------------------
// Query handle lifecycle (#108)
// ---------------------------------------------------------------------------

const QUERY_HANDLE = 7;

/** A SELECT with one inline row and `total` rows on the server. */
function buildPartialSelectResponse(total: number): Buffer {
  const response = buildSelectResponse([{ name: "id", type: 2 }], [["1"]]);
  const colMetaSize = 1 + 2 + 4 + 4 + 3 + 4 + 3 + 4 + 1 + 1 + 4 + 1 + 7;
  response.writeInt32BE(QUERY_HANDLE, 0);
  response.writeInt32BE(total, 4 + 4 + 1 + 4 + 1 + 4 + colMetaSize);
  return response;
}

/** A FETCH response announcing a row whose bytes are cut off. */
function buildTruncatedFetchResponse(): Buffer {
  const response = Buffer.alloc(4 + 4 + 2);
  response.writeInt32BE(0, 0);
  response.writeInt32BE(1, 4);
  return response;
}

/** A SELECT response that carries a handle but cuts off inside its inline row. */
function buildTruncatedSelectResponse(handle = QUERY_HANDLE): Buffer {
  const response = buildSelectResponse([{ name: "id", type: 2 }], [["a long value"]]);
  response.writeInt32BE(handle, 0);
  return response.subarray(0, response.length - 5);
}

async function assertQueryFails(
  adapter: NativeCubridAdapter,
  causePattern: RegExp,
  sql = "SELECT id FROM t",
): Promise<void> {
  await assert.rejects(
    () => adapter.query(sql),
    (err: Error) => {
      assert.ok(err instanceof QueryError);
      // A column-aware decoding error wraps the original malformed-packet
      // cause; inspect the cause chain without hiding the underlying failure.
      const messages: string[] = [];
      let current: unknown = err.cause;
      while (current instanceof Error) {
        messages.push(current.message);
        current = current.cause;
      }
      assert.match(messages.join(" | "), causePattern);
      return true;
    },
  );
}

test("query handle: a successful SELECT closes it exactly once", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(1));

  await adapter.query("SELECT id FROM t");

  assert.deepEqual(fakeCAS.closedHandles, [QUERY_HANDLE]);
});

test("query handle: a successful DML closes it exactly once", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildDMLResponse(20, 1));

  await adapter.query("INSERT INTO t VALUES (1)");

  assert.deepEqual(fakeCAS.closedHandles, [1]);
});

test("query handle: premature FETCH termination rejects and closes exactly once", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(3));
  fakeCAS.queueResponse(buildErrorResponse(-1, "no more data"));

  // #129 disallows returning incomplete rows on a negative FETCH envelope.
  await assertQueryFails(adapter, /CUBRID fetch failed/);
  assert.deepEqual(fakeCAS.closedHandles, [QUERY_HANDLE]);
});

test("query handle: a FETCH rejected by the server still closes it", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));
  const fetchError = buildErrorResponse(-495, "fetch rejected");
  fetchError.writeInt32BE(-2, 0);
  fakeCAS.queueResponse(fetchError);

  await assertQueryFails(adapter, /CUBRID fetch failed/);

  assert.deepEqual(fakeCAS.closedHandles, [QUERY_HANDLE]);
  assert.equal(fakeCAS.isConnected, true);
});

/** The session a damaged reply arrived on is dropped, and nothing more is sent on it. */
function assertSessionDiscarded(fakeCAS: FakeCASConnection): void {
  assert.equal(fakeCAS.discardCalls, 1);
  assert.equal(fakeCAS.isConnected, false);
  assert.deepEqual(fakeCAS.closedHandles, []);
}

test("query handle: a malformed FETCH drops the session instead of closing it", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));
  fakeCAS.queueResponse(buildTruncatedFetchResponse());

  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i);

  assertSessionDiscarded(fakeCAS);
});

test("query handle: malformed inline rows drop the session instead of closing it", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildTruncatedSelectResponse());

  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i);

  assertSessionDiscarded(fakeCAS);
});

test("query handle: malformed column metadata drops the session instead of closing it", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildDMLResponse(20, 1).subarray(0, 12));

  await assertQueryFails(adapter, /out of range|outside/i, "INSERT INTO t VALUES (1)");

  assertSessionDiscarded(fakeCAS);
});

test("a reply too short to hold a response code drops the session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(Buffer.from("0000", "hex"));

  await assertQueryFails(adapter, /reply of 2 bytes/);

  assertSessionDiscarded(fakeCAS);
});

test("a malformed reply reconnects the next autocommit query on a new session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildTruncatedSelectResponse());
  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i);

  fakeCAS.queueResponse(buildSelectResponse([{ name: "id", type: 2 }], [["1"]]));

  assert.deepEqual(await adapter.query("SELECT id FROM t"), [{ id: "1" }]);
  assert.equal(fakeCAS.connectCalls, 1);
});

test("a malformed reply loses the open transaction instead of committing what follows", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS.queueResponse(buildTruncatedSelectResponse());
  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i);
  assert.equal(fakeCAS.discardCalls, 1);
  fakeCAS.sentPayloads = [];

  await assert.rejects(adapter.query("INSERT INTO t VALUES (2)"), /Failed to execute/);
  await assert.rejects(adapter.commit(), TransactionError);

  assert.equal(fakeCAS.connectCalls, 0);
  assert.deepEqual(fakeCAS.sentPayloads, []);
});

for (const acknowledge of ["commit", "rollback"] as const) {
  test(`a rejected ${acknowledge}() acknowledges the lost transaction, so autocommit resumes`, async () => {
    const { adapter, fakeCAS } = await beginWithOneInsert();
    fakeCAS.queueResponse(buildTruncatedSelectResponse());
    await assertQueryFails(adapter, /Malformed CAS packet|out of range/i);

    await assert.rejects(adapter[acknowledge](), TransactionError);
    fakeCAS.queueResponse(buildSelectResponse([{ name: "id", type: 2 }], [["1"]]));

    assert.deepEqual(await adapter.query("SELECT id FROM t"), [{ id: "1" }]);
    assert.equal(fakeCAS.connectCalls, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((adapter as any).autoCommit, true);
  });
}

test("a malformed reply cannot rebind a transaction on a replacement session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).noBackslashEscapes = null;
  await adapter.beginTransaction();
  fakeCAS.queueResponse(buildTruncatedSelectResponse());

  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i, "UPDATE t SET a = ?");

  assert.equal(fakeCAS.discardCalls, 1);
  await assert.rejects(adapter.commit(), TransactionError);
  assert.equal(fakeCAS.connectCalls, 0);
});

/** The query handle the broker gave the captured OID reply (its first int32). */
const OID_FRAME_HANDLE = 20;

test("a zero-byte value without a decoder rejects, and the session stays open", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  // The captured OID reply, with its 8-byte value (type 19) removed.
  const value = "000000080000110100020000";
  const { hex } = ZONED_FRAMES.oidValue;
  assert.ok(hex.includes(value));
  fakeCAS.queueResponse(Buffer.from(hex.replace(value, "00000000"), "hex"));

  await assertQueryFails(adapter, /column "o" \(wire type 19, 0 bytes\)/);

  assert.equal(fakeCAS.discardCalls, 0);
  assert.equal(fakeCAS.isConnected, true);
  assert.deepEqual(fakeCAS.closedHandles, [OID_FRAME_HANDLE]);
});

test("a captured zero date rejects, and the session stays open for the next query", async () => {
  for (const frame of [
    CAPTURED_FRAMES.zeroDate,
    CAPTURED_FRAMES.zeroDatetime,
    CAPTURED_FRAMES.zeroTimestamp,
    CAPTURED_FRAMES.zeroDateElement,
    ZONED_FRAMES.zeroTimestamptz,
    ZONED_FRAMES.zeroDatetimetz,
  ]) {
    const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
    fakeCAS.queueResponse(Buffer.from(frame.hex, "hex"));

    await assertQueryFails(adapter, /Zero date 0000-00-00/);

    assert.equal(fakeCAS.discardCalls, 0, frame.sql);
    assert.equal(fakeCAS.isConnected, true, frame.sql);
    assert.deepEqual(
      fakeCAS.closedHandles,
      [Number.parseInt(frame.hex.slice(0, 8), 16)],
      frame.sql,
    );
  }
});

test("a zoned value reaches the caller with its zone, and its column has the type name", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(Buffer.from(ZONED_FRAMES.datetimetzRegion.hex, "hex"));

  const { rows, columns } = await adapter.queryResult("SELECT tz FROM t");

  assert.equal(String(rows[0]?.tz), "2020-07-02 03:04:05.999 America/New_York EDT");
  assert.equal(rows[0]?.t, "after");
  assert.deepEqual(
    columns.map((column) => column.type),
    ["DATETIMETZ", "CHAR"],
  );
});

test("a zoned value whose zone text has no NUL drops the session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  const { hex } = ZONED_FRAMES.timestamptzOffset;
  // "+09:00" and its NUL become "+09:00:" in a cell of the same length.
  const zone = "2b30393a303000";
  assert.ok(hex.includes(zone));
  fakeCAS.queueResponse(Buffer.from(hex.replace(zone, "2b30393a30303a"), "hex"));

  await assertQueryFails(adapter, /zone text/);

  assertSessionDiscarded(fakeCAS);
});

test("damage after an unsupported value still drops the session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  const { hex } = ZONED_FRAMES.oidValue;
  // Column t follows the unsupported value and now claims more bytes than remain.
  const tail = "0000000661667465720001";
  assert.ok(hex.endsWith(tail));
  fakeCAS.queueResponse(Buffer.from(hex.slice(0, -tail.length) + "7fffffff", "hex"));

  await assertQueryFails(adapter, /cannot read 2147483647 bytes/);

  assertSessionDiscarded(fakeCAS);
});

test("query handle: nothing is closed when the server returned no handle", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildErrorResponse(-493, "syntax error"));

  await assertQueryFails(adapter, /CUBRID query failed/);

  assert.deepEqual(fakeCAS.closedHandles, []);
});

test("query handle: nothing is closed on a socket the failed FETCH retired", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));
  fakeCAS.queueExchangeFailure(new Error("socket reset"));

  await assertQueryFails(adapter, /socket reset/);

  assert.deepEqual(fakeCAS.closedHandles, []);
  assert.equal(fakeCAS.sendAndRecvCalls, 2);

  // The broken connection is not reused: the next query opens a new one.
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  await adapter.query("INSERT INTO t VALUES (1)");
  assert.equal(fakeCAS.connectCalls, 1);
});

test("query handle: nothing is closed when decoding finds the socket retired", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  const original = fakeCAS.sendAndRecv.bind(fakeCAS);
  fakeCAS.sendAndRecv = async (header: Buffer, payload: Buffer) => {
    const response = await original(header, payload);
    fakeCAS._isConnected = false;
    return response;
  };
  fakeCAS.queueResponse(buildTruncatedSelectResponse());

  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i);

  assert.deepEqual(fakeCAS.closedHandles, []);
});

test("query handle: nothing is closed on a session that replaced the handle's", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));

  // Another caller retired the socket and reconnected while this FETCH was
  // queued. The number now names nothing here, or that caller's own handle.
  const original = fakeCAS.sendAndRecv.bind(fakeCAS);
  fakeCAS.sendAndRecv = async (header: Buffer, payload: Buffer) => {
    if (payload[0] === CASFunctionCode.FETCH) {
      fakeCAS.connectionGeneration += 1;
      throw new Error("fetched from a replaced session");
    }
    return original(header, payload);
  };

  await assertQueryFails(adapter, /replaced session/);

  assert.deepEqual(fakeCAS.closedHandles, []);
});

test("query handle: a transaction that lost its session closes nothing", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS.sentPayloads = [];
  fakeCAS.queueResponse(buildDMLResponse(20, 1));

  const original = fakeCAS.sendAndRecv.bind(fakeCAS);
  fakeCAS.sendAndRecv = async (header: Buffer, payload: Buffer) => {
    fakeCAS.connectionGeneration += 1;
    return original(header, payload);
  };

  await assertQueryFails(adapter, /Connection lost during transaction/, "INSERT INTO t VALUES (2)");

  assert.equal(fakeCAS.discardCalls, 1);
  assert.deepEqual(fakeCAS.closedHandles, []);
});

test("query handle: a failed close does not mask the fetch failure", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));
  fakeCAS.queueResponse(buildErrorResponse(-495, "fetch rejected"));
  fakeCAS.queueResponse(buildSimpleResponse(0)); // END_TRAN of the read transaction
  fakeCAS.queueExchangeFailure(new Error("close failed"));

  await assertQueryFails(adapter, /CUBRID fetch failed/);

  assert.deepEqual(fakeCAS.closedHandles, [QUERY_HANDLE]);
  assert.equal(fakeCAS.isConnected, false);
});

// #214: an autocommit SELECT stays IN_TRAN until its last row, so a FETCH that
// fails partway must end that transaction rather than keep the table lock.
test("autocommit query: a FETCH that fails partway ends the read transaction", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(3));
  fakeCAS.queueResponse(buildErrorResponse(-495, "fetch rejected"));
  fakeCAS.queueResponse(buildSimpleResponse(0)); // END_TRAN

  await assertQueryFails(adapter, /CUBRID fetch failed/);

  assert.deepEqual(sentCodes(fakeCAS), [
    PREPARE_AND_EXECUTE,
    CASFunctionCode.FETCH,
    END_TRAN,
    CLOSE_REQ_HANDLE,
  ]);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
  assert.equal(fakeCAS.isConnected, true);
});

test("autocommit query: a failed END_TRAN after a failed FETCH keeps the FETCH error and drops the session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(3));
  fakeCAS.queueResponse(buildErrorResponse(-495, "fetch rejected"));
  fakeCAS.queueResponse(buildErrorResponse(-1, "end tran rejected"));

  await assertQueryFails(adapter, /CUBRID fetch failed/);

  assert.equal(fakeCAS.discardCalls, 1);
  assert.equal(fakeCAS.isConnected, false);
  assert.deepEqual(fakeCAS.closedHandles, []);
});

test("autocommit query: a malformed FETCH sends no END_TRAN", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));
  fakeCAS.queueResponse(buildTruncatedFetchResponse());

  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i);

  assert.deepEqual(endTranTypes(fakeCAS), []);
  assertSessionDiscarded(fakeCAS);
});

test("transaction query: a failed FETCH leaves the caller's transaction to the caller", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS.sentPayloads = [];
  fakeCAS.queueResponse(buildPartialSelectResponse(3));
  fakeCAS.queueResponse(buildErrorResponse(-495, "fetch rejected"));

  await assertQueryFails(adapter, /CUBRID fetch failed/);

  assert.deepEqual(endTranTypes(fakeCAS), []);
});

test("query handle: a close rejected by the server does not mask the failure", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(Buffer.from(ZONED_FRAMES.oidValue.hex, "hex"));
  fakeCAS.queueResponse(buildErrorResponse(-1006, "invalid handle"));

  await assertQueryFails(adapter, /Unsupported CUBRID CAS value type 19/);

  assert.deepEqual(fakeCAS.closedHandles, [OID_FRAME_HANDLE]);
  assert.equal(fakeCAS.isConnected, true);
});

test("query handle: a successful query survives a failed close", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildPartialSelectResponse(1));
  fakeCAS.queueExchangeFailure(new Error("close failed"));

  const rows = await adapter.query("SELECT id FROM t");

  assert.equal(rows.length, 1);
  assert.deepEqual(fakeCAS.closedHandles, [QUERY_HANDLE]);
});

test("query handle: a malformed backslash probe drops the session instead of closing it", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).noBackslashEscapes = null;
  fakeCAS.queueResponse(buildTruncatedSelectResponse());

  await assertQueryFails(adapter, /Malformed CAS packet|out of range/i, "SELECT ?");

  assertSessionDiscarded(fakeCAS);
});

// ---------------------------------------------------------------------------
// ping()
// ---------------------------------------------------------------------------

test("NativeCubridAdapter ping delegates to CAS.ping", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  let pingCalled = false;
  (fakeCAS as FakeCASConnection & { ping: () => Promise<string> }).ping = async () => {
    pingCalled = true;
    return "11.2.9.0866";
  };

  const version = await adapter.ping();
  assert.equal(version, "11.2.9.0866");
  assert.ok(pingCalled);
});

test("NativeCubridAdapter ping auto-connects if not connected", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;

  (fakeCAS as FakeCASConnection & { ping: () => Promise<string> }).ping = async () => {
    return "11.2";
  };

  const version = await adapter.ping();
  assert.equal(version, "11.2");
  assert.equal(fakeCAS.connectCalls, 1);
});

test("NativeCubridAdapter ping wraps error as ConnectionError", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  (fakeCAS as FakeCASConnection & { ping: () => Promise<string> }).ping = async () => {
    throw new Error("ping failed");
  };

  await assert.rejects(
    () => adapter.ping(),
    (err: Error) => {
      assert.ok(err instanceof ConnectionError);
      assert.match(err.message, /Health check failed/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Read timeout through the public client, over a real socket (#90)
// ---------------------------------------------------------------------------

test("NativeCubridAdapter forwards readTimeout to CAS config", async () => {
  const adapter = new NativeCubridAdapter({ ...DEFAULT_CONFIG, port: 19999, readTimeout: 1500 });
  await adapter.connect().catch(() => {});

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).cas.config.readTimeout, 1500);
});

const CAS_INFO = Buffer.from([0x01, 0x02, 0x03, 0x04]);
const STALL = Symbol("stall");
const INSERT_OK = buildDMLResponse(20, 1);
const CLOSE_OK = buildSimpleResponse(0);

function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeInt32BE(payload.length, 0);
  return Buffer.concat([header, CAS_INFO, payload]);
}

function openDatabaseFrame(): Buffer {
  return frame(Buffer.alloc(16));
}

/** A reply sent `delay` milliseconds after its request arrived. */
interface Delayed {
  delay: number;
  reply: Buffer;
}

/**
 * Stub CAS. `scripts[n]` answers the requests of the nth connection in order;
 * STALL leaves that request unanswered and a missing entry answers success.
 */
async function createScriptedCas(
  scripts: Array<Array<Buffer | typeof STALL | Delayed>>,
): Promise<{ server: Server; port: number; requests: number[] }> {
  const requests: number[] = [];
  const server = createServer((socket: NetSocket) => {
    const connection = requests.push(0) - 1;
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(Buffer.alloc(4));
      socket.once("data", () => {
        socket.write(openDatabaseFrame());
        socket.on("data", () => {
          const index = requests[connection]!;
          requests[connection] = index + 1;
          const reply = scripts[connection]?.[index] ?? CLOSE_OK;
          if (Buffer.isBuffer(reply)) {
            socket.write(frame(reply));
          } else if (reply !== STALL) {
            setTimeout(() => {
              if (!socket.destroyed) socket.write(frame(reply.reply));
            }, reply.delay);
          }
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0, requests };
}

function clientFor(port: number) {
  return createClient({
    host: "127.0.0.1",
    port,
    database: "testdb",
    user: "dba",
    readTimeout: 200,
  });
}

function closeStub(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("client.query rejects with ReadTimeoutError, and the next query reconnects", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([[STALL], [INSERT_OK, CLOSE_OK]]);
  const client = clientFor(port);

  try {
    await assert.rejects(client.query("INSERT INTO t VALUES (1)"), ReadTimeoutError);

    assert.deepEqual(await client.query("INSERT INTO t VALUES (2)"), []);
    assert.deepEqual(requests, [1, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a query queued behind a timeout fails fast, and later queries work", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([
    [INSERT_OK, CLOSE_OK, STALL],
    [INSERT_OK, CLOSE_OK],
  ]);
  const client = clientFor(port);

  try {
    await client.query("INSERT INTO t VALUES (1)");

    const stalled = client.query("INSERT INTO t VALUES (2)");
    const queued = client.query("INSERT INTO t VALUES (3)");

    await assert.rejects(stalled, ReadTimeoutError);
    await assert.rejects(queued, (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match(((error.cause as Error).cause as Error).message, /not connected/);
      return true;
    });

    await client.query("INSERT INTO t VALUES (4)");
    assert.deepEqual(requests, [3, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("client.ping rejects with ReadTimeoutError", { timeout: 5000 }, async () => {
  const { server, port } = await createScriptedCas([[STALL]]);
  const client = clientFor(port);

  try {
    await assert.rejects(client.ping(), ReadTimeoutError);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a timeout inside a transaction loses the session: query and commit fail loudly", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([
    [INSERT_OK, CLOSE_OK, STALL],
    [INSERT_OK, CLOSE_OK],
  ]);
  const client = clientFor(port);

  try {
    await client.beginTransaction();
    await client.query("INSERT INTO t VALUES (1)");
    await assert.rejects(client.query("INSERT INTO t VALUES (2)"), ReadTimeoutError);

    await assert.rejects(client.query("INSERT INTO t VALUES (3)"), (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match(
        ((error.cause as Error).cause as Error).message,
        /Connection lost during transaction/,
      );
      return true;
    });
    await assert.rejects(client.commit(), TransactionError);

    // Nothing reached a new session while the transaction was unresolved.
    assert.deepEqual(requests, [3]);

    // commit() acknowledged the loss, so autocommit work may resume.
    await client.query("INSERT INTO t VALUES (4)");
    assert.deepEqual(requests, [3, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a timeout on the first transaction statement cannot start a new session", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([[STALL]]);
  const client = clientFor(port);

  try {
    await client.beginTransaction();
    await assert.rejects(client.query("INSERT INTO t VALUES (1)"), ReadTimeoutError);

    await assert.rejects(client.query("INSERT INTO t VALUES (2)"), QueryError);
    await assert.rejects(client.commit(), TransactionError);

    assert.deepEqual(requests, [1]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a statement whose handle cleanup times out still fails the commit", {
  timeout: 5000,
}, async () => {
  const { server, port } = await createScriptedCas([[INSERT_OK, STALL]]);
  const client = clientFor(port);

  try {
    await client.beginTransaction();
    await client.query("INSERT INTO t VALUES (1)");

    await assert.rejects(client.commit(), TransactionError);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a timed-out COMMIT reports ReadTimeoutError and is not retried", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([[INSERT_OK, CLOSE_OK, STALL]]);
  const client = clientFor(port);

  try {
    await client.beginTransaction();
    await client.query("INSERT INTO t VALUES (1)");

    await assert.rejects(client.commit(), ReadTimeoutError);

    assert.deepEqual(requests, [3]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("client.transaction surfaces a timeout and still closes", { timeout: 5000 }, async () => {
  const { server, port } = await createScriptedCas([[STALL]]);
  const client = clientFor(port);

  await assert.rejects(
    client.transaction((tx) => tx.query("INSERT INTO t VALUES (1)")),
    ReadTimeoutError,
  );

  await closeStub(server);
});

test("ping after a first-statement timeout cannot give the transaction a new session", {
  timeout: 5000,
}, async () => {
  const version = Buffer.concat([buildSimpleResponse(0), Buffer.from("11.4.0\0")]);
  const checkCasOk = Buffer.alloc(0);
  const { server, port, requests } = await createScriptedCas([[STALL], [checkCasOk, version]]);
  const client = clientFor(port);

  try {
    await client.beginTransaction();
    await assert.rejects(client.query("INSERT INTO t VALUES (1)"), ReadTimeoutError);
    await client.ping();

    await assert.rejects(client.query("INSERT INTO t VALUES (2)"), (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match(
        ((error.cause as Error).cause as Error).message,
        /Connection lost during transaction/,
      );
      return true;
    });
    await assert.rejects(client.commit(), TransactionError);

    // Only the ping's two requests reached the new session: no statement and no COMMIT.
    assert.deepEqual(requests, [1, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

// ---------------------------------------------------------------------------
// A transaction the server rolled back on its own (#184)
// ---------------------------------------------------------------------------

/** A database server error reply; buildErrorResponse() builds a CAS one. */
function buildServerErrorResponse(code: number): Buffer {
  const response = buildErrorResponse(code, "server error");
  response.writeInt32BE(-2, 0);
  return response;
}

/** One insert succeeds, then the server answers the next statement with -72. */
async function beginAndAbort() {
  const created = await beginWithOneInsert();
  created.fakeCAS.queueResponse(buildServerErrorResponse(-72));
  await assert.rejects(created.adapter.query("INSERT INTO t VALUES ('b')"), DeadlockError);
  return created;
}

async function assertLaterStatementIsNotSent(
  adapter: NativeCubridAdapter,
  fakeCAS: FakeCASConnection,
): Promise<void> {
  fakeCAS.sentPayloads = [];

  await assert.rejects(adapter.query("INSERT INTO t VALUES ('c')"), (error: unknown) => {
    assert.ok(error instanceof DeadlockError);
    assert.equal(error.code, -72);
    assert.equal(error.origin, "server");
    assert.equal(error.kind, "deadlock");
    return true;
  });

  assert.deepEqual(fakeCAS.sentPayloads, []);
}

function endTranTypes(fakeCAS: FakeCASConnection): number[] {
  return fakeCAS.sentPayloads
    .filter((payload) => payload[0] === CASFunctionCode.END_TRAN)
    .map((payload) => payload.readUInt8(5));
}

function assertAutocommitResumed(adapter: NativeCubridAdapter): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).autoCommit, true);
}

test("after -72 commit() rejects, because the work that remains is only what follows", async () => {
  const { adapter, fakeCAS } = await beginAndAbort();
  await assertLaterStatementIsNotSent(adapter, fakeCAS);

  await assert.rejects(adapter.commit(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.code, -72);
    assert.equal(error.kind, "deadlock");
    assert.match(((error.cause as Error).cause as Error).message, /server error/);
    return true;
  });

  assert.deepEqual(fakeCAS.sentPayloads, []);
  assert.equal(fakeCAS.connectCalls, 0);
  assert.equal(fakeCAS.discardCalls, 0);
});

test("a statement queued behind -72 is not sent", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  fakeCAS.sentPayloads = [];

  const results = await Promise.allSettled([
    adapter.query("INSERT INTO t VALUES ('b')"),
    adapter.query("INSERT INTO t VALUES ('c')"),
  ]);

  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(fakeCAS.sentPayloads.length, 1);
});

test("rollback() after -72 reaches the healthy session and resumes autocommit there", async () => {
  const { adapter, fakeCAS } = await beginAndAbort();
  await assertLaterStatementIsNotSent(adapter, fakeCAS);

  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.rollback();

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assertAutocommitResumed(adapter);
  fakeCAS.queueResponse(buildSelectResponse([{ name: "id", type: 2 }], [["1"]]));
  assert.deepEqual(await adapter.query("SELECT id FROM t"), [{ id: "1" }]);
  assert.equal(fakeCAS.connectCalls, 0);
  assert.equal(fakeCAS.discardCalls, 0);
});

test("a rejected commit() acknowledges -72, and the same session runs in autocommit", async () => {
  const { adapter, fakeCAS } = await beginAndAbort();
  await assert.rejects(adapter.commit(), TransactionError);

  assertAutocommitResumed(adapter);
  fakeCAS.queueResponse(buildSelectResponse([{ name: "id", type: 2 }], [["1"]]));
  assert.deepEqual(await adapter.query("SELECT id FROM t"), [{ id: "1" }]);
  assert.equal(fakeCAS.connectCalls, 0);
});

test("a rejected rollback() acknowledges -72 too", async () => {
  const { adapter, fakeCAS } = await beginAndAbort();
  await assertLaterStatementIsNotSent(adapter, fakeCAS);

  fakeCAS.queueResponse(buildErrorResponse(-1, "server refused"));
  await assert.rejects(adapter.rollback(), TransactionError);

  assertAutocommitResumed(adapter);
});

test("beginTransaction() cannot hide -72 before it is acknowledged", async () => {
  const { adapter, fakeCAS } = await beginAndAbort();

  await assert.rejects(adapter.beginTransaction(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.code, -72);
    return true;
  });
  await assertLaterStatementIsNotSent(adapter, fakeCAS);

  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.rollback();
  await adapter.beginTransaction();
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query("INSERT INTO t VALUES ('d')");
});

test("beginTransaction() cannot hide -72 that answered the first statement's backslash probe", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).noBackslashEscapes = null;
  await adapter.beginTransaction();
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  await assert.rejects(adapter.query("INSERT INTO t VALUES (?)", ["a\\b"]), DeadlockError);

  await assert.rejects(adapter.beginTransaction(), (error: unknown) => {
    assert.ok(error instanceof TransactionError);
    assert.equal(error.code, -72);
    return true;
  });
  await assertLaterStatementIsNotSent(adapter, fakeCAS);

  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.rollback();
  await adapter.beginTransaction();
});

test("-72 on a FETCH ends the transaction like -72 on the statement", async () => {
  const { adapter, fakeCAS } = await beginWithOneInsert();
  fakeCAS.queueResponse(buildPartialSelectResponse(2));
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  await assert.rejects(adapter.query("SELECT id FROM t"), DeadlockError);

  await assertLaterStatementIsNotSent(adapter, fakeCAS);
});

for (const method of ["commit", "rollback"] as const) {
  test(`-72 answering ${method}() ends the transaction instead of leaving it open`, async () => {
    const { adapter, fakeCAS } = await beginWithOneInsert();
    fakeCAS.queueResponse(buildServerErrorResponse(-72));

    await assert.rejects(adapter[method](), TransactionError);

    assertAutocommitResumed(adapter);
  });
}

test("a closed connection forgets -72, so the next session is not refused", async () => {
  const { adapter, fakeCAS } = await beginAndAbort();
  await assertLaterStatementIsNotSent(adapter, fakeCAS);

  await adapter.close();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).cas = fakeCAS;
  fakeCAS.queueResponse(buildSelectResponse([{ name: "id", type: 2 }], [["1"]]));

  assert.deepEqual(await adapter.query("SELECT id FROM t"), [{ id: "1" }]);
});

test("transaction() rejects when its callback swallows -72, and sends no COMMIT", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  const client = new CubridClient(DEFAULT_CONFIG, () => adapter);
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  await assert.rejects(
    client.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES ('a')").catch(() => undefined);
      await tx.query("INSERT INTO t VALUES ('b')").catch(() => undefined);
    }),
    (error: unknown) => {
      assert.ok(error instanceof TransactionError);
      assert.equal(error.code, -72);
      assert.equal(error.kind, "deadlock");
      return true;
    },
  );

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.equal(
    fakeCAS.sentPayloads.filter((p) => p[0] === CASFunctionCode.PREPARE_AND_EXECUTE).length,
    1,
  );
});

test("only the server's -72 inside a transaction blocks what follows", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  // -72 in autocommit has no transaction to lose, and the same number from
  // the CAS process is a different error.
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  await assert.rejects(adapter.query("INSERT INTO t VALUES (1)"), DeadlockError);
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  await adapter.query("INSERT INTO t VALUES (2)");

  await adapter.beginTransaction();
  fakeCAS.queueResponse(buildErrorResponse(-72, "from the CAS"));
  await assert.rejects(adapter.query("INSERT INTO t VALUES (3)"), QueryError);

  // Live servers keep the transaction open after these lock failures.
  for (const code of [-74, -75, -967, -968]) {
    fakeCAS.queueResponse(buildServerErrorResponse(code));
    await assert.rejects(adapter.query("INSERT INTO t VALUES (4)"), QueryError);
    fakeCAS.queueResponse(buildDMLResponse(20, 1));
    fakeCAS.queueResponse(buildSimpleResponse(0));
    await adapter.query("INSERT INTO t VALUES (5)");
  }

  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  await assert.rejects(adapter.query("INSERT INTO t VALUES (6)"), DeadlockError);
  await assertLaterStatementIsNotSent(adapter, fakeCAS);
});

// ---------------------------------------------------------------------------
// queryResult() — column metadata
// ---------------------------------------------------------------------------

test("NativeCubridAdapter queryResult reports every column, duplicates included", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(
    buildSelectResponse(
      [
        { name: "id", type: 2, precision: 20, notNull: true },
        { name: "id", type: 2, precision: 30, notNull: false },
        { name: "amount", type: 7, precision: 10, scale: 3, notNull: false },
        { name: "mystery", type: 99, precision: 0, notNull: true },
      ],
      [["1", "2", "3", null]],
    ),
  );
  fakeCAS.queueResponse(buildSimpleResponse(0));

  const result = await adapter.queryResult("SELECT a.id, b.id FROM a, b");

  assert.deepEqual(result.columns, [
    { name: "id", type: "VARCHAR", precision: 20, scale: 0, nullable: false },
    { name: "id", type: "VARCHAR", precision: 30, scale: 0, nullable: true },
    { name: "amount", type: "NUMERIC", precision: 10, scale: 3, nullable: true },
    { name: "mystery", type: "UNKNOWN(99)", precision: 0, scale: 0, nullable: false },
  ]);
  // The row keeps the 1.x shape: one key per name, the last column wins.
  assert.equal(result.rows[0]!.id, "2");
});

test("NativeCubridAdapter queryResult keeps the type of a column that holds only NULL", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(
    buildSelectResponse([{ name: "v", type: 8, precision: 10, notNull: false }], [[null]]),
  );
  fakeCAS.queueResponse(buildSimpleResponse(0));

  const result = await adapter.queryResult("SELECT v FROM t");

  assert.deepEqual(result.rows, [{ v: null }]);
  assert.deepEqual(result.columns, [
    { name: "v", type: "INT", precision: 10, scale: 0, nullable: true },
  ]);
});

test("NativeCubridAdapter query still returns the bare row array", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildSelectResponse([{ name: "v", type: 2 }], [["a"], ["b"]]));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  const rows = await adapter.query("SELECT v FROM t");

  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows, [{ v: "a" }, { v: "b" }]);
});

test("NativeCubridAdapter queryResult of a statement without a result set has no columns", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(buildDMLResponse(20, 3));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  assert.deepEqual(await adapter.queryResult("INSERT INTO t VALUES (1)"), {
    rows: [],
    columns: [],
  });
});

// ---------------------------------------------------------------------------
// execute() — affected rows and last insert ID (captured replies)
// ---------------------------------------------------------------------------

const hex = (value: string): Buffer => Buffer.from(value, "hex");
const DML_CAS_INFO = Buffer.alloc(4);

/** Function codes of the requests the fake CAS received, in order. */
function sentCodes(fakeCAS: FakeCASConnection): number[] {
  return fakeCAS.sentPayloads.map((payload) => payload[0] as number);
}

function sentStatement(sql: string, autoCommit: boolean): Buffer {
  return writePrepareAndExecute(sql, autoCommit, DML_CAS_INFO).payload;
}

const GET_LAST_INSERT_ID = CASFunctionCode.GET_LAST_INSERT_ID;
const END_TRAN = CASFunctionCode.END_TRAN;
const PREPARE_AND_EXECUTE = CASFunctionCode.PREPARE_AND_EXECUTE;
const CLOSE_REQ_HANDLE = CASFunctionCode.CLOSE_REQ_HANDLE;
const COMMIT = 1;
const ROLLBACK = 2;

test("execute reports the rows and generated id of an autocommit INSERT", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));

  const result = await adapter.execute(DML_FRAMES.insertOneRow.sql);

  assert.deepEqual(result, { affectedRows: 1, lastInsertId: 1 });
  // The value stays with the session, and a commit lets the CAS go, so the
  // statement is sent without the autocommit flag, asked for the value, and
  // committed afterwards.
  assert.deepEqual(sentCodes(fakeCAS), [
    PREPARE_AND_EXECUTE,
    GET_LAST_INSERT_ID,
    END_TRAN,
    CLOSE_REQ_HANDLE,
  ]);
  assert.deepEqual(fakeCAS.sentPayloads[0], sentStatement(DML_FRAMES.insertOneRow.sql, false));
  assert.equal(fakeCAS.sentPayloads[2]?.[fakeCAS.sentPayloads[2].length - 1], COMMIT);
});

test("execute reports the first generated id of a multi-row INSERT", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertThreeRows.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.firstOfThreeRows));

  assert.deepEqual(await adapter.execute(DML_FRAMES.insertThreeRows.sql), {
    affectedRows: 3,
    lastInsertId: 2,
  });
});

test("execute omits lastInsertId when the INSERT generated no value", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.none));

  const result = await adapter.execute("INSERT INTO no_auto_increment (v) VALUES (10)");

  assert.deepEqual(result, { affectedRows: 1 });
  assert.equal("lastInsertId" in result, false);
});

test("execute reports an UPDATE and a DELETE count without asking for an id", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.updateThreeRows.hex));
  assert.deepEqual(await adapter.execute(DML_FRAMES.updateThreeRows.sql), { affectedRows: 3 });
  fakeCAS.queueResponse(hex(DML_FRAMES.deleteThreeRows.hex));
  assert.deepEqual(await adapter.execute(DML_FRAMES.deleteThreeRows.sql), { affectedRows: 3 });

  assert.equal(sentCodes(fakeCAS).includes(GET_LAST_INSERT_ID), false);
});

test("execute reports 0 rows for an UPDATE that matched nothing and for DDL", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.updateNoMatch.hex));
  assert.deepEqual(await adapter.execute(DML_FRAMES.updateNoMatch.sql), { affectedRows: 0 });
  fakeCAS.queueResponse(hex(DML_FRAMES.createTable.hex));
  assert.deepEqual(await adapter.execute(DML_FRAMES.createTable.sql), { affectedRows: 0 });
});

test("execute adds the rows of every statement of a multi-statement string", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.twoInserts.hex));
  fakeCAS.queueResponse(hex("000000000000000483073300")); // the last INSERT started at 3

  assert.deepEqual(await adapter.execute(DML_FRAMES.twoInserts.sql), {
    affectedRows: 3,
    lastInsertId: 3,
  });
});

test("execute returns a bigint for an id beyond the safe integer range", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  // size 19: type header 0x83 0x07, "9007199254740993" (2^53 + 1) and a NUL
  fakeCAS.queueResponse(hex("00000000000000138307" + "39303037313939323534373430393933" + "00"));

  const result = await adapter.execute(DML_FRAMES.insertOneRow.sql);

  assert.equal(result.lastInsertId, 9007199254740993n);
});

test("execute rolls back an autocommit statement the server rejected", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  // response code -1, error code -493, message "syntax"
  fakeCAS.queueResponse(hex("ffffffff" + "fffffe13" + "73796e74617800"));

  await assert.rejects(() => adapter.execute("INSERT INTO"), QueryError);

  assert.deepEqual(sentCodes(fakeCAS), [PREPARE_AND_EXECUTE, END_TRAN]);
  assert.equal(fakeCAS.sentPayloads[1]?.[fakeCAS.sentPayloads[1].length - 1], ROLLBACK);
});

test("execute inside a transaction leaves committing to the caller", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  await adapter.beginTransaction();
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));

  const result = await adapter.execute(DML_FRAMES.insertOneRow.sql);

  assert.deepEqual(result, { affectedRows: 1, lastInsertId: 1 });
  assert.deepEqual(sentCodes(fakeCAS), [PREPARE_AND_EXECUTE, GET_LAST_INSERT_ID, CLOSE_REQ_HANDLE]);
  assert.deepEqual(fakeCAS.sentPayloads[0], sentStatement(DML_FRAMES.insertOneRow.sql, false));
});

test("execute inside a transaction does not repeat an earlier statement's id", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  await adapter.beginTransaction();
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  assert.equal((await adapter.execute("INSERT INTO t (v) VALUES (1)")).lastInsertId, 1);

  // The server still reports id 1 after an INSERT into a table without
  // AUTO_INCREMENT (verified on CUBRID 10.2 to 11.4).
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  const second = await adapter.execute("INSERT INTO no_auto_increment (v) VALUES (1)");

  assert.deepEqual(second, { affectedRows: 1 });
});

test("query still returns an empty array for DML and sends the autocommit flag", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));

  assert.deepEqual(await adapter.query(DML_FRAMES.insertOneRow.sql), []);
  assert.deepEqual(sentCodes(fakeCAS), [PREPARE_AND_EXECUTE, CLOSE_REQ_HANDLE]);
  assert.deepEqual(fakeCAS.sentPayloads[0], sentStatement(DML_FRAMES.insertOneRow.sql, true));
});

test("execute commits the session that ran the statement when sending replaced a released CAS", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  // The CAS was released: sending the statement opens a new session first.
  fakeCAS.onSendAndRecv = (index) => {
    if (index === 0) {
      fakeCAS.connectionGeneration += 1;
    }
  };
  fakeCAS.queueResponse(hex(DML_FRAMES.updateThreeRows.hex));

  assert.deepEqual(await adapter.execute(DML_FRAMES.updateThreeRows.sql), { affectedRows: 3 });

  assert.deepEqual(sentCodes(fakeCAS), [PREPARE_AND_EXECUTE, END_TRAN, CLOSE_REQ_HANDLE]);
  assert.equal(fakeCAS.sentPayloads[1]?.[fakeCAS.sentPayloads[1].length - 1], COMMIT);
});

test("execute rolls back the session that ran a failed statement after sending replaced a released CAS", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.onSendAndRecv = (index) => {
    if (index === 0) {
      fakeCAS.connectionGeneration += 1;
    }
  };
  fakeCAS.queueResponse(hex("ffffffff" + "fffffe13" + "73796e74617800"));

  await assert.rejects(() => adapter.execute("UPDATE"), QueryError);

  assert.deepEqual(sentCodes(fakeCAS), [PREPARE_AND_EXECUTE, END_TRAN]);
  assert.equal(fakeCAS.sentPayloads[1]?.[fakeCAS.sentPayloads[1].length - 1], ROLLBACK);
});

test("execute fails instead of reporting success when the session is lost before COMMIT", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.onSendAndRecv = (index) => {
    if (index === 1) {
      fakeCAS._isConnected = false; // the session ends while the id is read
    }
  };
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));

  await assert.rejects(
    () => adapter.execute(DML_FRAMES.insertOneRow.sql),
    (error: Error) =>
      error instanceof QueryError && /before the statement was committed/.test(String(error.cause)),
  );
});

test("execute does not report the id of an INSERT run through query() in the same transaction", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  await adapter.beginTransaction();
  // tx.query("INSERT INTO auto ...") generates id 1, which nobody reads.
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  assert.deepEqual(await adapter.query("INSERT INTO auto_increment_table (v) VALUES (1)"), []);

  // The server answers 1 again for the table without AUTO_INCREMENT.
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one)); // the value before the statement
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  const result = await adapter.execute("INSERT INTO plain_table (v) VALUES (1)");

  assert.deepEqual(result, { affectedRows: 1 });
});

test("execute reports the id it generated after a query() INSERT in the same transaction", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  await adapter.beginTransaction();
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  await adapter.query("INSERT INTO auto_increment_table (v) VALUES (1)");

  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.firstOfThreeRows));
  const result = await adapter.execute("INSERT INTO other_auto_increment_table (v) VALUES (1)");

  assert.deepEqual(result, { affectedRows: 1, lastInsertId: 2 });
  // The value is read before the statement only once; the next INSERT knows it.
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.firstOfThreeRows));
  assert.deepEqual(await adapter.execute("INSERT INTO plain_table (v) VALUES (1)"), {
    affectedRows: 1,
  });
});

test("execute reports no id in a transaction when it cannot tell the statement generated one", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  await adapter.beginTransaction();
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  assert.equal((await adapter.execute("INSERT INTO first_table (v) VALUES (1)")).lastInsertId, 1);

  // A second fresh AUTO_INCREMENT table also generates 1 (verified on CUBRID
  // 10.2 and 11.4: the replies are the same bytes as for a table without
  // AUTO_INCREMENT), so the server's answer cannot show whether this INSERT
  // generated it. A wrong id is worse than none.
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  const second = await adapter.execute("INSERT INTO second_table (v) VALUES (1)");

  assert.deepEqual(second, { affectedRows: 1 });
});

test("execute does not report a value that a kept session held from an earlier statement", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  assert.equal((await adapter.execute("INSERT INTO keyed (v) VALUES (1)")).lastInsertId, 1);

  // The same session and the same value: this table generated nothing.
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  const plain = await adapter.execute("INSERT INTO plain_table (v) VALUES (1)");

  assert.deepEqual(plain, { affectedRows: 1 });
});

test("a replaced session starts with no value, so an equal id is new there", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  await adapter.execute("INSERT INTO keyed (v) VALUES (1)");

  fakeCAS.released = true;
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  const result = await adapter.execute("INSERT INTO other_keyed (v) VALUES (1)");

  assert.deepEqual(result, { affectedRows: 1, lastInsertId: 1 });
});

test("execute reads the value first after a statement that may have changed it unseen", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  await adapter.query("INSERT INTO keyed (v) VALUES (1)");
  fakeCAS.sentPayloads.length = 0;

  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  const result = await adapter.execute("INSERT INTO plain_table (v) VALUES (1)");

  assert.deepEqual(result, { affectedRows: 1 });
  assert.equal(sentCodes(fakeCAS)[0], GET_LAST_INSERT_ID);
});

test("execute reads no value before a statement that cannot ask for one", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  await adapter.query("INSERT INTO keyed (v) VALUES (1)");
  fakeCAS.sentPayloads.length = 0;

  fakeCAS.queueResponse(buildDMLResponse(21, 1));
  await adapter.execute("UPDATE keyed SET v = 2");

  assert.equal(sentCodes(fakeCAS).includes(GET_LAST_INSERT_ID), false);
});

test("a failed statement makes execute read the value before its next INSERT", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(buildServerErrorResponse(-670));
  await assert.rejects(adapter.execute("INSERT INTO keyed (v) VALUES (1), (1)"));
  fakeCAS.sentPayloads.length = 0;

  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex(LAST_INSERT_ID_FRAMES.one));
  const result = await adapter.execute("INSERT INTO plain_table (v) VALUES (1)");

  assert.deepEqual(result, { affectedRows: 1 });
});

test("a server abort of the transaction during execute blocks later statements as it does for query", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  await adapter.beginTransaction();

  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  await assert.rejects(adapter.execute("UPDATE t SET v = 1"), DeadlockError);
  await assertLaterStatementIsNotSent(adapter, fakeCAS);
});

test("a malformed baseline reply after a query() INSERT discards the session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  await adapter.beginTransaction();
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  await adapter.query("INSERT INTO auto_increment_table (v) VALUES (1)");

  // The value read before the next execute() has a size of 0, which no broker sends.
  fakeCAS.queueResponse(hex("0000000000000000"));
  await assert.rejects(() => adapter.execute("INSERT INTO t (v) VALUES (1)"), QueryError);

  assert.equal(fakeCAS.discardCalls, 1);
  assert.equal(sentCodes(fakeCAS).includes(PREPARE_AND_EXECUTE), true);
  assert.equal(sentCodes(fakeCAS).filter((c) => c === PREPARE_AND_EXECUTE).length, 1);
});

test("an autocommit execute does not commit after a structurally invalid id reply", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(hex(DML_FRAMES.insertOneRow.hex));
  fakeCAS.queueResponse(hex("0000000000000000")); // size 0

  await assert.rejects(() => adapter.execute(DML_FRAMES.insertOneRow.sql), QueryError);

  assert.equal(
    sentCodes(fakeCAS).includes(END_TRAN) &&
      fakeCAS.sentPayloads.some(
        (payload) => payload[0] === END_TRAN && payload[payload.length - 1] === COMMIT,
      ),
    false,
  );
  assert.equal(fakeCAS.discardCalls, 1);
});

// ---------------------------------------------------------------------------
// BLOB and CLOB content
// ---------------------------------------------------------------------------

const FC_END_TRAN = 1;
const FC_CLOSE_REQ_HANDLE = 6;
const FC_LOB_READ = 37;
const FC_PREPARE_AND_EXECUTE = 41;
const SELECT_LOBS = LOB_FRAMES.selectRows.sql;

/** The captured three-row reply, with row 1's cell sizes replaced when a test needs more. */
function lobSelectReply(blobSize = 3n, clobSize = 2n): Buffer {
  const reply = Buffer.from(LOB_FRAMES.selectRows.hex, "hex");
  reply.writeBigInt64BE(blobSize, reply.indexOf(Buffer.from("00000021", "hex")) + 4);
  reply.writeBigInt64BE(clobSize, reply.indexOf(Buffer.from("00000022", "hex")) + 4);
  return reply;
}

function lobReadReply(content: Buffer): Buffer {
  const count = Buffer.alloc(4);
  count.writeInt32BE(content.length, 0);
  return Buffer.concat([count, content]);
}

function lobAdapter(config: Partial<ClientConfig> = {}) {
  return createAdapterWithFakeCAS({ ...DEFAULT_CONFIG, ...config }, { _protoVersion: 7 });
}

/** The CAS function of every request sent, in order. */
function functionsSent(fakeCAS: FakeCASConnection): number[] {
  return fakeCAS.sentPayloads.map((payload) => payload[0]!);
}

/** Offset and length of every LOB_READ, read from the end of the request. */
function lobReads(fakeCAS: FakeCASConnection): Array<[number, number]> {
  return fakeCAS.sentPayloads
    .filter((payload) => payload[0] === FC_LOB_READ)
    .map((payload) => [
      Number(payload.readBigInt64BE(payload.length - 16)),
      payload.readInt32BE(payload.length - 4),
    ]);
}

/** Queue the replies of a server that sends `content` in replies of its own maximum size. */
function queueLobChunks(fakeCAS: FakeCASConnection, content: Buffer): void {
  for (let offset = 0; offset < content.length; offset += LOB_READ_REPLY_LIMIT) {
    fakeCAS.queueResponse(lobReadReply(content.subarray(offset, offset + LOB_READ_REPLY_LIMIT)));
  }
}

test("LOB: a query returns content, never the locator, and ends the read transaction", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));

  const rows = await adapter.query(SELECT_LOBS);

  assert.deepEqual(rows, [
    { id: 1, b: Buffer.from([1, 2, 3]), c: "hi" },
    { id: 2, b: Buffer.alloc(0), c: "" },
    { id: 3, b: null, c: null },
  ]);
  assert.ok(!inspect(rows, { depth: null }).includes("file:"));
  // Row 2 is empty and row 3 is NULL, so neither asks the server for anything.
  // The handle is released after the reads, which need the query to be open.
  assert.deepEqual(functionsSent(fakeCAS), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_LOB_READ,
    FC_END_TRAN,
    FC_CLOSE_REQ_HANDLE,
  ]);
});

test("LOB: only empty and NULL values need no LOB_READ and no transaction end", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply(0n, 0n));

  const rows = await adapter.query(SELECT_LOBS);

  assert.deepEqual(rows[0], { id: 1, b: Buffer.alloc(0), c: "" });
  assert.deepEqual(functionsSent(fakeCAS), [FC_PREPARE_AND_EXECUTE, FC_CLOSE_REQ_HANDLE]);
});

test("LOB: a BLOB spanning several replies is reassembled from the offsets the server reached", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  const content = Buffer.alloc(200_000);
  for (let i = 0; i < content.length; i++) {
    content[i] = i % 251;
  }
  fakeCAS.queueResponse(lobSelectReply(BigInt(content.length), 0n));
  queueLobChunks(fakeCAS, content);

  const rows = await adapter.query(SELECT_LOBS);

  assert.ok(content.equals(rows[0]!.b as Buffer));
  assert.deepEqual(lobReads(fakeCAS), [
    [0, 131072],
    [81908, 118092],
    [163816, 36184],
  ]);
});

test("LOB: a multibyte character split between two replies stays one character", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  // 81908 is not a multiple of 3, so the first reply ends inside a character.
  const text = "\ud55c".repeat(50_000);
  const content = Buffer.from(text, "utf-8");
  fakeCAS.queueResponse(lobSelectReply(0n, BigInt(content.length)));
  queueLobChunks(fakeCAS, content);

  const rows = await adapter.query(SELECT_LOBS);

  assert.equal(rows[0]!.c, text);
});

test("LOB: a CLOB keeps a leading byte order mark as content", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply(0n, 4n));
  fakeCAS.queueResponse(lobReadReply(Buffer.from("efbbbf41", "hex")));

  const rows = await adapter.query(SELECT_LOBS);

  assert.equal(rows[0]!.c, "\ufeffA");
});

test("LOB: a CLOB that is not UTF-8 rejects instead of being replaced, and the session stays", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply(0n, 2n));
  fakeCAS.queueResponse(lobReadReply(Buffer.from("ffa1", "hex")));

  await assertQueryFails(adapter, /column "c" is not valid UTF-8/, SELECT_LOBS);

  assert.equal(fakeCAS.isConnected, true);
  assert.deepEqual(fakeCAS.closedHandles, [1]);
});

test("LOB: maxLobBytes covers the whole query and refuses it before reading anything", async () => {
  const { adapter, fakeCAS } = lobAdapter({ maxLobBytes: 4 });
  fakeCAS.queueResponse(lobSelectReply());

  await assert.rejects(
    () => adapter.query(SELECT_LOBS),
    (error: Error) => {
      assert.ok(error instanceof QueryError);
      assert.equal((error.cause as Error).name, "UnsupportedValueError");
      assert.match(
        (error.cause as Error).message,
        /column "c" takes this query's LOB content to 5 bytes, over the maxLobBytes limit of 4/,
      );
      return true;
    },
  );

  assert.deepEqual(functionsSent(fakeCAS), [FC_PREPARE_AND_EXECUTE, FC_CLOSE_REQ_HANDLE]);
  assert.equal(fakeCAS.discardCalls, 0);
  assert.equal(fakeCAS.isConnected, true);
});

test("LOB: content of exactly maxLobBytes loads", async () => {
  const { adapter, fakeCAS } = lobAdapter({ maxLobBytes: 5 });
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));

  const rows = await adapter.query(SELECT_LOBS);

  assert.equal(rows[0]!.c, "hi");
});

test("LOB: the default limit is 64 MiB", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply(64n * 1024n * 1024n + 1n, 0n));

  await assertQueryFails(adapter, /over the maxLobBytes limit of 67108864/, SELECT_LOBS);
  assert.deepEqual(lobReads(fakeCAS), []);
});

test("LOB: inside a transaction the read leaves the caller's transaction open", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  await adapter.beginTransaction();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));

  await adapter.query(SELECT_LOBS);

  assert.deepEqual(functionsSent(fakeCAS), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_LOB_READ,
    FC_CLOSE_REQ_HANDLE,
  ]);
});

test("LOB: a statement issued during a read waits for the reads and the handle release", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));
  fakeCAS.queueResponse(buildSimpleResponse(0)); // END_TRAN
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CLOSE_REQ_HANDLE
  fakeCAS.queueResponse(buildDMLResponse(20, 1));

  await Promise.all([adapter.query(SELECT_LOBS), adapter.query("INSERT INTO t VALUES (1)")]);

  assert.deepEqual(functionsSent(fakeCAS).slice(0, 6), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_LOB_READ,
    FC_END_TRAN,
    FC_CLOSE_REQ_HANDLE,
    FC_PREPARE_AND_EXECUTE,
  ]);
});

test("LOB: a file the server no longer has rejects with its error and keeps the session", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.fileNotFoundReply, "hex"));

  await assertQueryFails(adapter, /CUBRID LOB read failed \(-1020\)/, SELECT_LOBS);

  assert.equal(fakeCAS.discardCalls, 0);
  assert.deepEqual(functionsSent(fakeCAS), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_END_TRAN,
    FC_CLOSE_REQ_HANDLE,
  ]);
});

test("LOB: a file shorter than its declared size rejects instead of returning part of it", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply(5n, 0n));
  fakeCAS.queueResponse(lobReadReply(Buffer.from("0102", "hex")));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readAtEndReply, "hex"));

  await assertQueryFails(adapter, /column "b" holds 2 of its declared 5 LOB bytes/, SELECT_LOBS);

  assert.equal(fakeCAS.isConnected, true);
});

test("LOB: a damaged LOB_READ reply drops the session and nothing more is sent on it", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from("00000003" + "0102", "hex"));

  await assertQueryFails(adapter, /LOB read of 3 bytes reported 3 and carried 2/, SELECT_LOBS);

  assertSessionDiscarded(fakeCAS);
  assert.deepEqual(functionsSent(fakeCAS), [FC_PREPARE_AND_EXECUTE, FC_LOB_READ]);
});

test("LOB: a failed exchange during a read sends nothing more", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueExchangeFailure(new Error("Connection closed while reading"));

  await assertQueryFails(adapter, /Connection closed while reading/, SELECT_LOBS);

  assert.deepEqual(functionsSent(fakeCAS), [FC_PREPARE_AND_EXECUTE, FC_LOB_READ]);
});

test("LOB: reads never move to another session", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.sendAndRecvOnSession = async () => null;

  await assertQueryFails(adapter, /CASConnection is not connected/, SELECT_LOBS);

  assert.deepEqual(functionsSent(fakeCAS), [FC_PREPARE_AND_EXECUTE]);
});

/** The captured reply with BLOB column `b` renamed by a SQL alias. */
function lobSelectReplyWithBlobAlias(alias: string): Buffer {
  const reply = lobSelectReply();
  const nameField = reply.indexOf(Buffer.from("000000026200", "hex"));
  const name = Buffer.from(`${alias}\0`, "utf-8");
  const length = Buffer.alloc(4);
  length.writeInt32BE(name.length, 0);
  return Buffer.concat([reply.subarray(0, nameField), length, name, reply.subarray(nameField + 6)]);
}

/** The captured reply with row 1's BLOB cell replaced by a cell holding `locator`. */
function lobSelectReplyWithLocator(size: bigint, locatorLength: number, locator: Buffer): Buffer {
  const reply = lobSelectReply();
  const cell = reply.indexOf(Buffer.from("00000021", "hex"));
  const header = Buffer.alloc(20);
  header.writeInt32BE(16 + locator.length, 0);
  header.writeInt32BE(33, 4);
  header.writeBigInt64BE(size, 8);
  header.writeInt32BE(locatorLength, 16);
  return Buffer.concat([
    reply.subarray(0, cell - 4),
    header,
    locator,
    reply.subarray(cell + 16 + reply.readInt32BE(cell + 12)),
  ]);
}

test("LOB: a column aliased __proto__ loads as an own column, not as the row's prototype", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReplyWithBlobAlias("__proto__"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));

  const rows = await adapter.query(SELECT_LOBS);

  assert.deepEqual(Object.keys(rows[0]!), ["id", "__proto__", "c"]);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(rows[0], "__proto__")?.value,
    Buffer.from([1, 2, 3]),
  );
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
  assert.ok(!inspect(rows, { depth: null, showHidden: true }).includes("file:"));
});

test("LOB: a column aliased __proto__ counts against maxLobBytes", async () => {
  const { adapter, fakeCAS } = lobAdapter({ maxLobBytes: 2 });
  fakeCAS.queueResponse(lobSelectReplyWithBlobAlias("__proto__"));

  await assertQueryFails(
    adapter,
    /column "__proto__" takes this query's LOB content to 3 bytes/,
    SELECT_LOBS,
  );

  assert.deepEqual(lobReads(fakeCAS), []);
});

for (const [name, reply] of [
  ["two bytes", Buffer.from("0000", "hex")],
  ["a server error", buildErrorResponse(-495, "end of transaction refused")],
] as const) {
  test(`LOB: END_TRAN answered with ${name} keeps the rows and drops the session`, async () => {
    const { adapter, fakeCAS } = lobAdapter();
    fakeCAS.queueResponse(lobSelectReply());
    fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
    fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));
    fakeCAS.queueResponse(reply);

    const rows = await adapter.query(SELECT_LOBS);

    assert.equal(rows[0]!.c, "hi");
    assertSessionDiscarded(fakeCAS);
    assert.deepEqual(functionsSent(fakeCAS), [
      FC_PREPARE_AND_EXECUTE,
      FC_LOB_READ,
      FC_LOB_READ,
      FC_END_TRAN,
    ]);
  });
}

for (const [name, reply] of [
  ["an empty locator", () => lobSelectReplyWithLocator(0n, 0, Buffer.alloc(0))],
  ["a locator without its NUL", () => lobSelectReplyWithLocator(3n, 4, Buffer.from("file"))],
] as const) {
  test(`LOB: a cell with ${name} drops the session before any read`, async () => {
    const { adapter, fakeCAS } = lobAdapter();
    fakeCAS.queueResponse(reply());

    await assertQueryFails(adapter, /has no NUL/, SELECT_LOBS);

    assertSessionDiscarded(fakeCAS);
    assert.deepEqual(lobReads(fakeCAS), []);
  });
}

for (const maxLobBytes of [Number.NaN, 0, -1, 1.5]) {
  test(`LOB: the public adapter rejects maxLobBytes ${maxLobBytes}, which skips normalizeConfig`, () => {
    assert.throws(() => new NativeCubridAdapter({ ...DEFAULT_CONFIG, maxLobBytes }), RangeError);
  });
}

test("LOB: queryResult() returns content too, never the locator", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));

  const { rows, columns } = await adapter.queryResult(SELECT_LOBS);

  assert.deepEqual(rows[0], { id: 1, b: Buffer.from([1, 2, 3]), c: "hi" });
  assert.deepEqual(
    columns.map((column) => column.type),
    ["INT", "BLOB", "CLOB"],
  );
  assert.ok(!inspect(rows, { depth: null }).includes("file:"));
});

// ---------------------------------------------------------------------------
// transaction() over a transaction the server rolled back on its own
// ---------------------------------------------------------------------------

/** The adapter is inside no transaction yet; transaction() begins it. */
function transactionOverFakeCAS() {
  const created = createAdapterWithFakeCAS();
  const client = createClient({
    host: DEFAULT_CONFIG.host,
    database: DEFAULT_CONFIG.database,
    user: DEFAULT_CONFIG.user,
    connectionFactory: () => created.adapter,
  });
  return { ...created, client };
}

function rejectsWithAbort(error: unknown): boolean {
  assert.ok(error instanceof TransactionError);
  assert.equal(error.code, -72);
  assert.equal(error.origin, "server");
  assert.equal(error.kind, "deadlock");
  return true;
}

function statementsSent(fakeCAS: FakeCASConnection): number {
  return fakeCAS.sentPayloads.filter(
    (payload) => payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE,
  ).length;
}

const TRANSACTION_STATEMENTS: Array<
  [string, (tx: ResultTransactionClient & ExecutableTransactionClient) => Promise<unknown>]
> = [
  ["query", (tx) => tx.query("INSERT INTO t VALUES ('a')")],
  ["queryResult", (tx) => tx.queryResult("INSERT INTO t VALUES ('a')")],
  ["execute", (tx) => tx.execute("INSERT INTO t VALUES ('a')")],
];

for (const [statement, run] of TRANSACTION_STATEMENTS) {
  test(`transaction() rolls back once when tx.${statement} gets -72 and the callback rethrows`, async () => {
    const { client, fakeCAS } = transactionOverFakeCAS();
    fakeCAS.queueResponse(buildServerErrorResponse(-72));
    fakeCAS.queueResponse(buildSimpleResponse(0));

    await assert.rejects(
      client.transaction((tx) => run(tx)),
      rejectsWithAbort,
    );

    assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
    assert.equal(fakeCAS.connectCalls, 0);
  });

  test(`transaction() rolls back once when the callback swallows -72 from tx.${statement}`, async () => {
    const { client, fakeCAS } = transactionOverFakeCAS();
    fakeCAS.queueResponse(buildServerErrorResponse(-72));
    fakeCAS.queueResponse(buildSimpleResponse(0));

    await assert.rejects(
      client.transaction(async (tx) => {
        await assert.rejects(run(tx), TransactionError);
        return "must not be returned";
      }),
      rejectsWithAbort,
    );

    assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  });
}

test("transaction() sends nothing behind -72 in a Promise.all, then rolls back once", async () => {
  const { client, fakeCAS } = transactionOverFakeCAS();
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  await assert.rejects(
    client.transaction((tx) =>
      Promise.all([
        tx.query("INSERT INTO t VALUES ('a')"),
        tx.execute("INSERT INTO t VALUES ('b')"),
        tx.queryResult("SELECT 1"),
      ]),
    ),
    rejectsWithAbort,
  );

  assert.equal(statementsSent(fakeCAS), 1);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("a manual tx.rollback() after -72 is the only outcome of transaction()", async () => {
  const { client, fakeCAS } = transactionOverFakeCAS();
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  const result = await client.transaction(async (tx) => {
    await assert.rejects(tx.query("INSERT INTO t VALUES ('a')"), TransactionError);
    await tx.rollback();
    await assert.rejects(tx.commit(), TransactionError);
    return "retry later";
  });

  assert.equal(result, "retry later");
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("a manual tx.commit() after -72 rejects and sends no COMMIT", async () => {
  const { client, fakeCAS } = transactionOverFakeCAS();
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  await assert.rejects(
    client.transaction(async (tx) => {
      await assert.rejects(tx.query("INSERT INTO t VALUES ('a')"), TransactionError);
      await tx.commit();
    }),
    rejectsWithAbort,
  );

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("transaction() keeps -72 from the COMMIT reply and still ends with one rollback", async () => {
  const { client, fakeCAS } = transactionOverFakeCAS();
  fakeCAS.queueResponse(buildServerErrorResponse(-72));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  await assert.rejects(
    client.transaction(async () => "lost"),
    rejectsWithAbort,
  );

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT, EndTranType.ROLLBACK]);
});

test("transaction() commits nothing after the session changed under the callback", async () => {
  const { client, fakeCAS } = transactionOverFakeCAS();
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  fakeCAS.queueResponse(buildSimpleResponse(0));
  fakeCAS.queueResponse(buildSimpleResponse(0));

  await assert.rejects(
    client.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES ('a')");
      fakeCAS.connectionGeneration += 1;
      await assert.rejects(tx.execute("INSERT INTO t VALUES ('b')"), TransactionError);
    }),
    (error: unknown) => {
      assert.ok(error instanceof TransactionError);
      assert.equal(error.kind, "connection-lost");
      return true;
    },
  );

  assert.equal(statementsSent(fakeCAS), 1);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

// ---------------------------------------------------------------------------
// Prepared binding lifecycle: one handle per call, released on every path
// ---------------------------------------------------------------------------

const preparedReply = (hex: string): Buffer => Buffer.from(hex, "hex");

/** The captured frames are protocol 7, so the session must be too. */
const createPreparedAdapter = (): ReturnType<typeof createAdapterWithFakeCAS> =>
  createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });

function queuePreparedSelect(fakeCAS: FakeCASConnection): void {
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.executeUntypedInt));
}

test("queryPrepared prepares, executes, commits, then releases its handle", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queuePreparedSelect(fakeCAS);

  assert.deepEqual(await adapter.queryPrepared("SELECT ? AS v", [7]), [{ v: 7 }]);

  assert.deepEqual(sentCodes(fakeCAS), [
    CASFunctionCode.PREPARE,
    CASFunctionCode.EXECUTE,
    CASFunctionCode.END_TRAN,
    CASFunctionCode.CLOSE_REQ_HANDLE,
  ]);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
  assert.deepEqual(fakeCAS.closedHandles, [1]);
});

test("the prepared SQL keeps its markers and carries no bound value", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queuePreparedSelect(fakeCAS);

  await adapter.queryPrepared("SELECT ? AS v", [7]);

  const prepared = fakeCAS.sentPayloads[0]!.toString("latin1");
  assert.ok(prepared.includes("SELECT ? AS v"));
  assert.ok(!prepared.includes("7"));
});

test("query() still sends one PREPARE_AND_EXECUTE and no typed bind", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(buildDMLResponse(20, 1));

  await adapter.query("INSERT INTO t VALUES (?)", [7]);

  assert.equal(sentCodes(fakeCAS)[0], CASFunctionCode.PREPARE_AND_EXECUTE);
  assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.PREPARE));
  assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.EXECUTE));
  assert.ok(fakeCAS.sentPayloads[0]!.toString("latin1").includes("VALUES (7)"));
});

test("a refused value sends nothing and opens no session", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS._isConnected = false;

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [Number.NaN]), QueryError);

  assert.equal(fakeCAS.connectCalls, 0);
  assert.deepEqual(fakeCAS.sentPayloads, []);
});

test("a marker count the server disagrees with is refused before EXECUTE", async () => {
  for (const params of [[], [1, 2]]) {
    const { adapter, fakeCAS } = createPreparedAdapter();
    fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));

    await assert.rejects(adapter.queryPrepared("SELECT ? AS v", params), (error: QueryError) => {
      assert.match((error.cause as Error).message, /Parameter count mismatch/);
      return true;
    });

    assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.EXECUTE));
    assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
    assert.deepEqual(fakeCAS.closedHandles, [1]);
  }
});

test("a failed PREPARE ends the transaction it left open and has no handle to release", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareSyntaxError));

  await assert.rejects(adapter.queryPrepared("SELEC 1"), (error: QueryError) => {
    assert.equal(error.code, -493);
    return true;
  });

  assert.deepEqual(sentCodes(fakeCAS), [CASFunctionCode.PREPARE, CASFunctionCode.END_TRAN]);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.deepEqual(fakeCAS.closedHandles, []);
});

test("a server error at EXECUTE rolls back and releases the handle", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.executeCoercionError));

  await assert.rejects(adapter.executePrepared("SELECT ? AS v", ["abc"]), QueryError);

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.deepEqual(fakeCAS.closedHandles, [1]);
});

test("a malformed EXECUTE reply drops the session and sends nothing more on it", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueResponse(Buffer.from("0000000100", "hex"));

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), QueryError);

  assert.equal(fakeCAS.discardCalls, 1);
  assert.deepEqual(sentCodes(fakeCAS), [CASFunctionCode.PREPARE, CASFunctionCode.EXECUTE]);
});

test("EXECUTE is not sent when the session changed after PREPARE replied", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  const sendOnSession = fakeCAS.sendAndRecvOnSession.bind(fakeCAS);
  fakeCAS.sendAndRecvOnSession = async (generation, header, payload) => {
    fakeCAS.connectionGeneration += 1;
    return sendOnSession(generation, header, payload);
  };

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), (error: QueryError) => {
    assert.equal(error.kind, "connection-lost");
    return true;
  });

  assert.deepEqual(sentCodes(fakeCAS), [CASFunctionCode.PREPARE]);
});

test("a lost connection at EXECUTE sends nothing more and leaves no handle to reuse", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueExchangeFailure(new Error("socket closed"));

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), QueryError);

  assert.deepEqual(sentCodes(fakeCAS), [CASFunctionCode.PREPARE, CASFunctionCode.EXECUTE]);
});

test("a read timeout at EXECUTE stays a ReadTimeoutError and sends nothing more", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueExchangeFailure(new ReadTimeoutError(1000));

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), ReadTimeoutError);

  assert.deepEqual(sentCodes(fakeCAS), [CASFunctionCode.PREPARE, CASFunctionCode.EXECUTE]);
});

test("a prepared statement in a transaction leaves ending it to the caller", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  await adapter.beginTransaction();
  queuePreparedSelect(fakeCAS);

  await adapter.queryPrepared("SELECT ? AS v", [7]);

  assert.deepEqual(sentCodes(fakeCAS), [
    CASFunctionCode.PREPARE,
    CASFunctionCode.EXECUTE,
    CASFunctionCode.CLOSE_REQ_HANDLE,
  ]);
});

test("a prepared statement refuses to run after its transaction's session changed", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  await adapter.beginTransaction();
  queuePreparedSelect(fakeCAS);
  await adapter.queryPrepared("SELECT ? AS v", [7]);
  fakeCAS.connectionGeneration += 1;
  const sent = fakeCAS.sentPayloads.length;

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), QueryError);

  assert.equal(fakeCAS.sentPayloads.length, sent);
});

test("a server rollback at EXECUTE blocks the statements after it", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  await adapter.beginTransaction();
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  const message = Buffer.from("deadlock\0");
  const abort = Buffer.alloc(8);
  abort.writeInt32BE(-2, 0);
  abort.writeInt32BE(-72, 4);
  fakeCAS.queueResponse(Buffer.concat([abort, message]));

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), DeadlockError);
  const sent = fakeCAS.sentPayloads.length;

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), DeadlockError);
  assert.equal(fakeCAS.sentPayloads.length, sent);
});

test("a FETCH of a prepared handle never reaches a replaced session", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const twoRows = PREPARED_FRAMES.executeUntypedInt.replace(/^00000001/, "00000002");
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueResponse(preparedReply(twoRows));
  const sendOnSession = fakeCAS.sendAndRecvOnSession.bind(fakeCAS);
  fakeCAS.sendAndRecvOnSession = async (generation, header, payload) => {
    if (payload[0] === CASFunctionCode.FETCH) {
      fakeCAS.connectionGeneration += 1;
    }
    return sendOnSession(generation, header, payload);
  };

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), QueryError);

  assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.FETCH));
});

// #214: the prepared path already rolls back its own transaction, so a failed
// FETCH must not also send the read-transaction COMMIT.
test("queryPrepared: a FETCH that fails partway is rolled back once, never committed", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const twoRows = PREPARED_FRAMES.executeUntypedInt.replace(/^00000001/, "00000002");
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueResponse(preparedReply(twoRows));
  fakeCAS.queueResponse(buildErrorResponse(-495, "fetch rejected"));
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CLOSE_REQ_HANDLE
  fakeCAS.queueResponse(buildSimpleResponse(0)); // END_TRAN ROLLBACK

  await assert.rejects(adapter.queryPrepared("SELECT ? AS v", [7]), QueryError);

  assert.ok(sentCodes(fakeCAS).includes(CASFunctionCode.FETCH));
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("executePrepared reports affected rows from the EXECUTE reply", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const update = "00000002000000000116000000020000000000000000000000000000000000fffffffe";
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
  fakeCAS.queueResponse(preparedReply(update));

  assert.deepEqual(await adapter.executePrepared("UPDATE t SET a = ?", [7]), { affectedRows: 2 });
});

// ---------------------------------------------------------------------------
// Prepared binding: what happens before the first request, and LOB content
// ---------------------------------------------------------------------------

/**
 * The captured three-row LOB SELECT split where a PREPARE_AND_EXECUTE reply turns
 * into its execute part: the tuple count 3, cache_reusable 0, one result, SELECT.
 */
function preparedLobReplies(blobSize?: bigint, clobSize?: bigint): [Buffer, Buffer] {
  const reply = lobSelectReply(blobSize, clobSize);
  const split = reply.indexOf(Buffer.from("00000003" + "00" + "00000001" + "15", "hex"));
  assert.ok(split > 0);
  return [reply.subarray(0, split), reply.subarray(split)];
}

test("prepared LOB content is committed once, by the statement, after it is read", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  for (const reply of preparedLobReplies()) {
    fakeCAS.queueResponse(reply);
  }
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readClobReply, "hex"));

  const rows = await adapter.queryPrepared(SELECT_LOBS);

  assert.deepEqual(rows[0]?.b, Buffer.from([1, 2, 3]));
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
  assert.deepEqual(fakeCAS.closedHandles, [1]);
});

test("a prepared LOB read that fails commits nothing and rolls the statement back", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  for (const reply of preparedLobReplies()) {
    fakeCAS.queueResponse(reply);
  }
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  // The CLOB read fails with a server error, after a statement of the same
  // call may already have written.
  const failure = Buffer.alloc(8);
  failure.writeInt32BE(-2, 0);
  failure.writeInt32BE(-1001, 4);
  fakeCAS.queueResponse(Buffer.concat([failure, Buffer.from("failed\0")]));

  await assert.rejects(adapter.queryPrepared(SELECT_LOBS), QueryError);

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.deepEqual(fakeCAS.closedHandles, [1]);
});

test("query() still ends its own LOB read transaction when a read fails", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobSelectReply());
  fakeCAS.queueResponse(Buffer.from(LOB_FRAMES.readBlobReply, "hex"));
  const failure = Buffer.alloc(8);
  failure.writeInt32BE(-2, 0);
  failure.writeInt32BE(-1001, 4);
  fakeCAS.queueResponse(Buffer.concat([failure, Buffer.from("failed\0")]));

  await assert.rejects(adapter.query(SELECT_LOBS), QueryError);

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
});

test("a refused value sends nothing even when execute() would first read the insert id", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  // An INSERT through query() leaves the session's insert id unknown, so the
  // next execute() of an INSERT reads it before sending the statement.
  fakeCAS.queueResponse(buildDMLResponse(20, 1));
  await adapter.query("INSERT INTO t VALUES (1)");
  const sent = fakeCAS.sentPayloads.length;

  await assert.rejects(
    adapter.executePrepared("INSERT INTO t VALUES (?)", [Number.NaN]),
    (error: QueryError) => /NaN and Infinity/.test((error.cause as Error).message),
  );

  assert.equal(fakeCAS.sentPayloads.length, sent);
});

test("SQL with a NUL is refused before a session is opened", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS._isConnected = false;

  for (const run of [
    () => adapter.queryPrepared("SELECT 1\0; DELETE FROM t"),
    () => adapter.executePrepared("INSERT INTO t VALUES (1)\0", []),
  ]) {
    await assert.rejects(run(), (error: QueryError) =>
      /null byte/.test((error.cause as Error).message),
    );
  }

  assert.equal(fakeCAS.connectCalls, 0);
  assert.deepEqual(fakeCAS.sentPayloads, []);
});

test("the values bound are the ones passed when the method was called", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queuePreparedSelect(fakeCAS);
  const params: QueryParam[] = [7];
  // The statement only runs in a later turn, after this change to the array.
  const prepared = adapter.queryPrepared("SELECT ? AS v", params);
  params[0] = Number.NaN;

  assert.deepEqual(await prepared, [{ v: 7 }]);

  const execute = fakeCAS.sentPayloads.find((payload) => payload[0] === CASFunctionCode.EXECUTE);
  assert.ok(execute);
  assert.equal(
    execute.subarray(execute.length - 13).toString("hex"),
    "0000000108" + "00000004" + "00000007",
  );
});

test("a truncated EXECUTE reply in autocommit drops the session and never commits", async () => {
  // An UPDATE of two rows, cut off after its result record and after its column info flag.
  const update = "00000002000000000116000000020000000000000000000000000000000000fffffffe";
  for (const cut of [update.length - 10, update.length - 8]) {
    const { adapter, fakeCAS } = createPreparedAdapter();
    fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareUntypedMarker));
    fakeCAS.queueResponse(preparedReply(update.slice(0, cut)));

    await assert.rejects(adapter.executePrepared("UPDATE t SET a = ?", [7]), QueryError);

    assert.equal(fakeCAS.discardCalls, 1);
    assert.deepEqual(endTranTypes(fakeCAS), []);
  }
});

test("a truncated literal EXECUTE reply drops the session and never commits", async () => {
  // An UPDATE of two rows, cut off before its shard id and before its column info flag too.
  const update = buildDMLResponse(21, 2);
  for (const run of [
    (adapter: NativeCubridAdapter) => adapter.query("UPDATE t SET a = 1"),
    (adapter: NativeCubridAdapter) => adapter.execute("UPDATE t SET a = 1"),
  ]) {
    for (const cut of [update.length - 4, update.length - 5]) {
      const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
      fakeCAS.queueResponse(update.subarray(0, cut));

      await assert.rejects(run(adapter), QueryError);

      assert.equal(fakeCAS.discardCalls, 1);
      assert.deepEqual(endTranTypes(fakeCAS), []);
    }
  }
});

// ---------------------------------------------------------------------------
// Isolation level and lock timeout options
// ---------------------------------------------------------------------------

/** The parameters the adapter hands its next session. */
function sessionParameters(adapter: NativeCubridAdapter): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (adapter as any).getOrCreateCAS().sessionParameters;
}

test("the adapter sends no session parameters unless a setting was given", () => {
  assert.deepEqual(sessionParameters(new NativeCubridAdapter(DEFAULT_CONFIG)), []);
});

for (const [isolationLevel, code] of [
  ["read committed", 4],
  ["repeatable read", 5],
  ["serializable", 6],
] as const) {
  test(`the adapter maps ${isolationLevel} to server level ${code}`, () => {
    const adapter = new NativeCubridAdapter({ ...DEFAULT_CONFIG, isolationLevel });
    assert.deepEqual(sessionParameters(adapter), [{ parameter: 1, value: code }]);
  });
}

test("the adapter sends lockTimeout in milliseconds, keeping 0 and -1", () => {
  for (const lockTimeout of [-1, 0, 1500]) {
    const adapter = new NativeCubridAdapter({ ...DEFAULT_CONFIG, lockTimeout });
    assert.deepEqual(sessionParameters(adapter), [{ parameter: 2, value: lockTimeout }]);
  }
});

test("the adapter refuses invalid settings, because it is public and skips createClient()", async () => {
  assert.throws(
    () =>
      new NativeCubridAdapter({
        ...DEFAULT_CONFIG,
        isolationLevel: "snapshot" as "serializable",
      }),
    RangeError,
  );
  assert.throws(() => new NativeCubridAdapter({ ...DEFAULT_CONFIG, lockTimeout: -2 }), RangeError);
  await assert.rejects(
    new NativeCubridAdapter(DEFAULT_CONFIG).setTransactionOptions({ lockTimeout: 0.5 }),
    RangeError,
  );
});

test("setTransactionOptions keeps what it is not given", async () => {
  const adapter = new NativeCubridAdapter({ ...DEFAULT_CONFIG, lockTimeout: 2000 });

  await adapter.setTransactionOptions({ isolationLevel: "serializable" });

  assert.deepEqual(sessionParameters(adapter), [
    { parameter: 1, value: 6 },
    { parameter: 2, value: 2000 },
  ]);
});

test("setTransactionOptions is refused inside a transaction and changes nothing", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, {
    setSessionParameters: async () => {
      throw new Error("must not be sent");
    },
  } as Partial<FakeCASConnection>);

  await adapter.beginTransaction();
  await assert.rejects(
    adapter.setTransactionOptions({ isolationLevel: "serializable" }),
    /inside a transaction/,
  );

  assert.equal(fakeCAS.sendAndRecvCalls, 0);
});

test("settings given after construction end with close(), so a reused adapter cannot inherit them", async () => {
  const adapter = new NativeCubridAdapter({ ...DEFAULT_CONFIG, lockTimeout: 2000 });

  await adapter.setTransactionOptions({ isolationLevel: "serializable", lockTimeout: 0 });
  await adapter.close();

  assert.deepEqual(sessionParameters(adapter), [{ parameter: 2, value: 2000 }]);
});

/**
 * A broker that answers each SET_DB_PARAMETER after `delayMs`, with an error
 * when `refuse` is set. Everything else gets an empty success reply.
 * `settingsSent` resolves when the first SET_DB_PARAMETER arrives, which is the
 * moment the transport is open but the session is not ready yet.
 */
async function slowSettingsBroker(
  refuse: boolean,
  delayMs: number,
  events: string[],
): Promise<{ server: Server; port: number; sessions: () => number; settingsSent: Promise<void> }> {
  let sessions = 0;
  let markSent = (): void => {};
  const settingsSent = new Promise<void>((resolve) => {
    markSent = resolve;
  });
  const frame = (body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeInt32BE(body.length - 4, 0);
    return Buffer.concat([length, body]);
  };
  const casInfo = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  const ok = Buffer.alloc(4);
  const refused = Buffer.from("ffffffff0000232700", "hex");

  const server = createServer((socket: NetSocket) => {
    socket.on("error", () => {});
    const session = ++sessions;
    let buffered = Buffer.alloc(0);
    let stage: "client-info" | "open" | "requests" = "client-info";

    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (stage === "client-info") {
          if (buffered.length < 10) return;
          buffered = buffered.subarray(10);
          socket.write(Buffer.alloc(4));
          stage = "open";
        } else if (stage === "open") {
          if (buffered.length < 628) return;
          buffered = buffered.subarray(628);
          const brokerInfo = Buffer.alloc(8);
          brokerInfo[4] = 7;
          const sessionId = Buffer.alloc(4);
          sessionId.writeInt32BE(session, 0);
          socket.write(frame(Buffer.concat([casInfo, ok, brokerInfo, sessionId])));
          stage = "requests";
        } else {
          if (buffered.length < 8) return;
          const size = 8 + buffered.readInt32BE(0);
          if (buffered.length < size) return;
          const code = buffered[8];
          buffered = buffered.subarray(size);
          if (code === CASFunctionCode.SET_DB_PARAMETER) {
            markSent();
            setTimeout(() => {
              events.push(`session ${session}: settings ${refuse ? "refused" : "applied"}`);
              socket.write(frame(Buffer.concat([casInfo, refuse ? refused : ok])));
            }, delayMs);
          } else {
            socket.write(frame(Buffer.concat([casInfo, ok])));
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, port, sessions: () => sessions, settingsSent };
}

test("beginTransaction does not report success while a new session's settings may still fail", async () => {
  const events: string[] = [];
  const { server, port, sessions, settingsSent } = await slowSettingsBroker(true, 50, events);
  const adapter = new NativeCubridAdapter({
    ...DEFAULT_CONFIG,
    port,
    isolationLevel: "serializable",
    readTimeout: 2000,
  });

  try {
    const connecting = adapter.connect();
    await settingsSent;
    const beginning = adapter.beginTransaction();

    await assert.rejects(connecting, ConnectionError);
    // The begin waits for a session of its own, whose settings are refused too.
    await assert.rejects(beginning, TransactionError);
    assert.equal(sessions(), 2);
  } finally {
    await adapter.close();
    server.close();
  }
});

test("beginTransaction resolves only once a new session's settings hold", async () => {
  const events: string[] = [];
  const { server, port, sessions, settingsSent } = await slowSettingsBroker(false, 50, events);
  const adapter = new NativeCubridAdapter({
    ...DEFAULT_CONFIG,
    port,
    isolationLevel: "serializable",
    readTimeout: 2000,
  });

  try {
    const connecting = adapter.connect();
    await settingsSent;
    await adapter.beginTransaction();
    events.push("begin resolved");
    await connecting;

    assert.deepEqual(events, ["session 1: settings applied", "begin resolved"]);
    assert.equal(sessions(), 1);
  } finally {
    await adapter.rollback().catch(() => {});
    await adapter.close();
    server.close();
  }
});

// ---------------------------------------------------------------------------
// stream(): LOB content is read row by row
// ---------------------------------------------------------------------------

/** Replaces the sizes of the two LOB cells of rows 1 and 2 of the captured reply. */
function lobReplyWithSizes(row1: [bigint, bigint], row2: [bigint, bigint]): Buffer {
  const reply = lobSelectReply(row1[0], row1[1]);
  const second = (typeCode: string): number =>
    reply.indexOf(Buffer.from(typeCode, "hex"), reply.indexOf(Buffer.from(typeCode, "hex")) + 8) +
    4;
  reply.writeBigInt64BE(row2[0], second("00000021"));
  reply.writeBigInt64BE(row2[1], second("00000022"));
  return reply;
}

test("stream LOB: content is read when its row is reached, and END_TRAN waits for the end", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobReplyWithSizes([1n, 0n], [1n, 0n]));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([7])));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([8])));

  const rows = adapter.stream(SELECT_LOBS);
  const first = await rows.next();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(first.value, { id: 1, b: Buffer.from([7]), c: "" });
  assert.deepEqual(lobReads(fakeCAS), [[0, 1]]);

  assert.deepEqual((await rows.next()).value, { id: 2, b: Buffer.from([8]), c: "" });
  assert.deepEqual((await rows.next()).value, { id: 3, b: null, c: null });
  assert.equal((await rows.next()).done, true);

  assert.deepEqual(functionsSent(fakeCAS), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_LOB_READ,
    FC_END_TRAN,
    FC_CLOSE_REQ_HANDLE,
  ]);
});

test("stream LOB: maxLobBytes limits each row, so a result over it in total still streams", async () => {
  const { adapter, fakeCAS } = lobAdapter({ maxLobBytes: 2 });
  fakeCAS.queueResponse(lobReplyWithSizes([2n, 0n], [2n, 0n]));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([1, 2])));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([3, 4])));

  const blobs: unknown[] = [];
  for await (const row of adapter.stream(SELECT_LOBS)) {
    blobs.push(row.b);
  }

  assert.deepEqual(blobs, [Buffer.from([1, 2]), Buffer.from([3, 4]), null]);
});

test("stream LOB: a row over maxLobBytes fails at that row and keeps the connection", async () => {
  const { adapter, fakeCAS } = lobAdapter({ maxLobBytes: 2 });
  fakeCAS.queueResponse(lobReplyWithSizes([2n, 0n], [2n, 1n]));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([1, 2])));

  const rows = adapter.stream(SELECT_LOBS);
  await rows.next();

  await assert.rejects(
    () => rows.next(),
    (error: Error) => {
      assert.ok(error instanceof QueryError);
      assert.equal((error.cause as Error).name, "UnsupportedValueError");
      assert.match(
        (error.cause as Error).message,
        /column "c" takes this row's LOB content to 3 bytes, over the maxLobBytes limit of 2/,
      );
      return true;
    },
  );

  assert.deepEqual(lobReads(fakeCAS), [[0, 2]]);
  assert.deepEqual(fakeCAS.closedHandles, [1]);
  assert.equal(fakeCAS.discardCalls, 0);
  assert.equal(functionsSent(fakeCAS).filter((code) => code === FC_END_TRAN).length, 1);
});

test("stream LOB: the last row releases the turn before the consumer reads it", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobReplyWithSizes([0n, 0n], [0n, 0n]));

  const rows = adapter.stream(SELECT_LOBS, undefined, { consumerTimeout: 0 });
  await rows.next();
  await rows.next();
  assert.deepEqual((await rows.next()).value, { id: 3, b: null, c: null });
  // Lets the handle's release take its reply before the next statement's is queued.
  await new Promise((resolve) => setTimeout(resolve, 10));

  fakeCAS.queueResponse(lobReplyWithSizes([0n, 0n], [0n, 0n]));
  assert.equal((await adapter.query(SELECT_LOBS)).length, 3);
  assert.equal((await rows.next()).done, true);
});

test("stream LOB: a break after a read still ends the read transaction", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobReplyWithSizes([1n, 0n], [1n, 0n]));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([7])));

  for await (const row of adapter.stream(SELECT_LOBS)) {
    assert.ok(row);
    break;
  }

  assert.deepEqual(functionsSent(fakeCAS), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_END_TRAN,
    FC_CLOSE_REQ_HANDLE,
  ]);
});

test("stream LOB: only empty and NULL content ends no transaction", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobReplyWithSizes([0n, 0n], [0n, 0n]));

  for await (const row of adapter.stream(SELECT_LOBS)) {
    assert.ok(row);
  }

  assert.deepEqual(functionsSent(fakeCAS), [FC_PREPARE_AND_EXECUTE, FC_CLOSE_REQ_HANDLE]);
});

test("stream LOB: reads inside a transaction send no END_TRAN", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  await adapter.beginTransaction();
  fakeCAS.queueResponse(lobReplyWithSizes([1n, 0n], [1n, 0n]));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([7])));
  fakeCAS.queueResponse(lobReadReply(Buffer.from([8])));

  for await (const row of adapter.stream(SELECT_LOBS)) {
    assert.ok(row);
  }

  assert.equal(functionsSent(fakeCAS).includes(FC_END_TRAN), false);
});

test("stream LOB: a malformed LOB_READ reply retires the session and nothing follows it", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobReplyWithSizes([4n, 0n], [1n, 0n]));
  fakeCAS.queueResponse(Buffer.from("0000000501", "hex"));

  await assert.rejects(() => adapter.stream(SELECT_LOBS).next(), QueryError);

  assert.equal(fakeCAS.discardCalls, 1);
  assert.deepEqual(functionsSent(fakeCAS), [FC_PREPARE_AND_EXECUTE, FC_LOB_READ]);
});

test("stream LOB: a failed read in the last window still ends the read transaction", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  fakeCAS.queueResponse(lobReplyWithSizes([1n, 0n], [0n, 0n]));
  fakeCAS.queueResponse(buildServerErrorResponse(-493));

  await assert.rejects(() => adapter.stream(SELECT_LOBS).next(), QueryError);
  assert.deepEqual(functionsSent(fakeCAS), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_END_TRAN,
    FC_CLOSE_REQ_HANDLE,
  ]);
});

test("stream LOB: abort after a partial reply stops subsequent reads and cleans up", async () => {
  const { adapter, fakeCAS } = lobAdapter();
  const controller = new AbortController();
  fakeCAS.queueResponse(lobSelectReply(200_000n, 0n));
  fakeCAS.queueResponse(lobReadReply(Buffer.alloc(81_908)));
  fakeCAS.onSendAndRecv = () => {
    if (!controller.signal.aborted && fakeCAS.sentPayloads.at(-1)?.[0] === FC_LOB_READ) {
      controller.abort(new Error("stop streamed LOB"));
    }
  };

  await assert.rejects(
    () => adapter.stream(SELECT_LOBS, undefined, { signal: controller.signal }).next(),
    /stop streamed LOB/,
  );
  assert.deepEqual(lobReads(fakeCAS), [[0, 131072]]);
  assert.deepEqual(functionsSent(fakeCAS), [
    FC_PREPARE_AND_EXECUTE,
    FC_LOB_READ,
    FC_END_TRAN,
    FC_CLOSE_REQ_HANDLE,
  ]);
});

test("stream: the adapter checks its options and fetchSize config like the client", () => {
  assert.throws(() => new NativeCubridAdapter({ ...DEFAULT_CONFIG, fetchSize: 0 }), RangeError);
  const { adapter } = createAdapterWithFakeCAS();
  assert.throws(() => adapter.stream("SELECT 1", undefined, { fetchSize: 0 }), RangeError);
  assert.throws(() => adapter.stream("SELECT 1", undefined, { consumerTimeout: -1 }), RangeError);
});

// ---------------------------------------------------------------------------
// Per-query options: AbortSignal and readTimeout (#150)
// ---------------------------------------------------------------------------

const ADAPTER_METHODS = [
  "query",
  "queryResult",
  "execute",
  "queryPrepared",
  "queryResultPrepared",
  "executePrepared",
] as const;

function callAdapter(
  adapter: NativeCubridAdapter,
  method: (typeof ADAPTER_METHODS)[number],
  sql: string,
  options: unknown,
): Promise<unknown> {
  return (
    adapter as unknown as Record<
      (typeof ADAPTER_METHODS)[number],
      (sql: string, params: unknown[], options: unknown) => Promise<unknown>
    >
  )[method](sql, [], options);
}

/** A client with no readTimeout of its own, unless one is given. */
function optionsClient(port: number, readTimeout?: number) {
  return createClient({
    host: "127.0.0.1",
    port,
    database: "testdb",
    user: "dba",
    ...(readTimeout !== undefined && { readTimeout }),
  });
}

function abortAfter(ms: number, reason: unknown): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(reason), ms);
  return controller.signal;
}

function selectReply(value: string): Buffer {
  return buildSelectResponse([{ name: "v", type: 2 }], [[value]]);
}

function sentSql(fakeCAS: FakeCASConnection): string[] {
  return fakeCAS.sentPayloads
    .filter((payload) => payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE)
    .map((payload) => payload.toString("latin1"));
}

test("an already aborted signal sends nothing and opens no session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS._isConnected = false;
  const reason = new Error("cancelled before it started");
  const controller = new AbortController();
  controller.abort(reason);

  for (const method of ADAPTER_METHODS) {
    await assert.rejects(
      callAdapter(adapter, method, "SELECT 1", { signal: controller.signal }),
      (error) => error === reason,
    );
  }

  assert.equal(fakeCAS.sendAndRecvCalls, 0);
  assert.equal(fakeCAS.connectCalls, 0);
});

test("the adapter refuses invalid query options at once and sends nothing", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  for (const method of ADAPTER_METHODS) {
    await assert.rejects(callAdapter(adapter, method, "SELECT 1", { readTimeout: -1 }), RangeError);
    await assert.rejects(callAdapter(adapter, method, "SELECT 1", { signal: {} }), TypeError);
  }

  assert.equal(fakeCAS.sendAndRecvCalls, 0);
});

test("an abort while queued removes the statement: nothing is sent and the session stays", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();
  fakeCAS.queueResponse(INSERT_OK);
  fakeCAS.queueResponse(CLOSE_OK);
  fakeCAS.queueResponse(INSERT_OK);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = fakeCAS.sendAndRecv.bind(fakeCAS);
  let first = true;
  fakeCAS.sendAndRecv = async (header: Buffer, payload: Buffer) => {
    if (first) {
      first = false;
      await gate;
    }
    return send(header, payload);
  };

  const running = adapter.query("INSERT INTO t VALUES (1)");
  const controller = new AbortController();
  const reason = new Error("not needed any more");
  const queued = adapter.query("INSERT INTO t VALUES (2)", [], { signal: controller.signal });
  const behind = adapter.query("INSERT INTO t VALUES (3)");
  await new Promise((resolve) => setImmediate(resolve));

  controller.abort(reason);
  await assert.rejects(queued, (error) => error === reason);

  release();
  await running;
  await behind;

  const sent = sentSql(fakeCAS);
  assert.equal(sent.length, 2);
  assert.ok(sent[0]?.includes("VALUES (1)"));
  assert.ok(sent[1]?.includes("VALUES (3)"));
  assert.equal(fakeCAS.discardCalls, 0);
  assert.equal(fakeCAS.isConnected, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an abort in flight rejects at once with its reason, retires the socket and is not replayed", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([[STALL], [INSERT_OK, CLOSE_OK]]);
  const client = optionsClient(port);
  const reason = new Error("stopped by the caller");

  try {
    const started = Date.now();
    await assert.rejects(
      client.query("INSERT INTO t VALUES (1)", [], { signal: abortAfter(50, reason) }),
      (error) => error === reason,
    );
    assert.ok(Date.now() - started < 1000);

    assert.deepEqual(await client.query("INSERT INTO t VALUES (2)"), []);
    assert.deepEqual(requests, [1, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a late reply to an aborted statement never answers the next one", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([
    [{ delay: 150, reply: selectReply("late") }],
    [selectReply("fresh"), CLOSE_OK, selectReply("fresh")],
  ]);
  const client = optionsClient(port);
  const reason = new Error("stopped by the caller");

  try {
    await assert.rejects(
      client.query("SELECT v FROM t", [], { signal: abortAfter(30, reason) }),
      (error) => error === reason,
    );

    assert.deepEqual(await client.query("SELECT v FROM t"), [{ v: "fresh" }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await client.query("SELECT v FROM t"), [{ v: "fresh" }]);
    assert.equal(requests[0], 1);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("an abort during a FETCH of a multi-window result retires the socket", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([
    [buildPartialSelectResponse(3), STALL],
    [INSERT_OK, CLOSE_OK],
  ]);
  const client = optionsClient(port);
  const reason = new Error("stopped by the caller");

  try {
    await assert.rejects(
      client.query("SELECT id FROM t", [], { signal: abortAfter(50, reason) }),
      (error) => error === reason,
    );

    // Neither the handle release nor an END_TRAN followed on the retired socket.
    assert.deepEqual(requests, [2]);
    assert.deepEqual(await client.query("INSERT INTO t VALUES (2)"), []);
    assert.deepEqual(requests, [2, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("an abort inside a transaction loses it: later statements and commit fail", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([[INSERT_OK, CLOSE_OK, STALL]]);
  const client = optionsClient(port);
  const reason = new Error("stopped by the caller");

  try {
    const scope = await client.beginTransactionScope();
    await scope.query("INSERT INTO t VALUES (1)");
    await assert.rejects(
      scope.execute("INSERT INTO t VALUES (2)", [], { signal: abortAfter(50, reason) }),
      (error) => error === reason,
    );

    await assert.rejects(scope.query("INSERT INTO t VALUES (3)"), (error: unknown) => {
      assert.ok(error instanceof TransactionError);
      assert.match(
        String(((error.cause as Error).cause as Error).message),
        /Connection lost during transaction/,
      );
      return true;
    });
    await assert.rejects(scope.commit(), TransactionError);

    // Nothing reached a new session while the transaction was unresolved.
    assert.deepEqual(requests, [3]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("statements queued behind an aborted one behave as after a timeout", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([
    [INSERT_OK, CLOSE_OK, STALL],
    [INSERT_OK, CLOSE_OK],
  ]);
  const client = optionsClient(port);
  const reason = new Error("stopped by the caller");

  try {
    await client.query("INSERT INTO t VALUES (1)");
    const aborted = client.query("INSERT INTO t VALUES (2)", [], {
      signal: abortAfter(50, reason),
    });
    const queued = client.query("INSERT INTO t VALUES (3)");

    await assert.rejects(aborted, (error) => error === reason);
    await assert.rejects(queued, (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match(((error.cause as Error).cause as Error).message, /not connected/);
      return true;
    });

    await client.query("INSERT INTO t VALUES (4)");
    assert.deepEqual(requests, [3, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a per-query readTimeout applies where the client has none, and retires the socket", {
  timeout: 5000,
}, async () => {
  const { server, port, requests } = await createScriptedCas([[STALL], [INSERT_OK, CLOSE_OK]]);
  const client = optionsClient(port);

  try {
    await assert.rejects(
      client.query("INSERT INTO t VALUES (1)", [], { readTimeout: 100 }),
      (error: unknown) => error instanceof ReadTimeoutError && error.timeoutMs === 100,
    );

    assert.deepEqual(await client.query("INSERT INTO t VALUES (2)"), []);
    assert.deepEqual(requests, [1, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a per-query readTimeout overrides the client's for that request only", {
  timeout: 5000,
}, async () => {
  const { server, port } = await createScriptedCas([
    [{ delay: 300, reply: INSERT_OK }, CLOSE_OK, { delay: 300, reply: INSERT_OK }, CLOSE_OK, STALL],
  ]);
  const client = optionsClient(port, 100);

  try {
    assert.deepEqual(await client.query("INSERT INTO t VALUES (1)", [], { readTimeout: 1000 }), []);
    assert.deepEqual(await client.query("INSERT INTO t VALUES (2)", [], { readTimeout: 0 }), []);

    await assert.rejects(
      client.query("INSERT INTO t VALUES (3)"),
      (error: unknown) => error instanceof ReadTimeoutError && error.timeoutMs === 100,
    );
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a per-query readTimeout also limits the statement's FETCH", { timeout: 5000 }, async () => {
  const { server, port, requests } = await createScriptedCas([
    [buildPartialSelectResponse(3), STALL],
    [INSERT_OK, CLOSE_OK],
  ]);
  const client = optionsClient(port);

  try {
    await assert.rejects(
      client.query("SELECT id FROM t", [], { readTimeout: 100 }),
      (error: unknown) => error instanceof ReadTimeoutError && error.timeoutMs === 100,
    );
    assert.deepEqual(await client.query("INSERT INTO t VALUES (2)"), []);
    assert.deepEqual(requests, [2, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("abort listeners are removed when statements settle", { timeout: 10000 }, async () => {
  const CALLS = 50;
  const script = Array.from({ length: CALLS * 4 }, (_, index) =>
    index % 2 === 0 ? INSERT_OK : CLOSE_OK,
  );
  const { server, port } = await createScriptedCas([script]);
  const client = optionsClient(port);
  const signal = new AbortController().signal;

  try {
    for (let index = 0; index < CALLS; index += 1) {
      await client.query("INSERT INTO t VALUES (1)", [], { signal, readTimeout: 1000 });
    }
    assert.equal(getEventListeners(signal, "abort").length, 0);

    await Promise.all(
      Array.from({ length: CALLS }, () => client.query("INSERT INTO t VALUES (1)", [], { signal })),
    );
    assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

// ---------------------------------------------------------------------------
// executeMany(): PREPARE once, EXECUTE_ARRAY with every set (#86)
// ---------------------------------------------------------------------------

const EXECUTE_ARRAY = CASFunctionCode.EXECUTE_ARRAY;
const INSERT_EM = "INSERT INTO c_em (id, v) VALUES (?, ?)";

/** Sets of about 330 kB each: three fit in one EXECUTE_ARRAY request, four do not. */
const largeSets = (count: number): Array<[number, string]> =>
  Array.from({ length: count }, (_, index) => [index + 1, "x".repeat(330_000)]);

function queueBatch(fakeCAS: FakeCASConnection, prepare: string, ...replies: string[]): void {
  fakeCAS.queueResponse(Buffer.from(prepare, "hex"));
  for (const reply of replies) {
    fakeCAS.queueResponse(Buffer.from(reply, "hex"));
  }
}

test("executeMany prepares once, runs every set in one request, then commits", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareInsert, EXECUTE_ARRAY_FRAMES.insertThree);

  const result = await adapter.executeMany(INSERT_EM, [
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ]);

  assert.deepEqual(result, { affectedRows: 3, results: [1, 1, 1] });
  assert.deepEqual(sentCodes(fakeCAS), [
    CASFunctionCode.PREPARE,
    EXECUTE_ARRAY,
    CASFunctionCode.END_TRAN,
    CASFunctionCode.CLOSE_REQ_HANDLE,
  ]);
  assert.equal(fakeCAS.sentPayloads[1]!.toString("hex"), EXECUTE_ARRAY_FRAMES.insertThreeRequest);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
  assert.deepEqual(fakeCAS.closedHandles, [3]);
});

test("executeMany reports each set's own count, 0 included", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareUpdate, EXECUTE_ARRAY_FRAMES.updateTwoSets);

  assert.deepEqual(
    await adapter.executeMany("UPDATE c_em SET v = ? WHERE id > ?", [
      ["x", 3],
      ["y", 99],
    ]),
    { affectedRows: 2, results: [2, 0] },
  );
});

test("executeMany with no sets resolves at once and sends nothing", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS._isConnected = false;

  assert.deepEqual(await adapter.executeMany(INSERT_EM, []), { affectedRows: 0, results: [] });
  assert.equal(fakeCAS.sendAndRecvCalls, 0);
  assert.equal(fakeCAS.connectCalls, 0);
});

test("a failed set in autocommit rolls back the whole batch and reports every set", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(
    fakeCAS,
    EXECUTE_ARRAY_FRAMES.prepareInsert,
    EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate,
  );

  await assert.rejects(
    adapter.executeMany(INSERT_EM, [
      [6, "f"],
      [1, "dup"],
      [7, "g"],
    ]),
    (error: unknown) => {
      assert.ok(error instanceof ConstraintError);
      assert.equal(error.code, -670);
      assert.equal(error.kind, "unique-violation");
      assert.equal(error.batch?.rolledBack, true);
      assert.equal(error.batch?.executed, 3);
      assert.deepEqual(error.batch?.results, [1, null, 1]);
      assert.equal(error.batch?.failures.length, 1);
      const failure = error.batch?.failures[0];
      assert.equal(failure?.index, 1);
      assert.equal(failure?.code, -670);
      assert.equal(failure?.origin, "server");
      assert.equal(failure?.kind, "unique-violation");
      assert.match(failure?.message ?? "", /^Operation would have caused one or more unique/);
      return true;
    },
  );

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.deepEqual(fakeCAS.closedHandles, [3]);
  assertAutocommitResumed(adapter);
});

test("a failed set inside a transaction leaves the transaction to the caller", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  await adapter.beginTransaction();
  queueBatch(
    fakeCAS,
    EXECUTE_ARRAY_FRAMES.prepareInsert,
    EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate,
  );

  await assert.rejects(
    adapter.executeMany(INSERT_EM, [
      [6, "f"],
      [1, "dup"],
      [7, "g"],
    ]),
    (error: unknown) => {
      assert.ok(error instanceof ConstraintError);
      assert.equal(error.batch?.rolledBack, false);
      assert.deepEqual(error.batch?.results, [1, null, 1]);
      assert.equal(error.batch?.failures[0]?.index, 1);
      return true;
    },
  );

  assert.deepEqual(endTranTypes(fakeCAS), []);
  assert.deepEqual(fakeCAS.closedHandles, [3]);

  // Still the caller's transaction: it can go on and decide.
  await adapter.commit();
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
});

test("a successful executeMany inside a transaction does not end it", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  await adapter.beginTransaction();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareInsert, EXECUTE_ARRAY_FRAMES.insertTwo);

  assert.deepEqual(
    await adapter.executeMany(INSERT_EM, [
      [4, "d"],
      [5, "e"],
    ]),
    { affectedRows: 2, results: [1, 1] },
  );
  assert.deepEqual(sentCodes(fakeCAS), [
    CASFunctionCode.PREPARE,
    EXECUTE_ARRAY,
    CASFunctionCode.CLOSE_REQ_HANDLE,
  ]);
});

test("sets of different lengths are refused before anything is sent", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS._isConnected = false;

  await assert.rejects(adapter.executeMany(INSERT_EM, [[1, "a"], [2]]), (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.match((error.cause as Error).message, /Parameter count mismatch: parameter set 1/);
    return true;
  });
  assert.equal(fakeCAS.sendAndRecvCalls, 0);
  assert.equal(fakeCAS.connectCalls, 0);
});

test("sets that do not match the server's marker count never reach EXECUTE_ARRAY", async () => {
  for (const sets of [[[1]], [[1, "a", "extra"]]]) {
    const { adapter, fakeCAS } = createPreparedAdapter();
    queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareInsert);

    await assert.rejects(adapter.executeMany(INSERT_EM, sets), (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match((error.cause as Error).message, /Parameter count mismatch/);
      return true;
    });
    assert.ok(!sentCodes(fakeCAS).includes(EXECUTE_ARRAY));
    assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
    assert.deepEqual(fakeCAS.closedHandles, [3]);
  }
});

test("a SELECT is refused after PREPARE and never executed", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareSelect);

  await assert.rejects(
    adapter.executeMany("SELECT v FROM c_em WHERE id = ?", [[1], [2]]),
    (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match((error.cause as Error).message, /SELECT/);
      return true;
    },
  );
  assert.ok(!sentCodes(fakeCAS).includes(EXECUTE_ARRAY));
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.deepEqual(fakeCAS.closedHandles, [3]);
});

test("a statement without markers is refused: the server would run nothing", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareNoMarker);

  await assert.rejects(
    adapter.executeMany("INSERT INTO c_em (id, v) VALUES (100, 'z')", [[]]),
    (error: unknown) => {
      assert.ok(error instanceof QueryError);
      assert.match((error.cause as Error).message, /marker/);
      return true;
    },
  );
  assert.ok(!sentCodes(fakeCAS).includes(EXECUTE_ARRAY));
});

test("more than one statement, a bad value or a bad argument sends nothing", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS._isConnected = false;
  const refused: Array<() => Promise<unknown>> = [
    () => adapter.executeMany("INSERT INTO t VALUES (?); DELETE FROM t", [[1]]),
    () =>
      adapter.executeMany(INSERT_EM, [
        [1, "a"],
        [2, Number.NaN],
      ]),
    () => adapter.executeMany(INSERT_EM, "nope" as unknown as QueryParam[][]),
    () => adapter.executeMany(INSERT_EM, [[1, "a"], "b" as unknown as QueryParam[]]),
    () => adapter.executeMany("INSERT INTO t VALUES (?)\0", [[1]]),
  ];

  for (const run of refused) {
    await assert.rejects(run, QueryError);
  }
  assert.equal(fakeCAS.sendAndRecvCalls, 0);
  assert.equal(fakeCAS.connectCalls, 0);
});

test("executeMany splits a large batch by size, on one handle and one transaction", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(
    fakeCAS,
    EXECUTE_ARRAY_FRAMES.prepareInsert,
    EXECUTE_ARRAY_FRAMES.insertThree,
    EXECUTE_ARRAY_FRAMES.insertTwo,
  );

  const result = await adapter.executeMany(INSERT_EM, largeSets(5));

  assert.deepEqual(result, { affectedRows: 5, results: [1, 1, 1, 1, 1] });
  assert.deepEqual(sentCodes(fakeCAS), [
    CASFunctionCode.PREPARE,
    EXECUTE_ARRAY,
    EXECUTE_ARRAY,
    CASFunctionCode.END_TRAN,
    CASFunctionCode.CLOSE_REQ_HANDLE,
  ]);
  const requests = fakeCAS.sentPayloads.filter((payload) => payload[0] === EXECUTE_ARRAY);
  for (const request of requests) {
    assert.equal(request.readInt32BE(5), 3); // the same handle
    assert.equal(request[22], 0); // autocommit off
    assert.ok(request.length <= 1024 * 1024);
  }
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
});

test("a failure in a later request rolls back the requests before it", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(
    fakeCAS,
    EXECUTE_ARRAY_FRAMES.prepareInsert,
    EXECUTE_ARRAY_FRAMES.insertThree,
    EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate,
  );

  await assert.rejects(adapter.executeMany(INSERT_EM, largeSets(6)), (error: unknown) => {
    assert.ok(error instanceof ConstraintError);
    assert.deepEqual(error.batch?.results, [1, 1, 1, 1, null, 1]);
    assert.equal(error.batch?.failures[0]?.index, 4);
    assert.equal(error.batch?.executed, 6);
    return true;
  });
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("after a failed request the rest of the batch is never sent", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(
    fakeCAS,
    EXECUTE_ARRAY_FRAMES.prepareInsert,
    EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate,
  );

  await assert.rejects(adapter.executeMany(INSERT_EM, largeSets(6)), (error: unknown) => {
    assert.ok(error instanceof ConstraintError);
    assert.deepEqual(error.batch?.results, [1, null, 1, null, null, null]);
    assert.equal(error.batch?.executed, 3);
    return true;
  });
  assert.equal(sentCodes(fakeCAS).filter((code) => code === EXECUTE_ARRAY).length, 1);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("an error for the whole EXECUTE_ARRAY request rolls back and has no per-set detail", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareInsert, PREPARED_FRAMES.executeCoercionError);

  await assert.rejects(adapter.executeMany(INSERT_EM, [[1, "a"]]), (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.equal(error.code, -494);
    assert.equal(error.batch, undefined);
    return true;
  });
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.deepEqual(fakeCAS.closedHandles, [3]);
});

test("a malformed EXECUTE_ARRAY reply drops the session and commits nothing", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareInsert, EXECUTE_ARRAY_FRAMES.insertTwo);

  await assert.rejects(
    adapter.executeMany(INSERT_EM, [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]),
    QueryError,
  );
  assert.equal(fakeCAS.discardCalls, 1);
  assert.deepEqual(endTranTypes(fakeCAS), []);
});

test("a failed ROLLBACK after a failed set drops the session, so nothing is committed later", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(
    fakeCAS,
    EXECUTE_ARRAY_FRAMES.prepareInsert,
    EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate,
  );
  fakeCAS.queueResponse(buildSimpleResponse(0)); // CLOSE_REQ_HANDLE
  fakeCAS.queueResponse(buildErrorResponse(-1000, "rollback refused"));

  await assert.rejects(
    adapter.executeMany(INSERT_EM, [
      [6, "f"],
      [1, "dup"],
      [7, "g"],
    ]),
    ConstraintError,
  );
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.equal(fakeCAS.discardCalls, 1);
});

test("executeMany forgets the session's insert id, which its INSERTs changed", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueBatch(fakeCAS, EXECUTE_ARRAY_FRAMES.prepareInsert, EXECUTE_ARRAY_FRAMES.insertTwo);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).insertIdBaseline = "1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).insertIdGeneration = fakeCAS.connectionGeneration;

  await adapter.executeMany(INSERT_EM, [
    [4, "d"],
    [5, "e"],
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((adapter as any).insertIdBaseline, null);
});

test("executeMany with an aborted signal or invalid options sends nothing", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS._isConnected = false;
  const reason = new Error("cancelled before it started");
  const controller = new AbortController();
  controller.abort(reason);

  await assert.rejects(
    adapter.executeMany(INSERT_EM, [[1, "a"]], { signal: controller.signal }),
    (error) => error === reason,
  );
  await assert.rejects(
    adapter.executeMany(INSERT_EM, [], { signal: controller.signal }),
    (error) => error === reason,
  );
  await assert.rejects(adapter.executeMany(INSERT_EM, [[1, "a"]], { readTimeout: -1 }), RangeError);
  assert.equal(fakeCAS.sendAndRecvCalls, 0);
  assert.equal(fakeCAS.connectCalls, 0);
});

test("an abort while EXECUTE_ARRAY is in flight retires the socket and is never replayed", {
  timeout: 5000,
}, async () => {
  const prepare = Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex");
  const { server, port, requests } = await createScriptedCas([
    [prepare, STALL],
    [INSERT_OK, CLOSE_OK],
  ]);
  const client = optionsClient(port);
  const reason = new Error("stopped by the caller");

  try {
    await assert.rejects(
      client.executeMany(INSERT_EM, [[1, "a"]], { signal: abortAfter(50, reason) }),
      (error) => error === reason,
    );

    // No ROLLBACK or handle release followed on the retired socket, and nothing was resent.
    assert.deepEqual(requests, [2]);
    assert.deepEqual(await client.query("INSERT INTO t VALUES (2)"), []);
    assert.deepEqual(requests, [2, 2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a per-query readTimeout limits each EXECUTE_ARRAY request", { timeout: 5000 }, async () => {
  const prepare = Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex");
  const { server, port, requests } = await createScriptedCas([[prepare, STALL]]);
  const client = optionsClient(port);

  try {
    await assert.rejects(
      client.executeMany(INSERT_EM, [[1, "a"]], { readTimeout: 100 }),
      (error: unknown) => error instanceof ReadTimeoutError && error.timeoutMs === 100,
    );
    assert.deepEqual(requests, [2]);
  } finally {
    await client.close();
    await closeStub(server);
  }
});

test("a set reported as -72 after another failure still blocks a later commit", async () => {
  // Synthetic: with autocommit off the CAS fails the whole request on -72, so a
  // per-set -72 should never arrive. If it did, the transaction is gone.
  const entry = (code: number, text: string): Buffer => {
    const message = Buffer.from(`${text}\0`);
    const head = Buffer.alloc(12);
    head.writeInt32BE(-2, 0);
    head.writeInt32BE(code, 4);
    head.writeInt32BE(message.length, 8);
    return Buffer.concat([head, message]);
  };
  const reply = Buffer.concat([
    Buffer.from("0000000000000002", "hex"),
    entry(-670, "duplicate"),
    entry(-72, "deadlock"),
    Buffer.from("fffffffe", "hex"),
  ]);
  const { adapter, fakeCAS } = createPreparedAdapter();
  await adapter.beginTransaction();
  fakeCAS.queueResponse(Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex"));
  fakeCAS.queueResponse(reply);

  await assert.rejects(
    adapter.executeMany(INSERT_EM, [
      [1, "a"],
      [2, "b"],
    ]),
    ConstraintError,
  );
  const sent = fakeCAS.sentPayloads.length;

  await assert.rejects(adapter.commit(), TransactionError);
  assert.equal(fakeCAS.sentPayloads.length, sent);
});

// ---------------------------------------------------------------------------
// Writing BLOB and CLOB content: LOB_NEW and LOB_WRITE before EXECUTE (#103)
// ---------------------------------------------------------------------------

const LOB_CHUNK = 128 * 1024;
const UPDATE_LOB = "UPDATE t SET b = ? WHERE id = ?";
/** An EXECUTE reply for an UPDATE of one row. */
const UPDATE_ONE = "00000001000000000116000000010000000000000000000000000000000000fffffffe";

function lobWriteReply(count: number): Buffer {
  const reply = Buffer.alloc(4);
  reply.writeInt32BE(count, 0);
  return reply;
}

/** PREPARE of a statement with two markers, LOB_NEW, then one reply per LOB_WRITE of `sizes`. */
function queueLobUpload(
  fakeCAS: FakeCASConnection,
  sizes: number[],
  newReply: string = LOB_WRITE_FRAMES.newBlobReply,
): void {
  fakeCAS.queueResponse(Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex"));
  fakeCAS.queueResponse(Buffer.from(newReply, "hex"));
  for (const size of sizes) {
    fakeCAS.queueResponse(lobWriteReply(size));
  }
}

/** Offset and bytes of every LOB_WRITE, after the handle. */
function lobWrites(fakeCAS: FakeCASConnection): Array<{ offset: number; data: Buffer }> {
  return fakeCAS.sentPayloads
    .filter((payload) => payload[0] === CASFunctionCode.LOB_WRITE)
    .map((payload) => {
      const at = 1 + 4 + payload.readInt32BE(1);
      return {
        offset: Number(payload.readBigInt64BE(at + 4)),
        data: payload.subarray(at + 16, at + 16 + payload.readInt32BE(at + 12)),
      };
    });
}

/** The handle bound by the EXECUTE request: the LOB, then the id 1 as the last value. */
function boundHandle(fakeCAS: FakeCASConnection, type = 0x17): Buffer {
  const execute = fakeCAS.sentPayloads.find((payload) => payload[0] === CASFunctionCode.EXECUTE);
  assert.ok(execute);
  const id = Buffer.from("00000001080000000400000001", "hex");
  assert.ok(execute.subarray(execute.length - id.length).equals(id));
  const at = execute.lastIndexOf(Buffer.from([0, 0, 0, 1, type]));
  assert.ok(at > 0);
  const length = execute.readInt32BE(at + 5);
  assert.equal(at + 9 + length, execute.length - id.length);
  return execute.subarray(at + 9, at + 9 + length);
}

test("blob(): PREPARE, LOB_NEW, 128 KiB LOB_WRITEs, then EXECUTE with the sized handle", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const content = Buffer.alloc(300_000, 7);
  queueLobUpload(fakeCAS, [LOB_CHUNK, LOB_CHUNK, 300_000 - 2 * LOB_CHUNK]);
  fakeCAS.queueResponse(preparedReply(UPDATE_ONE));

  assert.deepEqual(await adapter.executePrepared(UPDATE_LOB, [blob(content), 1]), {
    affectedRows: 1,
  });

  assert.deepEqual(sentCodes(fakeCAS), [
    CASFunctionCode.PREPARE,
    CASFunctionCode.LOB_NEW,
    CASFunctionCode.LOB_WRITE,
    CASFunctionCode.LOB_WRITE,
    CASFunctionCode.LOB_WRITE,
    CASFunctionCode.EXECUTE,
    CASFunctionCode.END_TRAN,
    CASFunctionCode.CLOSE_REQ_HANDLE,
  ]);
  assert.equal(fakeCAS.sentPayloads[1]!.toString("hex"), LOB_WRITE_FRAMES.newBlobRequest);
  assert.deepEqual(
    lobWrites(fakeCAS).map(({ offset, data }) => [offset, data.length]),
    [
      [0, LOB_CHUNK],
      [LOB_CHUNK, LOB_CHUNK],
      [2 * LOB_CHUNK, 300_000 - 2 * LOB_CHUNK],
    ],
  );
  assert.ok(Buffer.concat(lobWrites(fakeCAS).map(({ data }) => data)).equals(content));

  const handle = boundHandle(fakeCAS);
  const created = Buffer.from(LOB_WRITE_FRAMES.newBlobReply, "hex").subarray(4);
  assert.equal(handle.readBigInt64BE(4), 300_000n);
  assert.ok(handle.subarray(12).equals(created.subarray(12)));
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
});

test("blob() of an empty Buffer creates an empty BLOB with no LOB_WRITE", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueLobUpload(fakeCAS, []);
  fakeCAS.queueResponse(preparedReply(UPDATE_ONE));

  await adapter.executePrepared(UPDATE_LOB, [blob(Buffer.alloc(0)), 1]);

  assert.deepEqual(lobWrites(fakeCAS), []);
  assert.equal(boundHandle(fakeCAS).readBigInt64BE(4), 0n);
});

test("small stream chunks are merged into full LOB_WRITEs and a Uint8Array is accepted", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const pieces = Array.from({ length: 40 }, (_, i) => new Uint8Array(5000).fill(i));
  queueLobUpload(fakeCAS, [LOB_CHUNK, 200_000 - LOB_CHUNK]);
  fakeCAS.queueResponse(preparedReply(UPDATE_ONE));

  await adapter.executePrepared(UPDATE_LOB, [blob(Readable.from(pieces)), 1]);

  const writes = lobWrites(fakeCAS);
  assert.deepEqual(
    writes.map(({ offset, data }) => [offset, data.length]),
    [
      [0, LOB_CHUNK],
      [LOB_CHUNK, 200_000 - LOB_CHUNK],
    ],
  );
  assert.ok(Buffer.concat(writes.map(({ data }) => data)).equals(Buffer.concat(pieces)));
  assert.equal(boundHandle(fakeCAS).readBigInt64BE(4), 200_000n);
});

test("clob(): a surrogate pair split between two stream strings is one character", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const expected = Buffer.from("a\u{1F600}b", "utf-8");
  queueLobUpload(fakeCAS, [expected.length], LOB_WRITE_FRAMES.newClobReply);
  fakeCAS.queueResponse(preparedReply(UPDATE_ONE));

  await adapter.executePrepared(UPDATE_LOB, [clob(Readable.from(["a\uD83D", "\uDE00b"])), 1]);

  assert.equal(fakeCAS.sentPayloads[1]!.toString("hex"), "230000000400000018");
  assert.ok(lobWrites(fakeCAS)[0]!.data.equals(expected));
  assert.equal(boundHandle(fakeCAS, 0x18).readBigInt64BE(4), BigInt(expected.length));
});

test("clob(): 3- and 4-byte characters across the 128 KiB boundary arrive as UTF-8", async () => {
  // One character starts at each of the last bytes before the boundary.
  const text = `${"x".repeat(LOB_CHUNK - 2)}\u{1F600}${"\uD55C".repeat(3)}${"y".repeat(10)}`;
  const expected = Buffer.from(text, "utf-8");
  for (const source of [text, Readable.from(Array.from(text.match(/[\s\S]{1,1000}/g) ?? []))]) {
    const { adapter, fakeCAS } = createPreparedAdapter();
    queueLobUpload(
      fakeCAS,
      [LOB_CHUNK, expected.length - LOB_CHUNK],
      LOB_WRITE_FRAMES.newClobReply,
    );
    fakeCAS.queueResponse(preparedReply(UPDATE_ONE));

    await adapter.executePrepared(UPDATE_LOB, [clob(source), 1]);

    const writes = lobWrites(fakeCAS);
    assert.deepEqual(
      writes.map(({ data }) => data.length),
      [LOB_CHUNK, expected.length - LOB_CHUNK],
    );
    assert.ok(Buffer.concat(writes.map(({ data }) => data)).equals(expected));
  }
});

for (const [name, source] of [
  ["a Buffer that is not UTF-8", () => Buffer.from([0x61, 0xff])],
  ["a stream that ends inside a character", () => Readable.from([Buffer.from([0xe2, 0x82])])],
  [
    "bytes that end inside a character before text",
    () => Readable.from([Buffer.from([0xe2]), "a"]),
  ],
  ["a lone high surrogate at the end", () => Readable.from(["a\uD83D"])],
  ["a lone low surrogate", () => "a\uDE00"],
  ["a high surrogate followed by bytes", () => Readable.from(["\uD83D", Buffer.from("a")])],
  ["a stream chunk that is a number", () => Readable.from([1], { objectMode: true })],
] as const) {
  test(`clob() of ${name} is refused with a TypeError and rolled back, never executed`, async () => {
    const { adapter, fakeCAS } = createPreparedAdapter();
    queueLobUpload(fakeCAS, [1, 1], LOB_WRITE_FRAMES.newClobReply);

    await assert.rejects(
      adapter.executePrepared(UPDATE_LOB, [clob(source() as never), 1]),
      TypeError,
    );

    assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.EXECUTE));
    assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  });
}

test("a blob() stream chunk that is not bytes is refused with a TypeError", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueLobUpload(fakeCAS, []);

  await assert.rejects(
    adapter.executePrepared(UPDATE_LOB, [blob(Readable.from(["text"])), 1]),
    (error: Error) => error instanceof TypeError && /yielded a string/.test(error.message),
  );
  assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.EXECUTE));
});

test("a LOB_WRITE that stores fewer bytes than sent fails the statement and rolls back", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  queueLobUpload(fakeCAS, [LOB_CHUNK - 1]);

  await assert.rejects(
    adapter.executePrepared(UPDATE_LOB, [blob(Buffer.alloc(LOB_CHUNK + 1)), 1]),
    (error: Error) =>
      error instanceof QueryError &&
      (error.cause as Error).message ===
        `CUBRID LOB write stored ${LOB_CHUNK - 1} of ${LOB_CHUNK} bytes`,
  );

  assert.equal(lobWrites(fakeCAS).length, 1);
  assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.EXECUTE));
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
  assert.equal(fakeCAS.discardCalls, 0);
});

test("a LOB_WRITE server error reports its code and rolls the autocommit statement back", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  fakeCAS.queueResponse(Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_WRITE_FRAMES.newBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_WRITE_FRAMES.writeGapReply, "hex"));

  await assert.rejects(
    adapter.executePrepared(UPDATE_LOB, [blob(Buffer.from("abc")), 1]),
    (error: Error) => error instanceof QueryError && (error as QueryError).code === -1016,
  );

  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("a failed PREPARE uploads nothing and leaves a stream source unread", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const source = Readable.from([Buffer.from("abc")]);
  fakeCAS.queueResponse(preparedReply(PREPARED_FRAMES.prepareSyntaxError));

  await assert.rejects(adapter.executePrepared(UPDATE_LOB, [blob(source), 1]), QueryError);
  assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.LOB_NEW));

  queueLobUpload(fakeCAS, [3]);
  fakeCAS.queueResponse(preparedReply(UPDATE_ONE));
  await adapter.executePrepared(UPDATE_LOB, [blob(source), 1]);
  assert.equal(lobWrites(fakeCAS)[0]!.data.toString(), "abc");
});

test("a stream source already uploaded is refused with a TypeError before anything is sent", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const source = Readable.from([Buffer.from("abc")]);
  queueLobUpload(fakeCAS, [3]);
  fakeCAS.queueResponse(preparedReply(UPDATE_ONE));
  await adapter.executePrepared(UPDATE_LOB, [blob(source), 1]);
  const sent = fakeCAS.sentPayloads.length;

  await assert.rejects(
    adapter.executePrepared(UPDATE_LOB, [blob(source), 2]),
    (error: Error) => error instanceof TypeError && /already been read/.test(error.message),
  );
  assert.equal(fakeCAS.sentPayloads.length, sent);
});

test("a failed upload consumes its stream source, which cannot be retried", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const source = Readable.from([Buffer.from("abc")]);
  fakeCAS.queueResponse(Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_WRITE_FRAMES.newBlobReply, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_WRITE_FRAMES.writeGapReply, "hex"));
  await assert.rejects(adapter.executePrepared(UPDATE_LOB, [blob(source), 1]), QueryError);

  await assert.rejects(adapter.executePrepared(UPDATE_LOB, [blob(source), 1]), TypeError);
  assert.equal(source.destroyed, true);
});

test("inside a transaction a failed upload sends no END_TRAN, and the caller can still commit", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  await adapter.beginTransaction();
  queueLobUpload(fakeCAS, [2]);

  await assert.rejects(
    adapter.executePrepared(UPDATE_LOB, [blob(Buffer.from("abc")), 1]),
    QueryError,
  );
  assert.deepEqual(endTranTypes(fakeCAS), []);

  await adapter.commit();
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.COMMIT]);
});

const lobValues = (): QueryParam[] => [blob(Buffer.from("a")) as never, clob("b") as never];

for (const [method, run] of [
  ["query", (adapter: NativeCubridAdapter) => adapter.query("SELECT ?", lobValues())],
  ["queryResult", (adapter: NativeCubridAdapter) => adapter.queryResult("SELECT ?", lobValues())],
  ["execute", (adapter: NativeCubridAdapter) => adapter.execute("UPDATE t SET b = ?", lobValues())],
  [
    "stream",
    async (adapter: NativeCubridAdapter) => {
      for await (const _row of adapter.stream("SELECT ?", lobValues())) {
        // Never reached.
      }
    },
  ],
  [
    "executeMany",
    (adapter: NativeCubridAdapter) =>
      adapter.executeMany("UPDATE t SET b = ?", [[1], lobValues().slice(0, 1)]),
  ],
] as const) {
  test(`${method}() refuses blob() and clob() with a TypeError before anything is sent`, async () => {
    const { adapter, fakeCAS } = createPreparedAdapter();
    fakeCAS._isConnected = false;

    await assert.rejects(async () => {
      await run(adapter);
    }, TypeError);

    assert.equal(fakeCAS.connectCalls, 0);
    assert.deepEqual(fakeCAS.sentPayloads, []);
  });
}

test("the client refuses blob() on a literal method with a TypeError before connecting", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  let connections = 0;
  const client = new CubridClient(DEFAULT_CONFIG, () => {
    connections += 1;
    return adapter;
  });

  for (const run of [
    () => client.query("SELECT ?", lobValues()),
    () => client.queryResult("SELECT ?", lobValues()),
    () => client.execute("UPDATE t SET b = ?", lobValues()),
  ]) {
    await assert.rejects(run(), (error: unknown) => error instanceof TypeError);
  }
  assert.throws(() => client.stream("SELECT ?", lobValues()), TypeError);
  assert.equal(connections, 0);

  // executeMany() is refused by the connection, still before any statement.
  await assert.rejects(client.executeMany("UPDATE t SET b = ?", [lobValues()]), TypeError);
  assert.deepEqual(fakeCAS.sentPayloads, []);
});

test("clob() accepts Uint8Array stream chunks, as web streams yield them", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const bytes = new TextEncoder().encode("hé");
  queueLobUpload(fakeCAS, [bytes.length], LOB_WRITE_FRAMES.newClobReply);
  fakeCAS.queueResponse(preparedReply(UPDATE_ONE));

  await adapter.executePrepared(UPDATE_LOB, [clob(Readable.from([bytes])), 1]);

  assert.equal(lobWrites(fakeCAS)[0]!.data.toString("utf-8"), "hé");
});

test("a LOB_NEW failure destroys the Readable source it consumed", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const source = Readable.from([Buffer.from("abc")]);
  fakeCAS.queueResponse(Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex"));
  fakeCAS.queueResponse(Buffer.from(LOB_WRITE_FRAMES.newBadTypeReply, "hex"));

  await assert.rejects(adapter.executePrepared(UPDATE_LOB, [blob(source), 1]), QueryError);

  assert.equal(source.destroyed, true);
  assert.deepEqual(endTranTypes(fakeCAS), [EndTranType.ROLLBACK]);
});

test("a transaction refuses blob() with a TypeError, and transaction() wraps it", async () => {
  const { adapter, fakeCAS } = createPreparedAdapter();
  const client = new CubridClient(DEFAULT_CONFIG, () => adapter);

  await assert.rejects(
    client.transaction(async (tx) => {
      for (const run of [
        () => tx.query("SELECT ?", lobValues()),
        () => tx.queryResult("SELECT ?", lobValues()),
        () => tx.execute("UPDATE t SET b = ?", lobValues()),
        () => tx.executeMany("UPDATE t SET b = ?", [lobValues()]),
      ]) {
        await assert.rejects(run(), (error: unknown) => error instanceof TypeError);
      }
      await tx.query("SELECT ?", lobValues());
    }),
    (error: unknown) => error instanceof TransactionError && error.cause instanceof TypeError,
  );

  assert.ok(!sentCodes(fakeCAS).includes(CASFunctionCode.PREPARE_AND_EXECUTE));
});
