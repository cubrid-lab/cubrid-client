import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket as NetSocket } from "node:net";

import { NativeCubridAdapter } from "../src/adapters/native.js";
import { createClient } from "../src/client/create-client.js";
import { CASFunctionCode } from "../src/protocol/constants.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { QueryError } from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import type { ClientConfig } from "../src/types/client.js";
import { CAPTURED_FRAMES } from "./fixtures/collection-frames.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
function buildDMLResponse(
  statementType: number,
  totalTupleCount: number,
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
  columns: Array<{ name: string; type: number }>,
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
    cs.writeInt16BE(0, 0);
    parts.push(cs);

    // precision (4 bytes)
    const cp = Buffer.alloc(4);
    cp.writeInt32BE(255, 0);
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

    // isNullable = 1
    parts.push(Buffer.from([1]));

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
  const adapter = new NativeCubridAdapter({ ...DEFAULT_CONFIG, port: 19999, connectionTimeout: 2000 });
  await assert.rejects(
    () => adapter.connect(),
    (err: Error) => {
      assert.ok(err instanceof ConnectionError);
      return true;
    },
  );
});

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

  const selectResp = buildSelectResponse(
    [{ name: "val", type: 2 }],
    [[null]],
  );
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
  fakeCAS.queueResponse(
    buildSelectResponse([{ name: "char_length", type: 2 }], [[charLength]]),
  );
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
    port: 19999,  // Use non-connectable port to avoid real connection
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
    port: 19999,  // Use non-connectable port to avoid real connection
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

test("NativeCubridAdapter rejects zero-tuple FETCH before the advertised total", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS();

  // Build a SELECT response where totalTupleCount > inline rows
  const selectResp = buildSelectResponse(
    [{ name: "id", type: 2 }],
    [["1"]],
  );
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

test("a zero-byte value without a decoder rejects, and the session stays open", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  // The captured TIMESTAMPTZ reply, with its 19-byte value (type 29) removed.
  const value = "0000001307e4000100020003000400052b30393a303000";
  const { hex } = CAPTURED_FRAMES.timestamptzValue;
  assert.ok(hex.includes(value));
  fakeCAS.queueResponse(Buffer.from(hex.replace(value, "00000000"), "hex"));

  await assertQueryFails(adapter, /column "tz" \(wire type 29, 0 bytes\)/);

  assert.equal(fakeCAS.discardCalls, 0);
  assert.equal(fakeCAS.isConnected, true);
  assert.deepEqual(fakeCAS.closedHandles, [1]);
});

test("damage after an unsupported value still drops the session", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  const { hex } = CAPTURED_FRAMES.timestamptzValue;
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
  fakeCAS.queueExchangeFailure(new Error("close failed"));

  await assertQueryFails(adapter, /CUBRID fetch failed/);

  assert.deepEqual(fakeCAS.closedHandles, [QUERY_HANDLE]);
  assert.equal(fakeCAS.isConnected, false);
});

test("query handle: a close rejected by the server does not mask the failure", async () => {
  const { adapter, fakeCAS } = createAdapterWithFakeCAS(DEFAULT_CONFIG, { _protoVersion: 7 });
  fakeCAS.queueResponse(Buffer.from(CAPTURED_FRAMES.timestamptzValue.hex, "hex"));
  fakeCAS.queueResponse(buildErrorResponse(-1006, "invalid handle"));

  await assertQueryFails(adapter, /Unsupported CUBRID CAS value type 29/);

  assert.deepEqual(fakeCAS.closedHandles, [1]);
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

/**
 * Stub CAS. `scripts[n]` answers the requests of the nth connection in order;
 * STALL leaves that request unanswered and a missing entry answers success.
 */
async function createScriptedCas(
  scripts: Array<Array<Buffer | typeof STALL>>,
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
          if (reply !== STALL) {
            socket.write(frame(reply));
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
  return createClient({ host: "127.0.0.1", port, database: "testdb", user: "dba", readTimeout: 200 });
}

function closeStub(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("client.query rejects with ReadTimeoutError, and the next query reconnects", { timeout: 5000 }, async () => {
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

test("a query queued behind a timeout fails fast, and later queries work", { timeout: 5000 }, async () => {
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

test("a timeout inside a transaction loses the session: query and commit fail loudly", { timeout: 5000 }, async () => {
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
      assert.match(((error.cause as Error).cause as Error).message, /Connection lost during transaction/);
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

test("a timeout on the first transaction statement cannot start a new session", { timeout: 5000 }, async () => {
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

test("a statement whose handle cleanup times out still fails the commit", { timeout: 5000 }, async () => {
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

test("a timed-out COMMIT reports ReadTimeoutError and is not retried", { timeout: 5000 }, async () => {
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

test("ping after a first-statement timeout cannot give the transaction a new session", { timeout: 5000 }, async () => {
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
      assert.match(((error.cause as Error).cause as Error).message, /Connection lost during transaction/);
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
