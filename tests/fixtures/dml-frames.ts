/**
 * Replies to DML statements captured byte for byte from live brokers.
 *
 * Each `sql` ran in autocommit mode against a table created with
 * `CREATE TABLE c_ai (id INT AUTO_INCREMENT PRIMARY KEY, v INT)` on the
 * cubrid/cubrid:10.2, 11.0, 11.2 and 11.4 images, through a raw socket client
 * speaking protocol version 7. The four servers sent identical bytes for every
 * frame. They are literal bytes, never produced by the decoder under test. The
 * `lastInsertId*` frames answer GET_LAST_INSERT_ID (function code 40) sent in
 * the same session before the transaction ended; the connection's own CAS_INFO
 * is not part of a frame.
 */
export interface DmlFrame {
  sql: string;
  hex: string;
}

export const DML_FRAMES = {
  insertOneRow: {
    sql: "INSERT INTO c_ai (v) VALUES (10)",
    hex:
      "00000001ffffffff14000000000000000000000000010000000001140000000100000000000000000000" +
      "00000000000000fffffffe",
  },
  insertThreeRows: {
    sql: "INSERT INTO c_ai (v) VALUES (11),(12),(13)",
    hex:
      "00000001ffffffff14000000000000000000000000030000000001140000000300000000000000000000" +
      "00000000000000fffffffe",
  },
  updateThreeRows: {
    sql: "UPDATE c_ai SET v=v+1 WHERE v>10",
    hex:
      "00000001ffffffff16000000000000000000000000030000000001160000000300000000000000000000" +
      "00000000000000fffffffe",
  },
  updateNoMatch: {
    sql: "UPDATE c_ai SET v=1 WHERE v=999",
    hex:
      "00000001ffffffff16000000000000000000000000000000000001160000000000000000000000000000" +
      "00000000000000fffffffe",
  },
  deleteThreeRows: {
    sql: "DELETE FROM c_ai WHERE v>11",
    hex:
      "00000001ffffffff17000000000000000000000000030000000001170000000300000000000000000000" +
      "00000000000000fffffffe",
  },
  createTable: {
    sql: "CREATE TABLE c_ai (id INT AUTO_INCREMENT PRIMARY KEY, v INT)",
    hex:
      "00000001ffffffff04000000000000000000000000000000000001040000000000000000000000000000" +
      "00000000000000fffffffe",
  },
  twoInserts: {
    sql: "INSERT INTO c_ai (v) VALUES (1); INSERT INTO c_ai (v) VALUES (2),(3)",
    hex:
      "00000001ffffffff14000000000000000000000000010000000002140000000100000000000000000000" +
      "00000000000014000000020000000000000000000000000000000001ffffffff14000000000000000000" +
      "fffffffe",
  },
} satisfies Record<string, DmlFrame>;

/**
 * GET_LAST_INSERT_ID (function code 40) replies, captured the same way but in a
 * session with autocommit off, because an autocommit statement ends its
 * transaction and the server then answers with the size -1 below: after `INSERT ... VALUES (10)` into an empty
 * AUTO_INCREMENT table (the value 1, as a two-byte type header 0x83 0x07 and
 * the text "1"), after a three-row INSERT (2, the first generated value), and
 * when the session holds none (a size of -1).
 */
export const LAST_INSERT_ID_FRAMES = {
  one: "000000000000000483073100",
  firstOfThreeRows: "000000000000000483073200",
  none: "00000000ffffffff",
} as const;
