# Architecture Decision Records (ADRs)

ADRs preserve **why** a consequential technical or release decision was made, the realistic alternatives, the consequences, and the evidence required to confirm it. A design guide explains *how to implement* a choice; an ADR explains *why that choice was selected*. ADRs do not replace the implementation, tests, CI or the authoritative published package contract.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-release-governance.md) | Release, SemVer and compatibility governance | Proposed (codifying the existing 1.x rules) |
| [0002](0002-database-correctness-evidence.md) | CUBRID correctness and failure-evidence requirements | Proposed |
| [0003](0003-native-node-driver-boundaries.md) | Native Node.js CAS driver and ORM responsibility | Proposed (existing behavior recorded; not full support certification) |
| [0004](0004-test-first-development.md) | TDD: design contract, Red–Green–Refactor and live-CUBRID verification | Proposed |
| [0005](0005-development-setup.md) | Reproducible language-native developer setup and verification | Proposed |
| [0006](0006-node-18-support-through-1x.md) | Retain Node.js 18 consumer support throughout 1.x; consider removal no earlier than 2.0 | Proposed |

The Node.js driver already has an established release process; these proposals record the rules without changing it.

## ADR lifecycle

- **Proposed:** a design decision under review. No project-wide requirement is claimed accepted merely because this file was committed to a PR.
- **Accepted:** a maintainer explicitly approves the decision in a reviewed PR, with required final-head checks. Record the acceptance PR/date by editing status and the decision record, not by guessing the reviewer.
- **Superseded:** a new numbered ADR accepts a different decision and links back to this one. Keep historic records; do not silently rewrite the reasoning to match a later implementation.
- **Rejected:** retained for traceability when the chosen alternative is not adopted.

Create a monotonically numbered `NNNN-plain-language-topic.md` file for a **material choice** (release contract, compatibility boundary, storage/transaction model, migration policy). Do not write one for every trivial code refactor or test case. Required headings: **Status, Context, Decision, Alternatives considered, Consequences and trade-offs, Verification / acceptance criteria, References**. Explain observable impact rather than using opaque tracking identifiers as the title. Link specific source code, tests, ADRs or issues.

Release policy must be reviewed **before** progressing the separate architecture proposal to acceptance. Code-level regressions remain tracked in the existing issue backlog, and real CUBRID tests remain mandatory where the release makes database-behavior claims.

Related current PR: [#218](https://github.com/cubrid-lab/cubrid-client/pull/218).
