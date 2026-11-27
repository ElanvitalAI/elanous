// APP-BUILD-LOCAL-PATH — no member connection: build locally, say so up front, resolve capabilities, no dead end.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalAppBuild, startLocalApp } from './local-build.js';
import type { CapabilityProbe } from './capability-resolution.js';

const ASK = '나는 번역 서비스를 만들고 싶어. 백엔드, 프론트 구성하고 만들어줘';
const KEY = 'sk-or-v1-localbuild-secret';
const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid); } catch { /* gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const cwd = () => { const dir = mkdtempSync(join(tmpdir(), 'eln-local-build-')); dirs.push(dir); return dir; };
const providerProbe = async (): Promise<CapabilityProbe> => ({ llmSecrets: [], secretNames: [], local: { tools: [] },
  provider: { name: 'openrouter', model: 'z-ai/glm-5.3', baseUrl: 'https://openrouter.ai/api/v1', hasKey: true, injectable: true } });
const allText = (root: string): string => readdirSync(root, { recursive: true }).map(String)
  .filter(path => statSync(join(root, path)).isFile()).map(path => readFileSync(join(root, path), 'utf8')).join('\n');

test('(i) no member + provider available → local workspace, LLM translation, no card, one truthful message', async () => {
  const root = cwd();
  const out = await runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe,
    start: async () => ({ started: true, port: 31511, localUrl: 'http://127.0.0.1:31511/', tailnetUrl: 'https://host.ts.net:31511/', stop: 'kill 1' }) });
  expect(out).toMatchObject({ status: 'local-build', mode: 'local', memberConnected: false, buildComplete: true, choices: [] });
  expect(out.workspace).toBe(join(root, 'translator'));
  expect(out.capabilities).toEqual([{ capability: 'translation', status: 'resolved', runMode: 'live',
    summary: '번역 = LLM (지금 eln 공급자 openrouter · z-ai/glm-5.3 · 키는 실행 때 env 로 주입)' }]);
  expect(out.files).toEqual(['ARCHITECTURE.md', 'backend/eln-llm.ts', 'backend/entry.test.ts', 'backend/entry.ts', 'eln-app.json', 'frontend/index.html']);
  expect(out.message.split('\n')[0]).toBe(`회원 연결이 없어 공개 게시 대신 이 기기에서 로컬로 만들었습니다: ${out.workspace}`);
  expect(out.message).toContain('https://host.ts.net:31511/');
  expect(out.message).not.toContain('불가능');
  const manifest = JSON.parse(readFileSync(join(out.workspace, 'eln-app.json'), 'utf8'));
  expect(manifest.capabilities[0]).toMatchObject({ key: { kind: 'provider', provider: 'openrouter' }, keyEnv: 'ELN_LLM_API_KEY' });
});

test('(ii) no key anywhere → still built (mock) and the numbered card is in the same message', async () => {
  const root = cwd();
  const out = await runLocalAppBuild({ ask: '번역 서비스 만들어줘', cwd: root }, {
    probe: async () => ({ llmSecrets: [], secretNames: [], local: { tools: [] } }),
    start: async () => ({ started: true, port: 31512, localUrl: 'http://127.0.0.1:31512/', stop: 'kill 2' }) });
  expect(out.status).toBe('local-build');
  expect(out.choices).toHaveLength(1);
  expect(out.message).toContain('1) LLM 번역 사용 (OpenRouter 키 연결) · 추천 — eln secret set OPENROUTER_API_KEY');
  expect(out.message).toContain('번역 = 모의 응답');
});

test('a second build never overwrites the first workspace', async () => {
  const root = cwd();
  const start = async () => ({ started: false, reason: 'test' });
  const first = await runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe, start });
  const second = await runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe, start });
  expect(second.workspace).toBe(`${first.workspace}-2`);
  expect(second.buildComplete).toBe(false);
  expect(second.message).toContain(`아직 실행 안 됨: test · 다시 띄우기: eln app run-local ${second.workspace}`);
});

test('the generated app passes its own tests (mock adapter) and starts with the key only in its env', async () => {
  const root = cwd();
  const out = await runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe, start: async () => ({ started: false, reason: 'later' }) });
  const tests = spawnSync(process.execPath, ['test'], { cwd: out.workspace, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  expect(`${tests.stdout}${tests.stderr}`).toContain(' 0 fail');
  expect(tests.status).toBe(0);
  // Start for real with a fake key: the app answers in live mode against a local fake provider.
  let seenAuth = '';
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    seenAuth = request.headers.get('authorization') ?? '';
    return Response.json({ choices: [{ message: { content: 'Hello' } }] });
  } });
  try {
    const run = await startLocalApp(out.workspace, {
      runEnv: async () => ({ env: { ELN_LLM_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, ELN_LLM_MODEL: 'z-ai/glm-5.3', ELN_LLM_API_KEY: KEY }, missing: [] }),
      share: async () => ({ reason: 'tailnet skipped in test' }) });
    if (run.pid) pids.push(run.pid);
    expect(run).toMatchObject({ started: true, reason: 'tailnet skipped in test' });
    const response = await fetch(`${run.localUrl}api/translate`, { method: 'POST', body: JSON.stringify({ text: '안녕하세요', target: 'English' }) });
    expect(await response.json()).toEqual({ result: 'Hello', mode: 'live' });
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    expect(allText(out.workspace)).not.toContain(KEY);
  } finally { provider.stop(true); }
});

/** A child that never answers health; `exitNow` simulates a lost bind (EADDRINUSE → exit). */
function fakeChild(pid: number, exitNow: boolean): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid, unref: () => {} }) as unknown as ChildProcess;
  if (exitNow) setTimeout(() => child.emit('exit', 1), 0);
  return child;
}

