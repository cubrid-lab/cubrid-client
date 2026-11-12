# Architecture

`cubrid-client` implements the CUBRID CAS binary protocol directly over native TCP sockets — a pure TypeScript CAS adapter with zero external driver dependencies.

## Layers

1. `client/create-client.ts`
   Builds the public client from normalized config.
2. `client/client.ts`
   Owns shared connection lifecycle and public query API.
3. `client/transaction.ts`
   Owns transaction-scoped queries and the single commit or rollback of a callback transaction.
4. `adapters/native.ts`
   Default `NativeCubridAdapter` — implements CAS binary protocol directly over TCP.
5. `protocol/connection.ts`
   `CASConnection`: the socket lifecycle, the broker handshake, TLS, framed send and receive, and the request queue.
6. `protocol/frame-reader.ts`
   One `FrameReader` per socket: a single data listener that queues the socket's bytes and hands them to one read at a time, in order. A replaced socket's bytes never reach its successor's reads.
7. `internals/*`
   Normalizes config and translates errors.

## Current Tradeoffs

- a single shared connection is reused for non-transactional client queries
- each transaction allocates its own isolated connection
- errors are translated into package-owned classes so callers can catch stable types

## Planned Evolution

- reusable prepared statements (each `queryPrepared()` call prepares its own handle today)
- pooling
- retry policies
- instrumentation hooks
