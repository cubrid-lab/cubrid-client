import { definedErrorDetails } from "./error-details.js";
import type { CubridErrorDetails, CubridErrorOptions } from "./error-details.js";

export interface ConnectionError extends Readonly<CubridErrorDetails> {}

export class ConnectionError extends Error {
  override name = "ConnectionError";

  constructor(message: string, options?: CubridErrorOptions) {
    super(message, options);
    Object.assign(this, definedErrorDetails(options));
  }
}
