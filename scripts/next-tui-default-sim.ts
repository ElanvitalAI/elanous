// Paired, credential-free PTY receipt for the local root TUI switch.
// Usage: bun scripts/next-tui-default-sim.ts <receipt-directory>
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';

const output = process.argv[2];
if (!output) throw new Error('usage: bun scripts/next-tui-default-sim.ts <receipt-directory>');
const receiptDir = resolve(output);
if (existsSync(receiptDir) && readdirSync(receiptDir).length > 0) throw new Error('receipt directory must be empty');
const entry = resolve(import.meta.dir, '..', 'bin', 'elanous.mjs');
const config = JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } });
mkdirSync(receiptDir, { recursive: true });

for (const mode of ['bare', 'classic', 'legacy'] as const) {
  const root = join(receiptDir, mode, 'universe');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), config);
  const receipt = await mockSeatPtySequence({
    executable: process.execPath,
    args: [entry, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', ...(mode === 'classic' ? ['--tui', 'classic'] : mode === 'legacy' ? ['--legacy'] : [])],
    root,
    rows: 24,
    cols: 80,
    env: { ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
    ready: { label: `${mode} first screen`, until: mode === 'bare'
      ? (screen) => screen.startsWith('elanous\n') && screen.includes('Ctrl+Q 종료') && screen.includes('바로 입력해 보세요:')
      : (screen) => screen.includes('ChatLog') && screen.includes('❯') && screen.includes('▶ 실행') },
    steps: [{ label: `${mode} help`, text: '/help', until: mode === 'bare'
      ? (screen) => screen.includes('Commands') && screen.includes('/harness')
      : (screen) => screen.includes('/help (?) — 명령과 키 보기') }],
    quitKeys: mode === 'bare' ? '\x11' : '/exit\r',
    exitTimeoutMs: 20_000,
    artifactPath: join(receiptDir, `${mode}.pty.json`),
  });
  if (receipt.exitCode !== 0 || receipt.frames.length !== 2) {
    throw new Error(`${mode} PTY failed: exit=${receipt.exitCode}, frames=${receipt.frames.length}`);
  }
  const first = receipt.frames[0]!.screen;
  if (mode === 'bare' && (first.includes('elanous | daemon') || !first.includes('Ctrl+Q 종료'))) throw new Error('bare did not open Next');
  if (mode !== 'bare' && (!first.includes('ChatLog') || !first.includes('▶ 실행'))) throw new Error(`${mode} fallback did not open dashboard`);
  console.log(JSON.stringify({ mode, host: receipt.actualHost, startedAt: receipt.startedAt, entrySha256: receipt.entrySha256, exitCode: receipt.exitCode, artifactPath: receipt.artifactPath }));
}
