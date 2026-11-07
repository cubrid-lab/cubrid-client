import { ConnectionError } from "../errors/connection-error.js";
import { definedErrorDetails } from "../errors/error-details.js";
import type { CubridErrorDetails, CubridErrorOptions } from "../errors/error-details.js";
import { CasReplyError, ConnectionLostError } from "../errors/internal-errors.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
} from "../errors/query-error.js";
import { ReadTimeoutError } from "../errors/read-timeout-error.js";
import { TransactionError } from "../errors/transaction-error.js";

type ErrorKind = "connection" | "query" | "transaction";

export function mapError(kind: ErrorKind, error: unknown, message: string): Error {
  // Kept as-is at every layer so callers can test for it without unwrapping.
  if (error instanceof ReadTimeoutError) {
    return error;
  }

  const cause = toError(error);
  const options: CubridErrorOptions = { cause, ...findErrorDetails(cause) };

  if (kind === "connection") {
    return new ConnectionError(message, options);
  }

  if (kind === "query") {
    return createQueryError(message, options);
  }

  return new TransactionError(message, options);
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

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);

    if (
      current instanceof CasReplyError ||
      current instanceof ConnectionLostError ||
      current instanceof QueryError ||
      current instanceof TransactionError ||
      current instanceof ConnectionError
    ) {
      const details = definedErrorDetails(current);

      if (Object.keys(details).length > 0) {
        return details;
      }
    }

    current = current.cause;
  }

  return {};
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
