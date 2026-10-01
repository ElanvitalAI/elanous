import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnboardingStep, scriptedIO } from '../src/onboarding.js';
import { fullScreenIO } from '../src/onboarding/full-screen-io.js';
import { ANSI_CLEAR_HOME } from '../src/onboarding/screen-renderer.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codex-order-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const codex = join(bin, 'codex');
  writeFileSync(codex, '#!/bin/sh\nexit 0\n');
  chmodSync(codex, 0o755);
  const io = scriptedIO(['1', '1', '1']);
  const order: string[] = [];
  return { root, bin, codex, io, order };
}

const result = (ok: boolean) => ({ ok, exitCode: ok ? 0 : 1, mode: 'browser' as const, output: '' });

function renderedLoginIO() {
  let waiting: ((key: string) => void) | undefined;
  const input = {
    isTTY: true,
    setRawMode: () => {}, setEncoding: () => {}, resume: () => {}, pause: () => {},
    on: (event: string, cb: (key: string) => void) => {
      if (event !== 'data') return;
      waiting = cb;
    },
    off: (event: string, cb: (key: string) => void) => {
      if (event === 'data' && waiting === cb) waiting = undefined;
    },
  } as unknown as NodeJS.ReadStream;
  const writes: string[] = [];
  const output = { write: (s: string) => { writes.push(s); return true; }, columns: 120, rows: 40 } as unknown as NodeJS.WriteStream;
  return { io: fullScreenIO({ input, output }), writes, press: (key: string) => {
    if (!waiting) throw new Error('no pending picker');
    waiting(key);
  } };
}

test('GUI: built-in browser succeeds without a PATH Codex or device code', async () => {
  const { root, io, order } = setup();
  await runOnboardingStep('llm', { io, path: join(root, 'config.json'), grokDeps: {
    detectProviders: async () => [], hasCodexCliLogin: () => false, loadCodexTokens: () => null, isHeadless: () => false,
    codexEnv: { PATH: join(root, 'missing') },
    loginWithCodexBrowser: async () => { order.push('browser'); return {} as never; },
    spawnCodexLogin: async () => { order.push('path'); return result(true); },
    loginWithCodex: async () => { order.push('device'); return {} as never; },
  } });
  expect(order).toEqual(['browser']);
  expect(io.outputs.join('\n')).not.toContain('코드로 이어갑니다');
});

test('browser failure with a successful PATH Codex login skips device code', async () => {
  const { root, bin, codex, io, order } = setup();
  await runOnboardingStep('llm', { io, path: join(root, 'config.json'), grokDeps: {
    detectProviders: async () => [], hasCodexCliLogin: () => false, loadCodexTokens: () => null, isHeadless: () => false,
    codexEnv: { PATH: bin },
    loginWithCodexBrowser: async () => { order.push('browser'); throw new Error('unavailable'); },
    spawnCodexLogin: async opts => { expect(opts.codexPath).toBe(codex); order.push('path'); return result(true); },
    loginWithCodex: async () => { order.push('device'); return {} as never; },
  } });
  expect(order).toEqual(['browser', 'path']);
  expect(io.outputs.join('\n')).not.toContain('코드로 이어갑니다');
});

test('browser failure uses PATH Codex before device; fallback screen drops stale waiting copy', async () => {
  const { root, bin, codex, io, order } = setup();
  await runOnboardingStep('llm', { io, path: join(root, 'config.json'), grokDeps: {
    detectProviders: async () => [], hasCodexCliLogin: () => false, loadCodexTokens: () => null, isHeadless: () => false,
    codexEnv: { PATH: bin },
    loginWithCodexBrowser: async () => { order.push('browser'); throw new Error('unavailable'); },
    spawnCodexLogin: async opts => { expect(opts.codexPath).toBe(codex); order.push('path'); return result(false); },
    loginWithCodex: async opts => {
      order.push('device');
      opts?.onProgress?.({ type: 'user_code', loginUrl: 'https://example.test/device', userCode: 'ABCD' });
      opts?.onProgress?.({ type: 'saved' });
      return {} as never;
    },
    runAuthCommand: () => false, writeAuthTerminal: () => false,
  } });
  expect(order).toEqual(['browser', 'path', 'device']);
  const printed = io.outputs.join('\n');
  expect(printed).toContain('브라우저 로그인이 안 됐습니다 — 코드로 이어갑니다');
  expect(printed.indexOf('코드로 이어갑니다')).toBeLessThan(printed.indexOf('Enter code:'));
  expect(printed).toContain('Enter code:          ABCD');
  expect(printed.slice(printed.indexOf('코드로 이어갑니다'))).not.toContain('자동으로 이어집니다');
});

test('full-screen device-code paint has no browser waiting hint after fallback', async () => {
  const { root, bin, codex, order } = setup();
  const { io, writes, press } = renderedLoginIO();
  let painted = '';
  const run = runOnboardingStep('llm', { io, path: join(root, 'config.json'), grokDeps: {
    detectProviders: async () => [], hasCodexCliLogin: () => false, loadCodexTokens: () => null, isHeadless: () => false,
    codexEnv: { PATH: bin },
    loginWithCodexBrowser: async () => { order.push('browser'); throw new Error('unavailable'); },
    spawnCodexLogin: async opts => { expect(opts.codexPath).toBe(codex); order.push('path'); return result(false); },
    loginWithCodex: async opts => {
      order.push('device');
      opts?.onProgress?.({ type: 'user_code', loginUrl: 'https://example.test/device', userCode: 'ABCD' });
      painted = writes.join('').split(ANSI_CLEAR_HOME).at(-1)!;
      opts?.onProgress?.({ type: 'saved' });
      return {} as never;
    },
    runAuthCommand: () => false, writeAuthTerminal: () => false,
  } });
  // Drive the actual full-screen pickers one at a time, after each readKey has attached.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  press('1');
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  press('1');
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  press('1');
  await run;
  expect(painted).toContain('Enter code:');
  expect(painted).toContain('ABCD');
  expect(painted).toContain('코드로 이어갑니다');
  expect(painted).not.toContain('브라우저에서 로그인을 마치세요');
  expect(painted).not.toContain('자동으로 이어집니다');
  expect(order).toEqual(['browser', 'path', 'device']);
});

test('no PATH Codex skips binary and enters device code; headless skips both browser attempts', async () => {
  for (const headless of [false, true]) {
    const { root, io, order } = setup();
    await runOnboardingStep('llm', { io, path: join(root, 'config.json'), grokDeps: {
      detectProviders: async () => [], hasCodexCliLogin: () => false, loadCodexTokens: () => null, isHeadless: () => headless,
      codexEnv: { PATH: join(root, 'empty') },
      loginWithCodexBrowser: async () => { order.push('browser'); throw new Error('unavailable'); },
      spawnCodexLogin: async () => { order.push('path'); return result(false); },
      loginWithCodex: async () => { order.push('device'); return {} as never; },
    } });
    expect(order).toEqual(headless ? ['device'] : ['browser', 'device']);
  }
});
