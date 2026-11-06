/**
 * Independent CUBRID CAS wire regression fixtures.
 *
 * Numeric expectations below are literal bytes transcribed from pinned
 * CUBRID source. They must NOT be generated from the enums under test.
 * Provenance: docs/PROTOCOL_ORACLES.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CASFunctionCode, CUBRIDDataType, StatementType } from "../src/protocol/constants.js";
import {
  encodeBindParams,
  parseFetch,
  parsePrepareAndExecute,
  writeFetch,
} from "../src/protocol/protocol.js";

const i32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return b;
};
const i16 = (value: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(value, 0);
  return b;
};

/**
 * A literal CCI v7 SELECT response with one named column and one row.
 * The numeric header/field values are independent of the driver enum.
 */
function selectWire(wireType: number, rawValue: Buffer | null): Buffer {
  const column = Buffer.from("value\0", "utf8");
  return Buffer.concat([
    i32(7),                         // query handle
    i32(0),                         // cache lifetime
    Buffer.from([21]),              // SQL SELECT statement code
    i32(0),                         // bind count
    Buffer.from([0]),               // updatable
    i32(1),                         // column count
    Buffer.from([wireType]),        // exact CCI column type ID
    i16(0),                         // scale
    i32(19),                        // precision
    i32(column.length), column,     // name
    i32(column.length), column,     // real name
    i32(1), Buffer.from([0]),       // table name
    Buffer.from([1]),               // nullable
    i32(1), Buffer.from([0]),       // default value
    Buffer.alloc(7),                // column flags
    i32(1),                         // total tuples
    Buffer.from([0]),               // cache_reusable
    i32(1),                         // result info count
    Buffer.from([21]),              // result info statement SELECT
    i32(1), Buffer.alloc(8), i32(0), i32(0), // result info
    i32(0), i32(1),                 // inline fetch success, 1 tuple
    i32(1), Buffer.alloc(8),        // cursor position, OID
    i32(rawValue === null ? -1 : rawValue.length),
    ...(rawValue === null ? [] : [rawValue]),
  ]);
}

test("literal CCI data-type IDs remain independent from implementation changes", () => {
  for (const [actual, expected] of [
    [CUBRIDDataType.NULL, 0],
    [CUBRIDDataType.STRING, 2],
    [CUBRIDDataType.INT, 8],
    [CUBRIDDataType.SET, 16],
    [CUBRIDDataType.MULTISET, 17],
    [CUBRIDDataType.SEQUENCE, 18],
    [CUBRIDDataType.OBJECT, 19],
    [CUBRIDDataType.RESULTSET, 20],
    [CUBRIDDataType.BIGINT, 21],
    [CUBRIDDataType.BLOB, 23],
    [CUBRIDDataType.CLOB, 24],
    [CUBRIDDataType.JSON, 34],
  ]) {
    assert.equal(actual, expected);
  }
});

test("literal SQL statement IDs use a separate domain from CCI data types", () => {
  for (const [actual, expected] of [
    [StatementType.CREATE_CLASS, 4],
    [StatementType.INSERT, 20],
    [StatementType.SELECT, 21],
    [StatementType.UPDATE, 22],
    [StatementType.DELETE, 23],
    [StatementType.CALL, 24],
    [StatementType.CALL_SP, 126],
  ]) {
    assert.equal(actual, expected);
  }
});

test("literal CAS function codes are not CCI values or SQL statement IDs", () => {
  assert.equal(CASFunctionCode.CLOSE_REQ_HANDLE, 6);
  assert.equal(CASFunctionCode.FETCH, 8);
  assert.equal(CASFunctionCode.GET_LAST_INSERT_ID, 40);
  assert.equal(CASFunctionCode.PREPARE_AND_EXECUTE, 41);
  const req = writeFetch(7, 0, 10, Buffer.alloc(4));
  assert.equal(req.payload[0], 8);
});

test("literal BIGINT type 21 decodes exact signed 64-bit boundaries", () => {
  const positive = parsePrepareAndExecute(
    selectWire(21, Buffer.from("7fffffffffffffff", "hex")), 1,
  );
  assert.equal(positive.rows[0]?.value, 9223372036854775807n);
  const negative = parsePrepareAndExecute(
    selectWire(21, Buffer.from("8000000000000000", "hex")), 1,
  );
  assert.equal(negative.rows[0]?.value, -9223372036854775808n);
});

test("literal BIGINT bind packet retains its exact type byte", () => {
  // An internal encoder contract; query(sql, params) still interpolates SQL.
  const wire = encodeBindParams([42n]);
  assert.equal(wire.toString("hex"), "0000000915000000000000002a");
});

test("unsupported non-NULL bytes are errors and never fabricated SQL NULL", () => {
  for (const type of [16, 17, 18, 19, 20, 26, 34, 99]) {
    const wire = selectWire(type, Buffer.from("01020304", "hex"));
    assert.throws(() => parsePrepareAndExecute(wire, 1), (error: Error) =>
      error.message.includes(`wire type ${type}`) &&
      error.message.includes('column "value"'));
  }
});

test("genuine SQL NULL and a valid empty string are different", () => {
  const nullRow = parsePrepareAndExecute(selectWire(2, null), 1);
  const emptyRow = parsePrepareAndExecute(selectWire(2, Buffer.from([0])), 1);
  assert.equal(nullRow.rows[0]?.value, null);
  assert.equal(emptyRow.rows[0]?.value, "");
});

test("truncated packets and literal FETCH error envelopes reject", () => {
  const truncated = selectWire(21, Buffer.from("000000000000002a", "hex")).subarray(0, -4);
  assert.throws(() => parsePrepareAndExecute(truncated, 1));
  const badFetch = Buffer.concat([i32(-1), i32(-10006), Buffer.from("invalid handle\0")]);
  assert.throws(() => parseFetch(badFetch, []), /CUBRID fetch failed/);
});
