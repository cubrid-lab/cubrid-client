# CUBRID and JavaScript type behavior

This document describes **the current native TypeScript CAS driver implementation**,
not a guarantee that every CUBRID release and column representation has been
tested against a real database. Start with [verified support](SUPPORT_MATRIX.md).
`query<T>()` only affects TypeScript checking; it cannot validate a row or
convert a runtime value.

## Reading result columns

| CUBRID wire type(s) | Current JavaScript value | Status / limitation |
| --- | --- | --- |
| CHAR, VARCHAR/STRING, NCHAR, VARNCHAR, ENUM | `string` | Decoded as UTF-8 null-terminated text whatever the column charset. In a non-UTF-8 database (`iso88591` in the Docker images) this differs from JDBC; see [the recorded difference](LEGACY_PARITY.md#recorded-defect-text-in-a-non-utf-8-database) |
| JSON | `string` | Raw JSON text, not parsed. This driver declares CAS protocol 7, and below protocol 8 the server sends JSON columns as VARCHAR (wire type 2), so wire type 34 does not arrive. Checked on 10.2, 11.0, 11.2 and 11.4; see [JSON columns](#json-columns) |
| SHORT, INTEGER | `number` | Parsed signed 16-bit / 32-bit integers |
| BIGINT | `bigint` | Lossless signed 64-bit value; corrected by [#126](https://github.com/cubrid-lab/cubrid-client/pull/126); `JSON.stringify` needs explicit bigint conversion |
| FLOAT, DOUBLE, MONETARY | `number` | IEEE-754 conversion may round decimal values |
| NUMERIC | `string` | Decimal text retained without floating-point rounding; consumer chooses decimal library |
| DATE, TIME, TIMESTAMP, DATETIME | `Date` | Fields read in the zone set by the [`timezone`](API_REFERENCE.md#clientoptions) option: the **local Node.js process zone** by default, or UTC with `timezone: "utc"`. See [date and time values](#date-and-time-values). The zero date `0000-00-00` of DATE, DATETIME and TIMESTAMP has no `Date`, so the query rejects; see [zero dates](#zero-dates) |
| BIT, VARBIT | `Buffer` | Binary bytes; verify bit-length/bit-order semantics per server version. An empty `X''` returns an empty `Buffer`, distinct from SQL NULL |
| BLOB | `Buffer` | Complete content, loaded by the query. See [BLOB and CLOB columns](#blob-and-clob-columns) |
| CLOB | `string` | Complete content decoded as UTF-8, loaded by the query. See [BLOB and CLOB columns](#blob-and-clob-columns) |
| SET, MULTISET, SEQUENCE | Array (`CollectionValue`) | See [collection columns](#collection-columns) |
| TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ, DATETIMELTZ (29-32) | `ZonedDateTime` | Wall-clock fields and the server's zone text, never a `Date`. See [timezone-aware values](#timezone-aware-values). The zero date rejects the query |
| OBJECT/OID (19), RESULTSET (20), JSON (34), and unknown codes | Query rejects, including for a zero-byte value | Never coerced to `null`; see [values that cannot be decoded](#values-that-cannot-be-decoded) |
| SQL NULL | `null` | Sent as cell length `-1`. NULL is distinct from unsupported non-NULL values and from a valid empty string, which is `""` |

### Values that cannot be decoded

A failed decode rejects the query with a `QueryError`. Further down its `cause`
chain is an error named `UnsupportedValueError` or `MalformedReplyError`, which
[troubleshooting](TROUBLESHOOTING.md#queryerror-because-a-value-or-reply-could-not-be-decoded)
shows how to find. When one cell failed, that error names the column, the numeric
CAS wire type and the value size, for example
`Failed to decode CUBRID column "o" (wire type 19, 8 bytes)`. What happens to
the connection depends on whether the server's reply can still be trusted:

| Failure | Example | Connection afterwards |
| --- | --- | --- |
| **Unsupported value** (`UnsupportedValueError`) in a reply that is otherwise intact | An OBJECT/OID column, or a zero date | Stays open. The query handle is released, and an open transaction stays open for you to commit or roll back |
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

A zero TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ or DATETIMELTZ value (all-zero
fields with a zone, such as `TIMESTAMPTZ'0000-00-00 00:00:00 +00:00'`) rejects the
same way, with the cause `Zero date 0000-00-00 cannot be represented as a
ZonedDateTime`. OBJECT/OID decoding is not part of this contract; see the
[independent protocol fixture plan](https://github.com/cubrid-lab/cubrid-client/issues/117).

## Date and time values

DATE, TIME, TIMESTAMP and DATETIME store wall-clock fields and no zone, while a
JavaScript `Date` is an instant, so the client has to pick a zone to read the
fields in. The [`timezone`](API_REFERENCE.md#clientoptions) client option picks it:

| `timezone` | Decoded `Date` | Read the fields with |
| --- | --- | --- |
| `"local"` (default) | The fields in the Node.js process zone. The same stored value is a **different instant** under `TZ=UTC`, `TZ=Asia/Seoul` or `TZ=America/Los_Angeles` | `getFullYear()`, `getHours()`, ... |
| `"utc"` | The fields as UTC, the zone `Date` parameters are sent in: a `Date` written and read back is the same instant on every host | `getUTCFullYear()`, `getUTCHours()`, ... |

- DATE is midnight of that day; TIME is that time on 1970-01-01.
- DATETIME keeps milliseconds; TIMESTAMP and TIME have none.
- Years 1 to 99 stay as written in both modes.
- A local time that does not exist in the process zone, inside a DST gap such as
  `2026-03-08 02:30` in `America/Los_Angeles`, is moved forward by JavaScript in
  `"local"` mode; `"utc"` has no gaps and keeps every field.
- The server does not send impossible calendar fields such as February 30, and the
  zero date rejects the query in both modes (see [zero dates](#zero-dates)).
- The zone-aware types below are not affected by the option.

`"local"` stays the default in 1.x so existing code reads the same values;
`"utc"` is a candidate default for 2.0.

## Timezone-aware values

TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ and DATETIMELTZ columns return a
`ZonedDateTime`, exported by the package. It holds what the server sent: the
wall-clock fields (`year`, `month` from 1 to 12, `day`, `hour`, `minute`,
`second`, `millisecond`), the `type` it was read from and the `zone` text, so the
zone is never lost. It is **not** a `Date`: a `Date` is an instant, cannot say
which zone a value was stored in, and for a region zone the instant depends on
the zone rules of that day. Convert it yourself when you need an instant, for
example with `Date.UTC(...)` and the offset of a `+09:00` zone, or a zone-rules
library for a region.

```ts
const [row] = await db.query<{ at: ZonedDateTime }>(
  "SELECT DATETIMETZ'2020-07-02 03:04:05.999 America/New_York EDT' AS at",
);
row.at.zone; // "America/New_York EDT"
String(row.at); // "2020-07-02 03:04:05.999 America/New_York EDT"
```

These results were checked on CUBRID 10.2, 11.0, 11.2 and 11.4, which send
identical bytes. The wire value is the fields of the plain type (TIMESTAMP six
int16, DATETIME seven) followed by the zone as NUL-terminated text.

| Column | Fields | `zone` examples | Notes |
| --- | --- | --- | --- |
| TIMESTAMPTZ | seconds precision, `millisecond` is `0` | `+09:00`, `-05:30`, `America/New_York EST` | Stored fields and zone as written; a region zone gets the abbreviation of that date |
| DATETIMETZ | milliseconds | `+09:00`, `America/New_York EDT` | Range checked from `0001-01-01 00:00:00.000 +00:00` to `9999-12-31 23:59:59.999 +14:00` |
| TIMESTAMPLTZ, DATETIMELTZ | as above | `UTC UTC`, `Asia/Seoul KST` | The server converts the value to the **session** zone, so the zone is that of the connection and not the one written. `SET TIME ZONE` lasts only as long as the broker keeps the session, for example within a transaction |

- `toString()` prints the value as SQL literal text, `YYYY-MM-DD HH:MM:SS[.mmm] <zone>`
  (milliseconds for DATETIMETZ and DATETIMELTZ only). Writing that text back as
  `TIMESTAMPTZ'...'`, `DATETIMETZ'...'` and so on reads back the same fields and
  zone on all four versions. `JSON.stringify` uses the same text.
- A `ZonedDateTime` is frozen. It cannot be sent as a `query()` parameter; write
  it as a SQL literal from `toString()`. Sending one is not implemented.
- `ColumnInfo.type` is the name of the type (`TIMESTAMPTZ`, `DATETIMELTZ`, ...).
- SQL NULL is `null`. Elements of SET, MULTISET and SEQUENCE columns are
  `ZonedDateTime` values too.
- Fields that are not a real date and time (year outside 1 to 9999, a day the month does not have, with leap years checked), a zone that is empty, not valid UTF-8
  or not one NUL-terminated string, and a value that does not fill its cell reject
  as a [malformed reply](#values-that-cannot-be-decoded), also for a zero date, so a damaged zero value is never reported as merely unsupported. The server itself refuses such dates (`Invalid utime`), so this only guards a damaged reply.
- Plain DATE, TIME, TIMESTAMP and DATETIME decode to a `Date` in the zone set by
  the [`timezone`](API_REFERENCE.md#clientoptions) option, local by default; see
  [date and time values](#date-and-time-values).

## JSON columns

A JSON column returns its text as a `string`, not a parsed value: call
`JSON.parse` yourself, and keep numbers beyond double precision out of it.

The server decides this. CUBRID sends JSON as wire type 34 only to a client that
declares CAS protocol 8, and this driver declares 7 (the protocol version is part of
every reply's layout, so changing it is a separate, wider change). Below protocol 8
the server converts a JSON column to VARCHAR before sending it, so the column
reports `VARCHAR` and the value is the server's rendering of the document, for
example `{"a":1}`. Checked on 10.2, 11.0, 11.2 and 11.4 for a JSON column and for
`JSON_OBJECT()`. A wire type 34 value, should a broker send one, still rejects
the query as an unsupported value; it is never turned into `null`.

Returning parsed JSON would change what a JSON column returns from `string` to
`unknown`, so it needs a documented opt-in and a decision recorded in
[#111](https://github.com/cubrid-lab/cubrid-client/issues/111); it is not done here.

## BLOB and CLOB columns

The server does not send LOB content in a row. A cell holds the content's size and
a locator that names a file on the server. `query()` reads that file before it
returns, so a BLOB column is a complete `Buffer` and a CLOB column a complete
`string`, and there is nothing to open, keep or close. Locators never reach your
code.

| Stored value | BLOB | CLOB |
| --- | --- | --- |
| Content | `Buffer` | `string` |
| Empty (`X''`, `''`) | Empty `Buffer` | `""` |
| SQL NULL | `null` | `null` |

Those results and everything below were checked on CUBRID 10.2, 11.0, 11.2 and
11.4.

**The size limit.** All the content of one query must fit in `maxLobBytes`, 64 MiB
by default, counted across its rows and columns:

```ts
const db = createClient({ host, database, user, maxLobBytes: 512 * 1024 * 1024 });
```

A query over the limit rejects before any content is read, with an
`UnsupportedValueError` naming the column that crossed it, and the connection and
any open transaction stay usable. Raise the limit, select fewer rows, or leave the
LOB column out. The limit counts bytes, including the bytes of a multibyte CLOB.

[`stream()`](API_REFERENCE.md#streamtsql-params-options) applies the same limit to
**each row** instead. It reads a row's content when the consumer reaches that row, so
it holds one row's content at a time, and a result over the limit in total can be
read in full. A row over the limit rejects when it is reached, after the rows before
it were delivered.

**Cost.** Every non-empty LOB takes at least one request after the query, and one
per 81908 bytes, the most the server sends at once. Select LOB columns only when
you need them: `SELECT *` on such a table now transfers the content. `readTimeout`
applies to each of those requests and not to the whole read.

**Why no LOB streaming handle.** A value arrives complete even from `stream()`. A
locator does not stay readable. After a commit that
deletes or updates the row, or a rollback, the file is gone and reading it fails
with error -1020, and the protocol has no request that holds a file or releases
one. So the driver reads within the query's own turn and keeps nothing afterwards.
Concurrent statements on the connection wait for those reads. A row deleted by
another session between the `SELECT` and its read can still fail with -1020; run
the query again.

**Limitations:**

- **A LOB built by the statement needs a transaction.** `SELECT CHAR_TO_CLOB('a')`
  makes a temporary file, and in autocommit mode the server deletes it before the
  reply arrives, so the query rejects with -1020. Run it in a transaction. A LOB
  stored in a table is not affected.
- **A CLOB must be valid UTF-8.** The driver has no charset option, and the server
  stores CLOB bytes without converting them. Other bytes reject with an
  `UnsupportedValueError` rather than being silently replaced. `CLOB_TO_CHAR(c)`
  returns such a value through the ordinary text path, which substitutes U+FFFD for
  invalid bytes.
- **BLOB and CLOB collection elements** still reject the query.
- **Writing** through a LOB handle is tracked in
  [#103](https://github.com/cubrid-lab/cubrid-client/issues/103). A `Buffer` or
  `string` parameter already stores content as a SQL literal.

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
  including `bigint` for BIGINT, decimal `string` for NUMERIC, `Date` values
  decoded in the [`timezone`](#date-and-time-values) zone like columns,
  and `ZonedDateTime` for the [timezone-aware types](#timezone-aware-values).
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
  type. That covers OBJECT/OID, and BLOB/CLOB,
  whose elements hold a server file locator rather than the content, and which
  [BLOB and CLOB columns](#blob-and-clob-columns) only loads for a whole column.
  The connection stays usable afterwards.
- **Collection parameters are not implemented.** `QueryParam` has no array type;
  write collection values as SQL literals.

## Sending JavaScript parameters

The public `query(sql, params)` method renders values into SQL text
**client-side**. It is not a server-side prepared-statement binding API; that
is the opt-in [`queryPrepared()` family](#prepared-binding) below.
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

The module also defines an older internal binary encoder, `encodeBindParams()`.
Nothing uses it, and its layout is not the one EXECUTE reads: prepared binding
has its own encoder. Check [the API reference](API_REFERENCE.md) for current
method contracts.

### Prepared binding

`queryPrepared()`, `queryResultPrepared()` and `executePrepared()` send the SQL
with its `?` markers in a PREPARE request and the values as typed binds in an
EXECUTE request, so a value never becomes SQL text and no backslash probe is
needed. They are opt-in: `query()`, `queryResult()` and `execute()` keep
rendering SQL literals.

| JavaScript parameter | Bind type | Notes |
| --- | --- | --- |
| `null`, `undefined` | NULL | |
| `boolean` | INT `1` or `0` | The same value as the literal path |
| `number`, safe integer | INT, or BIGINT past 32 bits | `-0` is `0` |
| `number`, any other finite value | DOUBLE | The exact IEEE-754 value |
| `number`, `NaN` or an infinity | Refused | The broker would store it |
| `bigint` | BIGINT, or NUMERIC past 64 bits | Plain digits; more than 38 digits is refused |
| `string` | CHAR | UTF-8; NUL and Ctrl-Z are refused, as on the literal path |
| `Date` | DATETIME | **UTC components**, as on the literal path. Years outside 0001 to 9999 and an invalid `Date` are refused |
| `Buffer` | VARBIT | An empty `Buffer` is refused: the broker reads it as SQL NULL |
| Anything else | Refused | The literal path would stringify it |

A refused value rejects with a `QueryError` before anything is sent, and the
error never contains the value.

How the result differs from the literal path for the same statement:

- **Parameter count.** The number of values must equal the server's marker
  count. Extra values reject; the literal path ignores them.
- **Fractions.** The literal path sends `1.5` as a NUMERIC literal, so
  `SELECT ?` returns the string `"1.5"`; here it returns the number `1.5`. The
  value stored in a DOUBLE column is exact, where a NUMERIC literal can round
  the last digit.
- **A fraction bound to a TIME column is stored rounded to seconds.** `1.5`
  becomes `00:00:02`, where the literal path gets `-494` from the server. The
  driver cannot refuse it, because it does not know the column's type. Bind a
  `Date`, or a string, to a TIME column.
- **Integers past `Number.MAX_SAFE_INTEGER`.** `2 ** 60` stores exactly that
  value in a BIGINT column; the literal path stores its shortened decimal text
  `1152921504606847000`. In a VARCHAR column it appears as
  `1.152921504606847e+18`. Use a `bigint`.
- **Empty `Buffer`.** Refused here; the literal path sends `X''`.
- **Error codes.** A value that does not fit the column fails at EXECUTE. The
  message names the host variable and not the value, and a value that does not
  fit an ENUM column reports `-181` rather than `-494`.

An NCHAR column accepts text on neither path. Multi-statement strings run every
statement on both paths, and the markers of all the statements count together.

## Cautions

- A TypeScript row type does not prove the database returned the declared
  type; explicitly validate results that cross trust boundaries.
- The default `timezone: "local"` decoding depends on the process `TZ`; use
  `timezone: "utc"` when values must be the same instants on every host. The
  default is a 2.0 decision ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113)).
- The required live broker/version and round-trip evidence is tracked in
  [#95](https://github.com/cubrid-lab/cubrid-client/issues/95).

