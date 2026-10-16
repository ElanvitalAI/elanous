// ── Shift+Enter 줄바꿈 — 터미널 바이트 → 입력창 판정 끝까지 (대표 10-14) ──────────
//
// 바이트 꼴은 herdr 0.9.1 실측에서 온다: 바깥 터미널이 보낸 키를 herdr 가 «pane 이 켠
// 프로토콜»로 다시 싸서 넘긴다(kitty 켬 → `CSI 13;2u` · modifyOtherKeys 켬 → `CSI 27;2;13~` ·
// 아무것도 안 켬 → 맨 `\r`). Alt+Enter(`ESC CR`)는 kitty 아래에서 `CSI 13;3u` 로 바뀐다.

import { describe, expect, test } from 'bun:test';

import { ansi, splitKeys } from '../src/tui.js';
import { resolveTextInputControlAction } from '../src/chat/input-control-key.js';
import {
  applyTurnTypeaheadKey,
  createTurnTypeaheadState,
  renderTurnTypeaheadEcho,
  renderTurnTypeaheadQueueRow,
} from '../src/chat/turn-typeahead.js';

const one = (bytes: string) => {
  const keys = splitKeys(bytes);
  expect(keys).toHaveLength(1);
  return keys[0]!;
};
const idle = (bytes: string) =>
  resolveTextInputControlAction(one(bytes), { currentLine: 'draft', cursor: 5 }).kind;

const NEWLINE_FORMS: Array<[string, string]> = [
  ['kitty Shift+Enter', '\x1b[13;2u'],
  ['modifyOtherKeys Shift+Enter', '\x1b[27;2;13~'],
  ['kitty Alt+Enter (herdr 가 ESC CR 을 바꾼 꼴)', '\x1b[13;3u'],
  ['modifyOtherKeys Alt+Enter', '\x1b[27;3;13~'],
  ['legacy ESC CR', '\x1b\r'],
  ['kitty Ctrl+J', '\x1b[106;5u'],
  ['legacy Ctrl+J (LF)', '\n'],
];

describe('Shift+Enter 줄바꿈 — 유휴 입력창', () => {
  for (const [label, bytes] of NEWLINE_FORMS) {
    test(`${label} → 줄바꿈`, () => {
      expect(idle(bytes)).toBe('newline');
    });
  }

  test('맨 Enter(CR) 와 kitty 맨 Enter 는 제출', () => {
    expect(idle('\r')).toBe('submit');
    expect(idle('\x1b[13u')).toBe('submit');
  });
});

describe('Shift+Enter 줄바꿈 — 턴 중 typeahead', () => {
  const typed = () => {
    let st = createTurnTypeaheadState();
    for (const ch of 'ab') st = applyTurnTypeaheadKey(st, { name: ch }).state;
    return st;
  };

  for (const [label, bytes] of NEWLINE_FORMS) {
    test(`${label} → 버퍼 줄바꿈 · 제출 안 함`, () => {
      const r = applyTurnTypeaheadKey(typed(), one(bytes));
      expect(r.consumed).toBe(true);
      expect(r.submissionDisposition).toBeUndefined();
      expect(r.state.buffer).toBe('ab\n');
      expect(r.state.queuedSubmissions).toEqual([]);
    });
  }

  test('빈 버퍼의 줄바꿈은 소유만 하고 버퍼를 안 바꾼다', () => {
    const r = applyTurnTypeaheadKey(createTurnTypeaheadState(), one('\x1b[13;2u'));
    expect(r).toMatchObject({ consumed: true, changed: false });
    expect(r.state.buffer).toBe('');
  });

  test('여러 줄 버퍼를 맨 Enter 로 한 발화로 제출 · 에코·큐 행은 한 줄(↵)', () => {
    let st = applyTurnTypeaheadKey(typed(), one('\x1b[13;2u')).state;
    st = applyTurnTypeaheadKey(st, { name: 'c' }).state;
    expect(renderTurnTypeaheadEcho(st, 80)).toBe('ab↵c');
    const r = applyTurnTypeaheadKey(st, one('\r'));
    expect(r.submissionDisposition).toBe('fifo');
    expect(r.state.queuedSubmissions).toEqual(['ab\nc']);
    expect(renderTurnTypeaheadQueueRow(r.state, 120)).toContain('"ab↵c"');
  });
});

describe('Shift+Enter 줄바꿈 — 켜기 시퀀스', () => {
  test('kitty(>1u) ⊕ modifyOtherKeys(>4;2m) 켜기 · 끄기 짝', () => {
    expect(ansi.kittyKbOn).toBe('\x1b[>1u');
    expect(ansi.kittyKbOff).toBe('\x1b[<u');
    expect(ansi.modKeysOn).toBe('\x1b[>4;2m');
    expect(ansi.modKeysOff).toBe('\x1b[>4;0m');
  });
});
