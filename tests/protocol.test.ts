import assert from "node:assert/strict";
import test from "node:test";

import { CasReplyError } from "../src/errors/internal-errors.js";
import {
  CAS_MAGIC,
  CAS_VERSION,
  CASFunctionCode,
  CLIENT_JDBC,
  CUBRIDDataType,
  EndTranType,
  EXECUTE_NORMAL,
  EXECUTE_QUERY_ALL,
  OPEN_DB_TOTAL_SIZE,
  PREPARE_NORMAL,
  SIZE_CAS_INFO,
  SIZE_INT,
  StatementType,
  TYPE_NAMES,
} from "../src/protocol/constants.js";
import { PacketReader } from "../src/protocol/packet-reader.js";
import { PacketWriter } from "../src/protocol/packet-writer.js";
import {
  type ColumnMeta,
  encodeBindParams,
  formatValue,
  interpolateParams,
  MalformedReplyError,
  parseClientInfoExchange,
  parseFetch,
  parseGetDbVersion,
  parseGetLastInsertId,
  parseOpenDatabase,
  parsePrepareAndExecute,
  parseSimpleResponse,
  readQueryHandle,
  writeClientInfoExchange,
  writeCloseReqHandle,
  writeConClose,
  writeEndTran,
  writeFetch,
  writeGetDbVersion,
  writeGetLastInsertId,
  writeOpenDatabase,
  writePrepareAndExecute,
  writeSetDbParameter,
} from "../src/protocol/protocol.js";
import { DML_FRAMES, LAST_INSERT_ID_FRAMES } from "./fixtures/dml-frames.js";

// ---------------------------------------------------------------------------
// PacketWriter tests
// ---------------------------------------------------------------------------

test("PacketWriter writeByte writes single byte", () => {
  const w = new PacketWriter(8);
  w.writeByte(42);
  const buf = w.toBuffer();
  assert.equal(buf.length, 1);
  assert.equal(buf.readInt8(0), 42);
});

test("PacketWriter writeShort writes big-endian int16", () => {
  const w = new PacketWriter(8);
  w.writeShort(0x0102);
  const buf = w.toBuffer();
  assert.equal(buf.length, 2);
  assert.equal(buf.readInt16BE(0), 0x0102);
});

test("PacketWriter writeInt writes big-endian int32", () => {
  const w = new PacketWriter(8);
  w.writeInt(0x01020304);
  const buf = w.toBuffer();
  assert.equal(buf.length, 4);
  assert.equal(buf.readInt32BE(0), 0x01020304);
});

test("PacketWriter writeLong writes big-endian int64", () => {
  const w = new PacketWriter(16);
  w.writeLong(123456789012345678n);
  const buf = w.toBuffer();
  assert.equal(buf.length, 8);
  assert.equal(buf.readBigInt64BE(0), 123456789012345678n);
});

test("PacketWriter writeFloat writes big-endian float32", () => {
  const w = new PacketWriter(8);
  w.writeFloat(3.14);
  const buf = w.toBuffer();
  assert.equal(buf.length, 4);
  assert.ok(Math.abs(buf.readFloatBE(0) - 3.14) < 0.001);
});

test("PacketWriter writeDouble writes big-endian float64", () => {
  const w = new PacketWriter(16);
  w.writeDouble(3.141592653589793);
  const buf = w.toBuffer();
  assert.equal(buf.length, 8);
  assert.equal(buf.readDoubleBE(0), 3.141592653589793);
});

test("PacketWriter writeBytes copies buffer data", () => {
  const w = new PacketWriter(16);
  const data = Buffer.from([0x01, 0x02, 0x03]);
  w.writeBytes(data);
  const buf = w.toBuffer();
  assert.equal(buf.length, 3);
  assert.deepEqual([...buf], [0x01, 0x02, 0x03]);
});

test("PacketWriter writeFixedString pads with zeros", () => {
  const w = new PacketWriter(32);
  w.writeFixedString("abc", 8);
  const buf = w.toBuffer();
  assert.equal(buf.length, 8);
  assert.equal(buf.subarray(0, 3).toString("utf-8"), "abc");
  assert.deepEqual([...buf.subarray(3, 8)], [0, 0, 0, 0, 0]);
});

test("PacketWriter writeFixedString truncates if string exceeds length", () => {
  const w = new PacketWriter(8);
  w.writeFixedString("abcdefghij", 4);
  const buf = w.toBuffer();
  assert.equal(buf.length, 4);
  assert.equal(buf.toString("utf-8"), "abcd");
});

test("PacketWriter writeNullTermString writes length-prefixed null-terminated string", () => {
  const w = new PacketWriter(32);
  w.writeNullTermString("abc");
  const buf = w.toBuffer();
  // int32(4) + "abc" + \x00
  assert.equal(buf.length, 4 + 3 + 1);
  assert.equal(buf.readInt32BE(0), 4); // length including null terminator
  assert.equal(buf.subarray(4, 7).toString("utf-8"), "abc");
  assert.equal(buf[7], 0);
});

test("PacketWriter addByte writes int32(1) prefix then byte", () => {
  const w = new PacketWriter(16);
  w.addByte(99);
  const buf = w.toBuffer();
  assert.equal(buf.length, 5);
  assert.equal(buf.readInt32BE(0), 1);
  assert.equal(buf.readInt8(4), 99);
});

test("PacketWriter addShort writes int32(2) prefix then short", () => {
  const w = new PacketWriter(16);
  w.addShort(1234);
  const buf = w.toBuffer();
  assert.equal(buf.length, 6);
  assert.equal(buf.readInt32BE(0), 2);
  assert.equal(buf.readInt16BE(4), 1234);
});

test("PacketWriter addInt writes int32(4) prefix then int", () => {
  const w = new PacketWriter(16);
  w.addInt(42);
  const buf = w.toBuffer();
  assert.equal(buf.length, 8);
  assert.equal(buf.readInt32BE(0), 4);
  assert.equal(buf.readInt32BE(4), 42);
});

test("PacketWriter addLong writes int32(8) prefix then long", () => {
  const w = new PacketWriter(16);
  w.addLong(1234567890n);
  const buf = w.toBuffer();
  assert.equal(buf.length, 12);
  assert.equal(buf.readInt32BE(0), 8);
  assert.equal(buf.readBigInt64BE(4), 1234567890n);
});

test("PacketWriter addFloat writes int32(4) prefix then float", () => {
  const w = new PacketWriter(16);
  w.addFloat(2.5);
  const buf = w.toBuffer();
  assert.equal(buf.length, 8);
  assert.equal(buf.readInt32BE(0), 4);
  assert.equal(buf.readFloatBE(4), 2.5);
});

test("PacketWriter addDouble writes int32(8) prefix then double", () => {
  const w = new PacketWriter(16);
  w.addDouble(2.5);
  const buf = w.toBuffer();
  assert.equal(buf.length, 12);
  assert.equal(buf.readInt32BE(0), 8);
  assert.equal(buf.readDoubleBE(4), 2.5);
});

test("PacketWriter addBytes writes int32(len) prefix then raw bytes", () => {
  const w = new PacketWriter(16);
  const data = Buffer.from([0xaa, 0xbb]);
  w.addBytes(data);
  const buf = w.toBuffer();
  assert.equal(buf.length, 6);
  assert.equal(buf.readInt32BE(0), 2);
  assert.equal(buf[4], 0xaa);
  assert.equal(buf[5], 0xbb);
});

test("PacketWriter addNull writes int32(0)", () => {
  const w = new PacketWriter(8);
  w.addNull();
  const buf = w.toBuffer();
  assert.equal(buf.length, 4);
  assert.equal(buf.readInt32BE(0), 0);
});

test("PacketWriter addDatetime writes 7 shorts with int32(14) prefix", () => {
  const w = new PacketWriter(32);
  const d = new Date(2025, 2, 14, 10, 30, 45, 123); // March 14, 2025
  w.addDatetime(d);
  const buf = w.toBuffer();
  assert.equal(buf.length, 18); // 4 + 14
  assert.equal(buf.readInt32BE(0), 14);
  assert.equal(buf.readInt16BE(4), 2025); // year
  assert.equal(buf.readInt16BE(6), 3); // month
  assert.equal(buf.readInt16BE(8), 14); // day
  assert.equal(buf.readInt16BE(10), 10); // hour
  assert.equal(buf.readInt16BE(12), 30); // minute
  assert.equal(buf.readInt16BE(14), 45); // second
  assert.equal(buf.readInt16BE(16), 123); // millisecond
});

test("PacketWriter addDate writes date with zeroed time fields", () => {
  const w = new PacketWriter(32);
  const d = new Date(2025, 5, 15);
  w.addDate(d);
  const buf = w.toBuffer();
  assert.equal(buf.length, 18);
  assert.equal(buf.readInt32BE(0), 14);
  assert.equal(buf.readInt16BE(4), 2025);
  assert.equal(buf.readInt16BE(6), 6); // June
  assert.equal(buf.readInt16BE(8), 15);
  assert.equal(buf.readInt16BE(10), 0);
  assert.equal(buf.readInt16BE(12), 0);
  assert.equal(buf.readInt16BE(14), 0);
  assert.equal(buf.readInt16BE(16), 0);
});

test("PacketWriter auto-grows buffer when needed", () => {
  const w = new PacketWriter(4); // tiny initial capacity
  w.writeInt(1);
  w.writeInt(2);
  w.writeInt(3);
  const buf = w.toBuffer();
  assert.equal(buf.length, 12);
  assert.equal(buf.readInt32BE(0), 1);
  assert.equal(buf.readInt32BE(4), 2);
  assert.equal(buf.readInt32BE(8), 3);
});

