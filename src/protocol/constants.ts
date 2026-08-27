/**
 * CUBRID CAS protocol constants.
 *
 * Values are derived from the CUBRID CCI/CAS specification and verified
 * against pycubrid, cubrid-go, and node-cubrid reference implementations.
 */

// ---------------------------------------------------------------------------
// Broker handshake
// ---------------------------------------------------------------------------

/** Magic string sent during broker handshake. */
export const CAS_MAGIC = "CUBRK";

/**
 * Magic string sent during broker handshake when TLS is requested.
 * The server detects SSL clients via `IS_SSL_CLIENT` (strncmp == "CUBRS").
 * Verified against CUBRID source: src/broker/cas_protocol.h
 *   SRV_CON_CLIENT_MAGIC_STR_SSL "CUBRS".
 */
export const CAS_MAGIC_SSL = "CUBRS";

/** Client type identifier — JDBC-compatible client. */
export const CLIENT_JDBC = 3;

/** CAS protocol version negotiated during handshake. */
export const CAS_PROTO_INDICATOR = 0x40;
export const CAS_PROTOCOL_VERSION = 7; // Match node-cubrid; enables v2+ column info and v5+ shard fields
export const CAS_VERSION = CAS_PROTO_INDICATOR | CAS_PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Wire sizes
// ---------------------------------------------------------------------------

export const SIZE_BYTE = 1;
export const SIZE_SHORT = 2;
export const SIZE_INT = 4;
export const SIZE_LONG = 8;
export const SIZE_FLOAT = 4;
export const SIZE_DOUBLE = 8;
export const SIZE_DATETIME = 14; // 7 × int16
export const SIZE_OID = 8;
export const SIZE_CAS_INFO = 4;
export const SIZE_DATA_LENGTH = 4;
export const SIZE_BROKER_INFO = 8;

/** Fixed size of OpenDatabase credential blocks. */
export const OPEN_DB_FIELD_SIZE = 32;
/** Extended info filler size in OpenDatabase. */
export const OPEN_DB_FILLER_SIZE = 512;
/** Reserved filler size in OpenDatabase. */
export const OPEN_DB_RESERVED_SIZE = 20;
/** Total size of an OpenDatabase request payload. */
export const OPEN_DB_TOTAL_SIZE =
  OPEN_DB_FIELD_SIZE * 3 + OPEN_DB_FILLER_SIZE + OPEN_DB_RESERVED_SIZE; // 628

// ---------------------------------------------------------------------------
// CAS function codes
// ---------------------------------------------------------------------------

export const enum CASFunctionCode {
  END_TRAN = 1,
  PREPARE = 2,
  EXECUTE = 3,
  GET_DB_PARAMETER = 4,
  SET_DB_PARAMETER = 5,
  CLOSE_REQ_HANDLE = 6,
  FETCH = 8,
  SCHEMA_INFO = 9,
  GET_DB_VERSION = 15,
  EXECUTE_BATCH = 20,
  CON_CLOSE = 31,
  GET_LAST_INSERT_ID = 40,
  PREPARE_AND_EXECUTE = 41,
}

// ---------------------------------------------------------------------------
// Transaction types (used with END_TRAN)
// ---------------------------------------------------------------------------

export const enum EndTranType {
  COMMIT = 1,
  ROLLBACK = 2,
}

// ---------------------------------------------------------------------------
// Prepare options
// ---------------------------------------------------------------------------

export const PREPARE_NORMAL = 0x00;
export const EXECUTE_NORMAL = 0x00;
export const EXECUTE_QUERY_ALL = 0x02;

// ---------------------------------------------------------------------------
// CUBRID data types (wire type codes)
// ---------------------------------------------------------------------------

export const enum CUBRIDDataType {
  NULL = 0,
  CHAR = 1,
  STRING = 2,
  NCHAR = 3,
  VARNCHAR = 4,
  BIT = 5,
  VARBIT = 6,
  NUMERIC = 7,
  INT = 8,
  SHORT = 9,
  MONETARY = 10,
  FLOAT = 11,
  DOUBLE = 12,
  DATE = 13,
  TIME = 14,
  TIMESTAMP = 15,
  DATETIME = 22,
  BLOB = 23,
  CLOB = 24,
  ENUM = 25,
  BIGINT = 26,
  OBJECT = 32,
  SET = 33,
  MULTISET = 34,
  SEQUENCE = 35,
}

// ---------------------------------------------------------------------------
// Statement types (from CAS response)
// ---------------------------------------------------------------------------

export const enum StatementType {
  ALTER = 6,
  CALL = 7,
  COMMIT = 8,
  CREATE = 9,
  DELETE = 23,
  DROP = 10,
  GET_STATS = 11,
  INSERT = 20,
  ROLLBACK = 13,
  SELECT = 21,
  UPDATE = 22,
  CALL_SP = 0x7e,
}

// ---------------------------------------------------------------------------
// Type name mapping (for metadata)
// ---------------------------------------------------------------------------

export const TYPE_NAMES: Record<number, string> = {
  [CUBRIDDataType.NULL]: "NULL",
  [CUBRIDDataType.CHAR]: "CHAR",
  [CUBRIDDataType.STRING]: "VARCHAR",
  [CUBRIDDataType.NCHAR]: "NCHAR",
  [CUBRIDDataType.VARNCHAR]: "VARNCHAR",
  [CUBRIDDataType.BIT]: "BIT",
  [CUBRIDDataType.VARBIT]: "VARBIT",
  [CUBRIDDataType.NUMERIC]: "NUMERIC",
  [CUBRIDDataType.INT]: "INT",
  [CUBRIDDataType.SHORT]: "SMALLINT",
  [CUBRIDDataType.MONETARY]: "MONETARY",
  [CUBRIDDataType.FLOAT]: "FLOAT",
  [CUBRIDDataType.DOUBLE]: "DOUBLE",
  [CUBRIDDataType.DATE]: "DATE",
  [CUBRIDDataType.TIME]: "TIME",
  [CUBRIDDataType.TIMESTAMP]: "TIMESTAMP",
  [CUBRIDDataType.DATETIME]: "DATETIME",
  [CUBRIDDataType.BLOB]: "BLOB",
  [CUBRIDDataType.CLOB]: "CLOB",
  [CUBRIDDataType.ENUM]: "ENUM",
  [CUBRIDDataType.BIGINT]: "BIGINT",
  [CUBRIDDataType.OBJECT]: "OBJECT",
  [CUBRIDDataType.SET]: "SET",
  [CUBRIDDataType.MULTISET]: "MULTISET",
  [CUBRIDDataType.SEQUENCE]: "SEQUENCE",
};
