# ADR 0008: A pooled connection is reused only when its session is clean

- **Status:** Proposed
- **Date:** 2026-11-12
- **Scope:** `createPool()` and `CubridPool`: when a leased connection goes back to the pool and when it is closed instead
- **Issue:** [#92](https://github.com/cubrid-lab/cubrid-client/issues/92)
- **Prerequisites:** [ADR 0007](0007-manual-transaction-ownership.md) (a transaction owns a dedicated connection)

## Context

A pool hands the same CUBRID session to one caller after another. Whatever the
previous caller left on that session reaches the next one. On CUBRID 10.2 to
11.4 the dangerous leftovers are:

- **An open transaction.** The adapter keeps autocommit on the client side. A
  session whose transaction was never ended, or whose transaction the server
  aborted without the caller acknowledging it, would make the next caller's
  autocommit statement part of that transaction, or commit the previous
  caller's uncommitted work with it.
- **Work still in flight.** A stream cursor that is still open, a statement
  queued on the adapter or a call the caller never awaited holds or waits for
  the session's turn. The next caller's statements would wait behind it, or run
  between its requests.
- **A request with an unknown outcome.** After a read timeout or an abort on the
  wire, the socket is retired and the outcome of the request on the server is
  unknown (`failedExchanges` counts these). The adapter would open a new session
  on the next statement, but the pool cannot tell the next caller what the old
  one did.
- **Transaction settings other than the pool's.** `setTransactionOptions()` merges
  into the connection's settings and the server keeps them for every later
  session of that connection. There is no call that restores "the server
  default" for a setting the pool never set.

Session variables (`SET @v = ...`) set in autocommit mode also survive on a
reused session, as they would on the client's shared connection, and so do an
isolation level or lock timeout changed with SQL (`SET TRANSACTION ...`), which
the adapter does not track. The live test
"a clean session is reused, session variables included" records this; the pool
does not reset them.

## Decision

When a lease ends, the pool reads the session state synchronously and **closes
the connection, never rolling it back to reuse it**, if any of these hold:

| Condition | `pool.destroy` reason |
| --- | --- |
| The transaction could not be ended cleanly: `transaction()` or a scope whose rollback failed, or a scope discarded by `close()` | `in-transaction` |
| `transaction()` or `beginTransactionScope()` failed before its transaction began, so its settings may be half applied | `error` |
| `inTransaction`: `!autoCommit`, a session bound to a transaction (`transactionGeneration !== null`) or an unacknowledged server abort (`transactionAbort !== null`) | `in-transaction` |
| A call made through the lease has not settled, or `busy`: an open stream cursor, a stream holding the turn (`heldBy`) or a queued statement | `busy` |
| `failedExchanges` rose during the lease | `failed-exchange` |
| No open session (`connected` is false) | `error` |
| The lease applied per-call `TransactionOptions` that differ from the pool's | `options` |
| The connection is older than its `maxLifetimeMs` (up to 10% shorter per connection) | `lifetime` |

The state comes from one internal method of `NativeCubridAdapter`, keyed by a
module-private symbol (`src/internals/session-state.ts`), so it adds nothing to
`ConnectionLike`. `withLogging` forwards it. A custom `ConnectionLike` without
it cannot report its state, so its connection is reused only after a lease in
which every call succeeded, and closed (`error`) otherwise.

A rollback is never used to clean a session for reuse: a rollback that fails, or
whose own outcome is unknown, would leave exactly the state the rule exists to
exclude. A transaction the caller ended with a successful rollback is clean and
is reused.

Connections are handed out first-in first-out, and a released connection goes
straight to the first waiting caller. `close()` rejects waiting callers, closes
idle connections and stream connections, waits for statements, `connection()`
callbacks and `transaction()` callbacks, and discards open scopes concurrently
with that wait.

## Alternatives considered

- **Roll back on release, then reuse.** Rejected: a failed rollback is the state
  the rule must exclude, and an unknown rollback outcome cannot be detected
  before the next caller uses the session.
- **Reset with a fresh `setTransactionOptions()` call.** Rejected: settings merge,
  and a setting the pool did not configure cannot be returned to the server's
  default.
- **Ping or `CHECK_CAS` before every lease.** Kept optional
  (`validateAfterIdleMs`). The adapter already probes a session that said its
  transaction ended before sending on it and replaces it if its CAS is gone, so
  a CAS that dropped an idle session costs no failed statement.
- **Discard scopes after the other leases end on `close()`.** Rejected: a
  statement or transaction may be waiting for a lock that only the forgotten
  scope holds, and with an unlimited lock timeout `close()` would never end. The
  client's `close()` discards scopes concurrently for the same reason (ADR 0007).

## Consequences and trade-offs

- A caller that aborts a statement or hits a read timeout costs the pool one
  connection and one new handshake. This is deliberate.
- Per-call transaction options on a pool cost a connection per transaction. Set
  them on the pool instead.
- Session variables and other session state set in autocommit mode survive on a
  reused connection, including transaction settings changed with SQL.
- `close()` awaited inside a running `connection()` or `transaction()` callback
  waits for no callback lease (the enclosing callbacks are found by an
  `AsyncLocalStorage`), as `CubridClient.close()` does (#246). Waiting for every
  lease but its own was not enough: two callbacks that each awaited `close()`
  waited for each other forever (#268). It still waits for statements and
  discards scopes; a `close()` from outside every callback waits for all the
  callbacks running when `close()` was first called. A `transaction()` whose
  callback has not started when the pool closes is rolled back without running
  it, as in the client. An inside `close()` that waits for a statement blocked
  on the closing callback's own lock waits until the statement's `readTimeout`
  or `signal` ends it.
- The method is internal and not part of the 1.x contract; a custom connection
  cannot opt in.

## Verification / acceptance criteria

- [x] Offline tests for each reason, for the custom-connection rule, for FIFO
  order without barging, `max` under 1000 concurrent callers, timeouts, aborts,
  `maxWaitingClients` and `close()` racing a wait, an open and a transaction,
  and `close()` awaited inside one or two callbacks, nested or not
  (`tests/pool.test.ts`).
- [x] A stub CAS over TCP: a CAS that drops an idle session is replaced in place,
  validation replaces a dead one, and a statement with an unknown outcome closes
  its connection (`tests/pool.test.ts`).
- [x] Live CUBRID: a session lost inside a transaction is not reused (its session
  variable is undefined and its row is gone on the next lease), a stream holds
  its session while a query in the loop uses another, concurrency stays within
  `max`, and `close()` drains (`tests/integration.test.ts`, "connection pool
  (#92)"; run locally on 11.4 and 10.2).
- [ ] Record explicit maintainer acceptance in a reviewed PR.

## References

- `src/client/pool.ts`, `src/client/connection-source.ts`, `src/internals/session-state.ts`
- [API reference: CubridPool](../API_REFERENCE.md#cubridpool)
- [ADR 0007](0007-manual-transaction-ownership.md)
