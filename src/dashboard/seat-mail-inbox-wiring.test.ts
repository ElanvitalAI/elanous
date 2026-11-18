import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeatMailInboxWiring } from './seat-mail-inbox-wiring.js';

describe('createSeatMailInboxWiring', () => {
  test('판 밖 cwd(자리 아님)면 우편 없는 no-op 컨트롤러 — startTurnIfIdle 을 부르지 않는다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seat-wiring-'));
    let opened = 0;
    const wiring = createSeatMailInboxWiring({
      getCwd: () => cwd,
      startTurnIfIdle: () => { opened += 1; return { opened: true as const, turnId: 'wiring-test-turn' }; },
    });
    expect(typeof wiring.noteTurnEnded).toBe('function');
    expect(() => { wiring.noteTurnEnded(); wiring.stop(); }).not.toThrow();
    expect(opened).toBe(0);
  });

  test('deps.startTurnIfIdle 이 던져도 팩토리·메서드는 예외를 밖으로 안 던진다(fail-soft)', () => {
    const wiring = createSeatMailInboxWiring({
      getCwd: () => '/definitely/not/a/seat',
      startTurnIfIdle: () => { throw new Error('boom'); },
    });
    expect(() => { wiring.noteTurnEnded(); wiring.stop(); }).not.toThrow();
  });
});
