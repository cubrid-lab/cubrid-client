# API stability and versioning

This policy applies to the **TypeScript/Node.js** package `cubrid-client`.
It is not a Python DB-API compatibility policy.

## Public contract

The public API consists of the package entry point defined by
`package.json` `exports`, exported JavaScript functions/classes/errors,
their documented runtime behavior, and the declarations distributed under
`dist/index.d.ts` / `dist/index.d.cts`. This includes:

- ESM `import` and CommonJS `require` behavior and the root package path.
- Public method names, arguments, return values, Promise rejection behavior,
  connection and transaction ownership, and observable error classes.
- The `name` values `UnsupportedValueError` and `MalformedReplyError` in the
  `cause` chain of a `QueryError`. Those classes are not exported, so their
  `name` is the contract for telling the two failures apart.
- Public TypeScript interfaces, generics and overloads used by consumers.
  `query<T>()` describes a result type at compile time; **it does not validate
  returned database values at runtime**.

The implementation's private class members, internal protocol types and
unexported helpers are not supported consumer entry points. A generated
declaration diff may include them; review compatibility based on the
consumer-visible change, not a textual diff alone.

## Semantic versioning for existing 1.x

The package follows SemVer with the following commitments.

| Change | Release level | Example |
| --- | --- | --- |
| Compatible behavior/correctness/security repair | PATCH | Throw a clear error when CAS FETCH fails rather than silently returning incomplete rows. |
| Backward-compatible public feature | MINOR | Add an optional `readTimeout` with an unchanged default behavior. |
| Incompatible public runtime or type contract | MAJOR | Remove/rename an exported function; narrow `query<T>()` parameters; change transaction behavior incompatibly. |
| Internal refactor without a public contract change | PATCH or no release | Replace an internal wire parser while preserving observable behavior. |

Do **not** introduce intentionally breaking project-specific extensions in a
1.x minor release. npm consumers can install 1.x minors with `^1.0.0`.
If a future MAJOR is needed, publish deprecation guidance, the replacement
API and a migration example in advance. There is no arbitrary 28-day
notice period; the notice/release plan is reviewed based on user impact.

Correcting behavior that previously produced invalid data can change the
observable outcome (for example, an error instead of a fabricated SQL
`null`). Document the bug, tests, and migration impact, and classify
the SemVer impact explicitly instead of assuming every fix is harmless.

### Transaction callback guards

