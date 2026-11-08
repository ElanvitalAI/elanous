import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import {
  acceptDaemonChannel,
  createPhoneChannel,
  generateDaemonKeyPair,
  serverIdFromPublicKey,
} from '../relay/channel.js';
import { MuxDecoder, MuxEncoder, MuxStreamState, type MuxFrame } from '../relay/mux.js';
import vectors from '../relay/test-vectors.json';
import { createFakeRelayWorld } from './fake-relay-world.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function value<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

test('SIM-RELAY-PUBLIC: pinned key admits a fresh valid host signature and rejects a forged signature', async () => {
  const world = await createFakeRelayWorld();
  try {
    const valid = await world.authenticateHost('alpha');
    expect(valid.admitted).toBe(true);
    expect(valid.challengeNonce).toBeTruthy();
    expect(world.relay.stats(valid.serverId).host).toBe(true);

    const forged = await world.attemptForgedHost('beta');
    expect(forged.admitted).toBe(false);
    expect(forged.closeCode).toBe(1008);
    expect(forged.closeReason).toBe('invalid host signature');
    expect(world.relay.stats(forged.serverId).host).toBe(false);

    const observation = world.observation();
    expect(observation.hosts).toHaveLength(2);
    expect(observation.hosts[0]).toEqual(valid);
    expect(observation.hosts[1]).toEqual(forged);
  } finally {
    world.close();
  }
});

test('SIM-RELAY-PUBLIC: two public app/user Host audiences are routed by the real Host boundary without cross-audience leakage', async () => {
  const world = await createFakeRelayWorld();
  try {
    await world.authenticateHost('alpha');
    const appAudience = await world.connectAudience('app-client', 'alpha', world.hostNames.app);
    const userAudience = await world.connectAudience('user-client', 'alpha', world.hostNames.user);

    expect(appAudience.response.status).toBe(200);
    expect(appAudience.response.routedHost).toBe(world.hostNames.app);
    expect(appAudience.response.body).toContain('audience-app');
    expect(userAudience.response.status).toBe(200);
    expect(userAudience.response.routedHost).toBe(world.hostNames.user);
    expect(userAudience.response.body).toContain('audience-user');

    // Real Host routing kept the responses apart: each audience received only its own frame.
    expect(appAudience.response.body).not.toContain('audience-user');
    expect(userAudience.response.body).not.toContain('audience-app');
    expect(appAudience.receivedFrames).toBe(1);
    expect(userAudience.receivedFrames).toBe(1);

    // Re-request from the app audience while the user audience stays connected: still no leak.
    const again = await world.connectAudience('app-client-2', 'alpha', world.hostNames.app);
    expect(again.response.body).toContain('audience-app');
    expect(again.response.routedHost).toBe(world.hostNames.app);
    expect(userAudience.receivedFrames).toBe(1);

    // Inject an actual encrypted host frame through the relay, addressed only to app-client.
    // The live counters and raw received frame lists make cross-client delivery observable.
    world.sendHostData('alpha', appAudience.clientId, 'app-only-push');
    await world.settleFrames();
    expect(appAudience.receivedFrames).toBe(2);
    expect(appAudience.receivedData.some((frame) => frame.includes('app-only-push'))).toBe(true);
    expect(userAudience.receivedFrames).toBe(1);
    expect(userAudience.receivedData.some((frame) => frame.includes('app-only-push'))).toBe(false);

    const stats = world.relay.stats(appAudience.serverId);
    expect(stats.host).toBe(true);
    expect(stats.clients).toBe(3);

    const observation = world.observation();
    expect(observation.audiences).toHaveLength(3);
    expect(observation.audiences.map((a) => a.routedHost)).toEqual([
      world.hostNames.app,
      world.hostNames.user,
      world.hostNames.app,
    ]);
    expect(new Set(observation.audiences.map((a) => a.requestedHost))).toEqual(
      new Set([world.hostNames.app, world.hostNames.user]),
    );
    expect(observation.externalNetworkAttempts).toBe(0);
    expect(observation.externalNetworkMeasured).toBe(true);
  } finally {
    world.close();
  }
});

