# ADR 0005: Reproducible, language-native development setup

- **Status:** Proposed
- **Date:** 2026-11-07
- **Scope:** TypeScript/Node.js developer setup, quality tooling and environment contracts
- **Prerequisites:** Release governance ADR 0001 and TDD ADR 0004; architecture ADR 0003 remains proposed until reviewed.

## Context

A correct CUBRID design and test-first workflow can still fail when contributors use inconsistent compiler/runtime versions, lockfiles, phantom integration tests or package/module paths that cannot be installed by an external consumer. A developer passing offline tests must not claim real broker/DDL or published package compatibility. The Python projects demonstrated the value of real, fail-closed integration gates, exact dependency environments and reproducible proof.

## Decision

Use Node 22 as a recommended reproducible developer workstation baseline while continuing to test and honor the published `engines.node >=18` consumer contract. `npm ci` uses the checked-in lockfile; API declaration diff, ESM/CJS package smoke, real CUBRID and npm registry checks remain separate required gates. Keep existing release workflow and do not confuse a GitHub Release with successful npm publication.

- Maintain a **single repository-local onboarding guide** [DEVELOPMENT_SETUP.md](../DEVELOPMENT_SETUP.md) that names the actual install/build/offline/live-CUBRID/publish-consumer steps, without requiring other-language package tools.
- Use the repo's checked-in lockfile or module manifest and keep dependency update/publishing workflows separately reviewed. Do not blindly regenerate a lockfile or raise a published runtime floor to fix a development-tool problem.
- Run **non-mutating** preflight/format checks by default. Code-formatters that rewrite files are separate intentional developer actions, not read-only readiness checks.
- Distinguish **setup ready**, **offline tests passed**, **real CUBRID integration passed** and **release artifact verified** as four distinct states. No passing prerequisite implies later states.
- Avoid adding heavyweight per-PR jobs just to demonstrate setup. Reserve required live DB matrix and external consumer checks for relevant behavioral changes and final release candidates.

## Node.js 18 compatibility invariant

The Node 22 local development baseline does **not** change the `engines.node >=18` requirement for any 1.x release, including maintenance patches. [ADR 0006](0006-node-18-support-through-1x.md) records this decision; a minimum-runtime upgrade is a prospective **2.0** consideration, not an allowed 1.x setup optimization. Test packed ESM/CJS output with a Node 18 consumer independent of the Node 22 builder. The established [API stability schedule](../API_STABILITY.md#nodejs-support-schedule) also retains Node 20 throughout 1.x.

## Alternatives considered

- **Rejected:** One shared global language/tool version and cross-language Makefile for every repo; violates Go, Cargo and Node-specific conventions.
- **Rejected:** Treat the green CI of an unrelated driver as proof the ORM or new developer machine is ready.
- **Rejected:** Silently replace dependencies, module imports or runtime support bounds during documentation/setup work.
- **Rejected:** Install a non-CUBRID fake server to make a missing real integration test appear green.

## Consequences and trade-offs

The setup guide makes current blockers visible rather than working around them. Some integration commands must remain explicitly blocked until a real CUBRID harness, correct package dependencies and upstream dialect extension are validated. Tool-version upgrades may need independent consumer compatibility reviews.

## Blocking questions before setup approval

Confirm developer Node versus Node 18/20 consumers in README/CONTRIBUTING. Existing repo has no local Docker Compose; live CUBRID provisioning must reference real service/runtime rather than an invented local command. Reconcile stale Biome command in contributor guidance with installed tooling.

## Verification / acceptance criteria

- [ ] A clean checkout installs/builds using the declared manifest/toolchain and reproducible documented commands, with actual observed results.
- [ ] A read-only check can identify baseline tools, missing files and unsupported operations without modifying tracked source.
- [ ] The setup guide has no phantom scripts, Docker Compose file or declared test coverage.
- [ ] Language-specific compiler/runtime and package/module path requirements are coherent with existing consumers; divergent development vs consumer versions are explicit.
- [ ] Real CUBRID integration is separately executable and cannot be marked passed when missing/zero/skipped.
- [ ] Final release candidate CI and external consumer/registry verification remain mandatory according to ADR 0001.
- [ ] Maintainer approves the decision and its outstanding blockers. Documentation alone does not mean setup validation passed.

## References

[Design sign-off](../DESIGN_SIGNOFF.md) (currently proposed), [engineering invariants](../ENGINEERING_INVARIANTS.md), [TDD ADR 0004](0004-test-first-development.md), [release ADR 0001](0001-release-governance.md).

**This ADR records a proposed setup contract. It does not itself install tooling, execute tests, change dependency metadata, or authorize a release.**
