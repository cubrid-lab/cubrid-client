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
  MalformedReplyError,
  parseFetch,
  parsePrepareAndExecute,
  UnsupportedValueError,
  writeFetch,
} from "../src/protocol/protocol.js";
import { CAPTURED_FRAMES, type CapturedFrame } from "./fixtures/collection-frames.js";

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

test("a captured TIMESTAMPTZ value rejects as unsupported, naming its column and wire type", () => {
  assert.throws(
    () => parsePrepareAndExecute(Buffer.from(CAPTURED_FRAMES.timestamptzValue.hex, "hex"), 7),
    (error: Error) => {
      assert.ok(error instanceof UnsupportedValueError);
      assert.match(error.message, /column "tz" \(wire type 29, 19 bytes\)/);
      return true;
    },
  );
});

test("a zero-byte value is null only for BIT and VARBIT, and never for another type", () => {
  // The captured SELECT X'' has a size-0 cell. It stays null until #173 and keeps column t.
  assert.deepEqual(
    parsePrepareAndExecute(Buffer.from(CAPTURED_FRAMES.emptyBitValue.hex, "hex"), 7).rows,
    [{ x: null, t: "after" }],
  );
  assert.equal(parsePrepareAndExecute(selectWire(5, Buffer.alloc(0)), 1).rows[0]?.value, null);

  // No decoder: OBJECT, TIMESTAMPTZ, JSON and a code CCI does not define.
  for (const type of [19, 29, 34, 99]) {
    assert.throws(() => parsePrepareAndExecute(selectWire(type, Buffer.alloc(0)), 1), (error: Error) =>
      error instanceof UnsupportedValueError && error.message.includes(`wire type ${type}, 0 bytes`));
  }

  // Decodable, but CAS counts the NUL of text and writes fixed widths in full.
  for (const type of [2, 8, 21, 23]) {
    assert.throws(() => parsePrepareAndExecute(selectWire(type, Buffer.alloc(0)), 1), (error: Error) =>
      error instanceof MalformedReplyError &&
      error.message.includes(`wire type ${type}, 0 bytes`) &&
      // The reason is one step down the cause chain, not behind a repeated message.
      !(error.cause as Error).message.startsWith("Failed to decode"));
  }
});

test("a NULL-typed column never turns a typed cell without value bytes into null", () => {
  // Cell of size 1 holding only the type header: the literal TIMESTAMPTZ code 29.
  assert.throws(
    () => parsePrepareAndExecute(selectWire(0, Buffer.from([29])), 1),
    (error: Error) => error instanceof UnsupportedValueError && /wire type 29, 0 bytes/.test(error.message),
  );
  // Cell of size 0 has no room for the header, which must not come from the next bytes.
  assert.throws(
    () => parsePrepareAndExecute(selectWire(0, Buffer.alloc(0)), 1),
    (error: Error) => error instanceof MalformedReplyError && /invalid cell length 0/.test(error.message),
  );
});

test("an unsupported value whose length overruns the reply is malformed, not unsupported", () => {
  const wire = selectWire(29, Buffer.from("01020304", "hex"));
  assert.throws(
    () => parsePrepareAndExecute(wire.subarray(0, -2), 1),
    (error: Error) => error instanceof MalformedReplyError,
  );
});

test("the first unsupported value is reported only once the whole reply holds together", () => {
  const column = { type: 29, name: "tz" } as never;
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
    [CAPTURED_FRAMES.datetimetzElement, 31],
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

test("parseFetch decodes collections with the metadata of the executed query", () => {
  const { columns } = decodeFrame(CAPTURED_FRAMES.tableRows);
  const cell = (hex: string): Buffer => Buffer.from(hex, "hex");
  const text = Buffer.from("fetch\0");
  const fetched = parseFetch(
    Buffer.concat([
      i32(0), i32(1),
      i32(5), Buffer.alloc(8),
      i32(4), cell("00000005"),
      i32(13), cell("08000000010000000400000007"),
      i32(5), cell("0000000000"),
      i32(-1),
      i32(text.length), text,
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
  ["an element length past the cell", "00000015080000000200000004000000010000000500000002", /cannot read 5 bytes/],
  ["an element length past the packet", "00000015080000000200000004000000017fffffff00000002", /cannot read 2147483647 bytes/],
  ["a negative element length below NULL", "0000001508000000020000000400000001fffffffe00000002", /invalid length -2/],
  ["a zero length on a type that cannot be empty", "00000015080000000200000004000000010000000000000002", /invalid length 0/],
  ["a count that exceeds the cell", "00000015087fffffff00000004000000010000000400000002", /count 2147483647/],
  ["a count larger than the elements", "00000015080000000300000004000000010000000400000002", /element 2 has no length/],
  ["a count smaller than the elements", "00000015080000000100000004000000010000000400000002", /uses 13 of its 21 bytes/],
  ["a negative count", "0000001508ffffffff00000004000000010000000400000002", /count -1/],
  ["a non-NULL element without an element type", "00000015000000000200000004000000010000000400000002", /Unsupported CUBRID CAS value type 0/],
  // Element payloads that disagree with their type, in a cell of the right size.
  ["an int element shorter than its type", "0000001308000000020000000400000001000000020000", /bounds|out of range/],
  ["an int element longer than its type", "00000016080000000200000004000000010000000500000000" + "02", /uses 4 of its 5 bytes/],
  // Cell lengths.
  ["a cell longer than its elements", "00000019080000000200000004000000010000000400000002ffffffff", /uses 21 of its 25 bytes/],
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
  assert.throws(() => parseFetch(
    Buffer.concat([i32(0), i32(1), i32(1), Buffer.alloc(8), i32(body.length), body]),
    [{ ...decodeFrame(CAPTURED_FRAMES.setDeduplicated).columns[0]!, type: CUBRIDDataType.SEQUENCE }],
  ));
});

test("a scalar value that disagrees with its cell length rejects", () => {
  // An int column declares 3 bytes: reading 4 would consume the next cell's first byte.
  const wire = selectWire(8, Buffer.from("000000", "hex"));
  assert.throws(() => parsePrepareAndExecute(Buffer.concat([wire, Buffer.alloc(4)]), 1), /Failed to decode/);
  // The same for a bigint column that declares more than its 8 bytes.
  const long = selectWire(21, Buffer.from("000000000000002a00", "hex"));
  assert.throws(() => parsePrepareAndExecute(long, 1), /Failed to decode/);
});

test("a NULL cell keeps an ordinary one-byte metadata type intact", () => {
  assert.equal(parsePrepareAndExecute(selectWire(34, null), 1).columns[0]?.type, 34);
  assert.equal(parsePrepareAndExecute(selectWire(34, null), 1).columns[0]?.elementType, undefined);
});
