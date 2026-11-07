# Design sign-off and TDD acceptance plan

> **Status: Not signed off / design under review.** This plan captures *expected* test behavior, not tests already written or run. The repository's ADRs 0001–0006 are proposed in this PR and require explicit maintainer review. No implementation, CI success, approved public API or live DB outcome is implied.

## Project setup prerequisite

**ADR 0005 and the development setup guide** are proposed in this branch; check [the setup documentation](DEVELOPMENT_SETUP.md) and the manifest/CI before checking these boxes.

- [ ] **Clean checkout verified:** language-native runtime/compiler and tooling are selected with a documented developer versus published consumer support distinction.
- [ ] **Dependency resolution verified:** the exact npm lockfile installs without undocumented replacement, incompatible version, or incorrect package exports.
- [ ] **Read-only setup checks executed:** record **actual** build/type/lint/unit results, not command examples; all known missing config/scripts have explicit blockers.
- [ ] **Real DB harness decided:** identify a disposable real CUBRID service and concrete test selection, or mark missing harness as blocked. A Docker healthcheck, fake broker or zero/fully skipped suite is not evidence.
- [ ] **External package consumer planned:** npm packed ESM/CJS and TypeScript declarations, with release preflight separate from initial setup.
- [ ] **Repository developer guidance consistent:** README, CONTRIBUTING, AGENTS, tooling and CI refer to commands that actually exist and do not silently raise the supported runtime floor.
- [ ] **Maintainer approval recorded** for ADR 0005 and any associated Node.js engine, package exports, dependency, or CI changes.

These are **not completed** merely because the files are written. If setup is blocked, fix or explicitly scope it in a separate reviewed task before claiming the design is ready for implementation.

### Node.js 18 support — binding 1.x compatibility requirement

- [ ] Preserve Node `>=18` across **every** `cubrid-client@1.x` version; the Node 22 development baseline is not a change to published runtime support.
- [ ] Release-candidate tests import the **packed ESM/CJS artifact on Node 18**, with representative runtime assertions, and record real results rather than relying on Node 22 compilation.
- [ ] Any future proposal to raise the runtime minimum is a **2.0 MAJOR** design/release decision with migration guidance; no 1.x workaround can quietly change it. See [ADR 0006](adr/0006-node-18-support-through-1x.md).

## Design-first gate

Before implementation changes are treated as approved, establish each of the following in reviewed project documentation and link the evidence. Check only when genuinely resolved, not merely because this template exists.

- [ ] **Boundaries and interfaces:** owned layer, public API, Node.js/TypeScript patterns, dependency version ranges and compatibility requirements.
- [ ] **Protocol/SQL contract:** CUBRID-specific wire/query semantics, supported and unsupported behaviors, parameter/result mapping, resource lifetimes.
- [ ] **State and failure model:** connection/session/transaction/statement states, cancellation, retries, ambiguous outcomes and cleanup.
- [ ] **Data types and precision:** NULL, signed integers, exact numeric, text, date/time, collections, binary/LOB and errors.
- [ ] **Schema/migration contract (where applicable):** CUBRID DDL, introspection, reversible behavior, destructive change guardrails.
- [ ] **Security and operations:** credentials/log redaction, timeout limits, resource bounds, cancellation behavior and diagnostics.
- [ ] **Verification design:** red/green cases (below), real CUBRID versions, non-vacuous failure gate, independent JDBC semantic comparison when appropriate.
- [ ] **Release readiness:** published npm package and supported Node.js consumer matrix, reviewed release notes, stable 1.0 exit conditions.
- [ ] **Integration feasibility:** independently verify the required CAS capabilities, runtime dependencies, and supported Node.js interfaces before committing to architecture.
- [ ] **Review approval:** maintainers explicitly approve the language-native architecture ADR, test contract and open blockers; no speculative sign-off.

The PR/issue must distinguish **decided**, **proposed**, **blocked**, and **requires live verification**. If a significant feasibility constraint prevents the proposed direction, update the ADR and its alternatives before implementing a workaround.

## TDD acceptance cases

For each feature or bug: first run a targeted test that fails for the intended reason (**Red**), make the smallest implementation pass (**Green**), refactor under the same tests, and verify live database behavior before claiming compatibility. A red failure log may be summarized truthfully in the PR but need not be committed. The final PR must have green required checks.

| Test contract (proposed) | Expected observable outcome | First test layer | TDD starting point |
| --- | --- | --- | --- |
| Reconnect probe | A healthy OUT_TRAN session remains the same; dead CAS is retired without replaying a previously sent SQL statement | protocol fixture; live broker reset | unit simulation first; verify exact CAS event on real CUBRID |
| Transaction ownership | Query after commit/rollback rejects, concurrent unrelated query does not join transaction; commit/rollback cleanup failures preserve original cause | fault-injected unit; live isolated-connection test | unit failure path; then live DB rollback assertions |
| Data fidelity | Malformed/unknown non-NULL type raises explicit error, never null; BIGINT/NUMERIC retain precision; date/time behavior is documented | protocol typed fixture + live server | compare selected typed results to official JDBC |
| Protocol and cursor | Truncated FETCH, reused handle, invalid frame length and stream cancellation do not corrupt next response | fragmented packet fixtures; controlled socket; live recovery | red on stale/partial failure; green on correct retirement |
| Release artifact | Final candidate tarball ESM/CJS/TypeScript consumers work and npm registry matches release tag | npm pack + external consumer + publish gate | do not call GitHub Release an npm publication |

## Project boundary

**Role:** Node.js CAS driver with existing public 1.x API.

The Node package's public Promise API and emitted declarations are already subject to the 1.x compatibility policy; the design must not silently replace them.

## Decisions still blocking full sign-off

#112 manual transaction ownership, #113 date/time zone, #118 JDBC comparison, #150 query cancellation, #189 npm release completeness, #214 autocommit partial FETCH. Existing 1.x does not imply every issue is complete.

These are outstanding verifications, not proof of failure. Existing code and currently declared support are not silently reclassified as unsupported merely because a test is absent.

## Release and implementation sequencing

1. Review and explicitly accept the repository release policy and [TDD ADR 0004](adr/0004-test-first-development.md) before using them as implementation sign-off requirements.
2. Resolve the above design/feasibility blockers with evidence, review [API_STABILITY](API_STABILITY.md) and [ENGINEERING_INVARIANTS](ENGINEERING_INVARIANTS.md), and explicitly accept the architecture/contract ADR when applicable.
3. Implement each scoped issue with test-first evidence, one observable contract at a time. No implementation-wide PR before essential protocol or interface feasibility.
4. Run real CUBRID and external npm consumer tests on the final release candidate; document exact versions and test counts; do not publish based on mocks alone.

**Tracked design PR:** #218. This file is a **sign-off checklist**, not a signed-off design.
