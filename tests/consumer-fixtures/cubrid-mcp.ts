// 1.x compile fixture for xhdndi81/cubrid-mcp (#300), the npm package `cubrid-mcp`.
//
// Pinned source: xhdndi81/cubrid-mcp at 876117d3ec9bb2edc3e581f9f1fd2aa9333e2e77
// (2026-08-24), the gitHead of npm cubrid-mcp@1.0.3. It depends on
// `cubrid-client ^1.1.0`; its lockfile installs 1.1.0. It is plain JavaScript and
// types against nothing, so this file states, in TypeScript, the calls it makes.
// docs/CONSUMER_INVENTORY.md lists them with file:line links. `npm run typecheck`
// (source types) and `npm run types:packed` (packed ESM and CJS declarations)
// compile this file; nothing here runs.

import { createClient } from "../../src/index.js";

// src/config.js:58-70: the object passed to createClient(), `connectionTimeout`
// included.
interface McpDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout: number;
}

// src/database.js:31: `clientFactory = createClient`, called with one argument.
type ClientFactory = (config: McpDatabaseConfig) => {
  query(sql: string, params: (string | number)[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
};
export const defaultFactory: ClientFactory = createClient;

// src/database.js:37-49 and 53-56: one client, query(sql, params), close().
export async function cubridMcpCalls(config: McpDatabaseConfig): Promise<number> {
  const client = createClient(config);
  // src/database.js:72 (ping), 82-91 (listTables), 175 (read-only query).
  await client.query("SELECT 1 AS ok", []);
  const rows = await client.query("SELECT class_name FROM db_class WHERE owner_name = ? LIMIT ?", [
    "PUBLIC",
    500,
  ]);
  await client.close();
  return rows.length;
}
