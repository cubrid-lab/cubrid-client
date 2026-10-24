# AGENTS.md

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
- `npm run check`

## Project Context — Performance Loop System

> This repo is a **supporting track** (nice-to-have) for the Performance Loop.
> Board: [CUBRID Ecosystem Roadmap](https://github.com/orgs/cubrid-lab/projects/2)

### Role

cubrid-client already benchmarks **faster than MySQL** in TypeScript.
The narrative is "already fast, now production-ready" — resilience, not speed.

### Related Issues

| Issue | Phase | Priority |
|-------|-------|----------|
| #14 Implement reconnect, retry, and health check | R4 | Nice-to-Have |

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
