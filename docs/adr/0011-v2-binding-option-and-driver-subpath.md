# ADR 0011: Choose binding with one option and move the driver SPI to its own entry point in 2.0

- **Status:** Proposed (2.0 planning; no 1.x change in this record)
- **Date:** 2026-11-12
- **Decision scope:** how a statement chooses between SQL literals and server-side typed binds, how prepared streaming is offered, which entry point exports the driver service provider interface (`ConnectionLike` and the types around it), and the deprecation and SemVer plan that gets 1.x users there
- **Issue:** [#249](https://github.com/cubrid-lab/cubrid-client/issues/249)
- **Design:** [v2 API design](../design/v2-api.md) (inventory, value behavior matrix, migration matrix) and the compile-tested type mock in [`tests/v2-api-mock/`](../../tests/v2-api-mock/)
- **Prerequisites:** [ADR 0001](0001-release-governance.md) (SemVer), [API stability](../API_STABILITY.md) ([#98](https://github.com/cubrid-lab/cubrid-client/issues/98), [#132](https://github.com/cubrid-lab/cubrid-client/issues/132)), [ADR 0008](0008-pool-reuse-invariant.md) (pool reuse), [ADR 0010](0010-utc-temporal-default-in-2-0.md) (the other 2.0 default change)

## Context

The 1.x API chooses the binding by method name. `query()`, `queryResult()` and
`execute()` render parameters into SQL text; `queryPrepared()`,
`queryResultPrepared()` and `executePrepared()` ([#85](https://github.com/cubrid-lab/cubrid-client/issues/85))
send PREPARE and EXECUTE with typed binds. `stream()` has no prepared form, and
`executeMany()` ([#86](https://github.com/cubrid-lab/cubrid-client/issues/86)) is
always prepared. Every surface that offers statements repeats the six methods:
`CubridClient`, `CubridPool`, `PoolConnection`, `CubridTransaction`, the `tx` of
`transaction()` and `TransactionScope`. Adding a prepared stream the same way would
add a seventh method to each, and any later axis (array rows,
[#255](https://github.com/cubrid-lab/cubrid-client/issues/255), in progress)
multiplies again.

The driver service provider interface grew the same way. `ConnectionLike` has six
required members and ten optional ones (`queryResult`, `execute`, the three
prepared methods, `executeMany`, `setTransactionOptions`, `stream`, `ping`,
`destroy`), each optional only so a 1.x `connectionFactory` keeps compiling. It is
exported from the root entry point next to the application API, as are
`ConnectionFactory`, `ClientConfig`, `NativeCubridAdapter` and the
`CubridTransaction` class. Because `NativeCubridAdapter` is exported, the root
declarations also carry two internal names, the `DriverAdapter` interface and the
`SESSION_STATE` symbol the pool reads (ADR 0008), and its 76 private members.

Verified facts this decision relies on:

- Prepared binding converts some values differently from literals: fractions
  are DOUBLE rather than NUMERIC, unsafe integers keep their bits, an empty
  `Buffer` is refused, a fraction bound to TIME is rounded, an ENUM misfit is
  `-181` rather than `-494` ([types: prepared binding](../TYPES.md#prepared-binding)).
- In autocommit mode a prepared call sends four requests (PREPARE, EXECUTE,
  END_TRAN, handle release) where a literal call sends two; reads measured
  0.3 to 0.4 ms slower on a loaded host ([performance](../PERFORMANCE.md#prepared-binding)).
- The native adapter already routes `stream()` through the same `runStatement()`
  that the prepared methods use, and a prepared statement's deferred END_TRAN
  runs after the stream's last window, so the cursor is not closed early
  (`src/adapters/native.ts`, `streamNow()` and `runOnSession()`). But
  `streamWindows()` also ends an autocommit read itself with
  `endReadTransaction()` when a stream stops early or read a LOB, checking only
  `autoCommit`; a prepared stream must skip that, as `executeQuery()` already
  does for prepared statements, or it would commit before a rollback and send
  two END_TRAN requests. No prepared stream has been tested against a server.
- The only downstream package in the organization, drizzle-cubrid, depends on
  `cubrid-client ^1.0.0`, imports only the `CubridClient` type, and calls
  `query()` through its own structural interface plus the deprecated
  `beginTransaction()`, `commit()` and `rollback()`.

## Decision

1. **One binding option.** 2.0 removes the three `*Prepared` methods and the
   `PreparedQueryable` and `PreparedTransactionClient` interfaces. Every statement
   method takes `binding?: "literal" | "prepared"` in its options, and
   `ClientOptions.binding` sets the default for a client or pool. A statement
   resolves its binding from the per-call option, then the client option, then
   the library default, and the resolved value is logged.
2. **Binding never changes which values are accepted, only how they travel,**
   with two exceptions that exist on the wire: `blob()` and `clob()` need
   `"prepared"` (a TypeError before anything is sent under `"literal"`), and an
   empty `Buffer` is refused under `"prepared"` because the broker reads it as
   NULL. The full matrix, including `undefined`, binary, dates, collections, text
   encoding and LOBs, is in the [design](../design/v2-api.md#value-behavior-by-binding).
   2.0 refuses `undefined` on both bindings, where 1.x sends NULL.
3. **The 2.0 default is decided by evidence, not by this record.** `"prepared"`
   becomes the default only if every item of the
   [evidence gate](../design/v2-api.md#evidence-gate-for-a-prepared-default) is met
   and accepted before 2.0.0 is cut: type coverage, charset behavior, session
   ownership, performance and downstream compatibility. Otherwise 2.0 ships with
   `"literal"` as the default and the option alone; changing the default later
   is itself a MAJOR change.
4. **Prepared streaming is `stream(sql, params, { binding: "prepared" })`**, not a
   `streamPrepared()` method, in 1.x and 2.0 alike. A dedicated method would be
   safe at the protocol level, provided the deferred END_TRAN alone ends a
   prepared stream's transaction, but would be deprecated by the next major as
   soon as it shipped.
5. **The driver SPI moves to `cubrid-client/driver`.** It exports
   `ConnectionLike`, `ConnectionFactory`, `ClientConfig`, `NativeCubridAdapter`,
   `CubridTransaction` and the statement and capability types they use. The 2.0
   `ConnectionLike` has two statement methods, `query()` and `execute()`, that
   receive the resolved binding, five optional methods and an optional
   `capabilities` declaration. A connection
   declares the bindings it supports, and the client refuses a binding the
   connection does not declare instead of letting it fall back. The root entry
   point exports no SPI type; `ClientOptions.connectionFactory` refers to it as
   a type only. Both entry points share one declaration and one runtime module
   for every shared type and class.
6. **Release order.** A 1.x MINOR adds `binding` (default `"literal"`), widens
   the parameters of `query()`, `queryResult()`, `execute()` and `stream()` to
   accept `blob()` and `clob()`, adds prepared streaming through the option, and the `cubrid-client/driver` subpath re-exporting the
   1.x SPI unchanged. A later 1.x MINOR marks the `*Prepared` methods and the
   root SPI exports `@deprecated`, with no runtime change. 2.0.0 removes them.
   The pool takes the same option in the same releases and is otherwise
   unaffected. The plan is in the [design](../design/v2-api.md#semver-release-plan).

## Alternatives considered

- **Keep the method names and add `streamPrepared()` in 1.x.** Smallest step, and
  safe on the wire (see the design). Rejected because it grows every statement
  surface again and becomes a deprecation before 2.0 exists; the option gives
  1.x users the same capability with a name that survives the major.
- **Flip the default to `"prepared"` in 2.0 unconditionally.** Rejected: the
  value conversions above change results without a type error, every read costs
  two more requests in autocommit mode, and DDL and other statements whose
  markers the server does not accept as host variables would start failing.
  Those are acceptable only with recorded evidence.
- **Type the parameters by binding** (overloads so `blob()` is a compile error
  under `"literal"`). Rejected for now: the binding often comes from the client
  default, which the method signature cannot see without making `CubridClient`
  generic, and the overloads would multiply with `rowMode`. The run-time
  TypeError before anything is sent is kept.
- **Infer prepared binding when a parameter is a `blob()` or `clob()`.** Rejected:
  the other parameters of that statement would silently change conversion.
- **Leave the SPI in the root entry point and only shrink it.** Rejected: the root
  declarations would still carry the adapter's internals, and every SPI change
  would remain an application-API change in review.
- **Ship a compatibility adapter from 1.x `ConnectionLike` to the 2.0 shape.**
  Deferred: the migration is mechanical (see the design), and a shim would keep
  the ten optional methods alive. It can be added in a 2.x MINOR if users ask.

## Consequences and trade-offs

- Applications that call `*Prepared` must change each call in 2.0; the change is
  mechanical and can be made during 1.x once the option ships.
- Custom connection factories must be rewritten for the 2.0 `ConnectionLike`
  shape. They can move their imports to `cubrid-client/driver` during 1.x, where
  the types are identical, so only the shape change waits for 2.0.
- One more package entry point to build, check and document: the API check must
  cover `driver.d.ts`, and ESM and CJS must share class identity across entries.
- If the evidence gate fails, 2.0 still removes the method variants, and the
  prepared default waits for a later major.
- The 1.x behavior of `undefined` (NULL) becomes an error, which can surface
  latent bugs, for example `buildWhere({ a: undefined })` comparing with `= NULL`.

## Verification / acceptance criteria

- [x] A type mock of both 2.0 entry points and a consumer compile test run under
      `npm run typecheck` (`tests/v2-api-mock/`), including the rejected 1.x names
      and misuses as expected errors.
- [x] A compile test of the 1.x bridge MINOR against the real 1.x types
      (`tests/v2-api-mock/bridge.ts`) shows the additions are compatible.
- [x] The published 1.x API is unchanged: `npm run api:check` passes against
      `api/index.d.ts`.
- [ ] Every item of the evidence gate is recorded with exact server versions
      before the 2.0 default is chosen.
- [ ] Prepared streaming is verified on a live CUBRID server (cursor lifecycle,
      early stop, errors, abort, transactions, pool lease) before the 1.x MINOR
      ships it.
- [ ] The packed package resolves `cubrid-client/driver` for ESM, CJS, and
      TypeScript with `moduleResolution` `node16`, `bundler` and `node10`, and
      `instanceof` holds across entry points.
- [ ] drizzle-cubrid's tests pass against the 2.0 release candidate.
- [ ] Explicit maintainer acceptance in a reviewed PR.

## References

- [v2 API design](../design/v2-api.md), [type mock](../../tests/v2-api-mock/)
- [Types: sending parameters and prepared binding](../TYPES.md#sending-javascript-parameters)
- [Performance: prepared binding](../PERFORMANCE.md#prepared-binding)
- [API stability](../API_STABILITY.md), [ADR 0006](0006-node-18-support-through-1x.md), [ADR 0010](0010-utc-temporal-default-in-2-0.md)
- Issues [#85](https://github.com/cubrid-lab/cubrid-client/issues/85), [#86](https://github.com/cubrid-lab/cubrid-client/issues/86), [#87](https://github.com/cubrid-lab/cubrid-client/issues/87), [#92](https://github.com/cubrid-lab/cubrid-client/issues/92), [#112](https://github.com/cubrid-lab/cubrid-client/issues/112), [#254](https://github.com/cubrid-lab/cubrid-client/issues/254), [#255](https://github.com/cubrid-lab/cubrid-client/issues/255)
