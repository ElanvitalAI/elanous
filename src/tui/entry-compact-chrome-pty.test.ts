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
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('Ctrl+Q quit'), timeoutMs: 8_000 }, // Source: #36661 · 출처: #38163 문구 영문화
      steps: [
        { label: 'approval', text: 'delete fixture', until: (screen) => screen.includes('Bash approval') && screen.includes('Enter default N'), timeoutMs: 15_000 }, // 출처: #38163 문구 영문화 (src/tui/chat/status-line.ts:211,213) · 원출처 #36690
        { label: 'denied', keys: '\r', until: (screen) => !screen.includes('Bash approval') && screen.includes('Turn'), timeoutMs: 12_000 }, // 출처: #38163 문구 영문화 (status-line.ts:211) · 원출처 #36690
        { label: 'exit', text: '/exit', until: (screen) => screen.includes('elanous'), timeoutMs: 8_000 }, // 출처: #36865 — bare exit words stay chat; the exit route is the slash route '/exit' (src/tui/core/registry.ts:47 → action quit)
      ],
    });
    expect(run.frames[0]?.screen).toContain('Ctrl+Q quit'); // 출처: #38163 문구 영문화
    expect(run.frames[0]?.screen).not.toContain('elanous next');
    expect(run.frames[1]?.screen).toContain('Enter default N'); // 출처: #38163 문구 영문화 (status-line.ts:213) · 원출처 #36690
    expect(existsSync(target)).toBe(true);
    expect(run.frames[2]?.screen).toContain('Ctrl+Q quit'); // 출처: #38159 — compact post-turn note keeps the exit route (src/tui/entry.ts:2066 `Turn done · Enter send · Ctrl+Q quit`)
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
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('Ctrl+Q quit'), timeoutMs: 8_000 }, // Source: #36690 · 출처: #38163 문구 영문화
      steps: [
        { label: 'selector', text: '/mo', enter: false, until: (screen) => screen.includes('/model') && screen.includes('Enter run'), timeoutMs: 8_000 }, // 출처: #38163 문구 영문화 (status-line.ts:200) · 원출처 #36690
        { label: 'selector-close', keys: '\x1b', until: (screen) => !screen.includes('Enter run'), timeoutMs: 8_000 }, // 출처: #38163 문구 영문화 (status-line.ts:200) · 원출처 #36690
      ],
    });
    expect(run.frames[1]?.screen).toContain('/model');
    expect(run.frames[2]?.screen).not.toContain('Enter run'); // 출처: #38163 문구 영문화 (status-line.ts:200) · 원출처 #36690
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
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('Ctrl+Q quit'), timeoutMs: 8_000 }, // Source: #36661
      steps: [
        { label: 'no-content', text: '/compact', until: (screen) => screen.includes('Nothing to compact · 0 messages'), timeoutMs: 8_000 }, // Source: #36661
        { label: 'how-to-correct', text: '/tasks stop x', until: (screen) => screen.includes('Enter a unique task ID prefix of at least 4 characters'), timeoutMs: 8_000 }, // Source: #36661
        { label: 'exit', text: 'exit', until: (screen) => screen.includes('elanous'), timeoutMs: 8_000 }, // Source: #36661
      ],
    });
    expect(run.frames[1]?.screen).toContain('Nothing to compact · 0 messages');
    expect(run.frames[2]?.screen).toContain('Enter a unique task ID prefix of at least 4 characters');
    expect(run.frames[2]?.screen).not.toContain('Ctrl+Q quit');
    expect(run.exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
