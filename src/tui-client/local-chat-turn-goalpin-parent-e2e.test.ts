import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// SEAT-HUMAN-GOAL-PIN ④ 종단(GOAL-PIN-2 후속 · OP #128939 ④ / #130409 쪼갬 처분) —
//   조사본: seat-state/HAND-ELN-ELS-API/evidence/goalpin2-investigation.md
//   1차(#39578)는 child(chat.ts) 자기 프로세스 저장소만 써서 부모(TUI) 저장소가 비어 있고
//   child 교체 뒤 핀이 소실됐다(실 TUI 📌 항상 꺼짐). 이 파일이 수리 전 RED:
//   부모 저장소 쓰기 · payload parentPinnedGoal · 완료 선언(update_goal) 해제 전파가 전부 없다.
import { runLocalChatTurn, closeLocalChatSession } from './local-chat-turn.js';
import { parseMessageSource } from '../session/index.js';
import {
  createInMemoryGoalPinStore,
  pinnedGoalOf,
  releasePinnedGoal,
  resolvePinnedObjective,
  sessionGoalPinStore,
} from '../core-turn/human-goal-pin.js';
import type { MessageSource } from '../session/index.js';

/** 1차 종단 시험(local-chat-turn-goalpin-e2e.test.ts)과 같은 fake CLI 하네스 — child stdin 에 쓴 실 payload 를 남긴다. */
function writeEchoCli(dir: string, seen: string): string {
  const cli = join(dir, 'echo-cli.ts');
  writeFileSync(cli, `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      if (!line.trim()) continue;
      appendFileSync(${JSON.stringify(seen)}, line + '\\n');
      const request = JSON.parse(line);
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'ok', provider: 'test', model: 'env' }));
    }
  `);
  return cli;
}

test('GOALPIN-④-PARENT: 사람 줄이 부모(TUI) 저장소를 쓰고, 교체 뒤 child payload 가 parentPinnedGoal 로 핀을 복구한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goalpin-parent-'));
  const seen = join(dir, 'seen-payloads.jsonl');
  const cli = writeEchoCli(dir, seen);
  const HUMAN: MessageSource = { kind: 'human' };
  const NOTICE: MessageSource = { kind: 'system', origin: 'queue-notice' };
  const SID = 'goalpin-parent-e2e';
  const GOAL = '크론 5개 처리 완료';
  releasePinnedGoal(SID, sessionGoalPinStore());
  const run = (text: string, from: MessageSource) => runLocalChatTurn(SID, text, new AbortController().signal, cli, undefined, undefined, {}, [], undefined, undefined, undefined, undefined, undefined, undefined, from);
  try {
    await run(GOAL, HUMAN);
    // (a) 사람 줄 턴 뒤 부모 저장소(상태줄 pinnedGoalOf 가 읽는 같은 싱글턴)에 고정 목표가 쓰였다 — 수리 전엔 항상 undefined.
    expect(pinnedGoalOf(SID)).toBe(GOAL);
    await closeLocalChatSession(SID); // child 교체 — 새 child 는 빈 인메모리 저장소로 시작
    await run('[notice · seat-mail] OP 우편 도착', NOTICE);
    for (let attempt = 0; attempt < 200 && !existsSync(seen); attempt++) await Bun.sleep(10);
    const raws = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
    expect(raws.length).toBeGreaterThanOrEqual(2);
    const noticePayload = JSON.parse(raws[raws.length - 1]);
    // (b) 사람 줄이 아닌 턴의 실 payload 가 parentPinnedGoal 을 싣는다(child 교체 뒤 복구 경로) — 수리 전엔 필드 부재.
    expect(noticePayload.parentPinnedGoal ?? '(absent)').toBe(GOAL);
    // (c) 교체된 child(빈 저장소)가 payload 의 parentPinnedGoal 로 핀을 복구한다 — chat.ts:797 과 동일 계약.
    const freshChildStore = createInMemoryGoalPinStore();
    const restored = resolvePinnedObjective({
      sessionId: SID, from: parseMessageSource(noticePayload.from), turnText: noticePayload.prompt,
      ...(noticePayload.parentPinnedGoal !== undefined ? { parentPinnedGoal: noticePayload.parentPinnedGoal } : {}),
    }, freshChildStore);
    expect(restored.pinned).toBe(true);
    expect(restored.objective).toBe(GOAL);
    // (d) 알림 턴 결과엔 완료 선언이 없다 — 부모 핀은 유지된다.
    expect(pinnedGoalOf(SID)).toBe(GOAL);
  } finally {
    releasePinnedGoal(SID, sessionGoalPinStore());
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('GOALPIN-④-RELEASE: child 완료 결과 중 update_goal complete 만 부모 핀을 해제한다(구조화 종결은 유지)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goalpin-release-'));
  const cli = join(dir, 'echo-cli.ts');
  // fake CLI 의 결과 프레임 — 완료 경로(via)는 run-goal-loop debug 'complete' 로그의 via 값 원문:
  //   'update_goal' | 'structured-final-phase' | 'status-question-final-answer'(wire 계약 · OP #131052).
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      const via = request.prompt.includes('완료 선언') ? 'update_goal'
        : request.prompt.includes('마무리 보고') ? 'structured-final-phase' : null;
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'ok', provider: 'test', model: 'env',
        ...(via ? { goalComplete: true, goalStopReason: 'goal_complete', goalCompletionVia: via } : {}) }));
    }
  `);
  const HUMAN: MessageSource = { kind: 'human' };
  const NOTICE: MessageSource = { kind: 'system', origin: 'queue-notice' };
  const SID = 'goalpin-release-e2e';
  const GOAL = '고정 목표 지시';
  releasePinnedGoal(SID, sessionGoalPinStore());
  const run = (text: string, from: MessageSource) => runLocalChatTurn(SID, text, new AbortController().signal, cli, undefined, undefined, {}, [], undefined, undefined, undefined, undefined, undefined, undefined, from);
  try {
    await run(GOAL, HUMAN);
    expect(pinnedGoalOf(SID)).toBe(GOAL); // (a) 핀 생성 — 수리 전엔 부모 저장소가 비어 undefined
    await closeLocalChatSession(SID);
    await run('[notice] 대형 마무리 보고 턴', NOTICE);
    expect(pinnedGoalOf(SID)).toBe(GOAL); // (b) structured-final 종결은 핀을 못 푼다(control · OP #131052)
    await closeLocalChatSession(SID);
    await run('[notice] 완료 선언 턴', NOTICE);
    expect(pinnedGoalOf(SID)).toBeUndefined(); // (c) update_goal complete 만 해제 — 수리 전엔 전파 자체가 없다
  } finally {
    releasePinnedGoal(SID, sessionGoalPinStore());
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
