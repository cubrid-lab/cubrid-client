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
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";

import { createClient } from "../src/client/create-client.js";
import { NativeCubridAdapter } from "../src/adapters/native.js";
import { ZonedDateTime } from "../src/types/zoned-date-time.js";
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
import type { TransactionClient } from "../src/types/client.js";
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

  test("getServerVersion returns the server version and leaves a transaction's row to rollback()", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      const version = await client.getServerVersion();
      assert.match(version, /^\d+\.\d+\.\d+\.\d+$/);
      assert.equal(version, await client.ping());

      await client.query("DROP TABLE IF EXISTS tx_version_test_native");
      await client.query("CREATE TABLE tx_version_test_native (val VARCHAR(50))");

      await client.beginTransaction();
      await client.query("INSERT INTO tx_version_test_native (val) VALUES ('rolled back')");
      assert.equal(await client.getServerVersion(), version);
      await client.rollback();

      assert.deepEqual(await client.query("SELECT val FROM tx_version_test_native"), []);

      await client.query("DROP TABLE tx_version_test_native");
    } finally {
      await client.close();
    }
  });

  test("queryResult reports column metadata, duplicate names and a NULL-only column", async () => {
    const client = createClient(TEST_CONFIG);

    try {
      await client.query("DROP TABLE IF EXISTS cm_a_native");
      await client.query("DROP TABLE IF EXISTS cm_b_native");
      await client.query(
        "CREATE TABLE cm_a_native (id INT NOT NULL PRIMARY KEY, label VARCHAR(20), amount NUMERIC(10,3), ts DATETIME, tags SET(INT))",
      );
      await client.query("CREATE TABLE cm_b_native (id INT)");
      await client.query("INSERT INTO cm_a_native (id, label) VALUES (7, 'seven')");

      const result = await client.queryResult(
        "SELECT a.id, b.id, a.label, a.amount, a.ts, a.tags, NULL AS nothing " +
          "FROM cm_a_native a LEFT JOIN cm_b_native b ON a.id = b.id",
      );

      assert.deepEqual(result.columns, [
        { name: "id", type: "INT", precision: 10, scale: 0, nullable: false },
        { name: "id", type: "INT", precision: 10, scale: 0, nullable: true },
        { name: "label", type: "VARCHAR", precision: 20, scale: 0, nullable: true },
        { name: "amount", type: "NUMERIC", precision: 10, scale: 3, nullable: true },
        { name: "ts", type: "DATETIME", precision: 23, scale: 3, nullable: true },
        { name: "tags", type: "SET", elementType: "INT", precision: 0, scale: 0, nullable: true },
        { name: "nothing", type: "NULL", precision: 0, scale: 0, nullable: true },
      ]);
      // One key per name, as query() returns: the second `id` (NULL here) wins.
      assert.deepEqual(result.rows, [
        { id: null, label: "seven", amount: null, ts: null, tags: null, nothing: null },
      ]);
      assert.deepEqual(await client.query("SELECT a.id, b.id FROM cm_a_native a LEFT JOIN cm_b_native b ON a.id = b.id"), [
        { id: null },
      ]);

      assert.deepEqual(await client.queryResult("INSERT INTO cm_b_native VALUES (1)"), {
        rows: [],
        columns: [],
      });

      await client.query("DROP TABLE cm_a_native");
      await client.query("DROP TABLE cm_b_native");
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
  // Transaction callback lifecycle: one terminal outcome, nothing after it
  // -------------------------------------------------------------------------

  describe("transaction callback lifecycle", () => {
    const table = "tx_lifecycle_test_native";

    /**
     * A real adapter that counts END_TRAN requests. Failure switches stand in
     * for faults a live broker will not produce on demand; the injected
     * rollback and commit never reach the server, so what the assertions read
     * back is what the server really kept.
     */
    class ObservedAdapter extends NativeCubridAdapter {
      commits = 0;
      rollbacks = 0;
      failCommit = false;
      failRollback = false;
      failClose = false;

      override async commit(): Promise<void> {
        this.commits += 1;
        if (this.failCommit) {
          throw new Error("injected commit failure");
        }
        await super.commit();
      }

      override async rollback(): Promise<void> {
        this.rollbacks += 1;
        if (this.failRollback) {
          throw new Error("injected rollback failure");
        }
        await super.rollback();
      }

      override async close(): Promise<void> {
        await super.close();
        if (this.failClose) {
          throw new Error("injected close failure");
        }
      }
    }

    async function withObservedClient(
      run: (
        client: ReturnType<typeof createClient>,
        observed: ObservedAdapter,
        insertedValues: () => Promise<string[]>,
      ) => Promise<void>,
      configure: (adapter: ObservedAdapter) => void = () => undefined,
    ): Promise<void> {
      const setup = createClient(TEST_CONFIG);
      const observed = new ObservedAdapter(TEST_CONFIG);
      configure(observed);
      const client = createClient({ ...TEST_CONFIG, connectionFactory: () => observed });

      const insertedValues = async () => {
        const rows = await setup.query<{ val: string }>(`SELECT val FROM ${table} ORDER BY id`);
        return rows.map((row) => row.val);
      };

      try {
        await setup.query(`DROP TABLE IF EXISTS ${table}`);
        await setup.query(
          `CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(50))`,
        );
        await run(client, observed, insertedValues);
      } finally {
        await setup.query(`DROP TABLE IF EXISTS ${table}`);
        await setup.close();
      }
    }

    const insert = (value: string) => `INSERT INTO ${table} (val) VALUES ('${value}')`;

    test("manual commit is the only commit and later statements cannot autocommit", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        const result = await client.transaction(async (tx) => {
          await tx.query(insert("before commit"));
          await tx.commit();
          await assert.rejects(tx.query(insert("after commit")), TransactionError);
          await assert.rejects(tx.commit(), TransactionError);
          await assert.rejects(tx.rollback(), TransactionError);
          return "ok";
        });

        assert.equal(result, "ok");
        assert.equal(observed.commits, 1);
        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), ["before commit"]);
      });
    });

    test("manual rollback stops the automatic commit", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        const result = await client.transaction(async (tx) => {
          await tx.query(insert("rolled back"));
          await tx.rollback();
          await assert.rejects(tx.query(insert("after rollback")), TransactionError);
          return "declined";
        });

        assert.equal(result, "declined");
        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    test("an error after manual commit rejects and the commit stands", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction(async (tx) => {
            await tx.query(insert("kept"));
            await tx.commit();
            throw new Error("after commit");
          }),
          (error: Error) => error instanceof TransactionError && error.cause instanceof Error,
        );

        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), ["kept"]);
      });
    });

    test("a tx kept after transaction() returned cannot write", async () => {
      await withObservedClient(async (client, _observed, insertedValues) => {
        let leaked: TransactionClient | undefined;

        await client.transaction(async (tx) => {
          leaked = tx;
          await tx.query(insert("committed"));
        });

        assert.ok(leaked);
        await assert.rejects(leaked.query(insert("leaked")), TransactionError);
        assert.deepEqual(await insertedValues(), ["committed"]);
      });
    });

    test("a bound query the callback did not await still lands inside the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        // The first bound query on a connection waits for the backslash-mode
        // probe, so its statement would otherwise follow the automatic commit.
        await client.transaction(async (tx) => {
          void tx.query(`INSERT INTO ${table} (val) VALUES (?)`, ["not awaited"]);
        });

        assert.equal(observed.commits, 1);
        assert.deepEqual(await insertedValues(), ["not awaited"]);
      });
    });

    test("a query that fails unawaited rolls back the rest of the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction(async (tx) => {
            await tx.query(insert("must not persist"));
            void tx.query("INSERT INTO tx_lifecycle_no_such_table (val) VALUES ('x')");
          }),
          TransactionError,
        );

        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    test("Promise.all of bound statements commits all of them through the queue", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        const values = ["one", "two", "three", "four", "five"];

        await client.transaction((tx) =>
          Promise.all(
            values.map((value) => tx.query(`INSERT INTO ${table} (val) VALUES (?)`, [value])),
          ),
        );

        assert.equal(observed.commits, 1);
        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), values);
      });
    });

    test("Promise.all of query, queryResult and execute commits all of them once", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await client.transaction((tx) =>
          Promise.all([
            tx.query(insert("one")),
            tx.queryResult(insert("two")),
            tx.execute(insert("three")),
          ]),
        );

        assert.equal(observed.commits, 1);
        assert.equal(observed.rollbacks, 0);
        assert.deepEqual(await insertedValues(), ["one", "two", "three"]);
      });
    });

    test("an execute() the callback did not await lands inside the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await client.transaction(async (tx) => {
          void tx.execute(`INSERT INTO ${table} (val) VALUES (?)`, ["not awaited"]);
        });

        assert.equal(observed.commits, 1);
        assert.deepEqual(await insertedValues(), ["not awaited"]);
      });
    });

    test("an execute() that fails unawaited rolls back the rest of the transaction", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction(async (tx) => {
            await tx.query(insert("kept out"));
            void tx.execute("INSERT INTO tx_lifecycle_no_such_table (val) VALUES ('x')");
          }),
          TransactionError,
        );

        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    test("execute() and queryResult() after a manual commit reject and write nothing", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await client.transaction(async (tx) => {
          await tx.execute(insert("committed"));
          await tx.commit();
          await assert.rejects(tx.execute(insert("late execute")), TransactionError);
          await assert.rejects(tx.queryResult(insert("late queryResult")), TransactionError);
        });

        assert.equal(observed.commits, 1);
        assert.deepEqual(await insertedValues(), ["committed"]);
      });
    });

    test("Promise.all with a failing statement rolls back the statements queued with it", async () => {
      await withObservedClient(async (client, observed, insertedValues) => {
        await assert.rejects(
          client.transaction((tx) =>
            Promise.all([
              tx.query(insert("before the failure")),
              tx.query("INSERT INTO tx_lifecycle_no_such_table (val) VALUES ('x')"),
              tx.query(insert("after the failure")),
            ]),
          ),
          TransactionError,
        );

        assert.equal(observed.commits, 0);
        assert.equal(observed.rollbacks, 1);
        assert.deepEqual(await insertedValues(), []);
      });
    });

    test("a failed commit rolls back on the server and keeps its cause", async () => {
      await withObservedClient(
        async (client, observed, insertedValues) => {
          await assert.rejects(
            client.transaction(async (tx) => {
              await tx.query(insert("not committed"));
            }),
            (error: Error) =>
              error instanceof TransactionError &&
              (error.cause as Error).message === "injected commit failure",
          );

          assert.equal(observed.commits, 1);
          assert.equal(observed.rollbacks, 1);
          assert.deepEqual(await insertedValues(), []);
        },
        (adapter) => {
          adapter.failCommit = true;
        },
      );
    });

    test("rollback and close failures keep the original error and discard the work", async () => {
      await withObservedClient(
        async (client, observed, insertedValues) => {
          const original = new Error("original");

          await assert.rejects(
            client.transaction(async (tx) => {
              await tx.query(insert("never committed"));
              throw original;
            }),
            (error: Error) =>
              error instanceof TransactionError &&
              error.cause === original &&
              error.rollbackError?.message === "injected rollback failure" &&
              error.closeError?.message === "injected close failure",
          );

          assert.equal(observed.commits, 0);
          assert.equal(observed.rollbacks, 1);
          assert.deepEqual(await insertedValues(), []);
        },
        (adapter) => {
          adapter.failRollback = true;
          adapter.failClose = true;
        },
      );
    });

    test("a close failure after commit rejects but the commit is durable", async () => {
      await withObservedClient(
        async (client, observed, insertedValues) => {
          await assert.rejects(
            client.transaction(async (tx) => {
              await tx.query(insert("durable"));
            }),
            (error: Error) => error.message === "injected close failure",
          );

          assert.equal(observed.commits, 1);
          assert.deepEqual(await insertedValues(), ["durable"]);
        },
        (adapter) => {
          adapter.failClose = true;
        },
      );
    });
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
  // Zero dates (#178)
  // -------------------------------------------------------------------------

  describe("zero dates", () => {
    const TABLE = "integration_zero_dates";
    const ZERO_VALUES = [
      { type: "DATE", literal: "DATE'0000-00-00'", wireType: 13, size: 6 },
      { type: "DATETIME", literal: "DATETIME'0000-00-00 00:00:00'", wireType: 22, size: 14 },
      { type: "TIMESTAMP", literal: "TIMESTAMP'0000-00-00 00:00:00'", wireType: 15, size: 12 },
    ];

    for (const { type, literal, wireType, size } of ZERO_VALUES) {
      test(`a zero ${type} rejects with its column and type, and the session stays usable`, async () => {
        const adapter = new NativeCubridAdapter(TEST_CONFIG);
        await adapter.connect();
        const cas = (adapter as unknown as { cas: CASConnection }).cas;
        const generation = cas.connectionGeneration;

        try {
          await assert.rejects(adapter.query(`SELECT ${literal} AS zero_value, 'after' AS t`), (err: Error) => {
            assert.ok(err instanceof QueryError);
            assert.match(
              (err.cause as Error).message,
              new RegExp(`column "zero_value" \\(wire type ${wireType}, ${size} bytes\\)`),
            );
            return true;
          });

          // Same physical session, and it answers the next statement.
          assert.equal(cas.connectionGeneration, generation);
          assert.deepEqual(await adapter.query("SELECT 1 AS one"), [{ one: 1 }]);
        } finally {
          await adapter.close();
        }
      });
    }

    test("a zero date inside a collection rejects, and the session stays usable", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = (adapter as unknown as { cas: CASConnection }).cas;
      const generation = cas.connectionGeneration;

      try {
        await assert.rejects(
          adapter.query(
            "SELECT CAST({DATE'0000-00-00', DATE'2020-01-02'} AS SEQUENCE OF DATE) AS c, 'after' AS t",
          ),
          (err: Error) => {
            assert.ok(err instanceof QueryError);
            assert.match((err.cause as Error).message, /column "c" \(wire type 18, 25 bytes\)/);
            return true;
          },
        );
        assert.equal(cas.connectionGeneration, generation);
        assert.deepEqual(await adapter.query("SELECT 1 AS one"), [{ one: 1 }]);
      } finally {
        await adapter.close();
      }
    });

    test("a stored zero date rejects, a valid row beside it still decodes, and a transaction survives", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, d DATE, dt DATETIME, ts TIMESTAMP)`,
        );
        await adapter.beginTransaction();
        await adapter.query(
          `INSERT INTO ${TABLE} VALUES (1, DATE'0000-00-00', DATETIME'0000-00-00 00:00:00', ` +
            `TIMESTAMP'0000-00-00 00:00:00')`,
        );
        await adapter.query(
          `INSERT INTO ${TABLE} VALUES (2, DATE'2020-01-02', DATETIME'2020-01-02 03:04:05', ` +
            `TIMESTAMP'2020-01-02 03:04:05')`,
        );

        for (const column of ["d", "dt", "ts"]) {
          await assert.rejects(
            adapter.query(`SELECT id, ${column} FROM ${TABLE} WHERE id = 1`),
            (err: Error) => {
              assert.ok(err instanceof QueryError);
              assert.match((err.cause as Error).message, new RegExp(`column "${column}"`));
              return true;
            },
          );
        }

        const rows = await adapter.query(`SELECT id, d FROM ${TABLE} WHERE id = 2`);
        assert.equal(rows.length, 1);
        assert.ok(rows[0]!.d instanceof Date);

        // The open transaction is still ours: its rows are visible, and commit works.
        assert.equal((await adapter.query(`SELECT id FROM ${TABLE}`)).length, 2);
        await adapter.commit();
        assert.equal((await adapter.query(`SELECT id FROM ${TABLE}`)).length, 2);
      } finally {
        try {
          await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        } finally {
          await adapter.close();
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Timezone-aware values and JSON (#111)
  // -------------------------------------------------------------------------

  describe("timezone-aware values and JSON", () => {
    const TABLE = "integration_zoned_values";
    const COLUMNS = ["tstz", "tsltz", "dttz", "dtltz"] as const;

    /** The value of the first column of the only row of `sql`, on a fresh session. */
    async function selectValue(sql: string): Promise<unknown> {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      try {
        const rows = await adapter.query(sql);
        assert.equal(rows.length, 1);
        return Object.values(rows[0] as Record<string, unknown>)[0];
      } finally {
        await adapter.close();
      }
    }

    const LITERALS: Array<{ literal: string; text: string; type: string }> = [
      {
        literal: "TIMESTAMPTZ'2020-01-02 03:04:05 +09:00'",
        text: "2020-01-02 03:04:05 +09:00",
        type: "TIMESTAMPTZ",
      },
      {
        literal: "TIMESTAMPTZ'2020-07-02 03:04:05 -05:30'",
        text: "2020-07-02 03:04:05 -05:30",
        type: "TIMESTAMPTZ",
      },
      {
        literal: "TIMESTAMPTZ'2020-01-02 03:04:05 America/New_York'",
        text: "2020-01-02 03:04:05 America/New_York EST",
        type: "TIMESTAMPTZ",
      },
      {
        literal: "DATETIMETZ'2020-01-02 03:04:05.678 +09:00'",
        text: "2020-01-02 03:04:05.678 +09:00",
        type: "DATETIMETZ",
      },
      {
        literal: "DATETIMETZ'2020-07-02 03:04:05.999 America/New_York EDT'",
        text: "2020-07-02 03:04:05.999 America/New_York EDT",
        type: "DATETIMETZ",
      },
      {
        literal: "DATETIMETZ'0001-01-01 00:00:00.000 +00:00'",
        text: "0001-01-01 00:00:00.000 +00:00",
        type: "DATETIMETZ",
      },
      {
        literal: "DATETIMETZ'9999-12-31 23:59:59.999 +14:00'",
        text: "9999-12-31 23:59:59.999 +14:00",
        type: "DATETIMETZ",
      },
    ];

    for (const { literal, text, type } of LITERALS) {
      test(`${literal} keeps its zone and its fields`, async () => {
        const value = await selectValue(`SELECT ${literal} AS v`);
        assert.ok(value instanceof ZonedDateTime);
        assert.equal(value.type, type);
        assert.equal(String(value), text);
      });

      test(`${literal} round-trips: its text, written back as a literal, reads the same`, async () => {
        const first = (await selectValue(`SELECT ${literal} AS v`)) as ZonedDateTime;
        const again = await selectValue(`SELECT ${first.type}'${first.toString()}' AS v`);
        assert.ok(again instanceof ZonedDateTime);
        assert.deepEqual({ ...again }, { ...first });
      });
    }

    test("leap days decode, and the server refuses a date that does not exist", async () => {
      assert.equal(
        String(await selectValue("SELECT DATETIMETZ'2020-02-29 23:59:59.999 +00:00' AS v")),
        "2020-02-29 23:59:59.999 +00:00",
      );
      assert.equal(
        String(await selectValue("SELECT DATETIMETZ'2000-02-29 00:00:00.000 +00:00' AS v")),
        "2000-02-29 00:00:00.000 +00:00",
      );
      // The decoder also rejects these as malformed, but the server never sends them.
      for (const literal of [
        "DATETIMETZ'2021-02-29 00:00:00.000 +00:00'",
        "DATETIMETZ'1900-02-29 00:00:00.000 +00:00'",
        "DATETIMETZ'10000-01-01 00:00:00.000 +00:00'",
        "TIMESTAMPTZ'2021-04-31 00:00:00 +00:00'",
      ]) {
        await assert.rejects(
          selectValue(`SELECT ${literal} AS v`),
          (error: Error) => {
            assert.ok(error instanceof QueryError, literal);
            assert.match(String((error.cause as Error | undefined)?.message), /Invalid utime/, literal);
            return true;
          },
          literal,
        );
      }
    });

    test("a local-zone value arrives in the session zone and round-trips", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      try {
        // In a transaction the broker keeps the session, and so its time zone.
        await adapter.beginTransaction();
        await adapter.query("SET TIME ZONE 'Asia/Seoul'");
        const [row] = await adapter.query(
          "SELECT TIMESTAMPLTZ'2020-01-02 03:04:05 +09:00' AS a, " +
            "DATETIMELTZ'2020-07-02 03:04:05.5 America/New_York' AS b",
        );
        const a = row?.a as ZonedDateTime;
        const b = row?.b as ZonedDateTime;
        assert.equal(a.type, "TIMESTAMPLTZ");
        assert.equal(String(a), "2020-01-02 03:04:05 Asia/Seoul KST");
        assert.equal(b.type, "DATETIMELTZ");
        assert.equal(String(b), "2020-07-02 16:04:05.500 Asia/Seoul KST");

        const [again] = await adapter.query(
          `SELECT ${a.type}'${a.toString()}' AS a, ${b.type}'${b.toString()}' AS b`,
        );
        assert.deepEqual({ ...(again?.a as ZonedDateTime) }, { ...a });
        assert.deepEqual({ ...(again?.b as ZonedDateTime) }, { ...b });
      } finally {
        await adapter.close();
      }
    });

    test("stored values, NULL and a collection read back exactly, with the type names in the columns", async () => {
      const client = createClient(TEST_CONFIG);
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, tstz TIMESTAMPTZ, tsltz TIMESTAMPLTZ, ` +
            "dttz DATETIMETZ, dtltz DATETIMELTZ, seq SEQUENCE OF TIMESTAMPTZ, j JSON)",
        );
        await client.query(
          `INSERT INTO ${TABLE} VALUES (1, TIMESTAMPTZ'2020-01-02 03:04:05 +09:00', ` +
            "TIMESTAMPLTZ'2020-01-02 03:04:05 +09:00', DATETIMETZ'2020-01-02 03:04:05.678 +09:00', " +
            "DATETIMELTZ'2020-01-02 03:04:05.678 +09:00', " +
            "{TIMESTAMPTZ'2020-01-02 03:04:05 +09:00', TIMESTAMPTZ'2020-07-02 03:04:05 -05:30'}, " +
            `'{"a":[1,2.5,null]}')`,
        );
        await client.query(`INSERT INTO ${TABLE} (id) VALUES (2)`);

        const { rows, columns } = await client.queryResult(`SELECT * FROM ${TABLE} ORDER BY id`);

        assert.deepEqual(
          columns.map((column) => column.type),
          ["INT", "TIMESTAMPTZ", "TIMESTAMPLTZ", "DATETIMETZ", "DATETIMELTZ", "SEQUENCE", "VARCHAR"],
        );
        const [first, second] = rows;
        assert.equal(String(first?.tstz), "2020-01-02 03:04:05 +09:00");
        assert.equal(String(first?.dttz), "2020-01-02 03:04:05.678 +09:00");
        for (const column of ["tsltz", "dtltz"] as const) {
          assert.ok(first?.[column] instanceof ZonedDateTime);
        }
        assert.deepEqual(
          (first?.seq as ZonedDateTime[]).map(String),
          ["2020-01-02 03:04:05 +09:00", "2020-07-02 03:04:05 -05:30"],
        );
        for (const column of [...COLUMNS, "seq", "j"]) {
          assert.equal(second?.[column], null, column);
        }

        // JSON is the server's text, not a parsed value, because below protocol 8 the
        // server sends wire type 2 (VARCHAR) instead of 34.
        assert.equal(first?.j, '{"a":[1,2.5,null]}');
        assert.deepEqual(JSON.parse(first?.j as string), { a: [1, 2.5, null] });
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    });

    for (const { type, literal, wireType, size } of [
      { type: "TIMESTAMPTZ", literal: "TIMESTAMPTZ'0000-00-00 00:00:00 +00:00'", wireType: 29, size: 19 },
      { type: "DATETIMETZ", literal: "DATETIMETZ'0000-00-00 00:00:00.000 +00:00'", wireType: 31, size: 21 },
    ]) {
      test(`a zero ${type} rejects with its column and type, and the session stays usable`, async () => {
        const adapter = new NativeCubridAdapter(TEST_CONFIG);
        await adapter.connect();
        const cas = (adapter as unknown as { cas: CASConnection }).cas;
        const generation = cas.connectionGeneration;

        try {
          await assert.rejects(adapter.query(`SELECT ${literal} AS zero_value, 'after' AS t`), (err: Error) => {
            assert.ok(err instanceof QueryError);
            assert.match(
              (err.cause as Error).message,
              new RegExp(`column "zero_value" \\(wire type ${wireType}, ${size} bytes\\)`),
            );
            return true;
          });

          assert.equal(cas.connectionGeneration, generation);
          assert.deepEqual(await adapter.query("SELECT 1 AS one"), [{ one: 1 }]);
        } finally {
          await adapter.close();
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Collections (#82)
  // -------------------------------------------------------------------------

  test("db.query() exposes an unsupported value by its name further down the cause chain", async () => {
    const client = createClient(TEST_CONFIG);
    try {
      await assert.rejects(
        client.query("SELECT DATETIME'0000-00-00 00:00:00' AS zeroed"),
        (error: Error) => {
          const failure = ((error.cause as Error).cause as Error);
          assert.equal(error.name, "QueryError");
          assert.equal(failure.name, "UnsupportedValueError");
          assert.match(failure.message, /column "zeroed" \(wire type 22, /);
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

    test("an empty top-level BIT value is an empty Buffer and SQL NULL stays null", async () => {
      const client = collectionClient();
      try {
        assert.deepEqual(
          await client.query(
            "SELECT X'' AS e, CAST(X'' AS BIT VARYING(8)) AS v, CAST(NULL AS BIT VARYING(8)) AS n, " +
              "X'0f' AS b, 'after' AS t",
          ),
          [{ e: Buffer.alloc(0), v: Buffer.alloc(0), n: null, b: Buffer.from([0x0f]), t: "after" }],
        );
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
    // Only the last row has a zero DATETIME, which has no JavaScript value. Ascending
    // order meets it in a FETCH reply, descending order in the first reply.
    const UNSUPPORTED_IN_FETCH = `SELECT id, zeroed FROM ${TABLE} ORDER BY id`;
    const UNSUPPORTED_IN_FIRST_REPLY = `SELECT id, zeroed FROM ${TABLE} ORDER BY id DESC`;
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
        return response && tamper(payload[0]!, response);
      };

      const releaseOnSession = cas.releaseOnSession.bind(cas);
      cas.releaseOnSession = async (generation, header, payload) => {
        const response = await releaseOnSession(generation, header, payload);
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
          `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, val VARCHAR(40), zeroed DATETIME)`,
        );
        await adapter.beginTransaction();
        for (let id = 0; id < ROW_COUNT; id += 1) {
          await adapter.query(`INSERT INTO ${TABLE} (id, val) VALUES (${id}, 'row ${id}')`);
        }
        await adapter.query(
          `UPDATE ${TABLE} SET zeroed = DATETIME'0000-00-00 00:00:00' ` +
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
        // The transaction has ended by now. A new session would accept the
        // release and close nothing, and fetchCode() below shows this one did.
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
      const sendAndRecvOnSession = trace.cas.sendAndRecvOnSession;
      trace.cas.sendAndRecvOnSession = async (generation, header, payload) => {
        if (payload[0] === CASFunctionCode.FETCH) {
          internals.socket.destroy();
        }
        return sendAndRecvOnSession(generation, header, payload);
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
          const sendAndRecvOnSession = cas.sendAndRecvOnSession.bind(cas);
          cas.sendAndRecvOnSession = (generation, header, payload) => {
            fetches += payload[0] === CASFunctionCode.FETCH ? 1 : 0;
            return sendAndRecvOnSession(generation, header, payload);
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

        // sendAndRecvOnSession() because sendAndRecv() would send CHECK_CAS once
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

  describe("autocommit statements on one session", () => {
    const TABLE = "cc_keep_session";

    function casOf(adapter: NativeCubridAdapter): CASConnection {
      return (adapter as unknown as { cas: CASConnection }).cas;
    }

    test("consecutive autocommit statements share one session and its state", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = casOf(adapter);
      const generation = cas.connectionGeneration;
      const sessionId = cas.sessionId;

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query("SET @cc_keep_session = 171");
        await adapter.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY)`);
        await adapter.query(`INSERT INTO ${TABLE} VALUES (1)`);
        await assert.rejects(adapter.query(`INSERT INTO ${TABLE} VALUES (1)`), ConstraintError);
        await adapter.query(`UPDATE ${TABLE} SET id = 2`);
        await adapter.ping();
        assert.deepEqual(await adapter.query(`SELECT id FROM ${TABLE}`), [{ id: 2 }]);
        await adapter.beginTransaction();
        await adapter.query(`DELETE FROM ${TABLE}`);
        await adapter.commit();
        assert.deepEqual(await adapter.query(`SELECT id FROM ${TABLE}`), []);

        // A variable is lost with its session, so this shows the server agrees.
        assert.deepEqual(await adapter.query("SELECT CAST(@cc_keep_session AS INT) AS kept"), [
          { kept: 171 },
        ]);
        assert.equal(cas.connectionGeneration, generation);
        assert.equal(cas.sessionId, sessionId);
      } finally {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
        await adapter.close();
      }
    });

    test("a large autocommit SELECT and the statements after it share one session", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = casOf(adapter);
      const generation = cas.connectionGeneration;

      try {
        await adapter.query("SELECT 1 FROM db_root");
        const rows = await adapter.query("SELECT a.class_name FROM db_class a, db_class b LIMIT 500");
        assert.equal(rows.length, 500);
        await adapter.query("SELECT 1 FROM db_root");
        await adapter.query("SELECT 1 FROM db_root");
        assert.equal(cas.connectionGeneration, generation);
      } finally {
        await adapter.close();
      }
    });

    test("a lock timeout set in autocommit applies to a later transaction", async () => {
      const holder = new NativeCubridAdapter(TEST_CONFIG);
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await holder.connect();
      await adapter.connect();
      let release: NodeJS.Timeout | undefined;

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, n INT)`);
        await adapter.query(`INSERT INTO ${TABLE} VALUES (1, 0)`);

        await holder.beginTransaction();
        await holder.query(`UPDATE ${TABLE} SET n = 1 WHERE id = 1`);

        await adapter.query("SET TRANSACTION LOCK TIMEOUT 1");
        await adapter.beginTransaction();

        // The lock is freed in time for a statement that ignored the setting to
        // finish, so the test ends either way and that statement fails it.
        release = setTimeout(() => void holder.rollback(), 6000);
        await assert.rejects(
          adapter.query(`UPDATE ${TABLE} SET n = 2 WHERE id = 1`),
          LockTimeoutError,
        );
      } finally {
        clearTimeout(release);
        await adapter.rollback().catch(() => {});
        await holder.rollback().catch(() => {});
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
        await adapter.close();
        await holder.close();
      }
    });

    test("execute() on a kept session never reports a value left by an earlier statement", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      await adapter.connect();
      const cas = casOf(adapter);
      const keyed = `${TABLE}_keyed`;
      const plain = `${TABLE}_plain`;
      const insertPlain = `INSERT INTO ${plain} VALUES (1)`;
      const insertKeyed = `INSERT INTO ${keyed} (n) VALUES (1)`;

      try {
        await adapter.query(`DROP TABLE IF EXISTS ${keyed}`);
        await adapter.query(`DROP TABLE IF EXISTS ${plain}`);
        await adapter.query(`CREATE TABLE ${keyed} (id INT AUTO_INCREMENT(100, 1) PRIMARY KEY, n INT)`);
        await adapter.query(`CREATE TABLE ${plain} (n INT)`);
        const generation = cas.connectionGeneration;

        assert.deepEqual(await adapter.execute(insertKeyed), { affectedRows: 1, lastInsertId: 100 });
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.query(insertKeyed);
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(insertKeyed), { affectedRows: 1, lastInsertId: 102 });
        await adapter.rollback();
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(insertKeyed), { affectedRows: 1, lastInsertId: 103 });
        await adapter.commit();
        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });
        await adapter.commit();

        await assert.rejects(adapter.execute(`INSERT INTO ${keyed} (id, n) VALUES (103, 1)`), ConstraintError);
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });

        await adapter.query(`REPLACE INTO ${keyed} (n) VALUES (1)`);
        assert.deepEqual(await adapter.execute(insertPlain), { affectedRows: 1 });
        assert.deepEqual(await adapter.execute(insertKeyed), { affectedRows: 1, lastInsertId: 105 });

        assert.equal(cas.connectionGeneration, generation);
      } finally {
        await adapter.rollback().catch(() => {});
        await adapter.query(`DROP TABLE IF EXISTS ${keyed}`).catch(() => {});
        await adapter.query(`DROP TABLE IF EXISTS ${plain}`).catch(() => {});
        await adapter.close();
      }
    });

    test("a session cut after an autocommit statement is replaced without running SQL twice", async () => {
      // A relay stands in for a CAS closing its socket, which a test cannot ask
      // of a shared broker.
      const sockets = new Set<Socket>();
      const relay = createServer((client) => {
        const upstream = netConnect(TEST_CONFIG.port, TEST_CONFIG.host);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        }
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
      const { port } = relay.address() as { port: number };
      const adapter = new NativeCubridAdapter({ ...TEST_CONFIG, port });
      const observer = new NativeCubridAdapter(TEST_CONFIG);

      try {
        await adapter.connect();
        await observer.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await observer.query(`CREATE TABLE ${TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, n INT)`);

        const cas = casOf(adapter);
        const generation = cas.connectionGeneration;
        await adapter.query(`INSERT INTO ${TABLE} (n) VALUES (1)`);
        await adapter.query(`INSERT INTO ${TABLE} (n) VALUES (2)`);
        assert.equal(cas.connectionGeneration, generation);

        for (const socket of sockets) {
          socket.destroy();
        }
        await adapter.query(`INSERT INTO ${TABLE} (n) VALUES (3)`);

        assert.equal(cas.connectionGeneration, generation + 1);
        assert.deepEqual(await observer.query(`SELECT n FROM ${TABLE} ORDER BY n`), [
          { n: 1 },
          { n: 2 },
          { n: 3 },
        ]);
      } finally {
        await observer.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
        await observer.close();
        await adapter.close();
        relay.close();
      }
    });
  });

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
     */
    async function deadlock(
      first: NativeCubridAdapter,
      second: NativeCubridAdapter,
      lockTimeoutSeconds?: number,
      beforeDeadlock: () => Promise<unknown> = async () => {},
    ): Promise<PromiseSettledResult<unknown>[]> {
      await first.beginTransaction();
      await second.beginTransaction();

      if (lockTimeoutSeconds !== undefined) {
        await first.query(`SET TRANSACTION LOCK TIMEOUT ${lockTimeoutSeconds}`);
        await second.query(`SET TRANSACTION LOCK TIMEOUT ${lockTimeoutSeconds}`);
      }

      await beforeDeadlock();
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
          client.query("SELECT DATETIME'0000-00-00 00:00:00' AS zeroed"),
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

    describe("after the server ended the transaction", () => {
      const FIRST_ROW = 201;
      const SECOND_ROW = 301;

      /** Each adapter writes a row, then they deadlock and one fails with `code`. */
      async function deadlockAfterWrites(
        first: NativeCubridAdapter,
        second: NativeCubridAdapter,
        code: number,
        lockTimeoutSeconds?: number,
      ) {
        const results = await deadlock(first, second, lockTimeoutSeconds, () =>
          Promise.all([
            first.query(`INSERT INTO ${ROWS} VALUES (${FIRST_ROW}, 'first', 0)`),
            second.query(`INSERT INTO ${ROWS} VALUES (${SECOND_ROW}, 'second', 0)`),
          ]),
        );
        const firstFailed = rejections(results.slice(0, 1)).some((error) => error.code === code);
        const secondFailed = rejections(results.slice(1)).some((error) => error.code === code);

        assert.ok(firstFailed !== secondFailed, `expected one ${code}`);
        return {
          victim: firstFailed ? first : second,
          survivor: firstFailed ? second : first,
          earlierRow: firstFailed ? FIRST_ROW : SECOND_ROW,
        };
      }

      async function committedRows(): Promise<number[]> {
        const reader = new NativeCubridAdapter(TEST_CONFIG);

        try {
          const rows = await reader.query<{ id: number }>(
            `SELECT id FROM ${ROWS} WHERE id > 200 ORDER BY id`,
          );
          return rows.map((row) => Number(row.id));
        } finally {
          await reader.close();
        }
      }

      async function removeRows(): Promise<void> {
        const cleaner = new NativeCubridAdapter(TEST_CONFIG);

        try {
          await cleaner.query(`DELETE FROM ${ROWS} WHERE id > 200`);
        } finally {
          await cleaner.close();
        }
      }

      async function assertFailsWithAbort(
        run: () => Promise<unknown>,
        type: new (...args: never[]) => Error,
      ): Promise<void> {
        const error = await failure<QueryError>(run);

        assert.ok(error instanceof type);
        assert.equal(error.code, -72);
        assert.equal(error.kind, "deadlock");
      }

      test("no statement commits alone after -72", async () => {
        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(first, second, -72);

          await assertFailsWithAbort(
            () => victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow + 1}, 'later', 0)`),
            DeadlockError,
          );
          await assertFailsWithAbort(() => victim.commit(), TransactionError);
          await survivor.rollback();

          assert.deepEqual(await committedRows(), []);
        });
        await removeRows();
      });

      test("rollback() acknowledges -72 and the same adapter can retry the work", async () => {
        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(first, second, -72);
          await assertFailsWithAbort(() => victim.query("SELECT 1 FROM db_root"), DeadlockError);

          await victim.rollback();
          await survivor.rollback();
          await victim.beginTransaction();
          await victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow}, 'retried', 0)`);
          await victim.commit();

          assert.deepEqual(await committedRows(), [earlierRow]);
        });
        await removeRows();
      });

      test("a transaction() callback that swallows -72 rejects and commits nothing", async () => {
        await withAdapters(async (first, second) => {
          let bothHoldLocks: () => void = () => undefined;
          let arrived = 0;
          const locksHeld = new Promise<void>((resolve) => {
            bothHoldLocks = resolve;
          });

          // Each callback writes a row, locks its own row, then asks for the other's.
          const contend = (adapter: NativeCubridAdapter, own: number, other: number, row: number) =>
            createClient({ ...TEST_CONFIG, connectionFactory: () => adapter }).transaction(
              async (tx) => {
                await tx.execute(`INSERT INTO ${ROWS} VALUES (${row}, 'row${row}', 0)`);
                await tx.execute(`UPDATE ${ROWS} SET n = n + 1 WHERE id = ${own}`);
                arrived += 1;
                if (arrived === 2) {
                  bothHoldLocks();
                }
                await locksHeld;
                await new Promise((resolve) => setTimeout(resolve, own === 1 ? 0 : 200));

                const updated = await tx
                  .execute(`UPDATE ${ROWS} SET n = n + 1 WHERE id = ${other}`)
                  .then(
                    () => true,
                    () => false,
                  );

                // The survivor gives its work back, so only the victim's outcome is tested.
                if (updated) {
                  await tx.rollback();
                }
              },
            );

          const results = await Promise.allSettled([
            contend(first, 1, 2, FIRST_ROW),
            contend(second, 2, 1, SECOND_ROW),
          ]);
          const failures = rejections(results);

          assert.equal(failures.length, 1);
          assert.ok(failures[0] instanceof TransactionError);
          assert.equal(failures[0].code, -72);
          assert.equal(failures[0].kind, "deadlock");
          assert.deepEqual(await committedRows(), []);
        });
        await removeRows();
      });

      test("-968 keeps the transaction, while a commit() rejected after -72 acknowledges it", async () => {
        // Each round has its own adapters because the lock timeout outlives a transaction.
        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(first, second, -968, 4);

          await victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow + 1}, 'kept', 0)`);
          await victim.commit();
          await survivor.rollback();

          assert.deepEqual(await committedRows(), [earlierRow, earlierRow + 1]);
        });
        await removeRows();

        await withAdapters(async (first, second) => {
          const { victim, survivor, earlierRow } = await deadlockAfterWrites(first, second, -72);
          await assertFailsWithAbort(() => victim.commit(), TransactionError);
          await survivor.rollback();

          // Acknowledged, so this statement runs in autocommit and commits by itself.
          await victim.query(`INSERT INTO ${ROWS} VALUES (${earlierRow}, 'autocommit', 0)`);

          assert.deepEqual(await committedRows(), [earlierRow]);
        });
        await removeRows();
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
  // execute(): affected rows and last insert ID
  // -------------------------------------------------------------------------

  describe("execute results", () => {
    const AUTO = "cc_exec_auto";
    const PLAIN = "cc_exec_plain";
    const BIG = "cc_exec_big";
    const FRESH_A = "cc_exec_fresh_a";
    const FRESH_B = "cc_exec_fresh_b";
    const ALL = [AUTO, PLAIN, BIG, FRESH_A, FRESH_B];

    test("create the tables", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        for (const table of ALL) {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        }
        await client.query(`CREATE TABLE ${AUTO} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
        await client.query(`CREATE TABLE ${PLAIN} (id INT, v INT)`);
        for (const table of [FRESH_A, FRESH_B]) {
          await client.query(`CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
        }
        await client.query(
          `CREATE TABLE ${BIG} (id BIGINT AUTO_INCREMENT(9007199254740993, 1) PRIMARY KEY, v INT)`,
        );
      } finally {
        await client.close();
      }
    });

    test("INSERT, UPDATE and DELETE report their row counts and the generated id", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        assert.deepEqual(await client.execute(`INSERT INTO ${AUTO} (v) VALUES (?)`, [10]), {
          affectedRows: 1,
          lastInsertId: 1,
        });
        // A multi-row INSERT reports the first id it generated (here 2, 3 and 4).
        assert.deepEqual(
          await client.execute(`INSERT INTO ${AUTO} (v) VALUES (11), (12), (13)`),
          { affectedRows: 3, lastInsertId: 2 },
        );
        assert.deepEqual(await client.execute(`UPDATE ${AUTO} SET v = v + 100 WHERE v > 10`), {
          affectedRows: 3,
        });
        assert.deepEqual(await client.execute(`UPDATE ${AUTO} SET v = 0 WHERE v = -1`), {
          affectedRows: 0,
        });
        assert.deepEqual(await client.execute(`DELETE FROM ${AUTO} WHERE v > 100`), {
          affectedRows: 3,
        });
        assert.deepEqual(await client.execute(`DELETE FROM ${AUTO} WHERE v = -1`), {
          affectedRows: 0,
        });
        // The next id continues after the deleted rows.
        assert.deepEqual(await client.execute(`INSERT INTO ${AUTO} (v) VALUES (20)`), {
          affectedRows: 1,
          lastInsertId: 5,
        });
        // The statements were committed, and query() still returns no rows for DML.
        // COUNT(*) is a number on 10.2 and 11.0 and a bigint from 11.2.
        const [counted] = await client.query<{ n: number | bigint }>(
          `SELECT COUNT(*) AS n FROM ${AUTO}`,
        );
        assert.equal(Number(counted?.n), 2);
        assert.deepEqual(await client.query(`INSERT INTO ${AUTO} (v) VALUES (30)`), []);
      } finally {
        await client.close();
      }
    });

    test("an INSERT into a table without AUTO_INCREMENT reports no id, not an earlier one", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const generated = await client.execute(`INSERT INTO ${AUTO} (v) VALUES (1)`);
        assert.equal(typeof generated.lastInsertId, "number");

        const plain = await client.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (1, 1), (2, 2)`);
        assert.deepEqual(plain, { affectedRows: 2 });
      } finally {
        await client.close();
      }
    });

    test("execute adds up the statements of a multi-statement string", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const result = await client.execute(
          `INSERT INTO ${PLAIN} (id, v) VALUES (10, 1); INSERT INTO ${PLAIN} (id, v) VALUES (11, 2), (12, 3)`,
        );
        assert.deepEqual(result, { affectedRows: 3 });
        assert.deepEqual(await client.execute(`DELETE FROM ${PLAIN} WHERE id >= 10`), {
          affectedRows: 3,
        });
      } finally {
        await client.close();
      }
    });

    test("execute reports 0 rows for DDL and for a SELECT", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        assert.deepEqual(await client.execute(`CREATE INDEX cc_exec_idx ON ${PLAIN} (v)`), {
          affectedRows: 0,
        });
        assert.deepEqual(await client.execute(`DROP INDEX cc_exec_idx ON ${PLAIN}`), {
          affectedRows: 0,
        });
        assert.deepEqual(await client.execute(`SELECT * FROM ${AUTO}`), { affectedRows: 0 });
      } finally {
        await client.close();
      }
    });

    test("execute returns a bigint when the id is beyond Number.MAX_SAFE_INTEGER", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        const result = await client.execute(`INSERT INTO ${BIG} (v) VALUES (1)`);
        assert.deepEqual(result, { affectedRows: 1, lastInsertId: 9007199254740993n });
      } finally {
        await client.close();
      }
    });

    test("a failing autocommit execute rolls back and leaves the connection usable", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await client.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (500, 1)`);
        await assert.rejects(
          () => client.execute(`INSERT INTO ${AUTO} (id, v) VALUES (1, 1)`),
          ConstraintError,
        );
        assert.deepEqual(await client.execute(`DELETE FROM ${PLAIN} WHERE id = 500`), {
          affectedRows: 1,
        });
      } finally {
        await client.close();
      }
    });

    test("an autocommit execute is visible to another connection at once", async () => {
      const writer = createClient(TEST_CONFIG);
      const reader = createClient(TEST_CONFIG);

      try {
        await writer.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (600, 6)`);
        assert.deepEqual(await reader.query(`SELECT v FROM ${PLAIN} WHERE id = 600`), [{ v: 6 }]);
        await writer.execute(`DELETE FROM ${PLAIN} WHERE id = 600`);
      } finally {
        await writer.close();
        await reader.close();
      }
    });

    test("tx.execute reports ids, repeats none and honors rollback", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await client.transaction(async (tx) => {
          const first = await tx.execute(`INSERT INTO ${AUTO} (v) VALUES (41)`);
          const second = await tx.execute(`INSERT INTO ${AUTO} (v) VALUES (42), (43)`);
          assert.equal(typeof first.lastInsertId, "number");
          assert.equal(Number(second.lastInsertId) > Number(first.lastInsertId), true);
          assert.equal(second.affectedRows, 2);

          // The server would answer with `second`'s id again for this INSERT.
          assert.deepEqual(await tx.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (700, 7)`), {
            affectedRows: 1,
          });
          assert.deepEqual(await tx.execute(`DELETE FROM ${PLAIN} WHERE id = 700`), {
            affectedRows: 1,
          });
        });

        const before = await client.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${AUTO}`);
        await assert.rejects(() =>
          client.transaction(async (tx) => {
            await tx.execute(`INSERT INTO ${AUTO} (v) VALUES (50)`);
            throw new Error("abort");
          }),
        );
        assert.deepEqual(
          await client.query(`SELECT COUNT(*) AS n FROM ${AUTO}`),
          before,
        );
      } finally {
        await client.close();
      }
    });

    test("an INSERT inside a transaction reports no id after an autocommit INSERT into another table", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);

      try {
        const inserted = await adapter.execute(`INSERT INTO ${AUTO} (v) VALUES (60)`);
        assert.equal(typeof inserted.lastInsertId, "number");

        await adapter.beginTransaction();
        assert.deepEqual(await adapter.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (800, 8)`), {
          affectedRows: 1,
        });
        await adapter.rollback();
      } finally {
        await adapter.close();
      }
    });

    test("tx.execute reports no id after a tx.query INSERT it cannot tell apart", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        await client.transaction(async (tx) => {
          // tx.query generates an id that nobody reads; the table without
          // AUTO_INCREMENT then sees the server still answering with it.
          assert.deepEqual(await tx.query(`INSERT INTO ${AUTO} (v) VALUES (70)`), []);
          assert.deepEqual(await tx.execute(`INSERT INTO ${PLAIN} (id, v) VALUES (900, 9)`), {
            affectedRows: 1,
          });
          // A different generated value is certainly this statement's.
          assert.deepEqual(await tx.execute(`INSERT INTO ${FRESH_A} (v) VALUES (1)`), {
            affectedRows: 1,
            lastInsertId: 1,
          });
          await tx.execute(`DELETE FROM ${PLAIN} WHERE id = 900`);
        });
      } finally {
        await client.close();
      }
    });

    test("tx.execute reports no id when two fresh tables generate the same number", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        // Restart both tables at 1.
        for (const table of [FRESH_A, FRESH_B]) {
          await client.execute(`DROP TABLE ${table}`);
          await client.execute(`CREATE TABLE ${table} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`);
        }
        await client.transaction(async (tx) => {
          // Both tables generate 1 and the server's answer is the same bytes
          // for each, so the second id cannot be told from the first's: no id.
          assert.deepEqual(await tx.execute(`INSERT INTO ${FRESH_A} (v) VALUES (1)`), {
            affectedRows: 1,
            lastInsertId: 1,
          });
          assert.deepEqual(await tx.execute(`INSERT INTO ${FRESH_B} (v) VALUES (1)`), {
            affectedRows: 1,
          });
        });
      } finally {
        await client.close();
      }
    });

    test("drop the tables", async () => {
      const client = createClient(TEST_CONFIG);

      try {
        for (const table of ALL) {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        }
      } finally {
        await client.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // BLOB and CLOB content
  // -------------------------------------------------------------------------

  describe("BLOB and CLOB columns", () => {
    const TABLE = "cc93_lob";

    /** More than one LOB_READ reply holds, which is 81908 bytes on all four versions. */
    const LARGE_BLOB = Buffer.alloc(250_000);
    for (let i = 0; i < LARGE_BLOB.length; i++) {
      LARGE_BLOB[i] = i % 251;
    }
    /** Three-byte characters after one ASCII byte, so a reply boundary splits one. */
    const LARGE_CLOB = `x${"\ud55c".repeat(100_000)}`;

    async function withLobTable(
      use: (client: ReturnType<typeof createClient>) => Promise<void>,
      options: { maxLobBytes?: number } = {},
    ): Promise<void> {
      const client = createClient({ ...TEST_CONFIG, ...options });
      try {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, b BLOB, c CLOB)`);
        await use(client);
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await client.close();
      }
    }

    const causes = (error: unknown): string => {
      const messages: string[] = [];
      for (let e = error; e instanceof Error; e = e.cause) {
        messages.push(`${e.name}: ${e.message}`);
      }
      return messages.join(" | ");
    };

    test("content, empty values and NULL read back as written", async () => {
      await withLobTable(async (client) => {
        await client.query(`INSERT INTO ${TABLE} VALUES (?, ?, ?)`, [
          1,
          Buffer.from([0, 1, 2, 255]),
          "hello \ud55c\uae00",
        ]);
        await client.query(`INSERT INTO ${TABLE} VALUES (2, X'', '')`);
        await client.query(`INSERT INTO ${TABLE} VALUES (3, NULL, NULL)`);

        assert.deepEqual(await client.query(`SELECT id, b, c FROM ${TABLE} ORDER BY id`), [
          { id: 1, b: Buffer.from([0, 1, 2, 255]), c: "hello \ud55c\uae00" },
          { id: 2, b: Buffer.alloc(0), c: "" },
          { id: 3, b: null, c: null },
        ]);
      });
    });

    test("content over several LOB_READ replies is complete, split characters included", async () => {
      await withLobTable(async (client) => {
        await client.query(`INSERT INTO ${TABLE} VALUES (?, ?, ?)`, [1, LARGE_BLOB, LARGE_CLOB]);

        const [row] = await client.query<{ b: Buffer; c: string }>(
          `SELECT b, c FROM ${TABLE}`,
        );

        assert.ok(LARGE_BLOB.equals(row!.b));
        assert.equal(row!.c, LARGE_CLOB);
      });
    });

    test("rows delivered by FETCH load too, and overlapping queries take their turns", async () => {
      await withLobTable(async (client) => {
        const rows = Array.from({ length: 150 }, (_, i) => `(${i}, X'0a', 'v${i}')`);
        await client.query(`INSERT INTO ${TABLE} VALUES ${rows.join(",")}`);

        const results = await Promise.all(
          [0, 1, 2, 3].map(() => client.query<{ id: number; c: string }>(
            `SELECT id, b, c FROM ${TABLE} ORDER BY id`,
          )),
        );

        for (const result of results) {
          assert.equal(result.length, 150);
          assert.deepEqual(result[149], { id: 149, b: Buffer.from([10]), c: "v149" });
        }
      });
    });

    test("over the limit, the query rejects by name and the connection stays usable", async () => {
      await withLobTable(async (client) => {
        await client.query(`INSERT INTO ${TABLE} VALUES (1, ?, 'short')`, [LARGE_BLOB]);

        await assert.rejects(
          () => client.query(`SELECT b FROM ${TABLE}`),
          (error: Error) => {
            assert.ok(error instanceof QueryError);
            assert.match(
              causes(error),
              /UnsupportedValueError: CUBRID column "b" .* 250000 bytes, over the maxLobBytes limit of 100000/,
            );
            return true;
          },
        );

        // Under the limit on the same connection, in the same table.
        assert.deepEqual(await client.query(`SELECT c FROM ${TABLE}`), [{ c: "short" }]);
      }, { maxLobBytes: 100_000 });
    });

    test("over the limit in a transaction, the transaction stays open", async () => {
      await withLobTable(async (client) => {
        await client.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${TABLE} VALUES (1, X'0102', 'kept')`);
          await assert.rejects(() => tx.query(`SELECT b FROM ${TABLE}`), TransactionError);
          await tx.query(`INSERT INTO ${TABLE} VALUES (2, NULL, 'too')`);
        });

        // Both rows committed; `c` is left out because it is over this client's limit.
        assert.deepEqual(await client.query(`SELECT id FROM ${TABLE} ORDER BY id`), [
          { id: 1 },
          { id: 2 },
        ]);
      }, { maxLobBytes: 1 });
    });

    test("a transaction reads its own uncommitted row, and a rollback removes it", async () => {
      await withLobTable(async (client) => {
        // Read inside and asserted outside: a failed assertion in the callback
        // would itself roll back and look like the planned failure.
        let seen: unknown;
        await assert.rejects(
          () => client.transaction(async (tx) => {
            await tx.query(`INSERT INTO ${TABLE} VALUES (1, X'0a0b', 'uncommitted')`);
            seen = await tx.query(`SELECT b, c FROM ${TABLE}`);
            throw new Error("roll it back");
          }),
          TransactionError,
        );

        assert.deepEqual(seen, [{ b: Buffer.from([10, 11]), c: "uncommitted" }]);
        assert.deepEqual(await client.query(`SELECT b FROM ${TABLE}`), []);
      });
    });

    test("a LOB made by the statement reads in a transaction, not after autocommit removed it", async () => {
      await withLobTable(async (client) => {
        await client.transaction(async (tx) => {
          assert.deepEqual(await tx.query("SELECT CHAR_TO_CLOB('temp') AS c"), [{ c: "temp" }]);
        });

        // The temporary file is already deleted when the autocommit reply arrives.
        await assert.rejects(
          () => client.query("SELECT CHAR_TO_CLOB('temp') AS c"),
          (error: Error) => {
            assert.ok(error instanceof QueryError);
            assert.match(causes(error), /CUBRID LOB read failed \(-1020\)/);
            return true;
          },
        );
        assert.deepEqual(await client.query("SELECT 'after' AS t"), [{ t: "after" }]);
      });
    });

    test("a CLOB that is not UTF-8 rejects by name and CLOB_TO_CHAR still reads it", async () => {
      await withLobTable(async (client) => {
        // The test databases use the iso88591 charset, where CHR(233) is one byte.
        await client.query(`INSERT INTO ${TABLE} VALUES (1, NULL, CHAR_TO_CLOB(CHR(233)))`);

        await assert.rejects(
          () => client.query(`SELECT c FROM ${TABLE}`),
          (error: Error) => {
            assert.match(causes(error), /UnsupportedValueError: CUBRID CLOB column "c" is not valid UTF-8/);
            return true;
          },
        );

        const [row] = await client.query<{ text: string }>(
          `SELECT CLOB_TO_CHAR(c) AS text FROM ${TABLE}`,
        );
        assert.equal(typeof row!.text, "string");
      });
    });

    test("columns aliased __proto__ stay ordinary columns, LOBs included", async () => {
      await withLobTable(async (client) => {
        await client.query(`INSERT INTO ${TABLE} VALUES (1, X'0a0b', 'c')`);

        const [lob] = await client.query(`SELECT b AS "__proto__" FROM ${TABLE}`);
        const [scalar] = await client.query(`SELECT 7 AS "__proto__", 'after' AS t`);
        const [nullValue] = await client.query(`SELECT NULL AS "__proto__", 'after' AS t`);

        assert.deepEqual(Object.getOwnPropertyDescriptor(lob, "__proto__")?.value, Buffer.from([10, 11]));
        assert.equal(Object.getOwnPropertyDescriptor(scalar, "__proto__")?.value, 7);
        assert.equal(Object.getOwnPropertyDescriptor(nullValue, "__proto__")?.value, null);
        assert.deepEqual(Object.keys(nullValue!), ["__proto__", "t"]);
        for (const row of [lob, scalar, nullValue]) {
          assert.equal(Object.getPrototypeOf(row), Object.prototype);
        }
      });
    });

    test("an autocommit read does not leave the session in a transaction", async () => {
      const adapter = new NativeCubridAdapter(TEST_CONFIG);
      try {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
        await adapter.query(`CREATE TABLE ${TABLE} (id INT PRIMARY KEY, b BLOB, c CLOB)`);
        await adapter.query(`INSERT INTO ${TABLE} VALUES (1, X'0a', 'c')`);

        assert.deepEqual(await adapter.query(`SELECT b FROM ${TABLE}`), [{ b: Buffer.from([10]) }]);

        // CAS_INFO[0] is 1 while a transaction is open, and LOB_READ opens one.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.equal((adapter as any).cas.casInfo[0], 0);
      } finally {
        await adapter.query(`DROP TABLE IF EXISTS ${TABLE}`);
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

// ---------------------------------------------------------------------------
// maxConnectionRetryCount against a live broker, reached through a TCP relay
// that starts late and counts connections.
// ---------------------------------------------------------------------------

describe("Integration: maxConnectionRetryCount", { skip: !available }, () => {
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  function relay(port: number, counter: { connections: number }): Promise<Server> {
    const server = createServer((client) => {
      counter.connections += 1;
      const upstream = netConnect(TEST_CONFIG.port, TEST_CONFIG.host);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
  }

  test("a client retries until the broker answers, then queries normally", async () => {
    const port = await freePort();
    const counter = { connections: 0 };
    let server: Server | undefined;
    const late = setTimeout(() => void relay(port, counter).then((s) => (server = s)), 300);
    const client = createClient({ ...TEST_CONFIG, port, maxConnectionRetryCount: 6 });

    try {
      const rows = await client.query<{ n: number }>("SELECT 1 AS n FROM db_root");
      assert.equal(rows[0]?.n, 1);
      assert.equal(counter.connections, 1);
    } finally {
      clearTimeout(late);
      await client.close();
      server?.close();
    }
  });

  test("wrong credentials fail at once without a retry", async () => {
    const port = await freePort();
    const counter = { connections: 0 };
    const server = await relay(port, counter);
    const client = createClient({
      ...TEST_CONFIG,
      port,
      password: "definitely-wrong",
      maxConnectionRetryCount: 5,
    });

    try {
      await assert.rejects(() => client.query("SELECT 1 FROM db_root"), QueryError);
      assert.equal(counter.connections, 1);
    } finally {
      await client.close();
      server.close();
    }
  });
});