test("PacketWriter.buildHeader creates 8-byte header", () => {
  const casInfo = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const header = PacketWriter.buildHeader(100, casInfo);
  assert.equal(header.length, 8);
  assert.equal(header.readUInt32BE(0), 100);
  assert.deepEqual([...header.subarray(4)], [0x01, 0x02, 0x03, 0x04]);
});

test("PacketWriter length returns current write position", () => {
  const w = new PacketWriter(16);
  assert.equal(w.length, 0);
  w.writeByte(1);
  assert.equal(w.length, 1);
  w.writeInt(2);
  assert.equal(w.length, 5);
});

// ---------------------------------------------------------------------------
// PacketReader tests
// ---------------------------------------------------------------------------

test("PacketReader parseByte reads single signed byte", () => {
  const r = new PacketReader(Buffer.from([0xff]));
  assert.equal(r.parseByte(), -1);
});

test("PacketReader parseUByte reads single unsigned byte", () => {
  const r = new PacketReader(Buffer.from([0xff]));
  assert.equal(r.parseUByte(), 255);
});

test("PacketReader parseShort reads big-endian int16", () => {
  const buf = Buffer.alloc(2);
  buf.writeInt16BE(0x0102);
  const r = new PacketReader(buf);
  assert.equal(r.parseShort(), 0x0102);
});

test("PacketReader parseInt reads big-endian int32", () => {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(0x01020304);
  const r = new PacketReader(buf);
  assert.equal(r.parseInt(), 0x01020304);
});

test("PacketReader parseLong reads big-endian int64", () => {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(9876543210n);
  const r = new PacketReader(buf);
  assert.equal(r.parseLong(), 9876543210n);
});

test("PacketReader parseFloat reads big-endian float32", () => {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(2.5);
  const r = new PacketReader(buf);
  assert.equal(r.parseFloat(), 2.5);
});

test("PacketReader parseDouble reads big-endian float64", () => {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(3.14159);
  const r = new PacketReader(buf);
  assert.equal(r.parseDouble(), 3.14159);
});

test("PacketReader parseBytes returns a copy of the specified range", () => {
  const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  const r = new PacketReader(buf);
  const result = r.parseBytes(3);
  assert.equal(result.length, 3);
  assert.deepEqual([...result], [0x01, 0x02, 0x03]);
  // Reader should have advanced past those bytes
  assert.equal(r.position, 3);
});

test("PacketReader parseNullTermString strips trailing nulls", () => {
  const buf = Buffer.from([0x61, 0x62, 0x63, 0x00]); // "abc\0"
  const r = new PacketReader(buf);
  assert.equal(r.parseNullTermString(4), "abc");
});

test("PacketReader parseNullTermString returns empty for zero length", () => {
  const r = new PacketReader(Buffer.alloc(0));
  assert.equal(r.parseNullTermString(0), "");
  assert.equal(r.parseNullTermString(-1), "");
});

test("PacketReader parseCASInfo reads 4 bytes", () => {
  const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  const r = new PacketReader(buf);
  const casInfo = r.parseCASInfo();
  assert.equal(casInfo.length, 4);
  assert.deepEqual([...casInfo], [0x01, 0x02, 0x03, 0x04]);
});

test("PacketReader parseDatetime reads 7 shorts and creates Date", () => {
  const buf = Buffer.alloc(14);
  let offset = 0;
  buf.writeInt16BE(2025, offset);
  offset += 2;
  buf.writeInt16BE(3, offset);
  offset += 2; // March
  buf.writeInt16BE(14, offset);
  offset += 2;
  buf.writeInt16BE(10, offset);
  offset += 2;
  buf.writeInt16BE(30, offset);
  offset += 2;
  buf.writeInt16BE(45, offset);
  offset += 2;
  buf.writeInt16BE(123, offset);

  const r = new PacketReader(buf);
  const d = r.parseDatetime();
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 2); // 0-indexed
  assert.equal(d.getDate(), 14);
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getSeconds(), 45);
  assert.equal(d.getMilliseconds(), 123);
});

test("PacketReader parseDate reads date only, zeroes time", () => {
  const buf = Buffer.alloc(6);
  buf.writeInt16BE(2025, 0);
  buf.writeInt16BE(6, 2); // June
  buf.writeInt16BE(15, 4);

  const r = new PacketReader(buf);
  const d = r.parseDate();
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 5); // 0-indexed
  assert.equal(d.getDate(), 15);
});

for (const year of [1, 99, 100, 9999]) {
  test(`PacketReader keeps year ${year} out of the 1900s for DATE, DATETIME and TIMESTAMP`, () => {
    const buf = Buffer.alloc(14);
    [year, 3, 14, 10, 30, 45, 123].forEach((v, i) => {
      buf.writeInt16BE(v, i * 2);
    });

    const dt = new PacketReader(buf).parseDatetime();
    assert.equal(dt.getFullYear(), year);
    assert.deepEqual(
      [dt.getMonth(), dt.getDate(), dt.getHours(), dt.getMinutes(), dt.getSeconds()],
      [2, 14, 10, 30, 45],
    );
    assert.equal(dt.getMilliseconds(), 123);

    const ts = new PacketReader(buf).parseTimestamp();
    assert.equal(ts.getFullYear(), year);
    assert.equal(ts.getSeconds(), 45);

    const d = new PacketReader(buf).parseDate();
    assert.equal(d.getFullYear(), year);
    assert.deepEqual([d.getMonth(), d.getDate(), d.getHours()], [2, 14, 0]);
  });
}

test("PacketReader parseTime reads time only", () => {
  const buf = Buffer.alloc(6);
  buf.writeInt16BE(10, 0); // hour
  buf.writeInt16BE(30, 2); // minute
  buf.writeInt16BE(45, 4); // second

  const r = new PacketReader(buf);
  const d = r.parseTime();
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getSeconds(), 45);
});

test("PacketReader readError parses error code and message", () => {
  const code = -493;
  const message = "Table not found\0";
  const buf = Buffer.alloc(4 + message.length);
  buf.writeInt32BE(code, 0);
  buf.write(message, 4, "utf-8");

  const r = new PacketReader(buf);
  const err = r.readError(buf.length);
  assert.equal(err.code, -493);
  assert.equal(err.message, "Table not found");
});

test("PacketReader readError with empty message", () => {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(-1, 0);

  const r = new PacketReader(buf);
  const err = r.readError(4);
  assert.equal(err.code, -1);
  assert.equal(err.message, "");
});

test("PacketReader skip advances position", () => {
  const r = new PacketReader(Buffer.alloc(10));
  assert.equal(r.position, 0);
  r.skip(5);
  assert.equal(r.position, 5);
});

test("PacketReader remaining returns unread bytes", () => {
  const r = new PacketReader(Buffer.alloc(10));
  assert.equal(r.remaining, 10);
  r.skip(3);
  assert.equal(r.remaining, 7);
});

test("PacketReader with initial offset", () => {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(42, 4);
  const r = new PacketReader(buf, 4);
  assert.equal(r.parseInt(), 42);
});

test("PacketReader parseTimestamp reads 6 shorts (no ms)", () => {
  const buf = Buffer.alloc(12);
  buf.writeInt16BE(2025, 0);
  buf.writeInt16BE(6, 2); // June
  buf.writeInt16BE(15, 4); // day
  buf.writeInt16BE(14, 6); // hour
  buf.writeInt16BE(30, 8); // minute
  buf.writeInt16BE(59, 10); // second

  const r = new PacketReader(buf);
  const d = r.parseTimestamp();
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 5); // 0-indexed
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getSeconds(), 59);
});

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------

test("CAS_MAGIC is CUBRK", () => {
  assert.equal(CAS_MAGIC, "CUBRK");
});

test("CAS_VERSION combines indicator and version", () => {
  assert.equal(CAS_VERSION, 0x40 | 7);
  assert.equal(CAS_VERSION, 0x47);
});

test("CLIENT_JDBC is 3", () => {
  assert.equal(CLIENT_JDBC, 3);
});

// Literal wire codes from T_CCI_U_TYPE (CUBRID/cubrid src/broker/broker_cas_cci.h).
// Deliberately not derived from CUBRIDDataType so a wrong constant cannot hide.
// [name, enum value under test, literal wire code]
const CCI_WIRE_CODES: Array<[string, number, number]> = [
  ["NULL", CUBRIDDataType.NULL, 0],
  ["CHAR", CUBRIDDataType.CHAR, 1],
  ["STRING", CUBRIDDataType.STRING, 2],
  ["NCHAR", CUBRIDDataType.NCHAR, 3],
  ["VARNCHAR", CUBRIDDataType.VARNCHAR, 4],
  ["BIT", CUBRIDDataType.BIT, 5],
  ["VARBIT", CUBRIDDataType.VARBIT, 6],
  ["NUMERIC", CUBRIDDataType.NUMERIC, 7],
  ["INT", CUBRIDDataType.INT, 8],
  ["SHORT", CUBRIDDataType.SHORT, 9],
  ["MONETARY", CUBRIDDataType.MONETARY, 10],
  ["FLOAT", CUBRIDDataType.FLOAT, 11],
  ["DOUBLE", CUBRIDDataType.DOUBLE, 12],
  ["DATE", CUBRIDDataType.DATE, 13],
  ["TIME", CUBRIDDataType.TIME, 14],
  ["TIMESTAMP", CUBRIDDataType.TIMESTAMP, 15],
  ["SET", CUBRIDDataType.SET, 16],
  ["MULTISET", CUBRIDDataType.MULTISET, 17],
  ["SEQUENCE", CUBRIDDataType.SEQUENCE, 18],
  ["OBJECT", CUBRIDDataType.OBJECT, 19],
  ["RESULTSET", CUBRIDDataType.RESULTSET, 20],
  ["BIGINT", CUBRIDDataType.BIGINT, 21],
  ["DATETIME", CUBRIDDataType.DATETIME, 22],
  ["BLOB", CUBRIDDataType.BLOB, 23],
  ["CLOB", CUBRIDDataType.CLOB, 24],
  ["ENUM", CUBRIDDataType.ENUM, 25],
  ["JSON", CUBRIDDataType.JSON, 34],
];

