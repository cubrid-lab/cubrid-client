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
 * GET_GENERATED_KEYS (function code 34) replies, captured byte for byte through a
 * raw socket client speaking protocol version 7 after a PREPARE_AND_EXECUTE with
 * EXECUTE_QUERY_ALL | EXECUTE_RETURN_GENERATED_KEYS (0x42) and autocommit off,
 * before END_TRAN. They are literal bytes, never produced by the decoder under
 * test. These came from cubrid/cubrid:11.4 (11.4.6.1963); 11.0.16 and 11.2.9 sent
 * the same bytes for every frame, and 10.2.18 differs only in the 8-byte OID of
 * each row, kept below as `insertOneRow102`. The PREPARE_AND_EXECUTE replies with
 * the flag are the same bytes as `DML_FRAMES.insertOneRow` and `insertThreeRows`.
 */
export const GENERATED_KEYS_FRAMES = {
  /** `INSERT INTO k_ai (v) VALUES (10)` into an empty table: INT column `id`, value 1. */
  insertOneRow:
    "00000000150000000101000000010800000000000a0000000369640000000001000000010000000000000000" +
    "0000000400000001",
  /** The same reply from 10.2, which fills in the row's OID. */
  insertOneRow102:
    "00000000150000000101000000010800000000000a00000003696400000000010000000100000d81001a0000" +
    "0000000400000001",
  /** A three-row INSERT: one row per generated value, 2, 3 and 4. */
  insertThreeRows:
    "00000000150000000301000000010800000000000a0000000369640000000003000000010000000000000000" +
    "0000000400000002000000020000000000000000000000040000000300000003000000000000000000000004" +
    "00000004",
  /** An INSERT into a table without AUTO_INCREMENT: no column and no row. */
  noAutoIncrement: "000000001500000000010000000000000000",
  /** `INSERT INTO k_ai (id, v) VALUES (100, 1)`: a supplied key is not a generated one. */
  explicitKey: "000000001500000000010000000000000000",
  /** A BIGINT column at 2^53 - 1 (Number.MAX_SAFE_INTEGER). */
  bigintMaxSafe:
    "0000000015000000010100000001150000000000130000000369640000000001000000010000000000000000" +
    "00000008001fffffffffffff",
  /** The next value of that column, 2^53. */
  bigintBeyondSafe:
    "0000000015000000010100000001150000000000130000000369640000000001000000010000000000000000" +
    "000000080020000000000000",
  /** A SMALLINT column starting at -32768. */
  smallint:
    "0000000015000000010100000001090000000000050000000369640000000001000000010000000000000000" +
    "000000028000",
  /** A NUMERIC(20,0) column at 12345678901234567890, sent as text. */
  numeric:
    "0000000015000000010100000001070000000000140000000369640000000001000000010000000000000000" +
    "00000015313233343536373839303132333435363738393000",
  /** A table with two AUTO_INCREMENT columns, `a` = 1 and `b` = 100. */
  twoColumns:
    "00000000150000000101000000020800000000000a0000000261000800000000000a00000002620000000001" +
    "00000001000000000000000000000004000000010000000400000064",
  /** Asked after an UPDATE: response code -2, error code 0. */
  afterUpdate: "fffffffe000000004e6f206572726f72206d65737361676520617661696c61626c652e00",
  /** Asked after CLOSE_REQ_HANDLE: response code -1, CAS error -1006 (CAS_ER_SRV_HANDLE). */
  closedHandle: "fffffffffffffc1200",
} as const;

/**
 * PREPARE and EXECUTE (with 0x42) replies for `INSERT INTO k_ai (v) VALUES (?)`
 * bound to 30, and its GET_GENERATED_KEYS reply (value 6), captured as above;
 * the same bytes on 10.2 to 11.4 except the OID of the 10.2 key row.
 */
