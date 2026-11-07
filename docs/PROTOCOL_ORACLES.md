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
after an autocommit statement because the commit clears the value; after a
multi-row INSERT it is the first generated id; and after an INSERT into a table
without AUTO_INCREMENT it still holds an earlier INSERT's value. The INSERT reply is the same bytes for a table with and without AUTO_INCREMENT, and two fresh AUTO_INCREMENT tables both answer `1` in one transaction, so the wire holds no signal that a statement generated the value; a commit or a rollback clears it (CUBRID 10.2 and 11.4).

## Separate numeric domains

| Domain | Named constant | Literal decimal / hex |
| --- | --- | --- |
| CCI column | SET / MULTISET / SEQUENCE | 16 / 17 / 18 |
| CCI column | OBJECT / RESULTSET / BIGINT | 19 / 20 / 21 (0x15) |
| CCI column | BLOB / CLOB / JSON | 23 / 24 / 34 |
| SQL statement | CREATE_CLASS / INSERT / SELECT | 4 / 20 / 21 |
| SQL statement | UPDATE / DELETE / CALL / CALL_SP | 22 / 23 / 24 / 126 (0x7e) |
| CAS function | CLOSE_REQ_HANDLE / FETCH | 6 / 8 |
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
