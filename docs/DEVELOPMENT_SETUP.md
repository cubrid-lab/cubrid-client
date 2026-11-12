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
npm run lint:ci
npm test
npm run build
npm run api:check
```

Run `npm run test:coverage` for offline coverage. `npm run check` runs type checking and offline coverage tests. `npm run lint:ci` checks formatting, lint and import order with the pinned Biome dev dependency without changing files; `npm run lint:fix` applies fixes (see [Code Style](../CONTRIBUTING.md#code-style)). The package uses Node's built-in test runner with `tsx`, `tsup`, TypeScript and `c8`; do not replace this with Vitest.

## Node.js 18 consumer verification during 1.x

**Policy:** Node 18 (and Node 20 per the established API schedule) remain supported for **all 1.x versions**, regardless of the Node 22 `.nvmrc` used to run development tools. A higher Node minimum is only a future **2.0 major** proposal; it must not slip into a 1.x patch or minor. See [ADR 0006](adr/0006-node-18-support-through-1x.md).

For each 1.x release candidate, verify the **built/packed npm artifact** from a clean external Node 18 environment: ESM `import`, CommonJS `require`, relevant exported APIs, and supported dependency/runtime syntax. Run separate live CUBRID integration tests where applicable; Node 22 typecheck/build passing is **not** Node 18 consumer evidence. Record the Node version and test counts, and mark missing coverage as **unverified**.

## Real CUBRID integration (separate environment)

`tests/integration.test.ts` exists; `npm run test:integration` invokes it. Without a reachable broker the default lane **may self-skip** real DB cases. An ordinary successful exit therefore does **not** prove a live CUBRID integration run.

Set up a disposable CUBRID broker and database (the commands for `cubrid/cubrid:11.4`, the `testu8` database, the environment variables and cleanup are in [Reproduce the live lane locally](TESTING_MAP.md#reproduce-the-live-lane-locally)), verify its host, port, version and authentication, and then run:

```sh
CUBRID_LIVE_REQUIRED=1 npm run test:integration
```

The integration fixture documents `CUBRID_TEST_PORT` (default 33000) and other `CUBRID_TEST_*` overrides; inspect the fixture before adjusting credentials/endpoint. **Never** pass production credentials into a test suite or leak passwords in CI logs. A release candidate requires an explicit tested CUBRID matrix and a nonzero count of executed SQL assertions, beyond this workstation smoke.

### Official JDBC comparison

For a protocol or value-decoding change, `npm run test:jdbc-parity` runs the same
SQL corpus through the official CUBRID JDBC driver and this client against one
broker and fails on an unexpected difference. It needs Java 11 or later, the
pinned JAR from `npm run -s jdbc-parity:fetch`, `CUBRID_JDBC_JAR` and
`CUBRID_TEST_PORT`. See [the official JDBC comparison](LEGACY_PARITY.md#official-jdbc-comparison).

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
- [x] Biome is a pinned dev dependency with `lint`, `format:check` and `lint:ci` scripts, run by CI ([#217](https://github.com/cubrid-lab/cubrid-client/issues/217)).
- [ ] Real CUBRID tests are distinguished from offline tests. If no server, record **not run**, not passed.
- [ ] Release QA remains separate from onboarding. See [design sign-off](DESIGN_SIGNOFF.md), [engineering invariants](ENGINEERING_INVARIANTS.md), [release process](RELEASE_PROCESS.md).
