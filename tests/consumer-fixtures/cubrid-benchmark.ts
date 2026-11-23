// 1.x compile fixture for cubrid-lab/cubrid-benchmark, typescript/ (#300).
//
// Pinned source: cubrid-lab/cubrid-benchmark `main` at
// fcecf40566d52b1eed47af8101a543e7bf372112 (2026-11-22). typescript/package.json
// accepts `cubrid-client ^1.1.0`; its lockfile installs 1.1.0. It is a private
// package (benchmarks), not published to npm. docs/CONSUMER_INVENTORY.md lists
// every call with a file:line link. `npm run typecheck` (source types) and
// `npm run types:packed` (packed ESM and CJS declarations) compile this file;
// nothing here runs.

import { type CubridClient, createClient } from "../../src/index.js";

// typescript/helpers.ts:7 and typescript/benchflow_worker.ts:18 declare their own
// parameter type and pass a mutable array of it.
type QueryParam = string | number | boolean | bigint | Date | Buffer | null;
type QueryResultRow = Record<string, unknown>;

// typescript/helpers.ts:10: the connection type is the 1.x class.
type CubridConnection = CubridClient;

// typescript/helpers.ts:21-29.
export async function getCubridConnection(): Promise<CubridConnection> {
  return createClient({
    host: "localhost",
    port: 33000,
    database: "benchdb",
    user: "dba",
    password: "",
  });
}

// typescript/helpers.ts:41-47.
export async function cubridQuery(
  conn: CubridConnection,
  sql: string,
  params: QueryParam[] = [],
): Promise<QueryResultRow[]> {
  return conn.query(sql, params);
}

// typescript/helpers.ts:49-51.
export async function cubridClose(conn: CubridConnection): Promise<void> {
  await conn.close();
}

// typescript/benchflow_worker.ts:121-141, connection options from a parsed DSN.
export async function benchflowWorker(parsed: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): Promise<string> {
  const client: CubridClient = createClient({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
  });
  const params: unknown[] | undefined = [1];
  await client.query("SELECT ?", (params ?? []) as QueryParam[]);
  await client.query("SELECT 1");
  const rows = await client.query("SELECT version()");
  await client.close();
  return (rows?.[0]?.["version()"] as string) ?? "unknown";
}
