# CUBRID and JavaScript type behavior

This document describes **the current native TypeScript CAS driver implementation**,
not a guarantee that every CUBRID release and column representation has been
tested against a real database. Start with [verified support](SUPPORT_MATRIX.md).
`query<T>()` only affects TypeScript checking; it cannot validate a row or
convert a runtime value.

## Reading result columns

| CUBRID wire type(s) | Current JavaScript value | Status / limitation |
| --- | --- | --- |
| CHAR, VARCHAR/STRING, NCHAR, VARNCHAR, ENUM | `string` | Decoded as null-terminated text; validate encoding against a live broker |
| SHORT, INTEGER | `number` | Parsed signed 16-bit / 32-bit integers |
| BIGINT | `bigint` | Lossless signed 64-bit value; corrected by [#126](https://github.com/cubrid-lab/cubrid-client/pull/126); `JSON.stringify` needs explicit bigint conversion |
| FLOAT, DOUBLE, MONETARY | `number` | IEEE-754 conversion may round decimal values |
| NUMERIC | `string` | Decimal text retained without floating-point rounding; consumer chooses decimal library |
| DATE, TIME, TIMESTAMP, DATETIME | `Date` | Parsed using the **local Node.js process timezone**; SQL DATETIME itself has no timezone, so this is not stable across zones ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113)) |
| BIT, VARBIT | `Buffer` | Binary bytes; verify bit-length/bit-order semantics per server version |
| BLOB, CLOB | `Buffer` from the wire field | **Not established as full LOB content**; the field may be a locator rather than the object body ([#93](https://github.com/cubrid-lab/cubrid-client/issues/93), [#103](https://github.com/cubrid-lab/cubrid-client/issues/103)) |
| SET, MULTISET, SEQUENCE | Query rejects for non-NULL | CAS identifiers fixed; collection decoding is not yet supported ([#82](https://github.com/cubrid-lab/cubrid-client/issues/82)) |
| OBJECT/OID, RESULTSET, JSON, timezone variants and unknown codes | Query rejects for unsupported non-NULL | Do not coerce unsupported data to `null`; future decoding tracked in [#111](https://github.com/cubrid-lab/cubrid-client/issues/111) |
| SQL NULL | `null` | NULL is distinct from unsupported non-NULL values and a valid empty string |

For unsupported non-NULL values, the error includes column name and numeric
CAS wire type. Error handling does **not** introduce collection, JSON or LOB
support. See [#110](https://github.com/cubrid-lab/cubrid-client/issues/110)
and the [independent protocol fixture plan](https://github.com/cubrid-lab/cubrid-client/issues/117).

## Sending JavaScript parameters

The existing public `query(sql, params)` method renders values into SQL text
**client-side**. It is not a server-side prepared-statement binding API;
native opt-in binding is a separate proposal ([#85](https://github.com/cubrid-lab/cubrid-client/issues/85)).
The SQL literal escaping rules depend on the server's `no_backslash_escapes`
setting, negotiated on each physical connection.

| JavaScript parameter | Current SQL literal behavior |
| --- | --- |
| `string` | Quoted, server-mode-aware escaped string; embedded NUL/Ctrl-Z rejected |
| `number` | Decimal text representation; floating-point/large integer precision is subject to JavaScript `number` |
| `bigint` | Decimal integer text, preserving JavaScript bigint precision |
| `boolean` | `1` or `0` |
| `Date` | `DATETIME'YYYY-MM-DD HH:MM:SS.mmm'` using **UTC components**; it has no timezone offset embedded |
| `Buffer` | Hexadecimal binary literal `X'...'`; not a promise of native BLOB/CLOB write support |
| `null` | SQL `NULL` |

The module also defines an internal binary encoder. It is **not** the active
binding path used by `query(sql, params)`; do not infer active server-side
prepared statements from its presence. Check [the API reference](API_REFERENCE.md)
for current method contracts.

## Cautions

- A TypeScript row type does not prove the database returned the declared
  type; explicitly validate results that cross trust boundaries.
- Do not use local-time `Date` decoding as a canonical UTC conversion until
  [#113](https://github.com/cubrid-lab/cubrid-client/issues/113) is resolved.
- A returned `Buffer` from a BLOB/CLOB wire field is **not** established as
  the LOB contents. Keep full LOB read/write unsupported until validated.
- The required live broker/version and round-trip evidence is tracked in
  [#95](https://github.com/cubrid-lab/cubrid-client/issues/95).