test("CUBRIDDataType values match CCI wire codes", () => {
  for (const [name, actual, expected] of CCI_WIRE_CODES) {
    assert.equal(actual, expected, name);
  }
});

test("TYPE_NAMES maps literal wire codes to type names", () => {
  assert.equal(TYPE_NAMES[0], "NULL");
  assert.equal(TYPE_NAMES[2], "VARCHAR");
  assert.equal(TYPE_NAMES[8], "INT");
  assert.equal(TYPE_NAMES[9], "SMALLINT");
  assert.equal(TYPE_NAMES[13], "DATE");
  assert.equal(TYPE_NAMES[16], "SET");
  assert.equal(TYPE_NAMES[17], "MULTISET");
  assert.equal(TYPE_NAMES[18], "SEQUENCE");
  assert.equal(TYPE_NAMES[19], "OBJECT");
  assert.equal(TYPE_NAMES[20], "RESULTSET");
  assert.equal(TYPE_NAMES[21], "BIGINT");
  assert.equal(TYPE_NAMES[22], "DATETIME");
  assert.equal(TYPE_NAMES[23], "BLOB");
  assert.equal(TYPE_NAMES[24], "CLOB");
  assert.equal(TYPE_NAMES[34], "JSON");
  // 26 is CCI_U_TYPE_USHORT, not BIGINT
  assert.notEqual(TYPE_NAMES[26], "BIGINT");
});

test("OPEN_DB_TOTAL_SIZE is 628", () => {
  assert.equal(OPEN_DB_TOTAL_SIZE, 628);
});

test("PREPARE_NORMAL and EXECUTE constants", () => {
  assert.equal(PREPARE_NORMAL, 0x00);
  assert.equal(EXECUTE_NORMAL, 0x00);
  assert.equal(EXECUTE_QUERY_ALL, 0x02);
});

// ---------------------------------------------------------------------------
// Handshake protocol tests
// ---------------------------------------------------------------------------

test("writeClientInfoExchange produces 10-byte packet", () => {
  const buf = writeClientInfoExchange();
  assert.equal(buf.length, 10);
  assert.equal(buf.subarray(0, 5).toString("ascii"), "CUBRK");
  assert.equal(buf[5], CLIENT_JDBC);
  assert.equal(buf[6], CAS_VERSION);
  assert.equal(buf[7], 0);
  assert.equal(buf[8], 0);
  assert.equal(buf[9], 0);
});

test("parseClientInfoExchange reads redirect port", () => {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(33001, 0);
  assert.equal(parseClientInfoExchange(buf), 33001);

  buf.writeInt32BE(0, 0);
  assert.equal(parseClientInfoExchange(buf), 0);

  buf.writeInt32BE(-1, 0);
  assert.equal(parseClientInfoExchange(buf), -1);
});

test("writeOpenDatabase produces 628-byte packet", () => {
  const buf = writeOpenDatabase("testdb", "dba", "secret");
  assert.equal(buf.length, OPEN_DB_TOTAL_SIZE);
  // First 32 bytes: database name
  assert.equal(buf.subarray(0, 6).toString("utf-8"), "testdb");
  assert.equal(buf[6], 0); // padding
  // 32-63: user
  assert.equal(buf.subarray(32, 35).toString("utf-8"), "dba");
  // 64-95: password
  assert.equal(buf.subarray(64, 70).toString("utf-8"), "secret");
});

test("parseOpenDatabase parses successful response", () => {
  // Build a mock response: CAS_INFO(4) + responseCode(4) + brokerInfo(8) + sessionId(4)
  const buf = Buffer.alloc(4 + 4 + 8 + 4);
  let offset = 0;
  // CAS_INFO
  buf[0] = 0x01;
  buf[1] = 0x02;
  buf[2] = 0x03;
  buf[3] = 0x04;
  offset = 4;
  // responseCode (>= 0 means success)
  buf.writeInt32BE(1, offset);
  offset += 4;
  // brokerInfo (8 bytes) — byte[4] = protoVersion
  buf[offset + 4] = 0x02; // protoVersion = 2 (masked with 0x3F)
  offset += 8;
  // sessionId
  buf.writeInt32BE(12345, offset);

  const result = parseOpenDatabase(buf);
  assert.deepEqual([...result.casInfo], [0x01, 0x02, 0x03, 0x04]);
  assert.equal(result.responseCode, 1);
  assert.equal(result.protoVersion, 2);
  assert.equal(result.sessionId, 12345);
});

test("parseOpenDatabase throws on error response", () => {
  // CAS_INFO(4) + responseCode(-1)(4) + errorCode(4) + errorMessage
  const errMsg = "Access denied\0";
  const buf = Buffer.alloc(4 + 4 + 4 + errMsg.length);
  buf[0] = 0x01;
  buf[1] = 0x02;
  buf[2] = 0x03;
  buf[3] = 0x04;
  buf.writeInt32BE(-1, 4);
  buf.writeInt32BE(-111, 8);
  buf.write(errMsg, 12, "utf-8");

  assert.throws(
    () => parseOpenDatabase(buf),
    (err: Error) => {
      return err.message.includes("-111") && err.message.includes("Access denied");
    },
  );
});

// ---------------------------------------------------------------------------
// PrepareAndExecute tests
// ---------------------------------------------------------------------------

test("writePrepareAndExecute builds valid request", () => {
  const casInfo = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const { header, payload } = writePrepareAndExecute("SELECT 1", true, casInfo);

  assert.equal(header.length, 8);
  assert.equal(header.readUInt32BE(0), payload.length);
  assert.deepEqual([...header.subarray(4)], [0x01, 0x02, 0x03, 0x04]);

  // First byte is function code
  assert.equal(payload[0], CASFunctionCode.PREPARE_AND_EXECUTE);
});

test("writePrepareAndExecute with autoCommit false", () => {
  const casInfo = Buffer.alloc(4);
  const { payload } = writePrepareAndExecute("INSERT INTO t VALUES (1)", false, casInfo);
  assert.equal(payload[0], CASFunctionCode.PREPARE_AND_EXECUTE);
});

// ---------------------------------------------------------------------------
// Fetch tests
// ---------------------------------------------------------------------------

test("writeFetch builds valid request", () => {
  const casInfo = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const { header, payload } = writeFetch(42, 10, 100, casInfo);

  assert.equal(header.length, 8);
  assert.equal(payload[0], CASFunctionCode.FETCH);
});

test("parseFetch rejects malformed negative error frame instead of returning EOF", () => {
  // A response code alone is not a complete CAS error block.
  const buf = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => parseFetch(buf, []));
});

test("parseFetch rejects CAS -1 errors with literal server codes", () => {
  // -1 envelope, then server code (-10006 invalid handle / -10012 no data).
  for (const [code, message] of [
    [-10006, "Server handle not found"],
    [-10012, "No more data"],
  ] as const) {
    const msg = Buffer.from(message + "\0", "utf-8");
    const buf = Buffer.alloc(8 + msg.length);
    buf.writeInt32BE(-1, 0);
    buf.writeInt32BE(code, 4);
    msg.copy(buf, 8);
    assert.throws(
      () => parseFetch(buf, []),
      (error: Error) => error.message.includes(String(code)) && error.message.includes(message),
    );
  }
});

test("parseFetch handles error response", () => {
  const errMsg = "Fetch error\0";
  const buf = Buffer.alloc(4 + 4 + errMsg.length);
  buf.writeInt32BE(-2, 0);
  buf.writeInt32BE(-500, 4);
  buf.write(errMsg, 8, "utf-8");

  assert.throws(
    () => parseFetch(buf, []),
    (err: Error) => {
      return err.message.includes("-500") && err.message.includes("Fetch error");
    },
  );
});

// ---------------------------------------------------------------------------
// CloseReqHandle tests
// ---------------------------------------------------------------------------

test("writeCloseReqHandle builds valid request", () => {
  const casInfo = Buffer.alloc(4);
  const { header, payload } = writeCloseReqHandle(99, casInfo);
  assert.equal(header.length, 8);
  assert.equal(payload[0], CASFunctionCode.CLOSE_REQ_HANDLE);
});

// ---------------------------------------------------------------------------
// EndTran tests
// ---------------------------------------------------------------------------

test("writeSetDbParameter sends the code, then the parameter and value as length-prefixed ints", () => {
  const casInfo = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const { header, payload } = writeSetDbParameter(2, -1, casInfo);

  assert.deepEqual(
    payload,
    Buffer.from([5, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0, 4, 0xff, 0xff, 0xff, 0xff]),
  );
  assert.equal(header.readInt32BE(0), payload.length);
  assert.deepEqual(header.subarray(4), casInfo);
});

test("writeEndTran commit builds valid request", () => {
  const casInfo = Buffer.alloc(4);
  const { header, payload } = writeEndTran(EndTranType.COMMIT, casInfo);
  assert.equal(header.length, 8);
  assert.equal(payload[0], CASFunctionCode.END_TRAN);
});

test("writeEndTran rollback builds valid request", () => {
  const casInfo = Buffer.alloc(4);
  const { payload } = writeEndTran(EndTranType.ROLLBACK, casInfo);
  assert.equal(payload[0], CASFunctionCode.END_TRAN);
});

// ---------------------------------------------------------------------------
// GetDbVersion tests
// ---------------------------------------------------------------------------

