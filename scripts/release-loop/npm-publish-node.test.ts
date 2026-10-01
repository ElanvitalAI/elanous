import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNpmPublish, type NpmPublishDeps } from './npm-publish-node.js';
import type { GraphContext } from './node-verdict.js';

const VERSION = '0.2.6';
const TOKEN = 'fixture-secret-token-123';
function fixture(options: { archiveVersion?: string; publish?: { status: number; stdout: string; stderr: string }; visible?: boolean; wait?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'npm-publish-test-'));
  const tokenFile = join(root, 'secrets', 'npm-token');
  mkdirSync(join(root, 'secrets'));
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const context: GraphContext = { input: { version: VERSION, previousVersion: '0.2.5', npmTokenFile: tokenFile, npmWaitMinutes: options.wait ?? 0 }, outputs: { publish: { outcome: 'ok' } } };
  const commands: string[] = [];
  const alerts: string[] = [];
  const logs: Array<[string, number]> = [];
  let npmrc = '';
  let mode = 0;
  const deps: NpmPublishDeps = {
    stateDir: root,
    exec: (command, args, env) => {
      commands.push(`${command} ${args.join(' ')}`);
      if (command === 'tar') return { status: 0, stdout: JSON.stringify({ name: 'elanous', version: options.archiveVersion ?? VERSION }), stderr: '' };
      npmrc = env?.NPM_CONFIG_USERCONFIG ?? '';
      mode = statSync(npmrc).mode & 0o777;
      expect(readFileSync(npmrc, 'utf8')).toBe(`//registry.npmjs.org/:_authToken=${TOKEN}\n`);
      return options.publish ?? { status: 0, stdout: `+ elanous@${VERSION}`, stderr: '' };
    },
    registry: async (url) => url.endsWith(`/${VERSION}`)
      ? { status: options.visible ? 200 : 404, body: options.visible ? { name: 'elanous', version: VERSION } : null }
      : { status: 200, body: { 'dist-tags': { latest: options.visible ? VERSION : '0.2.5' } } },
    sleep: async () => {},
    alert: (text) => { alerts.push(text); return true; },
    log: (v, minutes) => { logs.push([v, minutes]); },
  };
  return { root, context, deps, commands, alerts, logs, get npmrc() { return npmrc; }, get mode() { return mode; } };
}

