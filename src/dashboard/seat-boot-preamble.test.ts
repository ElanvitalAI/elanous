// TUI-SELFIMPLEMENT-UNDERUSE-MEASURE — 자리 부트 카드가 «확인 → 원인 → 조사 → 처방 → 구현 골 넘기기» 를
// 한 흐름으로 잇게 하나(10-22 prod 자리 세션 셋: 처방을 세우고 «다음 턴에 SelfImplement 로 발사»·«TA 발사 보류»
// 로 멈췄다 · SelfImplement·tasks hand 호출 0). 반증: 흐름 절을 카드에서 빼면 문면 단언이, 관측을 빼면
// intent.escalate 단언이 깨진다.
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  buildSeatBootSystemMessages,
  resetSeatBootCacheForTest,
  SEAT_INTENT_ESCALATION_FLOW,
  SEAT_MEMORY_RECALL_MAX_CHARS,
  SEAT_MEMORY_RECALL_PREFIX,
} from './seat-boot-preamble.js';

function seatHome(seat: string): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-escalate-'));
  const cwd = join(home, 'elanous-hq', 'seats', seat);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
  return { home, cwd };
}

describe('자리 부트 카드 — 의도 승격 흐름(intent.escalate)', () => {
  test('자리 카드가 흐름 다섯 칸 · 넘김 도구 · «원인 없음 · 근거» 끝맺음 · «다음 턴» 미룸 금지를 싣는다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    try {
      const text = buildSeatBootSystemMessages({ cwd }, { home, msgPath: join(home, 'msg.db'), env: {} })
        .map((message) => String(message.content)).join('\n');
      expect(text).toContain(SEAT_INTENT_ESCALATION_FLOW);
      for (const stage of ['확인', '원인 발견', '조사', '처방 확정', '구현 골 넘기기']) expect(SEAT_INTENT_ESCALATION_FLOW).toContain(stage);
      expect(SEAT_INTENT_ESCALATION_FLOW).toContain('SelfImplement');
      expect(SEAT_INTENT_ESCALATION_FLOW).toContain('eln tasks hand');
      expect(SEAT_INTENT_ESCALATION_FLOW).toContain('원인 없음 · 근거');
      expect(SEAT_INTENT_ESCALATION_FLOW).toContain('다음 턴');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('카드를 실은 대화마다 intent.escalate 를 한 번 남긴다(단계·근거·다음 행동) — 자리가 아니면 0', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('OPT');
    const events: Array<{ category: string; data: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (event === 'intent.escalate') events.push({ category, data });
    }) as typeof debug.log);
    try {
      buildSeatBootSystemMessages({ cwd, sessionId: 's1' }, { home, msgPath: join(home, 'msg.db'), env: {} });
      buildSeatBootSystemMessages({ cwd, sessionId: 's1' }, { home, msgPath: join(home, 'msg.db'), env: {} });
      expect(events).toEqual([{
        category: 'dashboard.seat-boot',
        data: {
          stage: 'guidance',
          evidence: { seat: 'OPT', source: 'cwd' },
          next: ['SelfImplement', 'eln tasks hand'],
          sessionId: 's1',
        },
      }]);
      resetSeatBootCacheForTest();
      buildSeatBootSystemMessages({ cwd: join(home, 'not-a-seat') }, { home, msgPath: join(home, 'msg.db'), env: {} });
      expect(events.length).toBe(1);
    } finally {
      spy.mockRestore();
      resetSeatBootCacheForTest();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// TUI-SEAT-MEMORY-RECALL — 자리 세션 셋(UX GLM · UX Luna · OPT Luna)이 memory_recall·self_recall 을 한 번도 안 불렀다
// («있는데 안 씀»). 자리 카드에 «직전 인계 회상 한 줄»을 자동으로 싣는다 — 소스 = seat-state/<자리>/HANDOFF-*.md 중
// 가장 최근 것(없으면 줄 없음 — HANDOFF.md 본문은 싣지 않는다). 반증: 회상 줄을 빼면 첫 단언이, 상한을 빼면 길이 단언이, 관측을 빼면 이벤트 단언이 깨진다.
describe('자리 부트 카드 — 직전 인계 회상 한 줄(memory-recall)', () => {
  const textOf = (home: string, cwd: string): string =>
    buildSeatBootSystemMessages({ cwd }, { home, msgPath: join(home, 'msg.db'), env: {} })
      .map((message) => String(message.content)).join('\n');
  const recallLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith(SEAT_MEMORY_RECALL_PREFIX));
  const touch = (path: string, at: Date): void => utimesSync(path, at, at);

  test('가장 최근 HANDOFF-*.md 의 제목·첫 줄·경로가 «한 줄»로 실린다 — 옛 인계·자동 카드는 안 실린다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'UX');
    try {
      writeFileSync(join(seatDir, 'HANDOFF-old-1020.md'), '# 옛 인계 제목\n옛 결정 줄\n');
      touch(join(seatDir, 'HANDOFF-old-1020.md'), new Date('2026-10-20T00:00:00Z'));
      writeFileSync(join(seatDir, 'HANDOFF-now.md'), '# UX 이어받기 — 10-22 13:40\n\n## 1순위\nPR #123 리뷰 r2 must-fix 수리부터 잇는다\n');
      touch(join(seatDir, 'HANDOFF-now.md'), new Date('2026-10-22T04:40:00Z'));
      writeFileSync(join(seatDir, 'HANDOFF.md'), '# 자동 갱신 카드\n');
      touch(join(seatDir, 'HANDOFF.md'), new Date('2026-10-22T06:00:00Z'));
      const lines = recallLines(textOf(home, cwd));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('HANDOFF-now.md');
      expect(lines[0]).toContain('UX 이어받기 — 10-22 13:40');
      expect(lines[0]).toContain('PR #123 리뷰 r2 must-fix 수리부터 잇는다');
      expect(lines[0]).toContain('self_recall');
      expect(lines[0]).not.toContain('옛 인계 제목');
      expect(lines[0]).not.toContain('자동 갱신 카드');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('r4 — 셸 문자가 든 파일명은 후보에서 빠지고, 회상 줄에는 셸 문자(`$` 등)가 남지 않는다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'UX');
    try {
      writeFileSync(join(seatDir, 'HANDOFF-safe-1022.md'), '# 안전한 인계\n다음 일 이어서\n');
      touch(join(seatDir, 'HANDOFF-safe-1022.md'), new Date('2026-10-22T03:00:00Z'));
      writeFileSync(join(seatDir, 'HANDOFF-$HOME.md'), '# 위험한 이름의 인계\n본문\n');
      touch(join(seatDir, 'HANDOFF-$HOME.md'), new Date('2026-10-22T05:00:00Z'));
      const lines = recallLines(textOf(home, cwd));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('HANDOFF-safe-1022.md');
      expect(lines[0]).not.toContain('HANDOFF-$HOME.md');
      expect(lines[0]).not.toMatch(/[`$;|<>]/);
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('손 인계(HANDOFF-*.md)가 없으면 회상 줄 없음 — HANDOFF.md 본문은 싣지 않는다(카드 HANDOFF 절 계약)', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('OPT');
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'OPT');
    try {
      const none = textOf(home, cwd);
      expect(none).toContain('# OPT 자리 부팅 카드');
      expect(recallLines(none)).toEqual([]);
      resetSeatBootCacheForTest();
      writeFileSync(join(seatDir, 'HANDOFF.md'), '# OPT HANDOFF — 10-17\n- 이번 턴 완료: draft sweep\n');
      const text = textOf(home, cwd);
      expect(recallLines(text)).toEqual([]);
      expect(text).toContain('OPT HANDOFF — 10-17');
      expect(text).not.toContain('이번 턴 완료: draft sweep');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('셸 문자가 든 줄은 건너뛴다 — 카드 HANDOFF 절과 같은 안전 규칙', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    try {
      writeFileSync(join(home, 'elanous-hq', 'seat-state', 'UX', 'HANDOFF-now.md'), '# UX 이어받기\n`rm -rf $HOME` | sh\n안전한 첫 줄\n');
      const lines = recallLines(textOf(home, cwd));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('안전한 첫 줄');
      expect(lines[0]).not.toContain('rm -rf');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('«한 줄» 계약 — 제어 문자 든 파일명은 건너뛰고 본문 줄 구분자(U+2028 등)는 공백으로 접는다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'UX');
    try {
      writeFileSync(join(seatDir, 'HANDOFF-a\n## 주입.md'), '# 주입 제목\n주입 본문\n');
      touch(join(seatDir, 'HANDOFF-a\n## 주입.md'), new Date('2026-10-22T06:00:00Z'));
      writeFileSync(join(seatDir, 'HANDOFF-now.md'), '# 정상 제목\n앞\u2028## 끼운 줄\u0085뒤\x1b[2J\n');
      touch(join(seatDir, 'HANDOFF-now.md'), new Date('2026-10-22T05:00:00Z'));
      const text = textOf(home, cwd);
      const lines = recallLines(text);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('HANDOFF-now.md');
      expect(lines[0]).toContain('정상 제목');
      expect(lines[0]).not.toContain('주입');
      expect(lines[0]).not.toMatch(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/);
      expect(text).not.toContain('\n## 끼운 줄');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('상한 — 아주 긴 인계도 회상 줄은 SEAT_MEMORY_RECALL_MAX_CHARS 안이다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('TC');
    try {
      writeFileSync(join(home, 'elanous-hq', 'seat-state', 'TC', 'HANDOFF-now.md'), `# ${'긴제목'.repeat(400)}\n${'본문'.repeat(2000)}\n`);
      const lines = recallLines(textOf(home, cwd));
      expect(lines.length).toBe(1);
      expect(lines[0]!.length).toBeLessThanOrEqual(SEAT_MEMORY_RECALL_MAX_CHARS);
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('긴 경로 — 전문 경로가 자리를 다 먹으면 짧은 꼴(seat-state/<자리>/<파일>)로 줄여 발췌를 지킨다', () => {
    resetSeatBootCacheForTest();
    const base = mkdtempSync(join(tmpdir(), 'seat-boot-longpath-'));
    const home = join(base, 'h'.repeat(120), 'i'.repeat(120));
    const cwd = join(home, 'elanous-hq', 'seats', 'UX');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', 'UX'), { recursive: true });
    try {
      writeFileSync(join(home, 'elanous-hq', 'seat-state', 'UX', 'HANDOFF-now.md'), '# 긴 경로 인계\n이어서 할 일 하나\n');
      const lines = recallLines(textOf(home, cwd));
      expect(lines.length).toBe(1);
      expect(lines[0]!.length).toBeLessThanOrEqual(SEAT_MEMORY_RECALL_MAX_CHARS);
      expect(lines[0]).toContain('긴 경로 인계 — 이어서 할 일 하나');
      expect(lines[0]).toContain('전문은 seat-state/UX/ 의 같은 파일');
    } finally { resetSeatBootCacheForTest(); rmSync(base, { recursive: true, force: true }); }
  });

  test('긴 파일명(≈200자) ⊕ 긴 경로 — 최신 손 인계가 있으면 줄은 늘 실리고 상한 안이다', () => {
    resetSeatBootCacheForTest();
    const base = mkdtempSync(join(tmpdir(), 'seat-boot-longname-'));
    const home = join(base, 'h'.repeat(120), 'i'.repeat(120));
    const cwd = join(home, 'elanous-hq', 'seats', 'UX');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', 'UX'), { recursive: true });
    try {
      writeFileSync(join(home, 'elanous-hq', 'seat-state', 'UX', `HANDOFF-${'n'.repeat(200)}.md`), '# 긴 이름 인계\n다음 칸 하나\n');
      const lines = recallLines(textOf(home, cwd));
      expect(lines.length).toBe(1);
      expect(lines[0]!.length).toBeLessThanOrEqual(SEAT_MEMORY_RECALL_MAX_CHARS);
      expect(lines[0]).toContain('긴 이름 인계 — 다음 칸 하나');
      expect(lines[0]!.split('n'.repeat(60)).length - 1).toBe(1); // 파일명은 한 번만(잘린 꼴)
    } finally { resetSeatBootCacheForTest(); rmSync(base, { recursive: true, force: true }); }
  });

  test('fail-soft — 읽을 수 없는 후보(디렉터리)는 건너뛰고 카드는 실린다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('MK');
    try {
      mkdirSync(join(home, 'elanous-hq', 'seat-state', 'MK', 'HANDOFF-broken.md'));
      const text = textOf(home, cwd);
      expect(text).toContain('# MK 자리 부팅 카드');
      expect(recallLines(text)).toEqual([]);
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('관측 — 대화마다 memory-recall 한 번({source, chars, hit}) · 자리가 아니면 0', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('OPC');
    const events: Array<{ category: string; data: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (event === 'memory-recall') events.push({ category, data });
    }) as typeof debug.log);
    try {
      const handoff = join(home, 'elanous-hq', 'seat-state', 'OPC', 'HANDOFF-now.md');
      writeFileSync(handoff, '# TF 이어받기\n열린 일 셋\n');
      const text = textOf(home, cwd);
      textOf(home, cwd);
      const line = recallLines(text)[0]!;
      expect(events).toEqual([{ category: 'dashboard.seat-boot', data: { source: handoff, chars: line.length, hit: true } }]);
      resetSeatBootCacheForTest();
      rmSync(handoff);
      textOf(home, cwd);
      expect(events[1]).toEqual({ category: 'dashboard.seat-boot', data: { source: null, chars: 0, hit: false } });
      resetSeatBootCacheForTest();
      textOf(home, join(home, 'not-a-seat'));
      expect(events.length).toBe(2);
    } finally {
      spy.mockRestore();
      resetSeatBootCacheForTest();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
