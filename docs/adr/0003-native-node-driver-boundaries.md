# ADR 0003: Preserve native Node.js CAS driver responsibility

- **Status:** Proposed (codifies existing design; no runtime migration is authorized)
- **Date:** 2026-11-07
- **Scope:** TypeScript Node.js driver and its public CAS connection and transaction contracts

## Context

`cubrid-client` is a Node.js/TypeScript CUBRID driver with its own 1.x API contract documented in `docs/API_STABILITY.md`. The driver owns CAS protocol transport, connections, query/prepared execution, result and type conversion, typed errors, streaming, and transaction safety. ORM-specific query generation and migrations are outside this driver's responsibilities.

## Decision

Retain a Node-native, Promise-oriented client with explicit boundaries:

- The driver implements physical CAS/Broker connections, request framing, liveness checks, result metadata, codecs, per-connection statements, errors and transaction lifecycle.
- A reconnect is a new physical session generation. Handles, cursors and LOB resources from the previous session must not be used in the replacement. A normal `OUT_TRAN` transaction status must not itself trigger a reconnect.
- Never reissue SQL whose server execution may have occurred. Distinguish safe connect-only retries from uncertain query, FETCH, COMMIT or ROLLBACK outcomes. Propagate accurate failure information rather than success/default values.
- Preserve distinct `query()` row behavior and `execute()` DML result metadata; maintain TypeScript, ESM and CommonJS public contracts in released artifacts.
- Leave ORM SQL compilation, schema inference, ORM type declarations, and migrations to consumers and separately maintained integrations; this package does not own their implementation or release schedules.
- Limit changes to the stable 1.x surface according to published SemVer and tested compatibility. The design/sign-off checklist requires **real CUBRID** independent evidence before new correctness claims.

## Alternatives considered

- **Rejected:** Embed ORM-specific SQL compilation inside the CAS driver; it would confuse driver transport responsibilities with application-level SQL generation.
- **Rejected:** Replace the documented Node.js Promise API and typed errors with an incompatible interface; that would break published 1.x consumers.
- **Rejected:** Retry every network error or return `null` for unrecognized values; it can duplicate writes or silently corrupt data.

## Consequences and trade-offs

The driver requires careful lifecycle tests and may retire ambiguous sessions rather than transparently reconnecting. Consumers and external integrations must verify their own compatibility independently. Existing feature defects remain tracked and are not solved by accepting this ADR.

## Verification / acceptance criteria

- [ ] Maintainers confirm the Node public contract and ownership boundary against `docs/API_STABILITY.md`.
- [ ] Protocol and transaction regression tests cover the actual failure model, with no unsafe replay, fabricated IDs or swallowed errors.
- [ ] Current published release state is separated from GitHub-only tag/release state; actual npm consumers are verified.
- [ ] Independent real CUBRID/JDBC comparisons and candidate SHA results are recorded when claiming compatibility.
- [ ] Design blockers in `docs/DESIGN_SIGNOFF.md` have scoped owners and evidence.

## References

[Node API stability](../API_STABILITY.md), [engineering invariants](../ENGINEERING_INVARIANTS.md), [design sign-off plan](../DESIGN_SIGNOFF.md), [JDBC comparison #118](https://github.com/cubrid-lab/cubrid-client/issues/118), [transaction ownership #112](https://github.com/cubrid-lab/cubrid-client/issues/112).

**This design record is Proposed and does not mean full release readiness or protocol parity.**
