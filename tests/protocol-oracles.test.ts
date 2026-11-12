/**
 * Independent CUBRID CAS wire regression fixtures.
 *
 * Numeric expectations below are literal bytes transcribed from pinned
 * CUBRID source. They must NOT be generated from the enums under test.
 * Provenance: docs/PROTOCOL_ORACLES.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CasReplyError } from "../src/errors/internal-errors.js";
import { CASFunctionCode, CUBRIDDataType, StatementType } from "../src/protocol/constants.js";
import {
  bindLobHandles,
  encodeBindParams,
  encodePreparedParams,
  formatValue,
  interpolateParams,
  type LobLocator,
  MalformedReplyError,
  parseExecute,
  parseExecuteArray,
  parseFetch,
  parseLobNew,
  parseLobRead,
  parseLobWrite,
  parsePrepare,
  parsePrepareAndExecute,
  setLobHandleSize,
  UnsupportedValueError,
  writeExecute,
  writeExecuteArray,
  writeFetch,
  writeLobNew,
  writeLobRead,
  writeLobWrite,
  writePrepare,
} from "../src/protocol/protocol.js";
import { blob, clob, lobChunks } from "../src/types/lob.js";
import { ZonedDateTime } from "../src/types/zoned-date-time.js";
import { CAPTURED_FRAMES, type CapturedFrame } from "./fixtures/collection-frames.js";
import { EXECUTE_ARRAY_FRAMES, PREPARED_FRAMES } from "./fixtures/dml-frames.js";
import { LOB_FRAMES, LOB_WRITE_FRAMES } from "./fixtures/lob-frames.js";
import { ZONED_FRAMES } from "./fixtures/zoned-frames.js";

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
function selectWire(wireType: number, rawValue: Buffer | null, name = "value"): Buffer {
  const column = Buffer.from(`${name}\0`, "utf8");
  return Buffer.concat([
    i32(7), // query handle
    i32(0), // cache lifetime
    Buffer.from([21]), // SQL SELECT statement code
    i32(0), // bind count
    Buffer.from([0]), // updatable
    i32(1), // column count
    Buffer.from([wireType]), // exact CCI column type ID
    i16(0), // scale
    i32(19), // precision
    i32(column.length),
    column, // name
    i32(column.length),
    column, // real name
    i32(1),
    Buffer.from([0]), // table name
    Buffer.from([1]), // nullable
    i32(1),
    Buffer.from([0]), // default value
    Buffer.alloc(7), // column flags
    i32(1), // total tuples
    Buffer.from([0]), // cache_reusable
    i32(1), // result info count
    Buffer.from([21]), // result info statement SELECT
    i32(1),
    Buffer.alloc(8),
    i32(0),
    i32(0), // result info
    i32(0),
    i32(1), // inline fetch success, 1 tuple
    i32(1),
    Buffer.alloc(8), // cursor position, OID
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
  // CAS_FC_EXECUTE_ARRAY in cas_protocol.h; JDBC's EXECUTE_BATCH_PREPAREDSTATEMENT.
  assert.equal(CASFunctionCode.EXECUTE_ARRAY, 21);
  const req = writeFetch(7, 0, 10, Buffer.alloc(4));
  assert.equal(req.payload[0], 8);
});

test("literal BIGINT type 21 decodes exact signed 64-bit boundaries", () => {
  const positive = parsePrepareAndExecute(
    selectWire(21, Buffer.from("7fffffffffffffff", "hex")),
    1,
  );
  assert.equal(positive.rows[0]?.value, 9223372036854775807n);
  const negative = parsePrepareAndExecute(
    selectWire(21, Buffer.from("8000000000000000", "hex")),
    1,
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
    assert.throws(
      () => parsePrepareAndExecute(wire, 1),
      (error: Error) =>
        error.message.includes(`wire type ${type}`) && error.message.includes('column "value"'),
    );
  }
});

test("genuine SQL NULL and a valid empty string are different", () => {
  const nullRow = parsePrepareAndExecute(selectWire(2, null), 1);
  const emptyRow = parsePrepareAndExecute(selectWire(2, Buffer.from([0])), 1);
  assert.equal(nullRow.rows[0]?.value, null);
  assert.equal(emptyRow.rows[0]?.value, "");
});

test("a captured OID value rejects as unsupported, naming its column and wire type", () => {
  assert.throws(
    () => parsePrepareAndExecute(Buffer.from(ZONED_FRAMES.oidValue.hex, "hex"), 7),
    (error: Error) => {
      assert.ok(error instanceof UnsupportedValueError);
      assert.match(error.message, /column "o" \(wire type 19, 8 bytes\)/);
      return true;
    },
  );
});

test("captured zero dates reject as unsupported, naming the column and type, never an 1899 Date", () => {
  // Literal wire types and sizes from the replies: DATE 13 is 6 bytes, DATETIME 22 is
  // 14 bytes and TIMESTAMP 15 is 12 bytes, all zero.
  const expected = [
    [CAPTURED_FRAMES.zeroDate, /column "d" \(wire type 13, 6 bytes\)/],
    [CAPTURED_FRAMES.zeroDatetime, /column "d" \(wire type 22, 14 bytes\)/],
    [CAPTURED_FRAMES.zeroTimestamp, /column "d" \(wire type 15, 12 bytes\)/],
  ] as const;
  for (const [frame, message] of expected) {
    assert.throws(
      () => parsePrepareAndExecute(Buffer.from(frame.hex, "hex"), 7),
      (error: Error) => {
        assert.ok(error instanceof UnsupportedValueError, frame.sql);
        assert.match(error.message, message);
        assert.match((error.cause as Error).message, /Zero date 0000-00-00/);
        return true;
      },
    );
  }
});

test("a zero-byte value is an empty Buffer only for BIT and VARBIT, and never for another type", () => {
  // The captured SELECT X'' has a size-0 cell: an empty Buffer, not SQL NULL, and column t stays.
  assert.deepEqual(
    parsePrepareAndExecute(Buffer.from(CAPTURED_FRAMES.emptyBitValue.hex, "hex"), 7).rows,
    [{ x: Buffer.alloc(0), t: "after" }],
  );
  for (const type of [5, 6]) {
    assert.deepEqual(
      parsePrepareAndExecute(selectWire(type, Buffer.alloc(0)), 1).rows[0]?.value,
      Buffer.alloc(0),
    );
    assert.equal(parsePrepareAndExecute(selectWire(type, null), 1).rows[0]?.value, null);
  }

  // No decoder: OBJECT, JSON (never sent below protocol 8) and a code CCI does not define.
  for (const type of [19, 34, 99]) {
    assert.throws(
      () => parsePrepareAndExecute(selectWire(type, Buffer.alloc(0)), 1),
      (error: Error) =>
        error instanceof UnsupportedValueError &&
        error.message.includes(`wire type ${type}, 0 bytes`),
    );
  }

  // Decodable, but CAS counts the NUL of text and writes fixed widths in full.
  for (const type of [2, 8, 21, 23, 29, 30, 31, 32]) {
    assert.throws(
      () => parsePrepareAndExecute(selectWire(type, Buffer.alloc(0)), 1),
      (error: Error) =>
        error instanceof MalformedReplyError &&
        error.message.includes(`wire type ${type}, 0 bytes`) &&
        // The reason is one step down the cause chain, not behind a repeated message.
        !(error.cause as Error).message.startsWith("Failed to decode"),
    );
  }
});

test("a NULL-typed column never turns a typed cell without value bytes into null", () => {
  // Cell of size 1 holding only the type header: the literal OBJECT code 19.
  assert.throws(
    () => parsePrepareAndExecute(selectWire(0, Buffer.from([19])), 1),
    (error: Error) =>
      error instanceof UnsupportedValueError && /wire type 19, 0 bytes/.test(error.message),
  );
  // Cell of size 0 has no room for the header, which must not come from the next bytes.
  assert.throws(
    () => parsePrepareAndExecute(selectWire(0, Buffer.alloc(0)), 1),
    (error: Error) =>
      error instanceof MalformedReplyError && /invalid cell length 0/.test(error.message),
  );
});

test("an unsupported value whose length overruns the reply is malformed, not unsupported", () => {
  const wire = selectWire(19, Buffer.from("01020304", "hex"));
  assert.throws(
    () => parsePrepareAndExecute(wire.subarray(0, -2), 1),
    (error: Error) => error instanceof MalformedReplyError,
  );
});

test("the first unsupported value is reported only once the whole reply holds together", () => {
  const column = { type: 19, name: "tz" } as never;
  const row = (...cells: Buffer[]): Buffer => Buffer.concat([i32(1), Buffer.alloc(8), ...cells]);
  const value = Buffer.concat([i32(2), Buffer.from("0102", "hex")]);

  const later = Buffer.concat([i32(3), Buffer.from("010203", "hex")]);

  assert.throws(
    () => parseFetch(Buffer.concat([i32(0), i32(2), row(value), row(later)]), [column]),
    (error: Error) => error instanceof UnsupportedValueError && /, 2 bytes/.test(error.message),
  );
  // Row 2 declares a negative length that is not NULL.
  assert.throws(
    () => parseFetch(Buffer.concat([i32(0), i32(2), row(value), row(i32(-2))]), [column]),
    (error: Error) => error instanceof MalformedReplyError,
  );
});

test("a reply that ends before its declared rows is malformed, not a short result", () => {
  const column = { type: 8, name: "n" } as never;
  const row = Buffer.concat([i32(1), Buffer.alloc(8), i32(4), i32(42)]);

  // FETCH declares two rows. One complete row, then none, then a row cut inside its cells.
  for (const body of [row, Buffer.alloc(0), row.subarray(0, -2)]) {
    assert.throws(
      () => parseFetch(Buffer.concat([i32(0), i32(2), body]), [column]),
      (error: Error) => error instanceof MalformedReplyError,
    );
  }
  assert.deepEqual(parseFetch(Buffer.concat([i32(0), i32(1), row]), [column]).rows, [{ n: 42 }]);

  // The inline rows of PREPARE_AND_EXECUTE declare two tuples but carry one.
  const wire = selectWire(8, i32(42));
  assert.deepEqual(parsePrepareAndExecute(wire, 1).rows, [{ value: 42 }]);
  const tupleCountAt = wire.length - (4 + 8 + 4 + 4) - 4;
  wire.writeInt32BE(2, tupleCountAt);
  assert.throws(
    () => parsePrepareAndExecute(wire, 1),
    (error: Error) => error instanceof MalformedReplyError,
  );
});

test("truncated packets and literal FETCH error envelopes reject", () => {
  const truncated = selectWire(21, Buffer.from("000000000000002a", "hex")).subarray(0, -4);
  assert.throws(() => parsePrepareAndExecute(truncated, 1));
  const badFetch = Buffer.concat([i32(-1), i32(-10006), Buffer.from("invalid handle\0")]);
  assert.throws(() => parseFetch(badFetch, []), /CUBRID fetch failed/);
});

// ---------------------------------------------------------------------------
// Collections, from replies captured on live brokers (#82)
// ---------------------------------------------------------------------------

const decodeFrame = (frame: CapturedFrame) =>
  parsePrepareAndExecute(Buffer.from(frame.hex, "hex"), 7);

const firstValue = (frame: CapturedFrame): { c: unknown; t: unknown } => {
  const row = decodeFrame(frame).rows[0];
  assert.ok(row);
  return { c: row.c, t: row.t };
};

for (const [name, frame] of [
  ["11.4", CAPTURED_FRAMES.tableRows],
  ["10.2", CAPTURED_FRAMES.tableRowsOn10_2],
] as const) {
  test(`CUBRID ${name} collection rows decode without shifting the next column`, () => {
    const result = decodeFrame(frame);

    // Literal CCI ids: SET 16, MULTISET 17, SEQUENCE 18 over INT 8, STRING 2, BIGINT 21.
    assert.deepEqual(
      result.columns.map((column) => [column.name, column.type, column.elementType]),
      [
        ["id", 8, undefined],
        ["s", 16, 8],
        ["m", 17, 2],
        ["q", 18, 21],
        ["tail_col", 2, undefined],
      ],
    );
    assert.deepEqual(result.rows, [
      // Inserted as {3,1,2,2}, {'b','a','b'} and {30000000000,1,1}: the server
      // sorts and deduplicates the SET, sorts the MULTISET and keeps the SEQUENCE.
      { id: 1, s: [1, 2, 3], m: ["a", "b", "b"], q: [30000000000n, 1n, 1n], tail_col: "after1" },
      { id: 2, s: [], m: [], q: [], tail_col: "after2" },
      { id: 3, s: null, m: null, q: null, tail_col: "after3" },
      { id: 4, s: [null], m: ["x", null], q: [null, 5n, null], tail_col: "after4" },
    ]);
  });
}

test("captured collection edge cases decode to their documented values", () => {
  const cases: Array<[CapturedFrame, unknown]> = [
    [CAPTURED_FRAMES.setDeduplicated, [1, 2]],
    [CAPTURED_FRAMES.allNullSet, [null, null]],
    [CAPTURED_FRAMES.nestedSequence, [[], [1]]],
    [CAPTURED_FRAMES.nullBesideNested, [null, [1]]],
    [CAPTURED_FRAMES.emptyVarbitElement, [Buffer.alloc(0)]],
    [CAPTURED_FRAMES.emptyStringElement, [""]],
    [CAPTURED_FRAMES.doubleElements, [1.5, 2.5]],
    [CAPTURED_FRAMES.datetimeElement, [new Date(2024, 0, 2, 3, 4, 5, 678)]],
    [CAPTURED_FRAMES.enumElements, ["a", "b"]],
  ];
  for (const [frame, expected] of cases) {
    assert.deepEqual(firstValue(frame), { c: expected, t: "after" }, frame.sql);
  }
});

test("the server sends a mixed-type collection as SQL NULL, also inside a collection", () => {
  // The broker replaces the value before the driver sees it: cell length -1 and
  // element length -1, the same bytes as a genuine NULL.
  assert.deepEqual(firstValue(CAPTURED_FRAMES.mixedSequence), { c: null, t: "after" });
  assert.deepEqual(firstValue(CAPTURED_FRAMES.nestedMixedInner), { c: [null, [2]], t: "after" });
});

test("unsupported collection elements reject and name the column", () => {
  for (const [frame, wireType] of [
    [CAPTURED_FRAMES.blobElement, 23],
    [CAPTURED_FRAMES.objectElement, 19],
  ] as const) {
    assert.throws(
      () => decodeFrame(frame),
      (error: Error) =>
        error.message.includes('column "c" (wire type 18') &&
        (error.cause as Error).message.includes(`type ${wireType}`),
      frame.sql,
    );
  }
});

test("a zero date element rejects as unsupported, and structural damage still wins", () => {
  // Captured SEQUENCE OF DATE {0000-00-00, 2020-01-02}: the first element is the zero date.
  assert.throws(
    () => decodeFrame(CAPTURED_FRAMES.zeroDateElement),
    (error: Error) => {
      assert.ok(error instanceof UnsupportedValueError);
      assert.match(error.message, /column "c" \(wire type 18, 25 bytes\)/);
      assert.match((error.cause as Error).message, /Zero date 0000-00-00/);
      return true;
    },
  );

  // The second element now claims 7 bytes, one more than the cell holds: the whole
  // reply is malformed even though an unsupported element came first.
  const { hex } = CAPTURED_FRAMES.zeroDateElement;
  const second = "0000000607e400010002";
  assert.ok(hex.includes(second));
  assert.throws(
    () =>
      parsePrepareAndExecute(Buffer.from(hex.replace(second, "0000000707e400010002"), "hex"), 7),
    (error: Error) => error instanceof MalformedReplyError,
  );
});

test("an all-zero value of the wrong width is malformed, not a zero date", () => {
  // Only DATE 6, DATETIME 14 and TIMESTAMP 12 bytes can be the zero date. Any other
  // width contradicts its cell, so the reply is malformed and the session is dropped.
  for (const [wireType, size] of [
    [22, 6],
    [15, 6],
    [13, 7],
    [13, 14],
    [15, 14],
  ] as const) {
    assert.throws(
      () => parsePrepareAndExecute(selectWire(wireType, Buffer.alloc(size)), 1),
      (error: Error) => error instanceof MalformedReplyError,
      `wire type ${wireType}, ${size} zero bytes`,
    );
  }
});

test("a zero-filled element of the wrong width in a collection is malformed", () => {
  // The captured SEQUENCE OF DATE reduced to its one six-byte zero element (cell
  // size 15, count 1) and retyped as DATETIME (22): six zero bytes are not a 14-byte
  // DATETIME. A second, valid element would hide this, so the cell holds only the zero.
  const { hex } = CAPTURED_FRAMES.zeroDateElement;
  const cell = "190d00000002" + "00000006000000000000" + "0000000607e400010002";
  const retyped = "0f1600000001" + "00000006000000000000";
  assert.equal(hex.split(cell).length, 2);
  assert.throws(
    () => parsePrepareAndExecute(Buffer.from(hex.replace(cell, retyped), "hex"), 7),
    (error: Error) => error instanceof MalformedReplyError,
  );
});

test("parseFetch decodes collections with the metadata of the executed query", () => {
  const { columns } = decodeFrame(CAPTURED_FRAMES.tableRows);
  const cell = (hex: string): Buffer => Buffer.from(hex, "hex");
  const text = Buffer.from("fetch\0");
  const fetched = parseFetch(
    Buffer.concat([
      i32(0),
      i32(1),
      i32(5),
      Buffer.alloc(8),
      i32(4),
      cell("00000005"),
      i32(13),
      cell("08000000010000000400000007"),
      i32(5),
      cell("0000000000"),
      i32(-1),
      i32(text.length),
      text,
    ]),
    columns,
  );
  assert.deepEqual(fetched.rows, [{ id: 5, s: [7], m: [], q: null, tail_col: "fetch" }]);
});

// The captured SET cell of CAST({1,2,2} AS SET OF INT): cell length 0x15, type 8,
// count 2, then two int32 elements. The value 'after' of column t follows it.
const SET_CELL = "00000015" + "08" + "00000002" + "00000004" + "00000001" + "00000004" + "00000002";

const withCell = (replacement: string): Buffer => {
  const { hex } = CAPTURED_FRAMES.setDeduplicated;
  assert.ok(hex.includes(SET_CELL));
  return Buffer.from(hex.replace(SET_CELL, replacement), "hex");
};

test("the unmodified captured cell decodes, proving the malformed cases below start valid", () => {
  assert.deepEqual(parsePrepareAndExecute(withCell(SET_CELL), 7).rows, [{ c: [1, 2], t: "after" }]);
});

const causeOf = (error: Error): string =>
  error.cause instanceof Error ? causeOf(error.cause) : error.message;

for (const [problem, cell, reason] of [
  // Lengths: the 21-byte cell of the valid case with one field changed.
  [
    "an element length past the cell",
    "00000015080000000200000004000000010000000500000002",
    /cannot read 5 bytes/,
  ],
  [
    "an element length past the packet",
    "00000015080000000200000004000000017fffffff00000002",
    /cannot read 2147483647 bytes/,
  ],
  [
    "a negative element length below NULL",
    "0000001508000000020000000400000001fffffffe00000002",
    /invalid length -2/,
  ],
  [
    "a zero length on a type that cannot be empty",
    "00000015080000000200000004000000010000000000000002",
    /invalid length 0/,
  ],
  [
    "a count that exceeds the cell",
    "00000015087fffffff00000004000000010000000400000002",
    /count 2147483647/,
  ],
  [
    "a count larger than the elements",
    "00000015080000000300000004000000010000000400000002",
    /element 2 has no length/,
  ],
  [
    "a count smaller than the elements",
    "00000015080000000100000004000000010000000400000002",
    /uses 13 of its 21 bytes/,
  ],
  ["a negative count", "0000001508ffffffff00000004000000010000000400000002", /count -1/],
  [
    "a non-NULL element without an element type",
    "00000015000000000200000004000000010000000400000002",
    /Unsupported CUBRID CAS value type 0/,
  ],
  // Element payloads that disagree with their type, in a cell of the right size.
  [
    "an int element shorter than its type",
    "0000001308000000020000000400000001000000020000",
    /bounds|out of range/,
  ],
  [
    "an int element longer than its type",
    "00000016080000000200000004000000010000000500000000" + "02",
    /uses 4 of its 5 bytes/,
  ],
  // Cell lengths.
  [
    "a cell longer than its elements",
    "00000019080000000200000004000000010000000400000002ffffffff",
    /uses 21 of its 25 bytes/,
  ],
  ["a cell shorter than its header", "000000040800000002", /has no header/],
  ["a zero-length collection cell", "00000000", /invalid cell length 0/],
  ["a cell length below NULL", "fffffffe", /invalid cell length -2/],
  ["a cell length past the packet", "7fffffff", /cannot read 2147483647 bytes/],
] as const) {
  test(`a collection with ${problem} rejects instead of shifting the next column`, () => {
    assert.throws(
      () => parsePrepareAndExecute(withCell(cell), 7),
      (error: Error) => {
        assert.match(causeOf(error), reason);
        return true;
      },
    );
  });
}

test("a collection cell cannot read past its end into the next column", () => {
  // An 11-byte cell whose only int32 element claims 4 bytes when 2 remain in the
  // cell. The bytes of column t follow, so an unbounded read would take them.
  const cell = "0000000b" + "08" + "00000001" + "00000004" + "0001";
  assert.throws(
    () => parsePrepareAndExecute(withCell(cell), 7),
    (error: Error) => {
      assert.ok(error.message.includes('column "c"'));
      assert.match(causeOf(error), /cannot read 4 bytes/);
      return true;
    },
  );
});

test("a collection element without a decoder is unsupported and leaves the next column readable", () => {
  // Cell: BLOB element type 23, one element of 4 bytes. It rejects the reply as
  // unsupported, so the column after it was reached and found intact.
  const cell = "0000000d" + "17" + "00000001" + "00000004" + "01020304";
  assert.throws(
    () => parsePrepareAndExecute(withCell(cell), 7),
    (error: Error) => error instanceof UnsupportedValueError,
  );
});

// One BLOB element (type 23) of 4 bytes, valid on its own, and a nested cell holding it.
const BLOB_ELEMENT = "00000004" + "01020304";
const NESTED_BLOB = "0000000d" + "17" + "00000001" + BLOB_ELEMENT;
const NESTED_CLOB = "0000000d" + "18" + "00000001" + BLOB_ELEMENT;

for (const [problem, cell, reason] of [
  [
    "a length past the cell",
    "0000000d" + "17" + "00000001" + "00000005" + "01020304",
    /cannot read 5 bytes/,
  ],
  [
    "a later element below NULL",
    "00000011" + "17" + "00000002" + BLOB_ELEMENT + "fffffffe",
    /invalid length -2/,
  ],
  [
    "a later element with no length",
    "00000011" + "17" + "00000003" + BLOB_ELEMENT + "ffffffff",
    /element 2 has no length/,
  ],
  [
    "a cell longer than its elements",
    "0000000f" + "17" + "00000001" + BLOB_ELEMENT + "0000",
    /uses 13 of its 15 bytes/,
  ],
  [
    "a later element of a type without any decoder",
    "00000013" + "63" + "00000002" + "00000002" + "0102" + "00000005" + "01020304",
    /cannot read 5 bytes/,
  ],
  // A SEQUENCE whose second nested cell has an int element claiming 5 of its 4 bytes.
  [
    "damage in a later nested cell",
    "00000027" +
      "12" +
      "00000002" +
      NESTED_BLOB +
      "0000000d" +
      "08" +
      "00000001" +
      "00000005" +
      "00000001",
    /cannot read 5 bytes/,
  ],
  // The unsupported element is itself nested, and the damage is in the outer cell.
  [
    "damage after a nested unsupported cell",
    "0000001a" + "12" + "00000002" + NESTED_BLOB + "fffffffe",
    /invalid length -2/,
  ],
] as const) {
  test(`an unsupported collection element does not hide ${problem}`, () => {
    assert.throws(
      () => parsePrepareAndExecute(withCell(cell), 7),
      (error: Error) => {
        assert.ok(error instanceof MalformedReplyError);
        assert.match(causeOf(error), reason);
        return true;
      },
    );
  });
}

test("a complete collection keeps its first unsupported element, and damage outranks it", () => {
  // Two nested cells, BLOB (23) then CLOB (24).
  const complete = "00000027" + "12" + "00000002" + NESTED_BLOB + NESTED_CLOB;
  assert.throws(
    () => parsePrepareAndExecute(withCell(complete), 7),
    (error: Error) => {
      assert.ok(error instanceof UnsupportedValueError);
      assert.match(causeOf(error), /element type 23/);
      return true;
    },
  );
  // The same walk reaches the second cell: damage there outranks the first error.
  const damaged =
    "00000027" +
    "12" +
    "00000002" +
    NESTED_BLOB +
    "0000000d" +
    "18" +
    "00000001" +
    "00000005" +
    "01020304";
  assert.throws(
    () => parsePrepareAndExecute(withCell(damaged), 7),
    (error: Error) => error instanceof MalformedReplyError,
  );
});

test("a nested collection with a malformed inner length rejects", () => {
  const { hex } = CAPTURED_FRAMES.nestedSequence;
  // Second element of {{},{1}}: its int32 element claims 5 bytes in a 4-byte payload.
  const inner = "0000000d08000000010000000400000001";
  assert.ok(hex.includes(inner));
  const damaged = hex.replace(inner, "0000000d08000000010000000500000001");
  assert.throws(() => parsePrepareAndExecute(Buffer.from(damaged, "hex"), 7));
});

test("very deep nesting rejects instead of crashing the process", () => {
  const depth = 200_000;
  const levelSize = 9; // element type, count and the inner element's length
  const body = Buffer.alloc(depth * levelSize);
  for (let level = 0; level < depth; level++) {
    const offset = level * levelSize;
    body[offset] = 18;
    body.writeInt32BE(1, offset + 1);
    body.writeInt32BE(body.length - offset - levelSize, offset + 5);
  }
  assert.throws(() =>
    parseFetch(Buffer.concat([i32(0), i32(1), i32(1), Buffer.alloc(8), i32(body.length), body]), [
      {
        ...decodeFrame(CAPTURED_FRAMES.setDeduplicated).columns[0]!,
        type: CUBRIDDataType.SEQUENCE,
      },
    ]),
  );
});

test("a scalar value that disagrees with its cell length rejects", () => {
  // An int column declares 3 bytes: reading 4 would consume the next cell's first byte.
  const wire = selectWire(8, Buffer.from("000000", "hex"));
  assert.throws(
    () => parsePrepareAndExecute(Buffer.concat([wire, Buffer.alloc(4)]), 1),
    /Failed to decode/,
  );
  // The same for a bigint column that declares more than its 8 bytes.
  const long = selectWire(21, Buffer.from("000000000000002a00", "hex"));
  assert.throws(() => parsePrepareAndExecute(long, 1), /Failed to decode/);
});

test("a NULL cell keeps an ordinary one-byte metadata type intact", () => {
  assert.equal(parsePrepareAndExecute(selectWire(34, null), 1).columns[0]?.type, 34);
  assert.equal(parsePrepareAndExecute(selectWire(34, null), 1).columns[0]?.elementType, undefined);
});

// ---------------------------------------------------------------------------
// BLOB and CLOB
// ---------------------------------------------------------------------------

/** One LOB cell: db_type, int64 size, locator length, then the locator bytes. */
function lobCell(dbType: number, size: bigint, locatorLength: number, locator: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeInt32BE(dbType, 0);
  header.writeBigInt64BE(size, 4);
  header.writeInt32BE(locatorLength, 12);
  return Buffer.concat([header, locator]);
}

