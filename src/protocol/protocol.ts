/**
 * CUBRID CAS protocol — request builders and response parsers.
 *
 * Each Write* function returns a Buffer containing the payload (without the
 * 8-byte frame header). The caller is responsible for prepending the header
 * via PacketWriter.buildHeader().
 *
 * Each Parse* function accepts a PacketReader positioned after CAS_INFO and
 * returns a parsed result structure.
 */

import { CasReplyError } from "../errors/internal-errors.js";
import { PacketReader } from "./packet-reader.js";
import { PacketWriter } from "./packet-writer.js";
import { ZonedDateTime } from "../types/zoned-date-time.js";
import {
  CASFunctionCode,
  CAS_MAGIC,
  CAS_MAGIC_SSL,
  CAS_PROTOCOL_VERSION,
  CAS_VERSION,
  CLIENT_JDBC,
  CUBRIDDataType,
  EXECUTE_QUERY_ALL,
  OPEN_DB_FIELD_SIZE,
  OPEN_DB_FILLER_SIZE,
  OPEN_DB_RESERVED_SIZE,
  PREPARE_NORMAL,
  SIZE_BROKER_INFO,
  SIZE_CAS_INFO,
  SIZE_DATETIME,
  SIZE_DOUBLE,
  SIZE_INT,
  SIZE_LONG,
  SIZE_OID,
  SIZE_SHORT,
  StatementType,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Column metadata (shared between prepare and execute results)
// ---------------------------------------------------------------------------

/** Bits of the first metadata type byte that name a collection kind. */
const COLLECTION_KIND_MASK = 0x60;
const COLLECTION_KIND_BY_FLAG: Readonly<Record<number, CUBRIDDataType>> = {
  0x20: CUBRIDDataType.SET,
  0x40: CUBRIDDataType.MULTISET,
  0x60: CUBRIDDataType.SEQUENCE,
};
/** One element-type byte and an int32 element count. */
const COLLECTION_HEADER_SIZE = 5;
/** The response code and the int32 after it: every reply, even an error, has both. */
const MIN_REPLY_SIZE = SIZE_INT * 2;
/** A LOB cell starts with int32 db_type, int64 size and int32 locator length. */
const LOB_HANDLE_HEADER_SIZE = SIZE_INT + SIZE_LONG + SIZE_INT;
/** The handle's own db_type, a different number from the column's wire type. */
const LOB_DB_TYPE_BLOB = 33;
const LOB_DB_TYPE_CLOB = 34;

/**
 * A value this driver has no decoder for, in a reply that is otherwise intact:
 * the whole reply was walked, so the session stays usable. Not exported: `name`
 * is how callers recognize it, so it is public contract (docs/API_STABILITY.md).
 */
export class UnsupportedValueError extends Error {
  override name = "UnsupportedValueError";
}

/**
 * A reply that contradicts its own structure. Nothing in it can be trusted,
 * including the frame length that keeps the stream aligned on the next reply,
 * so the caller must drop the session and must not send on it again. Not
 * exported: `name` is public contract, as for UnsupportedValueError.
 */
export class MalformedReplyError extends Error {
  override name = "MalformedReplyError";
}

/** Run a reply decoder, reporting any failure that is not a known verdict as malformed. */
function decodeReply<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (
      error instanceof UnsupportedValueError ||
      error instanceof MalformedReplyError ||
      error instanceof CasReplyError
    ) {
      throw error;
    }
    throw new MalformedReplyError((error as Error).message, { cause: error });
  }
}

function assertReplySize(data: Buffer): void {
  if (data.length < MIN_REPLY_SIZE) {
    throw new MalformedReplyError(`Malformed CAS packet: reply of ${data.length} bytes`);
  }
}

export interface ColumnMeta {
  /** Column type. A collection column holds its kind: SET, MULTISET or SEQUENCE. */
  type: CUBRIDDataType;
  /**
   * Declared element type of a collection column; undefined for other columns.
   * It is NULL (0) for a collection without one domain, such as a bare `SET`,
   * and each cell states the element type its values actually use.
   */
  elementType?: CUBRIDDataType;
  scale: number;
  precision: number;
  name: string;
  realName: string;
  tableName: string;
  isNullable: boolean;
  defaultValue: string;
  isAutoIncrement: boolean;
  isUniqueKey: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * Build ClientInfoExchange packet (10 bytes, unframed).
 * Sent to broker to initiate connection.
 *
 * When `useSsl` is true the SSL magic ("CUBRS") is emitted instead of the
 * normal magic ("CUBRK"), signaling the broker/CAS to expect a TLS upgrade.
 */
export function writeClientInfoExchange(useSsl = false): Buffer {
  const w = new PacketWriter(10);
  const magic = Buffer.from(useSsl ? CAS_MAGIC_SSL : CAS_MAGIC, "ascii");
  w.writeBytes(magic);
  w.writeByte(CLIENT_JDBC);
  w.writeByte(CAS_VERSION);
  w.writeByte(0);
  w.writeByte(0);
  w.writeByte(0);
  return w.toBuffer();
}

/**
 * Parse ClientInfoExchange response (4 bytes).
 * Returns the CAS redirect port. If 0, reuse the broker socket.
 * If negative, connection was rejected.
 */
export function parseClientInfoExchange(data: Buffer): number {
  return data.readInt32BE(0);
}

/**
 * Build OpenDatabase request (628 bytes, unframed).
 */
export function writeOpenDatabase(
  database: string,
  user: string,
  password: string,
): Buffer {
  const w = new PacketWriter(
    OPEN_DB_FIELD_SIZE * 3 + OPEN_DB_FILLER_SIZE + OPEN_DB_RESERVED_SIZE,
  );
  w.writeFixedString(database, OPEN_DB_FIELD_SIZE);
  w.writeFixedString(user, OPEN_DB_FIELD_SIZE);
  w.writeFixedString(password, OPEN_DB_FIELD_SIZE);
  // Extended info filler (512 bytes of zeros)
  w.writeBytes(Buffer.alloc(OPEN_DB_FILLER_SIZE));
  // Reserved filler (20 bytes of zeros)
  w.writeBytes(Buffer.alloc(OPEN_DB_RESERVED_SIZE));
  return w.toBuffer();
}

export interface OpenDatabaseResult {
  casInfo: Buffer;
  responseCode: number;
  protoVersion: number;
  sessionId: number;
}

/**
 * Parse OpenDatabase response.
 * Data starts with CAS_INFO, then the response payload.
 */
export function parseOpenDatabase(data: Buffer): OpenDatabaseResult {
  const reader = new PacketReader(data);
  const casInfo = reader.parseCASInfo();
  const responseCode = reader.parseInt();

  if (responseCode < 0) {
    const remaining = data.length - SIZE_CAS_INFO - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID connection failed (${err.code}): ${err.message || "Unknown error"}`,
      responseCode,
      err.code,
    );
  }

  const brokerBytes = reader.parseBytes(SIZE_BROKER_INFO);
  const serverVersion = brokerBytes[4]! & 0x3f;
  // Use the minimum of server version and our client version for parsing.
  // The server formats responses based on the client's declared version.
  const protoVersion = Math.min(serverVersion, CAS_PROTOCOL_VERSION);
  const sessionId = reader.parseInt();

  return { casInfo, responseCode, protoVersion, sessionId };
}

// ---------------------------------------------------------------------------
// PrepareAndExecute (FC=41)
// ---------------------------------------------------------------------------

/**
 * Build PREPARE_AND_EXECUTE request payload.
 */
export function writePrepareAndExecute(
  sql: string,
  autoCommit: boolean,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(512);
  w.writeByte(CASFunctionCode.PREPARE_AND_EXECUTE);
  w.addInt(3); // arg count
  w.writeNullTermString(sql);
  w.addByte(PREPARE_NORMAL);
  w.addByte(autoCommit ? 1 : 0);
  w.addByte(EXECUTE_QUERY_ALL);
  w.addInt(0); // max_col_size
  w.addInt(0); // max_row_size
  w.writeInt(0); // NULL bind params
  w.writeInt(SIZE_LONG); // cache time length
  w.writeInt(0); // cache time sec
  w.writeInt(0); // cache time usec
  w.addInt(0); // query timeout

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

export interface PrepareResult {
  queryHandle: number;
  statementType: StatementType;
  /** Markers the server counted in the SQL, over every statement of a `a; b` string. */
  bindCount: number;
  columnCount: number;
  columns: ColumnMeta[];
}

export interface PrepareAndExecuteResult extends PrepareResult {
  totalTupleCount: number;
  /** One entry per statement the request ran; more than one for `a; b`. */
  resultInfos: ResultInfo[];
  rows: Record<string, unknown>[];
}

/**
 * Parse PREPARE_AND_EXECUTE response.
 */
export function parsePrepareAndExecute(
  data: Buffer,
  protoVersion: number,
  utcDates = false,
): PrepareAndExecuteResult {
  assertReplySize(data);
  const reader = new PacketReader(data, 0, utcDates);
  const responseCode = reader.parseInt();

  if (responseCode < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID query failed (${err.code}): ${err.message}`,
      responseCode,
      err.code,
    );
  }

