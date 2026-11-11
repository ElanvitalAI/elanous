import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPtyKeyModifiersDevice } from './pty-key-modifiers-device.js';

const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

describe('N03 pty-key-modifiers 장치 (classic↔next · fake LLM)', () => {
  test('classic↔next PTY에서 shift+enter → 한 번의 제출에 두 줄 · 이스케이프 찌꺼기 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-ptykey-'));
    try {
      for (const tui of ['classic', 'next'] as const) {
        const r = await runPtyKeyModifiersDevice({ tui, encoding: 'xterm', root: join(dir, tui), executable: process.execPath, entry: REPO_CLI });
        expect(r.bytes).toBe('\x1b[27;2;13~');
        expect(r.checks).toEqual({ oneTurnTwoLines: true, noEscapeResidue: true, answered: true, exitedClean: true });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);
});
