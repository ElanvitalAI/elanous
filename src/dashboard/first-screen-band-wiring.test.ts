import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { Terminal } from '@xterm/headless';
import { renderDashboardFirstScreenBand } from './index.js';
import { buildFirstScreenBand } from './first-screen-band.js';
import type { NexusShowResult } from '../cli/nexus-show.js';

test('empty chat history gets a band; lookup updates only its address row', async () => {
  const lines: string[] = [];
  const history = [{ role: 'system' }];
  const observations: object[] = [];
  let resolve!: (value: Pick<NexusShowResult, 'status' | 'urls'>) => void;
  let draws = 0;
  const pending = renderDashboardFirstScreenBand({
    history, lines, width: 80,
    show: () => new Promise((r) => { resolve = r; }),
    draw: () => { draws++; },
    observe: (value) => observations.push(value),
  });
  expect(lines).toEqual(buildFirstScreenBand({ width: 80, daemon: false }));
  await Promise.resolve();
  resolve({ status: 'registered', urls: {
    pwa: { loopback: 'http://127.0.0.1:3000/app/', tailnet: 'https://example.ts.net/app/' },
    rest: { loopback: 'http://127.0.0.1:3000/v1/' },
    sse: { loopback: 'http://127.0.0.1:3000/v1/events' },
  } });
  await pending;
  expect(lines).toEqual([
    buildFirstScreenBand({ width: 80, daemon: false })[0],
    buildFirstScreenBand({ width: 80, daemon: true, pwa: { loopback: 'http://127.0.0.1:3000/app/', tailnet: 'https://example.ts.net/app/' } })[1],
    buildFirstScreenBand({ width: 80, daemon: false })[2],
  ]);
  expect(observations).toEqual([{ daemon: true, hasPwa: true, hasTailnet: true }]);
  expect(draws).toBe(1);
});

test('already populated session leaves its transcript untouched without probing', async () => {
  const lines = ['restored transcript'];
  let called = false;
  await renderDashboardFirstScreenBand({
    history: [{ role: 'system' }, { role: 'user' }], lines, width: 80,
    show: async () => { called = true; return { status: 'absent' }; },
    draw: () => {}, observe: () => {},
  });
  expect(lines).toEqual(['restored transcript']);
  expect(called).toBe(false);
});

test('lookup rejection does not block first screen or log secrets', async () => {
  const lines: string[] = [];
  const observations: object[] = [];
  await renderDashboardFirstScreenBand({
    history: [], lines, width: 60,
    show: async () => { throw new Error('secret-token'); },
    draw: () => { throw new Error('should not draw'); },
    observe: (value) => observations.push(value),
  });
  expect(lines).toEqual(buildFirstScreenBand({ width: 60, daemon: false }));
  expect(observations).toEqual([{ daemon: false, hasPwa: false, hasTailnet: false }]);
});

// ⚠️ 맥(BSD `script`)은 표준 입력이 진짜 터미널이어야 PTY 를 세운다 — 이 시험처럼 파이프로 띄우면
//  «tcgetattr/ioctl: Operation not supported on socket» 로 시작도 못 한다(0.2.9 게이트 10-02 실측).
//  리눅스(util-linux `script` · 하니스 파드)에서는 그대로 돈다. 맥에서도 돌게 하는 것은 0.2.10 칸(드라이버 `scripts/drive-tui.ts` 로 옮기기).
test.skipIf(process.platform === 'darwin')('showDashboard renders the startup band before and after the real first chat input', async () => {
  mkdirSync(resolve(import.meta.dir, '../../.elanous-test'), { recursive: true });
  const testRoot = mkdtempSync(resolve(import.meta.dir, '../../.elanous-test/first-screen-'));
  writeFileSync(resolve(testRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true } }));
  // `script` 는 판마다 문법이 다르다 — util-linux(리눅스 파드) `-qfec "<명령>" <파일>` · BSD(맥 게이트) `-q <파일> <명령…>`.
  //  리눅스 문법만 쓰면 맥에서 «illegal option -- f» 로 시작도 못 한다(0.2.9 게이트 10-02 실측).
  const command = ['bun', 'bin/elanous.mjs', `--test=${testRoot}`, '--chat-only'];
  const scriptArgs = process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qfec', command.join(' '), '/dev/null'];
  const child = spawn('script', scriptArgs, {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, NODE_ENV: 'test', TERM: 'xterm-256color', NO_COLOR: '1', COLUMNS: '120', LINES: '48' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const terminal = new Terminal({ cols: 120, rows: 48, scrollback: 200, allowProposedApi: true });
  let allOutput = '';
  let status: number | null | undefined;
  const exited = new Promise<void>((done) => {
    child.on('exit', (exitCode) => { status = exitCode; done(); });
  });
  const render = (chunk: Buffer): void => {
    allOutput += chunk.toString();
    terminal.write(chunk.toString());
  };
  child.stdout!.on('data', render);
  child.stderr!.on('data', render);
  const currentFrame = async (): Promise<string[]> => {
    await new Promise<void>((done) => terminal.write('', done));
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, y) =>
      buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
  };
  const waitFor = async (check: (frame: string[]) => boolean, label: string): Promise<string[]> => {
    const deadline = Date.now() + 20_000;
    let frame = await currentFrame();
    while (!check(frame) && status === undefined && Date.now() < deadline) {
      await Bun.sleep(50);
      frame = await currentFrame();
    }
    if (!check(frame)) throw new Error(`dashboard ${label}: exit=${status}, frame=${frame.join('\n').slice(-1200)}, output=${stripVTControlCharacters(allOutput).slice(-600)}`);
    return frame;
  };
  try {
    const historyArea = (frame: string[]): string[] => {
      const header = frame.findIndex((line) => line.includes('ChatLog'));
      const footer = frame.findIndex((line, index) => index > header && /^─{8}/.test(line));
      return header >= 0 && footer > header ? frame.slice(header + 1, footer) : [];
    };
    const before = await waitFor((frame) => historyArea(frame).some((line) => line.includes('Type a message to begin')), 'initial band');
    expect(historyArea(before).join('\n')).toContain('PWA:');
    expect(historyArea(before).join('\n')).not.toContain('band-retention-probe');
    child.stdin!.write('band-retention-probe\r');
    const after = await waitFor((frame) => {
      const history = historyArea(frame);
      return history.some((line) => line.includes('❯ band-retention-probe'))
        && history.some((line) => line.includes('Type a message to begin'))
        && history.some((line) => line.includes('PWA:'))
        && frame.some((line) => line.trim() === '❯');
    }, 'submitted input in transcript');
    expect(historyArea(after)).toEqual(expect.arrayContaining([
      expect.stringContaining('❯ band-retention-probe'),
      expect.stringContaining('Type a message to begin'),
      expect.stringContaining('PWA:'),
    ]));
  } finally {
    child.kill();
    await exited;
    terminal.dispose();
  }
}, 30_000);
