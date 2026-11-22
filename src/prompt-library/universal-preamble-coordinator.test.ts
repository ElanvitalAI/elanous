// SEAT-COORDINATOR-PROMPT-PROFILE — 조율자(OP) 자리 preamble 에는 코딩 lifecycle·트리·GPT-6 «persist» 덧말이 없고
// 조율자 프로필이 실린다. 손 자리·비자리 preamble 은 종전 그대로(회귀). 기대값 = 독립 리터럴.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUniversalPreamble, resetUniversalPreambleCache, setGlobalAnchorPathForTest } from './universal-preamble.js';

let root = '';
let cwd = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coord-preamble-'));
  cwd = join(root, 'seats', 'OP');
  mkdirSync(join(cwd, 'notes'), { recursive: true });
  writeFileSync(join(cwd, 'AGENTS.local.md'), '역할 = 조율\n');
  writeFileSync(join(cwd, 'notes', 'a.md'), 'x\n');
  setGlobalAnchorPathForTest(null);
  resetUniversalPreambleCache();
});
afterEach(() => {
  setGlobalAnchorPathForTest(undefined);
  resetUniversalPreambleCache();
  rmSync(root, { recursive: true, force: true });
});

const text = (msgs: ReturnType<typeof buildUniversalPreamble>): string => msgs.map((m) => String(m.content)).join('\n\n');

describe('coordinator preamble profile', () => {
  test('coordinator: no coding lifecycle, no tree, no GPT-6 persist/permission addendum, profile present', () => {
    const out = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole: 'coordinator' }));
    expect(out).not.toContain('# Coding Agent Pipelines');
    expect(out).not.toContain('## Project Layout');
    expect(out).not.toContain('persist until the user');
    expect(out).not.toContain('Autonomy and persistence');
    expect(out).not.toContain('Do not introduce unsolicited warnings, disclaimers, approval flows');
    expect(out).toContain('## 조율자 프로필');
    expect(out).toContain('위임');
    expect(out).toContain('한 것·남은 것·증거');
    // 앵커(자리 지시)와 환경 정보는 그대로 실린다.
    expect(out).toContain('역할 = 조율');
    expect(out).toContain('# Environment');
  });

  test('hand seat / no role: exact current preamble (lifecycle, tree, GPT-6 addendum)', () => {
    const plain = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'] }));
    const hand = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole: 'hand' }));
    expect(hand).toBe(plain);
    expect(plain).toContain('# Coding Agent Pipelines');
    expect(plain).toContain('## Project Layout');
    expect(plain).toContain('Autonomy and persistence');
    expect(plain).not.toContain('## 조율자 프로필');
  });
});
