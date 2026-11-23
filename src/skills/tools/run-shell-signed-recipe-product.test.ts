import { afterAll, expect, mock, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recipeHash, recipeSigningBytes } from './run-shell-recipe-ledger.js';
import { testRunShellIssuer } from '../../shell-primitive/runshell-test-issuer.js';
import { setTestStateRoot } from '../../nexus/paths.js';
import type { SpawnFunction } from '../../shell-primitive/spawn-gateway.js';

const home = mkdtempSync(join(tmpdir(), 'signed-recipe-product-'));
setTestStateRoot(home);
const previousStateDir = process.env.ELANOUS_STATE_DIR;
process.env.ELANOUS_STATE_DIR = home;
const { checkRecipeEpoch: realCheckRecipeEpoch } = await import('./run-shell-recipe-epoch.js');
afterAll(() => {
  setTestStateRoot(null);
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  mock.module('./run-shell-recipe-epoch.js', () => ({ checkRecipeEpoch: realCheckRecipeEpoch }));
});
const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let currentEpoch = 7;
let revoked = false;
mock.module('./run-shell-recipe-epoch.js', () => ({ checkRecipeEpoch: () => revoked
  ? { ok: false, reason: 'recipe-revoked-by-anchor' }
  : { ok: true, epoch: currentEpoch, publicKeyPem } }));
const { dispatchSignedRecipe } = await import('./run-shell-recipe-dispatch.js');
const { spawnGateway } = await import('../../shell-primitive/spawn-gateway.js');
const { parseRecipeJson } = await import('./run-shell-recipe-ledger.js');
const dir = join(home, 'runshell', 'recipes');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const recipe = Object.freeze({ id: 'sample', epoch: 7, cwd: home, argv: Object.freeze(['/bin/echo', 'signed-only']),
  bytesSha256: createHash('sha256').update(readFileSync('/bin/echo')).digest('hex') });
const unsigned = { v: 1 as const, kind: 'grant' as const, recipeId: recipe.id, recipeSha256: recipeHash(recipe),
  signer: 'JUD' as const, at: '2026-11-22T00:00:00.000Z' };
const event = { ...unsigned, signature: sign(null, recipeSigningBytes(unsigned), keys.privateKey).toString('base64') };
const path = join(dir, 'sample.json');
writeFileSync(path, JSON.stringify({ recipe, event }), { mode: 0o600 });
chmodSync(path, 0o600);

test('product dispatch requires a parent card for non-local recipes and still enforces revocation', async () => {
  expect((await dispatchSignedRecipe('sample', 5000)).outcome).toBe('denied');
  const oldSend = process.send;
  const oldConnected = Object.getOwnPropertyDescriptor(process, 'connected');
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  const oldTrack = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'test-seat';
  let requests = 0;
  let cardId = '';
  process.send = ((message: any) => {
    requests++;
    expect(message.request.argv).toEqual(recipe.argv);
    expect(message.request.bytesSha256).toBe(recipe.bytesSha256);
    const approval = testRunShellIssuer.issue(message.request);
    cardId = approval.payload.cardId;
    queueMicrotask(() => process.emit('message', { type: 'elanous.runshell-approval.result', callId: message.callId,
      approval }));
    return true;
  }) as typeof process.send;
  try {
    const ok = await dispatchSignedRecipe('sample', 5000, undefined, 'test-session');
    expect(ok.outcome).toBe('exit'); expect(ok.exitCode).toBe(0); expect(ok.stdout.trim()).toBe('signed-only');
    expect(requests).toBe(1);
    const entries = readFileSync(join(home, 'nexus', 'runshell-recipes', 'executions.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(entries).toHaveLength(2);
    const canonical = `{"argv":["/bin/echo","signed-only"],"bytesSha256":${JSON.stringify(recipe.bytesSha256)},"cwd":${JSON.stringify(home)},"epoch":7,"id":"sample"}`;
    expect(entries[0]).toMatchObject({ phase: 'start', recipeId: 'sample', epoch: 7,
      recipeSha256: createHash('sha256').update(canonical).digest('hex'), argv: ['/bin/echo', 'signed-only'],
      approval: { cardId, signerKeySha256: createHash('sha256').update(testRunShellIssuer.publicKey).digest('hex'), status: 'presented' } });
    expect(cardId).not.toBe('');
    expect(entries[1]).toMatchObject({ phase: 'finish', runId: entries[0].runId, outcome: 'exit', exitCode: 0 });
  } finally {
    process.send = oldSend;
    if (oldConnected) Object.defineProperty(process, 'connected', oldConnected);
    else delete (process as { connected?: boolean }).connected;
    if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
  }
  revoked = true;
  expect((await dispatchSignedRecipe('sample', 5000)).outcome).toBe('denied');
  revoked = false; currentEpoch = 8;
  expect((await dispatchSignedRecipe('sample', 5000)).outcome).toBe('denied');
  currentEpoch = 7;
});

test('local-read signed recipe runs without a card', async () => {
  const local = Object.freeze({ ...recipe, id: 'local', argv: Object.freeze(['/usr/bin/uname', '-s']),
    bytesSha256: createHash('sha256').update(readFileSync('/usr/bin/uname')).digest('hex') });
  const unsignedLocal = { ...unsigned, recipeId: local.id, recipeSha256: recipeHash(local) };
  const eventLocal = { ...unsignedLocal, signature: sign(null, recipeSigningBytes(unsignedLocal), keys.privateKey).toString('base64') };
  writeFileSync(join(dir, 'local.json'), JSON.stringify({ recipe: local, event: eventLocal }), { mode: 0o600 });
  const result = await dispatchSignedRecipe('local', 5000);
  expect(result.outcome).toBe('exit'); expect(result.exitCode).toBe(0);
});

test('gateway admits a non-destructive signed recipe without a card (CEO 11-23 relax) and refuses altered argv', () => {
  const envelope = parseRecipeJson(readFileSync(path)) as any;
  const prevTrack = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'test-seat'; // grant route present; echo is outside the destructive/secret/exposure holds
  const spawned: string[][] = [];
  const spawnFn = ((command: string, args: readonly string[]) => { spawned.push([command, ...args]); return {} as never; }) as unknown as SpawnFunction;
  try { expect(() => spawnGateway('/bin/echo', ['signed-only'], { cwd: home }, spawnFn, undefined, envelope)).not.toThrow(); }
  finally { if (prevTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = prevTrack; }
  expect(spawned).toEqual([['/bin/echo', 'signed-only']]);
  expect(() => spawnGateway('/bin/echo', ['altered'], { cwd: home }, spawnFn, undefined, envelope)).toThrow('invocation mismatch');
  expect(spawned).toHaveLength(1);
});