test("writeGetDbVersion builds valid request", () => {
  const casInfo = Buffer.alloc(4);
  const { header, payload } = writeGetDbVersion(true, casInfo);
  assert.equal(header.length, 8);
  assert.equal(payload[0], CASFunctionCode.GET_DB_VERSION);
});

test("parseGetDbVersion parses version string", () => {
  const version = "11.2.0.0343\0";
  const buf = Buffer.alloc(4 + version.length);
  buf.writeInt32BE(0, 0); // success code
  buf.write(version, 4, "utf-8");

  const result = parseGetDbVersion(buf);
  assert.equal(result, "11.2.0.0343");
});

test("parseGetDbVersion throws on error", () => {
  const errMsg = "Not connected\0";
  const buf = Buffer.alloc(4 + 4 + errMsg.length);
  buf.writeInt32BE(-1, 0);
  buf.writeInt32BE(-999, 4);
  buf.write(errMsg, 8, "utf-8");

  assert.throws(
    () => parseGetDbVersion(buf),
    (err: Error) => {
      return err.message.includes("-999");
    },
  );
});

// ---------------------------------------------------------------------------
// ConClose tests
// ---------------------------------------------------------------------------

test("writeConClose builds valid request", () => {
  const casInfo = Buffer.alloc(4);
  const { header, payload } = writeConClose(casInfo);
  assert.equal(header.length, 8);
  assert.equal(payload[0], CASFunctionCode.CON_CLOSE);
});

// ---------------------------------------------------------------------------
// parseSimpleResponse tests
// ---------------------------------------------------------------------------

test("parseSimpleResponse succeeds for non-negative code", () => {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(0, 0);
  assert.doesNotThrow(() => parseSimpleResponse(buf));
});

test("parseSimpleResponse throws on negative code", () => {
  const errMsg = "Operation failed\0";
  const buf = Buffer.alloc(4 + 4 + errMsg.length);
  buf.writeInt32BE(-1, 0);
  buf.writeInt32BE(-42, 4);
  buf.write(errMsg, 8, "utf-8");

  assert.throws(
    () => parseSimpleResponse(buf),
    (err: Error) => {
      return err.message.includes("-42") && err.message.includes("Operation failed");
    },
  );
});

// ---------------------------------------------------------------------------
// encodeBindParams tests
// ---------------------------------------------------------------------------

test("encodeBindParams encodes null", () => {
  const buf = encodeBindParams([null]);
  assert.equal(buf.readInt32BE(0), 0);
});

test("encodeBindParams encodes undefined as null", () => {
  const buf = encodeBindParams([undefined]);
  assert.equal(buf.readInt32BE(0), 0);
});

test("encodeBindParams encodes boolean", () => {
  const buf = encodeBindParams([true]);
  assert.equal(buf.readInt32BE(0), 1 + 2); // size: type_byte + short
  assert.equal(buf[4], CUBRIDDataType.SHORT);
  assert.equal(buf.readInt16BE(5), 1);

  const buf2 = encodeBindParams([false]);
  assert.equal(buf2.readInt16BE(5), 0);
});

test("encodeBindParams encodes integer within int32 range", () => {
  const buf = encodeBindParams([42]);
  assert.equal(buf.readInt32BE(0), 1 + 4); // type_byte + int32
  assert.equal(buf[4], CUBRIDDataType.INT);
  assert.equal(buf.readInt32BE(5), 42);
});

test("encodeBindParams encodes large integer as BIGINT", () => {
  const large = 2147483648; // exceeds int32 max
  const buf = encodeBindParams([large]);
  assert.equal(buf.readInt32BE(0), 1 + 8); // type_byte + int64
  assert.equal(buf[4], 21); // CCI_U_TYPE_BIGINT
  assert.equal(buf.readBigInt64BE(5), BigInt(large));
});

test("encodeBindParams encodes floating point as DOUBLE", () => {
  const buf = encodeBindParams([3.14]);
  assert.equal(buf.readInt32BE(0), 1 + 8); // type_byte + double
  assert.equal(buf[4], CUBRIDDataType.DOUBLE);
  assert.ok(Math.abs(buf.readDoubleBE(5) - 3.14) < 0.0001);
});

test("encodeBindParams encodes bigint", () => {
  const buf = encodeBindParams([9876543210n]);
  assert.equal(buf[4], 21); // CCI_U_TYPE_BIGINT
  assert.equal(buf.readBigInt64BE(5), 9876543210n);
});

test("encodeBindParams encodes string", () => {
  const buf = encodeBindParams(["hello"]);
  const expectedSize = 1 + 5 + 1; // type_byte + "hello" + null terminator
  assert.equal(buf.readInt32BE(0), expectedSize);
  assert.equal(buf[4], CUBRIDDataType.STRING);
  assert.equal(buf.subarray(5, 10).toString("utf-8"), "hello");
  assert.equal(buf[10], 0); // null terminator
});

test("encodeBindParams encodes Date as DATETIME", () => {
  const d = new Date(2025, 2, 14, 10, 30, 45, 123);
  const buf = encodeBindParams([d]);
  assert.equal(buf[4], CUBRIDDataType.DATETIME);
  assert.equal(buf.readInt16BE(5), 2025);
  assert.equal(buf.readInt16BE(7), 3);
  assert.equal(buf.readInt16BE(9), 14);
});

test("encodeBindParams encodes Buffer as VARBIT", () => {
  const data = Buffer.from([0xaa, 0xbb, 0xcc]);
  const buf = encodeBindParams([data]);
  assert.equal(buf.readInt32BE(0), 1 + 3); // type_byte + data length
  assert.equal(buf[4], CUBRIDDataType.VARBIT);
  assert.deepEqual([...buf.subarray(5, 8)], [0xaa, 0xbb, 0xcc]);
});

test("encodeBindParams fallback stringifies unknown types", () => {
  const buf = encodeBindParams([{ toString: () => "custom" }]);
  assert.equal(buf[4], CUBRIDDataType.STRING);
});

test("encodeBindParams encodes multiple params sequentially", () => {
  const buf = encodeBindParams([42, "hello", null]);
  // Should encode all three without error
  assert.ok(buf.length > 0);
  // First param: int32(5) + byte(INT) + int32(42)
  assert.equal(buf.readInt32BE(0), 5);
  assert.equal(buf[4], CUBRIDDataType.INT);
  assert.equal(buf.readInt32BE(5), 42);
});

// ---------------------------------------------------------------------------
// interpolateParams tests
// ---------------------------------------------------------------------------

test("interpolateParams replaces ? with formatted values", () => {
  const result = interpolateParams(
    "SELECT * FROM t WHERE id = ? AND name = ?",
    [42, "Alice"],
    true,
  );
  assert.equal(result, "SELECT * FROM t WHERE id = 42 AND name = 'Alice'");
});

test("interpolateParams handles null", () => {
  const result = interpolateParams("INSERT INTO t (v) VALUES (?)", [null], true);
  assert.equal(result, "INSERT INTO t (v) VALUES (NULL)");
});

test("interpolateParams handles boolean", () => {
  const result = interpolateParams("SELECT ? AS val", [true], true);
  assert.equal(result, "SELECT 1 AS val");
});

test("interpolateParams handles bigint", () => {
  const result = interpolateParams("SELECT ?", [9876543210n], true);
  assert.equal(result, "SELECT 9876543210");
});

test("interpolateParams handles Date", () => {
  const d = new Date(Date.UTC(2025, 2, 14, 10, 30, 45, 123));
  const result = interpolateParams("SELECT ?", [d], true);
  assert.ok(result.includes("DATETIME'2025-03-14 10:30:45.123'"));
});

test("interpolateParams handles Buffer", () => {
  const result = interpolateParams("SELECT ?", [Buffer.from([0xaa, 0xbb])], true);
  assert.equal(result, "SELECT X'aabb'");
});

test("interpolateParams preserves strings inside single quotes", () => {
  const result = interpolateParams("SELECT * FROM t WHERE name = '?' AND id = ?", [42], true);
  assert.equal(result, "SELECT * FROM t WHERE name = '?' AND id = 42");
});

test("interpolateParams skips ? inside block comments", () => {
  const result = interpolateParams("SELECT 1 /* ? */ WHERE id = ?", [7], true);
  assert.equal(result, "SELECT 1 /* ? */ WHERE id = 7");
});

test("interpolateParams skips ? inside line comments", () => {
  const result = interpolateParams("SELECT 1 -- ?\nWHERE id = ?", [7], true);
  assert.equal(result, "SELECT 1 -- ?\nWHERE id = 7");
});

test("interpolateParams preserves strings inside double quotes", () => {
  const result = interpolateParams('SELECT * FROM t WHERE "col?" = ?', [42], true);
  assert.equal(result, 'SELECT * FROM t WHERE "col?" = 42');
});

test("interpolateParams handles escaped quotes", () => {
  const result = interpolateParams("SELECT * FROM t WHERE name = 'O''Brien' AND id = ?", [1], true);
  assert.equal(result, "SELECT * FROM t WHERE name = 'O''Brien' AND id = 1");
});

test("interpolateParams throws on insufficient params", () => {
  assert.throws(
    () => interpolateParams("SELECT ?, ?", [1], true),
    (err: Error) => err.message.includes("Not enough parameters"),
  );
});

test("interpolateParams handles no params in SQL", () => {
  const result = interpolateParams("SELECT 1", [], true);
  assert.equal(result, "SELECT 1");
});

test("interpolateParams is backslash-mode aware for string params", () => {
  // Literal mode (CUBRID default): backslash preserved verbatim.
  assert.equal(interpolateParams("SELECT ?", ["C:\\temp"], true), "SELECT 'C:\\temp'");
  // Escape mode: backslash doubled.
  assert.equal(interpolateParams("SELECT ?", ["C:\\temp"], false), "SELECT 'C:\\\\temp'");
});

