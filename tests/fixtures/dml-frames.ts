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

/**
 * Replies to PREPARE (function code 2) and EXECUTE (function code 3) captured byte
 * for byte through a raw socket client speaking protocol version 7, with
 * EXECUTE_QUERY_ALL. They are literal bytes, never produced by the decoder under
 * test. These came from cubrid/cubrid:11.4; 11.0 and 11.2 sent the same bytes for
 * every frame here. 10.2 differs only in the type a text cell states, kept below
 * as `executeUntypedText102`.
 */
export const PREPARED_FRAMES = {
  /** `SELECT ? AS v`: the column has type NULL at PREPARE, as the marker has no type yet. */
  prepareUntypedMarker:
    "00000001ffffffff1500000001000000000180000000000000000000000276" +
    "000000000100000000010000000000010000000000000000",
  /** The cell of an INT bound to it: size 6, header 0x83 0x08, then the value 7. */
  executeUntypedInt:
    "00000001000000000115000000010000000000000000000000000000000000fffffffe" +
    "00000000000000010000000100000000000000000000000683080000000701",
  /** The cell of the text "ab": size 5, header 0x83 0x01, then "ab" and its NUL. */
  executeUntypedText:
    "00000001000000000115000000010000000000000000000000000000000000fffffffe" +
    "000000000000000100000001000000000000000000000005830161620001",
  /** The same reply from 10.2, whose header states STRING (0x02) rather than CHAR (0x01). */
  executeUntypedText102:
    "00000001000000000115000000010000000000000000000000000000000000fffffffe" +
    "000000000000000100000001000000000000000000000005830261620001",
  executeUntypedNull:
    "00000001000000000115000000010000000000000000000000000000000000fffffffe" +
    "0000000000000001000000010000000000000000ffffffff01",
  /** `SELECT 1 AS a; SELECT 2 AS b` */
  prepareMultiSelect:
    "00000001ffffffff15000000000000000001800800000000000a0000000261" +
    "000000000100000000010000000000010000000000000000",
  /** Two results, then includes_column_info 1 and a statement description before the shard id. */
  executeMultiSelect:
    "00000001000000000215000000010000000000000000000000000000000015000000010000" +
    "000000000000000000000000000001ffffffff15000000000000000001800800000000000a" +
    "0000000261000000000100000000010000000000010000000000000000fffffffe" +
    "0000000000000001000000010000000000000000000000040000000101",
  /** `SELEC 1`: a server error with code -493. */
  prepareSyntaxError:
    "fffffffefffffe1353796e7461783a20496e206c696e6520312c20636f6c756d6e2031206265666f72" +
    "6520272031270a53796e746178206572726f723a20756e6578706563746564202753454c4543272c20" +
    "657870656374696e672053454c454354206f722056414c5545206f722056414c554553206f72202728272000",
  /** `SELECT CAST(? AS INT) AS v` bound to "abc": the server rejects the value at EXECUTE. */
  executeCoercionError:
    "fffffffefffffe1253656d616e7469633a2043616e6e6f7420636f6572636520686f73742076617220" +
    "746f207479706520696e74656765722e2000",
} as const;
