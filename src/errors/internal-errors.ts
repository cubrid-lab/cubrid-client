import { definedErrorDetails } from "./error-details.js";
import type { CubridErrorDetails, CubridErrorKind } from "./error-details.js";

/** The leading int of a CAS error reply: CAS_ERROR_INDICATOR and DBMS_ERROR_INDICATOR. */
const ORIGINS: ReadonlyMap<number, "server" | "cas"> = new Map([
  [-1, "cas"],
  [-2, "server"],
]);

/**
 * Server error codes that have a kind. Every entry was reported by a live
 * 10.2, 11.0, 11.2 and 11.4 server unless its comment says otherwise. Codes
 * that only the CUBRID headers name, such as -73 and -76, stay unclassified.
 */
const SERVER_ERROR_KINDS: ReadonlyMap<number, CubridErrorKind> = new Map([
  [-4, "interrupted"], // ER_INTERRUPTED: cubrid killtran on a running statement.
  [-72, "deadlock"], // ER_LK_UNILATERALLY_ABORTED: the whole transaction was rolled back.
  [-74, "lock-timeout"], // ER_LK_OBJECT_TIMEOUT_CLASS_MSG: waiting on a table lock.
  [-75, "lock-timeout"], // ER_LK_OBJECT_TIMEOUT_CLASSOF_MSG: waiting on a row lock.
  [-111, "connection-lost"], // ER_TM_SERVER_DOWN_UNILATERALLY_ABORTED: cub_server died.
  [-165, "authentication"], // ER_AU_INVALID_USER
  [-171, "authentication"], // ER_AU_INVALID_PASSWORD
  [-493, "syntax"], // ER_PT_SYNTAX, also used for an unknown table.
  [-494, "semantic"], // ER_PT_SEMANTIC
  [-631, "not-null-violation"], // ER_NULL_CONSTRAINT_VIOLATION
  [-670, "unique-violation"], // ER_BTREE_UNIQUE_FAILED
  [-886, "unique-violation"], // ER_UNIQUE_VIOLATION_WITHKEY: print_key_value_on_unique_error=yes.
  [-922, "foreign-key-violation"], // ER_FK_INVALID: no matching parent row.
  [-924, "foreign-key-violation"], // ER_FK_RESTRICT: a child row refers to this one.
  [-967, "deadlock"], // ER_LK_OBJECT_DL_TIMEOUT_CLASS_MSG: finite lock timeout, table lock.
  [-968, "deadlock"], // ER_LK_OBJECT_DL_TIMEOUT_CLASSOF_MSG: finite lock timeout, row lock.
  [-1284, "foreign-key-violation"], // ER_TRUNCATE_PK_REFERRED: not defined by 10.2 or 11.0.
]);

/**
 * A CAS error reply. The first int of the reply says who assigned the code, and
 * only database server codes are classified. This driver does not declare
 * BROKER_RENEWED_ERROR_CODE, so the CAS shifts its own codes by 9000 into a range
 * that overlaps them: -1012 is CAS_ER_NO_MORE_DATA from the CAS, and
 * ER_CREATE_AS_SELECT_NULL_TYPE from the server.
 */
export interface CasReplyError extends Readonly<CubridErrorDetails> {}

export class CasReplyError extends Error {
  constructor(message: string, indicator: number, code: number) {
    super(message);

    const origin = ORIGINS.get(indicator);
    const kind = origin === "server" ? SERVER_ERROR_KINDS.get(code) : undefined;
    Object.assign(this, definedErrorDetails({ code, ...(origin && { origin }), ...(kind && { kind }) }));
  }
}

/** The socket to the CAS went away, or the session that held a transaction is gone. */
export class ConnectionLostError extends Error {
  readonly kind: CubridErrorKind = "connection-lost";
}
