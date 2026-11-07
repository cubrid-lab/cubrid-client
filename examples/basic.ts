import { createClient } from "../src/index.js";

async function main(): Promise<void> {
  const db = createClient({
    host: "localhost",
    database: "demodb",
    user: "dba",
  });

  const rows = await db.query("SELECT * FROM athlete");
  console.log(rows);

  // transaction() commits when the callback resolves and rolls back when it
  // throws. tx.rollback() abandons the work without an error; after it, tx
  // rejects every call and the client does not commit.
  const updated = await db.transaction(async (tx) => {
    await tx.query("UPDATE athlete SET nation_code = ? WHERE code = ?", ["KOR", 10999]);
    const changed = await tx.query("SELECT code FROM athlete WHERE code = ? AND nation_code = ?", [
      10999,
      "KOR",
    ]);

    if (changed.length === 0) {
      await tx.rollback();
      return false;
    }

    return true;
  });
  console.log(updated);

  await db.close();
}

void main();