test('(4) a different service answering /health on the chosen port is never taken for the app nor shared', async () => {
  const root = cwd();
  const out = await runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe, start: async () => ({ started: false, reason: 'later' }) });
  let squatter: ReturnType<typeof Bun.serve> | undefined;
  let shared = 0;
  try {
    const run = await startLocalApp(out.workspace, {
      runEnv: async () => ({ env: {}, missing: [] }), healthTimeoutMs: 800,
      share: async () => { shared++; return { url: 'https://x' }; },
      // The «child» never binds; another service grabs its port first and answers 200 with someone else's pid.
      spawnApp: (_entry, options) => {
        squatter = Bun.serve({ hostname: '127.0.0.1', port: Number(options.env!.PORT), fetch: () => Response.json({ ok: true, pid: 1, nonce: 'other' }) });
        return fakeChild(999_999_001, false);
      },
    });
    expect(run.started).toBe(false);
    expect(run.reason).toContain('health check failed');
    expect(shared).toBe(0);
  } finally { squatter?.stop(true); }
});

test('(4) a child that loses the bind moves to the next port; only its own pid+nonce counts', async () => {
  const root = cwd();
  const out = await runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe, start: async () => ({ started: false, reason: 'later' }) });
  const ports: number[] = [];
  let attempt = 0;
  const run = await startLocalApp(out.workspace, {
    runEnv: async () => ({ env: { ELN_LLM_MOCK: '1' }, missing: [] }), share: async () => ({ reason: 'tailnet 공유 안 됨(tailscale-missing)' }),
    spawnApp: (entry, options) => {
      ports.push(Number(options.env!.PORT));
      if (attempt++ === 0) return fakeChild(999_999_002, true);
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      return spawn(process.execPath, [entry], options);
    },
  });
  if (run.pid) pids.push(run.pid);
  expect(ports.length).toBe(2);
  expect(ports[1]!).toBeGreaterThan(ports[0]!);
  expect(run).toMatchObject({ started: true, port: ports[1], reason: 'tailnet 공유 안 됨(tailscale-missing)' });
  const health = await (await fetch(`${run.localUrl}health`)).json() as { pid: number };
  expect(health.pid).toBe(run.pid!);
});

test('(5) concurrent builds and a pre-existing folder each get their own workspace', async () => {
  const root = cwd();
  mkdirSync(join(root, 'translator'));
  const start = async () => ({ started: false, reason: 'test' });
  const [a, b] = await Promise.all([
    runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe, start }),
    runLocalAppBuild({ ask: ASK, cwd: root }, { probe: providerProbe, start }),
  ]);
  expect(new Set([a.workspace, b.workspace])).toEqual(new Set([join(root, 'translator-2'), join(root, 'translator-3')]));
  expect(readdirSync(join(root, 'translator'))).toEqual([]);
});

test('(6) the message reports the real run mode: a key unread at start is named as mock, and the tailnet reason is shown', async () => {
  const root = cwd();
  const out = await runLocalAppBuild({ ask: ASK, cwd: root }, { probe: async () => ({ secretNames: ['OPENROUTER_API_KEY'], local: { tools: [] },
    llmSecrets: [{ name: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3' }] }),
    start: async () => ({ started: true, port: 31520, localUrl: 'http://127.0.0.1:31520/', mockCapabilities: ['translation'],
      reason: 'tailnet 공유 안 됨(tailscale-down)', stop: 'kill 9' }) });
  expect(out.capabilities[0]).toMatchObject({ capability: 'translation', runMode: 'mock' });
  expect(out.message).toContain('실행 때 키(OPENROUTER_API_KEY)를 읽지 못해 지금은 모의 응답');
  expect(out.message).toContain('- 모의 응답으로 도는 능력: translation');
  expect(out.message).toContain('http://127.0.0.1:31520/ (이 기기 전용 · tailnet 공유 안 됨(tailscale-down))');
});
