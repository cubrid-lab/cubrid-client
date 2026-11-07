# Architecture

`cubrid-client` implements the CUBRID CAS binary protocol directly over native TCP sockets — a pure TypeScript CAS adapter with zero external driver dependencies.

## Layers

1. `client/create-client.ts`
   Builds the public client from normalized config.
2. `client/client.ts`
   Owns shared connection lifecycle and public query API.
3. `client/transaction.ts`
   Owns transaction-scoped query and commit/rollback flow.
4. `adapters/native.ts`
   Default `NativeCubridAdapter` — implements CAS binary protocol directly over TCP.
5. `internals/*`
   Normalizes config and translates errors.

## Current Tradeoffs

- a single shared connection is reused for non-transactional client queries
- each transaction allocates its own isolated connection
- errors are translated into package-owned classes so callers can catch stable types

## Planned Evolution

- prepared statements
- pooling
- retry policies
- instrumentation hooks
