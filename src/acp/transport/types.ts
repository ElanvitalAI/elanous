// UI-Core arc Phase U4 — shared transport types.
//
// Every ACP transport (stdio · in-process · unix socket · WebSocket ·
// SSH stdin) exposes the same minimal lifecycle so the server boot
// code is transport-agnostic.

/** An inbound ACP connection. Each connection is a single bidirectional
 *  byte stream — the ACP SDK's `ndJsonStream()` wraps it into the
 *  JSON-RPC layer. */
/** Caller class of an ACP connection. Only 'operator' may open operator-only taps (debug envelope). */
export type AcpAudience = 'operator' | 'member' | 'unknown';

export interface AcpTransportConnection {
  /** Bytes from the client to elanous. */
  readable: ReadableStream<Uint8Array>;
  /** Bytes elanous writes back to the client. */
  writable: WritableStream<Uint8Array>;
  /** Best-effort identity string — used for debug logs + per-peer
   *  metric tagging. Socket transports fill in a peer address, stdio
   *  uses 'stdio', ssh uses the remote hostname. */
  peerId: string;
  /** Who opened this connection, decided once by the server at the upgrade. Absent = 'unknown' (fail-closed). */
  audience?: AcpAudience;
  /** Close the connection. Safe to call more than once. */
  close(): Promise<void>;
}

/** Any listener type must let the caller register a handler + receive
 *  a dispose fn. The handler owns the `AcpTransportConnection` it
 *  receives (including calling `close()` on teardown). */
export interface AcpTransportServer {
  /** Human-readable transport kind for debug log tagging. */
  readonly kind: 'stdio' | 'unix-socket' | 'websocket' | 'ssh' | 'in-process';
  /** Human-readable bind target. `/path/to/sock` for unix, `host:port`
   *  for ws, 'stdio' for stdio. */
  readonly address: string;
  /** Stop accepting new connections and close any live ones. Idempotent. */
  close(): Promise<void>;
}

/** Per-transport event sink. Called once per inbound connection.
 *  Consumers typically set up `ndJsonStream` + `AgentSideConnection`
 *  per invocation. Errors in the handler must not bring down the
 *  listener — transports swallow + log. */
export type AcpConnectionHandler = (conn: AcpTransportConnection) => void | Promise<void>;

/** Transport-level failure surfaced to the caller of `listen*()`.
 *  Production code typically exits with a non-zero code on these. */
export class AcpTransportError extends Error {
  constructor(public readonly transport: string, public readonly reason: string) {
    super(`ACP transport ${transport} failed: ${reason}`);
    this.name = 'AcpTransportError';
  }
}
