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

import { PacketReader } from "./packet-reader.js";
import { PacketWriter } from "./packet-writer.js";
import {
  CASFunctionCode,
  CAS_MAGIC,
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

export interface ColumnMeta {
  type: CUBRIDDataType;
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
 */
export function writeClientInfoExchange(): Buffer {
  const w = new PacketWriter(10);
  const magic = Buffer.from(CAS_MAGIC, "ascii");
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
    throw new Error(
      `CUBRID connection failed (${err.code}): ${err.message || "Unknown error"}`,
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

export interface PrepareAndExecuteResult {
  queryHandle: number;
  statementType: StatementType;
  bindCount: number;
  columnCount: number;
  columns: ColumnMeta[];
  totalTupleCount: number;
  rows: Record<string, unknown>[];
}

/**
 * Parse PREPARE_AND_EXECUTE response.
 */
export function parsePrepareAndExecute(
  data: Buffer,
  protoVersion: number,
): PrepareAndExecuteResult {
  const reader = new PacketReader(data);
  const responseCode = reader.parseInt();

  if (responseCode < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new Error(`CUBRID query failed (${err.code}): ${err.message}`);
  }

  const queryHandle = responseCode;
  reader.parseInt(); // result cache lifetime
  const statementType = reader.parseByte() as StatementType;
  const bindCount = reader.parseInt();
  reader.parseByte(); // is_updatable
  const columnCount = reader.parseInt();

  const columns = parseColumnMetadata(reader, columnCount);

  // Execute portion
  const totalTupleCount = reader.parseInt();
  reader.parseByte(); // cache_reusable
  const resultCount = reader.parseInt();
  parseResultInfos(reader, resultCount);

  if (protoVersion > 1 && reader.remaining > 0) {
    reader.parseByte(); // includes_column_info
  }
  if (protoVersion > 4 && reader.remaining > 0) {
    reader.parseInt(); // shard_id
  }

  // Inline fetch (for SELECT statements)
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

  return {
    queryHandle,
    statementType,
    bindCount,
    columnCount,
    columns,
    totalTupleCount,
    rows,
  };
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
): FetchResult {
  const reader = new PacketReader(data);
  const responseCode = reader.parseInt();

  if (responseCode < 0) {
    // -1 means no more data — treat as empty result
    if (responseCode === -1) {
      return { tupleCount: 0, rows: [] };
    }
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new Error(`CUBRID fetch failed (${err.code}): ${err.message}`);
  }

  const tupleCount = reader.parseInt();
  const rows: Record<string, unknown>[] = [];
  if (tupleCount > 0) {
    parseRowData(reader, columns, tupleCount, rows, false);
  }

  return { tupleCount, rows };
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
    throw new Error(`CUBRID getDbVersion failed (${err.code}): ${err.message}`);
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
// Simple response parser (for EndTran, CloseReqHandle, etc.)
// ---------------------------------------------------------------------------

export function parseSimpleResponse(data: Buffer): void {
  const reader = new PacketReader(data);
  const code = reader.parseInt();

  if (code < 0) {
    const remaining = data.length - SIZE_INT;
    const err = reader.readError(remaining);
    throw new Error(`CUBRID operation failed (${err.code}): ${err.message}`);
  }
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
  if (value.includes("\0")) {
    throw new Error("string parameter contains a null byte (0x00), which CUBRID cannot store in a string literal");
  }
  if (value.includes("\x1a")) {
    throw new Error("string parameter contains a Ctrl-Z byte (0x1A), which has no safe CUBRID string-literal escape");
  }

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

function parseColumnMetadata(
  reader: PacketReader,
  count: number,
): ColumnMeta[] {
  const columns: ColumnMeta[] = [];

  for (let i = 0; i < count; i++) {
    const legacyType = reader.parseUByte();
    let colType: CUBRIDDataType;
    if ((legacyType & 0x80) !== 0) {
      colType = reader.parseUByte() as CUBRIDDataType;
    } else {
      colType = legacyType as CUBRIDDataType;
    }

    const scale = reader.parseShort();
    const precision = reader.parseInt();

    const nameLen = reader.parseInt();
    const name = reader.parseNullTermString(nameLen);

    const realNameLen = reader.parseInt();
    const realName = reader.parseNullTermString(realNameLen);

    const tableNameLen = reader.parseInt();
    const tableName = reader.parseNullTermString(tableNameLen);

    const isNullable = reader.parseByte() === 1;

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
      type: colType,
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

function parseRowData(
  reader: PacketReader,
  columns: ColumnMeta[],
  tupleCount: number,
  rows: Record<string, unknown>[],
  isCallType: boolean,
): void {
  for (let t = 0; t < tupleCount; t++) {
    if (reader.remaining <= 0) break;

    reader.parseInt(); // row index
    reader.skip(SIZE_OID); // OID

    const row: Record<string, unknown> = {};

    for (let c = 0; c < columns.length; c++) {
      let size = reader.parseInt();
      if (size <= 0) {
        row[columns[c]!.name] = null;
        continue;
      }

      let colType = columns[c]!.type;

      // Special handling for CALL/SP or NULL type
      if (isCallType || colType === CUBRIDDataType.NULL) {
        colType = reader.parseUByte() as CUBRIDDataType;
        size--;
        if (size <= 0) {
          row[columns[c]!.name] = null;
          continue;
        }
      }

      row[columns[c]!.name] = readValue(reader, colType, size);
    }

    rows.push(row);
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
      return reader.parseDate();

    case CUBRIDDataType.TIME:
      return reader.parseTime();

    case CUBRIDDataType.DATETIME:
      return reader.parseDatetime();

    case CUBRIDDataType.TIMESTAMP:
      return reader.parseTimestamp();
    case CUBRIDDataType.BIT:
    case CUBRIDDataType.VARBIT:
    case CUBRIDDataType.BLOB:
    case CUBRIDDataType.CLOB:
      return reader.parseBytes(size);

    case CUBRIDDataType.NULL:
    default:
      reader.skip(size);
      return null;
  }
}

// ---------------------------------------------------------------------------
// Result info parser (used by Execute/PrepareAndExecute)
// ---------------------------------------------------------------------------

function parseResultInfos(reader: PacketReader, count: number): void {
  for (let i = 0; i < count; i++) {
    reader.parseByte(); // statement type
    reader.parseInt(); // result count
    reader.parseBytes(SIZE_OID); // OID (8 bytes)
    reader.parseInt(); // cache time seconds
    reader.parseInt(); // cache time microseconds
  }
}
