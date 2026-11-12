import { ConnectionError } from "../errors/connection-error.js";
import type { CubridErrorDetails, CubridErrorOptions } from "../errors/error-details.js";
import { definedErrorDetails } from "../errors/error-details.js";
import {
  CasReplyError,
  ConnectionLostError,
  ExecuteManyError,
  NotSentError,
  StreamBusyError,
} from "../errors/internal-errors.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
} from "../errors/query-error.js";
import { ReadTimeoutError } from "../errors/read-timeout-error.js";
import { TransactionError } from "../errors/transaction-error.js";
import { LobParamError } from "../types/lob.js";

export type ErrorKind = "connection" | "query" | "transaction";

export function mapError(kind: ErrorKind, error: unknown, message: string): Error {
  // Kept as-is at every layer so callers can test for it without unwrapping.
  if (isInstance(error, ReadTimeoutError)) {
    return error;
  }
  // A misused blob() or clob() is a TypeError in the caller's code, like a bad
  // option, so a statement rejects with it as it is. A transaction that fails
  // because of it still reports a TransactionError, with it as the cause.
  if (kind === "query" && isInstance(error, LobParamError)) {
    return error;
  }

  const cause = toError(error);
  const options: CubridErrorOptions = {
    cause,
    ...findErrorDetails(cause),
    ...ownOutcome(cause),
  };
  // A refused statement can only be fixed in the caller's code, so the reason stays
  // in the first line anyone reads rather than at the end of the cause chain.
  const text = options.kind === "stream-busy" ? cause.message : message;

  if (kind === "connection") {
    return new ConnectionError(text, options);
  }

  if (kind === "query") {
    return createQueryError(text, options);
  }

  return new TransactionError(text, options);
}

function createQueryError(message: string, options: CubridErrorOptions): QueryError {
  switch (options.kind) {
    case "unique-violation":
    case "not-null-violation":
    case "foreign-key-violation":
      return new ConstraintError(message, options);
    case "syntax":
      return new SqlSyntaxError(message, options);
    case "deadlock":
      return new DeadlockError(message, options);
    case "lock-timeout":
      return new LockTimeoutError(message, options);
    default:
      return new QueryError(message, options);
  }
}

/**
 * Each layer wraps the one below it, and a transaction callback may wrap an
 * error of its own, so the details come from the nearest error in the cause
 * chain that has any. Only this driver's classes count: a `code` on any other
 * error, such as Node's `ECONNRESET`, is not a CUBRID error code.
 */
function findErrorDetails(error: Error): CubridErrorDetails {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (isInstance(current, Error) && !seen.has(current)) {
    seen.add(current);

    if (
      current instanceof CasReplyError ||
      current instanceof ExecuteManyError ||
      current instanceof ConnectionLostError ||
      current instanceof StreamBusyError ||
      current instanceof QueryError ||
      current instanceof TransactionError ||
      current instanceof ConnectionError
    ) {
      // The outcome belongs to the operation that failed, so it is never taken
      // from a cause, which may be an earlier operation's error. See mapError().
      const { outcomeUnknown: _outcome, ...details } = definedErrorDetails(current);

      if (Object.keys(details).length > 0) {
        return details;
      }
    }

    current = current.cause;
  }

  return {};
}

/**
 * The outcome of `error` itself, when it is one of this driver's errors: a layer
 * that wraps the error of the same operation keeps it. Never read further down
 * the cause chain, where an earlier operation's flag could leak into this one.
 */
function ownOutcome(error: Error): CubridErrorDetails {
  if (
    (error instanceof QueryError ||
      error instanceof TransactionError ||
      error instanceof ConnectionError ||
      error instanceof NotSentError) &&
    error.outcomeUnknown !== undefined
  ) {
    return { outcomeUnknown: error.outcomeUnknown };
  }
  return {};
}

/**
 * Records on one of this driver's errors whether the operation that failed with
 * it may have taken effect unseen (#254). Anything else, such as a caller's
 * abort reason, is not ours to change and is returned as it is. A `true` already
 * there is kept: something below knew the outcome was unknown.
 */
export function withOutcome<T>(error: T, outcomeUnknown: boolean): T {
  if (
    isInstance(error, QueryError) ||
    isInstance(error, ConnectionError) ||
    isInstance(error, TransactionError)
  ) {
    const details = error as { outcomeUnknown?: boolean };
    details.outcomeUnknown = outcomeUnknown || details.outcomeUnknown === true;
  }
  return error;
}

/**
 * Records the outcome of a whole transaction on the error it failed with.
 * `changed` is whether a request sent on its connection since it began has an
 * unknown outcome, or undefined when the connection cannot tell; then only a
 * `true` found on the failure or the rollback failure, or down their causes, is
 * reported, because nothing proves the other requests were answered.
 */
export function withTransactionOutcome(
  failure: TransactionError,
  changed: boolean | undefined,
  rollbackFailure: Error | undefined,
): TransactionError {
  if (changed !== undefined) {
    return withOutcome(failure, changed);
  }
  const details = failure as { outcomeUnknown?: boolean };
  if (hasUnknownOutcome(failure) || hasUnknownOutcome(rollbackFailure)) {
    details.outcomeUnknown = true;
  } else {
    delete details.outcomeUnknown;
  }
  return failure;
}

function hasUnknownOutcome(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (isInstance(current, Error) && !seen.has(current)) {
    seen.add(current);
    if ((current as { outcomeUnknown?: unknown }).outcomeUnknown === true) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** `instanceof` throws for a revoked proxy, and callers may throw any value. */
function isInstance<T>(value: unknown, type: abstract new (...args: never[]) => T): value is T {
  try {
    return value instanceof type;
  } catch {
    return false;
  }
}

/**
 * Whether `error` is the reason of the caller's own abort, which every layer
 * passes on as it is, the way `fetch()` does.
 */
export function isAbortReason(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && error === signal.reason;
}

export function toError(error: unknown): Error {
  if (isInstance(error, Error)) {
    return error;
  }

  try {
    return new Error(String(error));
  } catch {
    // String() throws for values such as Object.create(null) or a revoked proxy,
    // and this runs while a transaction still has a connection to close.
    return new Error("Non-Error value that cannot be converted to a string.", { cause: error });
  }
}
