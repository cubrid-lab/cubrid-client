# ADR 0006: Keep Node.js 18 support for every 1.x release

- **Status:** Proposed (records the existing public 1.x support decision)
- **Date:** 2026-11-08
- **Scope:** npm `cubrid-client` runtime compatibility, CI and release policy
- **Existing contract:** [API stability and Node.js support schedule](../API_STABILITY.md)

## Context

The package currently publishes `engines.node >=18` and has a 1.x public compatibility policy. Its existing [API stability schedule](../API_STABILITY.md#nodejs-support-schedule) explicitly retains **Node.js 18 and Node.js 20 for the complete 1.x line** even though both lines are end-of-life upstream. The project intentionally plans to reconsider the minimum Node.js runtime in a future **2.0 MAJOR**. Developer tooling may require a newer Node release, which must not silently change the runtime requirement of the published package.

## Decision

1. **Keep `engines.node >=18` through all 1.x MINOR, PATCH and maintenance releases.** No dependency, transpilation target, runtime built-in, ESM/CJS import path, or generated package entrypoint may require Node >18 during the 1.x generation. Preserve Node 20 as well, consistent with the existing API stability schedule.
2. A Node 22 `.nvmrc` is a **contributor/build toolchain preference**, not a consumer runtime support increase. It is acceptable to execute the latest build, coverage, lint or release tooling on Node 22 while keeping the emitted JavaScript and published tarball usable on Node 18.
3. Test actual **packed/distributed** ESM and CommonJS entrypoints under Node 18, with package exports, basic API imports, and representative non-DB behavior; run live CUBRID behavior tests separately with the supported runtime where practical. Compilation on Node 22 is not proof of Node 18 support.
4. Enforce a compatibility review for new npm dependencies and runtime syntax/built-ins before merge and release. If a development-only dependency cannot execute on Node 18, keep it in a separate modern-Node toolchain job rather than raising `engines.node` or disabling the Node 18 consumer smoke.
5. **The earliest proposed support drop is v2.0.0**, via an explicitly reviewed MAJOR compatibility decision, release notes and migration guidance. That future release is neither scheduled nor authorized by this ADR. Any 1.x security/bug fix must preserve Node 18; if a fix cannot satisfy that guarantee, document the blocker rather than silently ship an incompatible PATCH/MINOR.

## Alternatives considered

- **Rejected:** Raise `engines.node` to 20/22 during 1.x because upstream Node 18 is EOL.
- **Rejected:** Equate a green Node 22 build or TypeScript check with genuine Node 18 consumer compatibility.
- **Rejected:** Downgrade all contributor tools to Node 18 purely to keep the runtime support promise.

## Consequences and trade-offs

Supporting EOL runtime lines carries maintenance and security limits and may require an older compatible runtime dependency or separate CI lane. Document upstream EOL and recommend supported LTS Node for new deployments, **without claiming Node 18 was removed from 1.x**. Independently verify any introduced dependency against Node 18; a tool-only upgrade must not force a major runtime floor change.

## Verification / acceptance criteria

- [ ] `package.json` retains `engines.node >=18` for the entire 1.x generation.
- [ ] Required Node 18 **external packed-artifact** ESM/CommonJS tests execute with real assertions on each release candidate; no missing/skipped/zero-test success.
- [ ] The compiled package does not rely on newer Node-only runtime APIs; `npm pack` and external consumer checks report actual versions.
- [ ] Current Node 22 developer tooling remains explicitly separate from the consumer floor; CI never hides a failed Node 18 smoke behind a green developer matrix.
- [ ] Release notes and docs clearly retain Node 18/20 during 1.x and reserve any removal for a reviewed future 2.0.
- [ ] The recorded contract is explicitly reviewed/accepted by maintainers; documentation alone is not a successful test or approval.

## References

[Existing API stability schedule](../API_STABILITY.md#nodejs-support-schedule), [development setup](../DEVELOPMENT_SETUP.md), [release ADR](0001-release-governance.md), [setup ADR](0005-development-setup.md).
