import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign } from 'node:crypto';
import {
  challengeMessage,
  startRelayServer,
} from '../relay/relay-server.js';
import {
  acceptDaemonChannel,
  createPhoneChannel,
  generateDaemonKeyPair,
  serverIdFromPublicKey,
  type DaemonKeyPair,
  type EncryptedChannel,
} from '../relay/channel.js';
import { MuxDecoder, MuxEncoder, MuxStreamState, type MuxFrame } from '../relay/mux.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';

/**
 * SIM-RELAY-PUBLIC: deterministic loopback-only simulation world for the Nexus
 * public relay boundary. The runtime path reuses the production relay server
 * (`startRelayServer`), the encrypted channel/mux code, the fixed wire vectors
 * in `src/relay/test-vectors.json`, and the real app-host entry point
 * (`loadNexusAppHost` → `appHost.handle`). Only this device decides credentials
 * (seeded keys, seeded phone channels), transport targets (loopback only), and
 * records observations. No production relay/app-host logic is replaced.
 */

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MANIFEST = `apiVersion: elanous.app/v0
slug: %s
title: %s
frontend:
  kind: static-export
  out: out
`;

export interface HostAuthOutcome {
  label: string;
  serverId: string;
  admitted: boolean;
  closeCode?: number;
  closeReason?: string;
  challengeNonce?: string;
}

export interface AudienceRecord {
  label: string;
  serverId: string;
  clientId: number;
  requestedHost: string;
  responseStatus: number;
  routedHost: string;
  body: string;
  receivedFrames: number;
}

export interface ReconnectRecord {
  audienceClosedCode: number;
  reconnected: boolean;
  freshChallenge: boolean;
  freshClientId: number;
  freshResponse: Pick<AudienceRecord, 'requestedHost' | 'responseStatus' | 'routedHost' | 'body'>;
}

export interface FakeRelayWorldObservation {
  hosts: HostAuthOutcome[];
  audiences: AudienceRecord[];
  reconnect: ReconnectRecord | null;
  externalNetworkAttempts: number;
  externalNetworkMeasured: boolean;
  hostRoutingBlocker: string | null;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Deterministic Ed25519 signing key derived from a fixed label — no OS randomness. */
function seededSigningKey(label: string) {
  const seed = sha256(`elanous-fake-relay-world:ed25519:${label}`);
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    privateKey,
    publicKeyB64url: Buffer.from(spki.subarray(spki.length - 32)).toString('base64url'),
  };
}

/** Deterministic X25519 daemon key pair; its serverId is sha256(publicKey) as in production. */
async function seededDaemon(label: string) {
  const seed = new Uint8Array(sha256(`elanous-fake-relay-world:x25519:${label}`));
  const keys = await generateDaemonKeyPair(seed);
  return { label, keys, serverId: serverIdFromPublicKey(keys.publicKey) };
}

const u32be = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

function withTimeout<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`fake-relay-world: timed out waiting for ${what}`)), ms).unref?.()),
  ]);
}

/** App-level response payload the device daemon muxes back to a phone audience. */
interface DaemonResponse { status: number; routedHost: string; body: string }

interface AudienceHandle {
  label: string;
  serverId: string;
  clientId: number;
  requestedHost: string;
  response: DaemonResponse;
  readonly receivedFrames: number;
  receivedData: string[];
  socket: WebSocket;
}

export class FakeRelayWorld {
  readonly relay: ReturnType<typeof startRelayServer>;
  readonly appHost: ReturnType<typeof loadNexusAppHost>['appHost'];
  /** Public app/user Host names routed through the real app-host boundary. */
  readonly hostNames = { app: 'app.app.localhost', user: 'user.app.localhost' };
  readonly daemons: Record<'alpha' | 'beta', { label: string; keys: DaemonKeyPair; serverId: string }>;

