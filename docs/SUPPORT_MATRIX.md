# Tested and declared compatibility

This matrix separates **declared support**, **automated offline tests**, and
**manually reported live checks**. Only results backed by a CI job with a real
broker qualify as live CI coverage.

## Node.js

| Node version | Package declaration | PR CI typecheck / unit / build | Published-package consumer smoke |
| --- | --- | --- | --- |
| 18 | `engines.node >=18` | Included | Not established |
| 20 | Included by >=18 | Included | Not established |
| 22 | Included by >=18 | Included, plus declaration API check | Not established |
| Newer versions | Included by >=18 | Not claimed as matrix coverage | Not established |

The `tsup` build-tool Node.js requirement is **not** the runtime floor for
users importing the emitted npm package. A change to `engines` in 1.x is
governed by [API_STABILITY.md](API_STABILITY.md).

## CUBRID server / broker

The dedicated [Live CUBRID integration workflow](../.github/workflows/live-cubrid.yml)
now provisions disposable databases. On **2026-11-06**, the
[main branch full-matrix run](https://github.com/cubrid-lab/cubrid-client/actions/runs/42216017228)
used Node.js 22 and finished **23 passed, 0 failed, 0 skipped** on each
of the four image tags. It exercises the integration suite's actual assertions,
not all possible SQL types, broker options or fault-injection scenarios.

| CUBRID image tag | Actual live CI | Scope of evidence |
| --- | --- | --- |
| 10.2 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| 11.0 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| 11.2 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| 11.4 | 23/23 passed, 0 skipped | Current integration suite with a real broker |
| Other versions | Not tested in this workflow | No coverage claim |

Pull requests touching runtime code or the live workflow execute the 11.4
integration suite; a push to main executes the four-version matrix. A manual
dispatch can run all four versions before a release. The dedicated workflow
uses `CUBRID_LIVE_REQUIRED=1` so an unreachable server fails rather than
quietly self-skipping. The separate general-purpose Node.js CI still runs
its offline/self-skipping integration command and is **not** evidence of live
CUBRID coverage.

These results are a substantial improvement over the earlier targeted manual
checks, but the suite is not an exhaustive type round-trip or
fault-injection test. A separately required
[real SSL=ON CUBRID 11.4 workflow](https://github.com/cubrid-lab/cubrid-client/actions/runs/42217503095)
now verifies **3/3 tests with 0 skips**: a trusted CA/hostname-verified SQL
query, rejection of the untrusted self-signed certificate, and rejection
of a wrong hostname even with the correct CA. It does **not** establish TLS
compatibility on every database version, or independent JSON/LOB
coverage. Do not equate these 23 tests
with production-ready certification. See [#95](https://github.com/cubrid-lab/cubrid-client/issues/95)
and the [release gate](https://github.com/cubrid-lab/cubrid-client/issues/120).

The integration suite now also asserts decoded SET, MULTISET and SEQUENCE values:
29/29 passed with 0 skipped against local `cubrid/cubrid` 10.2, 11.0, 11.2 and
11.4 containers when that decoder was added
([#82](https://github.com/cubrid-lab/cubrid-client/issues/82)). The table above
records the earlier CI runs and has not been re-recorded with these cases.

## Release-blocking coverage still needed

- [#95](https://github.com/cubrid-lab/cubrid-client/issues/95):
  mandatory version-matrix and SSL=ON broker lanes are now implemented;
  their passing scope is exactly the 23+3 named tests, not every type/fault.
- [#117](https://github.com/cubrid-lab/cubrid-client/issues/117): independent
  literal CAS byte/type/statement fixtures and malformed packet cases.
- [#118](https://github.com/cubrid-lab/cubrid-client/issues/118): comparison
  with the original CUBRID Node.js adapter for scoped wire/result behavior.
- [#120](https://github.com/cubrid-lab/cubrid-client/issues/120): required
  package/API/type/live-DB release decision, not just a green offline job.

Until those are complete, describe the documented live matrix as **verified
for the 23 named integration tests only**, not broadly production-ready.