  return decodeReply(() => readExecuteReply(reader, responseCode, protoVersion));
}

function readExecuteReply(
  reader: PacketReader,
  queryHandle: number,
  protoVersion: number,
): PrepareAndExecuteResult {
  const statement = readPrepareInfo(reader, queryHandle);
  return readExecution(reader, statement, reader.parseInt(), protoVersion, false);
}

/** The statement description shared by PREPARE, PREPARE_AND_EXECUTE and a refreshed EXECUTE. */
function readPrepareInfo(reader: PacketReader, queryHandle: number): PrepareResult {
  reader.parseInt(); // result cache lifetime
  const statementType = reader.parseByte() as StatementType;
  const bindCount = reader.parseInt();
  reader.parseByte(); // is_updatable
  const columnCount = reader.parseInt();
  const columns = parseColumnMetadata(reader, columnCount);

  return { queryHandle, statementType, bindCount, columnCount, columns };
}

/**
 * The execute portion of a reply, after its total tuple count.
 *
 * `prepared` marks an EXECUTE reply. Only that reply can replace the statement
 * description: the CAS sends a new one after a multi-statement string, before
 * the shard id, and skipping it would misread everything behind it.
 */
function readExecution(
  reader: PacketReader,
  statement: PrepareResult,
  totalTupleCount: number,
  protoVersion: number,
  prepared: boolean,
): PrepareAndExecuteResult {
  reader.parseByte(); // cache_reusable
  const resultCount = reader.parseInt();
  const resultInfos = parseResultInfos(reader, resultCount, prepared);

  // Both trailer fields are required by the protocol version. A reply cut off
  // before them is malformed, never a success to commit.
  let current = statement;
  if (protoVersion > 1) {
    const includesColumnInfo = reader.parseByte(); // includes_column_info
    if (prepared) {
      if (includesColumnInfo !== 0 && includesColumnInfo !== 1) {
        throw new MalformedReplyError(
          `Malformed CAS packet: column info flag ${includesColumnInfo}`,
        );
      }
      if (includesColumnInfo === 1) {
        current = readPrepareInfo(reader, statement.queryHandle);
      }
    }
  }
  if (protoVersion > 4) {
    reader.parseInt(); // shard_id
  }

  // Inline fetch (for SELECT statements)
  const { columns, statementType } = current;
  const rows: Record<string, unknown>[] = [];
  if (statementType === StatementType.SELECT && reader.remaining > 0) {
    const fetchCode = reader.parseInt();
    if (fetchCode >= 0) {
      const tupleCount = reader.parseInt();
      if (tupleCount > 0) {
        parseRowData(reader, columns, tupleCount, rows, false);
      }
    }
  }

  return { ...current, totalTupleCount, resultInfos, rows };
}

/**
 * Read the query handle from a PREPARE_AND_EXECUTE response without decoding
 * the rest of it, so the handle can still be released if decoding fails.
 * The caller must close the handle on its owning CAS session, never after an
 * automatic reconnect where the same number could identify another request.
 * Returns null when the response holds none: a server error, or too few bytes.
 */
export function readQueryHandle(data: Buffer): number | null {
  if (data.length < SIZE_INT) {
    return null;
  }

  const responseCode = data.readInt32BE(0);
  return responseCode >= 0 ? responseCode : null;
}

// ---------------------------------------------------------------------------
// Prepare (FC=2) and Execute (FC=3)
// ---------------------------------------------------------------------------

/**
 * Build PREPARE request payload. The autocommit byte is always 0: the caller
 * ends the transaction itself, so CAS_INFO stays IN_TRAN while the handle lives.
 */