test("LOB_READ is CAS function 37 and its request matches the captured bytes", () => {
  const { rows } = parsePrepareAndExecute(Buffer.from(LOB_FRAMES.selectRows.hex, "hex"), 7);
  const blob = rows[0]!.b as LobLocator;
  const { header, payload } = writeLobRead(blob.handle, 0, 3, Buffer.from("01fffffb", "hex"));

  assert.equal(CASFunctionCode.LOB_READ, 37);
  assert.equal(payload.toString("hex"), LOB_FRAMES.readBlobRequest);
  assert.equal(header.toString("hex"), "0000006301fffffb");
});

test("captured LOB cells decode to a size and locator on relative and absolute paths", () => {
  for (const frame of [LOB_FRAMES.selectRows, LOB_FRAMES.selectRowsAbsolutePaths]) {
    const { rows } = parsePrepareAndExecute(Buffer.from(frame.hex, "hex"), 7);
    const sizes = rows.map((row) => [
      row.id,
      (row.b as LobLocator)?.size,
      (row.c as LobLocator)?.size,
    ]);

    assert.deepEqual(sizes, [
      [1, 3, 2],
      [2, 0, 0],
      [3, undefined, undefined],
    ]);
    assert.equal(rows[2]!.b, null);
    assert.equal(rows[2]!.c, null);
    assert.equal((rows[0]!.b as LobLocator).type, 23);
    assert.equal((rows[0]!.c as LobLocator).type, 24);
    assert.equal(
      (rows[0]!.b as LobLocator).handle.subarray(16).toString("latin1").slice(0, 5),
      "file:",
    );
  }
});

