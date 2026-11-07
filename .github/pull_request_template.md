## Summary

Explain the motivation, behavior affected and boundaries of this change.

## Related issues

Link specific issues or write N/A.

## Change type

- [ ] Bug fix or regression
- [ ] Feature / public API
- [ ] Documentation
- [ ] Refactor
- [ ] CI, tooling, dependencies or release infrastructure

## Implementation and test evidence

State **actual** commands and outcomes; if a check did not run or was skipped, say so. Do not mark a mock suite or a healthy container as real database verification.

- [ ] The owning layer, expected behavior and relevant ADR/design constraints were reviewed.
- [ ] For behavior changes: describe the observed failing RED case, minimum GREEN fix and REFACTOR checks (or explain why TDD is inapplicable).
- [ ] Run the applicable `npm run check` (typecheck + tests), `npm run build` and `npm run api:check`; link final-head CI evidence.
- [ ] For database behavior: include a real CUBRID version, executed SQL/results, transaction/failure tests and actual nonzero pass/fail/skip counts, or explicitly note missing evidence.
- [ ] For releases/API changes: verify the packed ESM/CJS consumer on **Node 18**. Node 18 and 20 remain supported throughout `cubrid-client@1.x`; Node 22 developer tooling is not a support-floor increase.
- [ ] Update docs, compatibility ranges, release notes and genuine contributor credit if applicable.
- [ ] No insecure automatic SQL replay, swallowed transaction failure, fabricated insert ID or silent type coercion is introduced.

## Compatibility and release impact

Describe potential breaking changes, affected CUBRID versions, and rollback/recovery, or write N/A. An approved PR does not imply npm publication.

## Reviewers

Mention relevant reviewers, or state that they are not assigned.