// ---------------------------------------------------------------------------
// formatValue tests
// ---------------------------------------------------------------------------

test("formatValue formats null and undefined", () => {
  assert.equal(formatValue(null, true), "NULL");
  assert.equal(formatValue(undefined, true), "NULL");
});

test("formatValue formats boolean", () => {
  assert.equal(formatValue(true, true), "1");
  assert.equal(formatValue(false, true), "0");
});

test("formatValue formats number", () => {
  assert.equal(formatValue(42, true), "42");
  assert.equal(formatValue(3.14, true), "3.14");
});

test("formatValue formats bigint", () => {
  assert.equal(formatValue(9876543210n, true), "9876543210");
});

test("formatValue escapes string in literal mode (no_backslash_escapes=yes)", () => {
  // CUBRID default: only the single quote is special; backslash is literal.
  assert.equal(formatValue("hello", true), "'hello'");
  assert.equal(formatValue("it's", true), "'it''s'");
  assert.equal(formatValue("back\\slash", true), "'back\\slash'");
  assert.equal(formatValue("new\nline", true), "'new\nline'");
  assert.equal(formatValue("return\rcar", true), "'return\rcar'");
});

test("formatValue escapes string in escape mode (no_backslash_escapes=no)", () => {
  assert.equal(formatValue("hello", false), "'hello'");
  assert.equal(formatValue("it's", false), "'it''s'");
  assert.equal(formatValue("back\\slash", false), "'back\\\\slash'");
  // Backslash prepended before the literal newline / carriage return.
  assert.equal(formatValue("new\nline", false), "'new\\\nline'");
  assert.equal(formatValue("return\rcar", false), "'return\\\rcar'");
});

test("formatValue rejects NUL and Ctrl-Z bytes in both modes", () => {
  for (const mode of [true, false]) {
    assert.throws(() => formatValue("null\0byte", mode), /null byte/);
    assert.throws(() => formatValue("ctrlz\x1abyte", mode), /Ctrl-Z/);
  }
});

test("formatValue formats Date", () => {
  const d = new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 0));
  assert.equal(formatValue(d, true), "DATETIME'2025-01-01 00:00:00.000'");
});

test("formatValue formats Date using UTC getters", () => {
  class FakeDate extends Date {
    override getFullYear(): number {
      return 2000;
    }

    override getMonth(): number {
      return 0;
    }

    override getDate(): number {
      return 1;
    }

    override getHours(): number {
      return 0;
    }

    override getMinutes(): number {
      return 0;
    }

    override getSeconds(): number {
      return 0;
    }

    override getMilliseconds(): number {
      return 0;
    }

    override getUTCFullYear(): number {
      return 2025;
    }

    override getUTCMonth(): number {
      return 2;
    }

    override getUTCDate(): number {
      return 14;
    }

    override getUTCHours(): number {
      return 10;
    }

    override getUTCMinutes(): number {
      return 30;
    }

    override getUTCSeconds(): number {
      return 45;
    }

    override getUTCMilliseconds(): number {
      return 123;
    }
  }

  const d = new FakeDate("2025-03-14T10:30:45.123Z");
  assert.equal(formatValue(d, true), "DATETIME'2025-03-14 10:30:45.123'");
});

test("formatValue formats Buffer", () => {
  assert.equal(formatValue(Buffer.from([0xde, 0xad]), true), "X'dead'");
});

test("formatValue stringifies unknown types", () => {
  assert.equal(formatValue({ toString: () => "custom" }, true), "'custom'");
});

// ---------------------------------------------------------------------------
// parsePrepareAndExecute tests
// ---------------------------------------------------------------------------

test("parsePrepareAndExecute throws on error response", () => {
  const errMsg = "Syntax error\0";
  const buf = Buffer.alloc(4 + 4 + errMsg.length);
  buf.writeInt32BE(-1, 0);
  buf.writeInt32BE(-493, 4);
  buf.write(errMsg, 8, "utf-8");

  assert.throws(
    () => parsePrepareAndExecute(buf, 1),
    (err: Error) => {
      return err.message.includes("-493") && err.message.includes("Syntax error");
    },
  );
});

test("StatementType values match the CUBRID CCI/CAS statement type ids", () => {
  // Literal ids (CUBRID T_CCI_CUBRID_STMT; node-cubrid CUBRIDStatementType;
  // pycubrid CUBRIDStatementType). Deliberately not derived from the enum so
  // that any renumbering fails here.
  assert.equal(StatementType.ALTER_CLASS, 0);
  assert.equal(StatementType.ALTER_SERIAL, 1);
  assert.equal(StatementType.COMMIT_WORK, 2);
  assert.equal(StatementType.REGISTER_DATABASE, 3);
  assert.equal(StatementType.CREATE_CLASS, 4);
  assert.equal(StatementType.CREATE_INDEX, 5);
  assert.equal(StatementType.CREATE_TRIGGER, 6);
  assert.equal(StatementType.CREATE_SERIAL, 7);
  assert.equal(StatementType.DROP_DATABASE, 8);
  assert.equal(StatementType.DROP_CLASS, 9);
  assert.equal(StatementType.DROP_INDEX, 10);
  assert.equal(StatementType.DROP_LABEL, 11);
  assert.equal(StatementType.DROP_TRIGGER, 12);
  assert.equal(StatementType.DROP_SERIAL, 13);
  assert.equal(StatementType.EVALUATE, 14);
  assert.equal(StatementType.RENAME_CLASS, 15);
  assert.equal(StatementType.ROLLBACK_WORK, 16);
  assert.equal(StatementType.GRANT, 17);
  assert.equal(StatementType.REVOKE, 18);
  assert.equal(StatementType.UPDATE_STATS, 19);
  assert.equal(StatementType.INSERT, 20);
  assert.equal(StatementType.SELECT, 21);
  assert.equal(StatementType.UPDATE, 22);
  assert.equal(StatementType.DELETE, 23);
  assert.equal(StatementType.CALL, 24);
  assert.equal(StatementType.GET_STATS, 41);
  assert.equal(StatementType.CALL_SP, 0x7e);
  assert.equal(StatementType.UNKNOWN, 0x7f);
});

test("parsePrepareAndExecute reports literal statement codes from the wire", () => {
  for (const code of [0, 4, 9, 17, 20, 22, 23, 24]) {
    const buf = Buffer.alloc(64);
    let offset = 0;
    buf.writeInt32BE(1, offset);
    offset += 4; // queryHandle
    buf.writeInt32BE(0, offset);
    offset += 4; // cache lifetime
    buf.writeInt8(code, offset);
    offset += 1; // statement type
    buf.writeInt32BE(0, offset);
    offset += 4; // bind count
    buf.writeInt8(0, offset);
    offset += 1; // is_updatable
    buf.writeInt32BE(0, offset);
    offset += 4; // column count
    buf.writeInt32BE(0, offset);
    offset += 4; // total tuple count
    buf.writeInt8(0, offset);
    offset += 1; // cache_reusable
    buf.writeInt32BE(0, offset);
    offset += 4; // result count
    const result = parsePrepareAndExecute(buf.subarray(0, offset), 1);
    assert.equal(result.statementType, code);
    assert.deepEqual(result.rows, []);
  }
});

test("readQueryHandle returns the handle of a response that cannot be decoded", () => {
  const buf = Buffer.alloc(6);
  buf.writeInt32BE(7, 0);

  assert.equal(readQueryHandle(buf), 7);
  assert.throws(() => parsePrepareAndExecute(buf, 1));
});

test("readQueryHandle returns null for a server error", () => {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(-1, 0);

  assert.equal(readQueryHandle(buf), null);
});

test("readQueryHandle returns null when the handle itself is cut off", () => {
  assert.equal(readQueryHandle(Buffer.alloc(3)), null);
});

test("parsePrepareAndExecute parses non-SELECT result", () => {
  // Build a minimal successful PrepareAndExecute response for INSERT
  // responseCode(4) + cacheLifetime(4) + stmtType(1) + bindCount(4) + isUpdatable(1) + colCount(4)
  // + totalTupleCount(4) + cacheReusable(1) + resultCount(4) + resultInfo(17 per result)
  const buf = Buffer.alloc(128);
  let offset = 0;
  buf.writeInt32BE(1, offset);
  offset += 4; // queryHandle = 1
  buf.writeInt32BE(0, offset);
  offset += 4; // cache lifetime
  buf.writeInt8(StatementType.INSERT, offset);
  offset += 1; // INSERT
  buf.writeInt32BE(0, offset);
  offset += 4; // bind count = 0
  buf.writeInt8(0, offset);
  offset += 1; // not updatable
  buf.writeInt32BE(0, offset);
  offset += 4; // column count = 0
  // Execute portion
  buf.writeInt32BE(1, offset);
  offset += 4; // total tuple count = 1
  buf.writeInt8(0, offset);
  offset += 1; // cache_reusable
  buf.writeInt32BE(1, offset);
  offset += 4; // result count = 1
  // Result info (21 bytes = byte + int + OID(8) + cacheTimeSec + cacheTimeUsec)
  buf.writeInt8(StatementType.INSERT, offset);
  offset += 1; // stmt type
  buf.writeInt32BE(1, offset);
  offset += 4; // affected rows
  // OID (8 bytes)
  buf.writeInt32BE(0, offset);
  offset += 4; // oid part 1
  buf.writeInt32BE(0, offset);
  offset += 4; // oid part 2
  buf.writeInt32BE(0, offset);
  offset += 4; // cache time seconds
  buf.writeInt32BE(0, offset);
  offset += 4; // cache time microseconds

  const result = parsePrepareAndExecute(buf.subarray(0, offset), 1);
  assert.equal(result.queryHandle, 1);
  assert.equal(result.statementType, StatementType.INSERT);
  assert.equal(result.bindCount, 0);
  assert.equal(result.columnCount, 0);
  assert.equal(result.totalTupleCount, 1);
  assert.deepEqual(result.rows, []);
});

