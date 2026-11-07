import { definedErrorDetails } from "./error-details.js";
import type { CubridErrorDetails, CubridErrorOptions } from "./error-details.js";

export interface QueryError extends Readonly<CubridErrorDetails> {}

export class QueryError extends Error {
  override name = "QueryError";

  constructor(message: string, options?: CubridErrorOptions) {
    super(message, options);
    Object.assign(this, definedErrorDetails(options));
  }
}

/** A unique, NOT NULL or foreign key constraint rejected the statement; see `kind`. */
export class ConstraintError extends QueryError {
  override name = "ConstraintError";
}

/** The server could not parse the statement, or it names an unknown table. */
export class SqlSyntaxError extends QueryError {
  override name = "SqlSyntaxError";
}

/**
 * The server chose this transaction as a deadlock victim. With code `-72` it
 * already rolled the whole transaction back; with `-967` or `-968`, reported
 * under a finite lock timeout, only the statement failed and the transaction
 * stays open. Either way, roll back and retry the transaction from its start.
 */
export class DeadlockError extends QueryError {
  override name = "DeadlockError";
}

/**
 * A server-side lock wait expired. Only the statement failed, and the
 * transaction stays open. This is not the client-side `ReadTimeoutError`.
 */
export class LockTimeoutError extends QueryError {
  override name = "LockTimeoutError";
}
