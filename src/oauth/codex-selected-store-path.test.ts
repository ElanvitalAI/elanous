import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const repoRoot = join(import.meta.dir, '../..');
const mod = (name: string) => JSON.stringify(join(import.meta.dir, name));

function redact(text: string): string {
  return text
    .replaceAll('fixture-access', '[redacted]')
    .replaceAll('fixture-refresh', '[redacted]')
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
}

function childEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME = root;
  env.NODE_ENV = 'production';
  env.ELANOUS_LLM_MODE = 'real';
  env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
  return env;
}

function isolatedScript(source: 'config-dir' | 'default-root' | 'mirror'): string {
  return `
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setElanousConfigDir } from ${mod('../elanous-config-dir.ts')};
import { setUserConfigOverlay } from ${mod('../user-config.ts')};
import { getProviderForConfig } from ${mod('../llm.ts')};
import { authStorePath } from ${mod('./store.ts')};
import { codexOwnerMirrorAuthPath } from ${mod('./codex-owner-mirror.ts')};
import { readCodexOwnerMirrorForRun } from ${mod('./codex.ts')};
import { isCodexUnauthorized } from ${mod('./codex-account-health.ts')};
import { withFakeFetchDevice } from ${mod('../ux-sim/fake-fetch.ts')};

const source = ${JSON.stringify(source)};
const home = process.env.HOME;
if (!home) throw new Error('missing-home');
const configDir = join(home, 'config');
setElanousConfigDir(configDir);
setUserConfigOverlay((config) => ({
  ...config,
  llm: { ...config.llm, codexTokenOwnerHost: 'owner-host', codexAccountRotation: false },
  hq: { ...config.hq, hostName: 'other-host' },
}));

const names = ['config-dir', 'default-root', 'mirror'];
const pairs = {
  'config-dir': { access: 'fixture-access-cfg', refresh: 'fixture-refresh-cfg' },
  'default-root': { access: 'fixture-access-def', refresh: 'fixture-refresh-def' },
  mirror: { access: 'fixture-access-mir', refresh: '' },
};
const third = { access: 'fixture-access-third', refresh: 'fixture-refresh-third' };
const thirdKey = 'openai-codex:third';

function primaryFresh(kind) {
  if (kind === 'mirror') return true;
  if (kind === 'config-dir') return source === 'config-dir';
  return source !== 'mirror';
}
function healthCredential(kind, pair) {
  return kind === 'mirror' ? pair.access : pair.refresh;
}
function providerRecord(kind, pair, fresh) {
  const expiresAt = fresh ? Date.now() + 3_600_000 : Date.now() - 3_600_000;
  const tokens = kind === 'mirror'
    ? { accessToken: pair.access, refreshToken: '', refresh_token: '', expiresAt }
    : { accessToken: pair.access, refreshToken: pair.refresh, expiresAt };
  return {
    authMode: 'chatgpt',
    tokens,
    lastRefresh: 'fixture-stamp',
    ...(kind === 'default-root' ? { accountUuid: 'acct-1', chatGPT: { accountId: 'acct-1' } } : {}),
  };
}
function healthPath(storePath, storeKey, credential) {
  const key = createHash('sha256').update(storeKey).digest('hex');
  const fingerprint = createHash('sha256').update(credential).digest('hex');
  return join(dirname(storePath), 'codex-account-health', key + '-' + fingerprint + '.json');
}
function plantHealth(storePath, storeKey, credential) {
  const path = healthPath(storePath, storeKey, credential);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fingerprint = createHash('sha256').update(credential).digest('hex');
  writeFileSync(path, JSON.stringify({ fingerprint, at: 1 }), { mode: 0o600 });
  return path;
}

const paths = {
  'config-dir': authStorePath(),
  'default-root': join(home, '.elanous', 'auth.json'),
  mirror: codexOwnerMirrorAuthPath(),
};
if (new Set(Object.values(paths)).size !== 3) throw new Error('path-collision');

const healthPaths = {};
for (const name of names) {
  const path = paths[name];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    providers: {
      'openai-codex': providerRecord(name, pairs[name], primaryFresh(name)),
      [thirdKey]: {
        authMode: 'chatgpt',
        tokens: { accessToken: third.access, refreshToken: third.refresh, expiresAt: Date.now() + 3_600_000 },
        lastRefresh: 'fixture-stamp',
        accountUuid: 'acct-3',
        chatGPT: { accountId: 'acct-3' },
      },
    },
  }), { mode: 0o600 });
  healthPaths[name] = {
    primary: plantHealth(path, 'openai-codex', healthCredential(name, pairs[name])),
    third: plantHealth(path, thirdKey, third.refresh),
  };
}

const selectedPath = paths[source];
if (source === 'mirror') {
  const explicit = readCodexOwnerMirrorForRun(selectedPath);
  if (explicit.storePath !== selectedPath || explicit.storeKey !== 'openai-codex') throw new Error('explicit-mirror-path');
}
const chosen = readCodexOwnerMirrorForRun();
if (chosen.storePath !== selectedPath || chosen.storeKey !== 'openai-codex') throw new Error('unexpected-store');

const watched = [];
for (const name of names) watched.push(paths[name], healthPaths[name].primary, healthPaths[name].third);
const before = new Map(watched.map((path) => [path, readFileSync(path)]));
const beforeDirs = new Map(names.map((name) => [
  name, readdirSync(dirname(healthPaths[name].primary)).sort().join('\\n'),
]));

const provider = getProviderForConfig({ llm: { provider: 'openai-codex', model: 'gpt-6.1-terra' } });
if (!provider.streamChat) throw new Error('missing-stream');
let sawStatus = false;
await withFakeFetchDevice([{
  url: 'https://chatgpt.com/backend-api/codex/responses',
  method: 'POST',
  response: () => new Response('unauthorized', { status: 401 }),
}], async () => {
  try {
    for await (const _ of provider.streamChat!([{ role: 'user', content: 'probe' }])) { /* drain */ }
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    if (status === 401) sawStatus = true;
  }
});
if (!sawStatus) throw new Error('missing-status');

const selectedHealth = healthPaths[source].primary;
const changed = [];
for (const [path, bytes] of before) {
  if (!readFileSync(path).equals(bytes)) changed.push(path);
}
if (changed.length !== 1 || changed[0] !== selectedHealth) throw new Error('byte-drift');
for (const name of names) {
  const now = readdirSync(dirname(healthPaths[name].primary)).sort().join('\\n');
  if (now !== beforeDirs.get(name)) throw new Error('health-dir:' + name);
}
const beforeHealth = JSON.parse(before.get(selectedHealth).toString('utf8'));
const afterHealth = JSON.parse(readFileSync(selectedHealth, 'utf8'));
if (beforeHealth.fingerprint !== afterHealth.fingerprint) throw new Error('selected-fingerprint');
if (typeof afterHealth.at !== 'number' || afterHealth.at === beforeHealth.at) throw new Error('selected-unchanged');

const selectedCredential = healthCredential(source, pairs[source]);
for (const name of names) {
  const marked = isCodexUnauthorized(paths[name], 'openai-codex', selectedCredential, paths[name]);
  if (name === source && !marked) throw new Error('selected-unmarked');
  if (name !== source && marked) throw new Error('other-marked:' + name);
  if (!isCodexUnauthorized(paths[name], 'openai-codex', healthCredential(name, pairs[name]), paths[name])) throw new Error('own-health-lost:' + name);
  if (!isCodexUnauthorized(paths[name], thirdKey, third.refresh, paths[name])) throw new Error('third-health-lost:' + name);
}
process.stdout.write(source + '-ok');
`;
}

function runIsolated(source: 'config-dir' | 'default-root' | 'mirror'): void {
  const root = mkdtempSync(join(tmpdir(), 'codex-sel-'));
  roots.push(root);
  const result = Bun.spawnSync(['bun', '-e', isolatedScript(source)], {
    cwd: repoRoot, env: childEnv(root), stdout: 'pipe', stderr: 'pipe',
  });
  const detail = redact(`${result.stderr.toString()}\n${result.stdout.toString()}`).slice(0, 800);
  expect(result.exitCode, detail).toBe(0);
  expect(redact(result.stdout.toString())).toContain(`${source}-ok`);
}

test('config-dir fake 401 changes only the selected health file', () => { runIsolated('config-dir'); });
test('default-root fake 401 changes only the selected health file', () => { runIsolated('default-root'); });
test('mirror fake 401 changes only the selected health file', () => { runIsolated('mirror'); });
