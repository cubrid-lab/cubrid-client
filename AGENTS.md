# AGENTS.md

## Shared issue and pull request policy

See [cubrid-lab issue, PR, and commit standard](https://github.com/cubrid-lab/.github/blob/main/docs/ISSUE_PR_COMMIT_STANDARD.md). Issues use a simple type-only title (`feat: ...`, `bug: ...`, `docs: ...`) without required module names. Describe the problem or goal, relevant evidence, and a verifiable outcome; keep implementation details provisional. Triage owns validity, duplicates, scope, priority and size. Pull requests and commits use the existing Conventional Commits/CI requirements and document actual changes and checks. Do not include internal agent instructions or personal comments in public issue prose.


## Purpose
`cubrid-client` is a TypeScript-first client library for CUBRID.

## Read First
- `README.md`
- `PRD.md`
- `CONTRIBUTING.md`
- `docs/agent-playbook.md`

## Working Rules
- Keep public TypeScript API, examples, and docs aligned.
- Preserve typed query ergonomics and transaction behavior unless intentionally redesigning the contract.
- Prefer compatibility-safe changes because this repo is library code.
- Add or update tests for any protocol or public client behavior change.




## Development setup before design and TDD implementation

Use the repository-specific [development setup guide](docs/DEVELOPMENT_SETUP.md) and [setup ADR 0005](docs/adr/0005-development-setup.md) (**Proposed**) before attempting new runtime or ORM work. Verify the **actual** manifest, supported developer toolchain, dependency resolution, read-only offline checks, and availability/absence of real CUBRID integration separately. Do not invent an unavailable Docker Compose file, integration test, linter, Cargo registry artifact, or Go module import path. A successful unit build is not a successful real-database test or a published package. Record observed setup blockers as issues; do not silently change public consumer engine/Go module paths/Rust MSRV, weaken CI, or modify release credentials to make onboarding appear green.

## Test-first implementation after architecture review

Before implementing a CUBRID behavior change, check the approved API/SQL/protocol contract and [TDD ADR 0004](docs/adr/0004-test-first-development.md) (**currently Proposed**). Follow **Red → Green → Refactor** in focused slices: execute a deterministic failure for the intended reason first, implement the smallest fix, rerun the case and relevant regressions, then refactor. Explain the initial failure and actual checks in the PR without inventing command output. A final PR must pass its required CI; never keep a deliberately failing regression as proof of Red. Confirm database-dependent behavior through real CUBRID tests and the release candidate matrix; mocks alone cannot certify it. Upstream feasibility prototypes and docs-only changes are exempt from ritual Red steps but must show their own accurate evidence. Release policy and architecture decisions must be approved before classifying design as completed.

## Architecture decisions and release order

Read the [repository ADR index](docs/adr/README.md) before proposing changes to public behavior, release contracts, native dialect design, transaction ownership or migrations. ADR 0001 records release governance; ADR 0002 records the failure-evidence contract learned from Python; native architecture ADR 0003 (where applicable) is **Proposed** in the separate draft architecture PR. Do not treat a Proposed ADR as approved. Adopt the release policy before accepting the architecture ADR; require actual tested evidence before claiming implementation or release readiness. Use the [ADR template](docs/adr/TEMPLATE.md) for material new decisions, not for every trivial change.

## CUBRID correctness lessons and native regression review

Before changing protocol, SQL generation, transaction handling, schema migrations, type codecs, connection recovery or release claims, review [the repository-specific engineering invariants](docs/ENGINEERING_INVARIANTS.md). These are based on concrete pycubrid/sqlalchemy-cubrid failure cases but must be implemented and tested using **this language's native interfaces**, not copied Python APIs. Distinguish mock tests, live CUBRID execution and independent differential evidence; never claim a check ran without its actual CI result. For an unrelated docs-only change, the checklist is advisory and does not mandate unnecessary database jobs. Existing repository review and merge requirements remain authoritative.

## Development Workflow (cubrid-lab org standard)

Apply **identical PR review and merge criteria** regardless of whether
code was written by a person, OpenCode, Codex, Claude Code, ChatGPT,
Copilot or any other agent. No specific AI review is a prerequisite.

1. Implement a focused change with tests and affected documentation.
2. Required GitHub Actions CI checks, appropriate to this repository,
   are the authoritative verification at the final head. Local testing
   is recommended but not an additional required gate.
3. Review correctness, tests, security, API compatibility, maintainability,
   and scope. Oracle, Copilot and `agent-review` findings are optional,
   **advisory**, and never automatic approval or rejection.
4. Disposition outstanding findings and let the responsible maintainer
   decide on merge after checking required CI. Security, CI permissions,
   release and publication changes need explicit independent review.

Preserve existing branch protection, integration tests, compatibility and
release safeguards. Do not create tool-dependent Oracle/Copilot routes.

## Validation
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run api:check` (after build; if the public API change is intentional run `npm run api:update` and commit `api/index.d.ts`)
- `npm run check`

## Project Context — Performance Loop System

> This repo is a **supporting track** (nice-to-have) for the Performance Loop.
> Board: [CUBRID Ecosystem Roadmap](https://github.com/orgs/cubrid-lab/projects/2)

### Role

Do not claim that cubrid-client is faster than another database's driver: the
only comparison is the external-harness result in `docs/PERFORMANCE.md`, which
compares different database engines and is not a goal. Release scope is deliberately limited
(see `docs/API_STABILITY.md`, `docs/RELEASE_DECISION.md` and
`docs/SUPPORT_MATRIX.md`); do not describe the client as production-ready
without a recorded verification decision. The focus is resilience and
verified correctness, not speed.

### Related Issues

| Issue | Phase | Priority |
|-------|-------|----------|
| #14 Implement reconnect, retry, and health check | R4 | Nice-to-Have |

## Human-readable communication (all agents)

Use this rule for text authored or edited by Codex, Claude Code, OpenCode,
ChatGPT, Copilot, or any other agent. It applies to issues, PRs, reviews,
comments, checklists, status updates, commit summaries, release notes,
documentation, presentations, and other maintainer-facing writing.

- Write for a reader unfamiliar with the underlying script, storyboard,
  automation run, or agent plan. Name the actual project, component,
  action, evidence, and location in ordinary, clear language.
- Never use unexplained internal identifiers as reader-facing labels or
  checklist instructions (for example, `H1, P1, C1, K1, F2` or `A1/B1/R1/R2`).
  Do not substitute `P1`/`P2` for repository priority labels.
- When an internal identifier is necessary for accurate cross-reference,
  **describe the subject first**, then add the identifier in context:
  `pycubrid introduction (0:20; storyboard shot P1)`. Use descriptive
  names and timestamps, section titles, or paths wherever practical.
- Use natural, actionable wording. Prefer `Listen to the full narration and
  verify the pronunciation of each project name` to `Maintainer full listen`.
  Avoid compressed task fragments, unexplained acronyms, and generated
  process/status jargon.
- Keep legitimate technical identifiers unchanged in code, tests, structured
  data, logs, specifications, and exact evidence references. Issue numbers,
  filenames, command names, APIs, error codes, and hashes are not prohibited.
  Do not break machine-readable references to improve prose.
- Before publishing, reread the text as a first-time maintainer. It should
  state what happened or needs to happen, why, and where without requiring a
  separate lookup table. Edit an existing editable comment to correct unclear
  wording rather than adding redundant follow-up comments.

This is a shared writing convention, not a new CI check, reviewer approval,
or merge gate. Keep existing repository-specific technical and safety rules.

### Self-explanatory code comments, tests and review text

Source comments, test names and test comments, examples, PR descriptions
and review replies follow the organization rule in
[Explanations in code, tests, reviews and agent-written text](https://github.com/cubrid-lab/.github/blob/main/docs/ISSUE_PR_COMMIT_STANDARD.md#6-explanations-in-code-tests-reviews-and-agent-written-text)
(section 6 of the shared standard; it is linked here, not copied). In short:
say what happens, why it matters and which constraint applies, then add an
issue number or scenario code only for traceability. The TLS upgrade comment
on `upgradeToTls` in `src/protocol/connection.ts` is a good local model: it
states the broker's exact byte ordering, why a second int must not be read,
and how that was verified.

Repository-specific rules in this file (CUBRID wire compatibility, public
TypeScript API, tests and CI) keep precedence. The rule is a writing
convention checked during normal review, not a CI gate or required reviewer.
Do not rename test names, fixtures or other machine-readable identifiers
only to improve prose.

## Issue triage lifecycle

New issues in this repository begin with `status: needs triage`. Any issue
forms include the label; the `issues: opened` workflow covers external
submissions. GitHub Actions using `GITHUB_TOKEN` must attach it when creating
issues because their own events may not trigger this workflow.

1. Confirm the problem and evidence, investigate unknowns, detect duplicate
   issues and overlapping open PRs, and check local ownership, issue type,
   scope/non-goals, dependencies and testable acceptance.
2. Compare **all currently open issues in this repository** (including API
   pagination) before deciding relative priority, considering user impact,
   existing work and blockers rather than issue age.
3. Assign one `priority: critical/high/medium/low` and one of the original
   `size: XS/S/M/L/XL`; split oversized implementation work where useful,
   retaining ownership and any parent completion contract.
4. Re-fetch the saved GitHub labels and validate issue type, priority, size,
   scope and duplicate disposition. Remove `status: needs triage` only when
   the maintainer has completed that check. Otherwise retain it.

This process never guesses issue urgency or creates another PR gate. Existing
quality, security and release expectations still apply.
