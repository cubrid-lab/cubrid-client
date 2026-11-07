# Engineering invariants learned from the Python CUBRID projects

> **Status:** Engineering review checklist and test-design requirements, not evidence that this repository already passes them. Adopted from verified scenarios in [pycubrid](https://github.com/cubrid-lab/pycubrid) and [sqlalchemy-cubrid](https://github.com/cubrid-lab/sqlalchemy-cubrid), with language-native adaptation. Review together with this repository's release policy before claiming stable support.

## Why these invariants exist

The Python driver and SQLAlchemy dialect revealed that a passing query or green offline suite is not enough. Bugs occurred around transaction boundaries, CAS session replacement, stale handles, partial fetches, value fidelity, state transitions, unsupported SQL and skipped live tests. They also established reusable **methods**: protocol fixtures, modeled lifecycle tests, JDBC/driver differential cases, explicit failure modes, catalog/DDL tests, and candidate-SHA evidence. **Do not port Python API shapes, source code, or version rules into another language.**

Useful concrete sources:
- [pycubrid CAS reconnect architecture](https://github.com/cubrid-lab/pycubrid/blob/main/docs/ARCHITECTURE.md#cas-reconnection), [session persistence tests](https://github.com/cubrid-lab/pycubrid/blob/main/tests/test_cas_session_persistence.py), [cursor ownership tests](https://github.com/cubrid-lab/pycubrid/blob/main/tests/test_autocommit_handle_ownership.py)
- [pycubrid connection state-machine tests](https://github.com/cubrid-lab/pycubrid/blob/main/tests/test_connection_state_machine.py), [official-driver differential cases](https://github.com/cubrid-lab/pycubrid/blob/main/tests/test_official_differential.py)
- [SQLAlchemy CUBRID architecture](https://github.com/cubrid-lab/sqlalchemy-cubrid/blob/main/docs/ARCHITECTURE.md), [transactional DDL tests](https://github.com/cubrid-lab/sqlalchemy-cubrid/blob/main/test/test_transactional_ddl.py), [live integration gate tests](https://github.com/cubrid-lab/sqlalchemy-cubrid/blob/main/test/test_integration_gate.py), [release-note formatting](https://github.com/cubrid-lab/sqlalchemy-cubrid/blob/main/docs/RELEASE_NOTES_STYLE.md)

**Evidence rule:** the Python code/tests are counterexamples and research references, not proof of the corresponding Go, Rust or TypeScript behavior. Every native implementation must demonstrate its own actual behavior on a real CUBRID server.

## TypeScript/Node.js CUBRID driver invariants

1. **Request sent versus not sent:** never replay a statement or transaction automatically after an ambiguous read timeout, connection loss or partial response. A TCP-connect retry is not a SQL-execution retry. Separate before-send, in-flight and after-reply states in tests. `CAS_INFO[0]=OUT_TRAN` signals transaction state, not dead TCP. Probe liveness before replacing a session; never assume a normal commit should reconnect.
2. **Physical-session ownership:** bind prepared statements, open cursors, LOB locators and transaction callbacks to a physical CAS generation. Closing or fetching a stale handle after replacement must fail safely and must never operate on a new session's identically numbered handle.
3. **Promise and transaction outcomes:** reject on failed begin, commit, rollback, close, unawaited query failure and use-after-commit/rollback. Preserve the original cause plus cleanup failures; never convert a failed transaction into a successful result. Parallel users of one connection must not join another callback's manual transaction.
4. **Data fidelity:** treat undocumented/unsupported non-NULL server types as explicit unsupported values, not fabricated SQL NULL. Keep BIGINT/DECIMAL precision, signedness, dates/timezone assumptions, binary/LOB and collections explicit. Separate `query()` row semantics from `execute()` command metadata; generated IDs are only as reliable as the actual driver contract.
5. **Protocol hardening:** test truncated/oversized frames, malformed headers, unexpected function codes, charset/escape-mode negotiation and partial FETCH. Reject invalid input before unbounded allocation. Do not expose credentials in logs, error messages or CI artifacts.
6. **Independent verification:** compare claims against official JDBC and pycubrid on the *same* DB/version with typed results and transaction outcomes, not by copying APIs. Distinguish agreement, known intentional differences, and unverified claims.

## Concrete checks for each driver PR

- [ ] Name the connection/session state transition affected, including which requests may have reached the server.
- [ ] Include one success test, one adversarial/failure test and cleanup/handle invalidation assertions where relevant.
- [ ] Prove no SQL replay, silent value substitution, guessed insert IDs or swallowed transaction errors.
- [ ] Distinguish mock protocol tests, real-CUBRID tests and pinned comparison/oracle evidence; record DB version and exact candidate SHA.
- [ ] Review Node runtime compatibility and public `exports` / `.d.ts` / `.d.cts` for package/API changes.
- [ ] Preserve the existing reviewed release workflow. An immutable GitHub tag or release is not proof that npm publication succeeded. Confirm the registry artifact before claiming a release.
- [ ] Only advertise behavior verified for named server/driver versions. Older CUBRID connectors are not called unsupported merely because a particular environment or test failed.

## Existing work, not duplicate tickets

- [#214: autocommit cleanup after partial fetch](https://github.com/cubrid-lab/cubrid-client/issues/214)
- [#112: manual transaction isolation](https://github.com/cubrid-lab/cubrid-client/issues/112)
- [#118: JDBC and pycubrid semantic comparison](https://github.com/cubrid-lab/cubrid-client/issues/118)
- [#120: release evidence gate](https://github.com/cubrid-lab/cubrid-client/issues/120)
- [#150: AbortSignal/query cancellation](https://github.com/cubrid-lab/cubrid-client/issues/150)
- [#189: verify npm publication](https://github.com/cubrid-lab/cubrid-client/issues/189)

Keep [API stability](API_STABILITY.md), [reviewed release process](RELEASE_PROCESS.md), and [release decision](RELEASE_DECISION.md) authoritative. This document adds review invariants; it does not declare any open issue resolved or change the published API.