export const PREPARED_GENERATED_KEYS_FRAMES = {
  prepare: "00000001ffffffff14000000010000000000",
  execute: "00000001000000000114000000010000000000000000000000000000000000fffffffe",
  keys:
    "00000000150000000101000000010800000000000a0000000369640000000001000000010000000000000000" +
    "0000000400000006",
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

/**
 * EXECUTE_ARRAY (function code 21) frames, with the PREPARE replies they follow,
 * captured byte for byte from cubrid/cubrid:11.4 and 10.2 through a raw socket
 * client speaking protocol version 7, on a table created with
 * `CREATE TABLE c_em (id INT PRIMARY KEY, v VARCHAR(20))`. Both servers sent
 * identical bytes for every frame except two: the text of the -670 message and
 * the table name in the SELECT metadata, which 10.2 does not qualify with the
 * owner. The 10.2 duplicate-key reply is kept as `insertMiddleDuplicate102`.
 * They are literal bytes, never produced by the code under test.
 */
export const EXECUTE_ARRAY_FRAMES = {
  /** `INSERT INTO c_em (id, v) VALUES (?, ?)`: handle 3, INSERT (0x14), two markers. */
  prepareInsert: "00000003ffffffff14000000020000000000",
  /** The request that ran `[[1, "a"], [2, "b"], [3, "c"]]` on handle 3: function code 21,
   * the handle, query timeout 0, autocommit 0, then one (type, value) pair per marker per set. */
  insertThreeRequest:
    "150000000400000003000000040000000000000001000000000108000000040000000100000001010000" +
    "000261000000000108000000040000000200000001010000000262000000000108000000040000000300" +
    "00000101000000026300",
  /** Result code 0, three sets, each 1 row and an 8-byte OID, then the shard id. */
  insertThree:
    "000000000000000300000001000000000000000000000001000000000000000000000001000000000000" +
    "0000fffffffe",
  /** `[[4, "d"], [5, "e"]]`: two sets of one row each. */
  insertTwo: "0000000000000002000000010000000000000000000000010000000000000000fffffffe",
  /** `[[6, "f"], [1, "dup"], [7, "g"]]`: the second set hits the primary key. Its entry is
   * the DBMS indicator -2, code -670 and the message; the server went on and ran the third set. */
  insertMiddleDuplicate:
    "0000000000000003000000010000000000000000fffffffefffffd62000000aa4f7065726174696f6e20" +
    "776f756c64206861766520636175736564206f6e65206f72206d6f726520756e6971756520636f6e7374" +
    "7261696e742076696f6c6174696f6e732e20494e44455820706b5f635f656d5f696428422b747265653a" +
    "20307c343238387c3432383929204f4e20434c415353206462612e635f656d28434c4153535f4f49443a" +
    "20307c3139377c39292e206b65793a2031284f49443a20307c343335337c37292e000000000100000000" +
    "00000000fffffffe",
  /** The same reply from 10.2: only the message text differs. */
  insertMiddleDuplicate102:
    "0000000000000003000000010000000000000000fffffffefffffd62000000a74f7065726174696f6e20" +
    "776f756c64206861766520636175736564206f6e65206f72206d6f726520756e6971756520636f6e7374" +
    "7261696e742076696f6c6174696f6e732e20494e44455820706b5f635f656d5f696428422b747265653a" +
    "20307c333339327c3333393329204f4e20434c41535320635f656d28434c4153535f4f49443a20307c32" +
    "30327c36292e206b65793a2031284f49443a20307c333435377c3132292e000000000100000000000000" +
    "00fffffffe",
  /** `UPDATE c_em SET v = ? WHERE id > ?`: UPDATE (0x16), two markers. */
  prepareUpdate: "00000003ffffffff16000000020000000000",
  /** `[["x", 3], ["y", 99]]` over ids 1 to 5: 2 rows, then 0 rows. */
  updateTwoSets: "0000000000000002000000020000000000000000000000000000000000000000fffffffe",
  /** `SELECT v FROM c_em WHERE id = ?`: SELECT (0x15), one marker. */
  prepareSelect:
    "00000003ffffffff15000000010000000001830200000000001400000002760000000001000000000964" +
    "62612e635f656d0000000000054e554c4c0000000000000000",
  /** `INSERT INTO c_em (id, v) VALUES (100, 'z')`: no marker. EXECUTE_ARRAY on it runs nothing
   * and reports zero sets. */
  prepareNoMarker: "00000003ffffffff14000000000000000000",
} as const;
