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
| JSON | `string` | Raw JSON text, not parsed. This driver declares CAS protocol 7, and below protocol 8 the server sends JSON columns as VARCHAR (wire type 2), so wire type 34 does not arrive. Checked on 10.2, 11.0, 11.2 and 11.4; a parsed contract is tracked in [#111](https://github.com/cubrid-lab/cubrid-client/issues/111) |
| SHORT, INTEGER | `number` | Parsed signed 16-bit / 32-bit integers |
| BIGINT | `bigint` | Lossless signed 64-bit value; corrected by [#126](https://github.com/cubrid-lab/cubrid-client/pull/126); `JSON.stringify` needs explicit bigint conversion |
| FLOAT, DOUBLE, MONETARY | `number` | IEEE-754 conversion may round decimal values |
| NUMERIC | `string` | Decimal text retained without floating-point rounding; consumer chooses decimal library |
| DATE, TIME, TIMESTAMP, DATETIME | `Date` | Parsed using the **local Node.js process timezone**; SQL DATETIME itself has no timezone, so this is not stable across zones ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113)). The zero date `0000-00-00` of DATE, DATETIME and TIMESTAMP has no `Date`, so the query rejects; see [zero dates](#zero-dates) |
| BIT, VARBIT | `Buffer` | Binary bytes; verify bit-length/bit-order semantics per server version. An empty `X''` returns an empty `Buffer`, distinct from SQL NULL |
| BLOB, CLOB | `Buffer` from the wire field | **Not established as full LOB content**; the field may be a locator rather than the object body ([#93](https://github.com/cubrid-lab/cubrid-client/issues/93), [#103](https://github.com/cubrid-lab/cubrid-client/issues/103)) |
| SET, MULTISET, SEQUENCE | Array (`CollectionValue`) | See [collection columns](#collection-columns) |
| OBJECT/OID (19), RESULTSET (20), TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ and DATETIMELTZ (29-32), and unknown codes | Query rejects, including for a zero-byte value | Never coerced to `null`; see [values that cannot be decoded](#values-that-cannot-be-decoded). Future decoding is tracked in [#111](https://github.com/cubrid-lab/cubrid-client/issues/111) |
| SQL NULL | `null` | Sent as cell length `-1`. NULL is distinct from unsupported non-NULL values and from a valid empty string, which is `""` |

### Values that cannot be decoded

A failed decode rejects the query with a `QueryError`. Further down its `cause`
chain is an error named `UnsupportedValueError` or `MalformedReplyError`, which
[troubleshooting](TROUBLESHOOTING.md#queryerror-because-a-value-or-reply-could-not-be-decoded)
shows how to find. When one cell failed, that error names the column, the numeric
CAS wire type and the value size, for example
`Failed to decode CUBRID column "tz" (wire type 29, 19 bytes)`. What happens to
the connection depends on whether the server's reply can still be trusted:

| Failure | Example | Connection afterwards |
| --- | --- | --- |
| **Unsupported value** (`UnsupportedValueError`) in a reply that is otherwise intact | A TIMESTAMPTZ column, or a zero date | Stays open. The query handle is released, and an open transaction stays open for you to commit or roll back |
| **Malformed reply** (`MalformedReplyError`) that contradicts its own structure | A length past the end of the reply, or a value that does not fill its cell | Dropped, because the next reply could not be trusted to line up. Nothing more is sent on it |

The driver reads the rest of a reply, including every remaining and nested
collection element, before reporting an unsupported value, so damage anywhere in
that reply is reported as malformed. The first unsupported column is the one
named. Queries already waiting behind a malformed reply reject without being
sent, because the statement before them has an unknown outcome; queries issued
afterwards open a new session.

After a malformed reply, the server discards the session:

- An open transaction is **rolled back by the server**, and `query()` rejects
  until you acknowledge the loss. Either `commit()` or `rollback()` does that.
  Both reject with a `TransactionError`, and `commit()` never reports success.
  Afterwards the next query opens a new session in **autocommit** mode, so call
  `beginTransaction()` first if the work must stay in a transaction, and redo
  the lost statements: none of them were committed.
- In autocommit mode the next query opens a new session. The failed statement
  may already have run and committed on the server, so verify its outcome before
  retrying a write.

A zero-byte value is never treated as SQL NULL. A top-level empty BIT or VARBIT
value is an empty `Buffer`, as inside a collection: the server counts the NUL of
text and writes fixed-width types in full, so it has no other zero-byte
encoding. A zero-byte value of another decodable type is a malformed reply.

### Zero dates

`DATE'0000-00-00'` and its DATETIME and TIMESTAMP forms, whether a literal or a
stored value, reach the client as all-zero year, month and day fields. They
used to decode to a real-looking `Date` in 1899 (`new Date(0, -1, 0)`), which
is silently wrong data. They now reject the query as an
[unsupported value](#values-that-cannot-be-decoded): the `QueryError` cause
names the column and wire type (`Failed to decode CUBRID column "d" (wire type
13, 6 bytes)`, with the cause `Zero date 0000-00-00 ...`), and the connection
and any open transaction stay usable. This matches pycubrid, which also raises
an error instead of returning a date.

The query rejects as a whole, so no other column of that row is returned. To
read a table that holds zero dates, filter them out or convert them in SQL, for
example `SELECT CASE WHEN d = DATE'0000-00-00' THEN NULL ELSE d END`, or select
`TO_CHAR(d)`. Valid dates decode exactly as before.

The driver can only reject what it receives. In some cases the server itself
sends SQL NULL for a non-NULL value, such as a
[mixed-type collection](#collection-columns) or a type its CAS cannot encode.
Those are the same bytes as a genuine NULL and return `null`.

Error handling does **not** introduce timezone, OBJECT or LOB decoding. See
[#110](https://github.com/cubrid-lab/cubrid-client/issues/110) and the
[independent protocol fixture plan](https://github.com/cubrid-lab/cubrid-client/issues/117).

## Collection columns

All three collection kinds return a plain JavaScript array in the order the
server sent it, typed by the exported `CollectionValue`. Sets and multisets are
arrays and not `Set` objects because `Set` compares `Date` and `Buffer` elements
by identity, and because a multiset needs its duplicates. Column metadata keeps
the kind, but query results do not expose it.

These results were checked on CUBRID 10.2, 11.0, 11.2 and 11.4:

| CUBRID kind | Duplicates | Order of the array | `{3,1,2,2}` returns |
| --- | --- | --- | --- |
| SET | Removed by the server | Server-defined, sorted in these checks | `[1, 2, 3]` |
| MULTISET | Kept | Server-defined, sorted in these checks | `[1, 2, 2, 3]` |
| SEQUENCE (LIST) | Kept | Stored order | `[3, 1, 2, 2]` |

Do not depend on SET or MULTISET order: CUBRID defines both as unordered.

- **Elements** use the same JavaScript types as result columns of that type,
  including `bigint` for BIGINT, decimal `string` for NUMERIC and local-time
  `Date` values ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113)).
  ENUM elements are strings, and a `SEQUENCE OF JSON` arrives as string elements.
- **Empty** collections return `[]`. A NULL column returns `null`.
- **NULL elements** return `null`. A NULL in a MULTISET sorted last in these
  checks, and repeated NULLs are not removed from a SET.
- **Empty strings and bit strings** stay distinct from NULL: `''` is `""` and
  `X''` is an empty `Buffer`.
- **Nested collections** return nested arrays, such as `[[1, 2], ["a"]]`.

Not supported:

- **Mixed-type collections are returned as `null`.** When one collection holds
  elements of different types, such as `{1,'a'}` in a bare `SET` column or
  `SELECT {1,'a',2.5}`, the CUBRID broker sends SQL NULL instead of the value, or
  a NULL element when it is nested. Those are the same bytes as a real NULL, so
  this driver cannot detect it and no error is raised. Cast the column to one
  element type to read it: `CAST(u AS SET OF VARCHAR(20))` returns `["1", "a"]`.
  Consider this before using an untyped `SET`, `MULTISET` or `SEQUENCE` column.
- **Elements without a decoder reject the query**, naming the column and CAS wire
  type. That covers OBJECT/OID and the timezone types
  ([#111](https://github.com/cubrid-lab/cubrid-client/issues/111)), and BLOB/CLOB,
  whose elements hold a server file locator rather than the content
  ([#93](https://github.com/cubrid-lab/cubrid-client/issues/93)). The connection
  stays usable afterwards.
- **Collection parameters are not implemented.** `QueryParam` has no array type;
  write collection values as SQL literals.

## Sending JavaScript parameters

The existing public `query(sql, params)` method renders values into SQL text
**client-side**. It is not a server-side prepared-statement binding API;
native opt-in binding is a separate proposal ([#85](https://github.com/cubrid-lab/cubrid-client/issues/85)).
The SQL literal escaping rules depend on the server's `no_backslash_escapes`
setting, negotiated on each physical session: a reconnect measures it again
before a string containing a backslash, CR or LF is bound on the new session.
Other parameters render the same in both modes and are sent without that probe.

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

