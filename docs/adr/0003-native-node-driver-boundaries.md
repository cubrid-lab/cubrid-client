# ADR 0003: Preserve native Node.js CAS driver responsibility

- **Status:** Proposed (codifies existing design; no runtime migration is authorized)
- **Date:** 2026-11-07
- **Scope:** TypeScript Node.js driver and its public CAS connection and transaction contracts

## Context

`cubrid-client` is the Node.js CUBRID driver, distinct from the Rust crate with the same package name. Its published Node 1.x API is documented in `docs/API_STABILITY.md`. The project's role is CAS protocol, connections, query/prepared execution, result and type conversion, typed errors, streaming and transaction safety. Drizzle's CUBRID dialect belongs to `drizzle-cubrid`. The pycubrid project supplies researched CAS and failure regressions, **not** a TypeScript API to port.

## Decision

Retain a Node-native, Promise-oriented client with explicit boundaries:

- The driver implements physical CAS/Broker connections, request framing, liveness checks, result metadata, codecs, per-connection statements, errors and transaction lifecycle.
- A reconnect is a new physical session generation. Handles, cursors and LOB resources from the previous session must not be used in the replacement. A normal `OUT_TRAN` transaction status must not itself trigger a reconnect.
- Never reissue SQL whose server execution may have occurred. Distinguish safe connect-only retries from uncertain query, FETCH, COMMIT or ROLLBACK outcomes. Propagate accurate failure information rather than success/default values.
- Preserve distinct `query()` row behavior and `execute()` DML result metadata; maintain TypeScript, ESM and CommonJS public contracts in released artifacts.
- Delegate ORM SQL compilation, schema inference, dialect type declarations and migrations to the separately versioned `drizzle-cubrid` adapter.
- Limit changes to the stable 1.x surface according to published SemVer and tested compatibility. The design/sign-off checklist requires **real CUBRID** independent evidence before new correctness claims.

## Alternatives considered

- **Rejected:** Import MySQL or Drizzle SQL compilation into this driver; it would invert ownership and confuse transport with ORM semantics.
- **Rejected:** Copy Python DB-API classes and exception names; it violates Node/TypeScript expectations and does not preserve published 1.x consumers.
- **Rejected:** Retry every network error or return `null` for unrecognized values; it can duplicate writes or silently corrupt data.

## Consequences and trade-offs

The driver requires careful lifecycle tests and may retire ambiguous sessions rather than transparently reconnecting. The Drizzle adapter must maintain its own SQL/ORM integration checks and verified dependency range. Existing feature defects remain tracked and are not solved by accepting this ADR.

## Verification / acceptance criteria

- [ ] Maintainers confirm the Node public contract and ownership boundary against `docs/API_STABILITY.md`.
- [ ] Protocol and transaction regression tests cover the actual failure model, with no unsafe replay, fabricated IDs or swallowed errors.
- [ ] Current published release state is separated from GitHub-only tag/release state; actual npm consumers are verified.
- [ ] Independent real CUBRID/JDBC comparisons and candidate SHA results are recorded when claiming compatibility.
- [ ] Design blockers in `docs/DESIGN_SIGNOFF.md` have scoped owners and evidence.

## References

[Node API stability](../API_STABILITY.md), [engineering invariants](../ENGINEERING_INVARIANTS.md), [design sign-off plan](../DESIGN_SIGNOFF.md), [JDBC comparison #118](https://github.com/cubrid-lab/cubrid-client/issues/118), [transaction ownership #112](https://github.com/cubrid-lab/cubrid-client/issues/112).

**This design record is Proposed and does not mean full release readiness or protocol parity.**
