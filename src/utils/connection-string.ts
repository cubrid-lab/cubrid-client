export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

const DEFAULT_PORT = 33000;

export function parseConnectionString(url: string): ConnectionConfig {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid CUBRID connection URL.");
  }

  if (parsed.protocol !== "cubrid:") {
    throw new Error("Connection URL must use cubrid:// protocol.");
  }

  if (!parsed.hostname) {
    throw new Error("Connection URL must include a host.");
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (!database) {
    throw new Error("Connection URL must include a database name.");
  }

  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Connection URL contains an invalid port.");
  }

  return {
    host: parsed.hostname,
    port,
    database,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}
