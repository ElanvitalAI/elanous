import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemoryInjection, listMemories } from '../memory.js';
import { dispatchMemorySave } from '../domains/core-tools.js';
import { debug } from '../debug/log.js';
import { rememberExplicitTuiUserFact } from './persistent-user-memory.js';

const root = mkdtempSync(join(tmpdir(), 'tui-persistent-memory-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('explicit user name survives a new turn through the pinned memory layer', () => {
  expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해. 다음 대화에서 말해 줘.', root)).toBe(false);
  expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해.', root)).toBe(true);
  const memories = listMemories({}, root);
  expect(memories).toHaveLength(1);
  expect(memories[0]?.pinned).toBe(true);
  expect(buildMemoryInjection('내 이름?', {}, root).block).toContain('다온');
  expect(rememberExplicitTuiUserFact('내 이름은 미르, 기억해.', root)).toBe(true);
  expect(listMemories({}, root)).toHaveLength(1);
  expect(buildMemoryInjection('내 이름?', {}, root).block).toContain('미르');
});

test('ordinary chat and ambiguous memory requests create no entry', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-persistent-memory-negative-'));
  try {
    expect(rememberExplicitTuiUserFact('내 이름은 다온.', separate)).toBe(false);
    expect(rememberExplicitTuiUserFact('이거 기억해 줘.', separate)).toBe(false);
    expect(rememberExplicitTuiUserFact('다음 문장을 분석해: 내 이름은 다온, 기억해.', separate)).toBe(false);
    expect(listMemories({}, separate)).toHaveLength(0);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('memory_save reuses the explicit user-name record instead of duplicating it', async () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-persistent-memory-tool-'));
  try {
    expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해.', separate)).toBe(true);
    const result = await dispatchMemorySave({ name: '사용자 이름', body: '사용자의 이름은 다온입니다.', type: 'user', pinned: true }, separate);
    expect(result).toEqual({ saved: true, id: 'tui-user-name', type: 'user', pinned: true });
    expect(listMemories({}, separate)).toHaveLength(1);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('memory_save reuses a directly saved fact and creates the stable name record first', async () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-tool-dedupe-'));
  try {
    expect(rememberExplicitTuiUserFact('오늘 회의는 오후 3시야, 기억해.', separate)).toBe(true);
    const first = listMemories({}, separate)[0]!;
    expect(await dispatchMemorySave({ name: '회의 시간', body: first.body, type: 'user' }, separate))
      .toMatchObject({ saved: true, id: first.id, pinned: true });
    expect(listMemories({}, separate)).toHaveLength(1);
    expect(await dispatchMemorySave({ name: '사용자 이름', body: '사용자가 직접 알려준 이름: 다온', type: 'user' }, separate))
      .toMatchObject({ saved: true, id: 'tui-user-name', pinned: true });
    expect(listMemories({}, separate)).toHaveLength(2);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('repeated preamble builds leave an existing memory untouched', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-persistent-memory-repeat-'));
  const actions: string[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, action) => {
    if (category === 'memory.persist') actions.push(action);
  });
  try {
    rememberExplicitTuiUserFact('내 이름은 다온, 기억해.', separate);
    rememberExplicitTuiUserFact('내 이름은 다온, 기억해.', separate);
    expect(actions).toEqual(['saved', 'unchanged']);
  } finally { log.mockRestore(); rmSync(separate, { recursive: true, force: true }); }
});

test('only an entire affirmative command persists a non-name fact', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-persistent-memory-fact-'));
  try {
    expect(rememberExplicitTuiUserFact('기억해: 나는 채식주의자야.', separate)).toBe(false);
    expect(rememberExplicitTuiUserFact('오늘 회의는 오후 3시야, 기억해.', separate)).toBe(true);
    expect(rememberExplicitTuiUserFact('I live in Seoul, remember this.', separate)).toBe(true);
    expect(listMemories({}, separate)).toHaveLength(2);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('one declarative fact followed by standalone 기억해 saves before model response', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-two-sentence-'));
  try {
    expect(rememberExplicitTuiUserFact('내 이름은 다온이야. 기억해.', separate)).toBe(true);
    expect(listMemories({}, separate)).toHaveLength(1);
    expect(listMemories({}, separate)[0]).toMatchObject({ name: '사용자 이름', pinned: true });
    expect(buildMemoryInjection('내 이름?', {}, separate).block).toContain('다온');
    expect(buildMemoryInjection('내 이름?', {}, separate).block).not.toContain('다온이야');
    expect(rememberExplicitTuiUserFact('나는 채식주의자야. 기억해줘', separate)).toBe(true);
    expect(listMemories({}, separate)).toHaveLength(2);
    for (const text of ['내 이름은 가온이야. 기억해?','내 이름은 가온이야. 기억해. 오늘 날씨는?',
      '내 이름은 가온이야. 아니, 기억해.', '내 이름은 가온이야. 기억해. 저장하지 마.',
      '기억해: 내 이름은 가온이야.']) {
      expect(rememberExplicitTuiUserFact(text, separate)).toBe(false);
    }
    expect(buildMemoryInjection('내 이름?', {}, separate).block).not.toContain('가온');
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('Terra ①: tool updates an existing user name instead of claiming stale memory is saved', async () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-name-update-'));
  try {
    expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해.', separate)).toBe(true);
    expect(await dispatchMemorySave({ name: '사용자 이름', body: '사용자가 직접 알려준 이름: 미르', type: 'user' }, separate))
      .toMatchObject({ saved: true, id: 'tui-user-name' });
    expect(buildMemoryInjection('내 이름?', {}, separate).block).toContain('미르');
    expect(buildMemoryInjection('내 이름?', {}, separate).block).not.toContain('다온');
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('Terra ②: same title with different facts has two content-based memory IDs', async () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-content-id-'));
  try {
    const first = await dispatchMemorySave({ name: '선호', body: '회의는 오전에', type: 'user', pinned: false }, separate) as { id: string };
    const second = await dispatchMemorySave({ name: '선호', body: '답변은 한국어로', type: 'user', pinned: true }, separate) as { id: string };
    expect(first.id).not.toBe(second.id);
    expect(listMemories({}, separate).map(entry => entry.body.trim()).sort()).toEqual(['답변은 한국어로', '회의는 오전에']);
    expect(listMemories({}, separate).find(entry => entry.body.trim() === '회의는 오전에')?.pinned).toBe(false);
    expect(listMemories({}, separate).find(entry => entry.body.trim() === '답변은 한국어로')?.pinned).toBe(true);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('Terra ③: negated remember requests and questions never become a name or fact', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-negation-'));
  try {
    for (const text of ['내 이름은 다온, 기억해 주지 마.', '내 이름은 다온, 기억해선 안 돼.', '내 이름은 다온, 기억해?',
      '내 이름은 다온인지 기억해? 알려줘.', 'Do not remember: my name is Daon.',
      "My name is Daon, don't remember it."]) {
      expect(rememberExplicitTuiUserFact(text, separate)).toBe(false);
    }
    expect(listMemories({}, separate)).toHaveLength(0);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('a trailing question delegates the whole message to memory_save', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-mixed-question-'));
  try {
    expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해. 오늘 날씨는 어때?', separate)).toBe(false);
    expect(listMemories({}, separate)).toHaveLength(0);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('refusal, decimal, and nonterminal imperative delegate to memory_save', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-last-intent-'));
  try {
    expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해. 아니, 기억하지 마.', separate)).toBe(false);
    expect(listMemories({}, separate)).toHaveLength(0);
    expect(rememberExplicitTuiUserFact('I weigh 70.5 kg, remember this', separate)).toBe(false);
    expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해. 다음에 알려줘', separate)).toBe(false);
    expect(listMemories({}, separate)).toHaveLength(0);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});

test('Terra ④: write failure calls the user-visible failure hook and reports no success', () => {
  const separate = mkdtempSync(join(tmpdir(), 'tui-memory-failure-'));
  try {
    const file = join(separate, 'not-a-directory');
    writeFileSync(file, 'occupied');
    let warnings = 0;
    expect(rememberExplicitTuiUserFact('내 이름은 다온, 기억해.', file, () => { warnings++; })).toBe(false);
    expect(warnings).toBe(1);
  } finally { rmSync(separate, { recursive: true, force: true }); }
});
