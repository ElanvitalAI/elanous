import { expect, test } from 'bun:test';
import { LLMock } from '@copilotkit/aimock';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

interface PaintReceipt {
  readonly entry: string;
  readonly echoMs: number;
  readonly fullClears: number;
  readonly bytes: number;
  readonly syncBegins: number;
  readonly cursorHides: number;
  readonly markdownBoldRendered: boolean;
  readonly exitCode: number | null;
  readonly binarySha256: string;
  readonly entrySha256: string | null;
}

test('next TUI echoes a sent question before the delayed model and paints streaming frames without full clears', async () => {
  const mock = new LLMock({ port: 0, host: '127.0.0.1', strict: false });
  // Source: seat-state/OP/evidence/20261110/STREAM-UX-DIAG.md uses a delayed, chunked local SSE reply.
  mock.onMessage(/STREAM-POLISH-ECHO/, { content: 'STREAM-POLISH-ANSWER\n\n**STREAM-MARKDOWN-BOLD**\n\n' + '단어 하나 둘 셋 넷 다섯. '.repeat(24) },
    { chunkSize: 5, streamingProfile: { ttft: 400, tps: 50, jitter: 0 } });
  await mock.start();
  const currentEntry = resolve(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
  const baselineEntry = process.env.ELANOUS_STREAM_POLISH_BASE_ENTRY?.trim();
  const run = async (entry: string, label: 'baseline' | 'current'): Promise<PaintReceipt> => {
    const root = mkdtempSync(join(tmpdir(), 'stream-polish-pty-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true }, errorReports: { enabled: false },
      llm: { provider: 'local', model: 'test-model', baseUrl: `${mock.url}/v1` },
    }));
    let submittedAt: number | null = null;
    let echoAt: number | null = null;
    let raw = '';
    try {
      const receipt = await mockSeatPtySequence({
        executable: process.execPath,
        args: [entry, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 36, cols: 120,
        env: { ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
        ready: { label: 'boot', until: 'Ctrl+Q 종료' },
        steps: [{
          // Source: seat-state/OP/evidence/20261110/STREAM-UX-DIAG.md streaming PTY turn timeout.
          label: 'stream', text: 'STREAM-POLISH-ECHO 질문', timeoutMs: 30_000, // Source: 내부 문서 `next-tui-stream-polish-1`
          until: (screen) => screen.includes('STREAM-POLISH-ANSWER') && screen.includes('응답 완료'),
        }],
        onStepInput: (_label, atMs) => { submittedAt = atMs; },
        onOutput: (chunk, atMs) => {
          if (submittedAt === null) return;
          raw += chunk;
          if (echoAt === null && raw.includes('나: STREAM-POLISH-ECHO')) echoAt = atMs;
        },
      });
      expect(receipt.exitCode).toBe(0);
      expect(echoAt).not.toBeNull();
      const rawOut = process.env.ELANOUS_STREAM_POLISH_RAW_OUT?.trim();
      if (rawOut) {
        mkdirSync(resolve(rawOut), { recursive: true });
        writeFileSync(join(resolve(rawOut), `${label}.bin`), raw);
      }
      return {
        entry,
        echoMs: echoAt! - submittedAt!,
        fullClears: raw.match(/\x1b\[2J/g)?.length ?? 0,
        bytes: Buffer.byteLength(raw),
        syncBegins: raw.match(/\x1b\[\?2026h/g)?.length ?? 0,
        cursorHides: raw.match(/\x1b\[\?25l/g)?.length ?? 0,
        markdownBoldRendered: /\x1b\[1mSTREAM-MARKDOWN-BOLD\x1b\[22m/.test(raw),
        exitCode: receipt.exitCode,
        binarySha256: receipt.binarySha256,
        entrySha256: receipt.entrySha256,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const baseline = baselineEntry ? await run(resolve(baselineEntry), 'baseline') : null;
    const current = await run(currentEntry, 'current');
    // Source: seat-state/OP/evidence/20261110/STREAM-UX-DIAG.md, OP's 100 ms echo target.
    expect(current.echoMs).toBeLessThanOrEqual(100); // Source: 내부 문서 `next-tui-stream-polish-1`
    expect(current.fullClears).toBe(0);
    expect(current.syncBegins).toBeGreaterThan(0); // Source: 내부 문서 `next-tui-stream-polish-1`
    expect(current.cursorHides).toBeGreaterThan(0); // Source: 내부 문서 `next-tui-stream-polish-1`
    // Source: NEXT-TUI-STREAM-MARKDOWN-LIVE — the production PTY must render the in-flight preview, not only saved history.
    expect(current.markdownBoldRendered).toBe(true);
    if (baseline) {
      expect(baseline.fullClears).toBeGreaterThan(current.fullClears);
      expect(baseline.bytes).toBeGreaterThan(current.bytes);
    }
    const out = process.env.ELANOUS_STREAM_POLISH_RECEIPT_OUT?.trim();
    if (out) writeFileSync(resolve(out), JSON.stringify({ baseline, current }, null, 2) + '\n');
    console.log('next TUI stream polish PTY:', JSON.stringify({ baseline, current }));
  } finally {
    await mock.stop();
  }
}, 120_000);
