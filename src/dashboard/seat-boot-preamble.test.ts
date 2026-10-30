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
  startSeatBootConversation,
  SEAT_INTENT_ESCALATION_FLOW,
  SEAT_MEMORY_IMPORT_MAX_CHARS,
  SEAT_MEMORY_IMPORT_PREFIX,
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

// TUI-SEAT-MEMORY-IMPORT — the conversation gets one bounded, read-only
// snapshot; source timestamps and explicit priority/evidence pointers travel
// with it, and a new conversation is the only refresh boundary.
describe('자리 부트 카드 — 세션 시작 자리 기억 스냅샷(memory-import)', () => {
  const importBlock = (home: string, cwd: string, now: Date): string => {
    const text = buildSeatBootSystemMessages({ cwd }, { home, msgPath: join(home, 'msg.db'), env: {}, now: () => now })
      .map((message) => String(message.content)).join('\n');
    const start = text.indexOf(SEAT_MEMORY_IMPORT_PREFIX);
    if (start < 0) return '';
    const end = text.indexOf('\n\n', start);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const touch = (path: string, at: Date): void => utimesSync(path, at, at);

  test('신선한 UX 인계의 우선순위·증거 포인터를 싣고 비밀·본문은 빼며 대화 중 스냅샷을 고정한다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'UX');
    const memoryDir = join(home, 'elanous-hq', 'seat-state', 'memory');
    const knowhow = join(cwd, 'docs', 'roles', 'UX', 'KNOWHOW.md');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(cwd, 'docs', 'roles', 'UX'), { recursive: true });
    const handoff = join(seatDir, 'HANDOFF-now.md');
    const memory = join(memoryDir, 'MEMORY.md');
    const at = new Date('2026-10-28T10:00:00.000Z');
    try {
      writeFileSync(handoff, '# UX 이어받기\n**다음 한 수:** P0 first cell token=ultra-secret-value-123 docs/evidence/current.md\n- 근거: docs/evidence/current.md\n');
      writeFileSync(memory, '# [기억 포인터]\nDO_NOT_IMPORT_MEMORY_BODY\n');
      writeFileSync(knowhow, '# UX 노하우\nDO_NOT_IMPORT_KNOWHOW_BODY\n');
      touch(handoff, new Date('2026-10-28T09:30:00.000Z'));
      touch(memory, new Date('2026-10-28T09:35:00.000Z'));
      touch(knowhow, new Date('2026-10-28T09:40:00.000Z'));

      const first = importBlock(home, cwd, at);
      expect(first.length).toBeLessThanOrEqual(SEAT_MEMORY_IMPORT_MAX_CHARS);
      expect(first).toContain('P0 first cell token=***');
      expect(first).toContain('docs/evidence/current.md');
      expect(first).toContain('seat-state/UX/HANDOFF-now.md');
      expect(first).toContain('seat-state/memory/MEMORY.md');
      expect(first).toContain('docs/roles/UX/KNOWHOW.md');
      expect(first).not.toContain('ultra-secret-value-123');
      expect(first).not.toContain('DO_NOT_IMPORT_');
      expect(first).toContain('stale/unknown 또는 상충');

      writeFileSync(handoff, '# UX 이어받기\n**다음 한 수:** SECOND PRIORITY docs/evidence/second.md\n');
      touch(handoff, new Date('2026-10-28T09:50:00.000Z'));
      expect(importBlock(home, cwd, at)).toBe(first);
      startSeatBootConversation({ reason: 'session-new' });
      expect(importBlock(home, cwd, at)).toContain('SECOND PRIORITY');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('근거 경로 안의 토큰 모양 문자열도 발췌 전에 가린다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const handoff = join(home, 'elanous-hq', 'seat-state', 'UX', 'HANDOFF-now.md');
    const openAiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz12345678901234567890';
    const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const now = new Date('2026-10-28T10:00:00.000Z');
    try {
      writeFileSync(handoff, `# UX 이어받기\n**다음 한 수:** 검증 ${openAiKey} docs/evidence/${openAiKey}/ticket.md\n- 근거: docs/evidence/${githubToken}/proof.md\n`);
      touch(handoff, new Date(now.getTime() - 60_000));

      const text = importBlock(home, cwd, now);
      expect(text).toContain('docs/evidence/sk-proj-***/ticket.md');
      expect(text).toContain('docs/evidence/ghp_***/proof.md');
      expect(text).not.toContain(openAiKey);
      expect(text).not.toContain(githubToken);
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('특수문자 경로는 온전히 보존하고 공백 경로의 부분 접두는 unknown 처리한다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const handoff = join(home, 'elanous-hq', 'seat-state', 'UX', 'HANDOFF-path-boundary.md');
    const now = new Date('2026-10-28T10:00:00.000Z');
    const evidenceRoot = `${['docs', 'evidence'].join('/')}/`;
    const spacedPath = `${evidenceRoot}proof report.md`;
    const extensionSpacedPath = `${evidenceRoot}proof.md report.md`;
    const multiwordSpacedPath = `${evidenceRoot}proof draft report.md`;
    const delimiterPath = `${evidenceRoot}proof#2.md`;
    const asciiSpecialPath = `${evidenceRoot}proof${String.fromCharCode(64)}2.md`;
    const unicodeSpecialPath = `${evidenceRoot}검증${String.fromCharCode(64)}2.md`;
    try {
      writeFileSync(handoff, `# UX 이어받기\n**다음 한 수:** 확인이 필요할 수 있음\n- 근거: ${spacedPath} · ${extensionSpacedPath} · ${multiwordSpacedPath} · ${delimiterPath} · ${asciiSpecialPath} · ${unicodeSpecialPath}\n`);
      touch(handoff, new Date(now.getTime() - 60_000));

      const text = importBlock(home, cwd, now);
      expect(text).toContain(asciiSpecialPath);
      expect(text).toContain(unicodeSpecialPath);
      expect(text).not.toContain(`${evidenceRoot}proof ·`);
      expect(text).not.toContain(`${evidenceRoot}proof.md ·`);
      expect(text).not.toContain(spacedPath);
      expect(text).not.toContain(extensionSpacedPath);
      expect(text).not.toContain(multiwordSpacedPath);
      expect(text).not.toContain(delimiterPath);
      expect(text).toContain('stale/unknown 또는 상충하는 기억은 사실로 단정하지 말고 unknown으로 답한 뒤 위 포인터의 정본을 확인한다. 비밀·계정 값은 기억에서 가져오지 않는다.');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('HANDOFF 포인터 파일명의 토큰 모양 문자열도 가린다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz12345678901234567890';
    const handoff = join(home, 'elanous-hq', 'seat-state', 'UX', `HANDOFF-${token}.md`);
    const now = new Date('2026-10-28T10:00:00.000Z');
    try {
      writeFileSync(handoff, '# UX 이어받기\n**다음 한 수:** 안전한 다음 작업\n');
      touch(handoff, new Date(now.getTime() - 60_000));

      const text = importBlock(home, cwd, now);
      expect(text).toContain('seat-state/UX/HANDOFF-sk-proj-***.md');
      expect(text).not.toContain(token);
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('긴 근거 경로는 중간에서 자르지 않고 제외하며 짧은 포인터와 unknown 지침은 보존한다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const handoff = join(home, 'elanous-hq', 'seat-state', 'UX', 'HANDOFF-long-evidence.md');
    const longPath = `docs/evidence/${'deep/'.repeat(140)}proof.md`;
    const shortPath = 'docs/evidence/short/proof.md';
    const now = new Date('2026-10-29T10:00:00.000Z');
    try {
      writeFileSync(handoff, `# UX 이어받기\n**다음 한 수:** P0 검증 ${longPath}\n- 근거: ${shortPath}\n`);
      touch(handoff, new Date(now.getTime() - 60_000));

      const text = importBlock(home, cwd, now);
      expect(text.length).toBeLessThanOrEqual(SEAT_MEMORY_IMPORT_MAX_CHARS);
      expect(text).toContain('P0 검증 〔경로는 근거 포인터 참조〕');
      expect(text).toContain(shortPath);
      expect(text).toContain('1개 긴 경로 생략(원문 인계 포인터 참조)');
      expect(text).not.toContain(longPath);
      expect(text).not.toContain(longPath.slice(0, 100));
      expect(text).toContain('stale/unknown 또는 상충하는 기억은 사실로 단정하지 말고 unknown으로 답한 뒤 위 포인터의 정본을 확인한다. 비밀·계정 값은 기억에서 가져오지 않는다.');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('24시간 지난 인계는 요약·근거를 unknown 처리하고 오래된 memory/knowhow를 stale로 표시한다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'UX');
    const memoryDir = join(home, 'elanous-hq', 'seat-state', 'memory');
    const knowhow = join(cwd, 'docs', 'roles', 'UX', 'KNOWHOW.md');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(cwd, 'docs', 'roles', 'UX'), { recursive: true });
    const handoff = join(seatDir, 'HANDOFF-now.md');
    try {
      writeFileSync(handoff, '# 오래된 인계\n**다음 한 수:** STALE PRIORITY docs/evidence/old.md\n');
      writeFileSync(join(memoryDir, 'MEMORY.md'), '# stale memory\n');
      writeFileSync(knowhow, '# stale knowhow\n');
      const now = new Date('2026-10-29T10:00:00.000Z');
      touch(handoff, new Date(now.getTime() - 25 * 60 * 60 * 1_000));
      touch(join(memoryDir, 'MEMORY.md'), new Date(now.getTime() - 26 * 60 * 60 * 1_000));
      touch(knowhow, new Date(now.getTime() - 26 * 60 * 60 * 1_000));
      const text = importBlock(home, cwd, now);
      expect(text).toContain('현재 우선순위: 미관측');
      expect(text).toContain('근거 포인터: 미관측');
      expect(text).not.toContain('STALE PRIORITY');
      expect(text).not.toContain('docs/evidence/old.md');
      expect(text.match(/stale\/unknown/g)?.length).toBeGreaterThanOrEqual(3);
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('현재보다 미래인 HANDOFF는 즉시 unknown 처리한다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const handoff = join(home, 'elanous-hq', 'seat-state', 'UX', 'HANDOFF-now.md');
    try {
      writeFileSync(handoff, '# UX 이어받기\n**다음 한 수:** FUTURE HANDOFF PRIORITY docs/evidence/future.md\n');
      touch(handoff, new Date('2026-10-28T10:00:01.000Z'));
      const text = importBlock(home, cwd, new Date('2026-10-28T10:00:00.000Z'));
      expect(text).toContain('현재 우선순위: 미관측');
      expect(text).toContain('인계 포인터: seat-state/UX/HANDOFF-now.md');
      expect(text).toContain('stale/unknown');
      expect(text).not.toContain('FUTURE HANDOFF PRIORITY');
      expect(text).not.toContain('docs/evidence/future.md');
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });

  test('미래 mtime의 MEMORY·KNOWHOW는 HANDOFF보다 최신이어도 stale로 표시한다', () => {
    resetSeatBootCacheForTest();
    const { home, cwd } = seatHome('UX');
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'UX');
    const memoryDir = join(home, 'elanous-hq', 'seat-state', 'memory');
    const memory = join(memoryDir, 'MEMORY.md');
    const knowhow = join(cwd, 'docs', 'roles', 'UX', 'KNOWHOW.md');
    const handoff = join(seatDir, 'HANDOFF-now.md');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(cwd, 'docs', 'roles', 'UX'), { recursive: true });
    try {
      writeFileSync(handoff, '# UX 이어받기\n**다음 한 수:** CURRENT PRIORITY docs/evidence/current.md\n');
      writeFileSync(memory, '# future memory\n');
      writeFileSync(knowhow, '# future knowhow\n');
      touch(handoff, new Date('2026-10-28T09:30:00.000Z'));
      touch(memory, new Date('2026-10-28T10:00:01.000Z'));
      touch(knowhow, new Date('2026-10-28T10:00:02.000Z'));
      const text = importBlock(home, cwd, new Date('2026-10-28T10:00:00.000Z'));
      expect(text).toContain('현재 우선순위(인계 발췌): 다음 한 수: CURRENT PRIORITY');
      expect(text.match(/ · stale\/unknown/g)?.length).toBe(2);
    } finally { resetSeatBootCacheForTest(); rmSync(home, { recursive: true, force: true }); }
  });
});