// ---------------------------------------------------------------------------
// parsePrepareAndExecute — SELECT with inline rows and various data types
// ---------------------------------------------------------------------------

/**
 * Helper: build a PrepareAndExecute SELECT response with column metadata and inline rows.
 * Each column value is written according to its CUBRIDDataType.
 */
function buildSelectResponseForTypes(
  columns: Array<{ name: string; type: number }>,
  rowValues: Array<Array<{ type: number; data: Buffer | null }>>,
): Buffer {
  const parts: Buffer[] = [];

  // queryHandle = 1
  const qh = Buffer.alloc(4);
  qh.writeInt32BE(1, 0);
  parts.push(qh);

  // result_cache_lifetime = 0
  parts.push(Buffer.alloc(4));

  // statementType = SELECT (21)
  const st = Buffer.alloc(1);
  st.writeInt8(21, 0);
  parts.push(st);

  // bindCount = 0
  parts.push(Buffer.alloc(4));

  // isUpdatable = 0
  parts.push(Buffer.from([0]));

  // numColumns
  const nc = Buffer.alloc(4);
  nc.writeInt32BE(columns.length, 0);
  parts.push(nc);

  // Column metadata
  for (const col of columns) {
    // type (1 byte)
    parts.push(Buffer.from([col.type]));
    // scale (2 bytes)
    parts.push(Buffer.alloc(2));
    // precision (4 bytes)
    const cp = Buffer.alloc(4);
    cp.writeInt32BE(255, 0);
    parts.push(cp);
    // name (length-prefixed, null-terminated)
    const nameBytes = Buffer.from(col.name, "utf-8");
    const nl = Buffer.alloc(4);
    nl.writeInt32BE(nameBytes.length + 1, 0);
    parts.push(nl, nameBytes, Buffer.from([0]));
    // realName
    const rnl = Buffer.alloc(4);
    rnl.writeInt32BE(nameBytes.length + 1, 0);
    parts.push(rnl, Buffer.from(nameBytes), Buffer.from([0]));
    // tableName
    const tl = Buffer.alloc(4);
    tl.writeInt32BE(1, 0);
    parts.push(tl, Buffer.from([0]));
    // isNullable
    parts.push(Buffer.from([1]));
    // defaultValue
    const dl = Buffer.alloc(4);
    dl.writeInt32BE(1, 0);
    parts.push(dl, Buffer.from([0]));
    // flags: autoInc, uniqueKey, primaryKey, reverseIdx, reverseUnique, foreignKey, shared
    parts.push(Buffer.from([0, 0, 0, 0, 0, 0, 0]));
  }

  // Execute portion: totalTupleCount
  const ttc = Buffer.alloc(4);
  ttc.writeInt32BE(rowValues.length, 0);
  parts.push(ttc);

  // cache_reusable = 0
  parts.push(Buffer.from([0]));

  // resultCount = 1
  const rcc = Buffer.alloc(4);
  rcc.writeInt32BE(1, 0);
  parts.push(rcc);

  // resultInfo: [stmtType:1][affectedRows:4][OID:8][cacheSec:4][cacheUsec:4]
  const ri = Buffer.alloc(21);
  ri.writeInt8(21, 0);
  ri.writeInt32BE(rowValues.length, 1);
  parts.push(ri);

  // Inline fetch — fetchCode and tupleCount
  if (rowValues.length > 0) {
    const fc = Buffer.alloc(4);
    fc.writeInt32BE(0, 0); // fetchCode >= 0
    parts.push(fc);

    const tc = Buffer.alloc(4);
    tc.writeInt32BE(rowValues.length, 0);
    parts.push(tc);

    // Tuples
    for (let i = 0; i < rowValues.length; i++) {
      // cursorPosition
      const cpp = Buffer.alloc(4);
      cpp.writeInt32BE(i + 1, 0);
      parts.push(cpp);
      // OID (8 bytes)
      parts.push(Buffer.alloc(8));
      // Column values
      for (const val of rowValues[i]!) {
        if (val.data === null) {
          const ns = Buffer.alloc(4);
          ns.writeInt32BE(-1, 0);
          parts.push(ns);
        } else {
          const vs = Buffer.alloc(4);
          vs.writeInt32BE(val.data.length, 0);
          parts.push(vs, val.data);
        }
      }
    }
  }

  return Buffer.concat(parts);
}

test("parsePrepareAndExecute SELECT with SHORT column", () => {
  const data = Buffer.alloc(2);
  data.writeInt16BE(42, 0);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.SHORT }],
    [[{ type: CUBRIDDataType.SHORT, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.val, 42);
});

test("parsePrepareAndExecute SELECT with INT column", () => {
  const data = Buffer.alloc(4);
  data.writeInt32BE(12345, 0);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.INT }],
    [[{ type: CUBRIDDataType.INT, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.val, 12345);
});

test("parsePrepareAndExecute SELECT with BIGINT column", () => {
  const data = Buffer.alloc(8);
  data.writeBigInt64BE(9876543210n, 0);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: 21 }], // CCI_U_TYPE_BIGINT
    [[{ type: 21, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.val, 9876543210n);
});

test("parsePrepareAndExecute SELECT with negative BIGINT column (wire code 21)", () => {
  const data = Buffer.alloc(8);
  data.writeBigInt64BE(-9223372036854775808n, 0);
  const buf = buildSelectResponseForTypes([{ name: "val", type: 21 }], [[{ type: 21, data }]]);
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows[0]!.val, -9223372036854775808n);
});

test("parsePrepareAndExecute SELECT with FLOAT column", () => {
  const data = Buffer.alloc(4);
  data.writeFloatBE(3.14, 0);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.FLOAT }],
    [[{ type: CUBRIDDataType.FLOAT, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.ok(Math.abs((result.rows[0]!.val as number) - 3.14) < 0.01);
});

test("parsePrepareAndExecute SELECT with DOUBLE column", () => {
  const data = Buffer.alloc(8);
  data.writeDoubleBE(2.718281828, 0);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.DOUBLE }],
    [[{ type: CUBRIDDataType.DOUBLE, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.ok(Math.abs((result.rows[0]!.val as number) - 2.718281828) < 0.0001);
});

test("parsePrepareAndExecute SELECT with MONETARY column (reads as double)", () => {
  const data = Buffer.alloc(8);
  data.writeDoubleBE(99.99, 0);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.MONETARY }],
    [[{ type: CUBRIDDataType.MONETARY, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.ok(Math.abs((result.rows[0]!.val as number) - 99.99) < 0.01);
});

test("parsePrepareAndExecute SELECT with DATE column", () => {
  const data = Buffer.alloc(6);
  data.writeInt16BE(2025, 0); // year
  data.writeInt16BE(3, 2); // month
  data.writeInt16BE(14, 4); // day
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.DATE }],
    [[{ type: CUBRIDDataType.DATE, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  const d = result.rows[0]!.val as Date;
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 2); // 0-indexed
  assert.equal(d.getDate(), 14);
});

test("parsePrepareAndExecute SELECT with TIME column", () => {
  const data = Buffer.alloc(6);
  data.writeInt16BE(10, 0); // hour
  data.writeInt16BE(30, 2); // min
  data.writeInt16BE(45, 4); // sec
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.TIME }],
    [[{ type: CUBRIDDataType.TIME, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  const d = result.rows[0]!.val as Date;
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getSeconds(), 45);
});

test("parsePrepareAndExecute SELECT with TIMESTAMP column", () => {
  const data = Buffer.alloc(12);
  data.writeInt16BE(2025, 0); // year
  data.writeInt16BE(6, 2); // month
  data.writeInt16BE(15, 4); // day
  data.writeInt16BE(14, 6); // hour
  data.writeInt16BE(30, 8); // min
  data.writeInt16BE(0, 10); // sec
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.TIMESTAMP }],
    [[{ type: CUBRIDDataType.TIMESTAMP, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  const d = result.rows[0]!.val as Date;
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 5); // 0-indexed
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 30);
});

test("parsePrepareAndExecute SELECT with DATETIME column", () => {
  const data = Buffer.alloc(14);
  data.writeInt16BE(2025, 0); // year
  data.writeInt16BE(1, 2); // month
  data.writeInt16BE(1, 4); // day
  data.writeInt16BE(0, 6); // hour
  data.writeInt16BE(0, 8); // min
  data.writeInt16BE(0, 10); // sec
  data.writeInt16BE(500, 12); // ms
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.DATETIME }],
    [[{ type: CUBRIDDataType.DATETIME, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  const d = result.rows[0]!.val as Date;
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMilliseconds(), 500);
});

test("parsePrepareAndExecute SELECT with BIT/VARBIT column returns Buffer", () => {
  const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.BIT }],
    [[{ type: CUBRIDDataType.BIT, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.ok(Buffer.isBuffer(result.rows[0]!.val));
  assert.deepEqual([...(result.rows[0]!.val as Buffer)], [0xde, 0xad, 0xbe, 0xef]);
});

test("parsePrepareAndExecute SELECT with VARBIT column returns Buffer", () => {
  const data = Buffer.from([0xff]);
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.VARBIT }],
    [[{ type: CUBRIDDataType.VARBIT, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.ok(Buffer.isBuffer(result.rows[0]!.val));
});

test("parsePrepareAndExecute SELECT with NULL type returns null", () => {
  const data = Buffer.alloc(4); // some dummy bytes
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.NULL }],
    [[{ type: CUBRIDDataType.NULL, data }]],
  );
  // NULL type in readValue calls reader.skip(size) and returns null
  // But NULL type in parseRowData triggers the isCallType branch
  // which reads an extra type byte — this is the branch we want to cover
  // Since we have colType=NULL, it will enter the isCallType/NULL branch
  // and read the first byte of data as the actual type
  // Let's encode a proper value: first byte = type STRING, rest = "x\0"
  const nullTypeData = Buffer.alloc(4);
  nullTypeData[0] = CUBRIDDataType.STRING;
  nullTypeData[1] = 0x78; // 'x'
  nullTypeData[2] = 0; // null terminator
  // size = 3 bytes (type byte + "x\0"), but the size includes the type byte
  // so the original size=4, minus 1 for type byte = 3 remaining
  const buf2 = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.NULL }],
    [[{ type: CUBRIDDataType.NULL, data: nullTypeData }]],
  );
  const result2 = parsePrepareAndExecute(buf2, 1);
  assert.equal(result2.rows.length, 1);
  // colType=NULL reads an extra byte as actual type, then reads the value
  assert.equal(result2.rows[0]!.val, "x");
});

