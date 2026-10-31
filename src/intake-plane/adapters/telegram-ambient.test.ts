import { expect, test } from 'bun:test';
import { createTelegramAmbientMessageHandler } from './telegram-ambient.js';

test('explicit Linear secretary request runs with ambient capture off and returns the reply card', async () => {
  const requests: string[] = [];
  const handle = createTelegramAmbientMessageHandler({ runSecretary: async request => { requests.push(request); return { replyCard: '등록: 부모 1개 · 하위 4개' }; } });
  const result = await handle({ text: '11-04 데모 준비 리니어로 정리해줘', chatId: 7, userId: 9, ambientCapture: 'off' });
  expect(requests).toEqual(['11-04 데모 준비 리니어로 정리해줘']);
  expect(result).toBe('등록: 부모 1개 · 하위 4개');
});

test('direct Linear requests may include trailing task details', async () => {
  const requests: string[] = [];
  const handle = createTelegramAmbientMessageHandler({ runSecretary: async request => { requests.push(request); return { replyCard: '등록됨' }; } });
  await handle({ text: 'linear로 만들어줘 11-04 데모 준비', chatId: 7, userId: 9, ambientCapture: 'off' });
  expect(requests).toEqual(['linear로 만들어줘 11-04 데모 준비']);
});

test('ordinary ambient messages still obey the configured capture mode', async () => {
  let called = false;
  const handle = createTelegramAmbientMessageHandler({
    runSecretary: async () => { called = true; return { replyCard: 'unexpected' }; },
  });
  const result = await handle({ text: '짧은 메모', chatId: 7, userId: 9, ambientCapture: 'off' });
  expect(called).toBe(false);
  expect(result).toBeNull();
});

test('Linear secretary failures return an actionable reply instead of escaping the Telegram handler', async () => {
  const handle = createTelegramAmbientMessageHandler({ runSecretary: async () => { throw new Error('sensitive internal detail'); } });
  await expect(handle({ text: '리니어로 정리해줘', chatId: 7, userId: 9, ambientCapture: 'off' }))
    .resolves.toBe('Linear 등록을 보류했습니다. 요청 날짜와 근거를 확인한 뒤 다시 시도해 주세요.');
});

test('ordinary registration language without Linear intent does not start the secretary', async () => {
  let called = false;
  const handle = createTelegramAmbientMessageHandler({ runSecretary: async () => { called = true; return { replyCard: 'unexpected' }; } });
  expect(await handle({ text: '이 메모를 등록해줘', chatId: 7, userId: 9, ambientCapture: 'off' })).toBeNull();
  expect(called).toBe(false);
});

test('quoted or indirect Linear phrases do not trigger issue creation', async () => {
  let called = false;
  const handle = createTelegramAmbientMessageHandler({ runSecretary: async () => { called = true; return { replyCard: 'unexpected' }; } });
  expect(await handle({ text: 'linear로 만들어 보라 하던데, 무슨 뜻이야?', chatId: 7, userId: 9, ambientCapture: 'off' })).toBeNull();
  expect(await handle({ text: 'linear로 만들어줘 하던데, 무슨 뜻이야?', chatId: 7, userId: 9, ambientCapture: 'off' })).toBeNull();
  expect(called).toBe(false);
});
