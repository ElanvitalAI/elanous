import { expect, test } from 'bun:test';
import { isClassicSigquitChord, registerClassicSigquitHandler } from './classic-sigquit.js';

test('classic Ctrl+\\ chord matcher accepts only the unmodified control chord', () => {
  expect(isClassicSigquitChord({ name: '\\', ctrl: true })).toBe(true);
  expect(isClassicSigquitChord({ name: 'backslash', ctrl: true })).toBe(true);
  expect(isClassicSigquitChord({ name: '\\' })).toBe(false);
  expect(isClassicSigquitChord({ name: '\\', ctrl: true, shift: true })).toBe(false);
  expect(isClassicSigquitChord({ name: '\\', ctrl: true, alt: true })).toBe(false);
});

type PtyProcess = {
  kill: (signal?: string) => void;
  exited: Promise<number | null>;
};

test('SIGQUIT delivered to the classic TUI process shows guidance and leaves its PTY alive', async () => {
  const bun = (globalThis as { Bun?: { spawn?: (cmd: string[], opts: Record<string, unknown>) => PtyProcess } }).Bun;
  if (!bun?.spawn) throw new Error('Bun.spawn is required for PTY signal coverage');
  const source = `
    const { registerClassicSigquitHandler } = await import(${JSON.stringify(new URL('./classic-sigquit.ts', import.meta.url).pathname)});
    registerClassicSigquitHandler(() => {
      process.stdout.write('classic 사이드탭: /side · /side new · /side attach <번호>\\n');
      setTimeout(() => { process.stdout.write('STILL-ALIVE\\n'); process.exit(0); }, 80);
    });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  let output = '';
  let signalled = false;
  let proc!: PtyProcess;
  const decoder = new TextDecoder();
  proc = bun.spawn([process.execPath, '-e', source], {
    cwd: process.cwd(),
    env: { ...process.env },
    terminal: {
      cols: 80,
      rows: 24,
      name: 'xterm-256color',
      data(_terminal: unknown, chunk: Uint8Array) {
        output += decoder.decode(chunk, { stream: true });
        if (!signalled && output.includes('READY')) {
          signalled = true;
          setTimeout(() => proc.kill('SIGQUIT'), 20);
        }
      },
    },
  });
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already exited */ } }, 3000);
  try {
    const code = await proc.exited;
    expect(signalled).toBe(true);
    expect(output).toContain('classic 사이드탭: /side · /side new · /side attach <번호>');
    expect(output).toContain('STILL-ALIVE');
    expect(code).toBe(0);
  } finally {
    clearTimeout(timer);
  }
}, 5000);