test("parsePrepareAndExecute SELECT with NUMERIC column returns string", () => {
  const numStr = "12345.67\0";
  const data = Buffer.from(numStr, "utf-8");
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.NUMERIC }],
    [[{ type: CUBRIDDataType.NUMERIC, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.val, "12345.67");
});

test("parsePrepareAndExecute SELECT with ENUM column returns string", () => {
  const enumVal = "active\0";
  const data = Buffer.from(enumVal, "utf-8");
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.ENUM }],
    [[{ type: CUBRIDDataType.ENUM, data }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.val, "active");
});

test("parsePrepareAndExecute SELECT with NULL value (size <= 0)", () => {
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: CUBRIDDataType.STRING }],
    [[{ type: CUBRIDDataType.STRING, data: null }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.val, null);
});

test("unknown and unsupported non-NULL wire values are never returned as SQL NULL", () => {
  // Literal CAS/CCI wire numbers; these must not be derived from implementation enums.
  for (const code of [16, 34, 99]) {
    const buf = buildSelectResponseForTypes(
      [{ name: "unsupported_column", type: code }],
      [[{ type: code, data: Buffer.from([0x01, 0x02, 0x03, 0x04]) }]],
    );
    assert.throws(
      () => parsePrepareAndExecute(buf, 1),
      (error: Error) =>
        error.message.includes("unsupported_column") &&
        error.message.includes(`wire type ${code}`) &&
        error.cause instanceof Error,
    );
  }
});

test("a real NULL and a valid empty string remain distinct", () => {
  const buf = buildSelectResponseForTypes(
    [{ name: "val", type: 2 }], // CCI_U_TYPE_STRING
    [[{ type: 2, data: null }], [{ type: 2, data: Buffer.from([0]) }]],
  );
  const result = parsePrepareAndExecute(buf, 1);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]!.val, null);
  assert.equal(result.rows[1]!.val, "");
});

test("parsePrepareAndExecute SELECT with high-bit column type (proto v7)", () => {
  // When legacyType has 0x80 bit set, an additional byte is read as the actual type
  // We need to build the column metadata manually for this case
  const parts: Buffer[] = [];

  // queryHandle = 1
  const qh = Buffer.alloc(4);
  qh.writeInt32BE(1, 0);
  parts.push(qh);

  // result_cache_lifetime = 0
  parts.push(Buffer.alloc(4));

  // statementType = SELECT
  parts.push(Buffer.from([21]));

  // bindCount = 0
  parts.push(Buffer.alloc(4));

  // isUpdatable = 0
  parts.push(Buffer.from([0]));

  // numColumns = 1
  const nc = Buffer.alloc(4);
  nc.writeInt32BE(1, 0);
  parts.push(nc);

  // Column metadata with high-bit type
  // type byte with 0x80 set (e.g., 0x80 | 0x02 = 0x82)
  parts.push(Buffer.from([0x82])); // high bit set
  // Actual type (read as second byte when high bit is set)
  parts.push(Buffer.from([CUBRIDDataType.STRING])); // actual type = STRING
  // scale
  parts.push(Buffer.alloc(2));
  // precision
  const cp = Buffer.alloc(4);
  cp.writeInt32BE(255, 0);
  parts.push(cp);
  // name
  const nameBytes = Buffer.from("val", "utf-8");
  const nl = Buffer.alloc(4);
  nl.writeInt32BE(nameBytes.length + 1, 0);
  parts.push(nl, nameBytes, Buffer.from([0]));
  // realName
  const rnl = Buffer.alloc(4);
  rnl.writeInt32BE(nameBytes.length + 1, 0);
  parts.push(rnl, Buffer.from(nameBytes), Buffer.from([0]));
  // tableName
  const tl = Buffer.alloc(4);
  tl.writeInt32BE(1, 0);
  parts.push(tl, Buffer.from([0]));
  // isNullable
  parts.push(Buffer.from([1]));
  // defaultValue
  const dl = Buffer.alloc(4);
  dl.writeInt32BE(1, 0);
  parts.push(dl, Buffer.from([0]));
  // flags
  parts.push(Buffer.from([0, 0, 0, 0, 0, 0, 0]));

  // Execute portion: totalTupleCount = 1
  const ttc = Buffer.alloc(4);
  ttc.writeInt32BE(1, 0);
  parts.push(ttc);

  // cache_reusable
  parts.push(Buffer.from([0]));

  // resultCount = 1
  const rcc = Buffer.alloc(4);
  rcc.writeInt32BE(1, 0);
  parts.push(rcc);

  // resultInfo
  const ri = Buffer.alloc(21);
  ri.writeInt8(21, 0);
  ri.writeInt32BE(1, 1);
  parts.push(ri);

  // proto v7 > 1: includesColInfo byte
  parts.push(Buffer.from([0]));
  // proto v7 > 4: shard_id (4 bytes)
  parts.push(Buffer.alloc(4));

  // Inline fetch
  const fc = Buffer.alloc(4);
  fc.writeInt32BE(0, 0);
  parts.push(fc);

  const tc = Buffer.alloc(4);
  tc.writeInt32BE(1, 0);
  parts.push(tc);

  // Row: cursorPosition + OID + value
  const cpp = Buffer.alloc(4);
  cpp.writeInt32BE(1, 0);
  parts.push(cpp);
  parts.push(Buffer.alloc(8)); // OID

  // Value: "test\0"
  const valBytes = Buffer.from("test\0", "utf-8");
  const vs = Buffer.alloc(4);
  vs.writeInt32BE(valBytes.length, 0);
  parts.push(vs, valBytes);

  const buf = Buffer.concat(parts);
  const result = parsePrepareAndExecute(buf, 7); // proto version 7
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.val, "test");
  // Column type should be STRING (the actual type, not the high-bit legacy type)
  assert.equal(result.columns[0]!.type, CUBRIDDataType.STRING);
});

test("parsePrepareAndExecute with protoVersion > 4 reads shard_id", () => {
  // Build a minimal INSERT response with extra bytes for proto v5+ fields
  const buf = Buffer.alloc(128);
  let offset = 0;
  buf.writeInt32BE(1, offset);
  offset += 4; // queryHandle = 1
  buf.writeInt32BE(0, offset);
  offset += 4; // cache lifetime
  buf.writeInt8(StatementType.INSERT, offset);
  offset += 1;
  buf.writeInt32BE(0, offset);
  offset += 4; // bind count
  buf.writeInt8(0, offset);
  offset += 1; // not updatable
  buf.writeInt32BE(0, offset);
  offset += 4; // column count = 0
  buf.writeInt32BE(1, offset);
  offset += 4; // total tuple count
  buf.writeInt8(0, offset);
  offset += 1; // cache_reusable
  buf.writeInt32BE(1, offset);
  offset += 4; // result count = 1
  // resultInfo
  buf.writeInt8(StatementType.INSERT, offset);
  offset += 1;
  buf.writeInt32BE(1, offset);
  offset += 4; // affected rows
  offset += 8; // OID
  buf.writeInt32BE(0, offset);
  offset += 4; // cache sec
  buf.writeInt32BE(0, offset);
  offset += 4; // cache usec
  // Proto v2+ field: includes_column_info
  buf.writeInt8(0, offset);
  offset += 1;
  // Proto v5+ field: shard_id
  buf.writeInt32BE(42, offset);
  offset += 4;

  const result = parsePrepareAndExecute(buf.subarray(0, offset), 7);
  assert.equal(result.queryHandle, 1);
  assert.equal(result.statementType, StatementType.INSERT);
});

// ---------------------------------------------------------------------------
// parseFetch with actual row data
// ---------------------------------------------------------------------------

