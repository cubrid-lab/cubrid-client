# ADR NNNN: Describe the decision in plain language

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Decision scope:** Which public behavior, interface or operating constraint this covers
- **Prerequisites:** Link earlier decisions or the release policy when relevant

## Context

Describe the concrete problem and relevant evidence. Distinguish verified behavior from assumptions, and link existing code, CUBRID documentation, issues or real tests.

## Decision

Explain the selected technical direction, with language-native implementation boundaries and versioned/public behavior. Do not claim implementation is complete if this is still a design proposal.

## Alternatives considered

Describe viable alternatives, including reasons for rejection or deferral. Avoid generic labels such as "worse" without a technical consequence.

## Consequences and trade-offs

Document the migration cost, compatibility impact, maintainability, new failure modes and any release consequences.

## Verification / acceptance criteria

- [ ] Confirm intended behavior with reproducible evidence (and real CUBRID where relevant).
- [ ] Show failure-path or regression tests, exact versions and pass/fail/skip state.
- [ ] Update supported compatibility and migration documentation if applicable.
- [ ] Record explicit maintainer acceptance via reviewed PR; do not assume approval from green checks alone.

## References

Link related specifications, tests, PRs, upstream interface evidence and previous ADRs.

## Supersession (if applicable)

If this decision replaces an earlier accepted ADR, link the previous record and describe the compatibility/migration plan. Preserve the previous record unchanged except for its status and forward link.
