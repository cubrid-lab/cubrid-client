import type { ClientConfig, ClientOptions } from "../types/client.js";

/** Largest delay Node.js timers support. */
const MAX_READ_TIMEOUT = 2 ** 31 - 1;

export function normalizeConfig(options: ClientOptions): ClientConfig {
  const { readTimeout } = options;

  // A value that quietly disabled the timeout would leave queries able to hang.
  if (
    readTimeout !== undefined &&
    !(Number.isFinite(readTimeout) && readTimeout >= 0 && readTimeout <= MAX_READ_TIMEOUT)
  ) {
    throw new RangeError(
      `readTimeout must be between 0 and ${MAX_READ_TIMEOUT} milliseconds.`,
    );
  }

  const { maxConnectionRetryCount } = options;

  if (
    maxConnectionRetryCount !== undefined &&
    !(Number.isInteger(maxConnectionRetryCount) && maxConnectionRetryCount >= 0)
  ) {
    throw new RangeError("maxConnectionRetryCount must be a non-negative integer.");
  }

  return {
    host: options.host,
    port: options.port ?? 33000,
    database: options.database,
    user: options.user,
    password: options.password ?? "",
    connectionTimeout: options.connectionTimeout,
    ...(readTimeout !== undefined && { readTimeout }),
    maxConnectionRetryCount: options.maxConnectionRetryCount,
    ssl: options.ssl,
    logger: options.logger,
  };
}