test("captured LOB_READ replies decode to their content or to the server's error", () => {
  const reply = (hex: string): Buffer => Buffer.from(hex, "hex");

  assert.deepEqual([...parseLobRead(reply(LOB_FRAMES.readBlobReply), 3)], [1, 2, 3]);
  assert.equal(parseLobRead(reply(LOB_FRAMES.readClobReply), 2).toString(), "hi");
  assert.equal(parseLobRead(reply(LOB_FRAMES.readAtEndReply), 3).length, 0);
  assert.throws(
    () => parseLobRead(reply(LOB_FRAMES.fileNotFoundReply), 3),
    (error: Error) =>
      !(error instanceof MalformedReplyError) &&
      /CUBRID LOB read failed \(-1020\): External file ".*" was not found/.test(error.message),
  );
});

for (const [name, reply, requested] of [
  ["no count", "000000", 3],
  ["more bytes than asked for", "00000004" + "01020304", 3],
  ["a count larger than its bytes", "00000003" + "0102", 3],
  ["bytes past its count", "00000002" + "010203", 3],
  ["an error envelope with no code", "fffffffe", 3],
] as const) {
  test(`a LOB_READ reply with ${name} is malformed`, () => {
    assert.throws(() => parseLobRead(Buffer.from(reply, "hex"), requested), MalformedReplyError);
  });
}