test("parseFetch parses rows with string columns", () => {
  const columns: ColumnMeta[] = [
    {
      type: CUBRIDDataType.STRING,
      scale: 0,
      precision: 255,
      name: "val",
      realName: "val",
      tableName: "",
      isNullable: true,
      defaultValue: "",
      isAutoIncrement: false,
      isUniqueKey: false,
      isPrimaryKey: false,
      isForeignKey: false,
    },
  ];

  const parts: Buffer[] = [];
  // responseCode = 0 (success)
  const rc = Buffer.alloc(4);
  rc.writeInt32BE(0, 0);
  parts.push(rc);

  // tupleCount = 2
  const tc = Buffer.alloc(4);
  tc.writeInt32BE(2, 0);
  parts.push(tc);

  // Row 1
  const cpp1 = Buffer.alloc(4);
  cpp1.writeInt32BE(1, 0);
  parts.push(cpp1);
  parts.push(Buffer.alloc(8)); // OID
  const val1 = Buffer.from("hello\0", "utf-8");
  const vs1 = Buffer.alloc(4);
  vs1.writeInt32BE(val1.length, 0);
  parts.push(vs1, val1);

  // Row 2
  const cpp2 = Buffer.alloc(4);
  cpp2.writeInt32BE(2, 0);
  parts.push(cpp2);
  parts.push(Buffer.alloc(8)); // OID
  const val2 = Buffer.from("world\0", "utf-8");
  const vs2 = Buffer.alloc(4);
  vs2.writeInt32BE(val2.length, 0);
  parts.push(vs2, val2);

  const buf = Buffer.concat(parts);
  const result = parseFetch(buf, columns);
  assert.equal(result.tupleCount, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]!.val, "hello");
  assert.equal(result.rows[1]!.val, "world");
});

test("parseFetch with zero tupleCount returns empty rows", () => {
  const columns: ColumnMeta[] = [
    {
      type: CUBRIDDataType.STRING,
      scale: 0,
      precision: 255,
      name: "val",
      realName: "val",
      tableName: "",
      isNullable: true,
      defaultValue: "",
      isAutoIncrement: false,
      isUniqueKey: false,
      isPrimaryKey: false,
      isForeignKey: false,
    },
  ];

  const parts: Buffer[] = [];
  const rc = Buffer.alloc(4);
  rc.writeInt32BE(0, 0);
  parts.push(rc);
  const tc = Buffer.alloc(4);
  tc.writeInt32BE(0, 0);
  parts.push(tc);

  const buf = Buffer.concat(parts);
  const result = parseFetch(buf, columns);
  assert.equal(result.tupleCount, 0);
  assert.deepEqual(result.rows, []);
});

// ---------------------------------------------------------------------------
// PacketReader bounds (#107)
// ---------------------------------------------------------------------------

test("PacketReader length-based reads reject ranges past the packet", () => {
  const r = new PacketReader(Buffer.alloc(4));
  r.skip(1);

  assert.throws(() => r.parseBytes(4), /Malformed CAS packet: cannot read 4 bytes at offset 1/);
  assert.throws(() => r.parseNullTermString(4), /Malformed CAS packet/);
  assert.throws(() => r.skip(4), /Malformed CAS packet/);
  assert.equal(r.position, 1);
});

test("PacketReader rejects negative and non-integer lengths without moving", () => {
  const r = new PacketReader(Buffer.alloc(4));

  assert.throws(() => r.skip(-1), /Malformed CAS packet/);
  assert.throws(() => r.parseBytes(-1), /Malformed CAS packet/);
  assert.throws(() => r.parseBytes(1.5), /Malformed CAS packet/);
  assert.equal(r.position, 0);
});

test("PacketReader reads exactly to the end of the packet", () => {
  const r = new PacketReader(Buffer.from([1, 2, 3, 4]));

  r.skip(1);
  assert.deepEqual(r.parseBytes(3), Buffer.from([2, 3, 4]));
  assert.equal(r.remaining, 0);
  r.skip(0);
});

// ---------------------------------------------------------------------------
// Error replies. Layout captured from 10.2, 11.0, 11.2 and 11.4 brokers:
// int32 indicator (-2 database server, -1 CAS), int32 code, NUL-terminated text.
// ---------------------------------------------------------------------------

function errorReply(indicator: number, code: number, text: string): Buffer {
  const message = Buffer.from(`${text}\0`, "utf-8");
  const reply = Buffer.alloc(8 + message.length);
  reply.writeInt32BE(indicator, 0);
  reply.writeInt32BE(code, 4);
  message.copy(reply, 8);
  return reply;
}

test("error replies keep the code, its origin and the existing message", () => {
  const cases: Array<[(reply: Buffer) => unknown, string]> = [
    [(reply) => parsePrepareAndExecute(reply, 7), "CUBRID query failed"],
    [(reply) => parseFetch(reply, []), "CUBRID fetch failed"],
    [parseGetDbVersion, "CUBRID getDbVersion failed"],
    [parseSimpleResponse, "CUBRID operation failed"],
  ];

  for (const [parse, prefix] of cases) {
    assert.throws(
      () => parse(errorReply(-2, -670, "duplicate")),
      (error: unknown) => {
        assert.ok(error instanceof CasReplyError);
        assert.equal(error.code, -670);
        assert.equal(error.origin, "server");
        assert.equal(error.kind, "unique-violation");
        assert.equal(error.message, `${prefix} (-670): duplicate`);
        return true;
      },
    );
  }
});

test("parseOpenDatabase reports the code that refused the login", () => {
  const reply = Buffer.concat([Buffer.alloc(SIZE_CAS_INFO), errorReply(-2, -171, "bad password")]);

  assert.throws(
    () => parseOpenDatabase(reply),
    (error: unknown) => {
      assert.ok(error instanceof CasReplyError);
      assert.equal(error.code, -171);
      assert.equal(error.kind, "authentication");
      assert.equal(error.message, "CUBRID connection failed (-171): bad password");
      return true;
    },
  );
});

test("an invalid handle error comes from the CAS and is not classified", () => {
  // A 10.2 to 11.4 broker answers FETCH on an unknown handle with exactly this reply.
  const reply = Buffer.alloc(9);
  reply.writeInt32BE(-1, 0);
  reply.writeInt32BE(-1006, 4);

  assert.throws(
    () => parseFetch(reply, []),
    (error: unknown) => {
      assert.ok(error instanceof CasReplyError);
      assert.equal(error.code, -1006);
      assert.equal(error.origin, "cas");
      assert.equal("kind" in error, false);
      return true;
    },
  );
});

test("a server error reply is never reported as a malformed reply", () => {
  for (const parse of [
    (reply: Buffer) => parsePrepareAndExecute(reply, 7),
    (reply: Buffer) => parseFetch(reply, []),
  ]) {
    assert.throws(
      () => parse(errorReply(-2, -493, "Syntax: unexpected")),
      (error: Error) => error instanceof CasReplyError && error.name !== "MalformedReplyError",
    );
  }
});

// ---------------------------------------------------------------------------
// DML results and GET_LAST_INSERT_ID (replies captured from live brokers)
// ---------------------------------------------------------------------------

test("parsePrepareAndExecute keeps the row count of each DML statement", () => {
  const counts = (frame: { hex: string }) =>
    parsePrepareAndExecute(Buffer.from(frame.hex, "hex"), 7).resultInfos;

  assert.deepEqual(counts(DML_FRAMES.insertOneRow), [{ statementType: 20, resultCount: 1 }]);
  assert.deepEqual(counts(DML_FRAMES.insertThreeRows), [{ statementType: 20, resultCount: 3 }]);
  assert.deepEqual(counts(DML_FRAMES.updateThreeRows), [{ statementType: 22, resultCount: 3 }]);
  assert.deepEqual(counts(DML_FRAMES.updateNoMatch), [{ statementType: 22, resultCount: 0 }]);
  assert.deepEqual(counts(DML_FRAMES.deleteThreeRows), [{ statementType: 23, resultCount: 3 }]);
  assert.deepEqual(counts(DML_FRAMES.createTable), [{ statementType: 4, resultCount: 0 }]);
});

test("parsePrepareAndExecute returns one result per statement of a multi-statement string", () => {
  const result = parsePrepareAndExecute(Buffer.from(DML_FRAMES.twoInserts.hex, "hex"), 7);

  assert.deepEqual(result.resultInfos, [
    { statementType: 20, resultCount: 1 },
    { statementType: 20, resultCount: 2 },
  ]);
});

test("writeGetLastInsertId sends only the function code", () => {
  const { payload, header } = writeGetLastInsertId(Buffer.from([1, 2, 3, 4]));

  assert.equal(payload.readInt8(payload.length - 1), 40);
  assert.equal(header.readInt32BE(0), payload.length);
});

test("parseGetLastInsertId reads the generated value of a captured reply", () => {
  const parse = (hex: string) => parseGetLastInsertId(Buffer.from(hex, "hex"));

  assert.equal(parse(LAST_INSERT_ID_FRAMES.one), "1");
  assert.equal(parse(LAST_INSERT_ID_FRAMES.firstOfThreeRows), "2");
});

test("parseGetLastInsertId returns undefined when the session holds no value", () => {
  assert.equal(parseGetLastInsertId(Buffer.from(LAST_INSERT_ID_FRAMES.none, "hex")), undefined);
});

test("parseGetLastInsertId accepts the one-byte type header of older brokers", () => {
  // size 3: type 0x07, the digit "7" and the terminating NUL
  assert.equal(parseGetLastInsertId(Buffer.from("00000000000000030737" + "00", "hex")), "7");
});

test("parseGetLastInsertId raises a server error", () => {
  const reply = Buffer.concat([
    Buffer.from("fffffffc", "hex"), // response code -4
    Buffer.from("fffffc18", "hex"), // error code -1000
    Buffer.from("bad\0"),
  ]);

  assert.throws(
    () => parseGetLastInsertId(reply),
    (error: Error) => error instanceof CasReplyError && error.message.includes("bad"),
  );
});

test("parseGetLastInsertId rejects a reply that overruns its declared size", () => {
  // size 9 but only 4 bytes follow
  assert.throws(
    () => parseGetLastInsertId(Buffer.from("000000000000000983073100", "hex")),
    MalformedReplyError,
  );
});

test("parseGetLastInsertId rejects every nonpositive size except -1", () => {
  for (const size of ["00000000", "fffffffe", "80000000"]) {
    assert.throws(
      () => parseGetLastInsertId(Buffer.from("00000000" + size, "hex")),
      MalformedReplyError,
    );
  }
});