export function writePrepare(sql: string, casInfo: Buffer): { header: Buffer; payload: Buffer } {
  assertPreparableSql(sql);

  const w = new PacketWriter(512);
  w.writeByte(CASFunctionCode.PREPARE);
  w.writeNullTermString(sql);
  w.addByte(PREPARE_NORMAL);
  w.addByte(0); // autocommit

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/** The CAS reads SQL up to the first NUL, so the rest would silently not run. */
export function assertPreparableSql(sql: string): void {
  if (sql.includes("\0")) {
    throw new Error("SQL text contains a null byte (0x00), which CUBRID cannot prepare");
  }
}

/** Parse PREPARE response. */
export function parsePrepare(data: Buffer): PrepareResult {
  assertReplySize(data);
  const reader = new PacketReader(data);
  const responseCode = reader.parseInt();

  if (responseCode < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID query failed (${err.code}): ${err.message}`,
      responseCode,
      err.code,
    );
  }

  return decodeReply(() => readPrepareInfo(reader, responseCode));
}

/**
 * Build EXECUTE request payload for a prepared handle.
 *
 * EXECUTE_QUERY_ALL matches PREPARE_AND_EXECUTE: with the plain flag the CAS
 * runs only the first statement of `a; b` and reports success (seen on live
 * brokers), so the later statements would be lost without an error.
 */
export function writeExecute(
  statement: PrepareResult,
  binds: PreparedBinds,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(512 + binds.bytes.length);
  w.writeByte(CASFunctionCode.EXECUTE);
  w.addInt(statement.queryHandle);
  w.addByte(EXECUTE_QUERY_ALL);
  w.addInt(0); // max_col_size
  w.addInt(0); // max_row_size
  w.writeInt(0); // empty CALL-mode argument
  w.addByte(statement.statementType === StatementType.SELECT ? 1 : 0); // inline fetch
  w.addByte(0); // autocommit: see writePrepare()
  w.addByte(0); // forward_only
  w.writeInt(SIZE_LONG); // cache time length
  w.writeInt(0); // cache time sec
  w.writeInt(0); // cache time usec
  w.addInt(0); // query timeout
  w.writeBytes(binds.bytes);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/**
 * Parse EXECUTE response. Its first int is the tuple count, not a handle: the
 * handle stays the one PREPARE returned.
 */
export function parseExecute(
  data: Buffer,
  statement: PrepareResult,
  protoVersion: number,
  utcDates = false,
): PrepareAndExecuteResult {
  assertReplySize(data);
  const reader = new PacketReader(data, 0, utcDates);
  const responseCode = reader.parseInt();

  if (responseCode < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID query failed (${err.code}): ${err.message}`,
      responseCode,
      err.code,
    );
  }

  return decodeReply(() => readExecution(reader, statement, responseCode, protoVersion, true));
}

// ---------------------------------------------------------------------------
// Fetch (FC=8)
// ---------------------------------------------------------------------------

/**
 * Build FETCH request payload.
 */
export function writeFetch(
  queryHandle: number,
  currentTupleCount: number,
  fetchSize: number,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(64);
  w.writeByte(CASFunctionCode.FETCH);
  w.addInt(queryHandle);
  w.addInt(currentTupleCount + 1); // 1-based start position
  w.addInt(fetchSize);
  w.addByte(0); // case_sensitive
  w.addInt(0); // resultset_index

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

export interface FetchResult {
  tupleCount: number;
  rows: Record<string, unknown>[];
}

/**
 * Parse FETCH response.
 */
export function parseFetch(
  data: Buffer,
  columns: ColumnMeta[],
  utcDates = false,
): FetchResult {
  assertReplySize(data);
  const reader = new PacketReader(data, 0, utcDates);
  const responseCode = reader.parseInt();

  if (responseCode < 0) {
    // -1 is the CAS error envelope, not an unconditional EOF marker.
    // For example, an invalid query handle reports -1 with a server code.
    // A genuine exhaustion error is also not expected while the execute
    // response still advertises additional tuples.
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID fetch failed (${err.code}): ${err.message}`,
      responseCode,
      err.code,
    );
  }

  return decodeReply(() => {
    const tupleCount = reader.parseInt();
    const rows: Record<string, unknown>[] = [];
    if (tupleCount > 0) {
      parseRowData(reader, columns, tupleCount, rows, false);
    }

    return { tupleCount, rows };
  });
}

// ---------------------------------------------------------------------------
// CloseReqHandle (FC=6)
// ---------------------------------------------------------------------------

export function writeCloseReqHandle(
  queryHandle: number,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(16);
  w.writeByte(CASFunctionCode.CLOSE_REQ_HANDLE);
  w.addInt(queryHandle);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

// ---------------------------------------------------------------------------
// EndTran (FC=1) — commit/rollback
// ---------------------------------------------------------------------------

export function writeEndTran(
  txType: number,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(16);
  w.writeByte(CASFunctionCode.END_TRAN);
  w.addByte(txType);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

// ---------------------------------------------------------------------------
// SetDbParameter (FC=5)
// ---------------------------------------------------------------------------

export function writeSetDbParameter(
  parameter: number,
  value: number,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(32);
  w.writeByte(CASFunctionCode.SET_DB_PARAMETER);
  w.addInt(parameter);
  w.addInt(value);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

// ---------------------------------------------------------------------------
// GetDbVersion (FC=15)
// ---------------------------------------------------------------------------

export function writeGetDbVersion(
  autoCommit: boolean,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(16);
  w.writeByte(CASFunctionCode.GET_DB_VERSION);
  w.addByte(autoCommit ? 1 : 0);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

export function parseGetDbVersion(data: Buffer): string {
  const reader = new PacketReader(data);
  const code = reader.parseInt();

  if (code < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID getDbVersion failed (${err.code}): ${err.message}`,
      code,
      err.code,
    );
  }

  const versionLen = data.length - SIZE_INT;
  return reader.parseNullTermString(versionLen);
}

// ---------------------------------------------------------------------------
// ConClose (FC=31)
// ---------------------------------------------------------------------------