  private readonly root: string;
  private readonly sessionCookies: ReadonlyMap<string, string>;
  private readonly pinnedKeys: Record<'alpha' | 'beta', ReturnType<typeof seededSigningKey>>;
  private readonly hostSockets = new Map<string, WebSocket>();
  private readonly daemonChannels = new Map<string, Map<number, { channel: EncryptedChannel; encoder: MuxEncoder }>>();
  private readonly hostAuths: HostAuthOutcome[] = [];
  private readonly audienceRecords: AudienceRecord[] = [];
  private reconnectRecord: ReconnectRecord | null = null;
  private lastAudienceClosedCode: number | null = null;
  private hostRoutingBlocker: string | null = null;
  private readonly externalAttempts = { count: 0, measured: false };

  private constructor(init: {
    relay: ReturnType<typeof startRelayServer>;
    appHost: ReturnType<typeof loadNexusAppHost>['appHost'];
    root: string;
    sessionCookies: ReadonlyMap<string, string>;
    daemons: FakeRelayWorld['daemons'];
    pinnedKeys: FakeRelayWorld['pinnedKeys'];
  }) {
    this.relay = init.relay;
    this.appHost = init.appHost;
    this.root = init.root;
    this.sessionCookies = init.sessionCookies;
    this.daemons = init.daemons;
    this.pinnedKeys = init.pinnedKeys;
  }

  static async create(): Promise<FakeRelayWorld> {
    const alpha = await seededDaemon('alpha');
    const beta = await seededDaemon('beta');
    const pinnedKeys = { alpha: seededSigningKey('alpha-host'), beta: seededSigningKey('beta-host') };
    const trustedHostKeys = new Map<string, string>([
      [alpha.serverId, pinnedKeys.alpha.publicKeyB64url],
      [beta.serverId, pinnedKeys.beta.publicKeyB64url],
    ]);
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', trustedHostKeys });
    const root = mkdtempSync(join(tmpdir(), 'fake-relay-world-'));
    try {
      for (const [slug, body] of [
        ['app', '<main>audience-app</main>'],
        ['user', '<main>audience-user</main>'],
      ] as const) {
        const appDir = join(root, slug);
        const outDir = join(appDir, 'out');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(appDir, 'app.yaml'), MANIFEST.replace('%s', slug).replace('%s', `Audience ${slug}`));
        writeFileSync(join(outDir, 'index.html'), body);
      }
      const mounted = loadNexusAppHost(root, undefined, {
        dir: join(root, 'app-sessions'),
        key: 'fake-relay-world-app-session-key-32-bytes-minimum',
      });
      if (mounted.issues.length > 0) {
        mounted.appHost.close();
        throw new Error(`fake-relay-world: app mount issues: ${mounted.issues.join(', ')}`);
      }
      const sessionCookies = new Map<string, string>();
      for (const slug of ['app', 'user']) {
        const invitation = mounted.appHost.issueInvitation(slug, 'fake-relay-world-operator');
        const publicHost = `${slug}.app.localhost`;
        const accepted = await mounted.appHost.handle(new Request(
          `http://${publicHost}/__auth/accept?${new URLSearchParams({ token: invitation.token })}`,
          { headers: { host: publicHost } },
        ));
        const cookie = accepted?.headers.get('set-cookie')?.split(';', 1)[0];
        if (accepted?.status !== 303 || !cookie) {
          mounted.appHost.close();
          throw new Error(`fake-relay-world: ${slug} app invitation was not accepted (${accepted?.status ?? 'no response'})`);
        }
        sessionCookies.set(publicHost, cookie);
      }
      return new FakeRelayWorld({ relay, appHost: mounted.appHost, root, sessionCookies, daemons: { alpha, beta }, pinnedKeys });
    } catch (error) {
      relay.stop();
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  /** Every device transport goes through here: loopback only, non-loopback targets are counted. */
  private connectWs(serverId: string, role: 'host' | 'client'): WebSocket {
    const url = new URL(`ws://127.0.0.1:${this.relay.port}/${role}`);
    url.searchParams.set('serverId', serverId);
    this.externalAttempts.measured = true;
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      this.externalAttempts.count += 1;
      throw new Error(`fake-relay-world: blocked non-loopback transport ${url.hostname}`);
    }
    return new WebSocket(url);
  }

