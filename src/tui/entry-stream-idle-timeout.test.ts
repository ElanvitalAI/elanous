import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

test('next TUI /help shows Commands and Keys in the terminal screen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-help-keys-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      llm: { goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
    }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      rows: 24,
      cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions') },
      ready: { label: 'next-tui-ready', timeoutMs: 30_000, until: (screen) => screen.includes('elanous next ·') && screen.includes('Ctrl+Q 종료') },
      steps: [{
        label: 'help-keys-visible',
        text: '/help',
        timeoutMs: 30_000,
        until: (screen) => screen.includes('Commands') && screen.includes('Keys') && screen.includes('PgUp/PgDn'),
      }],
      quitKeys: '\x11',
    });

    const helpScreen = run.frames.at(-1)?.screen ?? '';
    expect(helpScreen).toContain('Commands');
    expect(helpScreen).toContain('Keys');
    expect(helpScreen).toContain('PgUp/PgDn');
    expect(helpScreen).toContain('Ctrl+\\');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

test('next TUI shows idle retry status and the retried answer in its PTY screen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-stream-idle-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      llm: { goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
    }));
    const reply = '재시도 뒤 응답';
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      rows: 24,
      cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_SCRIPT: 'stall:초기 응답 조각,ok',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: reply,
        ELANOUS_TEST_FAKE_LLM_IDLE_TIMEOUT_MS: '50',
      },
      ready: { label: 'next-tui-ready', timeoutMs: 30_000, until: (screen) => screen.includes('elanous next ·') && screen.includes('Ctrl+Q 종료') },
      steps: [{
        label: 'idle-timeout-retry-visible-and-recovered',
        text: 'idle timeout 화면 복구 확인',
        timeoutMs: 30_000,
        until: (screen) => screen.includes('스트림 무응답 · 재시도 1/1') && screen.includes(reply) && screen.includes('응답 완료'),
      }],
      quitKeys: '\x11',
    });

    expect(run.frames[1]?.screen).toContain('스트림 무응답 · 재시도 1/1');
    expect(run.frames[1]?.screen).toContain(reply);
    expect(run.frames[1]?.screen).toContain('응답 완료');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