const LOCATOR = Buffer.from("file:ces_1/t.1\0", "latin1");

for (const [name, cell, cause] of [
  ["shorter than its header", Buffer.alloc(15), /has no header/],
  [
    "with the other LOB's db_type",
    lobCell(34, 3n, LOCATOR.length, LOCATOR),
    /db_type 34 in a column of type 23/,
  ],
  ["with a negative size", lobCell(33, -1n, LOCATOR.length, LOCATOR), /LOB size -1/],
  [
    "with a size past safe integers",
    lobCell(33, 2n ** 53n, LOCATOR.length, LOCATOR),
    /LOB size 9007199254740992/,
  ],
  [
    "whose locator overruns the cell",
    lobCell(33, 3n, LOCATOR.length + 1, LOCATOR),
    /value uses 32 of its 31 bytes/,
  ],
  [
    "whose locator stops short of the cell",
    lobCell(33, 3n, LOCATOR.length - 1, LOCATOR),
    /value uses 30 of its 31 bytes/,
  ],
  ["with an empty locator", lobCell(33, 0n, 0, Buffer.alloc(0)), /locator of 0 bytes has no NUL/],
  [
    "whose locator has no trailing NUL",
    lobCell(33, 3n, 4, Buffer.from("file")),
    /locator of 4 bytes has no NUL/,
  ],
] as const) {
  test(`a LOB cell ${name} is malformed`, () => {
    assert.throws(
      () => parsePrepareAndExecute(selectWire(23, cell), 1),
      (error: Error) =>
        error instanceof MalformedReplyError && cause.test((error.cause as Error).message),
    );
  });
}

