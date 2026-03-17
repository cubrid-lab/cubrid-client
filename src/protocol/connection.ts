/**
 * CAS TCP connection — socket lifecycle, framed send/recv, and broker handshake.
 *
 * Implements the two-step CUBRID connection sequence:
 *   1. Broker handshake — send 10-byte magic, receive redirect port
 *   2. Open database   — send 628-byte credentials, receive session info
 *
 * All subsequent communication uses length-framed packets:
 *   Request:  [DATA_LENGTH:4][CAS_INFO:4][payload]
 *   Response: read 4-byte DATA_LENGTH, then read DATA_LENGTH + CAS_INFO bytes
 */

import { Socket } from "node:net";
import { SIZE_CAS_INFO, SIZE_DATA_LENGTH } from "./constants.js";
import { parseConnectionString } from "../utils/connection-string.js";
import {
  writeClientInfoExchange,
  parseClientInfoExchange,
  writeOpenDatabase,
  parseOpenDatabase,
  type OpenDatabaseResult,
} from "./protocol.js";

export interface CASConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number;
}

/**
 * Low-level TCP connection to a CUBRID CAS broker.
 *
 * Manages socket lifecycle, the two-step handshake, and framed binary I/O.
 */
export class CASConnection {
  private socket: Socket | null = null;
  private connected = false;
  private _casInfo: Buffer = Buffer.alloc(SIZE_CAS_INFO);
  private _protoVersion = 1;
  private _sessionId = 0;
  private receiveBuffer: Buffer = Buffer.alloc(0);

  private readonly config: CASConnectionConfig;

  constructor(config: CASConnectionConfig | string) {
    this.config = typeof config === "string" ? parseConnectionString(config) : config;
  }

  /** Perform broker handshake and open database. */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Step 1: Connect to broker and send ClientInfoExchange
    const brokerSocket = await this.createSocket(this.config.host, this.config.port);

    try {
      await this.socketWrite(brokerSocket, writeClientInfoExchange());

      // Step 2: Receive redirect port (4 bytes)
      const portData = await this.recvExact(brokerSocket, SIZE_DATA_LENGTH);
      const newPort = parseClientInfoExchange(portData);

      if (newPort < 0) {
        brokerSocket.destroy();
        throw new Error(`CUBRID broker rejected connection (code: ${newPort})`);
      }

      // Step 3: If port > 0, connect to CAS on new port; if 0, reuse broker socket
      if (newPort > 0) {
        brokerSocket.destroy();
        this.socket = await this.createSocket(this.config.host, newPort);
      } else {
        this.socket = brokerSocket;
      }

      // Step 4: Send OpenDatabase (628 bytes, unframed)
      await this.socketWrite(
        this.socket,
        writeOpenDatabase(this.config.database, this.config.user, this.config.password),
      );

      // Step 5: Receive framed OpenDatabase response
      const dataLengthBuf = await this.recvExact(this.socket, SIZE_DATA_LENGTH);
      const dataLength = dataLengthBuf.readInt32BE(0);
      const responseBody = await this.recvExact(this.socket, dataLength + SIZE_CAS_INFO);

      const result: OpenDatabaseResult = parseOpenDatabase(responseBody);
      this._casInfo = result.casInfo;
      this._protoVersion = result.protoVersion;
      this._sessionId = result.sessionId;
      this.connected = true;
    } catch (error) {
      brokerSocket.destroy();
      if (this.socket && this.socket !== brokerSocket) {
        this.socket.destroy();
        this.socket = null;
      }
      throw error;
    }
  }

  /**
   * Send a framed CAS request (header + payload).
   * Both buffers are written as a single TCP send.
   */
  async send(header: Buffer, payload: Buffer): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new Error("CASConnection is not connected");
    }

    const combined = Buffer.concat([header, payload]);
    await this.socketWrite(this.socket, combined);
  }

  /**
   * Receive a framed CAS response.
   * Reads 4-byte DATA_LENGTH, then reads DATA_LENGTH + CAS_INFO bytes.
   * Returns the body (CAS_INFO + payload) without the DATA_LENGTH prefix.
   */
  async recv(): Promise<Buffer> {
    if (!this.socket || !this.connected) {
      throw new Error("CASConnection is not connected");
    }

    const dataLengthBuf = await this.recvExact(this.socket, SIZE_DATA_LENGTH);
    const dataLength = dataLengthBuf.readInt32BE(0);
    const totalLen = dataLength + SIZE_CAS_INFO;

    return this.recvExact(this.socket, totalLen);
  }

  /**
   * Send request and receive response in one call.
   * Strips the CAS_INFO from the response (first 4 bytes) and returns the payload.
   */
  async sendAndRecv(header: Buffer, payload: Buffer): Promise<Buffer> {
    await this.send(header, payload);
    const response = await this.recv();

    // Update CAS_INFO from response
    response.copy(this._casInfo, 0, 0, SIZE_CAS_INFO);

    // Return payload portion (after CAS_INFO)
    return response.subarray(SIZE_CAS_INFO);
  }

  /** Best-effort close: send CON_CLOSE, then destroy socket. */
  async close(): Promise<void> {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.receiveBuffer = Buffer.alloc(0);

    socket.destroy();
  }

  /** Current CAS_INFO bytes (echoed back to server on each request). */
  get casInfo(): Buffer {
    return this._casInfo;
  }

  /** Protocol version negotiated during OpenDatabase. */
  get protoVersion(): number {
    return this._protoVersion;
  }

  /** Session ID from OpenDatabase. */
  get sessionId(): number {
    return this._sessionId;
  }

  /** Whether the connection is currently open. */
  get isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private createSocket(host: string, port: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = new Socket();
      const timeout = this.config.connectionTimeout;

      if (timeout && timeout > 0) {
        socket.setTimeout(timeout);
      }

      socket.once("error", (err) => {
        socket.destroy();
        reject(new Error(`Failed to connect to ${host}:${port}: ${err.message}`));
      });

      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error(`Connection to ${host}:${port} timed out`));
      });

      socket.connect(port, host, () => {
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
        socket.setTimeout(0); // Disable timeout after successful connect
        resolve(socket);
      });
    });
  }

  private socketWrite(socket: Socket, data: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      socket.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Read exactly `size` bytes from the socket.
   * Accumulates data chunks until the required amount is received.
   */
  private recvExact(socket: Socket, size: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      // Check if we already have enough buffered data
      if (this.receiveBuffer.length >= size) {
        const result = this.receiveBuffer.subarray(0, size);
        this.receiveBuffer = this.receiveBuffer.subarray(size);
        resolve(result);
        return;
      }

      const onData = (chunk: Buffer): void => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

        if (this.receiveBuffer.length >= size) {
          cleanup();
          const result = this.receiveBuffer.subarray(0, size);
          this.receiveBuffer = this.receiveBuffer.subarray(size);
          resolve(result);
        }
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error("Connection closed while reading"));
      };

      const onEnd = (): void => {
        cleanup();
        reject(new Error("Connection ended while reading"));
      };

      const cleanup = (): void => {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        socket.removeListener("end", onEnd);
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("end", onEnd);
    });
  }
}
