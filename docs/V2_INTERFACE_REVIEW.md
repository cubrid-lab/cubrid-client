# v2 interface review and verification gates

Status: review checklist, **not** an accepted API change. This document complements [ADR 0011](adr/0011-v2-binding-option-and-driver-subpath.md), the [v2 design](design/v2-api.md), and [issue #300](https://github.com/cubrid-lab/cubrid-client/issues/300).

## What is already established

- The published 1.x package exposes a Promise-based query, execute, transaction, pool and streaming API. It is **not** an implementation of Python DB-API or a universal Node.js database-driver standard.
- The 2.0 design proposes one `binding` option and a `cubrid-client/driver` subpath. Its compile-checked v2 API mock is **design evidence only**, not a shipped runtime implementation.
- Existing 1.x `query()` and `execute()` render literal SQL parameters; `*Prepared()` methods use typed server-side binds. Their type conversions, request counts and error behavior are not interchangeable.
- The design's downstream inventory was scoped to the organization as of 2026-11-12; it did not establish compatibility for every npm consumer.

## Before changing the 1.x API

| Gate | Required evidence | Not sufficient |
| --- | --- | --- |
| Public compatibility | Compare built ESM/CJS exports and declarations against the published API baseline | Source-level typecheck alone |
| Consumer compatibility | Pin and compile known downstream versions; record external consumer discovery limits | Only a hand-written mock |
| Binding semantics | Real-broker literal/prepared value and error matrix across supported CUBRID versions | Unit fixtures sharing implementation assumptions |
| Streaming | Live prepared stream: early break, throw, cancellation, partial FETCH, transaction ownership, LOB cleanup | A successful `SELECT 1` |
| SPI packaging | Test packed npm artifact's root and `/driver` ESM/CJS entry points, shared runtime identity and type resolution | Importing source files directly |
| Release policy | Explicit migration notes and SemVer classification; 1.x compatibility retained | Treating a proposed ADR as implementation approval |

## Implementation sequencing

1. **Keep the existing 1.x API unchanged** while collecting consumer and broker evidence. Resolve correctness bugs independently of the v2 redesign.
2. Review `ConnectionLike` capability boundaries and design the smallest SPI that preserves explicit unsupported-operation errors. Avoid an additional generic abstraction layer unless a real consumer requires it.
3. Implement additive binding options and a driver subpath on a focused branch **only after** their runtime contracts and compatibility checks are agreed. Do not silently fall back from prepared to literal binding.
4. Deprecate redundant 1.x entry points with migration examples. Removal belongs to a major version.
5. Select any 2.0 prepared-binding default only after the evidence gate in ADR 0011 is satisfied. Otherwise retain the literal default and document the reason.

## Known review risks

- `drizzle-cubrid` uses deprecated transaction entry points. Its compile and runtime migration must be evaluated separately from statement method signatures.
- Prepared streaming requires proof that an early exit does not double-commit or release a cursor before its final read.
- The v2 design document records a 2026-11-12 baseline and describes some features as in progress. Treat those as historical baseline statements, not the current release status; check the current source, release notes and issues before implementation.
- A successful offline CI run does not establish CAS protocol behavior. The live suite must fail rather than skip when a broker is required.

## Decision record

Mark each gate **passed**, **failed**, or **not tested**, with a commit SHA and CI/run link. Do not claim that this checklist or the v2 mock establishes production readiness. Issue #300 tracks the independent consumer and runtime evidence.