for (const [name, wireType, cell, expected] of [
  ["an INT", 8, Buffer.from("00000007", "hex"), 7],
  ["a string", 2, Buffer.from("6100", "hex"), "a"],
  ["a NULL", 8, null, null],
  ["an empty bit string", 6, Buffer.alloc(0), Buffer.alloc(0)],
] as const) {
  test(`${name} column aliased __proto__ is an ordinary enumerable column`, () => {
    const { rows } = parsePrepareAndExecute(selectWire(wireType, cell, "__proto__"), 1);
    const row = rows[0]!;

    assert.deepEqual(Object.getOwnPropertyDescriptor(row, "__proto__"), {
      value: expected,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
  });
}

// ---------------------------------------------------------------------------
// Timezone-aware values and JSON, from replies captured on live brokers (#111)
// ---------------------------------------------------------------------------

const zonedRow = (frame: { hex: string }): { tz: unknown; t: unknown } => {
  const row = parsePrepareAndExecute(Buffer.from(frame.hex, "hex"), 7).rows[0];
  assert.ok(row);
  return { tz: row.tz, t: row.t };
};

const zonedCollection = (frame: { hex: string }): { c: unknown; t: unknown } => {
  const row = parsePrepareAndExecute(Buffer.from(frame.hex, "hex"), 7).rows[0];
  assert.ok(row);
  return { c: row.c, t: row.t };
};

test("captured zoned values keep their fields and the zone text the server sent", () => {
  const cases: Array<[{ hex: string; sql: string }, Record<string, unknown>]> = [
    [
      ZONED_FRAMES.timestamptzOffset,
      {
        type: "TIMESTAMPTZ",
        year: 2020,
        month: 1,
        day: 2,
        hour: 3,
        minute: 4,
        second: 5,
        millisecond: 0,
        zone: "+09:00",
      },
    ],
    [
      ZONED_FRAMES.timestamptzHalfHour,
      {
        type: "TIMESTAMPTZ",
        year: 2020,
        month: 7,
        day: 2,
        hour: 3,
        minute: 4,
        second: 5,
        millisecond: 0,
        zone: "-05:30",
      },
    ],
    [
      ZONED_FRAMES.timestamptzRegion,
      {
        type: "TIMESTAMPTZ",
        year: 2020,
        month: 1,
        day: 2,
        hour: 3,
        minute: 4,
        second: 5,
        millisecond: 0,
        zone: "America/New_York EST",
      },
    ],
    // LTZ values arrive in the session zone: the server's default UTC, or Asia/Seoul after
    // SET TIME ZONE, which also moves 03:04:05 America/New_York in July to 16:04:05 KST.
    [
      ZONED_FRAMES.timestampltz,
      {
        type: "TIMESTAMPLTZ",
        year: 2020,
        month: 1,
        day: 1,
        hour: 18,
        minute: 4,
        second: 5,
        millisecond: 0,
        zone: "UTC UTC",
      },
    ],
    [
      ZONED_FRAMES.timestampltzSeoul,
      {
        type: "TIMESTAMPLTZ",
        year: 2020,
        month: 1,
        day: 2,
        hour: 3,
        minute: 4,
        second: 5,
        millisecond: 0,
        zone: "Asia/Seoul KST",
      },
    ],
    [
      ZONED_FRAMES.datetimetzOffset,
      {
        type: "DATETIMETZ",
        year: 2020,
        month: 1,
        day: 2,
        hour: 3,
        minute: 4,
        second: 5,
        millisecond: 678,
        zone: "+09:00",
      },
    ],
    [
      ZONED_FRAMES.datetimetzRegion,
      {
        type: "DATETIMETZ",
        year: 2020,
        month: 7,
        day: 2,
        hour: 3,
        minute: 4,
        second: 5,
        millisecond: 999,
        zone: "America/New_York EDT",
      },
    ],
    [
      ZONED_FRAMES.datetimeltz,
      {
        type: "DATETIMELTZ",
        year: 2020,
        month: 1,
        day: 1,
        hour: 18,
        minute: 4,
        second: 5,
        millisecond: 678,
        zone: "UTC UTC",
      },
    ],
    [
      ZONED_FRAMES.datetimeltzSeoul,
      {
        type: "DATETIMELTZ",
        year: 2020,
        month: 7,
        day: 2,
        hour: 16,
        minute: 4,
        second: 5,
        millisecond: 500,
        zone: "Asia/Seoul KST",
      },
    ],
    // The extremes of the range: year 1 and year 9999 with a +14:00 offset.
    [
      ZONED_FRAMES.datetimetzMin,
      {
        type: "DATETIMETZ",
        year: 1,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        zone: "+00:00",
      },
    ],
    [
      ZONED_FRAMES.datetimetzMax,
      {
        type: "DATETIMETZ",
        year: 9999,
        month: 12,
        day: 31,
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
        zone: "+14:00",
      },
    ],
  ];
  for (const [frame, fields] of cases) {
    const { tz, t } = zonedRow(frame);
    assert.ok(tz instanceof ZonedDateTime, frame.sql);
    assert.deepEqual({ ...tz }, fields, frame.sql);
    assert.equal(t, "after", frame.sql);
  }
});

test("a zoned value prints as SQL literal text and serializes to JSON with its zone", () => {
  const texts: Array<[{ hex: string; sql: string }, string]> = [
    [ZONED_FRAMES.timestamptzOffset, "2020-01-02 03:04:05 +09:00"],
    [ZONED_FRAMES.datetimetzOffset, "2020-01-02 03:04:05.678 +09:00"],
    [ZONED_FRAMES.datetimetzMin, "0001-01-01 00:00:00.000 +00:00"],
    [ZONED_FRAMES.datetimeltzSeoul, "2020-07-02 16:04:05.500 Asia/Seoul KST"],
  ];
  for (const [frame, text] of texts) {
    const { tz } = zonedRow(frame);
    assert.equal(String(tz), text);
    assert.equal(JSON.stringify({ tz }), JSON.stringify({ tz: text }));
  }
  assert.throws(() => {
    (zonedRow(ZONED_FRAMES.timestamptzOffset).tz as { zone: string }).zone = "UTC";
  }, TypeError);
});

test("a NULL zoned value is null, and a zoned value inside a collection keeps its zone", () => {
  assert.deepEqual(zonedRow(ZONED_FRAMES.nullTimestamptz), { tz: null, t: "after" });

  const sequence = zonedCollection(ZONED_FRAMES.sequenceOfTimestamptz);
  assert.deepEqual(
    (sequence.c as ZonedDateTime[]).map((value) => value.toString()),
    ["2020-01-02 03:04:05 +09:00", "2020-07-02 03:04:05 -05:30"],
  );
  assert.equal(sequence.t, "after");
  const set = zonedCollection(ZONED_FRAMES.setOfDatetimeltz);
  assert.deepEqual((set.c as ZonedDateTime[]).map(String), ["2020-01-01 18:04:05.678 UTC UTC"]);
});

test("a captured zero zoned value rejects as unsupported, naming the column and size", () => {
  for (const [frame, pattern] of [
    [ZONED_FRAMES.zeroTimestamptz, /column "tz" \(wire type 29, 19 bytes\)/],
    [ZONED_FRAMES.zeroDatetimetz, /column "tz" \(wire type 31, 21 bytes\)/],
  ] as const) {
    assert.throws(
      () => parsePrepareAndExecute(Buffer.from(frame.hex, "hex"), 7),
      (error: Error) => {
        assert.ok(error instanceof UnsupportedValueError, frame.sql);
        assert.match(error.message, pattern);
        assert.match((error.cause as Error).message, /Zero date 0000-00-00/);
        return true;
      },
      frame.sql,
    );
  }
});

test("a zoned cell that breaks its layout is malformed and never a value", () => {
  const fields = (...values: number[]): Buffer => Buffer.concat(values.map(i16));
  const timestamp = fields(2020, 1, 2, 3, 4, 5);
  const datetime = fields(2020, 1, 2, 3, 4, 5, 678);
  const zone = (text: string): Buffer => Buffer.from(text, "latin1");

  const cases: Array<[string, number, Buffer]> = [
    ["no zone text", 29, timestamp],
    ["a NUL and no zone", 29, Buffer.concat([timestamp, zone("\0")])],
    ["a zone without its NUL", 29, Buffer.concat([timestamp, zone("+09:00")])],
    ["bytes after the NUL", 29, Buffer.concat([timestamp, zone("+09:00\0\0")])],
    ["a NUL inside the zone", 29, Buffer.concat([timestamp, zone("+09\0:00\0")])],
    ["a zone that is not UTF-8", 29, Buffer.concat([timestamp, Buffer.from([0xff, 0xfe, 0])])],
    ["a month of 13", 29, Buffer.concat([fields(2020, 13, 2, 3, 4, 5), zone("+09:00\0")])],
    ["a day of 0", 30, Buffer.concat([fields(2020, 1, 0, 3, 4, 5), zone("UTC UTC\0")])],
    ["an hour of 24", 29, Buffer.concat([fields(2020, 1, 2, 24, 4, 5), zone("+09:00\0")])],
    ["a negative year", 29, Buffer.concat([fields(-1, 1, 2, 3, 4, 5), zone("+09:00\0")])],
    [
      "milliseconds of 1000",
      31,
      Buffer.concat([fields(2020, 1, 2, 3, 4, 5, 1000), zone("+09:00\0")]),
    ],
    ["year 10000", 31, Buffer.concat([fields(10000, 1, 2, 3, 4, 5, 6), zone("+09:00\0")])],
    [
      "February 29 of a common year",
      29,
      Buffer.concat([fields(2021, 2, 29, 3, 4, 5), zone("+09:00\0")]),
    ],
    ["February 29 of 1900", 29, Buffer.concat([fields(1900, 2, 29, 3, 4, 5), zone("+09:00\0")])],
    ["April 31", 29, Buffer.concat([fields(2020, 4, 31, 3, 4, 5), zone("+09:00\0")])],
    ["a DATETIME shaped cell with no zone", 31, datetime],
    [
      "a TIMESTAMP shaped cell in a DATETIMETZ column",
      32,
      Buffer.concat([timestamp, zone("+9\0")]),
    ],
  ];
  for (const [name, type, cell] of cases) {
    assert.throws(
      () => parsePrepareAndExecute(selectWire(type, cell), 1),
      (error: Error) =>
        error instanceof MalformedReplyError && error.message.includes(`wire type ${type}`),
      name,
    );
  }

  // Real leap days and month ends decode.
  for (const [y, m, d] of [
    [2020, 2, 29],
    [2000, 2, 29],
    [2021, 2, 28],
    [1900, 2, 28],
    [9999, 12, 31],
    [1, 1, 1],
  ]) {
    const value = parsePrepareAndExecute(
      selectWire(29, Buffer.concat([fields(y!, m!, d!, 3, 4, 5), zone("+09:00\0")])),
      1,
    ).rows[0]?.value;
    assert.ok(value instanceof ZonedDateTime, `${y}-${m}-${d}`);
  }

  // The same layouts that are valid decode, so the cases above fail for their stated reason.
  const ok = parsePrepareAndExecute(selectWire(31, Buffer.concat([datetime, zone("+09:00\0")])), 1)
    .rows[0]?.value;
  assert.equal(String(ok), "2020-01-02 03:04:05.678 +09:00");
});

test("JSON is returned as its text, because the server sends it as VARCHAR below protocol 8", () => {
  const result = parsePrepareAndExecute(Buffer.from(ZONED_FRAMES.jsonColumn.hex, "hex"), 7);
  // Wire type 2 is VARCHAR, not the JSON code 34, and the value is not parsed.
  assert.equal(result.columns[0]?.type, 2);
  assert.deepEqual(result.rows, [{ j: '{"a":1}', t: "after" }]);
});

test("a damaged zero zoned value is malformed, never an unsupported value, in a column and a collection", () => {
  const zeroFields = (...tail: number[]): Buffer => Buffer.concat([0, 0, 0, ...tail].map(i16));
  const zone = (bytes: number[]): Buffer => Buffer.from(bytes);
  const good = [0x2b, 0x30, 0x30, 0x3a, 0x30, 0x30, 0]; // "+00:00\0"
  const cases: Array<[string, number, Buffer]> = [
    ["an unterminated zone", 29, Buffer.concat([zeroFields(0, 0, 0), zone([0x2b, 0x30, 0x30])])],
    ["a zone that is not UTF-8", 29, Buffer.concat([zeroFields(0, 0, 0), zone([0xff, 0xfe, 0])])],
    ["an empty zone", 29, Buffer.concat([zeroFields(0, 0, 0), zone([0, 0])])],
    ["an hour of 24", 29, Buffer.concat([zeroFields(24, 0, 0), zone(good)])],
    ["milliseconds of 1000", 31, Buffer.concat([zeroFields(0, 0, 0, 1000), zone(good)])],
  ];
  const element = (cell: Buffer, type: number): Buffer =>
    Buffer.concat([Buffer.from([type]), i32(1), i32(cell.length), cell]);
  for (const [name, type, cell] of cases) {
    assert.throws(
      () => parsePrepareAndExecute(selectWire(type, cell), 1),
      (error: Error) => error instanceof MalformedReplyError,
      name,
    );
    const cellInSequence = element(cell, type);
    assert.throws(
      () => parsePrepareAndExecute(selectWire(18, cellInSequence), 1),
      (error: Error) => error instanceof MalformedReplyError,
      `${name} in a SEQUENCE`,
    );
  }

  // The same zero date with its time and zone intact is still only unsupported.
  const intact = Buffer.concat([zeroFields(0, 0, 0), zone(good)]);
  assert.throws(
    () => parsePrepareAndExecute(selectWire(29, intact), 1),
    (error: Error) => error instanceof UnsupportedValueError,
  );
  assert.throws(
    () => parsePrepareAndExecute(selectWire(18, element(intact, 29)), 1),
    (error: Error) => error instanceof UnsupportedValueError,
  );
});

// ---------------------------------------------------------------------------
// Prepared binding: literal request bytes and captured replies
// ---------------------------------------------------------------------------

const frame = (hex: string): Buffer => Buffer.from(hex, "hex");
const bindHex = (value: unknown): string => encodePreparedParams([value]).bytes.toString("hex");
const CAS_INFO = Buffer.from("01ffffff", "hex");

test("PREPARE sends function code 2, the SQL with its NUL, flag 0 and autocommit 0", () => {
  const { header, payload } = writePrepare("SELECT 1", CAS_INFO);
  assert.equal(
    payload.toString("hex"),
    "02" + "00000009" + "53454c4543542031" + "00" + "0000000100" + "0000000100",
  );
  assert.equal(header.toString("hex"), "00000018" + "01ffffff");
});

test("PREPARE refuses SQL with a NUL, which would cut the statement short", () => {
  assert.throws(() => writePrepare("SELECT 1\0; DROP TABLE t", CAS_INFO), /null byte/);
});

test("EXECUTE sends the ten fixed arguments, then each type and value", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  const { payload } = writeExecute(statement, encodePreparedParams([7]), CAS_INFO);
  assert.equal(
    payload.toString("hex"),
    "03" +
      "00000004" +
      "00000001" + // handle
      "00000001" +
      "02" + // EXECUTE_QUERY_ALL, so `a; b` runs both statements
      "00000004" +
      "00000000" + // max_col_size
      "00000004" +
      "00000000" + // max_row_size
      "00000000" + // empty CALL-mode argument
      "00000001" +
      "01" + // inline fetch of a SELECT
      "00000001" +
      "00" + // autocommit
      "00000001" +
      "00" + // forward_only
      "00000008" +
      "00000000" +
      "00000000" + // cache time
      "00000004" +
      "00000000" + // query timeout
      "00000001" +
      "08" +
      "00000004" +
      "00000007", // INT 7
  );
});

test("EXECUTE asks for no inline fetch unless the statement is a SELECT", () => {
  const statement = {
    ...parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker)),
    statementType: 20 as StatementType,
  };
  const { payload } = writeExecute(statement, encodePreparedParams([]), CAS_INFO);
  assert.equal(payload.subarray(34, 39).toString("hex"), "0000000100");
});

