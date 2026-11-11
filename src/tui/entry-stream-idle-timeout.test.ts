import { NEXT_TUI_TITLE } from './core/render.js';
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
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20' },
      ready: { label: 'next-tui-ready', timeoutMs: 30_000, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') }, // Source: #36661
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

test('next TUI shows transient retry status and does not retain it in the transcript', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-stream-idle-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      llm: { goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
    }));
    const reply = '재시도 응답 조각';
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      rows: 24,
      cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20',
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_SCRIPT: 'stall:초기 응답 조각,stall:재시도 응답 조각',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: reply,
        ELANOUS_TEST_FAKE_LLM_IDLE_TIMEOUT_MS: '1000',
      },
      ready: { label: 'next-tui-ready', timeoutMs: 30_000, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') }, // Source: #36661
      steps: [{
        label: 'idle-timeout-retry-status-line',
        text: 'idle timeout 화면 복구 확인',
        timeoutMs: 30_000,
        until: (screen) => screen.includes('스트림 무응답 · 재시도 1/1'),
      }, {
        label: 'idle-timeout-retry-settled',
        // Source: .rules/30-harness/testing-gates.md — preserve the established PTY step deadline.
        timeoutMs: 30_000,
        until: (screen) => screen.includes(reply) && screen.includes('응답 완료'),
      }],
      quitKeys: '\x11',
    });

    expect(run.frames[1]?.screen).toContain('스트림 무응답 · 재시도 1/1');
    expect(run.frames[2]?.screen).toContain(reply);
    expect(run.frames[2]?.screen).toContain('응답 완료');
    expect(run.frames[2]?.screen).not.toContain('스트림 무응답 · 재시도 1/1');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
