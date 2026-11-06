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
the actual 23 integration cases per server separately.

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
are 35–37, **not** column type identifiers or support for full BLOB/CLOB
materialization. Older protocol v2 has a special legacy function-code
mapping; the fixtures use modern protocol expectations.

## Required regression checks

`tests/protocol-oracles.test.ts` uses literal constants and packet bytes
rather than importing the implementation enum as an oracle. It checks:

- The CCI type, SQL statement and CAS function IDs separately.
- Positive and negative 64-bit BIGINT decode from fixed wire bytes.
- BIGINT parameter encoding (`0000000915000000000000002a` for 42n).
- Distinguishing real SQL NULL, empty strings and unsupported non-NULL types.
- Malformed/truncated packets and the negative FETCH error envelope.

A one-line mutation of `BIGINT = 21` to `26` must fail its literal
expectations, instead of producing false-positive tests that use
`CUBRIDDataType.BIGINT` on both sides of an assertion.

The protocol test runs in the standard required Node.js CI and is
independent of a database connection. Separate [live CUBRID
validation](SUPPORT_MATRIX.md) exercises the current integration suite on
actual server images; it does not guarantee that every SQL type and
statement has been proven. Unsupported collection/JSON decoding, LOB
materialization, and full parity testing remain tracked in
[#82](https://github.com/cubrid-lab/cubrid-client/issues/82),
[#111](https://github.com/cubrid-lab/cubrid-client/issues/111),
[#93](https://github.com/cubrid-lab/cubrid-client/issues/93), and
[#118](https://github.com/cubrid-lab/cubrid-client/issues/118).
