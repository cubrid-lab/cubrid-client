import { NativeCubridAdapter } from "../adapters/native.js";
import { CubridClient } from "./client.js";
import { withLogging } from "../internals/log-connection.js";
import { normalizeConfig } from "../internals/normalize-config.js";
import type { ClientOptions } from "../types/client.js";

export function createClient(options: ClientOptions): CubridClient {
  const config = normalizeConfig(options);
  const baseFactory =
    options.connectionFactory ?? ((clientConfig) => new NativeCubridAdapter(clientConfig));
  const connectionFactory =
    config.logger === undefined ? baseFactory : withLogging(baseFactory, config.logger);

  return new CubridClient(config, connectionFactory);
}
