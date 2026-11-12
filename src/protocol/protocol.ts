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

import { TextDecoder } from "node:util";
import { CasReplyError } from "../errors/internal-errors.js";
import {
  CLOB_NOT_LATIN1,
  isLobParam,
  isSourceConsumed,
  isStreamSource,
  type LobParam,
  LobParamError,
  STREAM_REUSED,
} from "../types/lob.js";
import { ZonedDateTime } from "../types/zoned-date-time.js";
import {
  assertEncodable,
  CAS_CHARSET_EUC_KR,
  CAS_CHARSET_UTF8,
  NOT_LATIN1,
  type TextCharset,
} from "./charset.js";
import {
  CAS_MAGIC,
  CAS_MAGIC_SSL,
  CAS_PROTOCOL_VERSION,
  CAS_VERSION,
  CASFunctionCode,
  CLIENT_JDBC,
  CUBRIDDataType,
  EXECUTE_QUERY_ALL,
  EXECUTE_RETURN_GENERATED_KEYS,
  OPEN_DB_FIELD_SIZE,
  OPEN_DB_FILLER_SIZE,
  OPEN_DB_MAX_VALUE_BYTES,
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
import { PacketReader } from "./packet-reader.js";
import { PacketWriter } from "./packet-writer.js";

// ---------------------------------------------------------------------------
// Column metadata (shared between prepare and execute results)
// ---------------------------------------------------------------------------

/** Bits of the first metadata type byte that name a collection kind. */
const COLLECTION_KIND_MASK = 0x60;
/** Bits of the first metadata type byte that hold the charset code (protocol V7). */
const CHARSET_MASK = 0x07;
const COLLECTION_KIND_BY_FLAG: Readonly<Record<number, CUBRIDDataType>> = {
  32: CUBRIDDataType.SET,
  64: CUBRIDDataType.MULTISET,
  96: CUBRIDDataType.SEQUENCE,
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
  /**
   * Charset code of the column's text, or of a collection's elements, from the
   * low bits of its protocol V7 type; undefined for a one-byte type.
   */
  charset?: number;
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
 * The broker keeps only the first 31 bytes of each OpenDatabase field (see
 * OPEN_DB_MAX_VALUE_BYTES) and stops at a NUL, so a longer value or one holding
 * a NUL would quietly open another database or log in as another user or with
 * another password. createClient(), CubridClient and the adapter check this
 * before connecting, and writeOpenDatabase() before any socket opens. The
 * messages name the field, never its value.
 *
 * Values that are not strings are skipped: CubridClient may serve a connection
 * factory that uses no credentials. writeOpenDatabase() refuses them.
 */
export function assertValidCredentials(credentials: {
  database: unknown;
  user: unknown;
  password: unknown;
}): void {
  for (const field of ["database", "user", "password"] as const) {
    const value = credentials[field];
    if (typeof value !== "string") {
      continue;
    }
    if (value.includes("\0")) {
      throw new RangeError(`${field} must not contain a NUL character.`);
    }
    if (Buffer.byteLength(value, "utf-8") > OPEN_DB_MAX_VALUE_BYTES) {
      throw new RangeError(`${field} must be at most ${OPEN_DB_MAX_VALUE_BYTES} bytes in UTF-8.`);
    }
  }
}

/**
 * Build OpenDatabase request (628 bytes, unframed). Throws on a value the
 * broker would not read intact, see assertValidCredentials(), and on one that
 * is not a string, which Buffer.from() would otherwise accept unchecked.
 */
export function writeOpenDatabase(database: string, user: string, password: string): Buffer {
  const credentials = { database, user, password };
  for (const [field, value] of Object.entries(credentials)) {
    if (typeof value !== "string") {
      throw new TypeError(`${field} must be a string.`);
    }
  }
  assertValidCredentials(credentials);
  const w = new PacketWriter(OPEN_DB_FIELD_SIZE * 3 + OPEN_DB_FILLER_SIZE + OPEN_DB_RESERVED_SIZE);
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
 * Build PREPARE_AND_EXECUTE request payload. `generatedKeys` adds
 * EXECUTE_RETURN_GENERATED_KEYS; see writeGetGeneratedKeys().
 */
export function writePrepareAndExecute(
  sql: string,
  autoCommit: boolean,
  casInfo: Buffer,
  charset: TextCharset = "utf-8",
  generatedKeys = false,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(512);
  w.writeByte(CASFunctionCode.PREPARE_AND_EXECUTE);
  w.addInt(3); // arg count
  w.writeNullTermString(sql, charset, "SQL text");
  w.addByte(PREPARE_NORMAL);
  w.addByte(autoCommit ? 1 : 0);
  w.addByte(executeFlag(generatedKeys));
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

/**
 * How a decoded row holds its cells: an object keyed by column name, where the
 * last of several same-named columns wins, or an array in select-list order.
 */
export type RowShape = "object" | "array";

/** A decoded row of either {@link RowShape}. */
export type DecodedRow = Record<string, unknown> | unknown[];

export interface PrepareAndExecuteResult<R extends DecodedRow = Record<string, unknown>>
  extends PrepareResult {
  totalTupleCount: number;
  /** One entry per statement the request ran; more than one for `a; b`. */
  resultInfos: ResultInfo[];
  rows: R[];
}

/**
 * Parse PREPARE_AND_EXECUTE response.
 */
export function parsePrepareAndExecute(
  data: Buffer,
  protoVersion: number,
  utcDates?: boolean,
  charset?: TextCharset,
  shape?: "object",
): PrepareAndExecuteResult;
export function parsePrepareAndExecute(
  data: Buffer,
  protoVersion: number,
  utcDates: boolean,
  charset: TextCharset,
  shape: RowShape,
): PrepareAndExecuteResult<DecodedRow>;
export function parsePrepareAndExecute(
  data: Buffer,
  protoVersion: number,
  utcDates = false,
  charset: TextCharset = "utf-8",
  shape: RowShape = "object",
): PrepareAndExecuteResult<DecodedRow> {
  assertReplySize(data);
  const reader = new PacketReader(data, 0, utcDates, charset);
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

  return decodeReply(() => readExecuteReply(reader, responseCode, protoVersion, shape));
}

function readExecuteReply(
  reader: PacketReader,
  queryHandle: number,
  protoVersion: number,
  shape: RowShape,
): PrepareAndExecuteResult<DecodedRow> {
  const statement = readPrepareInfo(reader, queryHandle);
  return readExecution(reader, statement, reader.parseInt(), protoVersion, false, shape);
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
  shape: RowShape,
): PrepareAndExecuteResult<DecodedRow> {
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
  const rows: DecodedRow[] = [];
  if (statementType === StatementType.SELECT && reader.remaining > 0) {
    const fetchCode = reader.parseInt();
    if (fetchCode >= 0) {
      const tupleCount = reader.parseInt();
      if (tupleCount > 0) {
        parseRowData(reader, columns, tupleCount, rows, false, shape);
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
export function writePrepare(
  sql: string,
  casInfo: Buffer,
  charset: TextCharset = "utf-8",
): { header: Buffer; payload: Buffer } {
  assertPreparableSql(sql);

  const w = new PacketWriter(512);
  w.writeByte(CASFunctionCode.PREPARE);
  w.writeNullTermString(sql, charset, "SQL text");
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

/**
 * EXECUTE_ARRAY runs only the first statement of `a; b` and reports success
 * (seen on live 10.2 and 11.4 brokers), so the later statements would be lost
 * without an error. Refuses SQL with anything but comments after a top-level
 * `;`. It scans under every lexing the server could use (see LexRules), because
 * the server's settings decide where a quoted span ends, so a doubt refuses
 * rather than runs.
 */
export function assertSingleStatement(sql: string): void {
  if (ALL_LEX_RULES.some((rules) => scanSql(sql, rules).secondStatement)) {
    throw new Error("executeMany() runs one statement, but the SQL text holds more than one");
  }
}

/** Parse PREPARE response. */
export function parsePrepare(data: Buffer, charset: TextCharset = "utf-8"): PrepareResult {
  assertReplySize(data);
  const reader = new PacketReader(data, 0, false, charset);
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
  generatedKeys = false,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(512 + binds.bytes.length);
  w.writeByte(CASFunctionCode.EXECUTE);
  w.addInt(statement.queryHandle);
  w.addByte(executeFlag(generatedKeys));
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

function executeFlag(generatedKeys: boolean): number {
  return generatedKeys ? EXECUTE_QUERY_ALL | EXECUTE_RETURN_GENERATED_KEYS : EXECUTE_QUERY_ALL;
}

/**
 * Parse EXECUTE response. Its first int is the tuple count, not a handle: the
 * handle stays the one PREPARE returned.
 */
export function parseExecute(
  data: Buffer,
  statement: PrepareResult,
  protoVersion: number,
  utcDates?: boolean,
  charset?: TextCharset,
  shape?: "object",
): PrepareAndExecuteResult;
export function parseExecute(
  data: Buffer,
  statement: PrepareResult,
  protoVersion: number,
  utcDates: boolean,
  charset: TextCharset,
  shape: RowShape,
): PrepareAndExecuteResult<DecodedRow>;
export function parseExecute(
  data: Buffer,
  statement: PrepareResult,
  protoVersion: number,
  utcDates = false,
  charset: TextCharset = "utf-8",
  shape: RowShape = "object",
): PrepareAndExecuteResult<DecodedRow> {
  assertReplySize(data);
  const reader = new PacketReader(data, 0, utcDates, charset);
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

  return decodeReply(() =>
    readExecution(reader, statement, responseCode, protoVersion, true, shape),
  );
}

// ---------------------------------------------------------------------------
// Execute array (FC=21)
// ---------------------------------------------------------------------------

/** ER_INTERRUPTED: the only failure after which the CAS stops running the sets. */
const ER_INTERRUPTED = -4;

/**
 * Build an EXECUTE_ARRAY request: the prepared handle runs once per set, in
 * order (CAS `fn_execute_array`, JDBC `UStatement.writeExecuteBatchRequest`).
 * The query timeout int is there because this client declares protocol 7. The
 * autocommit byte is always 0, as for writePrepare(): with 1 the CAS commits or
 * rolls back each set on its own, so a failure could leave earlier sets committed.
 * The CAS does not check that the values fill whole sets, so the caller must.
 */
export function writeExecuteArray(
  queryHandle: number,
  sets: readonly PreparedBinds[],
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  let size = 32;
  for (const set of sets) {
    size += set.bytes.length;
  }

  const w = new PacketWriter(size);
  w.writeByte(CASFunctionCode.EXECUTE_ARRAY);
  w.addInt(queryHandle);
  w.addInt(0); // query timeout
  w.addByte(0); // autocommit
  for (const set of sets) {
    w.writeBytes(set.bytes);
  }

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/**
 * Parse an EXECUTE_ARRAY reply (CAS `ux_execute_array`): one entry per set, the
 * affected-row count or the set's own error. The CAS runs every set and undoes
 * only a failing one, unless the session is in autocommit, so a failure says
 * nothing about the sets around it. It stops early only after ER_INTERRUPTED,
 * which it reports, so any other reply that covers fewer sets than `sent` is
 * malformed. A negative result code is an error for the whole request.
 */
export function parseExecuteArray(
  data: Buffer,
  sent: number,
  protoVersion: number,
): Array<number | CasReplyError> {
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

  return decodeReply(() => {
    const executed = reader.parseInt();
    if (executed < 1 || executed > sent) {
      throw new MalformedReplyError(
        `Malformed CAS packet: execute array reported ${executed} of ${sent} sets`,
      );
    }

    const outcomes: Array<number | CasReplyError> = [];
    for (let index = 0; index < executed; index++) {
      const result = reader.parseInt();
      if (result >= 0) {
        reader.skip(SIZE_OID);
        outcomes.push(result);
        continue;
      }

      const indicator = protoVersion > 2 ? result : -2;
      const code = protoVersion > 2 ? reader.parseInt() : result;
      const length = reader.parseInt();
      if (length < 0) {
        throw new MalformedReplyError(`Malformed CAS packet: error message length ${length}`);
      }
      const message = reader.parseNullTermString(length);
      outcomes.push(new CasReplyError(message, indicator, code));
    }

    if (protoVersion > 4) {
      reader.parseInt(); // shard_id
    }

    const last = outcomes[outcomes.length - 1];
    if (executed < sent && !(last instanceof CasReplyError && last.code === ER_INTERRUPTED)) {
      throw new MalformedReplyError(
        `Malformed CAS packet: execute array stopped after ${executed} of ${sent} sets`,
      );
    }
    return outcomes;
  });
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

export interface FetchResult<R extends DecodedRow = Record<string, unknown>> {
  tupleCount: number;
  rows: R[];
}

/**
 * Parse FETCH response.
 */
export function parseFetch(
  data: Buffer,
  columns: ColumnMeta[],
  utcDates?: boolean,
  charset?: TextCharset,
  shape?: "object",
): FetchResult;
export function parseFetch(
  data: Buffer,
  columns: ColumnMeta[],
  utcDates: boolean,
  charset: TextCharset,
  shape: RowShape,
): FetchResult<DecodedRow>;
export function parseFetch(
  data: Buffer,
  columns: ColumnMeta[],
  utcDates = false,
  charset: TextCharset = "utf-8",
  shape: RowShape = "object",
): FetchResult<DecodedRow> {
  assertReplySize(data);
  const reader = new PacketReader(data, 0, utcDates, charset);
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
    const rows: DecodedRow[] = [];
    if (tupleCount > 0) {
      parseRowData(reader, columns, tupleCount, rows, false, shape);
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

export function writeEndTran(txType: number, casInfo: Buffer): { header: Buffer; payload: Buffer } {
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

export function writeConClose(casInfo: Buffer): { header: Buffer; payload: Buffer } {
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
// GetGeneratedKeys (FC=34)
// ---------------------------------------------------------------------------

/**
 * Asks for the AUTO_INCREMENT values the statement on `queryHandle` generated
 * (CAS `fn_get_generated_keys`, JDBC `UStatement.getGeneratedKeys`). The CAS
 * answers only for a statement executed with EXECUTE_RETURN_GENERATED_KEYS,
 * while its handle is open and before its transaction ends, and only for the
 * first statement of an `a; b` string.
 */
export function writeGetGeneratedKeys(
  queryHandle: number,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(16);
  w.writeByte(CASFunctionCode.GET_GENERATED_KEYS);
  w.addInt(queryHandle);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/**
 * The AUTO_INCREMENT value the statement generated for its first row, as
 * decimal text, or undefined when it generated none or more than one column of
 * them. Layout (CAS `ux_get_generated_keys_server_insert` and `_client_insert`,
 * the same in 10.2 to 11.4): result code 0, statement type byte, row count int,
 * updatable byte, column count int, per column a type, scale short, precision
 * int and name, then the row count again and per row an index int, an 8-byte
 * OID and one cell per column. A row only lists the values the server
 * generated: a key the INSERT supplied itself is not there. A server error
 * throws; a body that does not decode is undefined, see below.
 */
export function parseGetGeneratedKeys(data: Buffer): string | undefined {
  assertReplySize(data);
  const reader = new PacketReader(data);
  const code = reader.parseInt();

  if (code < 0) {
    const err = reader.readError(data.length - SIZE_INT);
    throw new CasReplyError(
      `CUBRID getGeneratedKeys failed (${err.code}): ${err.message}`,
      code,
      err.code,
    );
  }

  // The frame was read whole, so a body that does not decode leaves the session
  // aligned. CUBRID 11.0 to 11.4 send such bodies: the column descriptions come
  // only with the first row, while the column count is the one of the last row,
  // so when the server could not read the first row's keys (seen after DDL on
  // the table) a later row's count arrives without its descriptions. Such a
  // reply says nothing reliable, so it reports no key rather than failing an
  // INSERT that succeeded.
  try {
    return readGeneratedKeys(reader);
  } catch (error) {
    if (error instanceof MalformedReplyError || error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

function readGeneratedKeys(reader: PacketReader): string | undefined {
  return decodeReply(() => {
    reader.parseByte(); // statement type
    const totalRows = reader.parseInt();
    reader.parseByte(); // updatable
    const columnCount = reader.parseInt();
    if (columnCount < 0) {
      throw new MalformedReplyError(`Malformed CAS packet: ${columnCount} generated key columns`);
    }
    const types: CUBRIDDataType[] = [];
    for (let c = 0; c < columnCount; c++) {
      types.push(parseColumnType(reader).type);
      reader.parseShort(); // scale
      reader.parseInt(); // precision
      reader.parseNullTermString(reader.parseInt()); // column name
    }

    const rowCount = reader.parseInt();
    if (rowCount < 0 || rowCount !== totalRows) {
      throw new MalformedReplyError(
        `Malformed CAS packet: ${rowCount} generated key rows of ${totalRows}`,
      );
    }
    const firstRow: Array<string | undefined> = [];
    for (let r = 0; r < rowCount; r++) {
      reader.parseInt(); // row index
      reader.skip(SIZE_OID);
      for (const type of types) {
        const value = readGeneratedKey(reader, type);
        if (r === 0) {
          firstRow.push(value);
        }
      }
    }
    if (reader.remaining !== 0) {
      throw new MalformedReplyError(
        `Malformed CAS packet: ${reader.remaining} bytes after the generated keys`,
      );
    }

    // Two AUTO_INCREMENT columns leave no one value to report.
    return firstRow.length === 1 ? firstRow[0] : undefined;
  });
}

/** One generated-key cell. AUTO_INCREMENT columns are SMALLINT, INT, BIGINT or NUMERIC(p,0). */
function readGeneratedKey(reader: PacketReader, type: CUBRIDDataType): string | undefined {
  const size = reader.parseInt();
  if (size === -1) {
    return undefined;
  }
  let text: string;
  if (type === CUBRIDDataType.SHORT && size === SIZE_SHORT) {
    text = String(reader.parseShort());
  } else if (type === CUBRIDDataType.INT && size === SIZE_INT) {
    text = String(reader.parseInt());
  } else if (type === CUBRIDDataType.BIGINT && size === SIZE_LONG) {
    text = String(reader.parseLong());
  } else if (type === CUBRIDDataType.NUMERIC && size > 0) {
    text = reader.parseNullTermString(size);
  } else {
    throw new MalformedReplyError(
      `Malformed CAS packet: generated key of type ${type} and ${size} bytes`,
    );
  }
  if (!/^-?\d+$/.test(text)) {
    throw new MalformedReplyError(`Malformed CAS packet: generated key "${text}"`);
  }
  return text;
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
// LOB_NEW (FC=35) and LOB_WRITE (FC=36)
// ---------------------------------------------------------------------------

/**
 * Build a LOB_NEW request: one int argument, the bind type of the new LOB
 * (CAS `fn_lob_new`, JDBC `UConnection.lobNew`).
 */
export function writeLobNew(
  type: CUBRIDDataType.BLOB | CUBRIDDataType.CLOB,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(16);
  w.writeByte(CASFunctionCode.LOB_NEW);
  w.addInt(type);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/**
 * Parse a LOB_NEW reply: the handle's length, then the handle, int32 db_type,
 * int64 size, int32 locator length and the locator with its NUL (CAS
 * `ux_lob_new`, `net_buf_cp_lob_handle`). A new LOB is empty, so its size is 0.
 * Returns a copy of the handle, which LOB_WRITE and EXECUTE send back as it is.
 */
export function parseLobNew(data: Buffer, type: CUBRIDDataType.BLOB | CUBRIDDataType.CLOB): Buffer {
  if (data.length < SIZE_INT) {
    throw new MalformedReplyError(`Malformed CAS packet: reply of ${data.length} bytes`);
  }
  const reader = new PacketReader(data);
  const length = reader.parseInt();

  // A refused argument is the CAS's own code alone, with no error block (-10004
  // on 10.2 and 11.4 for an unknown type), unlike a failure to create the file.
  if (length < 0 && reader.remaining === 0) {
    throw new CasReplyError(`CUBRID LOB create failed (${length})`, -1, length);
  }
  if (length < 0) {
    const err = decodeReply(() => reader.readError(data.length - SIZE_INT));
    throw new CasReplyError(
      `CUBRID LOB create failed (${err.code}): ${err.message}`,
      length,
      err.code,
    );
  }

  return decodeReply(() => {
    if (length !== reader.remaining || length <= LOB_HANDLE_HEADER_SIZE) {
      throw new MalformedReplyError(
        `Malformed CAS packet: LOB handle of ${length} bytes in a reply carrying ${reader.remaining}`,
      );
    }
    const handle = Buffer.from(data.subarray(SIZE_INT));
    const dbType = handle.readInt32BE(0);
    const size = handle.readBigInt64BE(SIZE_INT);
    const locatorLength = handle.readInt32BE(SIZE_INT + SIZE_LONG);
    const expectedDbType = type === CUBRIDDataType.BLOB ? LOB_DB_TYPE_BLOB : LOB_DB_TYPE_CLOB;
    if (dbType !== expectedDbType || size !== 0n) {
      throw new MalformedReplyError(
        `Malformed CAS packet: new LOB of db_type ${dbType} and size ${size} for type ${type}`,
      );
    }
    if (locatorLength !== length - LOB_HANDLE_HEADER_SIZE || handle[handle.length - 1] !== 0) {
      throw new MalformedReplyError(
        `Malformed CAS packet: LOB locator of ${locatorLength} bytes in a handle of ${length}`,
      );
    }
    return handle;
  });
}

/**
 * Build a LOB_WRITE request: the handle, the int64 offset and the bytes, each
 * length-prefixed (CAS `fn_lob_write`, JDBC `UConnection.lobWrite`).
 */
export function writeLobWrite(
  handle: Buffer,
  offset: number,
  data: Buffer,
  casInfo: Buffer,
): { header: Buffer; payload: Buffer } {
  const w = new PacketWriter(handle.length + data.length + 32);
  w.writeByte(CASFunctionCode.LOB_WRITE);
  w.addBytes(handle);
  w.addLong(BigInt(offset));
  w.addBytes(data);

  const payload = w.toBuffer();
  const header = PacketWriter.buildHeader(payload.length, casInfo);
  return { header, payload };
}

/**
 * Parse a LOB_WRITE reply: only the int32 count of bytes written (CAS
 * `ux_lob_write`). A negative count is an error block. A count other than the
 * `sent` bytes fails the write: the reply itself is intact, so the session is not.
 */
export function parseLobWrite(data: Buffer, sent: number): number {
  if (data.length < SIZE_INT) {
    throw new MalformedReplyError(`Malformed CAS packet: reply of ${data.length} bytes`);
  }

  const reader = new PacketReader(data);
  const written = reader.parseInt();

  if (written < 0) {
    const err = decodeReply(() => reader.readError(data.length - SIZE_INT));
    throw new CasReplyError(
      `CUBRID LOB write failed (${err.code}): ${err.message}`,
      written,
      err.code,
    );
  }
  if (written > sent || reader.remaining !== 0) {
    throw new MalformedReplyError(
      `Malformed CAS packet: LOB write of ${sent} bytes reported ${written} ` +
        `and carried ${reader.remaining} more bytes`,
    );
  }
  if (written !== sent) {
    throw new Error(`CUBRID LOB write stored ${written} of ${sent} bytes`);
  }
  return written;
}

/**
 * A copy of `handle` whose int64 size says `size`. LOB_NEW returns size 0 and
 * LOB_WRITE never updates it, but EXECUTE stores the size the handle states, as
 * the JDBC driver's `CUBRIDLobHandle.setLobSize` does.
 */
export function setLobHandleSize(handle: Buffer, size: number): Buffer {
  const sized = Buffer.from(handle);
  sized.writeBigInt64BE(BigInt(size), SIZE_INT);
  return sized;
}

/**
 * The binds of `binds` with each LOB's handle in its place, in order: byte
 * BLOB or CLOB, then the length-prefixed handle (JDBC `UOutputBuffer.addLob`).
 */
export function bindLobHandles(binds: PreparedBinds, handles: readonly Buffer[]): PreparedBinds {
  const lobs = binds.lobs ?? [];
  if (handles.length !== lobs.length) {
    throw new Error(`${lobs.length} LOB parameters but ${handles.length} handles`);
  }

  const w = new PacketWriter(binds.bytes.length + 64 * handles.length);
  let at = 0;
  handles.forEach((handle, index) => {
    const { offset, param } = lobs[index] as (typeof lobs)[number];
    w.writeBytes(binds.bytes.subarray(at, offset));
    w.addByte(param.kind === "blob" ? CUBRIDDataType.BLOB : CUBRIDDataType.CLOB);
    w.addBytes(handle);
    at = offset;
  });
  w.writeBytes(binds.bytes.subarray(at));
  return { count: binds.count, bytes: Buffer.from(w.toBuffer()) };
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
  if (isLobParam(value)) {
    throw new LobParamError(LOB_LITERAL_REFUSED);
  }

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

  throw unsupportedParam(value);
}

// ---------------------------------------------------------------------------
// Prepared bind encoding (EXECUTE)
// ---------------------------------------------------------------------------

export interface PreparedBinds {
  count: number;
  /**
   * One length-prefixed type byte and one length-prefixed value per parameter,
   * except a LOB, whose bind needs its handle: see `lobs`.
   */
  bytes: Buffer;
  /**
   * The blob() and clob() parameters, in order, each with the offset in `bytes`
   * where its bind goes once uploaded. See bindLobHandles().
   */
  lobs?: ReadonlyArray<{ offset: number; param: LobParam }>;
}

const LOB_LITERAL_REFUSED =
  "a blob() or clob() value can only be sent by queryPrepared(), queryResultPrepared() " +
  "or executePrepared()";

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
export function encodePreparedParams(
  params: readonly unknown[],
  charset: TextCharset = "utf-8",
): PreparedBinds {
  const w = new PacketWriter(256);
  const lobs: Array<{ offset: number; param: LobParam }> = [];
  const streams = new Set<unknown>();
  for (const param of params) {
    if (isLobParam(param)) {
      if (isSourceConsumed(param.source)) {
        throw new LobParamError(STREAM_REUSED);
      }
      if (isStreamSource(param.source)) {
        if (streams.has(param.source)) {
          throw new LobParamError(
            "the same blob() or clob() stream source is used twice; a stream can be read only once",
          );
        }
        streams.add(param.source);
      }
      // Refused here, before PREPARE, when the text is already known; a stream
      // is checked as it is uploaded.
      if (
        charset === "iso-8859-1" &&
        param.kind === "clob" &&
        typeof param.source === "string" &&
        NOT_LATIN1.test(param.source)
      ) {
        throw new LobParamError(CLOB_NOT_LATIN1);
      }
      lobs.push({ offset: w.length, param });
      continue;
    }
    writePreparedParam(w, param, charset);
  }
  const bytes = Buffer.from(w.toBuffer());
  return lobs.length === 0
    ? { count: params.length, bytes }
    : { count: params.length, bytes, lobs };
}

function writePreparedParam(w: PacketWriter, value: unknown, charset: TextCharset): void {
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
    w.writeNullTermString(value, charset, "string parameter");
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
 * How a CUBRID session lexes the SQL text, which decides where a `?` marker can
 * be. Measured on CUBRID 10.2 and 11.4 brokers:
 *
 * - `'...'` is a string. `''` is a quote, and a backslash escapes the next
 *   character only with `no_backslash_escapes=no`.
 * - `"..."` is an identifier with `ansi_quotes=yes`, the default, and a string
 *   with `ansi_quotes=no`. `""` is a quote either way; a backslash escapes only in
 *   the string, and only with `no_backslash_escapes=no`.
 * - `` `...` `` is an identifier: ` `` ` is a backtick and a backslash is ordinary.
 * - `[...]` is an identifier that ends at the first `]`: `]]` is not an escape.
 * - `--` and `//` start a comment that ends at the next CR or LF. `/* ... *\/`
 *   does not nest, and an unterminated one runs to the end of the text.
 *   `#` is not a comment.
 */
interface LexRules {
  /** `no_backslash_escapes=no`: a backslash escapes the next character in a `'` string. */
  readonly backslashEscapes: boolean;
  /** The same in a `"` span, which is a string only with `ansi_quotes=no`. */
  readonly doubleQuoteEscapes: boolean;
}

/** `no_backslash_escapes=yes`, the CUBRID default: `ansi_quotes` changes nothing here. */
const LITERAL_BACKSLASH: LexRules = { backslashEscapes: false, doubleQuoteEscapes: false };
/** `no_backslash_escapes=no` with either `ansi_quotes` setting, which the client cannot see. */
const ESCAPE_RULES: readonly LexRules[] = [
  { backslashEscapes: true, doubleQuoteEscapes: false },
  { backslashEscapes: true, doubleQuoteEscapes: true },
];
const ALL_LEX_RULES: readonly LexRules[] = [LITERAL_BACKSLASH, ...ESCAPE_RULES];

interface SqlScan {
  /** Offsets of the `?` markers outside quoted spans and comments. */
  readonly markers: number[];
  /** Whether anything but a comment follows a top-level `;`. */
  readonly secondStatement: boolean;
}

/** The one lexer of the SQL text, for every literal path and executeMany(). */
function scanSql(sql: string, rules: LexRules): SqlScan {
  const markers: number[] = [];
  let separated = false;
  let secondStatement = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";

    if ((ch === "-" && next === "-") || (ch === "/" && next === "/")) {
      i = lineCommentEnd(sql, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ";") {
      separated = true;
      i++;
      continue;
    }
    // Only ASCII whitespace: anything else after a ; is counted as a statement.
    if (separated && !/[ \t\n\r\f\v]/.test(ch)) {
      secondStatement = true;
    }

    if (ch === "'") {
      i = quotedSpanEnd(sql, i, "'", rules.backslashEscapes);
    } else if (ch === '"') {
      i = quotedSpanEnd(sql, i, '"', rules.doubleQuoteEscapes);
    } else if (ch === "`") {
      i = quotedSpanEnd(sql, i, "`", false);
    } else if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else {
      if (ch === "?") {
        markers.push(i);
      }
      i++;
    }
  }

  return { markers, secondStatement };
}

/**
 * Whether `sql` is one `INSERT` or `REPLACE` whose text cannot run a stored
 * routine: no `SELECT` and no `name(` other than its column list and `VALUES (`.
 * A function in the statement can insert into another AUTO_INCREMENT table and
 * leave its value as the session's last insert id (seen with PL/CSQL on CUBRID
 * 11.4), so only such a statement may report that value. Built-in functions are
 * refused too: telling them from a stored function by name is not certain. Every
 * lexing the server could use must agree, as for assertSingleStatement().
 */
export function isPlainInsert(sql: string): boolean {
  return ALL_LEX_RULES.every((rules) => {
    const { code, secondStatement } = codeOnly(sql, rules);
    if (secondStatement || /\bselect\b/i.test(code)) {
      return false;
    }
    const head = INSERT_HEAD.exec(code);
    if (!head) {
      return false;
    }
    // The column list, if the table name is followed by one.
    const columnList = head[0].endsWith("(") ? head[0].length - 1 : -1;
    for (const call of code.matchAll(CALL)) {
      const paren = call.index + call[0].length - 1;
      if (paren !== columnList && !/^values?$/i.test(call[1] ?? "")) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Whether `sql` is one statement that starts with INSERT or REPLACE under every
 * lexing: the only statements EXECUTE_RETURN_GENERATED_KEYS is sent with, since
 * on 11.x the flag can make an INSERT the server runs on the client side fail.
 */
export function isSingleInsert(sql: string): boolean {
  return ALL_LEX_RULES.every((rules) => {
    const { code, secondStatement } = codeOnly(sql, rules);
    return !secondStatement && INSERT_HEAD.test(code);
  });
}

/** A name, or a quoted identifier as codeOnly() leaves it. */
const SQL_NAME = String.raw`(?:[\p{L}_][\p{L}\p{N}_$#]*|_q_)`;
const INSERT_HEAD = new RegExp(
  String.raw`^\s*(?:insert|replace)\s+(?:into\s+)?${SQL_NAME}(?:\s*\.\s*${SQL_NAME})?\s*\(?`,
  "iu",
);
const CALL = new RegExp(String.raw`(${SQL_NAME})\s*\(`, "gu");

/**
 * `sql` with comments blanked, string literals as `0` and quoted identifiers as
 * `_q_`, so what is left is the code of the statement.
 */
function codeOnly(sql: string, rules: LexRules): { code: string; secondStatement: boolean } {
  let code = "";
  let separated = false;
  let secondStatement = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql.charAt(i);
    const next = sql[i + 1] ?? "";
    let end: number;
    let replacement: string;

    if ((ch === "-" && next === "-") || (ch === "/" && next === "/")) {
      end = lineCommentEnd(sql, i + 2);
      replacement = " ";
    } else if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      end = close === -1 ? sql.length : close + 2;
      replacement = " ";
    } else {
      if (separated && !/[ \t\n\r\f\v;]/.test(ch)) {
        secondStatement = true;
      }
      if (ch === ";") {
        separated = true;
      }
      if (ch === "'") {
        end = quotedSpanEnd(sql, i, "'", rules.backslashEscapes);
        replacement = " 0 ";
      } else if (ch === '"') {
        end = quotedSpanEnd(sql, i, '"', rules.doubleQuoteEscapes);
        replacement = " _q_ ";
      } else if (ch === "`") {
        end = quotedSpanEnd(sql, i, "`", false);
        replacement = " _q_ ";
      } else if (ch === "[") {
        const close = sql.indexOf("]", i + 1);
        end = close === -1 ? sql.length : close + 1;
        replacement = " _q_ ";
      } else {
        end = i + 1;
        replacement = ch;
      }
    }
    code += replacement;
    i = end;
  }

  return { code, secondStatement };
}

/** The offset after a quoted span that starts at `start`, or the end of an unterminated one. */
function quotedSpanEnd(sql: string, start: number, quote: string, backslash: boolean): number {
  for (let i = start + 1; i < sql.length; i++) {
    const ch = sql[i];
    if (backslash && ch === "\\") {
      i++;
    } else if (ch === quote) {
      if (sql[i + 1] !== quote) {
        return i + 1;
      }
      i++;
    }
  }
  return sql.length;
}

/** The offset of the CR or LF that ends a line comment, or the end of the text. */
function lineCommentEnd(sql: string, from: number): number {
  for (let i = from; i < sql.length; i++) {
    if (sql[i] === "\n" || sql[i] === "\r") {
      return i;
    }
  }
  return sql.length;
}

/**
 * The offsets of the `?` markers of `sql` under the server's backslash mode, or
 * under every mode when it is not known. `undefined` when the possible lexings
 * disagree: only a backslash inside a quoted span makes them differ.
 */
export function findPlaceholders(sql: string, noBackslashEscapes?: boolean): number[] | undefined {
  let candidates: readonly LexRules[] = [LITERAL_BACKSLASH];
  if (sql.includes("\\")) {
    if (noBackslashEscapes === undefined) {
      candidates = ALL_LEX_RULES;
    } else if (!noBackslashEscapes) {
      candidates = ESCAPE_RULES;
    }
  }

  const [first, ...others] = candidates.map((rules) => scanSql(sql, rules).markers);
  const agree = others.every(
    (markers) => markers.length === first!.length && markers.every((at, k) => at === first![k]),
  );
  return agree ? first : undefined;
}

/** Every literal statement has exactly one value per marker; neither side is guessed. */
export function assertParameterCount(markers: number, values: number): void {
  if (markers !== values) {
    throw new Error(
      `Parameter count mismatch: the SQL has ${markers} ? markers, but ${values} values were given`,
    );
  }
}

/**
 * Renders the values into the SQL text as literals, in place of its `?` markers,
 * for `query()`, `queryResult()`, `execute()` and `stream()`. `queryPrepared()`,
 * `queryResultPrepared()`, `executePrepared()` and `executeMany()` send the values
 * as typed binds instead, so the server finds the markers and no value becomes
 * SQL text.
 *
 * The markers are found by the server's lexing rules (see LexRules) under the
 * negotiated backslash mode, and the number of values must equal them. In
 * escape mode a `"` span holding a backslash is refused when its two possible
 * lexings place the markers differently: whether it is an identifier depends on
 * the server's `ansi_quotes`, which the client cannot see.
 */
export function interpolateParams(
  sql: string,
  params: readonly unknown[],
  noBackslashEscapes: boolean,
): string {
  const markers = findPlaceholders(sql, noBackslashEscapes);
  if (markers === undefined) {
    throw new Error(
      "The ? markers of this SQL depend on the server's ansi_quotes setting: a double-quoted " +
        "span holds a backslash. Use a single-quoted string, or the prepared methods.",
    );
  }
  assertParameterCount(markers.length, params.length);

  let result = "";
  let from = 0;
  markers.forEach((at, index) => {
    result += sql.slice(from, at) + formatValue(params[index], noBackslashEscapes);
    from = at + 1;
  });
  return result + sql.slice(from);
}

/**
 * Format a JavaScript value as a SQL literal.
 */
export function formatValue(value: unknown, noBackslashEscapes: boolean): string {
  // String() would render the wrapper as '[object Object]' without complaint.
  if (isLobParam(value)) {
    throw new LobParamError(LOB_LITERAL_REFUSED);
  }

  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("NaN and Infinity are not supported as a parameter");
    }
    return formatNumeric(value, value < 0);
  }

  if (typeof value === "bigint") {
    return formatNumeric(value, value < 0n);
  }

  if (typeof value === "string") {
    return escapeString(value, noBackslashEscapes);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("an invalid Date cannot be sent as a parameter");
    }
    return formatDatetime(value);
  }

  if (Buffer.isBuffer(value)) {
    return `X'${value.toString("hex")}'`;
  }

  throw unsupportedParam(value);
}

/**
 * A negative number is parenthesized: after a `-` in the SQL text, `5-?` with -1
 * would otherwise read `5--1`, and `--` starts a comment that hides the rest of
 * the line, a WHERE clause included.
 */
function formatNumeric(value: number | bigint, negative: boolean): string {
  return negative ? `(${String(value)})` : String(value);
}

/**
 * Checks every value of a literal statement without rendering it, so a refused
 * value fails before anything is sent. Both backslash modes refuse the same values.
 */
export function assertLiteralParams(
  params: readonly unknown[],
  charset: TextCharset = "utf-8",
): void {
  for (const value of params) {
    if (typeof value === "string") {
      assertStorableText(value);
      assertEncodable(value, charset, "string parameter");
    } else {
      formatValue(value, true);
    }
  }
}

/** Objects, arrays, functions and symbols are not a QueryParam; their text is not a value. */
function unsupportedParam(value: unknown): Error {
  const type = Array.isArray(value) ? "array" : typeof value;
  return new Error(`unsupported parameter type: ${type}`);
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
    throw new Error(
      "string parameter contains a null byte (0x00), which CUBRID cannot store in a string literal",
    );
  }
  if (value.includes("\x1a")) {
    throw new Error(
      "string parameter contains a Ctrl-Z byte (0x1A), which has no safe CUBRID string-literal escape",
    );
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
  charset?: number;
} {
  const first = reader.parseUByte();
  if ((first & 0x80) === 0) {
    return { type: first as CUBRIDDataType };
  }

  const wireType = reader.parseUByte() as CUBRIDDataType;
  const charset = first & CHARSET_MASK;
  const kind = COLLECTION_KIND_BY_FLAG[first & COLLECTION_KIND_MASK];
  return kind === undefined
    ? { type: wireType, charset }
    : { type: kind, elementType: wireType, charset };
}

function parseColumnMetadata(reader: PacketReader, count: number): ColumnMeta[] {
  const columns: ColumnMeta[] = [];

  for (let i = 0; i < count; i++) {
    const { type, elementType, charset } = parseColumnType(reader);

    const scale = reader.parseShort();
    const precision = reader.parseInt();

    const nameLen = reader.parseInt();
    const name = reader.parseClientString(nameLen);

    const realNameLen = reader.parseInt();
    const realName = reader.parseClientString(realNameLen);

    const tableNameLen = reader.parseInt();
    const tableName = reader.parseClientString(tableNameLen);

    // The wire byte is is_non_null: zero permits NULL, nonzero means NOT NULL.
    const isNullable = reader.parseByte() === 0;

    const defaultLen = reader.parseInt();
    const defaultValue = reader.parseClientString(defaultLen);

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
      ...(charset === undefined ? {} : { charset }),
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

/**
 * Store a decoded cell: an array row at the column's position, so a repeated or
 * empty name keeps its own value, and an object row by name through setColumn().
 */
export function setCell(row: DecodedRow, index: number, name: string, value: unknown): void {
  if (Array.isArray(row)) {
    row[index] = value;
  } else {
    setColumn(row, name, value);
  }
}

function parseRowData(
  reader: PacketReader,
  columns: ColumnMeta[],
  tupleCount: number,
  rows: DecodedRow[],
  isCallType: boolean,
  shape: RowShape,
): void {
  let unsupported: UnsupportedValueError | undefined;

  for (let t = 0; t < tupleCount; t++) {
    // A reply that ends before tupleCount rows overruns the reader and is
    // reported as malformed, never returned as a short result.
    reader.parseInt(); // row index
    reader.skip(SIZE_OID); // OID

    const row: DecodedRow = shape === "array" ? new Array(columns.length) : {};

    for (let c = 0; c < columns.length; c++) {
      let size = reader.parseInt();
      const column = columns[c]!;
      let colType = column.type;
      let charset = column.charset;
      const hasTypeHeader = isCallType || colType === CUBRIDDataType.NULL;

      // CAS writes SQL NULL as -1, and a collection cell always has its header.
      if (size < -1 || (size === 0 && (isCollectionType(colType) || hasTypeHeader))) {
        throw new Error(
          `Malformed CAS packet: invalid cell length ${size} for column "${column.name}"`,
        );
      }
      if (size === -1) {
        setCell(row, c, column.name, null);
        continue;
      }

      // Such a cell states its own type, in the layout of column metadata. This
      // is what a bound `SELECT ?` returns: its column has no type at PREPARE.
      if (hasTypeHeader) {
        const headerStart = reader.position;
        ({ type: colType, charset } = parseColumnType(reader));
        size -= reader.position - headerStart;
        if (size < 0) {
          throw new Error(
            `Malformed CAS packet: type header overruns the cell of column "${column.name}"`,
          );
        }
      }

      // An empty bit string is not SQL NULL: it is an empty Buffer (#173).
      if (size === 0 && isBitType(colType)) {
        setCell(row, c, column.name, Buffer.alloc(0));
        continue;
      }

      const valueStart = reader.position;
      try {
        const value = readValue(reader, colType, size, charset);
        // A value that disagrees with its cell length would turn the bytes of
        // the following columns into the wrong values.
        assertExactLength(reader.position - valueStart, size);
        // CAS counts the NUL of text and writes fixed widths in full, so a
        // decodable zero-byte value is neither SQL NULL nor an empty value.
        if (size === 0) {
          throw new Error(`Malformed CAS packet: type ${colType} cannot be empty`);
        }
        setCell(row, c, column.name, value);
      } catch (error) {
        const message = `Failed to decode CUBRID column "${column.name}" (wire type ${colType}, ${size} bytes)`;
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

/** `charset` is the code the column or cell reports for its text, if any. */
function readValue(
  reader: PacketReader,
  colType: CUBRIDDataType,
  size: number,
  charset?: number,
): unknown {
  switch (colType) {
    case CUBRIDDataType.CHAR:
    case CUBRIDDataType.STRING:
    case CUBRIDDataType.NCHAR:
    case CUBRIDDataType.VARNCHAR:
    case CUBRIDDataType.ENUM:
      return decodeText(reader.parseNullTermBytes(size), reader.charset, charset);

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
      return readCollection(reader, size, charset);

    case CUBRIDDataType.NULL:
    default:
      // Never turn an unsupported non-NULL wire value into SQL NULL:
      // callers would silently lose data and could persist the wrong result.
      throw new UnsupportedValueError(
        `Unsupported CUBRID CAS value type ${colType} (${size} bytes)`,
      );
  }
}

/** Created on first use: a Node.js build without full ICU cannot construct it. */
let eucKrDecoder: TextDecoder | undefined;
const UTF8_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decode a text value. With charset "utf-8" every value is UTF-8 and the
 * column charset is ignored, the 1.x contract: an invalid sequence becomes
 * U+FFFD. With "iso-8859-1" the value is decoded in the charset its column or
 * cell reports, and bytes that charset cannot decode are refused, not replaced.
 * ASCII, binary, ISO-8859-1 and an unreported charset map each byte to the
 * code point of the same value.
 */
function decodeText(bytes: Buffer, client: TextCharset, charset: number | undefined): string {
  if (client === "utf-8") {
    return bytes.toString("utf-8");
  }
  if (charset === CAS_CHARSET_UTF8) {
    try {
      return UTF8_TEXT_DECODER.decode(bytes);
    } catch (error) {
      throw new UnsupportedValueError("utf8 text is not valid UTF-8", { cause: error });
    }
  }
  if (charset === CAS_CHARSET_EUC_KR) {
    // The WHATWG decoder is really windows-949: it also accepts its extension
    // pairs and maps bytes such as 80 to C1 controls, so EUC-KR is checked first.
    if (!isEucKr(bytes)) {
      throw new UnsupportedValueError("euckr text is not valid EUC-KR");
    }
    try {
      eucKrDecoder ??= new TextDecoder("euc-kr", { fatal: true });
      return eucKrDecoder.decode(bytes);
    } catch (error) {
      throw new UnsupportedValueError(
        "euckr text is not valid EUC-KR, or this Node.js build cannot decode EUC-KR",
        { cause: error },
      );
    }
  }
  return bytes.toString("latin1");
}

/** ASCII bytes, and pairs of bytes A1 to FE (KS X 1001), nothing else. */
function isEucKr(bytes: Buffer): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const lead = bytes[i]!;
    if (lead < 0x80) continue;
    const trail = bytes[++i];
    if (lead < 0xa1 || lead > 0xfe || trail === undefined || trail < 0xa1 || trail > 0xfe) {
      return false;
    }
  }
  return true;
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
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]!
  ) {
    throw new Error(
      `Malformed CAS packet: zoned value date ${year}-${month}-${day} does not exist`,
    );
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
function readCollection(reader: PacketReader, size: number, charset?: number): unknown[] {
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
      values.push(readCollectionElement(cell, elementType, cell.parseInt(), charset));
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
  charset: number | undefined,
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

  const value = readValue(element, elementType, length, charset);
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