test("prepared binds have literal type bytes and layouts", () => {
  for (const [value, expected] of [
    [null, "0000000100" + "00000000"],
    [undefined, "0000000100" + "00000000"],
    [true, "0000000108" + "00000004" + "00000001"],
    [false, "0000000108" + "00000004" + "00000000"],
    [-0, "0000000108" + "00000004" + "00000000"],
    [2147483647, "0000000108" + "00000004" + "7fffffff"],
    [2147483648, "0000000115" + "00000008" + "0000000080000000"],
    [Number.MAX_SAFE_INTEGER, "0000000115" + "00000008" + "001fffffffffffff"],
    [Number.MAX_SAFE_INTEGER + 1, "000000010c" + "00000008" + "4340000000000000"],
    [1.5, "000000010c" + "00000008" + "3ff8000000000000"],
    [9223372036854775807n, "0000000115" + "00000008" + "7fffffffffffffff"],
    [-9223372036854775808n, "0000000115" + "00000008" + "8000000000000000"],
    [
      9223372036854775808n,
      "0000000107" + "00000014" + "39323233333732303336383534373735383038" + "00",
    ],
    ["ab", "0000000101" + "00000003" + "6162" + "00"],
    ["", "0000000101" + "00000001" + "00"],
    ["\ud55c", "0000000101" + "00000004" + "ed959c" + "00"],
    [Buffer.from([0xab, 0xcd]), "0000000106" + "00000002" + "abcd"],
    [
      new Date(Date.UTC(2024, 1, 29, 13, 45, 56, 789)),
      "0000000116" + "0000000e" + "07e8" + "0002" + "001d" + "000d" + "002d" + "0038" + "0315",
    ],
  ] as const) {
    assert.equal(bindHex(value), expected);
  }
});

test("values that cannot be sent safely are refused without echoing them", () => {
  for (const [value, message] of [
    [Number.NaN, /NaN and Infinity/],
    [Number.POSITIVE_INFINITY, /NaN and Infinity/],
    [Number.NEGATIVE_INFINITY, /NaN and Infinity/],
    [Buffer.alloc(0), /empty Buffer/],
    ["secret\0", /null byte/],
    ["secret\x1a", /Ctrl-Z/],
    [10n ** 38n, /38 digits/],
    [-(10n ** 38n), /38 digits/],
    [new Date(Number.NaN), /invalid Date/],
    [new Date("0000-06-01T00:00:00Z"), /0001 to 9999/],
    [new Date("+010000-01-01T00:00:00Z"), /0001 to 9999/],
    [{ secret: 1 }, /unsupported prepared parameter type/],
    [new Uint8Array([1]), /unsupported prepared parameter type/],
  ] as const) {
    assert.throws(
      () => encodePreparedParams([value]),
      (error: Error) => message.test(error.message) && !error.message.includes("secret"),
    );
  }
});

test("the largest bigint NUMERIC can hold is sent as its 38 digits", () => {
  const largest = 10n ** 38n - 1n;
  assert.equal(bindHex(largest).slice(10, 18), "00000027");
  assert.equal(bindHex(-largest).slice(10, 18), "00000028");
});

test("a captured PREPARE reply gives the handle, the type and the server's bind count", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  assert.equal(statement.queryHandle, 1);
  assert.equal(statement.statementType, 21);
  assert.equal(statement.bindCount, 1);
  assert.equal(statement.columns[0]?.name, "v");
  assert.equal(statement.columns[0]?.type, 0);
});

test("the two-byte type header of an untyped column's cell is decoded", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  const read = (hex: string): unknown => parseExecute(frame(hex), statement, 7).rows[0]?.v;
  assert.equal(read(PREPARED_FRAMES.executeUntypedInt), 7);
  assert.equal(read(PREPARED_FRAMES.executeUntypedText), "ab");
  assert.equal(read(PREPARED_FRAMES.executeUntypedText102), "ab");
  assert.equal(read(PREPARED_FRAMES.executeUntypedNull), null);
});

test("a type header longer than its cell is malformed", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  // The size says 1 but the header takes 2, and the error names the column.
  const hex = PREPARED_FRAMES.executeUntypedInt.replace(
    "0000000683080000000701",
    "00000001" + "8363" + "00000000",
  );
  assert.throws(
    () => parseExecute(frame(hex), statement, 7),
    (error: Error) =>
      error instanceof MalformedReplyError && /overruns the cell of column "v"/.test(error.message),
  );
});

test("an EXECUTE reply handle stays PREPARE's, not its leading tuple count", () => {
  const statement = {
    ...parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker)),
    queryHandle: 9,
  };
  const result = parseExecute(frame(PREPARED_FRAMES.executeUntypedInt), statement, 7);
  assert.equal(result.queryHandle, 9);
  assert.equal(result.totalTupleCount, 1);
});

test("the statement description refreshed by EXECUTE is read before the shard id", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareMultiSelect));
  const result = parseExecute(frame(PREPARED_FRAMES.executeMultiSelect), statement, 7);
  assert.equal(result.resultInfos.length, 2);
  assert.deepEqual(result.rows, [{ a: 1 }]);
});

test("an impossible column info flag in an EXECUTE reply is malformed", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  const hex = PREPARED_FRAMES.executeUntypedInt.replace(
    "000000000000000000000000000000" + "00fffffffe",
    "000000000000000000000000000000" + "02fffffffe",
  );
  assert.throws(() => parseExecute(frame(hex), statement, 7), MalformedReplyError);
});

test("a statement failure inside an EXECUTE reply is the server's error", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  const wire = Buffer.concat([
    i32(1),
    Buffer.from([0]),
    i32(1),
    Buffer.from([20]),
    i32(-2),
    i32(-670),
    i32(4),
    Buffer.from("dup\0"),
  ]);
  assert.throws(
    () => parseExecute(wire, statement, 7),
    (error: Error & { code?: number }) => error.code === -670 && error.message.includes("dup"),
  );
});

test("captured PREPARE and EXECUTE server errors keep their codes", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  assert.throws(
    () => parsePrepare(frame(PREPARED_FRAMES.prepareSyntaxError)),
    (error: Error & { code?: number }) => error.code === -493,
  );
  assert.throws(
    () => parseExecute(frame(PREPARED_FRAMES.executeCoercionError), statement, 7),
    (error: Error & { code?: number }) => error.code === -494,
  );
});

/** An EXECUTE reply to an UPDATE of two rows: the result record, the column info flag, the shard id. */
const EXECUTE_UPDATE =
  "00000002" +
  "00" +
  "00000001" +
  "16" +
  "00000002" +
  "0000000000000000" +
  "00000000" +
  "00000000" +
  "00" +
  "fffffffe";

test("an EXECUTE reply cut off before its column info flag or shard id is malformed", () => {
  const statement = parsePrepare(frame(PREPARED_FRAMES.prepareUntypedMarker));
  assert.deepEqual(parseExecute(frame(EXECUTE_UPDATE), statement, 7).resultInfos, [
    { statementType: 22, resultCount: 2 },
  ]);

  for (const cut of [EXECUTE_UPDATE.length - 10, EXECUTE_UPDATE.length - 8]) {
    assert.throws(
      () => parseExecute(frame(EXECUTE_UPDATE.slice(0, cut)), statement, 7),
      MalformedReplyError,
    );
  }
});

// ---------------------------------------------------------------------------
// EXECUTE_ARRAY (function code 21): one prepared handle, many bind sets
// ---------------------------------------------------------------------------

test("EXECUTE_ARRAY is the request a live broker accepted, byte for byte", () => {
  const sets = [
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ].map((set) => encodePreparedParams(set));
  const { payload } = writeExecuteArray(3, sets, Buffer.alloc(4));

  assert.equal(payload.toString("hex"), EXECUTE_ARRAY_FRAMES.insertThreeRequest);
  assert.equal(payload[0], 21);
});

test("an EXECUTE_ARRAY reply gives each set's affected rows", () => {
  assert.deepEqual(parseExecuteArray(frame(EXECUTE_ARRAY_FRAMES.insertThree), 3, 7), [1, 1, 1]);
  assert.deepEqual(parseExecuteArray(frame(EXECUTE_ARRAY_FRAMES.insertTwo), 2, 7), [1, 1]);
  assert.deepEqual(parseExecuteArray(frame(EXECUTE_ARRAY_FRAMES.updateTwoSets), 2, 7), [2, 0]);
});

test("a failed set in an EXECUTE_ARRAY reply keeps its code, origin and message", () => {
  for (const hex of [
    EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate,
    EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate102,
  ]) {
    const [first, failed, last] = parseExecuteArray(frame(hex), 3, 7);

    assert.equal(first, 1);
    assert.equal(last, 1);
    assert.ok(failed instanceof CasReplyError);
    assert.equal(failed.code, -670);
    assert.equal(failed.origin, "server");
    assert.equal(failed.kind, "unique-violation");
    assert.match(failed.message, /^Operation would have caused one or more unique constraint/);
    assert.doesNotMatch(failed.message, /\0/);
  }
});

