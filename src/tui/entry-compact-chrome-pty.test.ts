import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

test('20-row next TUI hides informational chrome but keeps the approval panel and exit route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-compact-chrome-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const target = join(root, 'target');
    mkdirSync(target);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 20, cols: 60,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'delete fixture', name: 'Bash', args: { command: `rm -rf '${target}'` } }) },
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('Ctrl+Q 종료'), timeoutMs: 8_000 }, // Source: #36661
      steps: [
        { label: 'approval', text: 'delete fixture', until: (screen) => screen.includes('Bash 실행 승인') && screen.includes('Enter 기본 N'), timeoutMs: 15_000 }, // Source: #36690
        { label: 'denied', keys: '\r', until: (screen) => screen.includes('엘라누스:'), timeoutMs: 12_000 }, // Source: #36690
        { label: 'exit', text: 'exit', until: (screen) => screen.includes('elanous'), timeoutMs: 8_000 }, // Source: #36661
      ],
    });
    expect(run.frames[0]?.screen).toContain('Ctrl+Q 종료');
    expect(run.frames[0]?.screen).not.toContain('elanous next');
    expect(run.frames[1]?.screen).toContain('Enter 기본 N');
    expect(existsSync(target)).toBe(true);
    expect(run.frames[2]?.screen).not.toContain('Ctrl+Q 종료');
    expect(run.frames[2]?.screen).not.toContain('ctx ');
    expect(run.frames[2]?.screen).not.toContain('[자기 건강');
    expect(run.exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000); // Source: #36690

test('20-row next TUI keeps the slash selector visible before a turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-compact-selector-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 20, cols: 60,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('Ctrl+Q 종료'), timeoutMs: 8_000 }, // Source: #36690
      steps: [
        { label: 'selector', text: '/mo', enter: false, until: (screen) => screen.includes('/model') && screen.includes('Enter 실행'), timeoutMs: 8_000 }, // Source: #36690
        { label: 'selector-close', keys: '\x1b', until: (screen) => !screen.includes('Enter 실행'), timeoutMs: 8_000 }, // Source: #36690
      ],
    });
    expect(run.frames[1]?.screen).toContain('/model');
    expect(run.frames[2]?.screen).not.toContain('Enter 실행');
    expect(run.exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000); // Source: #36690

test('default 24-row compact view keeps failures and corrective instructions visible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-compact-action-status-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('Ctrl+Q 종료'), timeoutMs: 8_000 }, // Source: #36661
      steps: [
        { label: 'no-content', text: '/compact', until: (screen) => screen.includes('압축할 내용 없음 · 0 메시지'), timeoutMs: 8_000 }, // Source: #36661
        { label: 'how-to-correct', text: '/tasks stop x', until: (screen) => screen.includes('작업 ID를 고유한 4자 이상 앞자리로 입력하세요'), timeoutMs: 8_000 }, // Source: #36661
        { label: 'exit', text: 'exit', until: (screen) => screen.includes('elanous'), timeoutMs: 8_000 }, // Source: #36661
      ],
    });
    expect(run.frames[1]?.screen).toContain('압축할 내용 없음 · 0 메시지');
    expect(run.frames[2]?.screen).toContain('작업 ID를 고유한 4자 이상 앞자리로 입력하세요');
    expect(run.frames[2]?.screen).not.toContain('Ctrl+Q 종료');
    expect(run.exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
