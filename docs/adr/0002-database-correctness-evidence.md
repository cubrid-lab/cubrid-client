# ADR 0002: CUBRID correctness and failure-evidence boundaries

- **Status:** Proposed
- **Date:** 2026-11-07
- **Scope:** cubrid-client correctness obligations and review evidence

## Context

The CUBRID Python driver and its SQLAlchemy dialect revealed that apparently successful queries can hide transaction-scope mistakes, accidental retries after uncertain execution, stale broker handles, precision loss and unverified ORM-generated SQL. The purpose of learning from them is to **reuse verified invariants and test design**, never Python API signatures or implementation code. The current repository has its own runtime, public API and released compatibility obligations.

## Decision

The Node.js CAS driver owns physical sessions, request framing, result conversion, error propagation and transaction lifecycle. A query that may have reached CUBRID must never be replayed as an implicit recovery. A completed transaction is not a closed physical CAS connection; stale handles from replaced sessions must never be reused. Unsupported values must not become null or a guessed last-insert ID. Changes need focused mocked protocol adversarial tests, live CUBRID runs and independent JDBC/pycubrid semantic evidence for claimed parity. Keep Node Promise failures and transaction scoping correct.

Use source-linked test cases as engineering references, then implement targeted **native-language** regression tests. Identify whether a test actually talked to CUBRID, which server/broker and client/ORM versions were used, what SQL/outcome was asserted, and whether any required case was skipped. The fact that a Python project passes its tests does **not** certify this package.

## Alternatives considered

- **Rejected:** Automatic SQL replay after transport ambiguity; assuming OUT_TRAN means dead connection; treating unsupported non-null types as SQL NULL; equating a passed unit suite with JDBC parity.
- **Rejected:** A generic cross-language implementation copied verbatim from Python.
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

[engineering checks](../ENGINEERING_INVARIANTS.md), [Python session regression](https://github.com/cubrid-lab/pycubrid/blob/main/tests/test_cas_session_persistence.py), [JDBC comparisons #118](https://github.com/cubrid-lab/cubrid-client/issues/118)

**No claim of implementation completion is made.**
