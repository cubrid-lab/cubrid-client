import { definedErrorDetails } from "./error-details.js";
import type { CubridErrorDetails, CubridErrorOptions } from "./error-details.js";

export interface TransactionError extends Readonly<CubridErrorDetails> {}

export class TransactionError extends Error {
  override name = "TransactionError";

  /**
   * Set by `CubridClient.transaction()` when rolling back also failed. `cause`
   * still holds the failure that started it. The connection is closed
   * afterwards, so the server discards the uncommitted work either way.
   */
  declare rollbackError?: Error;

  /** Set by `CubridClient.transaction()` when closing its connection also failed. */
  declare closeError?: Error;

  constructor(message: string, options?: CubridErrorOptions) {
    super(message, options);
    Object.assign(this, definedErrorDetails(options));
  }
}
