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

## Validation
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run check`

## Competition Context (공모전 — Performance Loop System)

> This repo is a **supporting track** (nice-to-have) for the competition.
> Timeline: 2026-03-25 ~ 2026-11-04
> Board: [CUBRID Ecosystem Roadmap](https://github.com/orgs/cubrid-labs/projects/2)

### Competition Role

cubrid-client already benchmarks **faster than MySQL** in TypeScript.
The competition narrative is "already fast, now production-ready" — resilience, not speed.

### Competition Issues on This Repo

| Issue | Phase | Priority |
|-------|-------|----------|
| #14 Implement reconnect, retry, and health check | R4 | Nice-to-Have |
