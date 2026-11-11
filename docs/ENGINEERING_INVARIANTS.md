# Engineering invariants for the Node.js CUBRID client

> **Status:** Proposed engineering review checklist and test-design requirements for `cubrid-client`, not evidence that the current implementation already satisfies every check. Review it alongside this repository's API and release policies.

## Why these invariants exist

This package implements a Node.js/TypeScript client for the CUBRID CAS protocol. The correctness of query and transaction outcomes, session and handle lifetimes, value conversion, protocol parsing, and error handling cannot be inferred from a successful query or an offline unit suite alone.

Repository-specific starting points are [API stability](API_STABILITY.md), [release policy](RELEASE_PROCESS.md), the implemented client APIs, and existing protocol and integration tests. Each claimed behavior requires evidence against this package and, where server behavior matters, an actual CUBRID instance. An official JDBC connector can be an independent semantic reference, not a source of implementation or release dependencies.

## TypeScript/Node.js CUBRID driver invariants

1. **Request sent versus not sent:** never replay a statement or transaction automatically after an ambiguous read timeout, connection loss or partial response. A TCP-connect retry is not a SQL-execution retry. Separate before-send, in-flight and after-reply states in tests. `CAS_INFO[0]=OUT_TRAN` signals transaction state, not dead TCP. Probe liveness before replacing a session; never assume a normal commit should reconnect.
2. **Physical-session ownership:** bind prepared statements, open cursors, LOB locators and transaction callbacks to a physical CAS generation. Closing or fetching a stale handle after replacement must fail safely and must never operate on a new session's identically numbered handle.
3. **Promise and transaction outcomes:** reject on failed begin, commit, rollback, close, unawaited query failure and use-after-commit/rollback. Preserve the original cause plus cleanup failures; never convert a failed transaction into a successful result. Parallel users of one connection must not join another callback's manual transaction.
4. **Data fidelity:** treat undocumented/unsupported non-NULL server types as explicit unsupported values, not fabricated SQL NULL. Keep BIGINT/DECIMAL precision, signedness, dates/timezone assumptions, binary/LOB and collections explicit. Separate `query()` row semantics from `execute()` command metadata; generated IDs are only as reliable as the actual driver contract.
5. **Protocol hardening:** test truncated/oversized frames, malformed headers, unexpected function codes, charset/escape-mode negotiation and partial FETCH. Reject invalid input before unbounded allocation. Do not expose credentials in logs, error messages or CI artifacts.
6. **Independent verification:** compare selected claims against official JDBC on the *same* DB/version with typed results and transaction outcomes, not by copying APIs. Distinguish agreement, known intentional differences, and unverified claims.

## Concrete checks for each driver PR

- [ ] Name the connection/session state transition affected, including which requests may have reached the server.
- [ ] Include one success test, one adversarial/failure test and cleanup/handle invalidation assertions where relevant.
- [ ] Prove no SQL replay, silent value substitution, guessed insert IDs or swallowed transaction errors.
- [ ] Distinguish mock protocol tests, real-CUBRID tests and pinned comparison/oracle evidence; record DB version and exact candidate SHA.
- [ ] Review Node runtime compatibility and public `exports` / `.d.ts` / `.d.cts` for package/API changes.
- [ ] Preserve the existing reviewed release workflow. An immutable GitHub tag or release is not proof that npm publication succeeded. Confirm the registry artifact before claiming a release.
- [ ] Only advertise behavior verified for named server/driver versions. Older CUBRID connectors are not called unsupported merely because a particular environment or test failed.

## Existing work, not duplicate tickets

- [#112: manual transaction isolation](https://github.com/cubrid-lab/cubrid-client/issues/112)
- [#118: semantic comparison and verification](https://github.com/cubrid-lab/cubrid-client/issues/118)
- [#120: release evidence gate](https://github.com/cubrid-lab/cubrid-client/issues/120)
- [#150: AbortSignal/query cancellation](https://github.com/cubrid-lab/cubrid-client/issues/150)
- [#189: verify npm publication](https://github.com/cubrid-lab/cubrid-client/issues/189)

Keep [API stability](API_STABILITY.md), [reviewed release process](RELEASE_PROCESS.md), and [release decision](RELEASE_DECISION.md) authoritative. This document adds review invariants; it does not declare any open issue resolved or change the published API.
