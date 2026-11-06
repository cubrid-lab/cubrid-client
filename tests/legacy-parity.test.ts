/**
 * Compare documented common CAS behavior of the native and original Node
 * driver against the same REAL broker. Public API shapes are intentionally
 * different; observe SQL values and side effects instead.
 *
 * node-cubrid pinned in .github/workflows/live-cubrid.yml. This test must
 * fail rather than skip if the reference package is not checked out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createClient } from "../src/client/create-client.js";

const oldEntry = process.env.NODE_CUBRID_ENTRY;
if (!oldEntry) {
  if (process.env.CUBRID_LIVE_REQUIRED === "1") {
    throw new Error("Legacy driver parity required but NODE_CUBRID_ENTRY is unset");
  }
  // Never register silently skipped assertions in the required live lane.
  throw new Error("Run legacy parity with the pinned legacy driver entrypoint");
}

const require = createRequire(import.meta.url);
const legacyDriver = require(resolve(oldEntry)) as {
  createConnection(config: Record<string, unknown>): {
    connect(): Promise<void>;
    queryAllAsObjects(sql: string): Promise<Array<Record<string, unknown>>>;
    execute(sql: string): Promise<void>;
    close(): Promise<void>;
  };
};

const base = {
  host: "127.0.0.1",
  port: Number(process.env.CUBRID_TEST_PORT ?? "33000"),
  database: "testdb",
  user: "dba",
  password: "",
  connectionTimeout: 5000,
};
const TABLE = "native_legacy_parity_probe";

function normal(rows: Array<Record<string, unknown>>) {
  // CUBRID aliases may be cased differently by each adapter.
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v])),
  );
}

test("original node-cubrid and native client agree on integer/text/NULL and DML effects", async () => {
  const native = createClient(base);
  const legacy = legacyDriver.createConnection({
    ...base, maxConnectionRetryCount: 1,
  });
  await legacy.connect();
  try {
    await native.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await native.query(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, name VARCHAR(60), optional_value VARCHAR(30))`);
    await native.query(`INSERT INTO ${TABLE} VALUES (1, 'from native', NULL)`);

    // Test the legacy WRITE path, but don't compare return API shapes.
    await legacy.execute(`INSERT INTO ${TABLE} VALUES (2, 'from legacy', 'present')`);

    const sql = `SELECT id, name, optional_value FROM ${TABLE} ORDER BY id`;
    const nativeRows = normal(await native.query(sql));
    const legacyRows = normal(await legacy.queryAllAsObjects(sql));
    const expected = [
      { id: 1, name: "from native", optional_value: null },
      { id: 2, name: "from legacy", optional_value: "present" },
    ];
    assert.deepEqual(nativeRows, expected);
    assert.deepEqual(legacyRows, expected);
    assert.deepEqual(nativeRows, legacyRows);

    // Both drivers must report SQL syntax errors rather than success/empty.
    const invalid = "SELECT * FROM definitely_missing_parity_table_8675309";
    await assert.rejects(native.query(invalid));
    await assert.rejects(legacy.queryAllAsObjects(invalid));

    // Both drivers must still function after a rejected statement.
    const countSql = `SELECT COUNT(*) AS total FROM ${TABLE}`;
    const nCount = normal(await native.query(countSql));
    const lCount = normal(await legacy.queryAllAsObjects(countSql));
    assert.equal(Number(nCount[0]?.total), 2);
    assert.equal(Number(lCount[0]?.total), 2);
  } finally {
    try {
      await native.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
      await native.close();
      await legacy.close();
    }
  }
});