test("an EXECUTE_ARRAY reply that covers fewer sets than were sent is malformed", () => {
  assert.throws(
    () => parseExecuteArray(frame(EXECUTE_ARRAY_FRAMES.insertTwo), 3, 7),
    MalformedReplyError,
  );
  assert.throws(
    () => parseExecuteArray(frame(EXECUTE_ARRAY_FRAMES.insertThree), 2, 7),
    MalformedReplyError,
  );
});

test("an EXECUTE_ARRAY reply may stop early only after an interrupted set", () => {
  // Synthetic: the CAS stops after a set that failed with ER_INTERRUPTED (-4).
  const message = Buffer.from("interrupted\0");
  const reply = Buffer.concat([
    i32(0),
    i32(2),
    i32(1),
    Buffer.alloc(8),
    i32(-2),
    i32(-4),
    i32(message.length),
    message,
    i32(-2),
  ]);

  const [done, interrupted] = parseExecuteArray(reply, 3, 7);
  assert.equal(done, 1);
  assert.ok(interrupted instanceof CasReplyError);
  assert.equal(interrupted.kind, "interrupted");
});

test("an EXECUTE_ARRAY reply cut off inside a set or before its shard id is malformed", () => {
  const whole = EXECUTE_ARRAY_FRAMES.insertMiddleDuplicate;
  for (const cut of [whole.length - 8, 120, 40]) {
    assert.throws(() => parseExecuteArray(frame(whole.slice(0, cut)), 3, 7), MalformedReplyError);
  }
});

test("a negative EXECUTE_ARRAY result code is the server's error for the whole request", () => {
  assert.throws(
    () => parseExecuteArray(frame(PREPARED_FRAMES.executeCoercionError), 1, 7),
    (error: unknown) => error instanceof CasReplyError && error.code === -494,
  );
});

// ---------------------------------------------------------------------------
// LOB_NEW (35) and LOB_WRITE (36), against frames captured from 10.2 and 11.4
// ---------------------------------------------------------------------------

const lobReply = (hex: string): Buffer => Buffer.from(hex, "hex");
/** The handle of the captured 11.4 BLOB: the LOB_NEW reply after its int32 length. */
const NEW_BLOB_HANDLE = lobReply(LOB_WRITE_FRAMES.newBlobReply).subarray(4);

test("LOB_NEW is CAS function 35 and its requests are the captured bytes", () => {
  const casInfo = Buffer.from("01fffffb", "hex");
  const blobRequest = writeLobNew(CUBRIDDataType.BLOB, casInfo);
  const clobRequest = writeLobNew(CUBRIDDataType.CLOB, casInfo);

  assert.equal(CASFunctionCode.LOB_NEW, 35);
  assert.equal(blobRequest.payload.toString("hex"), LOB_WRITE_FRAMES.newBlobRequest);
  assert.equal(blobRequest.header.toString("hex"), "0000000901fffffb");
  assert.equal(clobRequest.payload.toString("hex"), "230000000400000018");
});

