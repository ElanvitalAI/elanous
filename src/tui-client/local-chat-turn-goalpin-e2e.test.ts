import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// SEAT-HUMAN-GOAL-PIN ① 종단(JUD-B #131273): 실 session.turn() 이 child stdin 에 쓰는
// «실제 payload 문자열»이 사람 from 을 살려 보내고, 그 payload 를 child 측 파싱
// (parseMessageSource)→핀 판별(resolvePinnedObjective)까지 잇는 근거. 순수 serializer 시험과
// 별개로 «실경로가 그 serializer 를 쓴다»를 증명한다(죽은 수출 방지).
import { runLocalChatTurn, closeLocalChatSession } from './local-chat-turn.js';
import { parseMessageSource } from '../session/index.js';
import { resolvePinnedObjective, createInMemoryGoalPinStore } from '../core-turn/human-goal-pin.js';
import { serializeTurnPayload } from './local-chat-turn-goalpin-wire.js';
import type { MessageSource } from '../session/index.js';

test('GOALPIN-①-E2E: 실 session.turn() payload 가 사람 from 을 살려 child 파싱→핀까지 간다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goalpin-e2e-'));
  const cli = join(dir, 'echo-cli.ts');
  const seen = join(dir, 'seen-payloads.jsonl');
  writeFileSync(cli, `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      if (!line.trim()) continue;
      appendFileSync(${JSON.stringify(seen)}, line + '\\n');
      const request = JSON.parse(line);
      console.log(JSON.stringify({ event: 'result', turnId: request.id, reply: 'ok', provider: 'test', model: 'env' }));
    }
  `);
  const HUMAN: MessageSource = { kind: 'human' };
  const NOTICE: MessageSource = { kind: 'system', origin: 'queue-notice' };
  try {
    // 사람 턴 — 실경로 직렬화를 거친 실제 payload.
    await runLocalChatTurn('goalpin-e2e', '사람이 친 줄 — 고정 목표 지시', new AbortController().signal, cli, undefined, undefined, {}, [], undefined, undefined, undefined, undefined, undefined, undefined, HUMAN);
    await closeLocalChatSession('goalpin-e2e');
    await runLocalChatTurn('goalpin-e2e', '[notice · seat-mail] OP 우편 도착', new AbortController().signal, cli, undefined, undefined, {}, [], undefined, undefined, undefined, undefined, undefined, undefined, NOTICE);
    await closeLocalChatSession('goalpin-e2e');
    for (let attempt = 0; attempt < 200 && !(existsSync(seen) && readFileSync(seen, 'utf8').split('\n').filter(Boolean).length >= 2); attempt++) await Bun.sleep(10);
    const raws = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
    expect(raws.length).toBeGreaterThanOrEqual(2);
    // (a) 실 payload 에 사람 from 생존 — 실경로 직렬화가 생략하면 여기서 RED.
    const humanPayload = JSON.parse(raws[0]);
    expect(humanPayload.from?.kind ?? '(absent)').toBe('human');
    // (b) child 측 파싱(parseMessageSource)이 실 payload 의 from 을 본다 — repl/index.ts:1543 와 동일 함수.
    expect(parseMessageSource(humanPayload.from)?.kind).toBe('human');
    // (c) 실 payload 를 핀 판별에 통과시킨다 — 사람 줄은 핀이 된다(chat.ts:797 와 동일 계약).
    const pinStore = createInMemoryGoalPinStore();
    const r = resolvePinnedObjective({ sessionId: 'goalpin-e2e', from: parseMessageSource(humanPayload.from), turnText: humanPayload.prompt }, pinStore);
    expect(r.pinned).toBe(true);
    expect(r.noticeTurn).toBe(false);
    // (d) 알림 턴 실 payload 는 system 출처 — 핀을 못 만든다(fail-closed).
    const noticePayload = JSON.parse(raws[1]);
    expect(parseMessageSource(noticePayload.from)?.kind).toBe('system');
    const r2 = resolvePinnedObjective({ sessionId: 'goalpin-e2e-fresh', from: parseMessageSource(noticePayload.from), turnText: noticePayload.prompt }, createInMemoryGoalPinStore());
    expect(r2.pinned).toBe(false);
  // (e) 실경로가 serializeTurnPayload 를 쓴다(단일 소싱) — 실 payload 줄을 순수 모듈로 재현해 동일.
  const rebuilt = JSON.parse(serializeTurnPayload({ prompt: humanPayload.prompt, from: HUMAN, id: humanPayload.id }));
    // deep-equal: 실경로가 모듈을 쓴다면 키 셋이 정확히 일치한다(id 포함 — 단일 소싱 증명).
    expect(Object.keys(rebuilt).sort().join(',')).toBe(Object.keys(humanPayload).sort().join(','));
    expect(rebuilt).toEqual(humanPayload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
