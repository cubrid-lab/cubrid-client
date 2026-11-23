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

- **Consumer compatibility, 1.x half (2026-11-23):** the known consumers (drizzle-cubrid, cubrid-benchmark, cubrid-mcp) and the search limits are recorded at pinned revisions in [CONSUMER_INVENTORY.md](CONSUMER_INVENTORY.md), and `tests/consumer-fixtures/` compiles their 1.x usage in `npm run typecheck`. The v2 half (the same fixtures against the proposal) is **not tested** until ADR 0011 is decided.

## Drizzle integration: defer breaking interface changes to 2.0

Review snapshot: 2026-11-17, `cubrid-lab/drizzle-cubrid` main. The adapter declares `cubrid-client >=1.4.0 <2.0.0`; the default entry point still extends Drizzle's MySQL classes, while `drizzle-cubrid/native` is an experimental CUBRID-specific preview. Its documented live integration target is CUBRID 11.4. This is **not** a claim of full compatibility across every ORM feature or CUBRID version.

| Proposed interface change | 1.x disposition | 2.0 design requirement |
| --- | --- | --- |
| Replace `queryPrepared()` / `executePrepared()` with `binding` options | Preserve published methods; additive bridge only after evidence | Adapt both legacy and native Drizzle sessions to one statement contract; preserve explicit prepared semantics and errors |
| Remove client-level `beginTransaction()`, `commit()`, `rollback()` | Keep compatibility and documented deprecations | Migrate any remaining Drizzle fallback to scoped `transaction(callback)` or explicit transaction scope; never silently use a shared connection |
| Reshape `ConnectionLike` and move SPI exports to `/driver` | Preserve root exports; optional additive subpath | Verify packed ESM/CJS imports and TypeScript structural compatibility for Drizzle, custom adapters and pools |
| Change binding or timezone defaults | Keep 1.x defaults | Require live type, date/time, charset and query behavior evidence plus migration guidance |
| Replace MySQL-derived Drizzle dialect classes | No change to `cubrid-client` API required | Track in `drizzle-cubrid` native-dialect work; avoid coupling it to the driver 2.0 release without a proven dependency |

**Separate correctness fixes from API migration.** Do **not** postpone data-integrity or security defects merely because 2.0 will change the interface. Existing [cubrid-client #297](https://github.com/cubrid-lab/cubrid-client/issues/297) (concurrent generated keys), [drizzle-cubrid #216](https://github.com/cubrid-lab/drizzle-cubrid/issues/216) (BIT bytes) and [drizzle-cubrid #237](https://github.com/cubrid-lab/drizzle-cubrid/issues/237) (CHAR IN comparisons) require independent triage and compatible fixes where possible.

Before declaring 2.0 integration ready, test both Drizzle entry points against the proposed driver with pinned dependency versions: ordinary and prepared SELECT/DML, positional rows with repeated labels, `$returningId()` under concurrent pool inserts, transaction rollback and savepoints, UTC temporal round trips, collections and binary values, and ESM/CJS consumer imports. Record the test environment and explicitly mark unsupported features rather than inferring parity from compilation.

Related design: [ADR 0011](adr/0011-v2-binding-option-and-driver-subpath.md), [v2 API design](design/v2-api.md), [compatibility evidence issue #300](https://github.com/cubrid-lab/cubrid-client/issues/300).