  /** Probe the documented public hostname against the real app-host and retain an exact blocker. */
  async probePublicHostRouting(): Promise<string | null> {
    const publicHost = 'app--user.elanous.app';
    const response = await this.appHost.handle(new Request(`http://${publicHost}/`, { headers: { host: publicHost } }));
    this.hostRoutingBlocker = response
      ? null
      : `loadNexusAppHost only recognizes *.app.localhost; ${publicHost} has no production Host-routing seam`;
    return this.hostRoutingBlocker;
  }

  /** Authenticate the daemon host for a serverId with the operator-pinned signing key. */
  async authenticateHost(which: 'alpha' | 'beta'): Promise<HostAuthOutcome> {
    const daemon = this.daemons[which];
    const pinned = this.pinnedKeys[which];
    const socket = this.connectWs(daemon.serverId, 'host');
    socket.binaryType = 'arraybuffer';
    const outcome: HostAuthOutcome = { label: which, serverId: daemon.serverId, admitted: false };
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const value = JSON.parse(event.data) as { type?: string; nonce?: string; reason?: string };
        if (value.type === 'challenge' && value.nonce) {
          outcome.challengeNonce = value.nonce;
          const signature = ed25519Sign(null, challengeMessage(daemon.serverId, value.nonce), pinned.privateKey);
          socket.send(JSON.stringify({ type: 'auth', publicKey: pinned.publicKeyB64url, signature: Buffer.from(signature).toString('base64url') }));
        } else if (value.type === 'authenticated') {
          outcome.admitted = true;
          this.hostSockets.set(daemon.serverId, socket);
          resolve();
        }
      });
      socket.addEventListener('close', (event) => {
        outcome.closeCode = event.code;
        outcome.closeReason = event.reason;
        if (!outcome.admitted) resolve();
      });
      socket.addEventListener('error', () => reject(new Error(`fake-relay-world: ${which} host socket error`)));
    }), `${which} host authentication`);
    this.hostAuths.push(outcome);
    if (outcome.admitted) await this.serveDaemon(which, socket);
    return outcome;
  }

  /** Forge: present the pinned public key but a signature made by a different (attacker) key. */
  async attemptForgedHost(which: 'alpha' | 'beta' = 'beta'): Promise<HostAuthOutcome> {
    const daemon = this.daemons[which];
    const pinned = this.pinnedKeys[which];
    const attacker = seededSigningKey(`attacker:${which}`);
    const socket = this.connectWs(daemon.serverId, 'host');
    const outcome: HostAuthOutcome = { label: `forged:${which}`, serverId: daemon.serverId, admitted: false };
    await withTimeout(new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const value = JSON.parse(event.data) as { type?: string; nonce?: string };
        if (value.type === 'challenge' && value.nonce) {
          outcome.challengeNonce = value.nonce;
          const signature = ed25519Sign(null, challengeMessage(daemon.serverId, value.nonce), attacker.privateKey);
          socket.send(JSON.stringify({ type: 'auth', publicKey: pinned.publicKeyB64url, signature: Buffer.from(signature).toString('base64url') }));
        }
      });
      socket.addEventListener('close', (event) => {
        outcome.closeCode = event.code;
        outcome.closeReason = event.reason;
        resolve();
      });
    }), `forged ${which} host rejection`);
    this.hostAuths.push(outcome);
    return outcome;
  }

  /**
   * Device daemon: decode phone channel handshakes, mux frames, run each HTTP
   * frame through the real appHost.handle, and mux the response back over the
   * relay's clientId-prefixed host frames.
   */
  private async serveDaemon(which: 'alpha' | 'beta', socket: WebSocket) {
    const daemon = this.daemons[which];
    type ClientChannel = { channel: EncryptedChannel; encoder: MuxEncoder; decoder: MuxDecoder };
    const channels = new Map<number, ClientChannel>();
    this.daemonChannels.set(daemon.serverId, channels);
    socket.addEventListener('message', async (event) => {
      if (typeof event.data === 'string') return; // relay control JSON
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (bytes.length < 5) return;
      const clientId = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
      const payload = bytes.subarray(4);
      let entry = channels.get(clientId);
      if (!entry) {
        if (payload.length !== 32) return;
        const accepted = await acceptDaemonChannel(daemon.keys, payload);
        if (!accepted.ok) return;
        const channel = accepted.value;
        const streams = new MuxStreamState();
        entry = { channel, encoder: new MuxEncoder(streams), decoder: new MuxDecoder(streams) };
        channels.set(clientId, entry);
        return;
      }
      const opened = entry.channel.open(payload);
      if (!opened.ok) return;
      const decoded = entry.decoder.decode(opened.value);
      if (!decoded.ok) return;
      const frame = decoded.value;
      if (frame.kind !== 'open' || frame.protocol !== 'http') return;
      const requestHeaders = new Headers(frame.headers);
      const routedHost = frame.headers.host ?? '';
      const sessionCookie = this.sessionCookies.get(routedHost);
      if (sessionCookie) requestHeaders.set('cookie', sessionCookie);
      const response = await this.appHost.handle(new Request(`http://${routedHost}${frame.path}`, {
        method: frame.method,
        headers: requestHeaders,
      }));
      const body = response ? await response.text() : '';
      const reply: DaemonResponse = {
        status: response?.status ?? 404,
        routedHost: response?.headers.get('x-nexus-app-host') ?? '',
        body,
      };
      const replyMux = entry.encoder.encode({
        streamId: frame.streamId,
        kind: 'data',
        data: new TextEncoder().encode(JSON.stringify(reply)),
      });
      if (!replyMux.ok) return;
      const sealed = entry.channel.seal(replyMux.value);
      if (!sealed.ok) return;
      const frameBytes = new Uint8Array(4 + sealed.value.length);
      frameBytes.set(u32be(clientId));
      frameBytes.set(sealed.value, 4);
      socket.send(frameBytes);
    });
  }

  /** Connect a phone audience and request `/` for a public Host name over the real mux/channel path. */
  async connectAudience(label: string, which: 'alpha' | 'beta', requestedHost: string): Promise<AudienceHandle> {
    const daemon = this.daemons[which];
    const socket = this.connectWs(daemon.serverId, 'client');
    socket.binaryType = 'arraybuffer';
    const phoneSeed = new Uint8Array(sha256(`elanous-fake-relay-world:phone:${label}`));
    const dialed = await createPhoneChannel(daemon.keys.publicKey, daemon.keys.publicKey, phoneSeed);
    if (!dialed.ok) throw new Error(`fake-relay-world: ${label} channel handshake failed: ${dialed.reason}`);
    const phone = dialed.value;
    const streams = new MuxStreamState();
    const encoder = new MuxEncoder(streams);
    const decoder = new MuxDecoder(streams);
    let clientId = -1;
    let receivedFrames = 0;
    const receivedData: string[] = [];
    const response = await withTimeout(new Promise<DaemonResponse>((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          const value = JSON.parse(event.data) as { type?: string; clientId?: number };
          if (value.type === 'connected' && typeof value.clientId === 'number') {
            clientId = value.clientId;
            socket.send(phone.phonePublicKey);
            const open: MuxFrame = {
              streamId: 1000,
              kind: 'open',
              protocol: 'http',
              method: 'GET',
              path: '/',
              headers: { host: requestedHost },
            };
            const muxed = encoder.encode(open);
            if (!muxed.ok) { reject(new Error(muxed.reason)); return; }
            const sealed = phone.channel.seal(muxed.value);
            if (!sealed.ok) { reject(new Error(sealed.reason)); return; }
            socket.send(sealed.value);
          }
          return;
        }
        receivedFrames += 1;
        const opened = phone.channel.open(new Uint8Array(event.data as ArrayBuffer));
        if (!opened.ok) return;
        const decoded = decoder.decode(opened.value);
        if (!decoded.ok) return;
        if (decoded.value.kind === 'data') {
          const data = new TextDecoder().decode(decoded.value.data);
          receivedData.push(data);
          resolve(JSON.parse(data) as DaemonResponse);
        }
      });
      socket.addEventListener('error', () => reject(new Error(`fake-relay-world: ${label} socket error`)));
    }), `${label} audience response`) as DaemonResponse;
    const record: AudienceRecord = {
      label,
      serverId: daemon.serverId,
      clientId,
      requestedHost,
      responseStatus: response.status,
      routedHost: response.routedHost,
      body: response.body,
      get receivedFrames() { return receivedFrames; },
    };
    this.audienceRecords.push(record);
    return {
      label,
      serverId: daemon.serverId,
      clientId,
      requestedHost,
      response,
      get receivedFrames() { return receivedFrames; },
      receivedData,
      socket,
    };
  }

  /** Close the connected daemon host for a serverId; production closes the whole audience. */
  disconnectHost(which: 'alpha' | 'beta', audience: AudienceHandle): Promise<number> {
    const daemon = this.daemons[which];
    const socket = this.hostSockets.get(daemon.serverId);
    if (!socket) return Promise.resolve(-1);
    const closed = withTimeout(new Promise<number>((resolve) => {
      audience.socket.addEventListener('close', (event) => resolve(event.code));
    }), `${which} audience close`);
    socket.close(1000, 'daemon stopped');
    this.hostSockets.delete(daemon.serverId);
    return closed.then((code) => {
      this.lastAudienceClosedCode = code;
      this.reconnectRecord = null;
      return code;
    });
  }

  /** Reconnect a fresh daemon host and confirm a fresh session serves a new audience. */
  async reconnectHost(which: 'alpha' | 'beta', previousChallengeNonce: string | undefined, requestedHost: string): Promise<ReconnectRecord> {
    const auth = await this.authenticateHost(which);
    const fresh = await this.connectAudience(`reconnect:${which}`, which, requestedHost);
    const record: ReconnectRecord = {
      audienceClosedCode: this.lastAudienceClosedCode ?? -1,
      reconnected: auth.admitted,
      freshChallenge: auth.challengeNonce !== undefined && auth.challengeNonce !== previousChallengeNonce,
      freshClientId: fresh.clientId,
      freshResponse: {
        requestedHost: fresh.requestedHost,
        responseStatus: fresh.response.status,
        routedHost: fresh.response.routedHost,
        body: fresh.response.body,
      },
    };
    this.reconnectRecord = record;
    return record;
  }

  observation(): FakeRelayWorldObservation {
    return {
      hosts: [...this.hostAuths],
      audiences: [...this.audienceRecords],
      reconnect: this.reconnectRecord,
      externalNetworkAttempts: this.externalAttempts.count,
      externalNetworkMeasured: this.externalAttempts.measured,
      hostRoutingBlocker: this.hostRoutingBlocker,
    };
  }

  /** Send a deterministic encrypted host data frame through the real relay to one client ID. */
  sendHostData(which: 'alpha' | 'beta', clientId: number, body: string): void {
    const daemon = this.daemons[which];
    const socket = this.hostSockets.get(daemon.serverId);
    const channel = this.daemonChannels.get(daemon.serverId)?.get(clientId);
    if (!socket || !channel) throw new Error(`fake-relay-world: no host/client channel for ${which}/${clientId}`);
    const muxed = channel.encoder.encode({
      streamId: 1000,
      kind: 'data',
      data: new TextEncoder().encode(JSON.stringify({ status: 200, routedHost: 'push', body })),
    });
    if (!muxed.ok) throw new Error(`fake-relay-world: host mux encode failed: ${muxed.reason}`);
    const sealed = channel.channel.seal(muxed.value);
    if (!sealed.ok) throw new Error(`fake-relay-world: host channel seal failed: ${sealed.reason}`);
    const frame = new Uint8Array(4 + sealed.value.length);
    frame.set(u32be(clientId));
    frame.set(sealed.value, 4);
    socket.send(frame);
  }

  /** Let websocket message events already queued by the loopback relay settle before checking absence. */
  async settleFrames(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  close(): void {
    for (const socket of this.hostSockets.values()) socket.close(1000, 'world closing');
    this.hostSockets.clear();
    this.relay.stop();
    this.appHost.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

export async function createFakeRelayWorld(): Promise<FakeRelayWorld> {
  return FakeRelayWorld.create();
}
