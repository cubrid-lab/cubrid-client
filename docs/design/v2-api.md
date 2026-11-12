# Design: v2 API binding option, driver entry point and prepared streaming

> Status: **Proposed** for 2.0 planning ([#249](https://github.com/cubrid-lab/cubrid-client/issues/249)).
> The decision record is [ADR 0011](../adr/0011-v2-binding-option-and-driver-subpath.md).
> Nothing here changes 1.x: the published declarations in `api/index.d.ts` are
> unchanged and no runtime code changed. The proposed 2.0 types are mocked in
> [`tests/v2-api-mock/`](../../tests/v2-api-mock/) and compiled by `npm run typecheck`.

Baseline: `main` at `e866323` (2026-11-12), which includes the pool (#92), `executeMany()`
(#86), `blob()` and `clob()` (#103), the `signal` and `readTimeout` statement
options (#150), the `charset` option (#238), `generatedKeys` (#247),
`maxReplyBytes` (#251) and `destroy()` (#245). Two pieces of work are **in
progress** and are referenced, not decided, here: array rows through a per-query
`rowMode: "array"` overload ([#255](https://github.com/cubrid-lab/cubrid-client/issues/255)),
and an `outcomeUnknown` flag on errors ([#254](https://github.com/cubrid-lab/cubrid-client/issues/254)).
Both are additive 1.x features and neither depends on this design.

How this document answers [#249](https://github.com/cubrid-lab/cubrid-client/issues/249):

| Issue item | Where |
| --- | --- |
| Inventory of exports, declarations, ESM/CJS consumers and downstream clients | [Inventory](#inventory-of-the-1x-api) |
| One binding option; typed binds as default only after evidence | [The binding option](#the-binding-option), [evidence gate](#evidence-gate-for-a-prepared-default) |
| Prepared streaming: cursor lifecycle, errors, transactions, backpressure | [Prepared streaming](#prepared-streaming) |
| Driver SPI in a reviewed subpath, tree-shaking, type compatibility, no protocol leak | [`cubrid-client/driver`](#the-cubrid-clientdriver-entry-point) |
| Migration matrix, nullable and unsupported values, deprecations, SemVer plan, pool | [Migration](#migration-matrix), [deprecations](#deprecation-plan), [release plan](#semver-release-plan) |
| Decision record and type mock with compile tests | [ADR 0011](../adr/0011-v2-binding-option-and-driver-subpath.md), [type mock](#type-mock-and-how-it-is-verified) |
| Literal vs prepared behavior for `undefined`, binary, dates, collections, text encoding | [Value behavior](#value-behavior-by-binding) |
| No 1.x break; baseline and downstream validated before a major | [Release plan](#semver-release-plan), evidence gate item 6 |

Contents:

1. [Inventory of the 1.x API](#inventory-of-the-1x-api)
2. [The binding option](#the-binding-option)
3. [Value behavior by binding](#value-behavior-by-binding)
4. [Evidence gate for a prepared default](#evidence-gate-for-a-prepared-default)
5. [Prepared streaming](#prepared-streaming)
6. [The `cubrid-client/driver` entry point](#the-cubrid-clientdriver-entry-point)
7. [Migration matrix](#migration-matrix)
8. [Deprecation plan](#deprecation-plan)
9. [SemVer release plan](#semver-release-plan)
10. [Type mock and how it is verified](#type-mock-and-how-it-is-verified)
11. [Open questions](#open-questions)

## Inventory of the 1.x API

### Entry points

`package.json` declares one entry point, `"."`, with `types` →
`dist/index.d.ts`, `import` → `dist/index.js` and `require` → `dist/index.cjs`.
tsup builds both from `src/index.ts` as one bundle each, and also writes
`dist/index.d.cts`. `npm run api:check` refuses a build whose `.d.ts` and
`.d.cts` differ, so ESM and CJS consumers see the same types. Checked on this
baseline after `npm run build`: `import * as m from "./dist/index.js"` and
`require("./dist/index.cjs")` both expose the same 20 runtime names. There is no
`sideEffects` field, no `typesVersions` and no subpath.

The runtime names are the 20 values in the table below; the other 56 names are
type-only exports. Every one of the 76 is listed once.

### Every export, by role

Roles: **statement** (runs SQL or describes a statement's parameters, options or
result), **lifecycle** (clients, pools, transactions, configuration and schema
reads around statements), **SPI** (the driver service provider interface a custom
`connectionFactory` implements or the client calls), **error**, and **utility**
(helpers that do not touch a connection).

| Export | Kind | Role | 2.0 disposition |
| --- | --- | --- | --- |
| `createClient` | function | lifecycle | Kept |
| `new CubridClient(config, connectionFactory)` | public constructor taking the SPI types `ClientConfig` and `ConnectionFactory` | lifecycle and SPI | Kept, documented as the driver-level way to build a client; its parameter types come from `cubrid-client/driver` (`createClient({ connectionFactory })` stays the application path) |
| `new CubridPool(options)` | public constructor | lifecycle | Kept, same as `createPool(options)` |
| `CubridClient` | class | lifecycle; statement methods below | Kept; `*Prepared` methods removed |
| `createPool` | function | lifecycle | Kept |
| `CubridPool` | class | lifecycle; statement methods below | Kept; `*Prepared` methods removed |
| `CubridTransaction` | class, constructor takes a `ConnectionLike` | SPI | Moved to `cubrid-client/driver` |
| `NativeCubridAdapter` | class implementing `ConnectionLike` | SPI | Moved to `cubrid-client/driver`, reshaped with `ConnectionLike` |
| `ConnectionLike` | interface | SPI | Moved and reshaped (see [below](#the-20-connectionlike)) |
| `ConnectionFactory` | type | SPI | Moved |
| `ClientConfig` | interface, what a factory receives | SPI | Moved |
| `blob`, `clob` | functions | statement (parameter constructors) | Kept |
| `LobParam`, `BlobSource`, `ClobSource` | types | statement | Kept |
| `PreparedQueryParam` | type | statement | Renamed `StatementParam` (alias kept in 2.0, removed in 3.0) |
| `QueryParam`, `QueryParams` | types | statement | Kept; `QueryParams` stays the `executeMany()` set type |
| `QueryResult`, `QueryResultRow`, `ColumnInfo` | types | statement | Kept |
| `CollectionElement`, `CollectionValue` | types | statement (result values) | Kept |
| `ZonedDateTime` | class | statement (result values) | Kept |
| `ZonedDateTimeFields`, `ZonedDateTimeType` | types | statement | Kept |
| `ExecuteResult`, `ExecuteManyResult` | types | statement | Kept |
| `QueryOptions` | type | statement | Gains `binding` |
| `ExecuteOptions` | type | statement | Gains `binding` through `QueryOptions` |
| `StreamOptions` | type | statement | Gains `binding` and `readTimeout` |
| `Queryable` | interface (`query`) | statement | Kept, `query()` options gain `binding` |
| `ResultQueryable` | interface (`queryResult`) | statement | Folded into `StatementClient` |
| `Executable` | interface (`execute`) | statement | Folded into `StatementClient` |
| `PreparedQueryable` | interface (three `*Prepared`) | statement | Removed |
| `BatchExecutable` | interface (`executeMany`) | statement | Folded into `StatementClient` |
| `Streamable` | interface (`stream`) | statement | Folded into `StatementClient` |
| `TransactionClient` | interface (`query`, `commit`, `rollback`) | lifecycle | Kept, widened to every statement method but `stream` |
| `ExecutableTransactionClient`, `ResultTransactionClient`, `PreparedTransactionClient`, `BatchTransactionClient` | interfaces | lifecycle | Folded into `TransactionClient` |
| `TransactionScope` | interface | lifecycle | Kept |
| `TransactionCallback` | type | lifecycle | Kept, one type parameter |
| `TransactionOptions`, `IsolationLevel` | types | lifecycle | Kept |
| `ClientOptions` | interface | lifecycle | Gains `binding`; `logger` typed as `ClientLogger` |
| `ClientLogger`, `ClientLogFields`, `ClientLogLevel` | types | lifecycle | Kept; fields gain `binding` |
| `PoolOptions`, `PoolStats`, `PoolConnectionOptions` | types | lifecycle | Kept; `PoolOptions` inherits `binding` |
| `PoolConnection` | interface | lifecycle; statement methods | Kept, as `StatementClient` |
| `SchemaOptions`, `SchemaTable`, `SchemaColumn`, `SchemaPrimaryKey`, `SchemaIndex`, `SchemaIndexColumn` | types | lifecycle (schema reads) | Kept |
| `ConnectionError`, `ReadTimeoutError`, `QueryError`, `ConstraintError`, `SqlSyntaxError`, `DeadlockError`, `LockTimeoutError`, `TransactionError` | classes | error | Kept |
| `CubridErrorDetails`, `CubridErrorKind`, `CubridErrorOptions`, `ExecuteManyFailure`, `ExecuteManySetFailure` | types | error | Kept (`outcomeUnknown` arrives with #254) |
| `escapeIdentifier` | function | utility | Kept |
| `buildWhere` | function | utility | Kept; typed `Record<string, QueryParam>` → `QueryParam[]` |
| `parseConnectionString`, `ConnectionConfig` | function, type | utility | Kept |

Names that appear in `dist/index.d.ts` without being exported:

| Name | Why it appears | 2.0 |
| --- | --- | --- |
| `ClientSSLOptions` | Type of `ClientOptions.ssl`; usable only through `Exclude<ClientOptions["ssl"], boolean | undefined>` | Exported from the root |
| `DriverAdapter` | Empty interface `NativeCubridAdapter` implements | Not in any declaration |
| `SESSION_STATE` | Symbol of the pool's reuse check (ADR 0008), a private member of `NativeCubridAdapter` | Only in the driver declarations, still unexported |
| 76 private members of `NativeCubridAdapter` | Emitted because the class is exported | Only in the driver declarations |

### Statement methods by surface

| Method | `CubridClient` | `CubridPool` | `PoolConnection` | `tx` of `transaction()` | `TransactionScope` | `CubridTransaction` | `ConnectionLike` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `query` | yes | yes | yes | yes | yes | yes | required |
| `queryResult` | yes | yes | yes | yes | yes | yes | optional |
| `execute` | yes | yes | yes | yes | yes | yes | optional |
| `queryPrepared` | yes | yes | yes | yes | yes | yes | optional |
| `queryResultPrepared` | yes | yes | yes | yes | yes | yes | optional |
| `executePrepared` | yes | yes | yes | yes | yes | yes | optional |
| `executeMany` | yes | yes | yes | yes | yes | yes | optional |
| `stream` | yes | yes | yes | no | no | no | optional |

Six surfaces times eight methods: 45 method declarations in the public
declarations and 8 more in the SPI. 2.0 keeps five statement methods on the
client, the pool and a leased connection (`query`, `queryResult`, `execute`,
`executeMany`, `stream`) and four on transactions and scopes (no `stream`), with
the binding as an option.

Lifecycle methods, unchanged by this design: `transaction()`,
`beginTransactionScope()`, `close()`, `destroy()`, `ping()`, `getServerVersion()`,
`getTables()`, `getColumns()`, `getPrimaryKey()`, `getIndexes()`, and on the pool
`connection()` and `stats()`. `CubridClient.beginTransaction()`, `commit()` and
`rollback()` are deprecated since #112; their removal is a separate 2.0 decision
(drizzle-cubrid still calls them, see below), not part of this design.

### SPI capabilities

`ConnectionLike` members and what the client does without the optional ones:

| Member | Required | Without it |
| --- | --- | --- |
| `connect`, `query`, `beginTransaction`, `commit`, `rollback`, `close` | yes | Does not compile |
| `queryResult`, `execute` | no | That client method rejects |
| `queryPrepared`, `queryResultPrepared`, `executePrepared` | no | That client method rejects; never falls back to literals |
| `executeMany` | no | Rejects; never loops over the sets |
| `setTransactionOptions` | no | A client or transaction with `isolationLevel` or `lockTimeout` fails |
| `stream` | no | `stream()` fails on its first read |
| `ping` | no | `ping()` rejects; the pool skips validation |
| `destroy` | no | `destroy()` falls back to `close()` without waiting |
| `[SESSION_STATE]` (unexported symbol) | no | The pool reuses the session only after a lease in which every call succeeded |

### Downstream users

Searched in the cubrid-lab organization on 2026-11-12; npm dependents outside
the organization were **not** searched, and must be before 2.0 (evidence gate
item 6). Only **drizzle-cubrid** (`main` at
`40e2c0b`) depends on the package: `cubrid-client ^1.0.0`, peer `>=0.1.0`. It
imports the `CubridClient` type only, and calls `query(sql, params)` through its
own structural interface `CubridQueryable` (`params?: readonly unknown[]`), plus
`beginTransaction()`, `commit()` and `rollback()` when they exist. It calls no
`*Prepared` method, no `stream()` and no SPI type. The consumer compile test checks
that a client and a pool still satisfy that structural interface under the 2.0
mock. Other repositories that mention the name (cubrid-rs and sqlalchemy-cubrid
documents) are not npm consumers.

## The binding option

```ts
type Binding = "literal" | "prepared";

interface QueryOptions { signal?: AbortSignal; readTimeout?: number; binding?: Binding }
interface ExecuteOptions extends QueryOptions { generatedKeys?: boolean }
interface StreamOptions { binding?: Binding; fetchSize?: number; signal?: AbortSignal;
                          consumerTimeout?: number; readTimeout?: number }
interface ClientOptions { /* ... */ binding?: Binding }   // PoolOptions inherits it
```

- **Resolution.** Per-call `binding`, else `ClientOptions.binding`, else the
  library default: `"literal"` in 1.x, and in 2.0 whatever the
  [evidence gate](#evidence-gate-for-a-prepared-default) decides. Transactions,
  scopes and pool leases inherit the client's or pool's setting.
- **Validation.** Any other value rejects with a `TypeError` before anything is
  queued, like the other statement options.
- **Visibility.** `ClientLogFields.binding` reports the resolved value on every
  statement log entry, so a default that changed is visible in logs.
- **`executeMany()`** always sends typed binds with EXECUTE_ARRAY. In 2.0 its
  options type, `ExecuteManyOptions`, has no `binding`, so an inline
  `{ binding: ... }` is a compile error (an options variable typed elsewhere is
  not caught). At run time it accepts `binding: "prepared"` as a no-op and
  refuses `binding: "literal"` with a `TypeError` before anything is sent, in the
  bridge MINOR and in 2.0, because it cannot honor it. In 1.x its options type is
  `QueryOptions`, which gains `binding`; the bridge MINOR adds
  `ExecuteManyOptions` (equal to `QueryOptions` in 1.x) as the declared type so
  2.0 can drop `binding` from it.
- **Parameter types in the bridge.** 1.x `query()`, `queryResult()`,
  `execute()` and `stream()` take `QueryParams`, which excludes `blob()` and
  `clob()`. The bridge MINOR widens them to `readonly PreparedQueryParam[]` so
  a LOB statement can move off `executePrepared()` during 1.x. Widening a
  parameter is compatible for callers, and implementers of `Queryable` and the
  other interfaces keep compiling because method parameters are checked
  bivariantly. A LOB under `"literal"` still rejects with a `TypeError`.
- **Schema reads.** `getTables()`, `getColumns()`, `getPrimaryKey()` and
  `getIndexes()` run fixed catalog queries with their own parameters. They always
  use `"literal"`, whatever `ClientOptions.binding` says, so a prepared default
  never makes them fail on a literal-only connection or change their results.
- **Option forwarding.** The client resolves `binding`, then removes it from the
  options before calling a 1.x `ConnectionLike` method, so a custom connection
  never receives an option it may not know.
- **Fail closed.** If the resolved binding is `"prepared"` and the connection
  cannot bind on the server, the statement rejects before anything is sent. In
  1.x that means the connection lacks the matching optional `*Prepared` method;
  in 2.0 it means the connection does not list `"prepared"` in
  `capabilities.bindings`. It never falls back to literals.
- **Results.** Rows, columns and `ExecuteResult` have the same shape on both
  bindings; values can differ as the next section lists.
- **Composition.** `rowMode` (#255) and `binding` are independent options of the
  same object, so array rows with prepared binding need no new method:
  `db.query(sql, params, { rowMode: "array", binding: "prepared" })`.

## Value behavior by binding

Both bindings accept the same JavaScript values, with the two exceptions marked.
A refused value rejects before anything is sent, with a `QueryError` whose
message names the value's type, never the value, unless the row says
`TypeError`. "1.x" describes the current behavior on `main`; "2.0" is the
proposal.

| Value | `"literal"` | `"prepared"` | 2.0 change |
| --- | --- | --- | --- |
| `null` | SQL `NULL` | NULL bind | None |
| `undefined` | SQL `NULL` (not a `QueryParam`, accepted at run time) | NULL bind (same) | **Refused on both**, see below |
| `boolean` | `1` / `0` | INT `1` / `0` | None |
| `number`, safe integer | Decimal text, negative in parentheses | INT, or BIGINT past 32 bits; `-0` is `0` | None |
| `number`, other finite | Decimal text, read as NUMERIC: `SELECT ?` of `1.5` returns `"1.5"` | DOUBLE, exact: returns `1.5` | None; listed in the gate |
| `number`, above 2^53 | Shortened decimal text (`1152921504606847000` for `2 ** 60`) | Exact bits as BIGINT | None; use `bigint` |
| `NaN`, `±Infinity` | Refused | Refused | None |
| `bigint` | Decimal text | BIGINT, or NUMERIC past 64 bits; more than 38 digits refused | None |
| `string` | Quoted, escaped for the session's `no_backslash_escapes` (probed per session) | CHAR bind, no probe | None |
| `string` encoding | SQL text in `charset`: UTF-8, or ISO-8859-1 with characters above U+00FF refused | Same encoding and refusal | None |
| `string` with NUL or Ctrl-Z | Refused | Refused | None |
| `Date` | `DATETIME'…'` from **UTC fields**; invalid `Date` refused | DATETIME bind from UTC fields; invalid `Date` and years outside 0001–9999 refused | None on write. Reads follow `timezone`, whose default becomes `"utc"` in 2.0 ([ADR 0010](../adr/0010-utc-temporal-default-in-2-0.md)) |
| Date into DATE, TIME, TIMESTAMP, zone-aware columns | The server converts the DATETIME literal | The server converts the DATETIME bind | None; a fraction (not a `Date`) bound to TIME is rounded on prepared, `-494` on literal |
| `Buffer` | `X'…'` (VARBIT literal) | VARBIT bind | None |
| Empty `Buffer` | `X''` | **Refused** (the broker reads it as NULL) | None; exception 1 |
| `Uint8Array` that is not a `Buffer` | Refused | Refused | None (accepting it is an additive [open question](#open-questions)) |
| `blob()`, `clob()` | **`TypeError`**: needs prepared | Uploaded with LOB_NEW and LOB_WRITE, bound as a handle | None; exception 2 |
| `blob()`, `clob()` in `executeMany()` | Not a `QueryParams` value: compile error, refused at run time | Same | None |
| `clob()` text encoding | n/a | UTF-8, or ISO-8859-1 with `charset: "iso-8859-1"`; invalid content refused during upload | None |
| Arrays (collections) | Refused: no collection parameter | Refused | None. A future `set()` / `multiset()` / `sequence()` wrapper, like `blob()`, would be additive. Arrays are never expanded into `IN (?, ?)` |
| `ZonedDateTime` | Refused (not a `QueryParam`) | Refused | None (writing one is an additive open question) |
| Any other object, function, symbol | Refused, never `String()`-converted | Refused | None |

Other differences that are about the statement rather than the value:

| Aspect | `"literal"` | `"prepared"` |
| --- | --- | --- |
| Marker count | Counted by the client's lexer; mismatch refused before sending | Server's count; mismatch refused before EXECUTE |
| Multi-statement SQL | Every statement runs; markers count together | Same (but `executeMany()` refuses it) |
| Markers where the server forbids host variables (for example DDL) | Work, because the client renders text | Fail at PREPARE; part of the gate |
| Requests in autocommit | PREPARE_AND_EXECUTE, handle release | PREPARE, LOB uploads, EXECUTE, END_TRAN, handle release |
| Value too large for its column | Server error at execution | Server error at EXECUTE naming the host variable; ENUM reports `-181` instead of `-494` |
| Result reads (BLOB/CLOB columns, collections, temporal types, `charset` decoding) | Identical | Identical |

**Why refuse `undefined` in 2.0.** It is not a `QueryParam`, so typed callers
cannot pass it without a cast, and JavaScript callers who do usually have a
missing field rather than an intended NULL: `buildWhere({ id: undefined })`
renders `[id] = ?` with NULL, a condition that matches no row. Refusing it on
both bindings keeps binding from changing what is accepted. The migration is
`value ?? null`.

## Evidence gate for a prepared default

`"prepared"` becomes the 2.0 default only if each item below is recorded, with
exact server versions and the commands that produced it, and a maintainer accepts
the result before 2.0.0. If any item fails, 2.0 ships the option with
`"literal"` as the default.

1. **Type coverage.** A round-trip matrix of every accepted JavaScript value
   against every CUBRID column type the support matrix lists (numeric, NUMERIC
   precisions, CHAR/VARCHAR/NCHAR, ENUM, BIT/VARBIT, DATE, TIME, TIMESTAMP,
   DATETIME, the four zone-aware types, JSON, collections, BLOB, CLOB) on 10.2,
   11.0, 11.2 and 11.4, run on both bindings. Each difference is either removed
   or listed in [TYPES](../TYPES.md#prepared-binding) and accepted. The current
   list: fractions, unsafe integers, empty `Buffer`, fraction into TIME, ENUM
   error code.
2. **Statement coverage.** Which statement kinds accept host variables at PREPARE
   (DDL, `SET` statements, `LIMIT`, `ORDER BY ?`, `CALL`, `MERGE`, multi-statement
   strings), on the same servers. Statements that work only as literals stay
   working with a per-call `binding: "literal"`, and the default is acceptable
   only if that list is short and documented.
3. **Charset semantics.** Both `charset` settings, on `utf8` and `iso88591`
   databases and on `utf8`, `iso88591` and `euckr` columns, store and read the
   same bytes on both bindings, including `clob()` content. The #238 tests cover
   part of this; the matrix must cover both bindings for every case.
4. **Session ownership.** A prepared handle never outlives its call or its
   session: PREPARE and EXECUTE reach the same session, a session replaced in
   between fails the statement instead of re-running it, the deferred END_TRAN
   in autocommit never reaches a replacement session, and a pooled session is
   clean ([ADR 0008](../adr/0008-pool-reuse-invariant.md)) after a failure at
   each step: PREPARE, LOB upload, EXECUTE, FETCH, END_TRAN, handle release, and
   an abort or `readTimeout` at each. Each failure after EXECUTE was written
   reports an unknown outcome (#254). The existing tests in
   `tests/connection.test.ts` and `tests/pool.test.ts` are the starting point;
   the evidence needs live runs.
5. **Performance.** `scripts/bench-prepared.ts` on an idle host, at least 300
   rounds per workload, on 11.4 and 10.2. Today a prepared read costs two more
   requests and measured 0.3 to 0.4 ms more per call on a loaded host. The gate
   is either a reduced request count (for example, checking whether the server
   accepts typed binds in a single request, which has not been verified) or a
   documented overhead the maintainers accept for the default.
6. **Compatibility.** The repository's suites (unit, integration, JDBC parity)
   pass with the default flipped, and drizzle-cubrid's suite passes against the
   release candidate with the default flipped. Every changed result in those
   runs is listed in the release notes.

## Prepared streaming

### Is a 1.x `streamPrepared()` safe?

Yes, but **not by only passing binds through `streamNow()`**. `stream()` already
calls the adapter's `runStatement()`, which is also the prepared path; it only
passes no binds. Two transaction owners would then collide:

- `runOnSession()` defers an autocommit prepared statement's commit to one
  END_TRAN after its callback, or rolls it back when the callback throws
  (`src/adapters/native.ts`, `deferCommit`).
- `streamWindows()` ends an autocommit read itself, in its `finally`, with
  `endReadTransaction()` (END_TRAN COMMIT) whenever the stream stopped early or
  read a LOB. That check looks at `autoCommit` only. `executeQuery()` already
  skips the same call for prepared statements (`binds === undefined`), and the
  stream path must do the same.

Without that guard a prepared stream would commit before the rollback when a
FETCH fails (wrong for a SELECT that calls a writing stored function), send two
END_TRAN requests on an early `break`, and, if the first END_TRAN fails,
discard the session so the deferred commit throws `ConnectionLostError` out of
the consumer's `break`, where a literal stream swallows that failure. **The
implementation requirement is: a prepared stream never calls
`endReadTransaction()`; the deferred END_TRAN in `runOnSession()` alone ends its
transaction.** With that guard:

- **Cursor lifecycle.** PREPARE, then EXECUTE with the binds, then FETCH windows
  on demand while the stream holds the connection's turn. The handle is released
  on the session that created it when the rows run out, the consumer stops
  (`break`, `return()`, a throw), the signal aborts, or a read fails. Nothing
  else can run on that connection meanwhile, as for a literal stream.
- **Autocommit.** The deferred END_TRAN runs once, after the window loop and
  before the handle release, never in the middle: an END_TRAN while the cursor
  is open would close it (`-1012`). A stream that completes or stops early
  commits then; one whose FETCH fails is rolled back. (A literal stream that
  stops early commits at the same point, through `endReadTransaction()`.) During
  the stream the session holds a transaction and its read locks, as a literal
  autocommit SELECT already does until its last row.
- **Inside a transaction.** No deferred END_TRAN; the cursor belongs to the
  caller's transaction. `commit()` and `rollback()` wait for the stream's turn,
  so awaiting them inside the loop rejects with `kind: "stream-busy"` after
  `consumerTimeout`, as any statement does. In 1.x this applies to a stream on a
  client inside the deprecated `beginTransaction()`; `transaction()` and scopes
  have no `stream()` in 1.x or in this proposal.
- **Errors.** A PREPARE failure (syntax, unknown column) or an EXECUTE failure
  (conversion, constraint) rejects the **first read**, with the same error
  classes as `queryPrepared()`, and the deferred transaction is rolled back. A
  FETCH failure rejects that read, releases the handle and rolls back. A refused
  value fails the stream before anything is sent. A failure of the deferred
  END_TRAN after the consumer stopped early is reported like a literal stream's
  `endReadTransaction()` failure, not thrown out of `break`: the statement only
  read, and the session is discarded so the pool or the next statement cannot
  inherit it.
- **Abort.** As for a literal stream, the stream's turn is queued without the
  statement options, so `StreamOptions.signal` does not retire the socket: the
  next read rejects with `signal.reason`, a reply already awaited is waited for
  (bounded by `readTimeout`), the handle is released, the deferred transaction is
  ended, and the session stays usable. A read timeout retires the socket as
  anywhere else, and then the outcome is unknown (#254).
- **Backpressure.** Unchanged from `stream()`: one FETCH window at a time, only
  when the consumer asks; a row's LOB content is read when that row is reached;
  other statements on the connection wait while the consumer reads, and are
  refused with `stream-busy` after `consumerTimeout` without a read.
- **LOB parameters.** `blob()` and `clob()` are **refused** in a prepared stream
  with a `TypeError` before anything is sent. They would be uploaded inside the
  stream's deferred transaction only to be compared, which no SELECT needs, and
  a failed upload in the middle of a stream adds a failure mode for no use.
  Allowing them later is additive.
- **Pool.** A pool stream holds its lease until the stream ends, as now, and
  `close()` of the cursor waits for the producer, so the deferred END_TRAN
  finishes inside the lease and the session is clean; if it fails the session is
  discarded (ADR 0008).
- **Custom connections.** A 1.x `ConnectionLike` has no way to stream with
  binds. It must not receive a prepared stream it would run as literals.

### Decision

Offer prepared streaming as `stream(sql, params, { binding: "prepared" })`,
in a 1.x MINOR and unchanged in 2.0, not as `streamPrepared()`. A dedicated
method is safe with the guard above but would be deprecated in the next major,
and it would add one more method to three surfaces and one more optional SPI
method.

In 1.x the client sends a prepared stream only to a connection that declares
the capability through an internal symbol, as the pool's reuse check does; the
built-in adapter declares it. Any other connection fails the first read with a
`QueryError` that says it cannot bind on the server, the same way `stream()`
fails on a connection without `stream`. The client removes `binding` from the
options before calling any 1.x connection method, so a custom connection never
sees an option it cannot honor. In 2.0 the connection receives the resolved
binding in `DriverStatement` and declares support in `capabilities.bindings`.

Called directly, the 1.x `NativeCubridAdapter.stream()`, `query()`,
`queryResult()` and `execute()` accept `binding` too and behave like the client;
its `*Prepared` methods ignore it (they are always prepared), and
`executeMany()` refuses `binding: "literal"` (see the bridge rules below).

Required before the 1.x MINOR ships: live tests on 10.2 and 11.4 of a prepared
stream that completes, stops early (checking that exactly one END_TRAN is sent),
fails at PREPARE, fails at EXECUTE, fails at a FETCH while a stored function in
the SELECT has written (checking it is rolled back), has its END_TRAN fail after
a `break` (checking the `break` does not throw), is aborted before and during a
FETCH, runs inside `beginTransaction()`, runs on a pool lease, and returns LOB
columns; plus the existing stream tests in `tests/connection.test.ts` repeated
with `binding: "prepared"`.

## The `cubrid-client/driver` entry point

### Contents

| Export | 1.x MINOR (bridge) | 2.0 |
| --- | --- | --- |
| `ConnectionLike` | Re-export of the 1.x type, identical | Reshaped (below) |
| `ConnectionFactory`, `ClientConfig` | Re-export, identical | Kept |
| `NativeCubridAdapter` | Re-export of the same class | Same class, new `ConnectionLike` shape |
| `CubridTransaction` | Re-export of the same class | Same class |
| `Binding`, `DriverStatement`, `DriverQueryOptions`, `DriverExecuteOptions`, `DriverStreamOptions`, `DriverQueryResult`, `DriverCapabilities` | Not present | New |

In the 1.x MINOR the root entry point keeps every name it has; the subpath only
adds a second path to the same types, so moving an import is never a breaking
change. 2.0 removes the SPI names from the root.

### The 2.0 `ConnectionLike`

```ts
interface DriverStatement { readonly sql: string; readonly params: StatementParams; readonly binding: Binding }

interface ConnectionLike {
  readonly capabilities?: { readonly bindings: readonly Binding[] }; // absent: ["literal"]
  connect(): Promise<void>;
  query(statement: DriverStatement, options: DriverQueryOptions): Promise<DriverQueryResult>;
  execute(statement: DriverStatement, options: DriverExecuteOptions): Promise<ExecuteResult>;
  executeMany?(sql: string, paramSets: readonly QueryParams[], options: ExecuteManyOptions): Promise<ExecuteManyResult>;
  stream?(statement: DriverStatement, options: DriverStreamOptions): AsyncIterable<QueryResultRow>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  setTransactionOptions?(options: TransactionOptions): Promise<void>;
  ping?(): Promise<string>;
  destroy?(): void;
}
```

- `query()` always returns rows with their columns; the client's `query()` drops
  the columns. That removes `queryResult` and the three prepared methods from the
  SPI: six statement methods become two, and ten optional members become five plus the optional `capabilities` declaration.
- The binding arrives resolved, and the client checks `capabilities.bindings`
  first, so a connection never decides on its own to fall back.
- `DriverStreamOptions` arrives with `fetchSize` and `consumerTimeout` already
  resolved, so a connection does not re-implement the defaults.
- How array rows (#255) cross the SPI is left to that work; the mock reserves
  `rowMode` in `DriverQueryOptions` and a discriminated `DriverQueryResult`.
- The pool's `SESSION_STATE` symbol stays internal and unexported, now declared
  only in the driver declarations.

### Package layout

```jsonc
"exports": {
  ".":        { "types": "./dist/index.d.ts",  "import": "./dist/index.js",  "require": "./dist/index.cjs" },
  "./driver": { "types": "./dist/driver.d.ts", "import": "./dist/driver.js", "require": "./dist/driver.cjs" },
  "./package.json": "./package.json"
},
"typesVersions": { "*": { "driver": ["./dist/driver.d.ts"] } },
"sideEffects": false
```

- **One layout for both entries.** Both use a single top-level `types`, as `"."`
  does today, so an ESM and a CJS consumer of either entry read the same
  declaration files. Splitting `import` and `require` types for one entry but not
  the other would let a CJS consumer under `node16` see `NativeCubridAdapter`
  from two declaration files, and two declarations of a class with private
  members are incompatible types. `api:check` keeps refusing a build whose `.d.ts`
  and `.d.cts` differ, for both entries.
- **Old resolvers.** `typesVersions` lets TypeScript with
  `moduleResolution: "node10"`, which ignores `exports`, find the subpath types.
- **Tree-shaking.** Both entries are built in one tsup run with code splitting,
  so shared code sits in a chunk both import. `sideEffects: false` is correct
  only after checking that no module has a top-level side effect; today the
  modules create symbols and constants only. The subpath does not make the root
  bundle smaller for a normal application, because `createClient()` uses the
  native adapter by default. Its purpose is the reviewed contract, not size.
- **Runtime identity.** `NativeCubridAdapter`, `CubridTransaction` and the error
  classes must be the same objects through either entry, or `instanceof` breaks.
  ESM code splitting gives that. For CJS the shared code must be one module that
  `index.cjs` and `driver.cjs` both `require`, not a copy in each. A packed-package
  test asserts it for both formats. Identity matters beyond `instanceof`: the
  pool reads the adapter's reuse state through `SESSION_STATE`, a plain
  `Symbol()` (`src/internals/session-state.ts`), and the bridge's prepared-stream
  capability marker would be one too. A duplicated module would create a second
  symbol, and the pool would silently fall back to its weaker reuse rule
  (ADR 0008). The test checks both symbols resolve to one module. (A process that
  loads both the ESM and the CJS build still has two copies, as today.)
- **Type identity.** Each shared type must be declared once and imported by both
  `.d.ts` files. Interfaces such as `ConnectionLike` are compared structurally,
  so a copy is harmless there, and `connectionFactory: () => new
  NativeCubridAdapter(config)` compiles either way. Classes with private members
  are not: with a copy per entry, `const a: NativeCubridAdapter` (root type) `=
  new NativeCubridAdapter(config)` (driver class) fails in the bridge release,
  and the same holds for `CubridTransaction` and every error class. A test on the
  packed package compiles such assignments across entries. The mock only shows
  the layout (`driver.d.ts` imports every shared type from `index.d.ts`); it
  cannot prove identity, because it has no private members and uses relative
  paths.
- **API check.** `api:check` gains a baseline `api/driver.d.ts`, compares
  `driver.d.ts` with `driver.d.cts`, and fails if the root declarations mention
  `SESSION_STATE`, `DriverAdapter`, any `src/protocol` type or any private member
  of the adapter.
- **What stays out of the root.** No protocol type (`CASConnection`,
  `PacketReader`, function codes, `SessionState`) is exported or declared through
  either entry; the driver entry declares the adapter's private members because
  the class is exported there, which TypeScript requires.

## Migration matrix

| 1.x code | 2.0 code | Can change during 1.x |
| --- | --- | --- |
| `db.queryPrepared<T>(sql, p)` | `db.query<T>(sql, p, { binding: "prepared" })` | Yes, after the bridge MINOR |
| `db.queryResultPrepared<T>(sql, p, o)` | `db.queryResult<T>(sql, p, { ...o, binding: "prepared" })` | Yes |
| `db.executePrepared(sql, p, { generatedKeys: true })` | `db.execute(sql, p, { generatedKeys: true, binding: "prepared" })` | Yes |
| Every call prepared | `createClient({ ..., binding: "prepared" })` | Yes |
| Every call literal, whatever the 2.0 default | `createClient({ ..., binding: "literal" })` | Yes |
| (no 1.x form) prepared stream | `db.stream(sql, p, { binding: "prepared" })` | Yes, after the bridge MINOR |
| `db.executeMany(sql, sets)` | Unchanged | n/a |
| `tx.queryPrepared(...)` in `transaction()` | `tx.query(..., { binding: "prepared" })` | Yes |
| `query(sql, [undefined])`, or a value that may be `undefined` | `query(sql, [value ?? null])` | Yes; works on 1.x |
| `buildWhere({ a: maybeUndefined })` | Drop the key or pass `null` (`IS NULL`) | Yes |
| `buildWhere(c).params` passed with a cast | No cast: `params` is `QueryParam[]`, and `conditions` must be `Record<string, QueryParam>` | No (type narrowed in 2.0) |
| `logger: anyObject` that is not a `ClientLogger` | Pass a `ClientLogger`, such as `console` | No (type narrowed in 2.0) |
| `query(sql, [someUint8Array])` | `Buffer.from(someUint8Array)` (unchanged rule) | n/a |
| `query(sql, [[1, 2]])` | Unchanged: refused; write `IN (?, ?)` with two values | n/a |
| `executePrepared(sql, [blob(x)])` | `execute(sql, [blob(x)], { binding: "prepared" })` | Yes, after the bridge MINOR widens the parameter type |
| `import type { PreparedQueryParam } from "cubrid-client"` | `StatementParam` (the old name stays an alias in 2.0) | Yes |
| `Queryable & ResultQueryable & Executable` | `StatementClient`, or `Pick<StatementClient, "query" \| "execute">` | No (new name in 2.0) |
| `PreparedQueryable`, `PreparedTransactionClient` | Remove; use `StatementClient` / `TransactionClient` | No |
| `(tx: ResultTransactionClient & ExecutableTransactionClient) => ...` | `(tx: TransactionClient) => ...` | No |
| A test double that `implements TransactionClient` with `query`, `commit`, `rollback` | Implement the 2.0 `TransactionClient`, or type the double as `Pick<TransactionClient, "query" \| "commit" \| "rollback">` | No |
| `import type { ConnectionLike, ConnectionFactory, ClientConfig } from "cubrid-client"` | `from "cubrid-client/driver"` | Yes, after the bridge MINOR |
| `import { NativeCubridAdapter, CubridTransaction } from "cubrid-client"` | `from "cubrid-client/driver"` | Yes |
| A custom `ConnectionLike` with `query(sql, params, options)` | `query({ sql, params, binding }, options)` returning `{ rows, columns }`; `execute` the same; declare `capabilities` if it binds on the server | No (shape changes in 2.0) |
| `Exclude<ClientOptions["ssl"], boolean \| undefined>` | `ClientSSLOptions` | Yes, after the bridge MINOR exports it |

**Custom connection, before and after.** A 1.x factory that forwards to an
existing driver:

```ts
// 1.x
import type { ConnectionLike } from "cubrid-client";
const conn: ConnectionLike = {
  connect: () => inner.open(),
  query: (sql, params) => inner.all(sql, params),
  execute: async (sql, params) => ({ affectedRows: await inner.run(sql, params) }),
  beginTransaction: () => inner.begin(), commit: () => inner.commit(),
  rollback: () => inner.rollback(), close: () => inner.end(),
};

// 2.0
import type { ConnectionLike } from "cubrid-client/driver";
const conn: ConnectionLike = {
  // omit capabilities: literal only, so the client refuses binding: "prepared"
  connect: () => inner.open(),
  query: async ({ sql, params }) => ({ rows: await inner.all(sql, params), columns: [] }),
  execute: async ({ sql, params }) => ({ affectedRows: await inner.run(sql, params) }),
  beginTransaction: () => inner.begin(), commit: () => inner.commit(),
  rollback: () => inner.rollback(), close: () => inner.end(),
};
```

**drizzle-cubrid.** No change is needed for this design: its structural
`query()` interface still accepts a 2.0 client and pool (checked by the compile
test). It should move off the deprecated `beginTransaction()`, `commit()` and
`rollback()` before a major removes them, which is a separate decision.

## Deprecation plan

| Name | Marked `@deprecated` in | Behavior in 1.x | Removed in |
| --- | --- | --- | --- |
| `queryPrepared`, `queryResultPrepared`, `executePrepared` on every surface | The 1.x MINOR after the bridge ships | Unchanged | 2.0.0 |
| `PreparedQueryable`, `PreparedTransactionClient` | Same | Unchanged | 2.0.0 |
| `ResultQueryable`, `Executable`, `BatchExecutable`, `Streamable`, `ExecutableTransactionClient`, `ResultTransactionClient`, `BatchTransactionClient` | Not deprecated in 1.x (no replacement name exists before 2.0) | Unchanged | 2.0.0, folded into `StatementClient` and `TransactionClient` |
| `ConnectionLike`, `ConnectionFactory`, `ClientConfig`, `NativeCubridAdapter`, `CubridTransaction` **imported from the root** | Same MINOR as the methods | Unchanged; the subpath exports the same types | 2.0.0 from the root; kept in `cubrid-client/driver` |
| The ten optional members of the 1.x `ConnectionLike` | 2.0.0 (shape change) | Unchanged | 2.0.0 |
| `PreparedQueryParam` | 2.0.0 (alias of `StatementParam`) | Unchanged | 3.0.0 |
| `undefined` as a parameter | Documented in the 2.0 notice; no runtime warning in 1.x | NULL | 2.0.0 refuses it |

Deprecation is JSDoc only: no runtime warning, no behavior change, no type change
(`@deprecated` does not make code fail to compile). The release note of that
MINOR carries the migration matrix above.

## SemVer release plan

| Release | Contents | Level | Why |
| --- | --- | --- | --- |
| 1.x (this PR) | ADR 0011, this design, the type mock | none | Documents only |
| 1.x MINOR "binding bridge" | `binding` on `QueryOptions`, `ExecuteOptions` and `StreamOptions`; `ClientOptions.binding`, default `"literal"`; `params` of `query`, `queryResult`, `execute` and `stream` widened to `readonly PreparedQueryParam[]`; `ExecuteManyOptions` (refuses `binding: "literal"`); schema reads pinned to literal; prepared streaming through the option; `ClientLogFields.binding`; the `cubrid-client/driver` subpath re-exporting the 1.x SPI; `ClientSSLOptions` exported | MINOR | Additive; defaults and existing signatures unchanged. Root entry unchanged. Ships only after the live prepared-stream tests |
| 1.x MINOR "deprecations" | `@deprecated` on the names in the deprecation plan; migration guide published | MINOR | No runtime or type change |
| 1.x PATCH/MINOR (independent) | #255 `rowMode: "array"`, #254 `outcomeUnknown` | As they decide | Additive; the 2.0 mock already composes with both |
| 2.0.0 | Remove `*Prepared` and the capability interfaces; SPI only in `cubrid-client/driver` and reshaped; refuse `undefined`; `buildWhere` and `logger` typed; binding default per the evidence gate; `timezone` default `"utc"` (ADR 0010); Node.js floor per ADR 0006, decided separately | MAJOR | Removals and changed defaults |
| 2.x MINOR (optional) | Compatibility adapter from a 1.x `ConnectionLike`, `Uint8Array` and collection parameters, `stream()` on transactions | MINOR | Additive, only if asked for |

**Pool coordination.** The pool (#92) is a statement surface and an SPI consumer,
so it changes in the same releases without a separate design: `PoolOptions`
inherits `binding`, `PoolConnection` becomes `StatementClient`, and the pool
calls the 2.0 `ConnectionLike` like the client does. Its reuse rule (ADR 0008)
does not change, because a prepared handle never outlives its call and the
deferred END_TRAN finishes inside the lease. A server-side statement cache would
make handles outlive calls and is out of scope; it would need its own ADR and a
new `SESSION_STATE` field before the pool could reuse such a session.

**Other 2.0 items.** ADR 0010 (UTC reads) and ADR 0006 (Node.js floor) are
independent decisions that happen to target the same major. The release
candidate's notes list each 2.0 change with its own migration, and the evidence
for each is reviewed separately.

## Type mock and how it is verified

- [`tests/v2-api-mock/index.d.ts`](../../tests/v2-api-mock/index.d.ts) mocks the
  2.0 root entry point, [`driver.d.ts`](../../tests/v2-api-mock/driver.d.ts) the
  driver entry point. Private class members are left out. The deprecated
  `CubridClient.beginTransaction()`, `commit()` and `rollback()` stay in the mock,
  because removing them is not part of this design.
- [`tests/v2-api-mock/consumer.ts`](../../tests/v2-api-mock/consumer.ts) is
  typical consumer code: a client with a default binding and per-call overrides,
  LOBs with generated keys, `executeMany()`, a prepared stream with a signal,
  array rows composed with binding, `transaction()` and a scope, `buildWhere()`
  passed straight to `query()`, `outcomeUnknown` handling, a pool with a leased
  stream, a drizzle-style structural interface, narrow library interfaces, a
  literal-only custom connection, a factory wrapping the native adapter, the
  adapter class used directly as a factory result, and the public client
  constructor. Thirteen `@ts-expect-error` lines prove what 2.0 rejects at compile
  time: the three `*Prepared` methods, an unknown binding, an inline `binding` on
  `executeMany()`, an array parameter, `undefined`, a LOB in `executeMany()`, a
  client constructor without arguments, and four SPI or removed names read from
  the root. If one of them stopped being an error, `tsc` would fail on the unused
  directive.
- [`tests/v2-api-mock/bridge.ts`](../../tests/v2-api-mock/bridge.ts) checks the
  1.x bridge MINOR against the **real** 1.x types from `src/index.ts`: 1.x
  options objects still fit the extended options, a 1.x `Queryable` test double
  still satisfies the widened parameter type, 1.x calls compile unchanged, a LOB
  statement can use `execute()` with `binding: "prepared"`, and a minimal 1.x
  `ConnectionLike` still compiles.
- `tsconfig.json` already includes `tests/**/*.ts`, so `npm run typecheck` (and
  `npm run check`) compiles all of it. Nothing imports it from `src/`, the build
  entry is still only `src/index.ts`, and `npm run api:check` still compares the
  built declarations with the unchanged `api/index.d.ts`.
- Limits. The repository sets `skipLibCheck`, so the mock `.d.ts` files are
  checked only through what `consumer.ts` uses; they were also compiled once with
  `skipLibCheck: false` without errors. The mock uses relative paths and has no
  private members, so it shows the declaration layout but cannot prove subpath
  resolution or class identity across entries; those need the packed-package
  tests listed under [package layout](#package-layout).

## Open questions

- Should `queryResult()` fold into `query()` with an option in 2.0 as well? Not
  proposed: it changes the return type by option, which `rowMode` already does
  once, and has no binding dimension.
- `Uint8Array` and `ZonedDateTime` parameters, and collection parameters through
  explicit wrappers: additive, any 1.x or 2.x MINOR, each with its own evidence.
- Whether a single request can carry typed binds, which would remove most of the
  prepared overhead (evidence gate item 5). Not verified on any server.
- `stream()` on `transaction()` and scopes: no use case has been reported.

## Review record

An independent architecture review of the first draft (2026-11-12) returned
**approve with changes**. It confirmed the 1.x inventory and the issue coverage,
and asked for these changes, all made in this revision:

- Prepared streaming: the stream's own `endReadTransaction()` would compete with
  the deferred END_TRAN of a prepared statement (commit before rollback on a
  FETCH failure, two END_TRAN requests on early stop, an error thrown out of
  `break`). The design now requires a prepared stream to skip it, and adds live
  tests for those cases. The abort semantics were corrected: a stream's signal
  does not retire the socket.
- Bridge MINOR: defined `executeMany()` with `binding` (`ExecuteManyOptions`,
  `"literal"` refused), widened the statement parameters so `blob()` and `clob()`
  can move off `executePrepared()` during 1.x, pinned schema reads to literal,
  specified option forwarding and direct adapter calls, and added a bridge
  compile test against the real 1.x types.
- Inventory: added the public `CubridClient` and `CubridPool` constructors and
  noted that npm dependents outside the organization were not searched.
- Driver entry: one `exports` layout for both entries, a corrected type-identity
  example, and `SESSION_STATE` and the stream-capability symbol in the
  runtime-identity test.
- Mock: constructors, the deprecated client methods, the adapter as a factory
  result, and a stated limit on what the mock can prove.
