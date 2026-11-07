import { definedErrorDetails } from "./error-details.js";
import type { CubridErrorDetails, CubridErrorOptions } from "./error-details.js";

export interface TransactionError extends Readonly<CubridErrorDetails> {}

export class TransactionError extends Error {
  override name = "TransactionError";

  constructor(message: string, options?: CubridErrorOptions) {
    super(message, options);
    Object.assign(this, definedErrorDetails(options));
  }
}
