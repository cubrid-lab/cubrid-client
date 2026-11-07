# Development setup — Node.js CUBRID driver

> **Status:** Setup instructions based on checked-in `package.json` and CI; **commands in this document have not been run for this change**. [ADR 0005](adr/0005-development-setup.md) is Proposed. Use a clean checkout; don't interpret a successful offline suite as a live broker test.

## Toolchain and dependencies

- Git, npm, Node.js. **Recommended local development Node version: 22**, to match a modern supported CI lane for build tools; `engines.node >=18` is the **published consumer contract**, not a promise that every current devDependency works on Node 18. CI tests Node 18/20/22/24/26 according to the repository's actual workflow.
- `package-lock.json` is committed; use `npm ci` instead of `npm install` for reproducible setup. Do not re-resolve dependencies or change the consumer engine during onboarding.
- Use optional Docker/external CUBRID only when a *real* live integration test is being run. This repository does **not** contain a root `docker-compose.yml` on the inspected main branch.

```sh
git clone https://github.com/cubrid-lab/cubrid-client.git
cd cubrid-client
node --version
npm --version
npm ci
npm run typecheck
npm test
npm run build
npm run api:check
```

Run `npm run test:coverage` for offline coverage. `npm run check` runs type checking and offline coverage tests. The package uses Node's built-in test runner with `tsx`, `tsup`, TypeScript and `c8`; do not replace this with Vitest or run undocumented Biome commands. Current `CONTRIBUTING.md` still contains a historical `npx biome` instruction, but `package.json` does not declare Biome. Until it is reconciled, **do not claim the Biome command is part of the verified default setup**.

## Real CUBRID integration (separate environment)

`tests/integration.test.ts` exists; `npm run test:integration` invokes it. Without a reachable broker the default lane **may self-skip** real DB cases. An ordinary successful exit therefore does **not** prove a live CUBRID integration run.

Set up a disposable CUBRID broker and database through a tested external/provisioned environment, verify its host, port, version and authentication, and then run:

```sh
CUBRID_LIVE_REQUIRED=1 npm run test:integration
```

The integration fixture documents `CUBRID_TEST_PORT` (default 33000) and other `CUBRID_TEST_*` overrides; inspect the fixture before adjusting credentials/endpoint. **Never** pass production credentials into a test suite or leak passwords in CI logs. A release candidate requires an explicit tested CUBRID matrix and a nonzero count of executed SQL assertions, beyond this workstation smoke.

## Consumer and release checks

```sh
npm run build
npm run api:check
npm pack --dry-run
```

`npm pack --dry-run` inspects packaging locally; **it does not publish anything** and cannot replace the reviewed release-validation workflow or installed ESM/CJS/TypeScript consumer tests. The checked-in `docs/RELEASE_DECISION.md` distinguishes GitHub Release state from actual npm publication. Do not publish or change npm credentials during setup.

## Known setup decisions and exit gate

- [ ] `npm ci`, typecheck, offline tests and build succeed on the selected Node 22 dev environment, with actual log/output recorded.
- [ ] `npm run api:check` and package exports are tested on the exact candidate if applicable.
- [ ] The historical Biome command is reconciled with real dependencies; no arbitrary new lint tool is assumed installed.
- [ ] Real CUBRID tests are distinguished from offline tests. If no server, record **not run**, not passed.
- [ ] Release QA remains separate from onboarding. See [design sign-off](DESIGN_SIGNOFF.md), [engineering invariants](ENGINEERING_INVARIANTS.md), [release process](RELEASE_PROCESS.md).
