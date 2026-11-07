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
  | "read-timeout";

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
}

export interface CubridErrorOptions extends ErrorOptions, CubridErrorDetails {}

/** The details that have a value, so that ordinary errors gain no empty properties. */
export function definedErrorDetails({
  code,
  origin,
  sqlState,
  kind,
}: CubridErrorDetails = {}): CubridErrorDetails {
  return {
    ...(code !== undefined && { code }),
    ...(origin !== undefined && { origin }),
    ...(sqlState !== undefined && { sqlState }),
    ...(kind !== undefined && { kind }),
  };
}
