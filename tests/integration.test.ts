/**
 * Integration tests — real TCP against a live CUBRID server.
 *
 * Requires: a CUBRID broker on 127.0.0.1:33000 with database `testdb`
 * (user `dba`, empty password). Database-dependent cases self-skip when no
 * server is reachable. Set CUBRID_TEST_PORT to use another broker port, and
 * CUBRID_CONCURRENCY_ROUNDS to repeat the overlapping-query tests more often.
 *
 * Run:  npm run test:integration
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/client/create-client.js";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { ConnectionError } from "../src/errors/connection-error.js";
import {
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  QueryError,
  SqlSyntaxError,
} from "../src/errors/query-error.js";
import { ReadTimeoutError } from "../src/errors/read-timeout-error.js";
import { TransactionError } from "../src/errors/transaction-error.js";
import { CASFunctionCode } from "../src/protocol/constants.js";
import { CASConnection } from "../src/protocol/connection.js";
import {
  parseFetch,
  parsePrepareAndExecute,
  writeFetch,
  writePrepareAndExecute,
  type FetchResult,
  type PrepareAndExecuteResult,
} from "../src/protocol/protocol.js";

const TEST_CONFIG = {
  host: "127.0.0.1",
  port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
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
    console.log(`CUBRID not available; offline integration tests are skipped: ${(err as Error).message}`);
    return false;
  }
}

const available = await isCubridAvailable();
if (!available && process.env.CUBRID_LIVE_REQUIRED === "1") {
  // Fail before registering the self-skipping suite. A release/CI job
  // cannot claim live verification when a broker was unreachable.
  throw new Error("Live CUBRID integration was required but the broker was unreachable");
}

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
          assert.match(((err.cause as Error).cause as Error).message, /null byte/);
          return true;
        },
      );
      await assert.rejects(
        () => client.query("SELECT ? AS v", ["a\x1ab"]),
        (err: Error) => {
          assert.ok(err instanceof QueryError);
          assert.match(((err.cause as Error).cause as Error).message, /Ctrl-Z/);
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
          new Date("2025-06-15T10:30:00Z"),
        ],
      );

      const rows = await client.query("SELECT * FROM dt_test_native");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.int_col, 42);
      assert.equal(typeof rows[0]!.str_col, "string");
      assert.equal(rows[0]!.str_col, "test string");
      assert.equal(rows[0]!.bigint_col, 9223372036854775807n);
      assert.equal(typeof rows[0]!.bigint_col, "bigint");
      // FLOAT is a 32-bit value; DOUBLE retains approximately 15 decimal digits.
      assert.equal(typeof rows[0]!.float_col, "number");
      assert.ok(Math.abs((rows[0]!.float_col as number) - 3.14) < 1e-5);
      assert.equal(typeof rows[0]!.double_col, "number");
      assert.ok(Math.abs((rows[0]!.double_col as number) - 2.718281828) < 1e-9);
      // CUBRID DATE and DATETIME have no stored timezone. Check each returned
      // SQL wall-clock component rather than claiming stable UTC instants.
      const sqlDate = rows[0]!.date_col;
      const sqlDatetime = rows[0]!.datetime_col;
      assert.ok(sqlDate instanceof Date);
      assert.ok(sqlDatetime instanceof Date);
      assert.equal(sqlDate.getFullYear(), 2025);
      assert.equal(sqlDate.getMonth(), 0);
      assert.equal(sqlDate.getDate(), 15);
      assert.equal(sqlDatetime.getFullYear(), 2025);
      assert.equal(sqlDatetime.getMonth(), 5);
      assert.equal(sqlDatetime.getDate(), 15);
      // The inserted JS Date is formatted using UTC components by this driver.
      const expectedUtc = new Date("2025-06-15T10:30:00Z");
      assert.equal(sqlDatetime.getHours(), expectedUtc.getUTCHours());
      assert.equal(sqlDatetime.getMinutes(), expectedUtc.getUTCMinutes());

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

  test("a ping inside a transaction leaves its row to rollback()", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await client.query("DROP TABLE IF EXISTS tx_ping_test_native");
      await client.query("CREATE TABLE tx_ping_test_native (val VARCHAR(50))");

      await client.beginTransaction();
      await client.query("INSERT INTO tx_ping_test_native (val) VALUES ('rolled back')");
      assert.match(await client.ping(), /^\d+\.\d+/);
      await client.rollback();

      assert.deepEqual(await client.query("SELECT val FROM tx_ping_test_native"), []);

      await client.query("DROP TABLE tx_ping_test_native");
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
  // Collections (#82)
  // -------------------------------------------------------------------------

  test("db.query() exposes an unsupported value by its name further down the cause chain", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      await assert.rejects(
        client.query("SELECT TIMESTAMPTZ'2020-01-02 03:04:05 +09:00' AS zoned"),
        (error: Error) => {
          const failure = ((error.cause as Error).cause as Error);
          assert.equal(error.name, "QueryError");
          assert.equal(failure.name, "UnsupportedValueError");
          assert.match(failure.message, /column "zoned" \(wire type 29, /);
          return true;
        },
      );
      assert.deepEqual(await client.query("SELECT 1 AS one"), [{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  describe("collection columns", () => {
    const TABLE = "integration_collections";
    const collectionClient = () => createClient(TEST_CONFIG);

    test("SET, MULTISET and SEQUENCE keep their documented semantics and the next column", async () => {
      const client = collectionClient();
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, s SET OF INT, m MULTISET OF VARCHAR(20), ` +
            "q SEQUENCE OF BIGINT, after_collections VARCHAR(10))",
        );
        await client.query(
          `INSERT INTO ${TABLE} VALUES (1, {3,1,2,2}, {'b','a','b'}, {30000000000,1,1}, 'one')`,
        );
        await client.query(`INSERT INTO ${TABLE} VALUES (2, {}, {}, {}, 'two')`);
        await client.query(`INSERT INTO ${TABLE} VALUES (3, NULL, NULL, NULL, 'three')`);
        await client.query(
          `INSERT INTO ${TABLE} VALUES (4, {NULL}, {NULL,'x'}, {NULL,5,NULL}, 'four')`,
        );

        const rows = await client.query(`SELECT * FROM ${TABLE} ORDER BY id`);
        assert.deepEqual(rows, [
          {
            id: 1,
            s: [1, 2, 3],
            m: ["a", "b", "b"],
            q: [30000000000n, 1n, 1n],
            after_collections: "one",
          },
          { id: 2, s: [], m: [], q: [], after_collections: "two" },
          { id: 3, s: null, m: null, q: null, after_collections: "three" },
          { id: 4, s: [null], m: ["x", null], q: [null, 5n, null], after_collections: "four" },
        ]);
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    test("collection rows decode across more than one FETCH", async () => {
      const client = collectionClient();
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, q SEQUENCE OF INT, label VARCHAR(10))`,
        );
        // 150 rows pass the 100-row fetch size, as in the multi-fetch test above.
        for (let i = 0; i < 150; i++) {
          await client.query(`INSERT INTO ${TABLE} VALUES (${i}, {${i},${i}}, 'row${i}')`);
        }

        const rows = await client.query(`SELECT id, q, label FROM ${TABLE} ORDER BY id`);
        assert.equal(rows.length, 150);
        assert.deepEqual(rows[0], { id: 0, q: [0, 0], label: "row0" });
        assert.deepEqual(rows[149], { id: 149, q: [149, 149], label: "row149" });
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    test("each supported element type decodes like its scalar column", async () => {
      const client = collectionClient();
      const cases: Array<[string, unknown[]]> = [
        ["CAST({1} AS SEQUENCE OF SMALLINT)", [1]],
        ["CAST({1,2} AS SEQUENCE OF INT)", [1, 2]],
        ["CAST({1.5} AS SEQUENCE OF FLOAT)", [1.5]],
        ["CAST({1.5,2.5} AS SEQUENCE OF DOUBLE)", [1.5, 2.5]],
        ["CAST({1} AS SEQUENCE OF MONETARY)", [1]],
        ["CAST({12.50} AS SEQUENCE OF NUMERIC(6,2))", ["12.50"]],
        ["CAST({'ab'} AS SEQUENCE OF CHAR(4))", ["ab  "]],
        ["CAST({'\ud55c\uae00',''} AS SEQUENCE OF VARCHAR(10))", ["\ud55c\uae00", ""]],
        ["CAST({1,2} AS SET OF ENUM('a','b'))", ["a", "b"]],
        ["CAST({X'0f'} AS SEQUENCE OF BIT VARYING(8))", [Buffer.from([0x0f])]],
        ["CAST({X''} AS SEQUENCE OF BIT VARYING(8))", [Buffer.alloc(0)]],
        ["CAST({DATE'2024-01-02'} AS SEQUENCE OF DATE)", [new Date(2024, 0, 2)]],
        ["CAST({TIME'03:04:05'} AS SEQUENCE OF TIME)", [new Date(1970, 0, 1, 3, 4, 5)]],
        [
          "CAST({TIMESTAMP'2024-01-02 03:04:05'} AS SEQUENCE OF TIMESTAMP)",
          [new Date(2024, 0, 2, 3, 4, 5)],
        ],
        [
          "CAST({DATETIME'2024-01-02 03:04:05.678'} AS SEQUENCE OF DATETIME)",
          [new Date(2024, 0, 2, 3, 4, 5, 678)],
        ],
      ];
      try {
        for (const [expression, expected] of cases) {
          const rows = await client.query(`SELECT ${expression} AS c, 'after' AS t`);
          assert.deepEqual(rows, [{ c: expected, t: "after" }], expression);
        }
      } finally {
        await client.close();
      }
    });

    test("nested collections decode recursively", async () => {
      const client = collectionClient();
      try {
        assert.deepEqual(await client.query("SELECT {{1,2},{'a'}} AS c, 'after' AS t"), [
          { c: [[1, 2], ["a"]], t: "after" },
        ]);
        assert.deepEqual(await client.query("SELECT {{},{1}} AS c, {NULL,{1}} AS d, 'after' AS t"), [
          { c: [[], [1]], d: [null, [1]], t: "after" },
        ]);
        assert.deepEqual(await client.query("SELECT {{{1}}} AS c, 'after' AS t"), [
          { c: [[[1]]], t: "after" },
        ]);
      } finally {
        await client.close();
      }
    });

    test("the server sends a mixed-type collection as NULL; a cast reads it", async () => {
      const client = collectionClient();
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, u SET)`);
        await client.query(`INSERT INTO ${TABLE} VALUES (1, {1,'a'})`);
        await client.query(`INSERT INTO ${TABLE} VALUES (2, {2,3})`);

        // The bytes of row 1 equal a genuine NULL, so the driver cannot tell them apart.
        assert.deepEqual(await client.query(`SELECT id, u FROM ${TABLE} ORDER BY id`), [
          { id: 1, u: null },
          { id: 2, u: [2, 3] },
        ]);
        assert.deepEqual(
          await client.query(`SELECT CAST(u AS SET OF VARCHAR(20)) AS u FROM ${TABLE} ORDER BY id`),
          [{ u: ["1", "a"] }, { u: ["2", "3"] }],
        );
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    test("an unsupported element rejects and leaves the session usable", async () => {
      const client = collectionClient();
      try {
        for (const expression of [
          "CAST({DATETIMETZ'2024-01-02 03:04:05.678 +09:00'} AS SEQUENCE OF DATETIMETZ)",
          "CAST({X'0f'} AS SEQUENCE OF BLOB)",
        ]) {
          await assert.rejects(
            () => client.query(`SELECT ${expression} AS c, 'after' AS t`),
            (error: Error) => {
              assert.ok(error instanceof QueryError);
              return true;
            },
          );
        }
        assert.deepEqual(await client.query("SELECT {1} AS c, 'after' AS t"), [
          { c: [1], t: "after" },
        ]);
      } finally {
        await client.close();
      }
    });
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
  // Query handle release (#108)
  // -------------------------------------------------------------------------

  describe("query handle release", () => {
    const TABLE = "integration_test_handles";
    const SELECT_ALL = `SELECT id, val FROM ${TABLE} ORDER BY id`;
    // Only the last row has a TIMESTAMPTZ value, which has no decoder. Ascending
    // order meets it in a FETCH reply, descending order in the first reply.
    const UNSUPPORTED_IN_FETCH = `SELECT id, zoned FROM ${TABLE} ORDER BY id`;
    const UNSUPPORTED_IN_FIRST_REPLY = `SELECT id, zoned FROM ${TABLE} ORDER BY id DESC`;
    const CAS_ER_SRV_HANDLE = -1006;

    /** Enough rows that the first response cannot carry them all. */
    const ROW_COUNT = 1000;

    interface Trace {
      adapter: NativeCubridAdapter;
      cas: CASConnection;
      sent: number[];
      handle: () => number;
    }

    /** Observe every request and let `tamper` replace the response decoded by the adapter. */
    async function open(tamper: (functionCode: number, response: Buffer) => Buffer): Promise<Trace> {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = (adapter as unknown as { cas: CASConnection }).cas;
      const sent: number[] = [];
      let handle = -1;

      const sendAndRecv = cas.sendAndRecv.bind(cas);
      cas.sendAndRecv = async (header, payload) => {
        sent.push(payload[0]!);
        const response = await sendAndRecv(header, payload);
        if (payload[0] === CASFunctionCode.PREPARE_AND_EXECUTE) {
          handle = response.readInt32BE(0);
        }
        return tamper(payload[0]!, response);
      };

      const sendAndRecvOnSession = cas.sendAndRecvOnSession.bind(cas);
      cas.sendAndRecvOnSession = async (generation, header, payload) => {
        const response = await sendAndRecvOnSession(generation, header, payload);
        if (response) {
          sent.push(payload[0]!);
        }
        return response;
      };

      return { adapter, cas, sent, handle: () => handle };
    }

    /** The server's verdict on `handle`, without the adapter or a reconnect in the way. */
    async function fetchCode(trace: Trace): Promise<number> {
      const { cas } = trace;
      const { header, payload } = writeFetch(trace.handle(), 0, 1, cas.casInfo);
      const response = await cas.sendAndRecvOnSession(cas.connectionGeneration, header, payload);
      assert.ok(response, "the session is still open");
      return response.readInt32BE(0) < 0 ? response.readInt32BE(4) : 0;
    }

    const count = (trace: Trace, functionCode: number): number =>
      trace.sent.filter((code) => code === functionCode).length;

    const truncateFetch = (functionCode: number, response: Buffer): Buffer =>
      functionCode === CASFunctionCode.FETCH ? response.subarray(0, 10) : response;

    const truncateExecute = (functionCode: number, response: Buffer): Buffer =>
      functionCode === CASFunctionCode.PREPARE_AND_EXECUTE ? response.subarray(0, 12) : response;

    test("creates a table large enough to need FETCH", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, val VARCHAR(40), zoned TIMESTAMPTZ)`,
        );
        await adapter.beginTransaction();
        for (let id = 0; id < ROW_COUNT; id += 1) {
          await adapter.query(`INSERT INTO ${TABLE} (id, val) VALUES (${id}, 'row ${id}')`);
        }
        await adapter.query(
          `UPDATE ${TABLE} SET zoned = TIMESTAMPTZ'2020-01-02 03:04:05 +09:00' ` +
            `WHERE id = ${ROW_COUNT - 1}`,
        );
        await adapter.commit();

        const trace = await open((_code, response) => response);
        const rows = await trace.adapter.query(SELECT_ALL);
        assert.equal(rows.length, ROW_COUNT);
        assert.ok(count(trace, CASFunctionCode.FETCH) > 0);
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        await trace.adapter.close();
      } finally {
        await adapter.close();
      }
    });

    test("releases the handle after an unsupported FETCH value inside a transaction", async () => {
      const trace = await open((_code, response) => response);

      try {
        await trace.adapter.beginTransaction();
        const generation = trace.cas.connectionGeneration;

        await assert.rejects(trace.adapter.query(UNSUPPORTED_IN_FETCH), QueryError);

        assert.ok(count(trace, CASFunctionCode.FETCH) > 0);
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        assert.equal(trace.cas.connectionGeneration, generation);
        assert.equal(await fetchCode(trace), CAS_ER_SRV_HANDLE);
        await trace.adapter.rollback();
      } finally {
        await trace.adapter.close();
      }
    });

    test("releases the handle on its own session after an autocommit FETCH failure", async () => {
      const trace = await open((_code, response) => response);

      try {
        const generation = trace.cas.connectionGeneration;

        await assert.rejects(trace.adapter.query(UNSUPPORTED_IN_FETCH), QueryError);

        assert.ok(count(trace, CASFunctionCode.FETCH) > 0);
        // The broker has marked the CAS released by now, so anything that goes
        // through sendAndRecv() would reconnect and close nothing.
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        assert.equal(trace.cas.connectionGeneration, generation);
        assert.equal(await fetchCode(trace), CAS_ER_SRV_HANDLE);
      } finally {
        await trace.adapter.close();
      }
    });

    test("releases the handle when the first response holds an unsupported value", async () => {
      const trace = await open((_code, response) => response);

      try {
        await trace.adapter.beginTransaction();

        await assert.rejects(trace.adapter.query(UNSUPPORTED_IN_FIRST_REPLY), QueryError);

        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 1);
        assert.equal(await fetchCode(trace), CAS_ER_SRV_HANDLE);
        await trace.adapter.rollback();
      } finally {
        await trace.adapter.close();
      }
    });

    /** Whether a separate session sees the row, so only committed work counts. */
    async function rowCommitted(id: number): Promise<boolean> {
      const observer = new NativeCubridAdapter(TEST_CONFIG);
      try {
        return (await observer.query(`SELECT id FROM ${TABLE} WHERE id = ${id}`)).length === 1;
      } finally {
        await observer.close();
      }
    }

    for (const [where, tamper] of [
      ["FETCH", truncateFetch],
      ["first", truncateExecute],
    ] as const) {
      test(`a malformed ${where} reply drops the session and the server undoes its work`, async () => {
        const id = ROW_COUNT + (where === "FETCH" ? 1 : 2);
        let armed = false;
        const trace = await open((code, response) => (armed ? tamper(code, response) : response));

        try {
          await trace.adapter.beginTransaction();
          await trace.adapter.query(`INSERT INTO ${TABLE} (id, val) VALUES (${id}, 'lost')`);
          const closesBefore = count(trace, CASFunctionCode.CLOSE_REQ_HANDLE);
          armed = true;

          await assert.rejects(trace.adapter.query(SELECT_ALL), QueryError);

          assert.equal(trace.cas.isConnected, false);
          assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), closesBefore);

          // A later commit must not report success for work the server dropped.
          armed = false;
          await assert.rejects(trace.adapter.commit(), TransactionError);
          assert.equal(await rowCommitted(id), false);

          // That rejected commit acknowledged the loss, so autocommit work resumes.
          const rows = await trace.adapter.query("SELECT 1 + 1 AS result");
          assert.equal(rows[0]!.result, 2);
        } finally {
          await trace.adapter.close();
        }
      });
    }

    test("attempts no release on a socket lost during FETCH, then recovers", async () => {
      const trace = await open((_code, response) => response);
      const internals = trace.cas as unknown as { socket: { destroy(): void } };
      const sendAndRecv = trace.cas.sendAndRecv;
      trace.cas.sendAndRecv = async (header, payload) => {
        if (payload[0] === CASFunctionCode.FETCH) {
          internals.socket.destroy();
        }
        return sendAndRecv(header, payload);
      };

      try {
        await assert.rejects(trace.adapter.query(SELECT_ALL), QueryError);

        assert.equal(trace.cas.isConnected, false);
        assert.equal(count(trace, CASFunctionCode.CLOSE_REQ_HANDLE), 0);

        const rows = await trace.adapter.query("SELECT 1 + 1 AS result");
        assert.equal(rows[0]!.result, 2);
      } finally {
        await trace.adapter.close();
      }
    });

    test("does not open a session just to close a handle", async () => {
      const trace = await open((_code, response) => response);

      try {
        const before = trace.cas.connectionGeneration;
        await trace.adapter.query("SELECT 1 + 1 AS result");

        assert.equal(trace.cas.connectionGeneration, before);
      } finally {
        await trace.adapter.close();
      }
    });

    test("drops the table", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await adapter.close();
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping query lifecycles on one connection (#114)
  // -------------------------------------------------------------------------

  describe("overlapping query lifecycles on one connection", () => {
    const TABLE = "integration_test_concurrent";
    const WRITES = "integration_test_concurrent_writes";
    const GROUPS = 6;
    /** With PADDING, too much data for the first reply, whose limit is bytes rather than rows. */
    const ROWS_PER_GROUP = 350;
    const PADDING = "x".repeat(800);
    const ROUNDS = Number(process.env.CUBRID_CONCURRENCY_ROUNDS ?? 3);

    const selectGroup = (group: number): string =>
      `SELECT id, grp, pad FROM ${TABLE} WHERE grp = ${group} ORDER BY id`;

    function assertOwnRows(rows: unknown[], group: number): void {
      const expected = Array.from({ length: ROWS_PER_GROUP }, (_unused, index) => ({
        id: group * ROWS_PER_GROUP + index,
        grp: group,
        pad: PADDING,
      }));
      assert.deepEqual(rows, expected);
    }

    /** A client whose connections count every FETCH they send. */
    function tracedClient(): { client: ReturnType<typeof createClient>; fetches: () => number } {
      let fetches = 0;
      const client = createClient({
        ...TEST_CONFIG,
        connectionFactory: async (config) => {
          const adapter = new NativeCubridAdapter(config);
          await adapter.connect();
          const cas = (adapter as unknown as { cas: CASConnection }).cas;
          const sendAndRecv = cas.sendAndRecv.bind(cas);
          cas.sendAndRecv = (header, payload) => {
            fetches += payload[0] === CASFunctionCode.FETCH ? 1 : 0;
            return sendAndRecv(header, payload);
          };
          return adapter;
        },
      });
      return { client, fetches: () => fetches };
    }

    test("creates tables whose rows need FETCH", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(`DROP TABLE IF EXISTS ${WRITES}`);
        await adapter.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, grp INT, pad VARCHAR(1000))`,
        );
        await adapter.query(`CREATE TABLE ${WRITES} (id INT)`);
        await adapter.beginTransaction();
        for (let group = 0; group < GROUPS; group += 1) {
          for (let index = 0; index < ROWS_PER_GROUP; index += 1) {
            const id = group * ROWS_PER_GROUP + index;
            await adapter.query(`INSERT INTO ${TABLE} VALUES (${id}, ${group}, '${PADDING}')`);
          }
        }
        await adapter.commit();
      } finally {
        await adapter.close();
      }
    });

    test("Promise.all SELECTs return exactly their own rows in every round", async () => {
      const { client, fetches } = tracedClient();

      try {
        for (let round = 0; round < ROUNDS; round += 1) {
          const groups = Array.from({ length: GROUPS }, (_unused, group) => group);
          const results = await Promise.all(groups.map((group) => client.query(selectGroup(group))));
          groups.forEach((group) => assertOwnRows(results[group]!, group));
        }
        assert.ok(fetches() > 0, "the test proves nothing unless these rows needed FETCH");
      } finally {
        await client.close();
      }
    });

    test("parameterized Promise.all SELECTs return exactly their own rows", async () => {
      const { client, fetches } = tracedClient();

      try {
        const groups = [0, 1, 2];
        const results = await Promise.all(
          groups.map((group) =>
            client.query(`SELECT id, grp, pad FROM ${TABLE} WHERE grp = ? ORDER BY id`, [group]),
          ),
        );
        groups.forEach((group) => assertOwnRows(results[group]!, group));
        assert.ok(fetches() > 0);
      } finally {
        await client.close();
      }
    });

    test("DML, a failing statement and a ping leave running SELECTs intact", async () => {
      const { client, fetches } = tracedClient();

      try {
        for (let round = 0; round < ROUNDS; round += 1) {
          const [first, inserted, failed, version, last] = await Promise.allSettled([
            client.query(selectGroup(0)),
            client.query(`INSERT INTO ${WRITES} VALUES (${round})`),
            client.query("SELEC bogus"),
            client.ping(),
            client.query(selectGroup(1)),
          ]);

          assert.equal(first.status, "fulfilled");
          assertOwnRows(first.status === "fulfilled" ? first.value : [], 0);
          assert.equal(inserted.status, "fulfilled");
          assert.equal(failed.status, "rejected");
          assert.equal(version.status, "fulfilled");
          assert.equal(last.status, "fulfilled");
          assertOwnRows(last.status === "fulfilled" ? last.value : [], 1);
        }
        assert.ok(fetches() > 0);
      } finally {
        await client.close();
      }
    });

    test("Promise.all inside transaction() keeps rows and commits every statement", async () => {
      const { client, fetches } = tracedClient();

      try {
        await client.query(`DELETE FROM ${WRITES}`);
        const results = await client.transaction((tx) =>
          Promise.all([
            tx.query(selectGroup(0)),
            tx.query(`INSERT INTO ${WRITES} VALUES (1)`),
            tx.query(selectGroup(1)),
          ]),
        );

        assertOwnRows(results[0], 0);
        assertOwnRows(results[2], 1);
        assert.ok(fetches() > 0);
        const written = await client.query(`SELECT id FROM ${WRITES}`);
        assert.deepEqual(written, [{ id: 1 }]);
      } finally {
        await client.close();
      }
    });

    test("rollback issued alongside queries undoes their writes and cuts off no rows", async () => {
      const { client, fetches } = tracedClient();

      try {
        await client.query(`DELETE FROM ${WRITES}`);
        await client.beginTransaction();
        const [before, , , after] = await Promise.all([
          client.query(selectGroup(0)),
          client.query(`INSERT INTO ${WRITES} VALUES (2)`),
          client.rollback(),
          client.query(selectGroup(1)),
        ]);

        assertOwnRows(before, 0);
        assertOwnRows(after, 1);
        assert.ok(fetches() > 0);
        assert.deepEqual(await client.query(`SELECT id FROM ${WRITES}`), []);
      } finally {
        await client.close();
      }
    });

    test("commit issued alongside queries runs after them", async () => {
      const { client, fetches } = tracedClient();

      try {
        await client.query(`DELETE FROM ${WRITES}`);
        await client.beginTransaction();
        const [rows] = await Promise.all([
          client.query(selectGroup(2)),
          client.query(`INSERT INTO ${WRITES} VALUES (3)`),
          client.commit(),
        ]);

        assertOwnRows(rows, 2);
        assert.ok(fetches() > 0);
        assert.deepEqual(await client.query(`SELECT id FROM ${WRITES}`), [{ id: 3 }]);
      } finally {
        await client.close();
      }
    });

    test("close waits for a query that is still fetching", async () => {
      const { client, fetches } = tracedClient();

      await client.ping();
      const running = client.query(selectGroup(3));
      const closing = client.close();

      assertOwnRows(await running, 3);
      await closing;
      assert.ok(fetches() > 0);
    });

    // The tests below drive the server without the adapter's statement queue,
    // to record what a broker does with several live handles. If one starts to
    // fail on a new server version, the reason for serializing has changed.
    describe("what the server does with several live handles", () => {
      async function openSession(): Promise<{
        cas: CASConnection;
        execute: (sql: string, autoCommit: boolean) => Promise<PrepareAndExecuteResult>;
        fetch: (result: PrepareAndExecuteResult, position: number) => Promise<FetchResult>;
      }> {
        const cas = new CASConnection(TEST_CONFIG);
        await cas.connect();
        const generation = cas.connectionGeneration;

        // sendAndRecvOnSession() because sendAndRecv() would reconnect once
        // CAS_INFO reports the transaction ended, which is the moment of interest.
        const exchange = async (request: { header: Buffer; payload: Buffer }): Promise<Buffer> => {
          const response = await cas.sendAndRecvOnSession(
            generation,
            request.header,
            request.payload,
          );
          assert.ok(response, "the session must stay open");
          return response;
        };

        return {
          cas,
          execute: async (sql, autoCommit) =>
            parsePrepareAndExecute(
              await exchange(writePrepareAndExecute(sql, autoCommit, cas.casInfo)),
              cas.protoVersion,
            ),
          fetch: async (result, position) =>
            parseFetch(
              await exchange(writeFetch(result.queryHandle, position, 100, cas.casInfo)),
              result.columns,
            ),
        };
      }

      test("handles of an open transaction interleave FETCHes safely", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const groups = [0, 1, 2];
          const results: PrepareAndExecuteResult[] = [];
          for (const group of groups) {
            results.push(await execute(selectGroup(group), false));
          }

          const handles = new Set(results.map((result) => result.queryHandle));
          assert.equal(handles.size, groups.length);
          const rows = results.map((result) => [...result.rows]);
          assert.ok(rows.every((own) => own.length < ROWS_PER_GROUP), "FETCH must be needed");

          while (rows.some((own) => own.length < ROWS_PER_GROUP)) {
            for (const group of groups) {
              if (rows[group]!.length < ROWS_PER_GROUP) {
                const page = await fetch(results[group]!, rows[group]!.length);
                rows[group]!.push(...page.rows);
              }
            }
          }

          groups.forEach((group) => assertOwnRows(rows[group]!, group));
        } finally {
          await cas.close();
        }
      });

      test("an autocommit SELECT reaching its last row closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          const finisher = await execute(selectGroup(1), true);

          let position = finisher.rows.length;
          while (position < ROWS_PER_GROUP) {
            position += (await fetch(finisher, position)).tupleCount;
          }

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("an autocommit INSERT closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          await execute(`INSERT INTO ${WRITES} VALUES (4)`, true);

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("a failing autocommit statement closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          await assert.rejects(execute("SELEC bogus", true), /\(-493\)/);

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("a ping closes other live handles", async () => {
        const { cas, execute, fetch } = await openSession();

        try {
          const survivor = await execute(selectGroup(0), true);
          await cas.ping(false);

          await assert.rejects(fetch(survivor, survivor.rows.length), /\(-1012\)/);
        } finally {
          await cas.close();
        }
      });

      test("a handle number means another result on a newer session", async () => {
        const first = await openSession();
        const second = await openSession();

        try {
          const stale = await first.execute(selectGroup(0), true);
          const other = await second.execute(selectGroup(1), true);
          assert.equal(stale.queryHandle, other.queryHandle);

          const page = await second.fetch(stale, stale.rows.length);
          assert.ok(page.rows.length > 0);
          assert.ok(page.rows.every((row) => row.grp === 1));
        } finally {
          await first.cas.close();
          await second.cas.close();
        }
      });
    });

    test("drops the tables", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await adapter.query(`DROP TABLE IF EXISTS ${WRITES}`);
      await adapter.close();
    });
  });

  // -------------------------------------------------------------------------
  // Structured server errors: each of these failures really happens on the server
  // -------------------------------------------------------------------------

  describe("server error details", () => {
    const PARENT = "cc_err_parent";
    const CHILD = "cc_err_child";
    const ROWS = "cc_err_rows";

    /** Resolves with the rejection, and fails the test if `run` succeeds. */
    async function failure<E extends Error = QueryError>(run: () => Promise<unknown>): Promise<E> {
      try {
        await run();
      } catch (error) {
        return error as E;
      }
      throw new Error("expected the statement to fail");
    }

    async function withAdapters(
      run: (first: NativeCubridAdapter, second: NativeCubridAdapter) => Promise<void>,
    ): Promise<void> {
      const first = new NativeCubridAdapter(TEST_CONFIG);
      const second = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await first.connect();
        await second.connect();
        await run(first, second);
      } finally {
        await first.rollback().catch(() => {});
        await second.rollback().catch(() => {});
        await first.close();
        await second.close();
      }
    }

    /**
     * Makes each adapter wait for the row the other has already locked.
     * SET TRANSACTION LOCK TIMEOUT runs inside the transaction because, sent in
     * autocommit before beginTransaction(), a later statement still waited forever.
     */
    async function deadlock(
      first: NativeCubridAdapter,
      second: NativeCubridAdapter,
      lockTimeoutSeconds?: number,
    ): Promise<PromiseSettledResult<unknown>[]> {
      await first.beginTransaction();
      await second.beginTransaction();

      if (lockTimeoutSeconds !== undefined) {
        await first.query(`SET TRANSACTION LOCK TIMEOUT ${lockTimeoutSeconds}`);
        await second.query(`SET TRANSACTION LOCK TIMEOUT ${lockTimeoutSeconds}`);
      }

      await first.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);
      await second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 2`);

      return Promise.allSettled([
        first.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 2`),
        new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
          second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`),
        ),
      ]);
    }

    const rejections = (results: PromiseSettledResult<unknown>[]): QueryError[] =>
      results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));

    test("create the tables", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${CHILD}`);
        await adapter.query(`DROP TABLE IF EXISTS ${PARENT}`);
        await adapter.query(`DROP TABLE IF EXISTS ${ROWS}`);
        await adapter.query(`CREATE TABLE ${PARENT} (id INT PRIMARY KEY)`);
        await adapter.query(
          `CREATE TABLE ${CHILD} (id INT PRIMARY KEY, parent_id INT, ` +
            `FOREIGN KEY (parent_id) REFERENCES ${PARENT} (id))`,
        );
        await adapter.query(
          `CREATE TABLE ${ROWS} (id INT PRIMARY KEY, label VARCHAR(20) UNIQUE, n INT NOT NULL)`,
        );
        await adapter.query(`INSERT INTO ${PARENT} VALUES (1)`);
        await adapter.query(`INSERT INTO ${CHILD} VALUES (1, 1)`);
        await adapter.query(`INSERT INTO ${ROWS} VALUES (1, 'a', 1), (2, 'b', 2)`);
      } finally {
        await adapter.close();
      }
    });

    test("a duplicate primary key and a duplicate unique column report -670", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        for (const sql of [
          `INSERT INTO ${ROWS} VALUES (1, 'z', 1)`,
          `INSERT INTO ${ROWS} VALUES (9, 'a', 1)`,
          `UPDATE ${ROWS} SET label = 'a' WHERE id = 2`,
        ]) {
          const error = await failure(() => client.query(sql));

          assert.ok(error instanceof ConstraintError);
          assert.ok(error instanceof QueryError);
          assert.equal(error.name, "ConstraintError");
          assert.equal(error.code, -670);
          assert.equal(error.origin, "server");
          assert.equal(error.kind, "unique-violation");
          assert.equal(error.sqlState, undefined);
        }
      } finally {
        await client.close();
      }
    });

    test("a syntax error reports -493", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure(() => client.query("SELEC 1"));

        assert.ok(error instanceof SqlSyntaxError);
        assert.ok(error instanceof QueryError);
        assert.equal(error.code, -493);
        assert.equal(error.origin, "server");
        assert.equal(error.kind, "syntax");
      } finally {
        await client.close();
      }
    });

    test("an unknown table is a -493 syntax error, an unknown column a -494", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const table = await failure(() => client.query("SELECT * FROM cc_err_no_such_table"));
        assert.ok(table instanceof SqlSyntaxError);
        assert.equal(table.code, -493);

        const column = await failure(() => client.query(`SELECT nope FROM ${ROWS}`));
        assert.equal(column.constructor, QueryError);
        assert.equal(column.code, -494);
        assert.equal(column.kind, "semantic");
      } finally {
        await client.close();
      }
    });

    test("constraint violations report their own codes", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const notNull = await failure(() =>
          client.query(`INSERT INTO ${ROWS} VALUES (5, 'n', NULL)`),
        );
        assert.ok(notNull instanceof ConstraintError);
        assert.equal(notNull.code, -631);
        assert.equal(notNull.kind, "not-null-violation");

        const noParent = await failure(() => client.query(`INSERT INTO ${CHILD} VALUES (2, 99)`));
        assert.ok(noParent instanceof ConstraintError);
        assert.equal(noParent.code, -922);
        assert.equal(noParent.kind, "foreign-key-violation");

        const hasChild = await failure(() => client.query(`DELETE FROM ${PARENT} WHERE id = 1`));
        assert.ok(hasChild instanceof ConstraintError);
        assert.equal(hasChild.code, -924);
        assert.equal(hasChild.kind, "foreign-key-violation");

        const truncate = await failure(() => client.query(`TRUNCATE ${PARENT}`));
        assert.ok(truncate instanceof ConstraintError);
        assert.ok(truncate.code === -924 || truncate.code === -1284, `got ${truncate.code}`);
        assert.equal(truncate.kind, "foreign-key-violation");
      } finally {
        await client.close();
      }
    });

    test("a server code nobody classified still reaches the caller", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure(() => client.query("SELECT CAST('x' AS INT)"));

        assert.equal(error.constructor, QueryError);
        assert.equal(error.code, -181);
        assert.equal(error.origin, "server");
        assert.equal(error.kind, undefined);
      } finally {
        await client.close();
      }
    });

    test("an undecodable value keeps its name and has no server details", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure(() =>
          client.query("SELECT TIMESTAMPTZ'2020-01-02 03:04:05 +09:00' AS zoned"),
        );
        let current: unknown = error;
        while (current instanceof Error && current.name !== "UnsupportedValueError") {
          current = current.cause;
        }

        assert.ok(current instanceof Error);
        assert.equal(error.constructor, QueryError);
        assert.equal(error.code, undefined);
        assert.equal(error.origin, undefined);
        assert.equal(error.kind, undefined);

        const next = await failure(() => client.query("SELEC 1"));
        assert.ok(next instanceof SqlSyntaxError);
        assert.equal(next.code, -493);
      } finally {
        await client.close();
      }
    });

    test("a failure inside transaction() stays a TransactionError with the same details", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const error = await failure<TransactionError>(() =>
          client.transaction((tx) => tx.query(`INSERT INTO ${ROWS} VALUES (1, 'z', 1)`)),
        );

        assert.ok(error instanceof TransactionError);
        assert.equal(error.code, -670);
        assert.equal(error.kind, "unique-violation");
        assert.equal(error.origin, "server");
      } finally {
        await client.close();
      }
    });

    test("a wrong password and an unknown user report their own codes", async () => {
      const password = new NativeCubridAdapter({ ...TEST_CONFIG, password: "wrong" });
      const passwordError = await failure<ConnectionError>(() => password.connect());
      assert.ok(passwordError instanceof ConnectionError);
      assert.equal(passwordError.code, -171);
      assert.equal(passwordError.origin, "server");
      assert.equal(passwordError.kind, "authentication");
      await password.close().catch(() => {});

      const user = new NativeCubridAdapter({ ...TEST_CONFIG, user: "cc_err_no_such_user" });
      const userError = await failure<ConnectionError>(() => user.connect());
      assert.equal(userError.code, -165);
      assert.equal(userError.kind, "authentication");
      await user.close().catch(() => {});
    });

    test("a server lock timeout on a row is -75 and leaves the transaction open", async () => {
      await withAdapters(async (first, second) => {
        await first.beginTransaction();
        await first.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);

        await second.beginTransaction();
        await second.query("SET TRANSACTION LOCK TIMEOUT 1");

        const error = await failure(() =>
          second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`),
        );

        assert.ok(error instanceof LockTimeoutError);
        assert.ok(error instanceof QueryError);
        assert.ok(!(error instanceof ConnectionError));
        assert.equal(error.code, -75);
        assert.equal(error.origin, "server");
        assert.equal(error.kind, "lock-timeout");

        await second.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 2`);
      });
    });

    test("a server lock timeout on a table is -74", async () => {
      await withAdapters(async (first, second) => {
        await first.beginTransaction();
        await first.query(`ALTER TABLE ${ROWS} ADD COLUMN cc_err_extra INT`);

        await second.beginTransaction();
        await second.query("SET TRANSACTION LOCK TIMEOUT 1");

        const error = await failure(() => second.query(`SELECT * FROM ${ROWS}`));

        assert.ok(error instanceof LockTimeoutError);
        assert.equal(error.code, -74);
      });
    });

    test("the client's read timeout stays distinct from a server lock wait", async () => {
      const impatient = new NativeCubridAdapter({ ...TEST_CONFIG, readTimeout: 2000 });
      const holder = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await holder.beginTransaction();
        await holder.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);
        await impatient.connect();
        await impatient.beginTransaction();

        const error = await failure<ReadTimeoutError>(() =>
          impatient.query(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`),
        );

        assert.ok(error instanceof ReadTimeoutError);
        assert.ok(!(error instanceof LockTimeoutError));
        assert.equal(error.kind, "read-timeout");
        assert.equal(error.code, undefined);
        assert.equal(error.origin, undefined);
      } finally {
        await holder.rollback().catch(() => {});
        await holder.close();
        await impatient.close().catch(() => {});
      }
    });

    test("a deadlock victim gets -72 and the other transaction proceeds", async () => {
      await withAdapters(async (first, second) => {
        const results = await deadlock(first, second);
        const failed = rejections(results);

        assert.equal(failed.length, 1);
        assert.ok(failed[0] instanceof DeadlockError);
        assert.ok(failed[0] instanceof QueryError);
        assert.equal(failed[0].code, -72);
        assert.equal(failed[0].origin, "server");
        assert.equal(failed[0].kind, "deadlock");
      });
    });

    test("under a finite lock timeout the deadlock victim gets -968", async () => {
      await withAdapters(async (first, second) => {
        const failed = rejections(await deadlock(first, second, 4));
        const codes = failed.map((error) => error.code).sort();

        // The survivor still waits for its own lock until its timeout expires.
        assert.deepEqual(codes, [-75, -968]);
        const victim = failed.find((error) => error.code === -968);
        assert.ok(victim instanceof DeadlockError);
        assert.equal(victim.kind, "deadlock");
      });
    });

    test("drop the tables", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${CHILD}`);
        await adapter.query(`DROP TABLE IF EXISTS ${PARENT}`);
        await adapter.query(`DROP TABLE IF EXISTS ${ROWS}`);
      } finally {
        await adapter.close();
      }
    });
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
