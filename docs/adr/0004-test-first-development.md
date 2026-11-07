# ADR 0004: Test-first development for CUBRID behavior

- **Status:** Proposed
- **Date:** 2026-11-07
- **Scope:** cubrid-client design-to-implementation workflow
- **Prerequisite:** Release governance ADR 0001 and the relevant architecture/contract ADR must be reviewed before implementation work is presented as complete.

## Context

Python driver and SQLAlchemy development surfaced errors that ordinary success-only tests did not catch: broker session life, uncertain execution, stale cursor handles, transaction/DDL rollback and precision/type fidelity. The project will complete its interface, behavioral and release design **before broad implementation**, then use Test-Driven Development (TDD) to prevent regressions in each small feature.

TDD is not proof of CUBRID compatibility by itself. Code-level mocks and failing unit tests cannot replace actual broker/database execution. A newly written test that passes on today's code does not demonstrate a successful Red step; a failing test must fail for the **intended behavioral reason**.

## Decision

For implementation and behavior-changing bug fixes, use **Red → Green → Refactor** in small, reviewable slices:

1. **Contract first:** choose a completed, reviewed design requirement with observable behavior, unsupported-case contract, and test level (type/unit/protocol, real CUBRID, external consumer).
2. **Red:** write the smallest deterministic test that demonstrates the required behavior is missing or buggy. Execute it and record the relevant failure summary (not a speculative error or CI screenshot of an unrelated failure). If the feature cannot be tested because upstream extension hooks are missing, conduct a scoped feasibility/compile probe and record the blocker **before production implementation**.
3. **Green:** implement the smallest change in the owning layer; the new test passes. Run related regression tests. Do not substitute a mock's behavior for a live server contract.
4. **Refactor:** remove duplication, improve names and error paths without changing the tested contract; rerun the targeted suite and all required final-head CI.
5. **Integration and contract evidence:** for CUBRID-dependent behavior, run a real database test that asserts actual SQL outcomes and failure paths, or leave the feature explicitly *unverified/blocked*. Release candidates always run the full required CUBRID matrix on their exact SHA, regardless of docs-only PR optimizations.

**Do not merge a deliberately failing test merely to prove Red.** The PR should contain passing tests on its final head and a short truthful summary of the initial failure, fix and verification. No mandatory ceremonial commit-per-phase, forced test framework, or reviewer-specific AI tooling is imposed.

## Language-native test strategy

- **Primary harness:** Vitest/TypeScript and Node test harnesses; protocol fixture, request lifecycle and public ESM/CJS consumer tests.
- **Contract cases:** Typed failures in CAS packets, Promise rejection, transaction state after rollback and public query/execute metadata.
- **Meaningful Red:** No unexecuted query is replayed; partial FETCH or unknown wire values fail with an explicit error instead of fabricated NULL.
- **Real database proof:** Run deterministic malformed/fragmented packet tests offline, then verify the named behavior on real CUBRID 10.2/11.0/11.2/11.4 only where jobs truly execute; compare selected results with JDBC/pycubrid.
- **Additional boundaries:** Actual npm packed consumer, d.ts and d.cts checks; no forced release from test changes.

Tests should distinguish independently verified JDBC/official-driver semantics from this library's current and future behavior. A failure in one CUBRID version or driver release is **not** proof of universal lack of support. Verify type preservation and transaction correctness instead of faking successful results.

## Alternatives considered

- **Rejected:** Implement the full driver/ORM first, then add tests to match whatever the code does; this risks normalizing incorrect behavior.
- **Rejected:** Only unit-test generated SQL or mock the database and label the whole feature production-ready; actual CUBRID runtime semantics remain unverified.
- **Rejected:** Demand a permanently red test in the final PR or one commit per TDD stage; it breaks final CI and does not establish correctness.
- **Rejected:** Force live database jobs for every pure-document change; reserve mandatory full DB matrix for relevant behavioral work and release candidates.

## Consequences and trade-offs

TDD increases upfront test design and may reveal API/extension infeasibility before code changes. Some tests must be written against a fake CAS transport first and then independently proved on real servers. The final PR remains reviewable with a green head, a reproducible test, honest validation notes, and explicit limitations.

## Verification / acceptance criteria

- [ ] A reviewed contract/ADR identifies the expected behavior and the owning layer.
- [ ] The PR describes the first deliberately failing test (case and failure reason) and the subsequent passing test; **do not invent failure output**.
- [ ] Relevant normal, negative and cleanup/recovery paths are covered with assertions.
- [ ] A real CUBRID test (or explicit blocker) supports every new database behavior claim; mandatory release jobs cannot self-skip, run zero test cases, or silently swallow failed transactions.
- [ ] Generated SQL/DDL, result types, protocol state and public consumer compatibility are covered as applicable.
- [ ] Final-head required CI passes, plus applicable packaging/consumer check; release candidate gates are separate and non-bypassable.
- [ ] Where a test-first approach does not apply (docs-only, research, design feasibility), the PR states why and records the resulting specification/probe evidence.

## References

[Repository correctness invariants](../ENGINEERING_INVARIANTS.md), docs/API_STABILITY.md and docs/RELEASE_PROCESS.md remain authoritative.

This is a **proposed process ADR**, not an assertion that the current code or its CI already follows TDD.
