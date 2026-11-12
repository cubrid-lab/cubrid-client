# Native TypeScript and original Node.js CUBRID driver parity

Reference date: 2026-11-07; the [official JDBC comparison](#official-jdbc-comparison)
was added on 2026-11-12. This is a **behavior-level audit**, not a
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
| NUMERIC, time/date | Original decoder behavior per version | NUMERIC string, Date decoded in process local timezone by default, or UTC with `timezone: "utc"` | Conversion differences may be intentional or unstable [#113](https://github.com/cubrid-lab/cubrid-client/issues/113) |
| SET, MULTISET, SEQUENCE | Historical implementation may have type/version limits | Arrays, checked on live 10.2, 11.0, 11.2 and 11.4 ([collection columns](TYPES.md#collection-columns)) | Not compared with the original driver; same elements and order as [official JDBC](#official-jdbc-comparison) on 10.2 to 11.4 |
| JSON | Historical implementation may have type/version limits | Raw text as `string`, because the server sends JSON as VARCHAR below protocol 8 | Parsed values are not advertised [#111](https://github.com/cubrid-lab/cubrid-client/issues/111) |
| BLOB/CLOB | Explicit LOB packets in original | `query()` loads complete content, bounded by `maxLobBytes`; `blob()` and `clob()` on the prepared methods write with LOB_NEW and LOB_WRITE; no handle API | Reads and writes verified on 10.2 to 11.4 ([#103](https://github.com/cubrid-lab/cubrid-client/issues/103)); no LOBs in `executeMany()` |
| Native bind/prepared SQL | `executeWithTypedParams` | Client-side SQL interpolation for `query(sql, params)`; opt-in typed binds through `queryPrepared()` and its siblings | Deliberate different default, with [prepared binding](TYPES.md#prepared-binding) as the opt-in |
| Multiple hosts / connection retries | Uses host fallback and retry counter | `maxConnectionRetryCount` retries a failed TCP connect with backoff; no host fallback | Retry implemented, host fallback not [#83](https://github.com/cubrid-lab/cubrid-client/issues/83) |
| Logger | Uses injected logger for query/protocol events | `logger` receives redacted structured events for connections, queries and transactions; no SQL, parameters, rows or credentials; no protocol-level events | Implemented with a different, redacted contract [#100](https://github.com/cubrid-lab/cubrid-client/issues/100) |
| TLS with verified certificate | Not a documented common feature in historical native API | Implemented; live SSL=ON 11.4 CA/hostname checks | Native-specific, not a legacy parity requirement |
| DML metadata, errors | Richer result packets and error structures | `query()` returns no rows for DML; `execute()` returns `{ affectedRows, lastInsertId }` ([#84](https://github.com/cubrid-lab/cubrid-client/issues/84)); error mapping differs | Affected rows and generated id implemented; remaining gap tracked [#89](https://github.com/cubrid-lab/cubrid-client/issues/89) |
| Large results / streaming | Query handles and `fetch` | `query()` fetches internally with automatic handle cleanup; `stream()` reads one reply at a time | `stream()` verified on 10.2 to 11.4, see [`stream()`](API_REFERENCE.md#streamtsql-params-options) [#87](https://github.com/cubrid-lab/cubrid-client/issues/87) |

## Live comparative acceptance

The pinned adapter must execute **the same inserted rows and selected SQL**
against the **same** CUBRID broker and version. The automated fixture checks
integer/string/NULL values, native and legacy DML side effects, SQL errors,
and a successful query after a rejected query.

This is a starting scope, **not** proof of every item in the matrix. In
particular, cross-driver date, 64-bit integer precision, large FETCH, LOB
and version-specific JSON semantics and cross-driver collection results need separately reviewed
fixtures before full production readiness. The
[official JDBC comparison](#official-jdbc-comparison) below adds those value
fixtures against the official driver instead of the historical one. Do not label absent fixtures
"passing". See [#118](https://github.com/cubrid-lab/cubrid-client/issues/118)
and [release validation gate](https://github.com/cubrid-lab/cubrid-client/issues/120).

The original library is **only a comparison oracle**, not a new production
dependency of the published `cubrid-client` npm package. The legacy source
and its runtime dependency install are isolated to CI.

## Official JDBC comparison

[#118](https://github.com/cubrid-lab/cubrid-client/issues/118) compares
`cubrid-client`'s public API with the official CUBRID JDBC driver on the same
disposable server. It compares stored and returned **values**, row counts,
server error codes and transaction side effects, not Java and JavaScript class
shapes. It is a bounded regression lane, not a claim of full parity.

### What runs

- [`tests/jdbc-parity/corpus.json`](../tests/jdbc-parity/corpus.json): 34
  cases, 32 executed and 2 declared unverified. Areas: server version, SELECT,
  DML and DDL row counts, SHORT/INT/BIGINT/NUMERIC/DOUBLE/FLOAT/MONETARY, NULL
  versus empty string and empty bit string, DATE/TIME/DATETIME/TIMESTAMP
  (including 0001-01-01, 9999-12-31 and both sides of the 1582 Julian/Gregorian
  switch), SET/MULTISET/SEQUENCE (empty, NULL, NULL elements, BIGINT, NUMERIC
  and DATE elements), BLOB/CLOB reads, prepared binding (INT, BIGINT, DOUBLE,
  string, NULL, DATETIME, bytes), an 8192-row multi-FETCH compared by row count
  and SHA-256 of every normalized row, autocommit, explicit commit and rollback
  seen from a second connection, a failed statement inside a transaction, and
  the error codes of a syntax error, an unknown table, unique violations and an
  unknown column, each followed by a statement on the same connection.
- [`JdbcRunner.java`](../tests/jdbc-parity/JdbcRunner.java) (Java 11+
  single-file launch, `-Duser.timezone=UTC`) and
  [`ts-runner.ts`](../tests/jdbc-parity/ts-runner.ts) (`timezone: "utc"`,
  `beginTransactionScope()` for explicit transactions, `queryResultPrepared()`
  and `executePrepared()` for binds) write the same normalized JSON: decimal text
  for integers and NUMERIC, the IEEE-754 bits of non-integral doubles, `0x` hex
  for bytes, wall-clock field text for temporal values, and the server error
  code, never the message.
- [`compare.ts`](../tests/jdbc-parity/compare.ts) classifies each case.
  A representation pair (Java class, JavaScript type) that is in neither table
  of the corpus is a defect even when the text is equal. The run fails on any
  undeclared difference, a runner failure, a missing case, or zero executed
  cases; the CI lane also requires at least 30 executed cases.

| Classification | Meaning |
| --- | --- |
| equivalent | Same values, counts, codes and side effects, carried by equivalent representations (`Integer`/`number`, `String`/`string`, `byte[]`/`Buffer`, `Object[]`/`Array`, ...) |
| intentional | Same values, carried by a representation listed with its reason: `Long`/`bigint`, `BigDecimal`/decimal `string`, `java.sql.Date`/`Time`/`CUBRIDTimestamp` to `Date` ([#113](https://github.com/cubrid-lab/cubrid-client/issues/113)), `CUBRIDBlob`/`Buffer` and `CUBRIDClob`/`string` (content loaded by the query) |
| limitation | A difference declared with its local issue (none in this run) |
| intentional difference | Different values by a documented design decision, declared as `intentional` with the issue or ADR that records it and limited to its steps (`intentional-difference` in `report.json`) |
| defect | A difference without a declaration fails the run. A verified defect recorded in the corpus (`expectedDefect`, limited to its steps) is reported, not fixed here |
| unverified | Declared as not run, with the reason |

### Run it

```sh
npm ci
export CUBRID_JDBC_JAR="$(npm run -s jdbc-parity:fetch)"   # downloads and checks SHA-256
CUBRID_TEST_PORT=33000 npm run test:jdbc-parity
```

It needs a broker with database `testdb`, user `dba` and an empty password
(`CUBRID_TEST_HOST`, `CUBRID_TEST_DATABASE` and `JAVA` are optional), creates
and drops `jp_*` tables, and writes `jdbc.json`, `ts.json` and `report.json` to
`JDBC_PARITY_OUT` (default `jdbc-parity-results/`).
[`tests/jdbc-parity-compare.test.ts`](../tests/jdbc-parity-compare.test.ts), part
of `npm test`, checks offline that the comparator cannot pass by classifying
nothing or hiding a difference.

The [JDBC parity workflow](../.github/workflows/jdbc-parity.yml) is opt-in. A
pull request runs it on 11.4 only when it changes `src/protocol/**`,
`src/adapters/**` or the comparison itself; `workflow_dispatch` and
`workflow_call` run 10.2, 11.0, 11.2 and 11.4. Each version costs one
disposable container, the 285 KB JAR and about 3 to 5 minutes, mostly the
server's DDL. It is not yet a required release gate.

### Evidence, 2026-11-12

| Item | Value |
| --- | --- |
| JDBC driver | `org.cubrid:cubrid-jdbc:11.3.2.0053` from Maven Central, SHA-256 `ab8ab5632382a3042c0f354dd903d53b4f15c67b462afbeddb4edcf0bf43ad1f` (pinned in [`jdbc-driver.json`](../tests/jdbc-parity/jdbc-driver.json); the only release published under that coordinate). Source: [CUBRID/cubrid-jdbc](https://github.com/CUBRID/cubrid-jdbc) |
| JDK | OpenJDK 17.0.21 |
| cubrid-client | 1.3.0, `src/` at commit `226aee8217831399ee483c087e9225a563d4a1d3`, Node.js 24.14.0 |
| Servers | Docker `cubrid/cubrid` 10.2 (10.2.18.9024), 11.0 (11.0.16.0419), 11.2 (11.2.9.0866), 11.4 (11.4.6.1963); both drivers reported the same version. Database charset `iso88591` on all four. The broker version was not recorded separately: the CAS reply carries only the server version |

| Server | Cases | Executed | Equivalent | Intentional | Limitation | Defect | Unverified | Failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10.2 | 34 | 32 | 21 | 10 | 0 | 1 (recorded) | 2 | 0 |
| 11.0 | 34 | 32 | 21 | 10 | 0 | 1 (recorded) | 2 | 0 |
| 11.2 | 34 | 32 | 18 | 13 | 0 | 1 (recorded) | 2 | 0 |
| 11.4 | 34 | 32 | 18 | 13 | 0 | 1 (recorded) | 2 | 0 |

The three cases that are equivalent on 10.2 and 11.0 but intentional on 11.2
and 11.4 select `COUNT(*)`, which those servers type as INTEGER and the newer
ones as BIGINT. Both drivers agree on each server.

¹ Re-run for [#238](https://github.com/cubrid-lab/cubrid-client/issues/238) on
10.2.18.9024 and 11.4.6.1963 with the same JDBC driver and JDK: 35 cases, 33
executed, no unexpected difference. The two text cases are as shown; every other
case kept its classification above.
² Recorded before #238 and not re-run on 11.0 and 11.2.

| Case | Area | 10.2 | 11.0 | 11.2 | 11.4 |
| --- | --- | --- | --- | --- | --- |
| `connect-server-version` | connection | equivalent | equivalent | equivalent | equivalent |
| `select-literals` | select | equivalent | equivalent | equivalent | equivalent |
| `select-empty-result` | select | equivalent | equivalent | equivalent | equivalent |
| `dml-row-counts` | dml | equivalent | equivalent | equivalent | equivalent |
| `ddl-row-count` | dml | equivalent | equivalent | equivalent | equivalent |
| `integer-ranges` | numeric | equivalent | equivalent | equivalent | equivalent |
| `bigint-ranges` | numeric | intentional | intentional | intentional | intentional |
| `numeric-scale` | numeric | intentional | intentional | intentional | intentional |
| `double-float-monetary` | numeric | equivalent | equivalent | equivalent | equivalent |
| `stored-numeric-columns` | numeric | intentional | intentional | intentional | intentional |
| `null-and-empty-literals` | null-empty | equivalent | equivalent | equivalent | equivalent |
| `null-and-empty-stored` | null-empty | equivalent | equivalent | intentional | intentional |
| `bit-strings` | null-empty | equivalent | equivalent | equivalent | equivalent |
| `text-non-ascii-iso88591-database` | select | intentional difference¹ | defect (recorded)² | defect (recorded)² | intentional difference¹ |
| `text-latin1-charset-option` | select | equivalent¹ | not run² | not run² | equivalent¹ |
| `temporal-literals` | temporal | intentional | intentional | intentional | intentional |
| `temporal-boundaries` | temporal | intentional | intentional | intentional | intentional |
| `collections-literal` | collection | equivalent | equivalent | equivalent | equivalent |
| `collections-stored` | collection | intentional | intentional | intentional | intentional |
| `lob-read` | lob | intentional | intentional | intentional | intentional |
| `prepared-bind-roundtrip` | prepared | intentional | intentional | intentional | intentional |
| `prepared-datetime-millis` | prepared | intentional | intentional | intentional | intentional |
| `prepared-row-counts` | prepared | equivalent | equivalent | intentional | intentional |
| `prepared-type-mismatch-error` | error | equivalent | equivalent | intentional | intentional |
| `multi-fetch-8192-rows` | fetch | intentional | intentional | intentional | intentional |
| `autocommit-visibility` | transaction | equivalent | equivalent | equivalent | equivalent |
| `explicit-rollback-visibility` | transaction | equivalent | equivalent | equivalent | equivalent |
| `explicit-commit-visibility` | transaction | equivalent | equivalent | equivalent | equivalent |
| `failed-statement-inside-transaction` | transaction | equivalent | equivalent | equivalent | equivalent |
| `error-syntax` | error | equivalent | equivalent | equivalent | equivalent |
| `error-unknown-table` | error | equivalent | equivalent | equivalent | equivalent |
| `error-unique-violation` | error | equivalent | equivalent | equivalent | equivalent |
| `error-semantic-unknown-column` | error | equivalent | equivalent | equivalent | equivalent |
| `session-replacement-stale-handle` | failure-path | unverified | unverified | unverified | unverified |
| `uncertain-outcome-no-replay` | failure-path | unverified | unverified | unverified | unverified |

Notable equivalences: BIGINT extremes and 2^53+1 are exact on both sides;
NUMERIC keeps its scale (`-0.50`, `0.000`); doubles match bit for bit; `''` and
`X''` stay distinct from NULL; DATE `0001-01-01` and `1582-10-04` read the same
wall-clock fields on both; a DATETIME bound with milliseconds keeps `.678`;
a string bound to an INT column fails with `-494` on both; a unique violation
inside a transaction (`-670`) leaves the earlier and later statements to commit
on both; the 8192-row result has the same row checksum.

### Intentional difference: text in a non-UTF-8 database

`text-non-ascii-iso88591-database` (steps 1, 3 and 5) runs both drivers in
their default mode. The Docker images create `testdb` with charset `iso88591`.
Both drivers send UTF-8 SQL text, so the server stores `café` as the bytes
`63 61 66 C3 A9` and reports `LENGTH('café')` as 5 (steps 2 and 4 agree).
JDBC decodes those bytes in the column charset and returns `cafÃ©`;
`cubrid-client`'s default `charset: "utf-8"` decodes UTF-8 and returns `café`.
For a byte that is not UTF-8, `CHR(233)` (`E9`), JDBC returns `é` and
`cubrid-client` returns `U+FFFD`. [#238](https://github.com/cubrid-lab/cubrid-client/issues/238)
kept that default, the 1.x behavior, so text this client stored keeps reading
back, and added `charset: "iso-8859-1"` for an `iso88591` database
([text and character sets](TYPES.md#text-and-character-sets)).

`text-latin1-charset-option` runs both with that charset, JDBC as
`charset=iso-8859-1` on its own connections: `CHR(233)` is `é`, `'café'` is
stored as `636166E9` with `LENGTH` 4, a bound `'café ÿ'` reads back as itself,
and a bound `SELECT ?` returns `é`. It is equivalent on 10.2 and 11.4. A case can
set `charset`, which both runners apply to that case only.

### Not covered

- `session-replacement-stale-handle` and `uncertain-outcome-no-replay` are
  unverified: they need a broker restart, CAS kill or a proxy between the
  statements, which this bounded lane does not provide. The native integration
  suite covers the TypeScript side alone.
- Not compared: timezone-aware types, JSON, ENUM, OID, LOB writes, batch
  execution, `lastInsertId`, isolation levels, lock and deadlock errors,
  concurrency, TLS, and a UTF-8 database. No result here extends
  [SUPPORT_MATRIX.md](SUPPORT_MATRIX.md).
