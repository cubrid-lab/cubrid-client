import { ConnectionError } from "../errors/connection-error.js";
import { QueryError } from "../errors/query-error.js";
import { ReadTimeoutError } from "../errors/read-timeout-error.js";
import { TransactionError } from "../errors/transaction-error.js";

type ErrorKind = "connection" | "query" | "transaction";

export function mapError(kind: ErrorKind, error: unknown, message: string): Error {
  // Kept as-is at every layer so callers can test for it without unwrapping.
  if (error instanceof ReadTimeoutError) {
    return error;
  }

  if (kind === "connection") {
    return new ConnectionError(message, { cause: toError(error) });
  }

  if (kind === "query") {
    return new QueryError(message, { cause: toError(error) });
  }

  return new TransactionError(message, { cause: toError(error) });
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