test('visible package is already published: no npm publish and no token file read', async () => {
  const f = fixture({ visible: true });
  try {
    rmSync(join(f.root, 'secrets', 'npm-token'));
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'already-published' });
    expect(f.commands.map((x) => x.split(' ')[0])).toEqual(['tar']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('visible version waits for matching latest tag without republishing', async () => {
  const f = fixture({ wait: 1 });
  let checks = 0;
  const intervals: number[] = [];
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: 200, body: { name: 'elanous', version: VERSION } }
    : { status: 200, body: { 'dist-tags': { latest: ++checks >= 3 ? VERSION : '0.2.5' } } };
  f.deps.sleep = async (ms) => { intervals.push(ms); };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'already-published' });
    expect(intervals).toEqual([30_000]);
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('visible version with stale latest tag fails after the wait without republishing or staging alert', async () => {
  const f = fixture({ wait: 1 });
  const intervals: number[] = [];
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: 200, body: { name: 'elanous', version: VERSION } }
    : { status: 200, body: { 'dist-tags': { latest: '0.2.5' } } };
  f.deps.sleep = async (ms) => { intervals.push(ms); };
  try {
    const result = await runNpmPublish(f.context, f.deps);
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(result.summary).toContain('dist-tags.latest did not reach');
    expect(intervals).toEqual([30_000, 30_000]);
    expect(f.commands).toHaveLength(1);
    expect(f.alerts).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('archive package/version mismatch fails before publishing', async () => {
  const f = fixture({ archiveVersion: '0.2.5' });
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', verdict: 'fail' });
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('published version becomes visible with latest tag and removes 0600 npmrc', async () => {
  const f = fixture();
  let polls = 0;
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? { status: polls++ > 1 ? 200 : 404, body: { name: 'elanous', version: VERSION } }
    : { status: 200, body: { 'dist-tags': { latest: polls > 2 ? VERSION : '0.2.5' } } };
  f.context.input.npmWaitMinutes = 1;
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'published' });
    expect(f.commands[1]).toBe(`npm publish ${join(f.root, 'release', VERSION, 'prepared', 'dist', 'elanous.tgz')} --ignore-scripts --tag latest --access public`);
    expect(f.mode).toBe(0o600);
    expect(existsSync(f.npmrc)).toBe(false);
    expect(f.alerts).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('E409 previously staged reports human action, logs and alerts once without republishing', async () => {
  const f = fixture({ publish: { status: 1, stdout: '', stderr: `npm ERR! code E409 Cannot publish over previously staged version "${VERSION}"` } });
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible', humanAction: 'npm-support', summary: 'npm 스테이징 — 레지스트리에 아직 없음' });
    expect(f.commands.filter((command) => command.startsWith('npm publish'))).toHaveLength(1);
    expect(f.alerts).toEqual([`npm ${VERSION} 가 스테이징에 멈춤 — 계정 소유자 확인 필요`]);
    expect(f.logs).toEqual([[VERSION, 0]]);
    expect(existsSync(f.npmrc)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('successful publish that never appears is staged and waits in 30s intervals', async () => {
  const f = fixture({ wait: 1 });
  const intervals: number[] = [];
  f.deps.sleep = async (ms) => { intervals.push(ms); };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible', humanAction: 'npm-support' });
    expect(intervals).toEqual([30_000, 30_000]);
    expect(f.logs).toEqual([[VERSION, 1]]);
    expect(f.alerts).toHaveLength(1);
    expect(existsSync(f.npmrc)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('default registry wait lasts 40 minutes before staging report', async () => {
  const f = fixture();
  delete f.context.input.npmWaitMinutes;
  let waitedMs = 0;
  let polls = 0;
  f.deps.sleep = async (ms) => { expect(ms).toBe(30_000); waitedMs += ms; };
  f.deps.registry = async (url) => url.endsWith(`/${VERSION}`)
    ? (polls++, { status: 404, body: null })
    : { status: 200, body: { 'dist-tags': { latest: '0.2.5' } } };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'ok', npm: 'staged-not-visible', humanAction: 'npm-support' });
    expect(waitedMs).toBe(40 * 60_000);
    expect(polls).toBe(82);
    expect(f.logs).toEqual([[VERSION, 40]]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('wait override cannot outlive the node recipe', async () => {
  const f = fixture({ wait: 41 });
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', summary: 'npm 0.2.6 failed: input.npmWaitMinutes must be between 0 and 40' });
    expect(f.commands).toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('registry network failure fails without attempting publication', async () => {
  const f = fixture();
  f.deps.registry = async () => { throw new Error('network unavailable'); };
  try {
    expect(await runNpmPublish(f.context, f.deps)).toMatchObject({ outcome: 'fail', summary: 'npm 0.2.6 failed: network unavailable' });
    expect(f.commands).toHaveLength(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('E401 and thrown command errors fail without disclosing token, cleaning npmrc', async () => {
  const f = fixture({ publish: { status: 1, stdout: TOKEN, stderr: `E401 unauthorized ${TOKEN}` } });
  try {
    const result = await runNpmPublish(f.context, f.deps);
    expect(result.outcome).toBe('fail');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(existsSync(f.npmrc)).toBe(false);
    expect(f.alerts).toEqual([]);
    let thrownNpmrc = '';
    f.deps.exec = (command, args, env) => {
      if (command === 'tar') return { status: 0, stdout: JSON.stringify({ name: 'elanous', version: VERSION }), stderr: '' };
      thrownNpmrc = env?.NPM_CONFIG_USERCONFIG ?? '';
      expect(existsSync(thrownNpmrc)).toBe(true);
      throw new Error(`spawn failed: ${TOKEN}`);
    };
    expect(JSON.stringify(await runNpmPublish(f.context, f.deps))).not.toContain(TOKEN);
    expect(existsSync(thrownNpmrc)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
