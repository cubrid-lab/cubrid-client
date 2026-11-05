# Contributing to cubrid-client

**Issue titles:** use a type-only prefix such as `feat:` or `bug:`, without a module scope. **PR and commit titles:** continue to use the existing Conventional Commits format and local validators. See the [shared policy](https://github.com/cubrid-lab/.github/blob/main/docs/ISSUE_PR_COMMIT_STANDARD.md) for evidence, acceptance criteria and triage responsibilities.

Thank you for your interest in contributing! This document provides guidelines
and instructions for contributing to the project.

## Table of Contents

- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
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

4. **Run lint checks**:
   ```bash
   npx biome check src/ tests/
   ```

### PR Content

- Keep PRs focused — one feature or fix per PR.
- Write a clear title and description explaining _what_ and _why_.
- Reference any related issues (e.g., `Fixes #42`).
- Update documentation if your change affects the public API.
- Update `CHANGELOG.md` with a summary of your change.

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
