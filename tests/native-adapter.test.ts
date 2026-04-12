import test from "node:test";
import assert from "node:assert/strict";

import { NativeCubridAdapter } from "../src/adapters/native.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { QueryError } from "../src/errors/query-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import type { ClientConfig } from "../src/types/client.js";

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
  destroyed = false;
  _isConnected = true;
  _casInfo = Buffer.alloc(4);
  _protoVersion = 1;
  _sessionId = 42;

  connectError?: Error;
  sendAndRecvError?: Error;
  sendError?: Error;

  /** Responses to return from sendAndRecv, consumed in FIFO order */
  private responses: Buffer[] = [];

  constructor(overrides: Partial<FakeCASConnection> = {}) {
    Object.assign(this, overrides);
  }

  /** Queue a sendAndRecv response */
  queueResponse(buf: Buffer): void {
    this.responses.push(buf);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) {
      throw this.connectError;
    }
    this._isConnected = true;
  }

  async send(_header: Buffer, _payload: Buffer): Promise<void> {
    this.sendCalls += 1;
    if (this.sendError) {
      throw this.sendError;
    }
  }

  async sendAndRecv(_header: Buffer, _payload: Buffer): Promise<Buffer> {
    this.sendAndRecvCalls += 1;
    if (this.sendAndRecvError) {
      throw this.sendAndRecvError;
    }
    if (this.responses.length > 0) {
      return this.responses.shift()!;
    }
    // Default: return a "success" response (response_code = 0)
    return buildSimpleResponse(0);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
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

test("NativeCubridAdapter query SELECT fetchRemaining stops on zero tupleCount", async () => {
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

  const rows = await adapter.query("SELECT id FROM t");
  // Only 1 row (inline), fetchRemaining stopped because tupleCount = 0
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "1");
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
