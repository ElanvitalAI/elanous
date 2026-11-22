// 출처: OP #129546/#129594(필수 ① — «묶음 dispatch 에 전체 id·msgId 목록 전달·각각 결속») — SEAT-NOTICE-BUNDLE-DRAIN 회귀.
// 첫 항목뿐 아니라 묶음 30통 전부가 plan link(onSeatMail)에 제 본문 그대로 결속되고, 묶음은 한 턴으로 열린다.
import { test, expect } from 'bun:test';
import { dispatchQueuedExternalEventOne } from './entry.js';

test('bundle dispatch binds every bundled seat-mail notice — 30/30 to the plan link, one turn (OP #129546)', async () => {
  const planLink: Array<{ id: string; text: string }> = [];
  const started: string[] = [];
  const notices = Array.from({ length: 30 }, (_, i) => ({
    id: `mail-${i + 1}`,
    text: `body ${i + 1}`,
    source: 'seat-mail',
    msgId: i + 1,
    remaining: 0,
  }));
  const leaf = {
    openExternalEventOne: () => ({ injected: true }),
    dispatchExternalEventOne: (input: { startChatTurn: (text: string, status: string) => void }) => {
      input.startChatTurn('BUNDLE-OPENED', 'ok');
    },
  };
  await dispatchQueuedExternalEventOne({
    notice: { id: 'mail-1', text: 'body 1', source: 'seat-mail', msgId: 1, remaining: 0 },
    bundled: notices,
    onSeatMail: (id, text) => { planLink.push({ id, text }); },
    injectKey: () => {},
    keepOpen: () => { throw new Error('keepOpen must not fire: the turn started'); },
    startChatTurn: (text, status) => { started.push(`${text}|${status}`); },
    log: () => {},
    held: () => true,
    afterDispatch: () => {},
    wire: Promise.resolve(leaf as unknown as typeof import('./external-event-one-wire.js')),
  });
  // 수리 전(RED): 첫 항목만 결속(1/30). 수리 후(GREEN): 30통 전부 각각 결속.
  expect(planLink).toHaveLength(30);
  expect(planLink.map((one) => one.id)).toEqual(Array.from({ length: 30 }, (_, i) => `mail-${i + 1}`));
  // 제 본문 그대로(합쳐진 문면이 아님) — 30번째 우편 확인.
  expect(planLink[29]!.text).toBe('body 30');
  // 묶음은 한 턴.
  expect(started).toEqual(['BUNDLE-OPENED|ok']);
}, 20000);