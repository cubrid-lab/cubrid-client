# Native TypeScript and original Node.js CUBRID driver parity

Reference date: 2026-11-07. This is a **behavior-level audit**, not a
requirement to reproduce the original callback/event API or infer full
production compatibility from a small successful fixture.

## Reference and reproducibility

- Native: this repository's `src/` and
  [TypeScript type mapping](TYPES.md).
- Original: [CUBRID/node-cubrid pinned to
  `89733f0a9a8f3d9796f65b46a1f4694fed683340`](https://github.com/CUBRID/node-cubrid/tree/89733f0a9a8f3d9796f65b46a1f4694fed683340)
  (historical library; its `queryAllAsObjects` result shape is adapted to
  native `query`'s array-of-objects shape for comparisons).
- Wire authority: [pinned official CUBRID CAS sources](PROTOCOL_ORACLES.md),
  **not** either driver implementation.
- Run: `npm ci`; provision a CUBRID broker with `CUBRID_DB=testdb` on
  `127.0.0.1:33000`; clone the pinned original into
  `legacy-node-cubrid`; install *its runtime dependencies only* with
  `npm install --prefix legacy-node-cubrid --omit=dev --ignore-scripts`;
  then run
  `CUBRID_LIVE_REQUIRED=1 NODE_CUBRID_ENTRY="$PWD/legacy-node-cubrid/index.js" node --import tsx --test tests/legacy-parity.test.ts`.
  The [live integration workflow](../.github/workflows/live-cubrid.yml)
  automates this per version and rejects absent/failed parity tests.

## Behavior inventory

| Capability | Original node-cubrid | Native TypeScript client | Classification / follow-up |
| --- | --- | --- | --- |
| Broker connection + native CAS SQL SELECT | Implemented | Implemented | Compare actual values on the same live broker |
| SQL INSERT/UPDATE/DELETE | `execute`, batch functionality | `query` DML currently resolves to empty row array | DML side effects comparable; richer result metadata planned [#84](https://github.com/cubrid-lab/cubrid-client/issues/84) |
| Row objects | `queryAllAsObjects()` | `query<T>()` | Different public API is intentional; normalize only values, not callback shapes |
| One-connection query ordering | Internal queue | CAS send/receive FIFO serialization | Statements run one complete lifecycle at a time; verified against CUBRID 10.2 to 11.4 in [#114](https://github.com/cubrid-lab/cubrid-client/issues/114), see [CONNECTION.md](CONNECTION.md#concurrent-statements-on-one-connection) |
| BIGINT | CCI wire ID 21 in source; returned JS representation needs comparison | `bigint`, ID 21 | Independent ID fixture added; live value precision and mapping [#81](https://github.com/cubrid-lab/cubrid-client/issues/81) |
| NUMERIC, time/date | Original decoder behavior per version | NUMERIC string, Date decoded in process local timezone | Conversion differences may be intentional or unstable [#113](https://github.com/cubrid-lab/cubrid-client/issues/113) |
| SET, MULTISET, SEQUENCE | Historical implementation may have type/version limits | Arrays, checked on live 10.2, 11.0, 11.2 and 11.4 ([collection columns](TYPES.md#collection-columns)) | Not compared with the original driver [#118](https://github.com/cubrid-lab/cubrid-client/issues/118) |
| JSON | Historical implementation may have type/version limits | Raw text as `string`, because the server sends JSON as VARCHAR below protocol 8 | Parsed values are not advertised [#111](https://github.com/cubrid-lab/cubrid-client/issues/111) |
| BLOB/CLOB | Explicit LOB packets in original | No verified full LOB read/write API | Feature gap, not a promise of parity [#93](https://github.com/cubrid-lab/cubrid-client/issues/93), [#103](https://github.com/cubrid-lab/cubrid-client/issues/103) |
| Native bind/prepared SQL | `executeWithTypedParams` | Client-side SQL interpolation for `query(sql, params)` | Deliberate different behavior, opt-in native binding tracked [#85](https://github.com/cubrid-lab/cubrid-client/issues/85) |
| Multiple hosts / connection retries | Uses host fallback and retry counter | `maxConnectionRetryCount` accepted but not effective | **Known functional gap** [#83](https://github.com/cubrid-lab/cubrid-client/issues/83) |
| Logger | Uses injected logger for query/protocol events | `logger` receives redacted structured events for connections, queries and transactions; no SQL, parameters, rows or credentials; no protocol-level events | Implemented with a different, redacted contract [#100](https://github.com/cubrid-lab/cubrid-client/issues/100) |
| TLS with verified certificate | Not a documented common feature in historical native API | Implemented; live SSL=ON 11.4 CA/hostname checks | Native-specific, not a legacy parity requirement |
| DML metadata, errors | Richer result packets and error structures | No affected-row return from `query`; error mapping differs | Explicit TypeScript API design backlog [#84](https://github.com/cubrid-lab/cubrid-client/issues/84), [#89](https://github.com/cubrid-lab/cubrid-client/issues/89) |
| Large results / streaming | Query handles and `fetch` | Internal fetch with automatic handle cleanup | Compare complete result content and lifecycle; public streaming planned [#87](https://github.com/cubrid-lab/cubrid-client/issues/87) |

## Live comparative acceptance

The pinned adapter must execute **the same inserted rows and selected SQL**
against the **same** CUBRID broker and version. The automated fixture checks
integer/string/NULL values, native and legacy DML side effects, SQL errors,
and a successful query after a rejected query.

This is a starting scope, **not** proof of every item in the matrix. In
particular, cross-driver date, 64-bit integer precision, large FETCH, LOB
and version-specific JSON semantics and cross-driver collection results need separately reviewed
fixtures before full production readiness. Do not label absent fixtures
"passing". See [#118](https://github.com/cubrid-lab/cubrid-client/issues/118)
and [release validation gate](https://github.com/cubrid-lab/cubrid-client/issues/120).

The original library is **only a comparison oracle**, not a new production
dependency of the published `cubrid-client` npm package. The legacy source
and its runtime dependency install are isolated to CI.
