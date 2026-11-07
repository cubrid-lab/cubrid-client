## Summary

<!-- Brief description of changes -->

## Changes

<!-- List the specific changes made -->

-

## Type of Change

<!-- Check the relevant option -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Chore (maintenance, dependencies, CI, etc.)

## Checklist

- [ ] My code follows the project's code style
- [ ] I have run `npm run check` (typecheck + test)
- [ ] I have added tests for new functionality (if applicable)
- [ ] I have updated documentation (if applicable)
- [ ] My changes do not introduce new warnings

## Related Issues

<!-- Link to related issues: Closes #123, Fixes #456 -->

## Test-first evidence and design approval

<!-- Applicable to behavioral implementation. For docs-only or design feasibility work, write N/A and the actual evidence. See docs/adr/0004-test-first-development.md and docs/DESIGN_SIGNOFF.md (in the design PR where applicable). -->

- [ ] **Design:** The public behavior/SQL/transaction/error contract and owning layer were reviewed before implementation (link ADR/issue or explain N/A).
- [ ] **Red:** A targeted test failed for the expected **behavioral** reason; summarize the observed failure or state why test-first did not apply.
- [ ] **Green:** The smallest implementation passes the new test; name the exact test command and outcome.
- [ ] **Refactor:** Related regression tests and required final-head checks pass, with observed CI links when available.
- [ ] **Live CUBRID:** For behavior depending on the server, distinguish real DB tests from mocks; include exact server/runtime/driver versions and passed/failed/skipped cases, or explicitly mark the behavior unverified.
- [ ] **Release:** No version/support claim or publication is inferred from a green mock or skipped integration job; final release candidates follow the separately reviewed full DB gate.

## Development environment and dependency verification

<!-- For a behavior/CI/dependency change, give observed results. For docs-only or unrelated work, state N/A with a reason. See docs/DEVELOPMENT_SETUP.md and ADR 0005. -->

- [ ] Clean checkout and native dependency install resolve without unexpected manifest/lockfile changes; report runtime/compiler version and result, or explain why not run.
- [ ] Do not confuse local build/offline tests with actual live CUBRID SQL execution. Record the database/version and count of executed integration cases when claiming that behavior.
- [ ] Node.js engine range, npm package exports, TypeScript declarations, and versioned dependency constraints are reviewed if relevant; no silent compatibility-breaking setup change.
- [ ] Required final-head CI and release checks remain in place; missing/failed/skipped checks are reported truthfully and a docs-only shortcut is **not** a release verification.

## Repository-owned change and reference review

- [ ] The title, rationale, expected behavior, ADR context and release notes describe **cubrid-client**'s own responsibility (Node.js/TypeScript CAS driver and npm consumer contract), not work to replicate another repository's design or release.
- [ ] Cross-repository links, if any, are necessary for an actual supported dependency/consumer interface, an independent CUBRID/JDBC comparison, or explicitly scoped coordination. They are context, not substituted test evidence or tracking ownership.
- [ ] Issue/PR/ADR text does not contain pasted tooling, API names, version rules, or test claims belonging to an unrelated language or repository.
