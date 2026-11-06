# Agent Playbook

## Source Of Truth
- `README.md` for public API examples and architecture summary.
- `PRD.md` for product goals, packaging, and compatibility intent.
- `CONTRIBUTING.md` for development workflow and quality checks.
- `package.json` for canonical scripts.

## Repository Map
- `src/` runtime implementation.
- `tests/` unit and integration tests.
- `docs/` supporting project documentation.

## Change Workflow
1. Check whether the change affects connection lifecycle, protocol handling, or typing only.
2. Keep examples in `README.md` current when public API behavior changes.
3. Preserve package exports and generated artifact expectations unless the change explicitly targets packaging.
4. Prefer targeted tests over broad rewrites.

## Validation
- `npm install`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run api:check` (after build; if the public API change is intentional run `npm run api:update` and commit `api/index.d.ts`)
- `npm run test:integration` only when integration paths are touched and CUBRID is available
