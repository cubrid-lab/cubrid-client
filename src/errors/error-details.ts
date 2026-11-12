/**
 * What a failure was, without parsing its message. Each server-reported value
 * was observed from a live broker; a code that was not observed has no kind.
 *
 * - `unique-violation`, `not-null-violation`, `foreign-key-violation`: a
 *   constraint rejected the statement.
 * - `syntax`: the server could not parse the statement. CUBRID also reports an
 *   unknown table this way.
 * - `semantic`: the statement parsed but cannot run, such as an unknown column,
 *   a missing privilege or a constant division by zero.
 * - `deadlock`: the server picked this transaction as the deadlock victim.
 * - `lock-timeout`: a server-side lock wait expired. This is not `read-timeout`.
 * - `interrupted`: the server stopped the statement, for example `cubrid killtran`.
 * - `authentication`: the broker refused the user or password.
 * - `connection-lost`: the connection went away, or the server process died and
 *   took the transaction with it. The outcome of a request in flight is unknown.
 * - `read-timeout`: the client gave up waiting, see `ReadTimeoutError`.
 * - `stream-busy`: the client refused a statement that waited behind a `stream()`
 *   whose consumer stopped asking for rows. Nothing was sent.
 * - `pool-timeout`: a pool had no connection to lease within `acquireTimeoutMs`.
 *   Nothing was sent.
 * - `pool-full`: a pool already had `maxWaitingClients` callers waiting for a
 *   connection. Nothing was sent.
 * - `pool-closed`: the pool was closed before a connection could be leased.
 *   Nothing was sent.
 */
export type CubridErrorKind =
  | "unique-violation"
  | "not-null-violation"
  | "foreign-key-violation"
  | "syntax"
  | "semantic"
  | "deadlock"
  | "lock-timeout"
  | "interrupted"
  | "authentication"
  | "connection-lost"
  | "read-timeout"
  | "stream-busy"
  | "pool-timeout"
  | "pool-full"
  | "pool-closed";

/** One parameter set of an `executeMany()` call that the server reported as failed. */
export interface ExecuteManySetFailure {
  /** Position of the set in `paramSets`. */
  index: number;
  /** The server's error code for this set. */
  code: number;
  /** Who assigned `code`; see {@link CubridErrorDetails.origin}. */
  origin?: "server" | "cas";
  /** Classification of `code`; see {@link CubridErrorKind}. */
  kind?: CubridErrorKind;
  /** The server's message for this set. */
  message: string;
}

/**
 * What became of each parameter set when `executeMany()` rejected because the
 * server reported one or more sets as failed.
 */
export interface ExecuteManyFailure {
  /**
   * One entry per set in `paramSets`, in order: the rows the set changed when it
   * ran without error, and `null` when it failed or never ran. A count is what
   * the server reported before the outcome below, never a committed change.
   */
  results: ReadonlyArray<number | null>;
  /** Every failed set, in order. The error's own `code` and `kind` are the first one's. */
  failures: readonly ExecuteManySetFailure[];
  /** Number of sets the server ran, with or without error; the rest never ran. */
  executed: number;
  /**
   * `true` in autocommit mode: the client rolled the whole batch back, so no set
   * was committed. `false` inside a transaction: the sets that succeeded are still
   * part of it, uncommitted, and the caller decides whether to roll it back.
   */
  rolledBack: boolean;
}

export interface CubridErrorDetails {
  /** Numeric error code of the CAS error reply. Absent for client-side failures. */
  code?: number;
  /**
   * Who assigned `code`: `server` for a database error code, `cas` for one from
   * the CAS process. The two number ranges overlap, so compare a code only
   * together with its origin: `-1012` is a different error in each.
   */
  origin?: "server" | "cas";
  /**
   * Five-character SQLSTATE. CAS error replies do not carry one and CUBRID
   * documents no mapping from its codes, so this driver never sets it. It is
   * kept for a custom connection that has a real value to report.
   */
  sqlState?: string;
  /** Classification of a known failure. Absent when the failure is not classified. */
  kind?: CubridErrorKind;
  /**
   * Per-set outcome of an `executeMany()` that failed because the server reported
   * a parameter set as failed. Absent for every other failure.
   */
  batch?: ExecuteManyFailure;
}

export interface CubridErrorOptions extends ErrorOptions, CubridErrorDetails {}

/** The details that have a value, so that ordinary errors gain no empty properties. */
export function definedErrorDetails({
  code,
  origin,
  sqlState,
  kind,
  batch,
}: CubridErrorDetails = {}): CubridErrorDetails {
  return {
    ...(code !== undefined && { code }),
    ...(origin !== undefined && { origin }),
    ...(sqlState !== undefined && { sqlState }),
    ...(kind !== undefined && { kind }),
    ...(batch !== undefined && { batch }),
  };
}
