import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  test('sprint O5 ③ · OP #93799 — deps.getSessionId 주입 시 createSeatMailInbox에 heartbeat 주입: 박동 파일에 실측 세션 id 기록', () => {
    const root = mkdtempSync(join(tmpdir(), 'seat-wiring-hb-'));
    const stateRoot = join(root, 'seat-state');
    const wiring = createSeatMailInboxWiring({
      getCwd: () => join(root, 'seats', 'TC-WIRING-HB'),
      seatStateRoot: stateRoot,
      getSessionId: () => 'sess-w1',
      startTurnIfIdle: () => ({ opened: true as const, turnId: 'wiring-test-turn' }),
    });
    wiring.noteTurnEnded();
    const alive = join(stateRoot, 'TC-WIRING-HB', 'inbox.alive');
    expect(existsSync(alive)).toBe(true);
    const beat = JSON.parse(readFileSync(alive, 'utf8')) as { sessionId: string; host: string };
    expect(beat.sessionId).toBe('sess-w1');
    expect(typeof beat.host).toBe('string');
    wiring.stop();
    rmSync(root, { recursive: true, force: true });
  });
