# Parallel issue and pull request execution review

> **Snapshot: 2026-11-08.** Current GitHub inventory: **19 open issues and 1 open PRs** in `cubrid-client`. [Historical release note PR #221](https://github.com/cubrid-lab/cubrid-client/pull/221) has already **merged** and is not an open dependency. Recheck live state before acting; this plan approves no merge or release.

## Execution principles

- **Start independently:** TDD RED regressions, protocol fixtures, live CUBRID/JDBC comparison, npm publication recovery, dev-tool improvement and CI design. Documentation/ADR review governs **final acceptance**, not starting isolated tests or research.
- **Hard dependencies only:** a final pool API must preserve #112 transaction isolation; npm publication #166 requires authorized npm account action; final release requires candidate QA #120; merge template changes only after resolving #222 path collision.
- **Integration coordination:** merge changes to the same CAS session state machine with a combined regression suite; do not force disjoint issues into one giant PR.
- **Node contract:** Node 18 and 20 remain supported through all `cubrid-client@1.x`; Node 22 is a development toolchain, not a runtime-floor change.
- **Proof:** mark offline/real DB/packed Node 18 consumer/registry publication as distinct statuses. Never call a skipped or zero-case job a pass.

## Every open issue

| Issue | Priority | Size | Independent workstream | Actual dependency or merge boundary |
| --- | --- | --- | --- | --- |
| [#222](https://github.com/cubrid-lab/cubrid-client/issues/222) bug: consolidate case-colliding pull request templates for cross-platform checkouts | high | S | Developer setup and review | Case-colliding templates are a confirmed portable checkout defect. Coordinate final merge with #218; fix is independent of other releases and protocol work. |
| [#217](https://github.com/cubrid-lab/cubrid-client/issues/217) ci: make the documented TypeScript lint and format policy executable | high | M | Developer setup and review | Lint/format tooling decision can progress without protocol changes. Verify actual pinned command and CI. |
| [#214](https://github.com/cubrid-lab/cubrid-client/issues/214) bug: end the autocommit transaction when a query fetch fails partway | high | S | CAS, data and transaction correctness | Partial-fetch cleanup independent of query cancellation #150; coordinate only the shared session-state integration. |
| [#203](https://github.com/cubrid-lab/cubrid-client/issues/203) test: find why the lock timeout tests fail intermittently on 10.2 | low | S | CAS, data and transaction correctness | Lock timeout behavior on CUBRID 10.2 can be isolated without blocking other fixes. |
| [#175](https://github.com/cubrid-lab/cubrid-client/issues/175) test: check the type header width on NULL-typed columns | low | S | CAS, data and transaction correctness | NULL column header fixture and real server test are independent. |
| [#166](https://github.com/cubrid-lab/cubrid-client/issues/166) ci: restore npm publication for the existing v1.2.0 release | high | M | Release and distribution | Actual npm publication auth recovery requires authorized npm maintainer; no new tag or duplicate release. Independent of unrelated driver features. |
| [#150](https://github.com/cubrid-lab/cubrid-client/issues/150) feat: support per-query timeout and AbortSignal cancellation | medium | M | CAS, data and transaction correctness | AbortSignal/timeout cases independently; final change must prohibit SQL replay after ambiguous request send. |
| [#120](https://github.com/cubrid-lab/cubrid-client/issues/120) ci: block production-ready releases when database validation or API contracts are unverified | high | M | Release and distribution | Release gate can be built in parallel; final candidate must verify live CUBRID, Node 18 packed ESM/CJS and exact artifact. |
| [#118](https://github.com/cubrid-lab/cubrid-client/issues/118) test: verify Node.js client semantics against official CUBRID JDBC | high | M | Release and distribution | JDBC/official-driver comparison is independently executable and supplies evidence to other issues. |
| [#113](https://github.com/cubrid-lab/cubrid-client/issues/113) bug: keep decoded CUBRID date and time values stable across Node.js time zones | high | M | CAS, data and transaction correctness | Timezone-dependent decoding RED tests start independently of JSON/timezone-aware feature #111. |
| [#112](https://github.com/cubrid-lab/cubrid-client/issues/112) bug: prevent unrelated queries from joining manual transactions | critical | M | CAS, data and transaction correctness | Transaction cross-talk regression independent of other fixes; future pool work #92 must respect this isolation contract. |
| [#111](https://github.com/cubrid-lab/cubrid-client/issues/111) feat: decode JSON and timezone-aware CUBRID values with documented JavaScript types | medium | M | CAS, data and transaction correctness | Type-codec specification and live values may be tested independently; align date/time public types with #113 at final integration. |
| [#106](https://github.com/cubrid-lab/cubrid-client/issues/106) chore: verify and publish the existing 1.2.0 fixes | medium | M | Release and distribution | GitHub v1.2.0 release exists; keep historical QA separate from npm registry recovery #166. |
| [#105](https://github.com/cubrid-lab/cubrid-client/issues/105) chore: prepare reviewed npm releases with release-please | medium | M | Release and distribution | Release-please candidate workflow can be prototyped independently; do not gate existing v1.2.0 recovery on it. |
| [#103](https://github.com/cubrid-lab/cubrid-client/issues/103) feat: write BLOB and CLOB values through the CAS LOB protocol | medium | L | CAS, data and transaction correctness | LOB protocol tests can start; integration later shares cursor/stream ownership with #150. |
| [#101](https://github.com/cubrid-lab/cubrid-client/issues/101) chore: publish npm releases with provenance | medium | M | Release and distribution | OIDC/provenance research independent of release-please; coordinate publish workflow with #166 only for deployment. |
| [#96](https://github.com/cubrid-lab/cubrid-client/issues/96) chore: update the supported Node.js versions | medium | S | Release and distribution | Node 18/20 compatibility remains required across all 1.x; Node 22 dev tooling can evolve separately. |
| [#92](https://github.com/cubrid-lab/cubrid-client/issues/92) feat: reuse connections with a connection pool | medium | L | CAS, data and transaction correctness | Pool contract/testing starts now; final pool release requires proven transaction isolation (#112). |
| [#86](https://github.com/cubrid-lab/cubrid-client/issues/86) feat: add batch execution for multi-row inserts and updates | medium | L | CAS, data and transaction correctness | Batch failure and partial-result research independent; stable API later needs typed-error and no-replay contract. |

## Every open PR

| PR | Priority | Review and merge implications |
| --- | --- | --- |
| [#218](https://github.com/cubrid-lab/cubrid-client/pull/218) docs: define cubrid-client engineering, testing, and release standards | high | Policy, ADRs and setup guidance can be reviewed independently of driver fixes; however this branch edits **both** case-colliding PR templates and must be reconciled with #222 before claiming macOS/Windows setup portability. Check latest CI, and review/rebase against main after #221 merged. |

## Merge/release decision

Release policy approval is not a global semaphore for investigations. Independent tests and consumer fixtures may proceed in parallel now; only breaking API/public package changes require reviewed designs. Do not issue a new v1.2.0 Git tag to address npm authentication. Resolve real hard blockers, obtain final-head PR CI/review, then verify the exact release candidate and npm registry. Link actual validation before closing any issue.
