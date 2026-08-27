/**
 * Integration tests — real TCP against Docker CUBRID.
 *
 * Requires: docker container `cubrid-test` on localhost:33000 with database `testdb`.
 * Run:  docker compose up -d
 *       node --import tsx --test tests/integration.test.ts
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/client/create-client.js";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import { QueryError } from "../src/errors/query-error.js";

const TEST_CONFIG = {
  host: "127.0.0.1",
  port: 33000,
  database: "testdb",
  user: "dba",
  password: "",
};

// ---------------------------------------------------------------------------
// Check availability at top level before registering tests
// ---------------------------------------------------------------------------

async function isCubridAvailable(): Promise<boolean> {
  try {
    const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, connectionTimeout: 5000 });
    await adapter.connect();
    await adapter.close();
    return true;
  } catch (err) {
    console.log(`⚠ CUBRID not available — skipping integration tests: ${(err as Error).message}`);
    return false;
  }
}

const available = await isCubridAvailable();

// ---------------------------------------------------------------------------
// Connection tests (always run)
// ---------------------------------------------------------------------------

test("connect fails with wrong port", async () => {
  const adapter = new NativeCubridAdapter({
    ...TEST_CONFIG,
    port: 19999,
    connectionTimeout: 2000,
  });
  await assert.rejects(
    () => adapter.connect(),
    (err: Error) => {
      assert.ok(err instanceof ConnectionError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Tests that require a running CUBRID instance
// ---------------------------------------------------------------------------

describe("Integration: NativeCubridAdapter against Docker CUBRID", { skip: !available }, () => {
  test("connect to CUBRID", async () => {
    const adapter = new NativeCubridAdapter(TEST_CONFIG);
    await adapter.connect();
    await adapter.close();
  });

  // -------------------------------------------------------------------------
  // DDL & DML
  // -------------------------------------------------------------------------

  test("CREATE TABLE, INSERT, SELECT, UPDATE, DELETE, DROP", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      // Cleanup (ignore if not exists)
      try {
        await client.query("DROP TABLE IF EXISTS integration_test_native");
      } catch {
        // Table might not exist
      }

      // CREATE TABLE
      const createResult = await client.query(
        "CREATE TABLE integration_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(100), cnt INT)",
      );
      assert.deepEqual(createResult, []);

      // INSERT
      const insertResult = await client.query(
        "INSERT INTO integration_test_native (val, cnt) VALUES ('hello', 42)",
      );
      assert.deepEqual(insertResult, []);

      // INSERT with params
      const insertResult2 = await client.query(
        "INSERT INTO integration_test_native (val, cnt) VALUES (?, ?)",
        ["world", 99],
      );
      assert.deepEqual(insertResult2, []);

      // SELECT all
      const rows = await client.query("SELECT val, cnt FROM integration_test_native ORDER BY cnt");
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.val, "hello");
      assert.equal(rows[1]!.val, "world");

      // UPDATE
      const updateResult = await client.query(
        "UPDATE integration_test_native SET cnt = 100 WHERE val = 'hello'",
      );
      assert.deepEqual(updateResult, []);

      // Verify update
      const updated = await client.query(
        "SELECT cnt FROM integration_test_native WHERE val = 'hello'",
      );
      assert.equal(updated.length, 1);
      assert.equal(updated[0]!.cnt, 100);

      // DELETE
      const deleteResult = await client.query(
        "DELETE FROM integration_test_native WHERE val = 'world'",
      );
      assert.deepEqual(deleteResult, []);

      // Verify delete
      const remaining = await client.query("SELECT val FROM integration_test_native");
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]!.val, "hello");

      // DROP TABLE
      const dropResult = await client.query("DROP TABLE integration_test_native");
      assert.deepEqual(dropResult, []);
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // P0 regression: mode-aware string escaping (no silent corruption)
  // -------------------------------------------------------------------------

  test("P0: backslash/quote/newline string params round-trip without corruption", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS p0_escape_native");
      } catch {
        // Table might not exist
      }
      await client.query(
        "CREATE TABLE p0_escape_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(200))",
      );

      const samples = [
        "C:\\temp\\file.txt", // Windows path — backslashes must NOT be doubled
        "back\\slash",
        "O'Brien", // embedded single quote
        "line1\nline2", // newline
        "carriage\rreturn", // carriage return
        "mixed \\ ' end",
        "100%_plain",
      ];

      for (const s of samples) {
        await client.query("INSERT INTO p0_escape_native (val) VALUES (?)", [s]);
      }

      const rows = await client.query<{ val: string }>(
        "SELECT val FROM p0_escape_native ORDER BY id",
      );
      assert.equal(rows.length, samples.length);
      rows.forEach((row, i) => {
        assert.equal(row.val, samples[i], `round-trip mismatch for sample #${i}`);
      });

      await client.query("DROP TABLE p0_escape_native");
    } finally {
      await client.close();
    }
  });

  test("P0: NUL and Ctrl-Z string params are rejected, not silently mutated", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await assert.rejects(
        () => client.query("SELECT ? AS v", ["a\0b"]),
        (err: Error) => {
          assert.ok(err instanceof QueryError);
          assert.match((err.cause as Error).message, /null byte/);
          return true;
        },
      );
      await assert.rejects(
        () => client.query("SELECT ? AS v", ["a\x1ab"]),
        (err: Error) => {
          assert.ok(err instanceof QueryError);
          assert.match((err.cause as Error).message, /Ctrl-Z/);
          return true;
        },
      );
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Data types
  // -------------------------------------------------------------------------

  test("data type round-trips", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS dt_test_native");
      } catch {
        // ignore
      }

      await client.query(`
        CREATE TABLE dt_test_native (
          int_col INT,
          bigint_col BIGINT,
          float_col FLOAT,
          double_col DOUBLE,
          str_col VARCHAR(200),
          date_col DATE,
          datetime_col DATETIME
        )
      `);

      await client.query(
        "INSERT INTO dt_test_native (int_col, bigint_col, float_col, double_col, str_col, date_col, datetime_col) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          42,
          BigInt("9223372036854775807"),
          3.14,
          2.718281828,
          "test string",
          new Date("2025-01-15"),
          new Date("2025-06-15T10:30:00"),
        ],
      );

      const rows = await client.query("SELECT * FROM dt_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.int_col, 42);
      assert.equal(typeof rows[0]!.str_col, "string");
      assert.equal(rows[0]!.str_col, "test string");

      await client.query("DROP TABLE dt_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // NULL handling
  // -------------------------------------------------------------------------

  test("NULL values", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS null_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE null_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );
      await client.query("INSERT INTO null_test_native (val) VALUES (NULL)");
      await client.query("INSERT INTO null_test_native (val) VALUES ('not null')");

      const rows = await client.query(
        "SELECT val FROM null_test_native ORDER BY id",
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.val, null);
      assert.equal(rows[1]!.val, "not null");

      await client.query("DROP TABLE null_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  test("transaction commit", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      await client.beginTransaction();
      await client.query("INSERT INTO tx_test_native (val) VALUES ('committed')");
      await client.commit();

      const rows = await client.query("SELECT val FROM tx_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.val, "committed");

      await client.query("DROP TABLE tx_test_native");
    } finally {
      await client.close();
    }
  });

  test("transaction rollback", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_rb_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_rb_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      // Insert in auto-commit
      await client.query("INSERT INTO tx_rb_test_native (val) VALUES ('kept')");

      // Start transaction and rollback
      await client.beginTransaction();
      await client.query("INSERT INTO tx_rb_test_native (val) VALUES ('rolled back')");
      await client.rollback();

      const rows = await client.query("SELECT val FROM tx_rb_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.val, "kept");

      await client.query("DROP TABLE tx_rb_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Transaction callback (client.transaction())
  // -------------------------------------------------------------------------

  test("transaction callback with commit", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_cb_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_cb_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      const result = await client.transaction(async (tx) => {
        await tx.query("INSERT INTO tx_cb_test_native (val) VALUES ('via callback')");
        const rows = await tx.query<{ val: string }>(
          "SELECT val FROM tx_cb_test_native",
        );
        return rows[0]!.val;
      });

      assert.equal(result, "via callback");

      const rows = await client.query("SELECT val FROM tx_cb_test_native");
      assert.equal(rows.length, 1);

      await client.query("DROP TABLE tx_cb_test_native");
    } finally {
      await client.close();
    }
  });

  test("transaction callback with rollback on error", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS tx_err_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE tx_err_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))",
      );

      // Pre-insert a row
      await client.query("INSERT INTO tx_err_test_native (val) VALUES ('existing')");

      // Transaction that throws should rollback
      await assert.rejects(
        () =>
          client.transaction(async (tx) => {
            await tx.query(
              "INSERT INTO tx_err_test_native (val) VALUES ('should be rolled back')",
            );
            throw new Error("intentional error");
          }),
        (err: Error) => {
          assert.ok(err.message.includes("Transaction failed") || err.message.includes("intentional error"));
          assert.ok(err.cause instanceof Error);
          assert.equal((err.cause as Error).message, "intentional error");
          return true;
        },
      );

      // Only the pre-existing row should remain
      const rows = await client.query("SELECT val FROM tx_err_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.val, "existing");

      await client.query("DROP TABLE tx_err_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Parameterized queries (client-side interpolation)
  // -------------------------------------------------------------------------

  test("parameterized queries with various types", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS param_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE param_test_native (str_val VARCHAR(100), int_val INT, float_val DOUBLE)",
      );

      await client.query(
        "INSERT INTO param_test_native (str_val, int_val, float_val) VALUES (?, ?, ?)",
        ["hello 'world'", 42, 3.14],
      );

      const rows = await client.query(
        "SELECT str_val, int_val FROM param_test_native WHERE int_val = ?",
        [42],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.str_val, "hello 'world'");

      await client.query("DROP TABLE param_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Multiple result sets / large result set fetch
  // -------------------------------------------------------------------------

  test("large result set triggers multi-fetch", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      try {
        await client.query("DROP TABLE IF EXISTS fetch_test_native");
      } catch {
        // ignore
      }

      await client.query(
        "CREATE TABLE fetch_test_native (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(20))",
      );

      // Insert 150 rows to trigger multi-fetch (DEFAULT_FETCH_SIZE is 100)
      for (let i = 0; i < 150; i++) {
        await client.query(
          "INSERT INTO fetch_test_native (val) VALUES (?)",
          [`row_${String(i).padStart(3, "0")}`],
        );
      }

      const rows = await client.query(
        "SELECT id, val FROM fetch_test_native ORDER BY id",
      );
      assert.equal(rows.length, 150);
      assert.equal(rows[0]!.val, "row_000");
      assert.equal(rows[149]!.val, "row_149");

      await client.query("DROP TABLE fetch_test_native");
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // SQL syntax error
  // -------------------------------------------------------------------------

  test("SQL syntax error throws QueryError", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await assert.rejects(
        () => client.query("INVALID SQL STATEMENT"),
        (err: Error) => {
          assert.ok(err instanceof QueryError);
          return true;
        },
      );
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // System queries
  // -------------------------------------------------------------------------

  test("SELECT 1 + 1 works", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      const rows = await client.query("SELECT 1 + 1 AS result");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.result, 2);
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Close behavior
  // -------------------------------------------------------------------------

  test("close is safe to call multiple times", async () => {
    const client = createClient(TEST_CONFIG);
    await client.query("SELECT 1");
    await client.close();
    await client.close(); // Should not throw
  });
});
