# Contributing to cubrid-client

**Issue titles:** use a type-only prefix such as `feat:` or `bug:`, without a module scope. **PR and commit titles:** continue to use the existing Conventional Commits format and local validators. See the [shared policy](https://github.com/cubrid-lab/.github/blob/main/docs/ISSUE_PR_COMMIT_STANDARD.md) for evidence, acceptance criteria and triage responsibilities.

Thank you for your interest in contributing! This document provides guidelines
and instructions for contributing to the project.

## Table of Contents

- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Public API compatibility](#public-api-compatibility)
- [Code Style](#code-style)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Reporting Issues](#reporting-issues)

---

## Development Setup

### Prerequisites

- Node.js 18 or later
- Git
- Docker (for integration tests)

### Installation

```bash
# Clone the repository
git clone https://github.com/cubrid-lab/cubrid-client.git
cd cubrid-client

# Install dependencies
npm install

# Build
npm run build
```

---



## Test-driven implementation

For bug fixes or behavioral features, start from a reviewed interface/SQL/transaction design. Use the [TDD decision](docs/adr/0004-test-first-development.md): **Red** (run a new focused test and capture the genuine target failure), **Green** (smallest production change passing that test), **Refactor** (rerun related tests and final PR CI). In the PR description record the failing assertion/error **actually observed**, the passing assertion, which regressions ran, and whether real CUBRID validation ran or remains unverified. A mock-only pass cannot establish server compatibility; the exact release candidate still requires full live DB validation. No deliberate failing tests or skipped release checks may be left to satisfy the TDD process. For documentation and upstream feasibility work, describe the design/probe evidence rather than forcing an irrelevant Red test. The ADR and design contracts are proposals until reviewed and accepted.

## CUBRID correctness and regression evidence

For changes to CUBRID protocol, connection lifecycle, error handling, results, native SQL, ORM migrations, supported versions or releases, read [this repository's engineering invariants](docs/ENGINEERING_INVARIANTS.md) **before** implementation and review. The checks are adapted from the real bugs and tests of `pycubrid` and `sqlalchemy-cubrid`, not a Python API port. In the pull request, describe the behavioral invariant affected, the normal and failure cases tested, and which checks were offline, real CUBRID or independently compared with JDBC. State the exact CUBRID/runtime/driver versions and test outcomes when claiming database compatibility. **Do not mark tests as passed when they were skipped, missing or never executed.**

For documentation-only or nonbehavioral changes, explain why a database run is unnecessary rather than manufacturing an integration result. The final **release candidate** still follows the repository's full live-CUBRID release gate, separate from ordinary PR path optimization. These expectations supplement, and do not weaken, the established review/CI rules.

## Running Tests

### Unit Tests

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

### Type Checking

```bash
npm run typecheck
```

### Offline check

```bash
npm run check
```

This executes type checking and offline unit tests with coverage. The PR CI
also builds the package and invokes `npm run test:integration`, but it does
**not** provision CUBRID: its database-dependent integration tests self-skip.
A green CI run is not a live CAS round-trip verification. For a protocol,
reconnection or transaction change, separately run `npm run test:integration`
against a real CUBRID server and report the endpoint/version and executed test
count; state clearly when that check was not run.

---

## Protocol correctness review

For a change to the native CAS decoder, frame parser or wire constants,
reviewers must require independent protocol evidence rather than tests that
build expectations from the same enum or parser being changed:

1. Cite a versioned official CCI/CAS source or a separately captured broker
   fixture, and assert **literal wire IDs** and boundary values.
2. Assert actual returned and sent values for each affected type. Row counts,
   high statement coverage and a self-skipped integration suite are not
   evidence of protocol correctness.
3. Record live-broker versions, executed cases and failures. If no CUBRID
   server ran, mark the result **offline-only** and do not claim broad support.
4. Confirm that error/NULL handling fails closed, that query handles are
   cleaned on the correct session, and that transaction failures do not
   silently commit on another connection.
5. Review the exact npm package and public ESM/CJS/types contract before
   a production-ready release decision.

See the [v1.0.0 release regression review](docs/RELEASE_REGRESSION_REVIEW.md)
for the historical evidence and [#120](https://github.com/cubrid-lab/cubrid-client/issues/120)
for the separate required production-ready release gate.

---

## Public API compatibility

Read [the public API stability policy](docs/API_STABILITY.md) before changing
an exported TypeScript type, Promise contract, Node.js runtime requirement, or
package entrypoint. The baseline diff is a reviewer aid, not SemVer approval.


The published surface is the built `dist/index.d.ts` (and the identical
`dist/index.d.cts`), generated from `src/index.ts`. The reviewed copy of it is
committed as `api/index.d.ts`. CI (the Node 22 lane) runs `npm run api:check`
after the build and fails if the generated declarations differ from that file,
so changed public exports and types require explicit review. Private class members are not public API.

```bash
npm run build
npm run api:check    # compare dist/index.d.ts with api/index.d.ts
npm run api:update   # build, then rewrite api/index.d.ts
```

### Approving an intentional change

1. Make the change, run `npm run api:update`, and commit `api/index.d.ts` in
   the same PR. The diff of that file is what reviewers read.
2. In the PR description, say whether the change is additive or breaking.
3. Reviewers approve by merging the PR with the updated baseline. Do not update
   the baseline to silence a failure you cannot explain.

### What the 1.x contract allows

The package follows semantic versioning. Within 1.x:

- **Additive changes are allowed**: new exports, new optional options (for
  example `readTimeout`), new optional properties, new overloads that keep the
  old ones. They change the baseline, so they need the baseline update above.
- **Breaking changes are not allowed**: removing or renaming an export,
  removing a property or overload, making an optional property required,
  narrowing a parameter type, changing a return type incompatibly, or changing
  the `query<T>()` generics or transaction signatures. These need a major
  version and explicit maintainer approval.

The check parses TypeScript declarations to compare their normalized
consumer-visible shapes, excluding private class members and JSDoc comments.
It still does **not** decide whether a public diff is additive or breaking;
the reviewer does. Whitespace-only and private implementation changes are
not public contract changes.
It does not check runtime behavior or ESM/CJS import behavior, and
`query<T>()` types are compile-time only and do not validate result rows.
The declarations come from the pinned `tsup` and `typescript` versions, so an
upgrade of either can change the output; regenerate the baseline in that PR and
check that the diff is cosmetic.

---

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

### Rules

- **Indent**: Tabs
- **Line width**: 100 characters
- **Quote style**: Double quotes
- **Semicolons**: Always

### Running Checks

```bash
# Check lint and format
npx biome check src/ tests/

# Auto-fix
npx biome check --write src/ tests/
```

---

## Pull Request Review and Merge Policy

The same contributor process applies to human-written and AI-assisted
changes (OpenCode, Codex, Claude Code, ChatGPT, Copilot, etc.).
Use the repository's GitHub Actions CI checks for authoritative final
validation, with local checks encouraged but not separately required.
Review the implementation, tests, security, compatibility and documentation.
Oracle, Copilot and `agent-review` output is optional advisory context.
The responsible maintainer makes the final merge decision after required
checks and actionable findings are resolved or documented. Security,
CI permissions and release/publishing changes get independent maintainer
scrutiny. No existing repository CI or release safeguards are waived.

## Pull Request Guidelines

### Before Submitting

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/my-feature main
   ```

2. **Write tests** for any new functionality.

3. **Run the full check suite** and ensure all tests pass:
   ```bash
   npm run check
   ```

   If you touched `src/index.ts` or an exported type, also run
   `npm run build && npm run api:check` (see
   [Public API compatibility](#public-api-compatibility)).

4. **Run lint checks**:
   ```bash
   npx biome check src/ tests/
   ```

### PR Content

- Keep PRs focused — one feature or fix per PR.
- Write a clear title and description explaining _what_ and _why_.
- Reference any related issues (e.g., `Fixes #42`).
- Update documentation if your change affects the public API.
- Title the PR `type: description` without a scope. PRs are squash-merged, so this becomes the commit subject on `main`, and CI checks it. Only the generated `chore(deps)` and `chore(main)` scopes are allowed.
- Summarize user-facing changes in the PR. Release Please owns generated version/changelog entries; review the Release PR for accuracy.

### Review Process

- All PRs require at least one review before merge.
- CI must pass (lint, type check, tests).
- Maintain backward compatibility unless explicitly approved.

---

## Local issue and agent handoff

Before editing protocol, session or public API behavior, compare the latest
`main`, local open issues and overlapping PRs. New issues begin with
`status: needs triage`; maintainers verify validity, duplicates, type, scope
and urgency against all open issues in this repository. Use exactly one
`priority: critical/high/medium/low` and one `size: XS/S/M/L/XL`, then read
back the actual GitHub labels before clearing triage. A priority estimate is
not approval to merge.

Human contributors may work on unclaimed issues without required AI tools or
preapproval. Maintainer-operated autonomous agents must have authorization
and a verified GitHub assignee before taking reserved work; coordinate with
existing PR owners. Keep `database/sql`-equivalent transaction intent,
parameter binding and wire parsing safe, use focused regression tests, and
report offline versus real-database evidence separately.

## Release management

This is a Node.js/TypeScript npm package. Release Please proposes version and changelog changes in a reviewed PR; it does not automatically publish. See [the release process](docs/RELEASE_PROCESS.md) for the v1.1.0 bootstrap, manual release approval, npm publication/recovery, live CUBRID evidence and token-related CI caveat.

## Reporting Issues

When reporting a bug, please include:

- Node.js version (`node --version`)
- CUBRID server version
- cubrid-client version
- Minimal reproduction code
- Full error output

For feature requests, describe the use case and expected behavior.

---

## Questions?

Open a [GitHub Discussion](https://github.com/cubrid-lab/cubrid-client/discussions)
or file an [issue](https://github.com/cubrid-lab/cubrid-client/issues).
