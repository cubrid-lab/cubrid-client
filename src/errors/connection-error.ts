import type { CubridErrorDetails, CubridErrorOptions } from "./error-details.js";
import { definedErrorDetails } from "./error-details.js";

export interface ConnectionError extends Readonly<CubridErrorDetails> {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface only declares the readonly error details the constructor assigns
export class ConnectionError extends Error {
  override name = "ConnectionError";

  constructor(message: string, options?: CubridErrorOptions) {
    super(message, options);
    Object.assign(this, definedErrorDetails(options));
  }
}
