import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../src/client/create-client.js";
import type { TransactionClient } from "../src/index.js";

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
