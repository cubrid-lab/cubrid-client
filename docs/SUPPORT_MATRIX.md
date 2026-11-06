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

The README historically advertised CUBRID 10.2–11.4, but the required
repository CI workflow provisions **no CUBRID server**; its integration suite
self-skips live database tests. Consequently, **none** of the following
versions has a complete mandatory live CI pass.

| CUBRID release | Required live CI | Reported manual evidence (not full certification) |
| --- | --- | --- |
| 10.2 | Not configured | Selected CAS statement codes and frames reported in [#130](https://github.com/cubrid-lab/cubrid-client/pull/130) and [#122](https://github.com/cubrid-lab/cubrid-client/pull/122) |
| 11.0 | Not configured | No complete version-specific check recorded here |
| 11.2 | Not configured | TLS connection round-trip and selected frames reported in [#55](https://github.com/cubrid-lab/cubrid-client/pull/55) and [#122](https://github.com/cubrid-lab/cubrid-client/pull/122) |
| 11.4 | Not configured | Targeted BIGINT, statement-code, handle cleanup and frame tests reported in [#126](https://github.com/cubrid-lab/cubrid-client/pull/126), [#130](https://github.com/cubrid-lab/cubrid-client/pull/130), [#127](https://github.com/cubrid-lab/cubrid-client/pull/127) |
| Other server releases | Not configured | No support claim |

Manual reports are evidence of **only the named scenarios**, not a universal
version, type, TLS or transaction matrix. Do not infer compatibility from
`npm test`, offline coverage statistics, typecheck, or successful connection
to a single version. Final combined source changes may need fresh live
regression tests even when earlier PR branches reported passing checks.

## Release-blocking coverage still needed

- [#95](https://github.com/cubrid-lab/cubrid-client/issues/95): real CUBRID
  integration jobs for the exact versions the package promises.
- [#117](https://github.com/cubrid-lab/cubrid-client/issues/117): independent
  literal CAS byte/type/statement fixtures and malformed packet cases.
- [#118](https://github.com/cubrid-lab/cubrid-client/issues/118): comparison
  with the original CUBRID Node.js adapter for scoped wire/result behavior.
- [#120](https://github.com/cubrid-lab/cubrid-client/issues/120): required
  package/API/type/live-DB release decision, not just a green offline job.

Until those are complete, describe supported database versions as **targeted /
partially verified** and avoid an unqualified production-ready claim.
