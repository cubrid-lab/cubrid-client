import type {
  BatchExecutable,
  ClientOptions,
  Executable,
  PreparedQueryable,
  Queryable,
  ResultQueryable,
  Streamable,
} from "./client.js";

/**
 * Options of `createPool()`: every {@link ClientOptions} setting, applied to
 * each connection the pool opens, and the pool's own limits. An invalid value
 * throws a `RangeError` from `createPool()`.
 */
export interface PoolOptions extends ClientOptions {
  /**
   * Most connections open at once, counting those still being opened. An
   * integer of at least 1. Default: 10.
   */
  max?: number;
  /**
   * Connections the pool keeps open even when idle, opened in the background
   * after `createPool()` and after a connection is closed. A failure to open one
   * is only logged. An integer from 0 to `max`. Default: 0.
   */
  min?: number;
  /**
   * Longest a caller waits for a connection, in milliseconds, before it rejects
   * with a `ConnectionError` of kind `pool-timeout`. The wait does not count
   * towards `readTimeout`. An integer from 1 to 2147483647. Default: 30000.
   */
  acquireTimeoutMs?: number;
  /**
   * Most callers waiting for a connection at once. One more rejects at once with
   * kind `pool-full`. A non-negative integer or `Infinity`. Default: `Infinity`.
   */
  maxWaitingClients?: number;
  /**
   * Milliseconds a connection may stay idle before the pool closes it, never
   * going below `min`. `0` keeps idle connections open. An integer from 0 to
   * 2147483647. Default: 30000.
   */
  idleTimeoutMs?: number;
  /**
   * Age, in milliseconds, after which a connection is closed instead of being
   * reused. Checked when a lease ends and while the connection is idle, never
   * during a lease; each connection's limit is up to 10% shorter, so connections
   * opened together do not all close together. An integer from 1 to 2147483647.
   * Default: no limit.
   */
  maxLifetimeMs?: number;
  /**
   * A connection idle for at least this many milliseconds is checked with
   * `ping()` before it is leased; one that fails is closed and the caller gets
   * another. `0` checks before every lease. An integer from 0 to 2147483647.
   * Default: no check.
   */
  validateAfterIdleMs?: number;
}

/** A snapshot of the pool, from `CubridPool.stats()`. */
export interface PoolStats {
  /** Connections open or being opened: `idle + active + pending`. */
  total: number;
  /** Open connections nobody holds. */
  idle: number;
  /** Connections held by a statement, stream, transaction or `connection()` callback. */
  active: number;
  /** Connections being opened. */
  pending: number;
  /** Callers waiting for a connection. */
  waiting: number;
}

/**
 * The connection `CubridPool.connection()` lends its callback. It runs in
 * autocommit mode, so it has no transaction methods: use `pool.transaction()`.
 * It is valid only while the callback runs; afterwards every call rejects
 * without reaching the server.
 *
 * This describes a value the pool passes in. Members may be added to it in a
 * minor release, so do not implement it in your own classes.
 */
export interface PoolConnection
  extends Queryable,
    ResultQueryable,
    Executable,
    PreparedQueryable,
    BatchExecutable,
    Streamable {}

/** Options of `CubridPool.connection()`. */
export interface PoolConnectionOptions {
  /** Cancels the wait for a connection. It does not apply to the callback's statements. */
  signal?: AbortSignal;
}
