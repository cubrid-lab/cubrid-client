# ADR 0002: CUBRID correctness and failure-evidence boundaries

- **Status:** Proposed
- **Date:** 2026-11-07
- **Scope:** cubrid-client correctness obligations and review evidence

## Context

The Node.js driver must verify its own transaction boundaries, uncertain-execution handling, broker session and handle lifetimes, value fidelity, and error behavior. Passing offline tests alone cannot prove these behaviors on a real CUBRID server. Requirements and verification must follow this package's published API and runtime support policy.

## Decision

The Node.js CAS driver owns physical sessions, request framing, result conversion, error propagation and transaction lifecycle. A query that may have reached CUBRID must never be replayed as an implicit recovery. A completed transaction is not a closed physical CAS connection; stale handles from replaced sessions must never be reused. Unsupported values must not become null or a guessed last-insert ID. Changes need focused mocked protocol adversarial tests, live CUBRID runs and independent JDBC semantic evidence for claimed parity. Keep Node Promise failures and transaction scoping correct.

Write targeted Node.js/TypeScript regression tests based on this driver's observable contract. Identify whether a test actually communicated with CUBRID, which server/broker and package versions were used, what SQL/outcome was asserted, and whether any required case was skipped. Independent reference results do **not** certify this package.

## Alternatives considered

- **Rejected:** Automatic SQL replay after transport ambiguity; assuming OUT_TRAN means dead connection; treating unsupported non-null types as SQL NULL; equating a passed unit suite with JDBC parity.
- **Rejected:** Replacing the published Node.js API with an unrelated driver's API or assuming another implementation's test results establish correctness here.
- **Rejected:** Marking an unsupported/unverified feature as absent simply because one server or connector failed in a particular test.

## Consequences and trade-offs

Extra error handling and negative tests increase effort but prevent silent data corruption and duplicate writes. Ordinary documentation-only PRs need not run an expensive database matrix; **the final release candidate still must run all required real-CUBRID checks** for its promised compatibility.

## Verification / acceptance criteria

- [ ] Normal and failure-path tests cover the actual decision's affected behavior.
- [ ] No silent statement replay, fabricated database values, unknown-success transaction or stale-handle reuse for the supported public API.
- [ ] Real DB tests use an isolated ready-checked CUBRID instance, assert actual stored/returned values and report nonzero executed-case counts; skip/missing is not success.
- [ ] Independent JDBC (or verified official driver) comparisons evaluate meaning and type, not matching source implementation.
- [ ] Public docs, type declarations and compatibility claims are reconciled with observed behavior; unsupported operations fail clearly.
- [ ] Maintainer accepts this ADR and separately reviews release/code changes; neither this record nor a checklist fixes existing defects.

## References

[engineering checks](../ENGINEERING_INVARIANTS.md), [API stability](../API_STABILITY.md), [semantic verification #118](https://github.com/cubrid-lab/cubrid-client/issues/118)

**No claim of implementation completion is made.**
