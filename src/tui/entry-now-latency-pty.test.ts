import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

test('next TUI acknowledges /now before the ledger answer arrives in a real PTY', async () => {
  const evidence = process.env.ELANOUS_NOW_LATENCY_LIVE_OUT?.trim();
  const root = evidence ? join(evidence, 'state') : mkdtempSync(join(tmpdir(), 'next-now-latency-'));
  mkdirSync(root, { recursive: true });
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
      ready: { label: 'ready', timeoutMs: 30_000, until: screen => screen.includes('elanous') && screen.includes('Ctrl+Q 종료') && screen.includes('❯ ') }, // Source: #36749 compact header; #36701 PTY boot deadline.
      steps: [{
        label: 'acknowledged',
        text: '/now',
        timeoutMs: 5_000, // Source: #36701 — the observed silent wait was about ten seconds.
        until: screen => screen.includes('현재 맥락 조회 중'),
      }, {
        label: 'answered',
        timeoutMs: 30_000, // Source: #36701 reuses the established PTY answer deadline.
        until: screen => screen.includes('원장') && !screen.includes('현재 맥락 조회 중'),
      }],
      quitKeys: '\x11',
      ...(evidence ? { artifactPath: join(evidence, 'next-now-latency-minim5.json') } : {}),
    });
    const ackMs = Date.parse(run.frames[1]!.at) - Date.parse(run.frames[0]!.at);
    expect(ackMs).toBeLessThan(2_000); // Source: #36701 — minim5 observed 303ms; a two-second ceiling leaves room for PTY scheduling.
    expect(run.frames[1]!.screen).toContain('현재 맥락 조회 중');
    expect(run.frames[2]!.screen).toContain('원장');
    expect(run.exitCode).toBe(0);
  } finally {
    if (!evidence) rmSync(root, { recursive: true, force: true });
  }
}, 45_000); // Source: #36701 reuses the established live PTY test timeout.
