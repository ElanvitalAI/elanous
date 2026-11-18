// UI-Core arc Phase U4 — transport module public surface.

export type {
  AcpAudience,
  AcpConnectionHandler,
  AcpTransportConnection,
  AcpTransportServer,
} from './types.js';
export { AcpTransportError } from './types.js';

export {
  generateAuthToken,
  compareTokenConstTime,
  createAuthVerifier,
  type AcpAuthToken,
  type AcpAuthTokenRecord,
  type AcpAuthHandshake,
  type AcpAuthHandshakeResult,
  type AcpAuthVerifier,
} from './auth.js';

export {
  listenUnixSocket,
  type UnixSocketServerOpts,
} from './unix-socket-server.js';

export {
  listenWebSocket,
  type WebSocketServerOpts,
} from './websocket-server.js';
