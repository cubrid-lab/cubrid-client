# CUBRID and JavaScript type behavior

This document describes **the current native TypeScript CAS driver implementation**,
not a guarantee that every CUBRID release and column representation has been
tested against a real database. Start with [verified support](SUPPORT_MATRIX.md).
`query<T>()` only affects TypeScript checking; it cannot validate a row or
convert a runtime value.

## Reading result columns

| CUBRID wire type(s) | Current JavaScript value | Status / limitation |
| --- | --- | --- |
| CHAR, VARCHAR/STRING, NCHAR, VARNCHAR, ENUM | `string` | Null-terminated text. By default decoded as UTF-8 whatever the column charset; with `charset: "iso-8859-1"` in the charset the column reports. See [text and character sets](#text-and-character-sets) |
| JSON | `string` | Raw JSON text, not parsed. This driver declares CAS protocol 7, and below protocol 8 the server sends JSON columns as VARCHAR (wire type 2), so wire type 34 does not arrive. Checked on 10.2, 11.0, 11.2 and 11.4; see [JSON columns](#json-columns) |
| SHORT, INTEGER | `number` | Parsed signed 16-bit / 32-bit integers |
| BIGINT | `bigint` | Lossless signed 64-bit value; corrected by [#126](https://github.com/cubrid-lab/cubrid-client/pull/126); `JSON.stringify` needs explicit bigint conversion |
| FLOAT, DOUBLE, MONETARY | `number` | IEEE-754 conversion may round decimal values |
| NUMERIC | `string` | Decimal text retained without floating-point rounding; consumer chooses decimal library |
| DATE, TIME, TIMESTAMP, DATETIME | `Date` | Fields read in the zone set by the [`timezone`](API_REFERENCE.md#clientoptions) option: the **local Node.js process zone** by default, or UTC with `timezone: "utc"`. See [date and time values](#date-and-time-values). The zero date `0000-00-00` of DATE, DATETIME and TIMESTAMP has no `Date`, so the query rejects; see [zero dates](#zero-dates) |
| BIT, VARBIT | `Buffer` | Binary bytes; verify bit-length/bit-order semantics per server version. An empty `X''` returns an empty `Buffer`, distinct from SQL NULL |
| BLOB | `Buffer` | Complete content, loaded by the query. See [BLOB and CLOB columns](#blob-and-clob-columns) |
| CLOB | `string` | Complete content decoded as UTF-8, or as ISO-8859-1 with `charset: "iso-8859-1"`, loaded by the query. See [BLOB and CLOB columns](#blob-and-clob-columns) |
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

## Text and character sets

A CUBRID database has a charset, and so can each column: `CHARSET('x')` names the
database's. The Docker `cubrid/cubrid` images create `testdb` as `iso88591` on 10.2,
11.0, 11.2 and 11.4. The server stores the bytes a client sends and returns them as
stored, and it reports each column's charset in its result metadata (protocol 7:
the low three bits of the type byte, `3` iso88591, `5` utf8, `4` euckr). The
[`charset`](API_REFERENCE.md#clientoptions) option chooses how this client uses
them (#238):

| | `"utf-8"` (default, the 1.x behavior) | `"iso-8859-1"` |
| --- | --- | --- |
| SQL text, string parameters, `clob()` text | Sent as UTF-8 | Sent as ISO-8859-1. A character above U+00FF rejects with a `QueryError` before the statement is sent; the message gives its offset, never the text. In `clob()` it rejects with a `TypeError`: before anything is sent for a `string`, during the upload for a stream, as content that is not UTF-8 does in the default |
| CHAR, VARCHAR, NCHAR, ENUM, collection elements | Read as UTF-8, whatever the column charset. Bytes that are not UTF-8 become U+FFFD | Read in the column's charset: utf8 as UTF-8, euckr as EUC-KR (KS X 1001 pairs only, not the windows-949 extensions; needs a Node.js build with full ICU, the default), iso88591, ASCII and binary as ISO-8859-1. Bytes invalid in a utf8 or euckr column reject the query with an `UnsupportedValueError` cause |
| Column names | UTF-8 | ISO-8859-1 |
| CLOB content | UTF-8, invalid bytes rejected | ISO-8859-1 |
| Server error messages, `database`, `user`, `password` | UTF-8 | UTF-8 |

**Which to use.** On a `utf8` database, keep the default. On an `iso88591`
database:

- The default sends UTF-8 bytes, which the server stores as they are, so whatever
  this client writes reads back unchanged. But the server sees each byte as one
  Latin-1 character: `LENGTH('café')` is 5 and `HEX('café')` is `636166C3A9`.
  Text another client stored as Latin-1 is not readable: `CHR(233)` reads as
  U+FFFD. A column declared with another charset, such as `CHARSET utf8`, is
  converted by the server from the session's iso88591, so it reads back as
  mojibake (`'cafÃ©'`).
- `charset: "iso-8859-1"` makes the server and the client agree: `'café'` is
  stored as `636166E9`, `LENGTH` is 4, `CHR(233)` is `é`, and a `CHARSET utf8`
  column reads back as written. Only characters up to U+00FF can be sent. This
  is the official JDBC driver with `charset=iso-8859-1`.
- Switching an existing application to `"iso-8859-1"` changes how the text it
  already stored reads: UTF-8 bytes stored by the default read as Latin-1
  characters (`'café'` becomes `'cafÃ©'`). Choose one per database.

The official JDBC driver with its default `charset=utf-8` sends UTF-8 and reads in
the column charset, so on an `iso88591` database its own `'café'` reads back as
`'cafÃ©'`. That difference from this client's default is
[recorded as intentional](LEGACY_PARITY.md#intentional-difference-text-in-a-non-utf-8-database).

**Never use `"iso-8859-1"` against a `utf8` database.** The server reads the
Latin-1 bytes as UTF-8, and on 11.4 it stored `'é'`, sent as a literal or as a
bound string, as an empty string without an error. The client cannot tell which
charset a database has without a query of its own, so it does not check. Set the
option from `SELECT CHARSET('x')`. See
[troubleshooting](TROUBLESHOOTING.md#text-reads-as-mojibake-or-u-fffd).

## Date and time values

> **Warning: the 1.x default reads in the local zone.** A `Date` parameter is
> sent as its UTC fields, but by default (`timezone: "local"`) the fields are
> read back in the Node.js process zone, so a `Date` written and read on a host
> that is not on UTC comes back as a different instant (9 hours early under
> `TZ=Asia/Seoul`, 7 or 8 hours late under `TZ=America/Los_Angeles`). Opt in to
> UTC reads:
>
> ```ts
> const db = createClient({ host: "localhost", database: "demodb", user: "dba", timezone: "utc" });
> ```
>
> The default stays `"local"` for all of 1.x. Changing it to `"utc"` in 2.0 is
> proposed in [ADR 0010](adr/0010-utc-temporal-default-in-2-0.md).

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
- A value without a zone names wall-clock fields, not an instant. A DATE written
  from `new Date(2025, 5, 15)` under `TZ=Asia/Seoul` stores 2025-06-14, because
  local midnight there is 15:00 UTC the day before; build date-only values with
  `Date.UTC(...)`. A server session on a zone with daylight saving time stores a
  TIMESTAMP in that zone, so the two instants of a repeated hour read back as the
  same fields, and a time in a skipped hour is refused (`Invalid utime`).
- A `Date` written to a TIMESTAMPTZ, DATETIMETZ or `*LTZ` column gets the
  **session** zone attached to its UTC fields, so it is the same instant only
  while the session zone is UTC. The session starts in the server's zone (the
  `timezone` server parameter, by default the zone of the server host). Write an
  explicit literal such as `DATETIMETZ'2025-06-14 23:30:45.678 +00:00'` otherwise.

`"local"` stays the default in 1.x so existing code reads the same values;
`"utc"` is proposed as the 2.0 default in
[ADR 0010](adr/0010-utc-temporal-default-in-2-0.md).

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
It is separate from [`maxReplyBytes`](CONNECTION.md#reply-size-limit), which
bounds one reply from the server: LOB content arrives in replies of 128 KiB, so
`maxReplyBytes` never limits it.

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
- **A CLOB must be valid UTF-8** in the default `charset`. The server stores CLOB
  bytes without converting them. Other bytes reject with an
  `UnsupportedValueError` rather than being silently replaced. With
  `charset: "iso-8859-1"` a CLOB is read as ISO-8859-1, where every byte is a
  character, so nothing is refused. `CLOB_TO_CHAR(c)`
  returns such a value through the ordinary text path, which substitutes U+FFFD for
  invalid bytes.
- **BLOB and CLOB collection elements** still reject the query.
- **Writing** large content goes through [`blob()` and `clob()`](#writing-blob-and-clob).
  A `Buffer` or `string` parameter also stores content, as a SQL literal or a
  VARBIT or CHAR bind that the whole statement carries.

## Writing BLOB and CLOB

`blob(source)` and `clob(source)` wrap content for the prepared methods. The
driver creates the LOB on the server with LOB_NEW, writes it with LOB_WRITE in
pieces of 128 KiB, and binds the resulting handle in EXECUTE, as the JDBC driver's
`Blob` and `Clob` do. Writes were checked on CUBRID 10.2, 11.0, 11.2 and 11.4.

```ts
import { createReadStream } from "node:fs";
import { blob, clob } from "cubrid-client";

await db.executePrepared("INSERT INTO docs (id, body, notes) VALUES (?, ?, ?)", [
  1,
  blob(createReadStream("report.pdf")),
  clob("Résumé 😀"),
]);
```

| Source | `blob()` | `clob()` |
| --- | --- | --- |
| `Buffer` | The bytes | UTF-8 bytes, checked (with `charset: "iso-8859-1"`: the bytes) |
| `Uint8Array` | The bytes | Refused |
| `string` | Refused | Encoded as UTF-8 (with `charset: "iso-8859-1"`: as ISO-8859-1) |
| `AsyncIterable` or `Readable` | Chunks of `Buffer` or `Uint8Array` | Chunks of `string`, `Buffer` or `Uint8Array`, mixed as you like |
| Empty | An empty BLOB, not NULL | An empty CLOB, not NULL |

**Encoding.** A CLOB is UTF-8 in the default `charset`, and the server stores the
bytes without converting them, which is also what
[reading a CLOB](#blob-and-clob-columns) expects. With `charset: "iso-8859-1"` it
is ISO-8859-1 instead: a `string` holding a character above U+00FF rejects the
statement with a `TypeError`, and bytes are sent as they are. The rest of this
paragraph describes the default. Strings are encoded about 128 KiB
at a time. A high surrogate at the end of one stream chunk is joined with the low
surrogate that starts the next, so splitting text anywhere is safe. A lone
surrogate, `Buffer` bytes that are not UTF-8, or a stream that ends inside a
character reject the statement with a `TypeError`. That can only be found while
reading a stream, so part of the CLOB may already have been written; it is
discarded with the statement as described below.

**Memory.** A stream source is read with `for await`, and the next chunk is asked
for only after the server has answered the previous LOB_WRITE, so a slow server
slows the source down instead of filling memory. Chunks are merged or sliced into
LOB_WRITEs of exactly 128 KiB, except the last. Apart from the source's own
buffers, the driver holds about one chunk at a time. A `Buffer` or `string`
source is already in memory; the driver does not copy it whole.

**Cost.** A LOB takes one LOB_NEW and one LOB_WRITE per 128 KiB, each a round trip
before the statement's EXECUTE, so an 8 MiB BLOB adds 65 requests. A statement with
several LOBs uploads them one after the other, in parameter order.

**Transactions and failure.** The upload starts after PREPARE, so SQL the server
refuses fails before anything is uploaded. The LOB belongs to the statement's
transaction:

- In autocommit mode the statement and its LOBs are committed together after
  EXECUTE, or rolled back together when anything fails: a LOB_WRITE error, a short
  write, a source that throws, or EXECUTE itself, such as a unique violation.
- Inside `transaction()` or a transaction scope a failed upload fails only that
  statement and the transaction stays yours: commit or roll back as after any
  failed statement. `scope.rollback()` discards the LOBs with the rows.
- An abort or a `readTimeout` while a LOB_WRITE is in flight discards the
  connection, as for any statement. `signal` also stops a wait on a stream source
  that yields nothing, and since the LOB_NEW was already sent, the connection is
  discarded then too.

Each statement creates its own LOBs; a handle is never reused, and none reaches
your code.

**Stream sources are read once.** An `AsyncIterable` or `Readable` is marked as
consumed when its upload starts. Passing it again after that, or twice in one
statement, rejects with a `TypeError` before anything is sent. Two statements
given the same stream before either has started are both accepted; the second
rejects with a `TypeError` once it is prepared, and is rolled back in autocommit
mode. A statement that fails before the upload starts, such as on a syntax error,
leaves the stream unread. A failed upload destroys the `Readable` whose upload
failed; the sources of later LOB parameters stay unread.

**A source must not wait on the same connection.** The upload holds the
connection's turn, so a source that awaits a statement of the same client or
transaction waits forever, and so does that statement. `readTimeout` does not
limit the source, only each reply; pass a `signal` to bound a source that may stall.

**Not supported:**

- `query()`, `queryResult()`, `execute()` and `stream()` render SQL literals and
  reject a `blob()` or `clob()` value with a `TypeError` before anything is sent.
- `executeMany()` rejects one too: a batch with LOBs is not implemented.
- There is no LOB object to create or append to separately (`createLob()`), and no
  write-side size limit: `maxLobBytes` only limits reads, so a CLOB larger than it
  can be written but not read back without raising the limit.

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
before a string containing a backslash, CR or LF is bound on the new session, and
so does any statement whose text mentions `SYSTEM` and `PARAMETERS`, since
`SET SYSTEM PARAMETERS 'no_backslash_escapes=...'` changes the mode for the
session. The values are read once, when the method is called.
Other parameters render the same in both modes and are sent without that probe.

| JavaScript parameter | Current SQL literal behavior |
| --- | --- |
| `string` | Quoted, server-mode-aware escaped string; embedded NUL/Ctrl-Z rejected |
| `number` | Decimal text representation; floating-point/large integer precision is subject to JavaScript `number`. A negative value is parenthesized, `(-1)`. `NaN` and the infinities are refused |
| `bigint` | Decimal integer text, preserving JavaScript bigint precision. A negative value is parenthesized, `(-1)` |
| `boolean` | `1` or `0` |
| `Date` | `DATETIME'YYYY-MM-DD HH:MM:SS.mmm'` using **UTC components**; it has no timezone offset embedded. An invalid `Date` is refused |
| `Buffer` | Hexadecimal binary literal `X'...'`. For BLOB or CLOB content use [`blob()` or `clob()`](#writing-blob-and-clob) with a prepared method |
| `null`, `undefined` | SQL `NULL` |
| `blob()`, `clob()` | Refused with a `TypeError`: use a prepared method |
| Anything else | Refused: an object, array, function or symbol is never converted with `String()` |

The values replace the `?` markers that CUBRID's lexer would read as code, as
measured on 10.2 and 11.4 brokers. A `?` is not a marker inside a `'...'` string,
a `"..."` span (an identifier with `ansi_quotes=yes`, the default, or a string),
a `` `...` `` identifier (a doubled backtick is a backtick), a `[...]` identifier (which ends
at the first `]`; `]]` is not an escape), a `/* */` comment (not nested; an
unterminated one runs to the end), or a `--` or `//` comment, which ends at CR or
LF. `#` is not a comment. Quotes are escaped by doubling them, and a backslash
escapes the next character only in strings and only with
`no_backslash_escapes=no`. The number of values must equal the number of markers:
too few or too many reject with a `QueryError` before anything is sent. When a
backslash in the SQL makes the markers depend on the backslash mode, the session
is probed first, and the count is checked before the statement is sent. In escape
mode a `"..."` span holding a backslash is refused when `ansi_quotes`, which the
client cannot see, would move a marker. A call without `params` sends the SQL as
written.

The broker itself counts a `?` inside a quoted identifier as a host variable, so a
statement with an identifier such as `[a?]` fails with `-1007` on either path.

A negative number is parenthesized because the SQL text can put a minus sign
before the marker: `b-?` with `-1` would otherwise read `b--1`, and `--` starts a
comment that hides the rest of the line, a `WHERE` clause included. A refused
value rejects with a `QueryError` before anything is sent, and the error names
only the value's type.

The module also defines an older internal binary encoder, `encodeBindParams()`.
Nothing uses it, and its layout is not the one EXECUTE reads: prepared binding
has its own encoder. It refuses values outside `QueryParam` too. Check [the API reference](API_REFERENCE.md) for current
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
| `string` | CHAR | UTF-8, or ISO-8859-1 with `charset: "iso-8859-1"`; NUL and Ctrl-Z are refused, as on the literal path |
| `Date` | DATETIME | **UTC components**, as on the literal path. Years outside 0001 to 9999 and an invalid `Date` are refused |
| `Buffer` | VARBIT | An empty `Buffer` is refused: the broker reads it as SQL NULL |
| `blob()`, `clob()` | BLOB, CLOB handle | Uploaded first. See [writing BLOB and CLOB](#writing-blob-and-clob) |
| Anything else | Refused | As on the literal path |

A refused value rejects with a `QueryError` before anything is sent, and the
error never contains the value.

How the result differs from the literal path for the same statement:

- **Parameter count.** The number of values must equal the server's marker
  count, as on the literal path, which counts the markers itself.
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

`executeMany()` binds every parameter set with these same rules, and refuses the
whole call, before anything is sent, when one value of any set is refused. Every
set must have the statement's marker count. It differs in one way: it runs a
single statement, because the server's EXECUTE_ARRAY runs only the first
statement of a multi-statement string, so such SQL text is refused.

## Cautions

- A TypeScript row type does not prove the database returned the declared
  type; explicitly validate results that cross trust boundaries.
- The default `timezone: "local"` decoding depends on the process `TZ`; use
  `timezone: "utc"` when values must be the same instants on every host. The
  default is a 2.0 decision ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113)).
- The required live broker/version and round-trip evidence is tracked in
  [#95](https://github.com/cubrid-lab/cubrid-client/issues/95).