export function writeConClose(
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(8);
  w.writeByte(CASFunctionCode.CON_CLOSE);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

// ---------------------------------------------------------------------------
// CheckCas (FC=32)
// ---------------------------------------------------------------------------

export function writeCheckCas(casInfo: Buffer): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(8);
  w.writeByte(CASFunctionCode.CHECK_CAS);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/** A live CAS answers with no body at all; a failure has the usual error layout. */
export function parseCheckCas(data: Buffer): void {
  if (data.length > 0) {
    parseSimpleResponse(data);
  }
}

// ---------------------------------------------------------------------------
// GetLastInsertId (FC=40)
// ---------------------------------------------------------------------------

export function writeGetLastInsertId(casInfo: Buffer): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(8);
  w.writeByte(CASFunctionCode.GET_LAST_INSERT_ID);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/**
 * The session's last generated AUTO_INCREMENT value as decimal text, or
 * undefined when the server holds none. The value is a cell: an int32 size that
 * counts a type header (one byte, or two when the first has bit 0x80), then the
 * digits and a NUL.
 */
export function parseGetLastInsertId(data: Buffer): string | undefined {
  assertReplySize(data);
  const reader = new PacketReader(data);
  const code = reader.parseInt();

  if (code < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID getLastInsertId failed (${err.code}): ${err.message}`,
      code,
      err.code,
    );
  }

  return decodeReply(() => {
    const size = reader.parseInt();
    // Only -1 means "no value"; the broker never sends another size below 1.
    if (size === -1) {
      return undefined;
    }
    if (size < 1) {
      throw new MalformedReplyError(`Malformed CAS packet: last insert id size ${size}`);
    }
    const cell = reader.subReader(size);
    const headerSize = (cell.parseUByte() & 0x80) === 0 ? 1 : 2;
    if (headerSize === 2) {
      cell.parseUByte();
    }
    const text = cell.parseNullTermString(size - headerSize);
    return text === "" ? undefined : text;
  });
}

// ---------------------------------------------------------------------------
// Simple response parser (for EndTran, CloseReqHandle, etc.)
// ---------------------------------------------------------------------------

export function parseSimpleResponse(data: Buffer): void {
  const reader = new PacketReader(data);
  const code = reader.parseInt();

  if (code < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new CasReplyError(
      `CUBRID operation failed (${err.code}): ${err.message}`,
      code,
      err.code,
    );
  }
}

// ---------------------------------------------------------------------------
// LOB_READ (FC=37)
// ---------------------------------------------------------------------------

/**
 * A BLOB or CLOB cell as the server sends it: not the content but the content's
 * size and the server's file locator. `NativeCubridAdapter` replaces it with the
 * content before a row leaves the driver, so `handle` never reaches a caller:
 * it names a path on the server and is not the column's value.
 */
export class LobLocator {
  constructor(
    readonly type: CUBRIDDataType.BLOB | CUBRIDDataType.CLOB,
    readonly size: number,
    readonly handle: Buffer,
  ) {}
}

/** True for a column whose cells can decode to a LobLocator. */
export function mayHoldLob(column: ColumnMeta): boolean {
  // A NULL-typed column states each cell's type in the cell itself.
  return (
    column.type === CUBRIDDataType.BLOB ||
    column.type === CUBRIDDataType.CLOB ||
    column.type === CUBRIDDataType.NULL
  );
}

/**
 * Build a LOB_READ request. `length` must not be 0: CUBRID 10.2 to 11.4 answer
 * a zero-length read with error -185 and that session then fails every request.
 */
export function writeLobRead(
  handle: Buffer,
  offset: number,
  length: number,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(handle.length + 32);
  w.writeByte(CASFunctionCode.LOB_READ);
  w.addBytes(handle);
  w.addLong(BigInt(offset));
  w.addInt(length);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/**
 * Parse a LOB_READ reply: an int32 count, then exactly that many bytes. A count
 * of 0 is the end of the file and has no second int32, unlike other replies.
 */
export function parseLobRead(data: Buffer, requested: number): Buffer {
  if (data.length < SIZE_INT) {
    throw new MalformedReplyError(`Malformed CAS packet: reply of ${data.length} bytes`);
  }

  const reader = new PacketReader(data);
  const count = reader.parseInt();

  if (count < 0) {
    const err = decodeReply(() => reader.readError(data.length - SIZE_INT));
    throw new CasReplyError(
      `CUBRID LOB read failed (${err.code}): ${err.message}`,
      count,
      err.code,
    );
  }
  if (count > requested || count !== reader.remaining) {
    throw new MalformedReplyError(
      `Malformed CAS packet: LOB read of ${requested} bytes reported ${count} ` +
        `and carried ${reader.remaining}`,
    );
  }

  return data.subarray(SIZE_INT);
}

// ---------------------------------------------------------------------------
// Bind parameter encoding
// ---------------------------------------------------------------------------

/**
 * Encode bind parameters for the CAS protocol.
 * Each parameter is encoded as: int32(size) + byte(type) + value_bytes
 * NULL is encoded as int32(0).
 */
export function encodeBindParams(params: readonly unknown[]): Buffer {
  const w = new PacketWriter(256);

  for (const param of params) {
    encodeOneParam(w, param);
  }

  return w.toBuffer();
}

function encodeOneParam(w: PacketWriter, value: unknown): void {
  if (value === null || value === undefined) {
    w.writeInt(0); // NULL
    return;
  }

  if (typeof value === "boolean") {
    w.writeInt(1 + SIZE_SHORT);
    w.writeByte(CUBRIDDataType.SHORT);
    w.writeShort(value ? 1 : 0);
    return;
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      // Check if fits in int32
      if (value >= -2147483648 && value <= 2147483647) {
        w.writeInt(1 + SIZE_INT);
        w.writeByte(CUBRIDDataType.INT);
        w.writeInt(value);
      } else {
        w.writeInt(1 + SIZE_LONG);
        w.writeByte(CUBRIDDataType.BIGINT);
        w.writeLong(BigInt(value));
      }
    } else {
      w.writeInt(1 + SIZE_DOUBLE);
      w.writeByte(CUBRIDDataType.DOUBLE);
      w.writeDouble(value);
    }
    return;
  }

  if (typeof value === "bigint") {
    w.writeInt(1 + SIZE_LONG);
    w.writeByte(CUBRIDDataType.BIGINT);
    w.writeLong(value);
    return;
  }

  if (typeof value === "string") {
    const encoded = Buffer.from(value, "utf-8");
    w.writeInt(1 + encoded.length + 1); // type byte + string bytes + null terminator
    w.writeByte(CUBRIDDataType.STRING);
    w.writeBytes(encoded);
    w.writeByte(0); // null terminator
    return;
  }

  if (value instanceof Date) {
    w.writeInt(1 + SIZE_DATETIME);
    w.writeByte(CUBRIDDataType.DATETIME);
    w.writeShort(value.getFullYear());
    w.writeShort(value.getMonth() + 1);
    w.writeShort(value.getDate());
    w.writeShort(value.getHours());
    w.writeShort(value.getMinutes());
    w.writeShort(value.getSeconds());
    w.writeShort(value.getMilliseconds());
    return;
  }

  if (Buffer.isBuffer(value)) {
    w.writeInt(1 + value.length);
    w.writeByte(CUBRIDDataType.VARBIT);
    w.writeBytes(value);
    return;
  }

  // Fallback: stringify
  const str = String(value);
  const encoded = Buffer.from(str, "utf-8");
  w.writeInt(1 + encoded.length + 1);
  w.writeByte(CUBRIDDataType.STRING);
  w.writeBytes(encoded);
  w.writeByte(0);
}

// ---------------------------------------------------------------------------
// Prepared bind encoding (EXECUTE)
// ---------------------------------------------------------------------------

export interface PreparedBinds {
  count: number;
  /** One length-prefixed type byte and one length-prefixed value per parameter. */
  bytes: Buffer;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** NUMERIC holds 38 digits. */
const NUMERIC_LIMIT = 10n ** 38n;
const MIN_DATETIME_YEAR = 1;
const MAX_DATETIME_YEAR = 9999;

/**
 * Encode parameters as typed EXECUTE binds, refusing before anything is sent
 * every value the server would store wrongly or the literal path would refuse.
 * Messages never contain the value.
 */
export function encodePreparedParams(params: readonly unknown[]): PreparedBinds {
  const w = new PacketWriter(256);
  for (const param of params) {
    writePreparedParam(w, param);
  }
  return { count: params.length, bytes: Buffer.from(w.toBuffer()) };
}

function writePreparedParam(w: PacketWriter, value: unknown): void {
  if (value === null || value === undefined) {
    w.addByte(CUBRIDDataType.NULL);
    w.addNull();
    return;
  }

  if (typeof value === "boolean") {
    // The literal path renders 1 or 0, which are INTEGER literals.
    w.addByte(CUBRIDDataType.INT);
    w.addInt(value ? 1 : 0);
    return;
  }

  if (typeof value === "number") {
    writePreparedNumber(w, value);
    return;
  }

  if (typeof value === "bigint") {
    writePreparedBigint(w, value);
    return;
  }

  if (typeof value === "string") {
    assertStorableText(value);
    w.addByte(CUBRIDDataType.CHAR);
    w.writeNullTermString(value);
    return;
  }

  if (value instanceof Date) {
    writePreparedDate(w, value);
    return;
  }

  if (Buffer.isBuffer(value)) {
    // X'' is valid SQL, but the CAS reads a zero-length bind as SQL NULL.
    if (value.length === 0) {
      throw new Error("an empty Buffer cannot be sent as a prepared parameter: it would be NULL");
    }
    w.addByte(CUBRIDDataType.VARBIT);
    w.addBytes(value);
    return;
  }

  throw new Error(`unsupported prepared parameter type: ${typeof value}`);
}

/**
 * A number past the safe range goes as DOUBLE, the value it really is: its
 * decimal text and the integer it is closest to can differ.
 */
function writePreparedNumber(w: PacketWriter, value: number): void {
  // The broker stores NaN without complaint; the literal path gets a server error.
  if (!Number.isFinite(value)) {
    throw new Error("NaN and Infinity are not supported as a prepared parameter");
  }

  if (!Number.isSafeInteger(value)) {
    w.addByte(CUBRIDDataType.DOUBLE);
    w.addDouble(value);
  } else if (value >= INT32_MIN && value <= INT32_MAX) {
    w.addByte(CUBRIDDataType.INT);
    w.addInt(value);
  } else {
    w.addByte(CUBRIDDataType.BIGINT);
    w.addLong(BigInt(value));
  }
}

function writePreparedBigint(w: PacketWriter, value: bigint): void {
  if (value >= INT64_MIN && value <= INT64_MAX) {
    w.addByte(CUBRIDDataType.BIGINT);
    w.addLong(value);
    return;
  }

  if (value <= -NUMERIC_LIMIT || value >= NUMERIC_LIMIT) {
    throw new Error("bigint parameter needs more than 38 digits, which NUMERIC cannot hold");
  }
  // The CAS counts every character but the sign and the point as precision, so
  // only plain integer digits are sent: no leading zero can use one up.
  w.addByte(CUBRIDDataType.NUMERIC);
  w.writeNullTermString(value.toString());
}

/**
 * Always the 14-byte DATETIME layout, using UTC components as the literal path
 * does. Only DATETIME is sent: JavaScript has no date-only or time-only value,
 * and the CAS reads TIME at offset 6 without checking the length.
 */
function writePreparedDate(w: PacketWriter, value: Date): void {
  const year = value.getUTCFullYear();
  if (Number.isNaN(year)) {
    throw new Error("an invalid Date cannot be sent as a prepared parameter");
  }
  if (year < MIN_DATETIME_YEAR || year > MAX_DATETIME_YEAR) {
    throw new Error("Date parameter is outside the DATETIME years 0001 to 9999");
  }

  w.addByte(CUBRIDDataType.DATETIME);
  w.writeInt(SIZE_DATETIME);
  w.writeShort(year);
  w.writeShort(value.getUTCMonth() + 1);
  w.writeShort(value.getUTCDate());
  w.writeShort(value.getUTCHours());
  w.writeShort(value.getUTCMinutes());
  w.writeShort(value.getUTCSeconds());
  w.writeShort(value.getUTCMilliseconds());
}

// ---------------------------------------------------------------------------
// Client-side SQL parameter interpolation
// ---------------------------------------------------------------------------

/**
 * Interpolate parameters into SQL string (client-side).
 *
 * CUBRID's CAS protocol does not reliably support server-side bind
 * parameters for all drivers, so we use client-side interpolation
 * (same approach as cubrid-go and node-cubrid).
 */
export function interpolateParams(
  sql: string,
  params: readonly unknown[],
  noBackslashEscapes: boolean,
): string {
  let paramIndex = 0;
  let result = "";
  let inSingleQuotedString = false;
  let inDoubleQuotedString = false;
  let inBlockComment = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = i + 1 < sql.length ? sql[i + 1]! : "";

    if (inSingleQuotedString) {
      result += ch;

      if (ch === "\\" && next !== "") {
        result += next;
        i++;
        continue;
      }

      if (ch === "'") {
        if (next === "'") {
          result += next;
          i++;
          continue;
        }
        inSingleQuotedString = false;
      }

      continue;
    }

    if (inDoubleQuotedString) {
      result += ch;

      if (ch === "\\" && next !== "") {
        result += next;
        i++;
        continue;
      }

      if (ch === '"') {
        if (next === '"') {
          result += next;
          i++;
          continue;
        }
        inDoubleQuotedString = false;
      }

      continue;
    }

    if (inBlockComment) {
      result += ch;
      if (ch === "*" && next === "/") {
        result += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (inLineComment) {
      result += ch;
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingleQuotedString = true;
      result += ch;
      continue;
    }

    if (ch === '"') {
      inDoubleQuotedString = true;
      result += ch;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      result += ch;
      result += next;
      i++;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      result += ch;
      result += next;
      i++;
      continue;
    }

    if (ch === "?") {
      if (paramIndex >= params.length) {
        throw new Error(
          `Not enough parameters: expected at least ${paramIndex + 1}, got ${params.length}`,
        );
      }
      result += formatValue(params[paramIndex]!, noBackslashEscapes);
      paramIndex++;
      continue;
    }

    result += ch;
  }

  return result;
}

/**
 * Format a JavaScript value as a SQL literal.
 */
export function formatValue(value: unknown, noBackslashEscapes: boolean): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "string") {
    return escapeString(value, noBackslashEscapes);
  }

  if (value instanceof Date) {
    return formatDatetime(value);
  }

  if (Buffer.isBuffer(value)) {
    return `X'${value.toString("hex")}'`;
  }

  return escapeString(String(value), noBackslashEscapes);
}

/**
 * Escape a string as a complete CUBRID SQL literal (including the surrounding
 * single quotes).
 *
 * CUBRID's escaping is MODE-DEPENDENT, governed by the server system parameter
 * `no_backslash_escapes` (default `yes`). The caller MUST pass the negotiated
 * mode (see `NativeCubridAdapter` / `SELECT CHAR_LENGTH('\\')` probe):
 *
 *   - `noBackslashEscapes = true`  (literal mode, the CUBRID default): the
 *     backslash is an ordinary character. Only the single quote is special and
 *     is doubled (`'` -> `''`). Backslashes, newlines, and carriage returns are
 *     preserved verbatim. This is the ANSI-SQL behaviour.
 *   - `noBackslashEscapes = false` (escape mode): backslash introduces escape
 *     sequences, so `\` is doubled and `\r` / `\n` are backslash-escaped, in
 *     addition to doubling `'`.
 *
 * NUL (`\x00`) and Ctrl-Z (`\x1a`) are ALWAYS rejected: CUBRID does not accept
 * a NUL inside a string literal, and its SQL grammar defines no safe literal
 * escape for `0x1A` (there is no MySQL-style `\Z`), so emitting either as a
 * raw control byte would corrupt the statement. Callers should use binary
 * (`X'..'`) encoding for values that may contain these bytes.
 */
function escapeString(value: string, noBackslashEscapes: boolean): string {
  assertStorableText(value);

  if (noBackslashEscapes) {
    // Literal mode (CUBRID default): only the single quote is special.
    return `'${value.replace(/'/g, "''")}'`;
  }

  // Escape mode: backslash is an escape introducer.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\r/g, "\\\r")
    .replace(/\n/g, "\\\n");
  return `'${escaped}'`;
}

/** Text the literal path refuses, which the prepared path refuses too. */
function assertStorableText(value: string): void {
  if (value.includes("\0")) {
    throw new Error("string parameter contains a null byte (0x00), which CUBRID cannot store in a string literal");
  }
  if (value.includes("\x1a")) {
    throw new Error("string parameter contains a Ctrl-Z byte (0x1A), which has no safe CUBRID string-literal escape");
  }
}

function formatDatetime(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `DATETIME'${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}'`;
}

// ---------------------------------------------------------------------------
// Column metadata parser
// ---------------------------------------------------------------------------

/**
 * Read a column's type. Bit 0x80 of the first byte announces a second byte that
 * holds the type; the first byte then carries the collection kind in bits 0x60
 * and the charset in its low bits, so the kind must be kept from it before the
 * second byte is read as the element type. CUBRID 10.2-11.4 send 0xa0 0x08 for
 * SET OF INT and 0xc3 0x02 for MULTISET OF VARCHAR.
 */
function parseColumnType(reader: PacketReader): {
  type: CUBRIDDataType;
  elementType?: CUBRIDDataType;
} {
  const first = reader.parseUByte();
  if ((first & 0x80) === 0) {
    return { type: first as CUBRIDDataType };
  }

  const wireType = reader.parseUByte() as CUBRIDDataType;
  const kind = COLLECTION_KIND_BY_FLAG[first & COLLECTION_KIND_MASK];
  return kind === undefined ? { type: wireType } : { type: kind, elementType: wireType };
}

function parseColumnMetadata(
  reader: PacketReader,
  count: number,
): ColumnMeta[] {
  const columns: ColumnMeta[] = [];

  for (let i = 0; i < count; i++) {
    const { type, elementType } = parseColumnType(reader);

    const scale = reader.parseShort();
    const precision = reader.parseInt();

    const nameLen = reader.parseInt();
    const name = reader.parseNullTermString(nameLen);

    const realNameLen = reader.parseInt();
    const realName = reader.parseNullTermString(realNameLen);

    const tableNameLen = reader.parseInt();
    const tableName = reader.parseNullTermString(tableNameLen);

    // The wire byte is is_non_null: zero permits NULL, nonzero means NOT NULL.
    const isNullable = reader.parseByte() === 0;

    const defaultLen = reader.parseInt();
    const defaultValue = reader.parseNullTermString(defaultLen);

    const isAutoIncrement = reader.parseByte() === 1;
    const isUniqueKey = reader.parseByte() === 1;
    const isPrimaryKey = reader.parseByte() === 1;
    reader.parseByte(); // is_reverse_index (ignored)
    reader.parseByte(); // is_reverse_unique (ignored)
    const isForeignKey = reader.parseByte() === 1;
    reader.parseByte(); // is_shared (ignored)

    columns.push({
      type,
      ...(elementType === undefined ? {} : { elementType }),
      scale,
      precision,
      name,
      realName,
      tableName,
      isNullable,
      defaultValue,
      isAutoIncrement,
      isUniqueKey,
      isPrimaryKey,
      isForeignKey,
    });
  }

  return columns;
}

// ---------------------------------------------------------------------------
// Row data parser
// ---------------------------------------------------------------------------

/**
 * Store a decoded column as an enumerable own property. Plain assignment to the
 * name `__proto__`, which SQL can give any column as an alias, would set the
 * row's prototype instead: the value would vanish from the row's keys, and a
 * NULL would strip the row of its prototype. Only that name takes the slow path.
 */
export function setColumn(row: Record<string, unknown>, name: string, value: unknown): void {
  if (name === "__proto__") {
    Object.defineProperty(row, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }

  row[name] = value;
}

function parseRowData(
  reader: PacketReader,
  columns: ColumnMeta[],
  tupleCount: number,
  rows: Record<string, unknown>[],
  isCallType: boolean,
): void {
  let unsupported: UnsupportedValueError | undefined;

  for (let t = 0; t < tupleCount; t++) {
    // A reply that ends before tupleCount rows overruns the reader and is
    // reported as malformed, never returned as a short result.
    reader.parseInt(); // row index
    reader.skip(SIZE_OID); // OID

    const row: Record<string, unknown> = {};

    for (let c = 0; c < columns.length; c++) {
      let size = reader.parseInt();
      const column = columns[c]!;
      let colType = column.type;
      const hasTypeHeader = isCallType || colType === CUBRIDDataType.NULL;

      // CAS writes SQL NULL as -1, and a collection cell always has its header.
      if (size < -1 || (size === 0 && (isCollectionType(colType) || hasTypeHeader))) {
        throw new Error(
          `Malformed CAS packet: invalid cell length ${size} for column "${column.name}"`,
        );
      }
      if (size === -1) {
        setColumn(row, column.name, null);
        continue;
      }

      // Such a cell states its own type, in the layout of column metadata. This
      // is what a bound `SELECT ?` returns: its column has no type at PREPARE.
      if (hasTypeHeader) {
        const headerStart = reader.position;
        colType = parseColumnType(reader).type;
        size -= reader.position - headerStart;
        if (size < 0) {
          throw new Error(
            `Malformed CAS packet: type header overruns the cell of column "${column.name}"`,
          );
        }
      }

      // An empty bit string is not SQL NULL: it is an empty Buffer (#173).
      if (size === 0 && isBitType(colType)) {
        setColumn(row, column.name, Buffer.alloc(0));
        continue;
      }

      const valueStart = reader.position;
      try {
        const value = readValue(reader, colType, size);
        // A value that disagrees with its cell length would turn the bytes of
        // the following columns into the wrong values.
        assertExactLength(reader.position - valueStart, size);
        // CAS counts the NUL of text and writes fixed widths in full, so a
        // decodable zero-byte value is neither SQL NULL nor an empty value.
        if (size === 0) {
          throw new Error(`Malformed CAS packet: type ${colType} cannot be empty`);
        }
        setColumn(row, column.name, value);
      } catch (error) {
        const message =
          `Failed to decode CUBRID column "${column.name}" (wire type ${colType}, ${size} bytes)`;
        if (!(error instanceof UnsupportedValueError)) {
          throw new MalformedReplyError(message, { cause: error });
        }
        // Keep walking: the session is only safe to reuse if the rest of the
        // reply holds together, and a later structural failure must win.
        unsupported ??= new UnsupportedValueError(message, { cause: error });
        reader.skip(valueStart + size - reader.position);
      }
    }

    rows.push(row);
  }

  if (unsupported) {
    throw unsupported;
  }
}

function readValue(
  reader: PacketReader,
  colType: CUBRIDDataType,
  size: number,
): unknown {
  switch (colType) {
    case CUBRIDDataType.CHAR:
    case CUBRIDDataType.STRING:
    case CUBRIDDataType.NCHAR:
    case CUBRIDDataType.VARNCHAR:
    case CUBRIDDataType.ENUM:
      return reader.parseNullTermString(size);

    case CUBRIDDataType.SHORT:
      return reader.parseShort();

    case CUBRIDDataType.INT:
      return reader.parseInt();

    case CUBRIDDataType.BIGINT:
      return reader.parseLong();

    case CUBRIDDataType.FLOAT:
      return reader.parseFloat();

    case CUBRIDDataType.DOUBLE:
    case CUBRIDDataType.MONETARY:
      return reader.parseDouble();

    case CUBRIDDataType.NUMERIC:
      return reader.parseNullTermString(size);

    case CUBRIDDataType.DATE:
      rejectZeroDate(reader, size, SIZE_SHORT * 3);
      return reader.parseDate();

    case CUBRIDDataType.TIME:
      return reader.parseTime();

    case CUBRIDDataType.DATETIME:
      rejectZeroDate(reader, size, SIZE_DATETIME);
      return reader.parseDatetime();

    case CUBRIDDataType.TIMESTAMP:
      rejectZeroDate(reader, size, SIZE_SHORT * 6);
      return reader.parseTimestamp();

    case CUBRIDDataType.TIMESTAMPTZ:
    case CUBRIDDataType.TIMESTAMPLTZ:
    case CUBRIDDataType.DATETIMETZ:
    case CUBRIDDataType.DATETIMELTZ:
      return readZonedDateTime(reader, colType, size);

    case CUBRIDDataType.BIT:
    case CUBRIDDataType.VARBIT:
      return reader.parseBytes(size);

    case CUBRIDDataType.BLOB:
    case CUBRIDDataType.CLOB:
      return readLobLocator(reader, colType, size);

    case CUBRIDDataType.SET:
    case CUBRIDDataType.MULTISET:
    case CUBRIDDataType.SEQUENCE:
      return readCollection(reader, size);

    case CUBRIDDataType.NULL:
    default:
      // Never turn an unsupported non-NULL wire value into SQL NULL:
      // callers would silently lose data and could persist the wrong result.
      throw new UnsupportedValueError(
        `Unsupported CUBRID CAS value type ${colType} (${size} bytes)`,
      );
  }
}

/**
 * Decode a LOB cell: `[db_type: int32][size: int64][locator length: int32]` and
 * the locator with its NUL. An empty LOB has a locator and size 0; SQL NULL is
 * the usual cell length -1 and never gets here.
 */
function readLobLocator(
  reader: PacketReader,
  colType: CUBRIDDataType.BLOB | CUBRIDDataType.CLOB,
  size: number,
): LobLocator {
  const handle = reader.parseBytes(size);
  if (size < LOB_HANDLE_HEADER_SIZE) {
    throw new Error(`Malformed CAS packet: LOB handle of ${size} bytes has no header`);
  }

  const cell = new PacketReader(handle);
  const dbType = cell.parseInt();
  const lobSize = cell.parseLong();
  const locatorLength = cell.parseInt();
  const expectedDbType = colType === CUBRIDDataType.BLOB ? LOB_DB_TYPE_BLOB : LOB_DB_TYPE_CLOB;

  if (dbType !== expectedDbType) {
    throw new Error(`Malformed CAS packet: LOB db_type ${dbType} in a column of type ${colType}`);
  }
  if (lobSize < 0n || lobSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Malformed CAS packet: LOB size ${lobSize}`);
  }
  assertExactLength(LOB_HANDLE_HEADER_SIZE + locatorLength, size);
  // CAS counts the locator's NUL in its length, so even an empty LOB has one.
  if (locatorLength === 0 || handle[size - 1] !== 0) {
    throw new Error(`Malformed CAS packet: LOB locator of ${locatorLength} bytes has no NUL`);
  }

  return new LobLocator(colType, Number(lobSize), handle);
}

const ZONED_TYPE_NAMES = {
  [CUBRIDDataType.TIMESTAMPTZ]: "TIMESTAMPTZ",
  [CUBRIDDataType.TIMESTAMPLTZ]: "TIMESTAMPLTZ",
  [CUBRIDDataType.DATETIMETZ]: "DATETIMETZ",
  [CUBRIDDataType.DATETIMELTZ]: "DATETIMELTZ",
} as const;

const ZONE_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode a TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ or DATETIMELTZ cell: the fields
 * of the plain type (TIMESTAMP six int16, DATETIME seven) and then the zone as
 * text with its NUL, filling the rest of the cell. The zone is `+09:00` for an
 * offset and `Asia/Seoul KST` for a region, and it stays in the value (#111).
 * The zero date is reported as unsupported like the plain types; every other
 * layout violation is malformed.
 */
function readZonedDateTime(
  reader: PacketReader,
  colType: keyof typeof ZONED_TYPE_NAMES,
  size: number,
): ZonedDateTime {
  const hasMilliseconds =
    colType === CUBRIDDataType.DATETIMETZ || colType === CUBRIDDataType.DATETIMELTZ;
  const fixed = SIZE_SHORT * (hasMilliseconds ? 7 : 6);
  const cell = reader.subReader(size);
  // At least one character of zone text and its NUL must follow the fields.
  if (size < fixed + 2) {
    throw new Error(`Malformed CAS packet: zoned value of ${size} bytes has no zone`);
  }
  const year = cell.parseShort();
  const month = cell.parseShort();
  const day = cell.parseShort();
  const hour = cell.parseShort();
  const minute = cell.parseShort();
  const second = cell.parseShort();
  const millisecond = hasMilliseconds ? cell.parseShort() : 0;
  const zeroDate = year === 0 && month === 0 && day === 0;
  // The time and the zone are checked first, so a damaged zero date is malformed
  // and drops the session instead of being reported as an unsupported value.
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    millisecond < 0 ||
    millisecond > 999
  ) {
    throw new Error(
      `Malformed CAS packet: zoned value time ${hour}:${minute}:${second}.${millisecond} ` +
        "is out of range",
    );
  }

  const zoneBytes = cell.parseBytes(cell.remaining);
  const nul = zoneBytes.indexOf(0);
  if (nul !== zoneBytes.length - 1 || nul === 0) {
    throw new Error("Malformed CAS packet: zone text is empty or not one NUL-terminated string");
  }
  const zone = ZONE_TEXT_DECODER.decode(zoneBytes.subarray(0, nul));

  if (zeroDate) {
    throw new UnsupportedValueError(
      "Zero date 0000-00-00 cannot be represented as a ZonedDateTime",
    );
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
    throw new Error(`Malformed CAS packet: zoned value date ${year}-${month}-${day} does not exist`);
  }

  return new ZonedDateTime({
    type: ZONED_TYPE_NAMES[colType],
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    zone,
  });
}

function isCollectionType(colType: CUBRIDDataType): boolean {
  return (
    colType === CUBRIDDataType.SET ||
    colType === CUBRIDDataType.MULTISET ||
    colType === CUBRIDDataType.SEQUENCE
  );
}

/**
 * The broker sends the zero date `0000-00-00` (DATE, DATETIME and TIMESTAMP) as
 * all-zero fields. `new Date(0, -1, 0)` would turn it into a real-looking 1899
 * instant, and no JavaScript Date can hold it, so report it instead. The value
 * is intact and has its full size, so the session stays usable. Only the exact
 * width of the type counts (DATE 6, DATETIME 14, TIMESTAMP 12): any other width is
 * malformed and falls through to the exact-length check, which drops the session.
 */
function rejectZeroDate(reader: PacketReader, size: number, width: number): void {
  if (size === width && reader.peekZeroDate()) {
    throw new UnsupportedValueError(
      "Zero date 0000-00-00 cannot be represented as a JavaScript Date",
    );
  }
}

function isBitType(colType: CUBRIDDataType): boolean {
  return colType === CUBRIDDataType.BIT || colType === CUBRIDDataType.VARBIT;
}

function assertExactLength(consumed: number, declared: number): void {
  if (consumed !== declared) {
    throw new Error(`Malformed CAS packet: value uses ${consumed} of its ${declared} bytes`);
  }
}

/**
 * Decode one collection cell: an element-type byte, an int32 element count, then
 * an int32 length and the payload of each element. The cell states the element
 * type itself, so it decides over the column metadata: an empty or all-NULL
 * collection sends type 0, and a bare `SET` column declares no element type.
 *
 * Every read is bounded to the cell, so a wrong length rejects the query and can
 * never consume the following columns. An unsupported element does not stop the
 * walk: the reply is only intact if every remaining and nested element fits, so
 * a structural failure wins and a complete collection reports the first
 * unsupported element.
 */
function readCollection(reader: PacketReader, size: number): unknown[] {
  const cell = reader.subReader(size);
  if (size < COLLECTION_HEADER_SIZE) {
    throw new Error(`Malformed CAS packet: collection cell of ${size} bytes has no header`);
  }

  const elementType = cell.parseUByte() as CUBRIDDataType;
  const count = cell.parseInt();
  // Each element has at least a length word; check that before looping on a
  // count that only the sender vouches for.
  if (count < 0 || count * SIZE_INT > cell.remaining) {
    throw new Error(
      `Malformed CAS packet: collection count ${count} does not fit ${cell.remaining} bytes`,
    );
  }

  const values: unknown[] = [];
  let unsupported: UnsupportedValueError | undefined;
  for (let i = 0; i < count; i++) {
    if (cell.remaining < SIZE_INT) {
      throw new Error(`Malformed CAS packet: collection element ${i} has no length`);
    }
    try {
      values.push(readCollectionElement(cell, elementType, cell.parseInt()));
    } catch (error) {
      if (!(error instanceof UnsupportedValueError)) {
        throw error;
      }
      unsupported ??= error;
    }
  }
  assertExactLength(size - cell.remaining, size);
  if (unsupported) {
    throw unsupported;
  }
  return values;
}

function readCollectionElement(
  cell: PacketReader,
  elementType: CUBRIDDataType,
  length: number,
): unknown {
  if (length === -1) {
    return null;
  }
  // BIT and VARBIT are the only encodings that can be empty: text keeps its NUL.
  if (length === 0 && isBitType(elementType)) {
    return Buffer.alloc(0);
  }
  if (length <= 0) {
    throw new Error(
      `Malformed CAS packet: invalid length ${length} for collection element type ${elementType}`,
    );
  }
  // Taken first: the cell must move past this element and a length that
  // overruns it must be structural, whichever way the element is then handled.
  const element = cell.subReader(length);
  // The payload is a file locator, not the LOB content (#93); do not hand a
  // server path to callers as if it were the element value.
  if (elementType === CUBRIDDataType.BLOB || elementType === CUBRIDDataType.CLOB) {
    throw new UnsupportedValueError(`Unsupported CUBRID collection element type ${elementType}`);
  }

  const value = readValue(element, elementType, length);
  assertExactLength(length - element.remaining, length);
  return value;
}

// ---------------------------------------------------------------------------
// Result info parser (used by Execute/PrepareAndExecute)
// ---------------------------------------------------------------------------

export interface ResultInfo {
  statementType: StatementType;
  /** Rows the statement affected (DML) or matched (SELECT). */
  resultCount: number;
}

function parseResultInfos(reader: PacketReader, count: number, prepared = false): ResultInfo[] {
  const infos: ResultInfo[] = [];
  for (let i = 0; i < count; i++) {
    const statementType = reader.parseByte() as StatementType;
    const resultCount = reader.parseInt();
    // An EXECUTE reply can report one statement's failure in place of its result.
    if (prepared && resultCount < 0) {
      const code = reader.parseInt();
      const message = reader.parseNullTermString(reader.parseInt());
      throw new CasReplyError(`CUBRID query failed (${code}): ${message}`, resultCount, code);
    }
    reader.parseBytes(SIZE_OID); // OID (8 bytes)
    reader.parseInt(); // cache time seconds
    reader.parseInt(); // cache time microseconds
    infos.push({ statementType, resultCount });
  }
  return infos;
}
