# Tested and declared compatibility

This matrix separates **declared support**, **automated offline tests**, and
**manually reported live checks**. Only results backed by a CI job with a real
broker qualify as live CI coverage.

## Node.js

| Node version | Package declaration | PR CI typecheck / unit / build | Published-package consumer smoke |
| --- | --- | --- | --- |
| 18 | `engines.node >=18` | Included | Not established |
| 20 | Included by >=18 | Included | Not established |
| 22 | Included by >=18 | Included, plus declaration API check | Not established |
| 24 | Included by >=18 | Included | Not established |
| 26 | Included by >=18 | Included | Not established |
| Other newer versions | Included by >=18 | Not claimed as matrix coverage | Not established |

Node.js 18 and 20 have reached end-of-life upstream but remain in the
declared 1.x contract; see the
[Node.js support schedule](API_STABILITY.md#nodejs-support-schedule). The
`@types/node` development dependency stays on `^18.19.0` to match the lowest
declared version. CI, the release preflight (`publish.yml`) and the
packed-package CJS/ESM consumer smoke (`release-validation.yml`) all run on
Node 18, 20, 22, 24 and 26 ([#96](https://github.com/cubrid-lab/cubrid-client/issues/96)).

The `tsup` build-tool Node.js requirement is **not** the runtime floor for
users importing the emitted npm package. A change to `engines` in 1.x is
governed by [API_STABILITY.md](API_STABILITY.md).

## CUBRID server / broker

The dedicated [Live CUBRID integration workflow](../.github/workflows/live-cubrid.yml)
now provisions disposable databases. On **2026-11-06**, the
[main branch full-matrix run](https://github.com/cubrid-lab/cubrid-client/actions/runs/42216017228)
used Node.js 22 and finished **23 passed, 0 failed, 0 skipped** on each
of the four image tags. It exercises the integration suite's actual assertions,
not all possible SQL types, broker options or fault-injection scenarios.

| CUBRID image tag | Actual live CI | Scope of evidence |
| --- | --- | --- |
| 10.2 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| 11.0 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| 11.2 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| 11.4 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| Other versions | Not tested in this workflow | No coverage claim |

Pull requests touching runtime code or the live workflow execute the 11.4
integration suite; a push to main executes the four-version matrix. A manual
dispatch can run all four versions before a release. The dedicated workflow
uses `CUBRID_LIVE_REQUIRED=1` so an unreachable server fails rather than
quietly self-skipping. The separate general-purpose Node.js CI still runs
its offline/self-skipping integration command and is **not** evidence of live
CUBRID coverage.

These results are a substantial improvement over the earlier targeted manual
checks, but the suite is not an exhaustive type round-trip or
fault-injection test. A separately required
[real SSL=ON CUBRID 11.4 workflow](https://github.com/cubrid-lab/cubrid-client/actions/runs/42217503095)
now verifies **3/3 tests with 0 skips**: a trusted CA/hostname-verified SQL
query, rejection of the untrusted self-signed certificate, and rejection
of a wrong hostname even with the correct CA. It does **not** establish TLS
compatibility on every database version, or independent JSON
coverage. Do not equate these 23 tests
with production-ready certification. See [#95](https://github.com/cubrid-lab/cubrid-client/issues/95)
and the [release gate](https://github.com/cubrid-lab/cubrid-client/issues/120).

The integration suite now also asserts decoded SET, MULTISET and SEQUENCE values:
29/29 passed with 0 skipped against local `cubrid/cubrid` 10.2, 11.0, 11.2 and
11.4 containers when that decoder was added
([#82](https://github.com/cubrid-lab/cubrid-client/issues/82)). The table above
is a **historical record of the 2026-11-06 run** (23 tests per version), not the
current case count: integration cases were added afterwards. A current count is
recorded here only when backed by a linked CI job; none has been re-recorded.

BLOB and CLOB reads are asserted the same way, against local `cubrid/cubrid` 10.2,
11.0, 11.2 and 11.4 containers: content, empty and NULL values, content spanning
several LOB_READ replies, a multibyte CLOB, the size limit and transaction
behavior ([#93](https://github.com/cubrid-lab/cubrid-client/issues/93)).

Prepared binding is asserted against local `cubrid/cubrid` 10.2, 11.0, 11.2 and
11.4 containers with statement pooling on, and on 11.4 again with
`STATEMENT_POOLING=OFF`: every supported column type against the literal path,
SQL NULL, text, number and bigint limits, multi-statement strings, FETCH,
autocommit and transactions, and the release of each handle on every way a
statement ends, together with a lost socket, a malformed reply, a deadlock and a
read timeout ([#85](https://github.com/cubrid-lab/cubrid-client/issues/85)).

Batch execution (`executeMany()`, EXECUTE_ARRAY) is asserted against local
`cubrid/cubrid` 10.2 and 11.4 containers: 1000 inserted rows, a unique violation
that rolls back the whole autocommit batch, a failure inside a transaction scope
that leaves the transaction open, mixed types and NULL, a batch split into several
requests, per-set update counts, the refused statements, `lastInsertId` after a
batch and an abort during a lock wait
([#86](https://github.com/cubrid-lab/cubrid-client/issues/86)). Both servers sent
the same EXECUTE_ARRAY frames apart from error message text. 11.0 and 11.2 were
not run.

Generated insert ids (`lastInsertId`, GET_LAST_INSERT_ID and, with
`{ generatedKeys: true }`, GET_GENERATED_KEYS) are asserted against local
`cubrid/cubrid` 10.2, 11.0, 11.2 and 11.4 containers: tables that both generate
1, a table without AUTO_INCREMENT, a supplied key, multi-row INSERT,
INSERT ... SELECT, a failed INSERT, ROLLBACK, a new session, CREATE TABLE ... AS
SELECT, the number/bigint boundary, an INSERT trigger and, on 11.4 only (PL/CSQL),
a stored function and a trigger that calls a procedure
([#247](https://github.com/cubrid-lab/cubrid-client/issues/247)). The four servers
sent the same GET_GENERATED_KEYS frames apart from the row OIDs, which only 10.2
fills in. From 11.0 the server refuses `generatedKeys` for an INSERT into a table
with an INSERT trigger; 10.2 runs it. From 11.0 a `generatedKeys` INSERT, mostly one of the first
into a newly created table, can come back without its key (absent, never wrong).

BLOB and CLOB writes (`blob()` and `clob()` on the prepared methods, LOB_NEW and
LOB_WRITE) are asserted against local `cubrid/cubrid` 10.2, 11.0, 11.2 and 11.4
containers, 9/9 cases on each: an 8 MiB BLOB from a `Buffer` and from a `Readable`
read back byte for byte, a CLOB with 3- and 4-byte characters across the 128 KiB
boundary, an empty BLOB against NULL, an autocommit failure after a LOB_WRITE with
the session reused, `scope.rollback()`, an abort while waiting on the source and
one with a LOB_WRITE in flight, a commit after a failed upload in a transaction,
and the refusal on the literal path
([#103](https://github.com/cubrid-lab/cubrid-client/issues/103)). The LOB_NEW and
LOB_WRITE frames were captured from 10.2 and 11.4 and differ only in the locator
text.

Identifier quoting by `escapeIdentifier()` and `buildWhere()` is asserted against
local `cubrid/cubrid` 10.2 and 11.4 containers in both `no_backslash_escapes`
modes ([#259](https://github.com/cubrid-lab/cubrid-client/issues/259)). Names with a
backtick, a double quote, a space or a backslash stay in brackets on both.
Names with `]` are backtick-quoted. 10.2 resolves them, and 11.4 refuses any
identifier with `[` or `]` (code `-493`). 11.0 and 11.2 were not run.

The connection pool (`createPool()`) is asserted against local `cubrid/cubrid`
10.2 and 11.4 containers: concurrency bounded by `max`, a clean session reused, a
session lost inside a transaction never reused (its session variable undefined and
its uncommitted row gone on the next lease), a scope discarded by `close()`, a
stream holding its session while a query in the loop uses another, and `close()`
waiting for a running statement, and a `blob()` written through the pool's
`executePrepared()` (11.4)
([#92](https://github.com/cubrid-lab/cubrid-client/issues/92)). 11.0 and 11.2 were
not run.

The `isolationLevel` and `lockTimeout` options are asserted the same way against
local `cubrid/cubrid` 10.2, 11.0, 11.2 and 11.4 containers: the level read back from
the server, what each level shows of a concurrent commit, the `-1158` conflict, write
skew under `serializable`, lock waits in milliseconds, and the settings on a session
that replaced a cut one ([#91](https://github.com/cubrid-lab/cubrid-client/issues/91)).
Restoring after a broker restart, a killed CAS, a database server restart and a CAS
taken by another client was measured by hand on the same versions; those events
cannot be caused from the shared CI broker.

## Release-blocking coverage still needed

- [#95](https://github.com/cubrid-lab/cubrid-client/issues/95):
  mandatory version-matrix and SSL=ON broker lanes are now implemented;
  their passing scope is exactly the 23+3 named tests, not every type/fault.
- [#117](https://github.com/cubrid-lab/cubrid-client/issues/117): independent
  literal CAS byte/type/statement fixtures and malformed packet cases.
- [#118](https://github.com/cubrid-lab/cubrid-client/issues/118): comparison
  with the original CUBRID Node.js adapter for scoped wire/result behavior.
- [#120](https://github.com/cubrid-lab/cubrid-client/issues/120): required
  package/API/type/live-DB release decision, not just a green offline job.

Until those are complete, describe the documented live matrix as **verified
for the named integration tests of the linked runs only**, not broadly production-ready.
