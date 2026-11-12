# ADR 0009: A failed statement nothing observed rolls a transaction back, whenever it failed

- **Status:** Proposed
- **Date:** 2026-11-12
- **Decision scope:** how a failed statement affects the outcome of a `transaction()` callback and of a `beginTransactionScope()` commit
- **Issue:** [#244](https://github.com/cubrid-lab/cubrid-client/issues/244)
- **Prerequisites:** [ADR 0001](0001-release-governance.md) (SemVer), [ADR 0007](0007-manual-transaction-ownership.md) (amended here), issue [#109](https://github.com/cubrid-lab/cubrid-client/issues/109)

## Context

The fix for #109, released in 1.3.0, refused the commit when a statement the
callback did not await failed while the commit waited for it. It still had to
let a failure the callback had awaited and caught commit, so it guessed from
timing. `rememberRejection()` kept a rejected statement in `justRejectedQueries`
for two `queueMicrotask()` turns, and `finish()` treated anything still there as
running. The published documentation admitted that a statement that was not
awaited and rejected before the callback's last `await` resumed "cannot be
detected" and was committed past. The same code could therefore commit or roll
back depending on when the server replied.

JavaScript cannot tell whether a rejection was *semantically* handled. It can
tell, exactly, whether code attached a handler to a promise: every way of
consuming a rejection (`await`, `.catch()`, `.then(f, g)`, `.finally()`,
`Promise.all()` and its siblings, `Promise.resolve()`, returning it from an
async function) ends in a call to that promise's `then()` with a rejection
handler, and for a promise whose constructor is not `Promise` a native `await`
does so too, through thenable assimilation. Whether such a call happened is a
property of the caller's code, not of when the statement settles.

Catching a failed statement and carrying on is the most common 1.x pattern
(insert, and update on a duplicate key) and is legal in CUBRID and JDBC: a
failed statement leaves the transaction open with its earlier statements intact.
The repository's own live tests and the JDBC parity runner rely on it.

## Decision

**A failed statement stops the commit if and only if nothing observed it.** A
statement is observed when a rejection handler was attached to the promise it
returned, directly or further down a chain of `then(onFulfilled)` calls.

1. Each statement method of the callback's `tx` and of a `TransactionScope`
   returns an internal `Promise` subclass whose `then()` marks the statement
   observed when it receives a rejection handler. A `then()` without one passes
   the mark on to the derived promise, so `tx.query(sql).then(f).catch(g)` is
   observed and `tx.query(sql).then(f)` alone is not. The subclass is not
   exported and the return types stay `Promise<T>`.
2. Every statement settles before COMMIT or ROLLBACK is sent (as since #109), so
   END_TRAN is always the last thing sent on the connection. Only then is the
   outcome decided: the first statement **in issue order** that failed and was
   not observed refuses the commit, which rolls back and rejects with that
   statement's error, as 1.3.0 did for a statement still running.
3. The client marks each statement promise handled without observing it, so an
   unobserved failure is reported by the commit it refuses and never also as a
   process-level unhandled rejection.
4. The callback's own error, `tx.rollback()`, rollback and close failures, and
   `-72` / lost-connection handling are unchanged.
5. An explicit `tx.commit()` keeps the 1.x rule for statements issued after it:
   they are refused and the commit stands. While the client commits on behalf
   of a callback that already returned, a statement refused before the outcome
   is decided also refuses the commit: work the callback left running would
   otherwise be committed without it. This is best effort. The decision comes a
   few microtask turns after the last statement settles, so it catches a
   statement issued directly by a handler of that statement (where 1.3.0 also
   rolled back), not one issued further down a chain or after another `await`,
   which is refused while the commit stands, as in 1.3.0.
6. No public API is added or changed.

| Case | Server sees | `transaction()` |
| --- | --- | --- |
| Awaited and caught, then more work | COMMIT | Resolves |
| `await Promise.allSettled([...])` / caught `Promise.all([...])` | COMMIT | Resolves |
| Detached `.catch(handler)` | COMMIT | Resolves |
| `void tx.query(bad)`, or a promise never touched | ROLLBACK | Rejects, `cause` is the failure |
| `tx.query(bad).then(f)` with no rejection handler further down | ROLLBACK | Rejects; Node.js reports the derived rejection |
| Still running when the callback returns | Waited for, then as above | As above |
| Callback throws | ROLLBACK | Rejects, `cause` is the callback's error |
| `tx.commit()` after an unobserved failure | ROLLBACK; `commit()` rejects | Rejects |
| Statement after an explicit `tx.commit()` | Refused; COMMIT stands | As the commit |
| Statement issued directly by a handler after the callback returned (best effort, see 5) | Refused; ROLLBACK | Rejects |

Every row but the last is the same whether the statement fails before the
callback returns or after it. Work that runs after the callback returned, such
as a detached handler that sends a fallback statement, is outside that
guarantee: the issue's "same outcome in both schedules" criterion is met for
the callback's own code and documented as an exception for such work.

## Alternatives considered

- **(a) Any failure poisons the transaction unless acknowledged with a new
  `tx.acknowledge()`.** Implemented and reviewed first, then rejected: it turns
  every awaited-and-caught failure, the most common 1.x pattern, into a
  rollback. Three live tests and the JDBC parity runner needed migrating, which
  is the compatibility break a 1.x minor cannot make (AGENTS.md, ADR 0001).
- **(b) without observation: the callback's result alone decides.** Fails open:
  `void tx.query(bad)` would commit the rest, weakening what 1.3.0 already
  refused for a failure arriving late.
- **A timer, or more microtask turns.** Rejected by the issue: any interval only
  moves the boundary where the outcome flips.
- **Refuse the commit only for statements still pending when the callback
  returns.** Still timing-dependent: a 10 ms difference in a reply moves a
  statement across that boundary.
- **Treat `.finally()` or `Promise.all()` as not observing.** They do attach a
  rejection handler, and distinguishing them would mean guessing what a handler
  does with the error. A handler that observes and then leaves its own promise
  rejected is reported by Node.js like any other unhandled rejection.

## Consequences and trade-offs

- Awaited-and-caught failures commit exactly as in 1.3.0; existing tests, the
  three live tests that catch and continue, and the JDBC parity runner pass
  unmodified.
- A failure that was not observed now always rolls back. In 1.3.0 it committed
  when it failed before the callback's last step (with an unhandled rejection).
- A detached `.catch()` now always commits. In 1.3.0 it rolled back when the
  failure arrived after the callback returned.
- `.finally()`, `Promise.all()` or `Promise.resolve()` left unhandled, a
  rethrowing `onRejected` and a fire-and-forget async wrapper count as
  observation, so the commit goes ahead and Node.js reports the derived
  rejection; the client does not judge what a handler does. In 1.3.0 these
  rolled back when the failure arrived after the callback returned, so some
  outcomes move from rollback to commit. This is the price of keeping
  awaited-and-caught failures committing without a new API, and it needs
  explicit maintainer acceptance.
- Observation goes through the promise's own `then()`. A library that calls
  `Promise.prototype.then.call()` on it bypasses that and the failure counts as
  unobserved (the safe direction). `promise.constructor` is no longer `Promise`.
- Code still running after the callback returned (a detached chain that issues
  another statement) is outside the timing guarantee, because whether it runs
  before the decision depends on replies. It fails closed while the outcome is
  undecided; a statement issued after a commit decision is refused, as since #109.
- Each `await` on a statement promise takes extra microtask turns, because a
  subclass is assimilated through `then()`.
- `beginTransactionScope()` (not in 1.3.0) follows the same rule; the matching
  bullet of ADR 0007 is amended, and one unit test of a running statement with a
  detached `.catch()` now expects a commit.

## Verification / acceptance criteria

- [x] `justRejectedQueries`, `rememberRejection()` and the double `queueMicrotask()` are removed (`src/client/transaction.ts`).
- [x] Fake-adapter tests run each case in an early schedule (the statement fails before the callback returns) and a late one (it fails 30 ms after issue, after the callback returned), assert which schedule happened, the same outcome in both, END_TRAN last, and no unhandled rejection: awaited and caught, `.catch()`, `Promise.allSettled`, caught `Promise.all`, detached `.catch()`, `.then(f, g)`, `.then(f).catch(g)`, `void`, an untouched promise, `.then(f)` alone, `.finally()` (its test handles the derived promise), a returned statement, a throwing callback, `tx.commit()`, a statement after an unawaited `tx.commit()`, and a detached fallback (`tests/client.test.ts`).
- [x] Every pre-existing unit test, live test and the JDBC parity runner pass unmodified, except the scope test noted above.
- [x] Live CUBRID (`tests/integration.test.ts`, "observed and unobserved statement failures (#244)"): duplicate key caught then UPDATE commits; `void` failure rolls back and detached `.catch()` commits in both schedules; `Promise.allSettled` commits; a scope commits past an observed failure and refuses an unobserved one.
- [x] `API_REFERENCE.md`, `API_STABILITY.md`, README, TROUBLESHOOTING, ADR 0007 and `ENGINEERING_INVARIANTS.md` updated.
- [ ] Record explicit maintainer acceptance, including the SemVer classification, in a reviewed PR.

## References

- `src/client/transaction.ts` (`StatementPromise`, `CallbackTransaction.track()`, `runCommit()`)
- [API reference: observed and unobserved statement failures](../API_REFERENCE.md#observed-and-unobserved-statement-failures)
- [API stability: unobserved statement failures](../API_STABILITY.md#unobserved-statement-failures)
- Issues [#244](https://github.com/cubrid-lab/cubrid-client/issues/244), [#109](https://github.com/cubrid-lab/cubrid-client/issues/109), [#195](https://github.com/cubrid-lab/cubrid-client/issues/195)
- [ADR 0007](0007-manual-transaction-ownership.md)
