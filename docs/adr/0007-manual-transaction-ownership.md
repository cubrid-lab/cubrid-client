# ADR 0007: Explicit ownership for manual transactions on a shared Node client

- **Status:** Proposed — compatibility decision not yet accepted
- **Date:** 2026-11-08
- **Scope:** `CubridClient.beginTransaction()`, `commit()`, `rollback()`, and regular query methods
- **Issue:** [#112](https://github.com/cubrid-lab/cubrid-client/issues/112)

## Context

The published Node 1.x API exposes `beginTransaction(): Promise<void>`
and sends ordinary `query()`, `execute()`, `commit()`, and `rollback()`
calls on the same shared physical CAS connection. There is **no transaction
handle or owner identity** in the method signatures. FIFO packet ordering
prevents simultaneous wire writes, but does **not** determine which
asynchronous request owns the open transaction. An unrelated caller can
send SQL after `beginTransaction()` and before `commit()` or
`rollback()`, inadvertently joining that transaction.

The existing `transaction(async tx => ...)` callback **does** create a
dedicated physical connection. A deterministic overlapping query test
was added in [PR #225](https://github.com/cubrid-lab/cubrid-client/pull/225)
(merged `79a47a4270c7de95a795a515a360546973ef1998`) and the published
[API reference](../API_REFERENCE.md) now describes this distinction.
That passing test **does not fix** the manual transaction API.

## Constraints and alternatives

### Keep the 1.x contract, make concurrent use explicitly scoped

Do not silently change the meaning or return type of the already
published `beginTransaction(): Promise<void>` in a patch/minor release.
For concurrent workloads, use `transaction(async tx => ...)` and issue
all work belonging to that transaction through `tx`, or use an unshared
`CubridClient` instance for each manual transaction.

This is an interim documented **usage boundary**, not a claim that the
manual methods themselves are concurrency-safe. Calling them on a shared
client while unrelated queries may run remains unsafe.

### Explicit ownership capability (proposed future design)

Investigate a language-native, typed capability such as:

```ts
const tx = await client.beginTransactionScope();
try {
  await tx.query('...');
  await tx.commit();
} catch (error) {
  await tx.rollback();
  throw error;
}
```

The above is **illustrative only; this API does not currently exist**.
A design must prove exclusive connection ownership; which operations on
`client` remain available; concurrent control and close races; the
ownership state machine; cancellation and ambiguous commit; and typed
error/rollback cleanup behavior. The existing `transaction(callback)`
may already satisfy most use cases without new API surface.

A future **major** could change or remove ambiguous manual methods after
a reviewed migration path. Do not set a version or remove 1.x methods
merely because this ADR documents the risk.

## Rejected approaches

- **Packet FIFO is sufficient:** it serializes bytes, not caller ownership.
- **Global lock around manual `beginTransaction()` to `commit()`:**
  unqualified `query()` has no ownership token, so such a lock either
  blocks the legitimate transaction's own queries or admits unrelated
  ones. It is not a correct isolation guarantee.
- **Guessing ownership from asynchronous promise order, time or SQL:**
  multiple unrelated tasks can share a Node execution context.
- **Automatically replaying failed writes on another connection:**
  a SQL request/commit may already have reached CUBRID.
- **Breaking `beginTransaction()` in a 1.x patch:** violates published
  version expectations without a migration path.

## TDD and live database acceptance before resolving #112

- [x] A deterministic test confirms that scoped callbacks maintain a
  dedicated connection while unrelated client queries run concurrently
  ([PR #225](https://github.com/cubrid-lab/cubrid-client/pull/225)).
- [ ] Review a concrete public ownership-token/handle contract and
  backward-compatibility/migration options; do **not** treat documentation
  as an implementation.
- [ ] Write targeted RED tests where an unrelated caller attempts SQL
  during a manual transaction, a commit/rollback races another query,
  and failure/close occurs with operations queued.
- [ ] Implement the chosen safe contract with actual Green/Refactor
  results and preserve Node 18 support throughout 1.x.
- [ ] Execute isolated **real CUBRID** concurrent sessions across the
  advertised database matrix, verify rollback/commit visibility and
  no duplicate execution, and record versions and nonzero case counts.
- [ ] Validate packed Node 18 CJS/ESM consumers and review SemVer
  impact before a published release.

## Parallel execution and consequence

A new explicit ownership API proposal, negative concurrency tests,
real-CUBRID fixture design, documentation and independent pool tests
can proceed in parallel. Final implementation must agree on the
**public ownership capability** before API integration. The existing
callback contract remains the recommended safe path today. Issue #112
remains open and critical until the manual API's claimed safety is
demonstrably resolved or intentionally re-scoped by an approved
compatibility decision.
