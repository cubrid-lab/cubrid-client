import type { ClientConfig, ClientOptions } from "../types/client.js";

export function normalizeConfig(options: ClientOptions): ClientConfig {
  return {
    host: options.host,
    port: options.port ?? 33000,
    database: options.database,
    user: options.user,
    password: options.password ?? "",
    connectionTimeout: options.connectionTimeout,
    maxConnectionRetryCount: options.maxConnectionRetryCount,
    ssl: options.ssl,
    logger: options.logger,
  };
}