test("captured LOB_NEW replies decode to the handle, on relative and absolute paths", () => {
  const blobHandle = parseLobNew(lobReply(LOB_WRITE_FRAMES.newBlobReply), CUBRIDDataType.BLOB);
  assert.equal(blobHandle.length, 64);
  assert.equal(blobHandle.readInt32BE(0), 33);
  assert.equal(blobHandle.readBigInt64BE(4), 0n);
  assert.equal(blobHandle.readInt32BE(12), 48);
  assert.equal(
    blobHandle.subarray(16).toString("latin1"),
    "file:ces_475/ces_temp.00001794437053656858_2467\0",
  );

  const clobHandle = parseLobNew(lobReply(LOB_WRITE_FRAMES.newClobReply), CUBRIDDataType.CLOB);
  assert.equal(clobHandle.readInt32BE(0), 34);

  const absolute = parseLobNew(
    lobReply(LOB_WRITE_FRAMES.newBlobReplyAbsolutePath),
    CUBRIDDataType.BLOB,
  );
  assert.equal(absolute.length, 91);
  assert.match(absolute.subarray(16).toString("latin1"), /^file:\/var\/lib\/cubrid\/testdb\/lob\//);
});

test("a LOB_NEW handle is a copy, not a view of the reply", () => {
  const reply = lobReply(LOB_WRITE_FRAMES.newBlobReply);
  const handle = parseLobNew(reply, CUBRIDDataType.BLOB);
  reply.fill(0);
  assert.equal(handle.readInt32BE(0), 33);
});

test("a LOB_NEW refusal with a bare CAS code is an error, not a malformed reply", () => {
  assert.throws(
    () => parseLobNew(lobReply(LOB_WRITE_FRAMES.newBadTypeReply), CUBRIDDataType.BLOB),
    (error: unknown) =>
      error instanceof CasReplyError &&
      error.code === -10004 &&
      error.origin === "cas" &&
      /CUBRID LOB create failed \(-10004\)/.test(error.message),
  );
});

test("a LOB_NEW server error carries its code and message", () => {
  // The error layout every CAS reply shares: -2, the code, then the message.
  const reply = lobReply(`fffffffefffffc08${Buffer.from("disk full\0").toString("hex")}`);
  assert.throws(
    () => parseLobNew(reply, CUBRIDDataType.CLOB),
    (error: unknown) =>
      error instanceof CasReplyError &&
      error.code === -1016 &&
      error.origin === "server" &&
      /LOB create failed \(-1016\): disk full/.test(error.message),
  );
});

const newBlobHex = LOB_WRITE_FRAMES.newBlobReply;
for (const [name, reply, type] of [
  ["no length", "000000", CUBRIDDataType.BLOB],
  ["a length of 0", "00000000", CUBRIDDataType.BLOB],
  ["a length longer than its bytes", `00000041${newBlobHex.slice(8)}`, CUBRIDDataType.BLOB],
  ["bytes past its length", `${newBlobHex}00`, CUBRIDDataType.BLOB],
  ["a header and no locator", `00000010${newBlobHex.slice(8, 40)}`, CUBRIDDataType.BLOB],
  ["the other LOB's db_type", newBlobHex, CUBRIDDataType.CLOB],
  [
    "a size other than 0",
    `${newBlobHex.slice(0, 16)}0000000000000001${newBlobHex.slice(32)}`,
    CUBRIDDataType.BLOB,
  ],
  [
    "a locator length that disagrees",
    `${newBlobHex.slice(0, 32)}0000002f${newBlobHex.slice(40)}`,
    CUBRIDDataType.BLOB,
  ],
  ["a locator without its NUL", `${newBlobHex.slice(0, -2)}41`, CUBRIDDataType.BLOB],
  ["an error envelope with no code", "fffffffe00", CUBRIDDataType.BLOB],
] as const) {
  test(`a LOB_NEW reply with ${name} is malformed`, () => {
    assert.throws(() => parseLobNew(lobReply(reply), type), MalformedReplyError);
  });
}

test("LOB_WRITE is CAS function 36 and its request is the captured bytes", () => {
  const { header, payload } = writeLobWrite(
    NEW_BLOB_HANDLE,
    0,
    Buffer.from([1, 2, 3]),
    Buffer.from("01fffffb", "hex"),
  );

  assert.equal(CASFunctionCode.LOB_WRITE, 36);
  assert.equal(payload.toString("hex"), LOB_WRITE_FRAMES.writeRequest);
  assert.equal(header.readInt32BE(0), payload.length);
});

test("a LOB_WRITE request states its offset as an int64", () => {
  const offset = 2 ** 33 + 5;
  const { payload } = writeLobWrite(NEW_BLOB_HANDLE, offset, Buffer.from([9]), Buffer.alloc(4));
  const at = 1 + 4 + NEW_BLOB_HANDLE.length;
  assert.equal(payload.readInt32BE(at), 8);
  assert.equal(payload.readBigInt64BE(at + 4), BigInt(offset));
  assert.equal(payload.subarray(at + 12).toString("hex"), "0000000109");
});

test("a captured LOB_WRITE reply is the count written, and an error carries its code", () => {
  assert.equal(parseLobWrite(lobReply(LOB_WRITE_FRAMES.writeReply), 3), 3);
  assert.throws(
    () => parseLobWrite(lobReply(LOB_WRITE_FRAMES.writeGapReply), 1),
    (error: unknown) =>
      error instanceof CasReplyError &&
      error.code === -1016 &&
      /CUBRID LOB write failed \(-1016\): POSIX external storage error: offset error/.test(
        error.message,
      ),
  );
});

test("a LOB_WRITE that stored fewer bytes than sent fails without condemning the session", () => {
  assert.throws(
    () => parseLobWrite(lobReply("00000002"), 3),
    (error: Error) =>
      !(error instanceof MalformedReplyError) &&
      !(error instanceof CasReplyError) &&
      error.message === "CUBRID LOB write stored 2 of 3 bytes",
  );
});

for (const [name, reply] of [
  ["no count", "000000"],
  ["a count larger than sent", "00000004"],
  ["bytes after its count", "0000000300"],
  ["an error envelope with no code", "fffffffe"],
] as const) {
  test(`a LOB_WRITE reply with ${name} is malformed`, () => {
    assert.throws(() => parseLobWrite(lobReply(reply), 3), MalformedReplyError);
  });
}

test("the size patch writes the int64 after db_type into a copy of the handle", () => {
  const sized = setLobHandleSize(NEW_BLOB_HANDLE, 8 * 1024 * 1024);

  assert.equal(sized.readBigInt64BE(4), 8_388_608n);
  assert.equal(sized.subarray(0, 4).toString("hex"), "00000021");
  assert.ok(sized.subarray(12).equals(NEW_BLOB_HANDLE.subarray(12)));
  assert.equal(NEW_BLOB_HANDLE.readBigInt64BE(4), 0n);
});

test("a LOB parameter binds as int32 1, the BLOB or CLOB type, then the length-prefixed handle", () => {
  const binds = encodePreparedParams([7, blob(Buffer.from("ab")), "x", clob("c")]);
  assert.deepEqual(
    binds.lobs?.map(({ offset, param }) => [offset, param.kind]),
    [
      [13, "blob"],
      [24, "clob"],
    ],
  );

  const blobHandle = setLobHandleSize(NEW_BLOB_HANDLE, 2);
  const clobHandle = setLobHandleSize(
    parseLobNew(lobReply(LOB_WRITE_FRAMES.newClobReply), CUBRIDDataType.CLOB),
    1,
  );
  const bound = bindLobHandles(binds, [blobHandle, clobHandle]);

  assert.equal(bound.count, 4);
  assert.equal(bound.lobs, undefined);
  assert.equal(
    bound.bytes.toString("hex"),
    "0000000108" +
      "0000000400000007" +
      `0000000117${"00000040"}${blobHandle.toString("hex")}` +
      "0000000101" +
      "000000027800" +
      `0000000118${"00000040"}${clobHandle.toString("hex")}`,
  );
});

test("an EXECUTE with a LOB carries the bound handle as its last value", () => {
  const statement = parsePrepare(Buffer.from(EXECUTE_ARRAY_FRAMES.prepareInsert, "hex"));
  const handle = setLobHandleSize(NEW_BLOB_HANDLE, 3);
  const bound = bindLobHandles(encodePreparedParams([1, blob(Buffer.from([1, 2, 3]))]), [handle]);
  const { payload } = writeExecute(statement, bound, Buffer.alloc(4));

  assert.equal(
    payload.subarray(payload.length - bound.bytes.length).toString("hex"),
    `00000001080000000400000001000000011700000040${handle.toString("hex")}`,
  );
});

test("an empty blob() still uploads: it is an empty BLOB, not NULL", () => {
  const binds = encodePreparedParams([blob(Buffer.alloc(0))]);
  assert.equal(binds.bytes.length, 0);
  assert.equal(binds.lobs?.length, 1);
});

test("blob() and clob() are refused by every SQL literal path with a TypeError", () => {
  for (const value of [blob(Buffer.from("a")), clob("a")]) {
    assert.throws(() => formatValue(value, true), TypeError);
    assert.throws(() => interpolateParams("SELECT ?", [value], true), TypeError);
    assert.throws(() => encodeBindParams([value]), TypeError);
  }
});

test("a stream source given twice to one statement is refused before anything is encoded", async () => {
  async function* source(): AsyncGenerator<Buffer> {
    yield Buffer.from("a");
  }
  const stream = source();
  assert.throws(
    () => encodePreparedParams([blob(stream), blob(stream)]),
    (error: Error) => error instanceof TypeError && /used twice/.test(error.message),
  );
  // A Buffer is not read once, so it may appear twice.
  const bytes = Buffer.from("a");
  assert.equal(encodePreparedParams([blob(bytes), blob(bytes)]).lobs?.length, 2);
});

// ---------------------------------------------------------------------------
// Text charsets, from a reply captured on the iso88591 testdb (#238)
// ---------------------------------------------------------------------------

/** The captured reply with each `[from, to]` hex pair replaced; each `from` must occur once. */
function latin1TextWith(...edits: Array<[string, string]>): Buffer {
  let hex = CAPTURED_FRAMES.latin1Text.hex;
  for (const [from, to] of edits) {
    assert.equal(hex.split(from).length, 2, from);
    hex = hex.replace(from, to);
  }
  return Buffer.from(hex, "hex");
}

/** Column u8: its type (VARCHAR, charset 5) and its cell (C3 A9 and the NUL). */
const U8_TYPE = "8502000000000004";
const U8_CELL = "00000003c3a900";

test("the column charset sits in the low bits of the literal first type byte", () => {
  const reply = Buffer.from(CAPTURED_FRAMES.latin1Text.hex, "hex");
  // VARCHAR iso88591 (3), VARCHAR utf8 (5), SET (16) OF VARCHAR iso88591, CHAR iso88591.
  for (const type of ["830200003fffffff", "8502000000000004", "a302000000000000", "830100"]) {
    assert.ok(reply.includes(Buffer.from(type, "hex")), type);
  }
  const { columns } = parsePrepareAndExecute(reply, 7);
  assert.deepEqual(
    columns.map((c) => [c.name, c.type, c.elementType, c.charset]),
    [
      ["l1", 2, undefined, 3],
      ["u8", 2, undefined, 5],
      ["st", 16, 2, 3],
      ["t", 1, undefined, 3],
    ],
  );
});

test("utf-8 decodes every text value as UTF-8 and ignores the column charset", () => {
  const { rows } = parsePrepareAndExecute(
    Buffer.from(CAPTURED_FRAMES.latin1Text.hex, "hex"),
    7,
    false,
    "utf-8",
  );
  // E9 alone is not UTF-8: the unchanged 1.x result is U+FFFD.
  assert.deepEqual(rows, [{ l1: "�", u8: "é", st: ["�"], t: "after" }]);
});

test("iso-8859-1 decodes each value in the charset its column reports", () => {
  const decode = (reply: Buffer) => parsePrepareAndExecute(reply, 7, false, "iso-8859-1").rows[0];
  assert.deepEqual(decode(Buffer.from(CAPTURED_FRAMES.latin1Text.hex, "hex")), {
    l1: "\u00e9",
    u8: "\u00e9",
    st: ["\u00e9"],
    t: "after",
  });
  // EUC-KR (charset 4): C7 D1 is U+D55C.
  const eucKr = latin1TextWith([U8_TYPE, "8402000000000004"], [U8_CELL, "00000003c7d100"]);
  assert.equal(decode(eucKr)?.u8, "\ud55c");
});

test("iso-8859-1 refuses a utf8 or euckr value its charset cannot decode, never U+FFFD", () => {
  const decode = (reply: Buffer) => parsePrepareAndExecute(reply, 7, false, "iso-8859-1");
  for (const reply of [
    latin1TextWith([U8_CELL, "00000003e9ff00"]),
    latin1TextWith([U8_TYPE, "8402000000000004"], [U8_CELL, "00000003ff0100"]),
    // Bytes the WHATWG euc-kr decoder (windows-949) accepts but EUC-KR does not:
    // 81 41 is a UHC extension pair, 80 80 would become two C1 controls.
    latin1TextWith([U8_TYPE, "8402000000000004"], [U8_CELL, "00000003814100"]),
    latin1TextWith([U8_TYPE, "8402000000000004"], [U8_CELL, "00000003808000"]),
  ]) {
    assert.throws(
      () => decode(reply),
      (error: Error) =>
        error instanceof UnsupportedValueError &&
        /column "u8" \(wire type 2, 3 bytes\)/.test(error.message),
    );
  }
  // The utf-8 mode keeps its 1.x replacement.
  const reply = latin1TextWith([U8_CELL, "00000003e9ff00"]);
  assert.equal(parsePrepareAndExecute(reply, 7).rows[0]?.u8, "\ufffd\ufffd");
});

test("iso-8859-1 sends SQL text and string binds as Latin-1 and refuses text above U+00FF", () => {
  const latin1Sql = writePrepare("SELECT '\u00e9'", Buffer.alloc(4), "iso-8859-1").payload;
  // int32 length 11 (10 bytes and the NUL), then the Latin-1 bytes.
  assert.ok(latin1Sql.includes(Buffer.from("0000000b53454c4543542027e92700", "hex")));
  const utf8Sql = writePrepare("SELECT '\u00e9'", Buffer.alloc(4)).payload;
  assert.ok(utf8Sql.includes(Buffer.from("0000000c53454c4543542027c3a92700", "hex")));

  // CHAR (1) bind: type, then int32 length 3, E9 FF and the NUL.
  assert.equal(
    encodePreparedParams(["\u00e9\u00ff"], "iso-8859-1").bytes.toString("hex"),
    "000000010100000003e9ff00",
  );
  assert.equal(encodePreparedParams(["\u00e9"]).bytes.toString("hex"), "000000010100000003c3a900");

  for (const call of [
    () => writePrepare("SELECT '\u2603'", Buffer.alloc(4), "iso-8859-1"),
    () => encodePreparedParams(["a\u0100"], "iso-8859-1"),
  ]) {
    assert.throws(call, /above U\+00FF at offset \d+, which charset "iso-8859-1" cannot encode/);
  }
});

test("iso-8859-1 clob() content: text as Latin-1, bytes as they are, nothing above U+00FF", async () => {
  const chunks = async (source: Parameters<typeof clob>[0]) => {
    const out: Buffer[] = [];
    for await (const chunk of lobChunks(clob(source), 4, "iso-8859-1"))
      out.push(Buffer.from(chunk));
    return out.map((chunk) => chunk.toString("hex"));
  };
  assert.deepEqual(await chunks("h\u00e9\u00ff!x"), ["68e9ff21", "78"]);
  // Not UTF-8, which the default refuses: in ISO-8859-1 every byte is a character.
  assert.deepEqual(await chunks(Buffer.from("ffa1", "hex")), ["ffa1"]);
  await assert.rejects(chunks("\u0100"), /character above U\+00FF/);
  await assert.rejects(async () => {
    for await (const _ of lobChunks(clob(Buffer.from("ffa1", "hex")), 4)) {
      // drain
    }
  }, /not valid UTF-8/);
});
