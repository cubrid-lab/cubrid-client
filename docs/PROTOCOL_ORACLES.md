# Independently sourced CUBRID wire protocol fixtures

These fixture values are not generated from the TypeScript driver, its
`CUBRIDDataType` enum or an internal packet builder. They were transcribed
from these **pinned upstream CUBRID source files**, cross-checked against the
historical CUBRID Node.js driver:

- [CCI column type domain, `broker_cas_cci.h`](https://github.com/CUBRID/cubrid/blob/2d928e34b11069b8087e0bef6d28184827c3d94a/src/broker/broker_cas_cci.h)
- [CAS function code domain, `cas_protocol.h`](https://github.com/CUBRID/cubrid/blob/2d928e34b11069b8087e0bef6d28184827c3d94a/src/broker/cas_protocol.h)
- [SQL statement code domain, `dbtype_def.h`](https://github.com/CUBRID/cubrid/blob/2d928e34b11069b8087e0bef6d28184827c3d94a/src/compat/dbtype_def.h)
- [Historical Node.js CAS definitions](https://github.com/CUBRID/node-cubrid/blob/develop/src/constants/CASConstants.js), secondary cross-check only

The pinned commit above is an independent reference for numeric constants;
it is **not** evidence of complete CUBRID 10.2–11.4 behavioral compatibility
for JSON, LOB, collections or protocol extensions. The live matrix validates
the actual integration cases per server separately.

[`tests/fixtures/collection-frames.ts`](../tests/fixtures/collection-frames.ts)
is a second, separate oracle: complete replies captured from live 10.2, 11.0,
11.2 and 11.4 brokers with a raw socket client, stored as hexadecimal literals.
The offline tests replace single fields in those frames to build the malformed
cases.

[`tests/fixtures/dml-frames.ts`](../tests/fixtures/dml-frames.ts) holds the
replies to INSERT, UPDATE, DELETE, DDL and a two-statement string, and to
GET_LAST_INSERT_ID (function code 40), captured the same way. Facts they pin
down: the per-statement row count is in the execute result list (one entry per
statement of a multi-statement string); GET_LAST_INSERT_ID answers size `-1`
on a session that has generated nothing; after a multi-row INSERT it is the first
generated id; and after an INSERT into a table without AUTO_INCREMENT it still
holds an earlier INSERT's value. The INSERT reply is the same bytes for a table
with and without AUTO_INCREMENT, and two fresh AUTO_INCREMENT tables both answer
`1`, so the wire holds no signal that a statement generated the value. The value
belongs to the session: a commit, a rollback, the autocommit flag and a failed
statement all leave it in place, and only a new session starts without one.

CAS_INFO status, measured on the wire on CUBRID 10.2, 11.0, 11.2 and 11.4 and
pinned by the fake CAS in `tests/concurrent-lifecycle.test.ts`:

| Reply to | `CAS_INFO[0]` |
| --- | --- |
| OPEN_DATABASE | 1 |
| A statement with the autocommit flag, and CLOSE_REQ_HANDLE after it | 0 |
| An autocommit SELECT with rows left to fetch | 1 |
| CLOSE_REQ_HANDLE of that SELECT before its last row | 1 |
| A statement without the flag, failed or not, including after `-72` | 1 |
| END_TRAN | 0 |
| CHECK_CAS | 1, even on an idle session |
| SET_DB_PARAMETER and GET_DB_PARAMETER outside a statement's transaction | 0, even straight after OPEN_DATABASE |

Status 0 therefore means the last transaction ended, not that the CAS has gone.
That is the state in which a CAS closes its socket on purpose, and CHECK_CAS holds
it until the next statement ends, which is what makes the client's check before a
request safe. For the same reason the `isolationLevel` and `lockTimeout` setup of a
new session ends with CHECK_CAS.

SET_DB_PARAMETER (function code 5), measured on the same four versions: the request
is the code byte, then the parameter and the value as length-prefixed int32s, and a
reply of int32 0 means applied.

| Parameter | Values accepted | Notes |
| --- | --- | --- |
| 1, isolation level | 4, 5 and 6 | Anything else fails with `-1157`. SQL `SET TRANSACTION ISOLATION LEVEL` refuses the same levels with `-495`, or `-493` for read uncommitted |
| 2, lock timeout | Milliseconds | `0` does not wait. Every negative value is stored as `-1`, no limit. SQL `GET TRANSACTION LOCK TIMEOUT` reports seconds |
| 4, autocommit | Any | Accepted and ignored: the statement's own flag still decides. GET_DB_PARAMETER for it fails with `-1011` |

Both settings belong to the session. COMMIT, ROLLBACK, failed statements and
autocommit statements keep them; a change inside a transaction applies to that
transaction at once. A new session, including one on the same CAS after the previous
client closed or was cut off, starts from the server defaults (4 and `-1` on a stock
server). The reply to the database server restart case was `-111` and then `-224`
inside a transaction, after which the CAS closed its socket, so no session lost its
settings without the client opening a new one.

An autocommit SELECT closed before its last row therefore stays in a transaction:
it keeps its table lock and its CAS, and a second session's `ALTER TABLE` waits,
until the next statement or an END_TRAN. So `stream()` sends END_TRAN when it stops
early in autocommit mode, and `query()` sends it when a FETCH fails before the last
row; after a malformed reply the session is dropped instead. An END_TRAN between two FETCHes closes the cursor, and the
next FETCH fails with `-1012`, which is why a stream that read LOB content sends it
once, after the cursor is finished, and never between rows. LOB_READ itself leaves
the cursor and the status alone.

FETCH replies, measured the same way and pinned by the `stream()` tests in
`tests/integration.test.ts`: the server **ignores the requested fetch size**. The
reply to a FETCH of 1 row and of 5000 rows was the same 16 KiB (819 INT rows, or 131
rows of about 110 bytes), and a 100 KB row came back alone. The rows inlined in the
execute reply follow the same limit. So one reply is the unit of buffering for
`stream()`, and the `fetchSize` option is sent but has no effect on these servers.

## Separate numeric domains

| Domain | Named constant | Literal decimal / hex |
| --- | --- | --- |
| CCI column | SET / MULTISET / SEQUENCE | 16 / 17 / 18 |
| CCI column | OBJECT / RESULTSET / BIGINT | 19 / 20 / 21 (0x15) |
| CCI column | BLOB / CLOB / JSON | 23 / 24 / 34 |
| SQL statement | CREATE_CLASS / INSERT / SELECT | 4 / 20 / 21 |
| SQL statement | UPDATE / DELETE / CALL / CALL_SP | 22 / 23 / 24 / 126 (0x7e) |
| CAS function | CLOSE_REQ_HANDLE / FETCH | 6 / 8 |
| CAS function | EXECUTE_BATCH (SQL texts) / EXECUTE_ARRAY (one handle, many bind sets) | 20 / 21 |
| CAS function | GET_GENERATED_KEYS / LOB_NEW / LOB_WRITE / LOB_READ | 34 / 35 / 36 / 37 |
| CAS function | GET_LAST_INSERT_ID / PREPARE_AND_EXECUTE (modern) | 40 / 41 |

**Do not conflate a CCI type byte with a CAS function code.** The value 34
is `CCI_U_TYPE_JSON` in the column-type domain and
`CAS_FC_GET_GENERATED_KEYS` in the function-code domain. LOB API functions
are 35–37, **not** column type identifiers. Older protocol v2 has a special legacy function-code
mapping; the fixtures use modern protocol expectations.

## LOB wire format

These facts were measured with a raw socket client, not with this driver's
decoder, on the cubrid/cubrid 10.2, 11.0, 11.2 and 11.4 images with protocol
version 7. All four behaved the same, and `tests/fixtures/lob-frames.ts` holds the
captured bytes.

- **A cell** is `[db_type: int32][size: int64][locator length: int32][locator]`,
  not the content. `db_type` is 33 for BLOB and 34 for CLOB, unlike the column
  types 23 and 24. The locator ends in a NUL counted in its length. An empty LOB
  has size 0 and a locator; SQL NULL is the usual cell length -1.
- **The locator text differs by version.** 10.2 to 11.2 send an absolute path,
  `file:/var/lib/cubrid/testdb/lob/ces_429/...`. 11.4 sends one relative to the
  LOB directory, `file:ces_429/...`. 11.2 and 11.4 prefix the table with `dba.`.
  The driver treats it as opaque bytes.
- **LOB_READ** (function 37) sends the whole cell with an int32 length, then an
  int64 offset and an int32 length, each with its length prefix. The reply is an
  int32 count and that many bytes; error replies use the usual `-2`, code and
  message.
- **One reply holds at most 81908 bytes** whatever was asked for, and reports the
  shorter count. At or past the end of the file the count is 0 and the reply is
  only those four bytes.
- **Never send length 0.** It answers error -185, and every later request on that
  session then fails with "Server no longer responding", until it is replaced.
- **LOB_READ opens a transaction.** On a session whose last reply had
  `CAS_INFO[0]` 0, the reply has 1, so an autocommit session stays reserved until
  it is ended. The driver sends END_TRAN after reading.
- **A locator is not bound to its session.** Any session can read a committed
  file, also after the session that received the locator has closed. That is not
  a guarantee to rely on: after a commit that deletes or updates the row, or a
  rollback, the read fails with -1020, and a LOB built by a statement is already
  gone when an autocommit reply arrives.

## EXECUTE_ARRAY wire format

`executeMany()` uses function 21, `CAS_FC_EXECUTE_ARRAY` in CUBRID's
`src/broker/cas_protocol.h` (`fn_execute_array` in `cas_function.c`,
`ux_execute_array` in `cas_execute.c`), which JDBC names
`EXECUTE_BATCH_PREPAREDSTATEMENT` and sends from `UStatement.executeBatch()`.
Function 20, `EXECUTE_BATCH`, carries several SQL texts instead and is not used.
These facts come from those sources on the 10.2, 11.4 and develop branches and
were confirmed with a raw socket client on the cubrid/cubrid 10.2 and 11.4 images
with protocol version 7; `tests/fixtures/dml-frames.ts` holds the captured bytes.

- **The request** is the prepared handle, the query timeout (protocol 4 and
  later), the autocommit byte, then one (type, value) argument pair per marker
  per set, in set order: the pairs an EXECUTE request sends. The CAS divides the
  values into sets by the handle's marker count and ignores a remainder, so a set
  with an extra value runs and the extra value is dropped without an error.
- **The reply** is result code 0, the number of sets run, then per set either
  its affected-row count and an 8-byte OID, or the indicator `-2`, the error
  code and a length-prefixed message; the shard id (protocol 5 and later) last.
- **A failed set does not stop the request.** The CAS undoes that set only and
  runs the rest. With autocommit 1 it commits or rolls back after each set, which
  is why the driver always sends 0 and ends the transaction itself. It stops
  early only after ER_INTERRUPTED (`-4`), which it reports, and it fails the whole
  request instead after a deadlock (`-72`) or a server crash with autocommit 0.
- **A multi-statement string runs only its first statement** and reports one
  set as successful; the later statements never run. A statement without a
  marker runs nothing and reports zero sets. A SELECT runs and reports counts.
  The driver refuses all three.

## Collection wire format

The four brokers sent the same layout, with protocol version 7:

- **Column metadata** is two bytes. The first holds `0x80`, the collection kind in
  bits `0x60` (SET `0x20`, MULTISET `0x40`, SEQUENCE `0x60`) and the charset in its
  low bits. The second is the element type: `a0 08` is SET OF INT and `c3 02` is
  MULTISET OF VARCHAR. A collection without one domain has element type `00`.
- **A cell** is `[element type: 1 byte][count: int32]` followed by
  `[length: int32][payload]` for each element. `08 00000001 00000004 00000007` is
  `{7}`. An empty collection is `00 00000000`. The cell's element type decides
  over the metadata; it is `00` when every element is NULL.
- **A NULL element** has length `-1` and no payload. Only BIT and VARBIT use
  length `0`, for an empty value; an empty string has length `1`, its NUL.
- **A nested collection** is an element whose payload is a complete cell.
- **A mixed-type collection** is sent as a NULL cell, or a NULL element when
  nested, the same bytes as a genuine NULL.

## NULL and zero-byte cells

- **SQL NULL** is cell length `-1` with no bytes
  ([`dbval_to_net_buf`, `cas_execute.c` on `release/11.4` at `1df4af4`](https://github.com/CUBRID/cubrid/blob/1df4af4bca6416f2e5a7388ed066fb5b4ac651fe/src/broker/cas_execute.c#L5015-L5019)).
- **Length `0`** comes only from `add_res_data_bytes`, which only BIT and VARBIT
  use. `add_res_data_string` counts the NUL, so an empty string has length `1`.
  The captured `emptyBitValue` frame shows this: `SELECT X''` has a size-0 cell.
- **The default case of `dbval_to_net_buf`** writes `-1` for a type the CAS cannot
  encode, so a client cannot detect that NULL.
- **JSON** is sent as wire type `2` below protocol 8. This driver declares
  protocol 7, so all four brokers described it as `85 02` in column metadata.
  A probe that declared protocol 8 on 11.4 received wire type `34` with the same
  text and NUL (`7b2261223a317d00`), but the driver does not declare 8, so that
  layout has no decoder and is not exercised (#111).
- **TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ and DATETIMELTZ** are wire types `29`
  to `32`: the fields of TIMESTAMP (six int16) or DATETIME (seven int16), then the
  zone as NUL-terminated text (`+09:00`, `America/New_York EDT`, `UTC UTC`). The
  zero date is all-zero fields with a zone. Captured in `tests/fixtures/zoned-frames.ts`.

## Required regression checks

`tests/protocol-oracles.test.ts` uses literal constants and packet bytes
rather than importing the implementation enum as an oracle. It checks:

- The CCI type, SQL statement and CAS function IDs separately.
- Positive and negative 64-bit BIGINT decode from fixed wire bytes.
- BIGINT parameter encoding (`0000000915000000000000002a` for 42n).
- Distinguishing real SQL NULL, empty strings and unsupported non-NULL types,
  with the captured `oidValue` reply, and rejecting a zero-byte value
  of any type except BIT and VARBIT.
- Captured TIMESTAMPTZ, TIMESTAMPLTZ, DATETIMETZ and DATETIMELTZ replies (offset
  and region zones, year 1 and 9999, session zones, NULL, collections) decode to
  their fields and zone text; the zero values reject as unsupported; every
  layout violation (no zone, no NUL, out-of-range fields, bad UTF-8) is malformed.
- The captured zero DATE, DATETIME and TIMESTAMP replies (all-zero fields, wire
  types 13, 22 and 15 with sizes 6, 14 and 12, identical on 10.2, 11.0, 11.2 and
  11.4) reject as unsupported instead of decoding to an 1899 `Date`. A zero date
  element of a captured `SEQUENCE OF DATE` (10.2 and 11.4) takes the deferred
  collection path: unsupported, unless the reply is also structurally damaged.
- An unsupported value keeps the session only when the whole reply holds
  together; any structural failure is reported as malformed, which drops it.
- Malformed/truncated packets and the negative FETCH error envelope.
- SET, MULTISET and SEQUENCE decode from captured replies, including empty,
  NULL, repeated, nested and unsupported elements, and each malformed length
  rejects for its stated reason.
- BLOB and CLOB cells, LOB_READ requests and replies match captured bytes, and
  each malformed cell or reply is rejected.

A one-line mutation of `BIGINT = 21` to `26` must fail its literal
expectations, instead of producing false-positive tests that use
`CUBRIDDataType.BIGINT` on both sides of an assertion.

The protocol test runs in the standard required Node.js CI and is
independent of a database connection. Separate [live CUBRID
validation](SUPPORT_MATRIX.md) exercises the current integration suite on
actual server images; it does not guarantee that every SQL type and
statement has been proven. Parsed JSON, which needs protocol 8, is tracked in
[#111](https://github.com/cubrid-lab/cubrid-client/issues/111); full parity testing remains tracked in
[#118](https://github.com/cubrid-lab/cubrid-client/issues/118).
