import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../src/client/create-client.js";
import { createPool } from "../src/client/pool.js";
import type { ConnectionLike, TransactionClient } from "../src/index.js";

// Type-level check, enforced by `npm run typecheck`: a 1.x implementation of
// TransactionClient has no queryResult(), and must keep compiling.
const minimalTransaction: TransactionClient = {
  async query() {
    return [];
  },
  async commit() {},
  async rollback() {},
};

test("a minimal TransactionClient implementation still compiles and works", async () => {
  assert.deepEqual(await minimalTransaction.query("SELECT 1"), []);
});

test("a transaction callback written against TransactionClient is still accepted", async () => {
  const db = createClient({
    host: "127.0.0.1",
    database: "d",
    user: "u",
    connectionFactory: () => ({
      async connect() {},
      async query() {
        return [];
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      async close() {},
    }),
  });
  const callback = async (tx: TransactionClient): Promise<number> =>
    (await tx.query("SELECT 1")).length;

  assert.equal(await db.transaction(callback), 0);
});

test("a 1.x TransactionClient needs no executeMany", () => {
  // Type-level check: executeMany must not become mandatory.
  assert.equal("executeMany" in minimalTransaction, false);
});

test("a 1.x TransactionClient has no prepared methods and needs none", () => {
  // Type-level check: the prepared methods must not become mandatory.
  assert.equal("queryPrepared" in minimalTransaction, false);
});

// #292: `timezone` was added to the transaction()'s tx, not to TransactionClient
// or ConnectionLike, so 1.x callbacks and connection doubles keep compiling.

/** A 1.x connection double with no `timezone`. */
class PlainConnection implements ConnectionLike {
  async connect() {}
  async query() {
    return [];
  }
  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  async close() {}
}

/** A 1.x connection double whose own `timezone` is any string, such as an IANA name. */
class NamedZoneConnection extends PlainConnection implements ConnectionLike {
  public timezone: string = "Asia/Seoul";
}

/** A 1.x connection double with a private `timezone`. */
class PrivateZoneConnection extends PlainConnection implements ConnectionLike {
  private readonly timezone = 9;
  offset(): number {
    return this.timezone;
  }
}

test("#292: a TransactionClient callback still compiles on client and pool transaction()", async () => {
  const callback = async (tx: TransactionClient): Promise<number> =>
    (await tx.query("SELECT 1")).length;
  const options = { host: "127.0.0.1", database: "d", user: "u" };
  const db = createClient({ ...options, connectionFactory: () => new PlainConnection() });
  const pool = createPool({ ...options, connectionFactory: () => new PlainConnection() });
  assert.equal(await db.transaction(callback), 0);
  assert.equal(await pool.transaction(callback), 0);
  await db.close();
  await pool.close();
});

test("#292: ConnectionLike doubles with no, a string or a private timezone still compile", async () => {
  const doubles: ConnectionLike[] = [
    new PlainConnection(),
    new NamedZoneConnection(),
    new PrivateZoneConnection(),
  ];
  for (const connection of doubles) {
    const db = createClient({
      host: "127.0.0.1",
      database: "d",
      user: "u",
      timezone: "utc",
      connectionFactory: () => connection,
    });
    // None of them is "local" or "utc", so the configured zone is reported.
    assert.equal(await db.transaction(async (tx) => tx.timezone), "utc");
    await db.close();
  }
});