test('SIM-RELAY-PUBLIC: host disconnect closes its audience and a reconnect establishes a fresh session', async () => {
  const world = await createFakeRelayWorld();
  try {
    const first = await world.authenticateHost('alpha');
    expect(first.admitted).toBe(true);
    const audience = await world.connectAudience('pre-disconnect', 'alpha', world.hostNames.app);
    expect(audience.response.body).toContain('audience-app');

    const closedCode = await world.disconnectHost('alpha', audience);
    expect(closedCode).toBe(1012);
    expect(world.relay.stats(first.serverId).host).toBe(false);

    const reconnected = await world.reconnectHost('alpha', first.challengeNonce, world.hostNames.app);
    expect(reconnected.reconnected).toBe(true);
    expect(reconnected.freshChallenge).toBe(true);
    expect(reconnected.freshResponse.responseStatus).toBe(200);
    expect(reconnected.freshResponse.routedHost).toBe(world.hostNames.app);
    expect(reconnected.freshResponse.body).toContain('audience-app');

    const observation = world.observation();
    expect(observation.reconnect).toEqual(reconnected);
    expect(reconnected.audienceClosedCode).toBe(closedCode);
    expect(world.relay.stats(first.serverId).host).toBe(true);
  } finally {
    world.close();
  }
});

test('SIM-RELAY-PUBLIC: records the current public Host routing blocker without changing production routing', async () => {
  const world = await createFakeRelayWorld();
  try {
    expect(await world.probePublicHostRouting()).toBe(
      'loadNexusAppHost only recognizes *.app.localhost; app--user.elanous.app has no production Host-routing seam',
    );
    expect(world.observation().hostRoutingBlocker).toContain('app--user.elanous.app');
  } finally {
    world.close();
  }
});

test('SIM-RELAY-PUBLIC: fixed channel/mux relay wire vectors still match byte-for-byte through the real code', async () => {
  await sodium.ready;
  const daemonSeed = fromHex(vectors.daemonSeedHex);
  const phoneSeed = fromHex(vectors.phoneSeedHex);
  const daemon = await generateDaemonKeyPair(daemonSeed);
  const phone = value(await createPhoneChannel(daemon.publicKey, daemon.publicKey, phoneSeed));
  const server = value(await acceptDaemonChannel(daemon, phone.phonePublicKey));
  expect(hex(daemon.publicKey)).toBe(vectors.daemonPublicKeyHex);
  expect(hex(phone.phonePublicKey)).toBe(vectors.phonePublicKeyHex);
  expect(serverIdFromPublicKey(daemon.publicKey)).toBe(vectors.serverId);

  const phonePair = sodium.crypto_kx_seed_keypair(phoneSeed);
  const keys = sodium.crypto_kx_client_session_keys(phonePair.publicKey, phonePair.privateKey, daemon.publicKey);
  expect(sha256(keys.sharedTx)).toBe(vectors.phoneToDaemonKeySha256);

  const phoneStreams = new MuxStreamState();
  const daemonStreams = new MuxStreamState();
  const phoneEncoder = new MuxEncoder(phoneStreams);
  const phoneDecoder = new MuxDecoder(phoneStreams);
  const daemonEncoder = new MuxEncoder(daemonStreams);
  const daemonDecoder = new MuxDecoder(daemonStreams);

  const request = vectors.request as MuxFrame;
  const requestMux = value(phoneEncoder.encode(request));
  expect(hex(requestMux)).toBe(vectors.requestMuxHex);
  const requestEncrypted = value(phone.channel.seal(requestMux));
  expect(hex(requestEncrypted)).toBe(vectors.requestEncryptedHex);
  expect(value(server.open(fromHex(vectors.requestEncryptedHex)))).toEqual(requestMux);
  expect(daemonDecoder.decode(requestMux)).toEqual({ ok: true, value: request });

  const response: MuxFrame = {
    streamId: vectors.response.streamId,
    kind: 'data',
    data: fromHex(vectors.response.dataHex),
  };
  const responseMux = value(daemonEncoder.encode(response));
  expect(hex(responseMux)).toBe(vectors.responseMuxHex);
  const responseEncrypted = value(server.seal(responseMux));
  expect(hex(responseEncrypted)).toBe(vectors.responseEncryptedHex);
  const receivedResponse = value(phone.channel.open(fromHex(vectors.responseEncryptedHex)));
  expect(receivedResponse).toEqual(responseMux);
  expect(phoneDecoder.decode(receivedResponse)).toEqual({ ok: true, value: response });
});
