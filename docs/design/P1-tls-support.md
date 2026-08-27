# Design: TLS/SSL Support for cubrid-client (P1)

> Status: **APPROVED — Oracle-reviewed, user-approved. Implemented in `feat/tls-support`.**
> Unit-tested against a mock SSL broker. Live `SSL=ON` CUBRID broker validation is the deferred release gate before this ships in a tagged release.

## 1. Motivation

`cubrid-client` currently speaks the CAS wire protocol over a plaintext `node:net`
socket only. CUBRID brokers can be configured for TLS (`SSL=ON` in
`cubrid_broker.conf`), and JDBC/CCI clients already support it (`useSSL=true`).
A Node client has no way to connect to an SSL-enabled broker today. P1 adds
opt-in client-side TLS.

## 2. Confirmed protocol facts (from CUBRID C source, `src/broker/`)

1. **SSL is signaled by the client-info magic string.** The initial 10-byte
   client-info header (`SRV_CON_CLIENT_INFO_SIZE = 10`) carries a 5-byte magic:
   - normal: `"CUBRK"` (`SRV_CON_CLIENT_MAGIC_STR`)
   - SSL:    `"CUBRS"` (`SRV_CON_CLIENT_MAGIC_STR_SSL`)

   Server detects SSL via `IS_SSL_CLIENT := strncmp(driver_info,"CUBRS",5)==0`
   (`cas_protocol.h:41-47`).

2. **STARTTLS-style upgrade on the same socket, after broker redirect.** SSL is
   negotiated *after* the broker redirects the client to a CAS process and that
   CAS accepts. Same port (33000). Per-broker via `SSL=ON` (default `OFF`).
   Client mode must match broker mode or the connect is rejected
   (`"The requested SSL mode is not permitted..."`).

3. **Exact server-side ordering** (`cas_common_main.c`, non-Windows path):
   1. server sends plaintext 4-byte `int(0)` NO_ERROR to the client
      (`net_write_int(client_sock_fd, 0)`)
   2. server, if `IS_SSL_CLIENT`, runs `cas_init_ssl(client_sock_fd)`
      (OpenSSL `SSL_accept`)
   3. server reads the 628-byte credentials / OpenDatabase packet **over TLS**
      (`net_read_stream(..., db_info_size)`)

   → The client must **read the plaintext 4-byte `int(0)` first, then start the
   TLS handshake, then send OpenDatabase**; all subsequent traffic is TLS.

4. **Server certificate is self-signed by default** (`cas_ssl_cert.crt/.key`),
   using OpenSSL `TLS_server_method()`.

## 3. Current (non-SSL) connect flow (`src/protocol/connection.ts`)

1. Open raw `net.Socket` to broker `host:port`.
2. Send broker connection magic; read redirect (new CAS port, or `0` = reuse).
3. If `newPort > 0`, open a new socket to the CAS port; else reuse.
4. Write the 10-byte client-info exchange (`writeClientInfoExchange`, emits `"CUBRK"`).
5. Write OpenDatabase (628 bytes).
6. Read framed response.
7. `checkReconnect()` re-runs the whole handshake on CAS INACTIVE.

## 4. Proposed design

### 4.1 Config (`CASConnectionConfig`)
| field | type | default | purpose |
|---|---|---|---|
| `ssl` | `boolean` | `false` | opt into TLS; emits `"CUBRS"` magic |
| `rejectUnauthorized` | `boolean` | `true` (secure by default) | verify server cert chain |
| `ca` | `string \| Buffer` | – | trust anchor for self-signed server cert |
| `servername` | `string` | – | SNI / cert hostname override |

### 4.2 Handshake changes
- When `ssl=true`, `writeClientInfoExchange` emits `"CUBRS"`.
- After the CAS socket is resolved (post-redirect) and the client-info header is
  sent: **read exactly the plaintext 4-byte `int(0)` NO_ERROR**, then upgrade:
  `tls.connect({ socket: rawSocket, rejectUnauthorized, ca, servername, minVersion: 'TLSv1.2' })`,
  await `'secureConnect'`, then send OpenDatabase and all subsequent traffic over
  the TLS socket.
- **Reconnect (`checkReconnect`) rebuilds the ENTIRE state machine**: broker
  connect → redirect → client-info (`CUBRS`) → read plaintext NO_ERROR → TLS
  upgrade → OpenDatabase. Never reuse a previously wrapped `TLSSocket`.

### 4.3 Plaintext→TLS boundary safety (Oracle-confirmed)
- Reading the 4-byte plaintext `int(0)` before `tls.connect({ socket })` is
  **correct and required** (matches confirmed server ordering §2.3).
- Over-read risk is **low**: the server cannot send `ServerHello` until the
  client sends `ClientHello`, so no TLS bytes precede the upgrade.
- **Defensive guard (required):** use an exact-read helper that consumes exactly
  4 bytes; if the received chunk is longer, `rawSocket.unshift(leftover)` **before**
  wrapping with TLS, so `tls.connect({socket})` starts at a clean boundary with
  no stray plaintext buffered.

### 4.4 Redirect reuse-fd handling (Oracle-confirmed)
- TLS upgrade belongs **after** redirect resolution and after sending the 10-byte
  client-info header on the *final* CAS socket.
- `newPort > 0`: upgrade the new CAS socket.
- `newPort === 0` (reuse): upgrade the reused socket **only after all broker
  redirect bytes are fully consumed** (no leftover plaintext buffered).

### 4.5 Non-SSL path caveat (Oracle warning — do NOT touch opportunistically)
The server appears to send the plaintext `int(0)` even in non-SSL mode, yet the
current client does not explicitly read it. **Audit** where the existing non-SSL
client consumes/absorbs that int(0) before designing the SSL read. Do **not**
"fix" the non-SSL framing while adding TLS unless the current framing is fully
understood — it risks a silent regression on the working non-SSL path.

### 4.6 TLS version
- Default `minVersion: 'TLSv1.2'`. Do **not** silently downgrade.
- Make configurable **only if** old-broker (SSLv3/TLSv1.0/1.1) support is required.

### 4.7 Security default (Oracle-confirmed)
- Keep `rejectUnauthorized: true`. Do not copy JDBC's weaker trust-by-default.
- Document: default CUBRID self-signed certs require either a supplied `ca` or
  explicit `rejectUnauthorized: false`, and label the latter **development/testing
  only**.

## 5. Validation gate (Oracle-confirmed)
- Implement behind unit/spec tests first, but **block release on live end-to-end
  validation against an `SSL=ON` broker**.
- **Highest-risk unknown that MUST be validated live:** whether Node's
  `tls.connect({ socket })` interoperates cleanly with CUBRID CAS `SSL_accept`
  using the default self-signed server cert and the exact STARTTLS timing.
- The current test container is `SSL=OFF`, so a dedicated `SSL=ON` broker must be
  provisioned before shipping.

## 5a. Effort estimate
Medium (~1–2d): design doc + implementation + tests + docs + live SSL validation.

## 6. Testing
- Unit: magic-string swap, config plumbing.
- Integration: requires a live `SSL=ON` broker (current test container is `SSL=OFF`);
  self-skips otherwise, matching existing integration harness.

## 7. Docs impact (same-PR, per AGENTS.md)
- `README.md` configuration table (new `ssl`/`rejectUnauthorized`/`ca`/`servername`).
- `CHANGELOG.md` `[Unreleased]`.
