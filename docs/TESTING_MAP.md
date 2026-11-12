# Test case map

> **Status:** Measured on `main` at `25c770d` with Node 24.14.0 and a disposable
> CUBRID 11.4.6 container (#230). Counts change with every test added; rerun the
> commands below rather than trusting the numbers in a later review.

This page maps each driver contract to the test files and blocks that check
it, and records which layer each file tests. Use it to pick the focused run
for a change and to see which independent checks a change must keep.

## Layers

Each layer catches a different failure, so a case that looks the same in two
layers is not a duplicate. A mock-only pass never stands in for a live run,
and an oracle never shares a builder with the code it checks
([protocol oracles](PROTOCOL_ORACLES.md)).

| Layer | What it substitutes | Files |
| --- | --- | --- |
| Packet and parser units | nothing below the parser; test-local frame builders | `protocol.test.ts`, `query-utils.test.ts`, `connection-string.test.ts` |
| Independent protocol oracle | literal CCI/CAS IDs and frames captured from live 10.2–11.4 brokers (`tests/fixtures/*-frames.ts`) | `protocol-oracles.test.ts`, `jdbc-parity-compare.test.ts` (comparator only) |
| CAS socket | a scripted broker over real TCP or TLS | `connection.test.ts`, `connection-tls.test.ts`, `destroy.test.ts`, `outcome-unknown.test.ts` |
| Native adapter | `FakeCASConnection` in place of the socket, plus a scripted TCP CAS for #90 | `native-adapter.test.ts` |
| Client and transactions | `FakeConnection` in place of the adapter | `client.test.ts`, `transaction-scope.test.ts`, `close-lifecycle.test.ts`, `pool.test.ts`, `row-mode.test.ts`, `schema.test.ts`, `timezone.test.ts`, `logger.test.ts`, `transaction-client-compat.test.ts` (typecheck) |
| Concurrency | real `createClient()` on a fake CAS that records each request's owner | `concurrent-lifecycle.test.ts` |
| Live CUBRID | nothing | `integration.test.ts`, `integration-tls.test.ts`, `legacy-parity.test.ts`, `tests/jdbc-parity/` |

## Lanes and selection commands

| Command | Files | Where it runs | Result on `25c770d` |
| --- | --- | --- | --- |
| `npm test` | the 20 offline `.ts` files, then `verify-npm-version.test.mjs` | `ci.yml` (Node 18–26), `release-validation.yml` | 1416 pass, 0 fail, 0 skipped; then 6 pass |
| `npm run test:coverage` | the same 20 files under `c8` | `ci.yml` | same 1416 tests |
| `npm run test:integration`, no broker | `integration.test.ts` | `ci.yml` (warns that it is offline only) | 1 pass (`connect fails with wrong port`); the 18 top-level suites are skipped |
| `CUBRID_LIVE_REQUIRED=1 CUBRID_TEST_PORT=1 npm run test:integration` | `integration.test.ts` | `ci.yml` negative check | fails with "Live CUBRID integration was required but the broker was unreachable" |
| `CUBRID_LIVE_REQUIRED=1 CUBRID_TEST_UTF8_DATABASE=testu8 npm run test:integration` | `integration.test.ts` | `live-cubrid.yml` (11.4 on PRs; 10.2, 11.0, 11.2, 11.4 on `main` and releases) | CUBRID 11.4.6, broker on 127.0.0.1:33410: 309 pass, 0 fail, 0 skipped, 39 suites, 834 s |
| `node --import tsx --test tests/integration-tls.test.ts` | `integration-tls.test.ts` | `live-cubrid-tls.yml`, which requires `# tests 3` | offline: 3 skipped; not run live here |
| `node --import tsx --test tests/legacy-parity.test.ts` | `legacy-parity.test.ts` | `live-cubrid.yml`, which requires 1 pass and 0 skipped | not run here; throws without `NODE_CUBRID_ENTRY` |
| `npm run test:jdbc-parity` | `tests/jdbc-parity/` | `jdbc-parity.yml` | not run here (needs Java and the pinned JAR) |
| `npm run test:all` | every `tests/*.test.ts` | no workflow | fails offline by design: 1417 pass, 1 fail (`legacy-parity.test.ts`), 3 skipped (TLS) |
| `node --test tests/api-public-surface.test.mjs`, `npm run api:check` | public API parser and `api/index.d.ts` | `ci.yml` (Node 22) | 3 pass; "Public API matches api/index.d.ts." |

`live-cubrid.yml` fails the job if the TAP output has `# skipped` above 0 or
fewer than 20 passes. Two facts behind those gates:

- A suite skipped with `describe(..., { skip })` is counted under `# suites`,
  not `# skipped`. The offline run above reports `# skipped 0`. What turns an
  unreachable broker into a failure is `CUBRID_LIVE_REQUIRED=1`, which throws
  before any suite registers; the pass floor is the second guard.
- The nested `text charsets (#238)` tests skip themselves without
  `CUBRID_TEST_UTF8_DATABASE`, and those do count as `# skipped`, so the gate
  catches a missing `testu8`.

For one area, run its file. Inside the large files, `--test-name-pattern`
selects by name, for example
`npm run test:integration -- --test-name-pattern="connection pool \(#92\)"`
for one live suite. Names in the offline files are not uniformly prefixed, so
a pattern there is approximate: on `25c770d`, `LOB` selects 110 offline tests,
`charset|#238` 28, `rowMode|#255` 34, `#254|outcomeUnknown` 20 (of the 23 in
`outcome-unknown.test.ts`) and `TLS` 29.

## Contract areas

Live blocks are `describe` names in `tests/integration.test.ts`; nested ones sit
under "Integration: NativeCubridAdapter against Docker CUBRID". Offline blocks
are the section comments in each file.

| Area | Offline | Live (`integration.test.ts` unless named) |
| --- | --- | --- |
| Connection and handshake | `connection.test.ts`: connect() full handshake, frame validation (#107); `protocol.test.ts`: handshake, writeOpenDatabase byte limits; `native-adapter.test.ts`: connect(), connectionTimeout forwarding; `connection-string.test.ts` | `connect fails with wrong port`, `connect to CUBRID`, `Integration: OpenDatabase credential byte limits` |
| CAS protocol | `protocol.test.ts`: PacketWriter/Reader, parsers, error replies, captured DML and generated-key replies; `protocol-oracles.test.ts`: literal type and function IDs, captured frames | every live block decodes real replies; `tests/jdbc-parity/` compares with JDBC |
| Query and fetch | `native-adapter.test.ts`: query() DML/DDL/SELECT, fetchRemaining, query handle lifecycle (#108), prepared binding, executeMany (#86); `protocol.test.ts`: fetch, SQL lexer (#243); `query-utils.test.ts` | `query handle release`, `execute results`, `generated insert ids`, `prepared binding`, `stream()`, `Integration: executeMany (#86)`, `negative literal parameters (#242)`, `where a ? is a marker (#243)`, `escapeIdentifier and buildWhere quoting (#259)` |
| Transactions | `client.test.ts`: transaction() callback lifecycle, statement guards, observed and unobserved failures (#244); `native-adapter.test.ts`: begin/commit/rollback, connection loss in a transaction (#107), server-side rollback (#184); `transaction-scope.test.ts`; `transaction-client-compat.test.ts` | `beginTransactionScope() ownership`, `transaction callback lifecycle`, `isolation level and lock timeout options` |
| Concurrent lifecycle | `concurrent-lifecycle.test.ts`; `connection.test.ts`: concurrency serialization (#39); `close-lifecycle.test.ts` (#246) | `overlapping query lifecycles on one connection`, `autocommit statements on one session`, `close() and running transaction() callbacks (#246)` |
| Error classification | `client.test.ts`: structured error details; `native-adapter.test.ts`: query() error handling; `protocol.test.ts`: error replies | `server error details` |
| TLS | `connection-tls.test.ts` (self-signed certificate, local TLS server) | `integration-tls.test.ts` (`live-cubrid-tls.yml` only) |
| LOB | `protocol-oracles.test.ts`: BLOB and CLOB, LOB_NEW and LOB_WRITE; `native-adapter.test.ts`: BLOB and CLOB content, stream() LOB, writing LOBs (#103) | `BLOB and CLOB columns`, `Integration: writing BLOB and CLOB with LOB_NEW and LOB_WRITE (#103)` |
| Retry, reconnect and timeouts | `connection.test.ts`: read timeout (#90), maxConnectionRetryCount, awaitScoped(); `native-adapter.test.ts`: auto-reconnect, read timeout over a socket (#90), per-query options (#150); `concurrent-lifecycle.test.ts`: reconnects never carry a request; `client.test.ts`: per-query options (#150) | `Integration: maxConnectionRetryCount`, `Integration: per-query AbortSignal and readTimeout (#150)`, `Integration: maxReplyBytes (#251)` |
| Pool | `pool.test.ts` | `Integration: connection pool (#92)`, `Integration: pool close() inside transaction() callbacks (#268)` |
| destroy() | `destroy.test.ts`; `connection-tls.test.ts`: destroy() over TLS | `Integration: destroy() (#245)` |
| outcomeUnknown | `outcome-unknown.test.ts` | `Integration: outcomeUnknown on uncertain outcomes (#254)` |
| rowMode | `row-mode.test.ts` (options and typings); `protocol.test.ts`: row shape (#255); `native-adapter.test.ts`: rowMode "array" | `Integration: rowMode "array" keeps every column (#255)` |
| Charset | `protocol-oracles.test.ts`: text charsets (#238); `native-adapter.test.ts`: the charset option (#238) | `text charsets (#238)` (needs `CUBRID_TEST_UTF8_DATABASE`) |
| Dates, times and zones | `timezone.test.ts`; `protocol-oracles.test.ts`: timezone-aware values and JSON (#111) | `zero dates`, `years 1 to 99`, `timezone-aware values and JSON`, `Integration: temporal values under TZ=… (#250)`, `Integration: a Date written to a zone-aware column (#273)` |
| Collections | `protocol-oracles.test.ts`: collections (#82) | `collection columns` |
| Schema introspection | `schema.test.ts` | `schema introspection` |
| Logging | `logger.test.ts` | none |
| Public API | `api-public-surface.test.mjs`, `npm run api:check`, `transaction-client-compat.test.ts` | none |
| Legacy driver parity | none | `legacy-parity.test.ts` (`live-cubrid.yml` only) |

## Duplicate review (#230)

No pair was confirmed as a duplicate. The check was: the same input, the same
assertion and the same failure it would catch. Every full test path is unique
(per-file TAP lists, offline and live). Names that look alike across files
were compared case by case:

| Pair | Why both stay |
| --- | --- |
| `protocol.test.ts` "unknown and unsupported non-NULL wire values are never returned as SQL NULL" / `protocol-oracles.test.ts` "unsupported non-NULL bytes are errors and never fabricated SQL NULL" (also the NULL versus empty-string pair) | Same parser, different inputs: a test-local builder versus literal oracle frames. The oracle must not share a builder with the code (`PROTOCOL_ORACLES.md`), and it covers more wire types. |
| `client.test.ts` "createClient rejects a user with an embedded NUL" / `protocol.test.ts` "writeOpenDatabase rejects a user with an embedded NUL" | Different entry points: `normalizeConfig()` versus the wire writer, which the public adapter reaches without `createClient()`. |
| `client.test.ts` "a query after close rejects and leaves no connection open" / `concurrent-lifecycle.test.ts` "a query issued right after close rejects and leaves no session open" | `FakeConnection` counts connections; the concurrency test checks which requests reached the CAS and that its sockets close. |
| `client.test.ts` "commit after manual commit rejects and sends nothing" / `native-adapter.test.ts` "a manual tx.commit() after -72 rejects and sends no COMMIT" | Different trigger: a client-side terminal state versus a server rollback reported by `CAS_INFO`. |
| `native-adapter.test.ts` charset iso-8859-1 cases / `protocol-oracles.test.ts` iso-8859-1 cases | Adapter wiring of the option versus the codec against a captured reply. |
| Live `Integration: destroy() (#245)` / live `outcomeUnknown` "destroy() during SELECT SLEEP(2) leaves the outcome unknown" | Different assertions: prompt settling, lock release and at-most-once versus the `outcomeUnknown` flag. |
| Offline and live blocks of the same area (pool, destroy, outcomeUnknown, rowMode, charset, LOB) | Mock-only and live checks catch different failures; see the layers above. |

Several runs of near-identical names inside one file (microtask turns 0–6,
32- and 33-byte credentials, 10.2 and 11.4 frames) are parameterized cases of
one loop, not copies.

## Decision: keep the files as they are (#230)

#230 allows one small refactor if it shows a clear benefit. None of the
candidates did, so the suite stays as it is:

- **Moving a live group out of `integration.test.ts`** (pool #92 and #268 was
  the most self-contained). The new file would need the broker availability
  check and its `CUBRID_LIVE_REQUIRED` throw, a change to `test:integration`,
  and new `paths` entries in `live-cubrid.yml`, which only lists
  `tests/integration.test.ts`. `node --test` runs files in parallel, so the
  pool timing assertions (`>= 2900` ms, peak sessions) would share one broker
  with the rest of the suite unless concurrency is pinned. The gain is small:
  `--test-name-pattern` already runs one live suite. The group's
  `ClientLogFields` import is on a line that the pending #284 also changes.
- **A shared live setup helper.** The `before`/`after` blocks differ in tables,
  options and cleanup. One helper would touch most live suites, which is the
  large restructuring #230 rules out.
- **Moving an offline group out of `native-adapter.test.ts`.** Its groups
  depend on `FakeCASConnection` and the response builders defined at the top
  of the file. Moving one means first extracting about 500 lines of fixture.

Revisit when one of these changes: a live area grows its own provisioning (as
TLS did with `integration-tls.test.ts`), or another file needs
`FakeCASConnection`.