The `tx` passed to a `transaction()` callback now allows exactly one terminal
outcome ([#109](https://github.com/cubrid-lab/cubrid-client/issues/109)). No API
was removed: `TransactionClient` is unchanged, `tx.commit()` and `tx.rollback()`
still work, and `CubridTransaction` keeps its constructor. `TransactionError`
gains the optional `rollbackError` and `closeError` properties. This is a
correctness repair, because the affected calls could silently break atomicity:

| Inside a callback | Before | Now | Migration |
| --- | --- | --- | --- |
| `tx.query()`, `tx.queryResult()` or `tx.execute()` after `tx.commit()` or `tx.rollback()` | Ran in **autocommit** and persisted on its own | Rejects with `TransactionError` | Run it before completing, or on `db.query()` |
| Second `tx.commit()` or `tx.rollback()` | Sent another END_TRAN to the server | Rejects with `TransactionError` | Complete once; remove the duplicate call |
| `tx.rollback()`, then resolve | Client sent a commit afterwards | No commit; resolves with the value | None |
| Swallowed `tx.commit()` failure, then resolve | Client committed again | Rolls back once and rejects | Handle the failure or let it propagate |
| Swallowed `tx.rollback()` failure, then resolve | Client **committed** | Rejects without a commit | Handle the failure or let it propagate |
| `tx` used after `transaction()` settled | The built-in adapter opened a new session and ran the statement in **autocommit** | Rejects with `TransactionError` | Await all work inside the callback |
| A query not awaited by the callback fails while the commit waits for it | Client committed the rest, with an unhandled rejection | Rolls back and rejects `transaction()` (since #244, when nothing observed the query, whenever it failed) | Await every statement; catch the error if the transaction may continue |
| Close fails after another failure | Close error replaced the original | `cause` is the original, `closeError` is set | Read `cause` |
| `beginTransaction()` fails | Rollback attempted anyway | No rollback is sent | None |
| `db.transaction()` after `db.close()` | Opened a new connection and ran the callback | Rejects with `TransactionError` and opens no connection | Start the transaction before closing, or create a new client |

Code that completes a transaction once and then returns or throws keeps working.
A failure the callback awaited and handled still commits. How a failure the
callback never observed is detected changed in #244; see
[unobserved statement failures](#unobserved-statement-failures).
A `CubridTransaction` you construct yourself keeps forwarding every call: only
the instance `transaction()` creates is guarded. Removing `commit()` and
`rollback()` from the callback's `tx`, if ever wanted, would be a MAJOR change
under the policy above.

### Unobserved statement failures

In 1.3.0 a failed statement the callback did not await stopped the commit only
if it failed within two microtask turns of the callback returning, an inference
from timing ([#244](https://github.com/cubrid-lab/cubrid-client/issues/244)).
The same code could commit or roll back depending on when the server replied.
Now the rule is whether code **observed** the statement's promise, by attaching
a rejection handler to it (`await`, `.catch()`, `Promise.allSettled()` and so
on), not when it failed
([ADR 0009](adr/0009-unobserved-statement-failures-roll-back.md)). No API was
added or removed and no type changed. Code that awaits its statements, caught
or not, behaves exactly as before. What changes is code that did not await a
statement, whose outcome used to depend on timing: it now has one outcome,
which is a **rollback** where nothing observed the failure and a **commit**
where a handler did, including handlers that do not really handle the error
(rows below). Proposed as a correctness repair in a MINOR, like #109; because
some of these cases move from rollback to commit, it needs explicit maintainer
acceptance.

| Inside `transaction()` | 1.3.0 | Now |
| --- | --- | --- |
| A failure awaited and caught (`try`/`catch`, `.catch()` awaited), then more work | Committed | Committed (unchanged) |
| `await Promise.allSettled([...])` or a caught `Promise.all([...])` with a failure | Committed | Committed (unchanged) |
| `void tx.query(sql)` that fails while the commit waits for it | Rolled back | Rolled back (unchanged) |
| `void tx.query(sql)` that fails before the callback's last step | Committed, with an unhandled rejection | **Rolled back**, no unhandled rejection |
| `tx.query(sql).catch(handler)`, not awaited, fails before the callback returns | Committed | Committed (unchanged) |
| The same, failing after the callback returned | Rolled back | **Committed**: the handler observed it |
| Not awaited and observed without being handled: `.finally()`, `void Promise.all([...])`, `void Promise.resolve(p)`, `.then(f, (e) => { throw e })`, or a fire-and-forget `(async () => { await tx.query(sql) })()`, failing after the callback returned | Rolled back | **Committed**, and Node.js reports the derived promise's rejection |
| The same, failing before the callback's last step | Committed, with an unhandled rejection | Committed, with an unhandled rejection (unchanged) |
| An unobserved failure, then the callback throws | Rolled back; an unhandled rejection unless it failed late | Rolled back, no unhandled rejection |
| A statement issued after an explicit `tx.commit()` | Refused; the commit stands | Refused; the commit stands (unchanged) |
| A statement issued after the callback returned, while the client commits for it | Refused; the rest committed without it | Refused. Best effort: when a handler of a statement the commit was waiting for issued it directly, the commit is refused too (rollback); deeper in a chain, the rest is committed without it, as before |

The migration is to await every statement or attach a handler where a failure
is acceptable. Code that awaited and caught its failures needs no change.
`beginTransactionScope()` follows the same rule; it is not in 1.3.0.

### Isolation level and lock timeout

`isolationLevel` and `lockTimeout` on `ClientOptions`, the optional second argument
of `transaction()`, and the optional `ConnectionLike.setTransactionOptions()` are
additive, so this is a MINOR change. Without the options nothing new is sent and the
server's defaults apply as before. `TransactionClient`, `ExecutableTransactionClient`
and `ResultTransactionClient` are unchanged, and a 1.x connection factory keeps
working as long as no setting is requested. Requesting one from a connection without
`setTransactionOptions()` fails rather than running without it. The accepted levels
and the meaning of `lockTimeout` are public behavior; see
[Isolation Level and Lock Timeout](CONNECTION.md#isolation-level-and-lock-timeout).

### Streaming additions

`stream()`, its `StreamOptions` and `Streamable` types, and the `fetchSize` client
option are a backward-compatible MINOR feature
([#87](https://github.com/cubrid-lab/cubrid-client/issues/87)). `query()` and
`queryResult()` keep their signatures, return arrays and send the same fetch size by
default. `ConnectionLike.stream` is optional, so existing connection factories still
compile, and `TransactionClient` is unchanged. `CubridErrorKind` gains
`"stream-busy"`, which only `stream()` can cause; a `switch` over that type that
checks for exhaustiveness at compile time needs a case for it.

The `stream-busy` limit is part of the contract. A statement waits as long as the
consumer keeps reading, and a consumer that stops cannot make a statement wait for
ever: `consumerTimeout` can be raised but not disabled.

### Date and time zone default

`timezone` defaults to `"local"` for every 1.x release: DATE, TIME, TIMESTAMP and
DATETIME are read in the Node.js process zone, while `Date` parameters are written
as UTC fields. Changing the default to `"utc"` changes the instant every such value
decodes to on a host that is not on UTC, without a type change, so it is a MAJOR
change. It is proposed for 2.0 in
[ADR 0010](adr/0010-utc-temporal-default-in-2-0.md), with `"local"` kept as an
explicit setting; set `timezone` explicitly now to be unaffected.

### Unknown outcomes

`outcomeUnknown` on `CubridErrorDetails`, and so on `ConnectionError`, `QueryError`,
`TransactionError` and their subclasses, is an additive MINOR change
([#254](https://github.com/cubrid-lab/cubrid-client/issues/254)). It is optional:
errors the driver raises carry `true` or `false`, and an error it did not classify,
such as one from a custom connection, has none. No class, `kind`, message or `cause`
changes, and an abort still rejects with the caller's `signal.reason` unchanged. A
required property, wrapped abort reasons or a richer outcome than a boolean are left
to a 2.0 decision. The mapping from each failure to its value is public behavior;
see [Unknown outcomes](API_REFERENCE.md#unknown-outcomes).

### Binding methods and the driver interface in 2.0

The `*Prepared` methods, the capability interfaces such as `PreparedQueryable`,
and the driver interface (`ConnectionLike` and the types around it) exported from
the root are unchanged for every 1.x release. A 2.0 plan replaces the method
variants with one `binding: "literal" | "prepared"` option and moves the driver
interface to a `cubrid-client/driver` entry point, after additive 1.x MINOR
releases that let callers migrate first. It is proposed in
[ADR 0011](adr/0011-v2-binding-option-and-driver-subpath.md), with the
migration matrix and release plan in the [v2 API design](design/v2-api.md).

For the complete 1.x line, Node.js 18 and 20 are retained even though they are upstream EOL. [ADR 0006](adr/0006-node-18-support-through-1x.md) records the explicit Node 18 release commitment and independent Node 18 **packed-package** test requirement. A higher Node minimum is reserved for a possible, separately reviewed 2.0 MAJOR, not a 1.x development-tooling update.

## Node.js, TypeScript and distribution

- **Current runtime declaration:** `engines.node >=18` in
  `package.json`, with Node 18/20/22/24/26 CI. A successful CI build is not a
  substitute for a packaged ESM/CJS consumer smoke test.
- **Changing the Node.js runtime floor:** raising it above 18 excludes
  previously supported installations and therefore requires a **major
  release** under this 1.x contract, with prior notice and migration steps.
  Node.js reaching end-of-life is a reason to plan a change, not permission
  to change the existing npm contract silently.
- <a id="nodejs-support-schedule"></a>**Node.js support schedule:** Node.js 18 (end-of-life April 2025) and 20
  (end-of-life April 2026) are deprecated but remain supported for all 1.x
  releases; no 1.x release raises `engines.node`. The next 1.x release
  notes announce this deprecation. The removal of Node 18 and 20 support is a
  candidate for a future 2.0 major release, with its own notice and migration steps; no 2.0 date is
  set and the maintainers have not yet decided it. CI tests every currently
  supported Node.js line (22, 24 and 26 LTS) and the retained Node 18 and 20
  lines. `@types/node` stays at the lowest supported major (18) so type
  declarations do not use newer Node APIs; do not merge an `@types/node`
  major bump until the Node 18 floor is raised. See the
  [Node.js release schedule](https://nodejs.org/en/about/previous-releases).
- **Build tool vs consumer support:** tsup, TypeScript and other
  devDependencies may need a newer Node version to *build*; this does not
  automatically raise the minimum runtime for the published JavaScript.
  Verify emitted packages on every advertised runtime independently.
- **TypeScript compatibility:** `typescript` in `devDependencies`
  identifies a development tool, not a tested minimum for consumers. Do not
  advertise an explicit compiler minimum until a consumer declaration test
  demonstrates it. Review declaration syntax/type changes for compatibility;
  announce any intentionally raised tested compiler floor.

## Release review

1. Inspect PR changes and the exact emitted `exports`, `.d.ts` and
   `.d.cts`. Run `npm run build && npm run api:check`. For intended public
   changes, commit a reviewed `api/index.d.ts` baseline update.
2. Classify both runtime and type-level differences as PATCH, MINOR, or
   MAJOR. A passing textual API check cannot decide that classification.
3. Verify ESM/CJS imports and the real CUBRID version/type scenarios the
   release claims. Database-dependent tests that self-skip **do not count**
   as live validation.
4. Review the Release Please-generated changelog and curated, emoji-free
   `docs/releases/vX.Y.Z.md` note. Document known limitations and the
   migration path for any change that may affect callers.
5. Publish only after the separate release gate is satisfied. See
   [the release process](RELEASE_PROCESS.md) and [release validation issue](https://github.com/cubrid-lab/cubrid-client/issues/120).

The ABI or code shape of the historical `node-cubrid` driver is not a
promise of source-level API equivalence with this package. Protocol
behavior parity is validated separately.
