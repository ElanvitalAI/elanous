import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { challengeMessage, generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { startRelayServer } from './relay-server.js';
import { createAppKillSwitch } from './app-kill-switch.js';

test('public app report flips only the targeted relay block and stores no credential or token', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-abuse-report-')));
  const databasePath = join(root, 'relay', 'app-kill-switch.sqlite');
  const control = createAppKillSwitch(databasePath, { stateRoot: root });
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), publicDomain: 'elanous.app',
    publicServerId: serverId, publicUserId: 'alice', appKillSwitch: control });
  try {
    const address = `http://127.0.0.1:${relay.port}`;
    const headers = { host: 'notes--alice.elanous.app', origin: 'https://elanous.app', 'content-type': 'application/json' };
    const preflight = await fetch(`${address}/.well-known/elanous/report`, { method: 'OPTIONS', headers });
    expect(preflight.status).toBe(204);
    const secret = 'Bearer emt_must_not_store';
    const invalid = await fetch(`${address}/.well-known/elanous/report`, { method: 'POST', headers,
      body: JSON.stringify({ category: 'phishing', token: secret }) });
    expect(invalid.status).toBe(400);
    expect(control.audit('alice', 'notes')).toHaveLength(0);
    control.applyIncident({ userId: 'alice', appId: 'notes', incident: 'cost-spike',
      reason: 'cost guard', requestedBy: 'operator' });
    const reported = await fetch(`${address}/.well-known/elanous/report`, { method: 'POST',
      headers: { ...headers, authorization: secret }, body: JSON.stringify({ category: 'phishing' }) });
    expect(reported.status).toBe(202);
    const audit = control.audit('alice', 'notes');
    expect(audit).toMatchObject([
      { userId: 'alice', appId: 'notes', incident: 'cost-spike', reason: 'cost guard' },
      { userId: 'alice', appId: 'notes', incident: 'abuse-report', reason: 'phishing' },
    ]);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect((await fetch(`${address}/`, { headers: { host: 'notes--alice.elanous.app' } })).status).toBe(403);
    expect((await fetch(`${address}/`, { headers: { host: 'other--alice.elanous.app' } })).status).toBe(503);
  } finally { relay.stop(); expect(readFileSync(databasePath).includes(Buffer.from('emt_must_not_store'))).toBe(false);
    rmSync(root, { recursive: true, force: true }); }
});

test('report cuts off a public request already in flight', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(22));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  let down = false;
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), publicDomain: 'elanous.app',
    publicServerId: serverId, publicUserId: 'alice', appKillSwitch: {
      isDown: () => down,
      applyIncident: input => { down = true; return input as never; },
    } });
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/host?serverId=${serverId}`);
  const next = () => new Promise<MessageEvent>(resolve => ws.addEventListener('message', resolve, { once: true }));
  try {
    const challengeEvent = next();
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('host handshake failed')), { once: true });
    });
    const challenge = JSON.parse((await challengeEvent).data as string) as { nonce: string };
    const authenticated = next();
    ws.send(JSON.stringify({ type: 'auth', publicKey,
      signature: sign(null, challengeMessage(serverId, challenge.nonce), signing.privateKey).toString('base64url') }));
    await authenticated;
    const accepted = next();
    ws.send(JSON.stringify({ type: 'host-public-key', publicKey: Buffer.from(daemonKeys.publicKey).toString('base64url') }));
    await accepted;
    const forwarded = next();
    const address = `http://127.0.0.1:${relay.port}`;
    const pending = fetch(`${address}/`, { headers: { host: 'notes--alice.elanous.app' } });
    await forwarded;
    expect(relay.stats(serverId).publicRequests).toBe(1);
    const report = await fetch(`${address}/.well-known/elanous/report`, { method: 'POST',
      headers: { host: 'notes--alice.elanous.app', origin: 'https://elanous.app', 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'abuse' }) });
    expect(report.status).toBe(202);
    expect((await pending).status).toBe(403);
    expect(relay.stats(serverId).publicRequests).toBe(0);
  } finally { ws.close(); relay.stop(); }
});
