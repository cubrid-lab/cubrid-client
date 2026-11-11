import type { CubridErrorDetails, CubridErrorOptions } from "./error-details.js";
import { definedErrorDetails } from "./error-details.js";

export interface TransactionError extends Readonly<CubridErrorDetails> {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface only declares the readonly error details the constructor assigns
export class TransactionError extends Error {
  override name = "TransactionError";

  /**
   * Set by `CubridClient.transaction()`, and by the `commit()` of a
   * `beginTransactionScope()` handle, when rolling back also failed. `cause`
   * still holds the failure that started it. The connection is closed
   * afterwards, so the server discards the uncommitted work either way.
   */
  declare rollbackError?: Error;

  /**
   * Set by `CubridClient.transaction()`, and when a `beginTransactionScope()`
   * handle failed to end, when closing its connection also failed.
   */
  declare closeError?: Error;

  constructor(message: string, options?: CubridErrorOptions) {
    super(message, options);
    Object.assign(this, definedErrorDetails(options));
  }
}
