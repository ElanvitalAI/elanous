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
  test('coordinator: no coding lifecycle, no tree, no GPT-6 persist, permission addendum and profile present', () => {
    const out = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole: 'coordinator' }));
    expect(out).not.toContain('# Coding Agent Pipelines');
    expect(out).not.toContain('## Project Layout');
    expect(out).not.toContain('persist until the user');
    expect(out).not.toContain('Autonomy and persistence');
    expect(out).toContain('## When to ask for permission (GPT-6 guidance)');
    expect(out).toContain('## 조율자 프로필');
    expect(out).toContain('delegate implementation to a hand seat');
    expect(out).toContain('한 것·남은 것·증거');
    // 앵커(자리 지시)와 환경 정보는 그대로 실린다.
    expect(out).toContain('역할 = 조율');
    expect(out).toContain('# Environment');
  });

  test('hand seat adds contract while preserving lifecycle, tree, GPT-6 addendum', () => {
    const plain = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'] }));
    const hand = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole: 'hand' }));
    expect(hand).toContain('## Seat operating contract (every elanous seat)');
    expect(plain).not.toContain('## Seat operating contract (every elanous seat)');
    expect(plain).toContain('# Coding Agent Pipelines');
    expect(plain).toContain('## Project Layout');
    expect(plain).toContain('Autonomy and persistence');
    expect(plain).not.toContain('## 조율자 프로필');
  });
});

test('seat contract pins the complete investigation ladder for both roles', () => {
  for (const seatRole of ['coordinator', 'hand'] as const) {
    const out = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole }));
    expect(out).toContain("read the full checklist item's evidence");
    expect(out).toContain('git log origin/main --grep <work-item>');
    expect(out).toContain('gh pr list --search <work-item> --state all');
    expect(out).toContain('inspect `elanous logs` and calculate the observed values');
    expect(out).toContain('read the relevant seat-state ledger');
    expect(out).toContain('including a merged PR number when present');
    expect(out).toContain('do not ask an owner for evidence already found');
  }
});

// ELN-OP-OWNERSHIP-IDENTITY — OP 는 연방 결과의 주인이다. 제3자 말투·자기 결정 떠넘기기를 프로필에서 걷어낸다. 기대값 = 독립 리터럴.
describe('coordinator ownership identity', () => {
  const coordinatorText = (): string => text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole: 'coordinator' }));

  test('profile opens with accountability for federation outcomes', () => {
    const out = coordinatorText();
    const profileAt = out.indexOf('## 조율자 프로필 (이 자리 = 조율 자리)');
    const ownerAt = out.indexOf("- You own the federation's outcomes: the on-time release, the roster, hourly landings and greens, and the health of every seat.");
    expect(out).toContain('## 조율자 프로필 (이 자리 = 조율 자리)');
    // 주인 문장이 프로필의 첫 항목이다.
    expect(ownerAt).toBe(profileAt + '## 조율자 프로필 (이 자리 = 조율 자리)\n\n'.length);
    expect(out).toContain('Delegating work never transfers accountability.');
    expect(out).toContain('Decide in this turn.');
    expect(out).toContain('state it in first person: "I decided X because Y."');
    expect(out).toContain('Do not route your own decision to other seats for a cross-check');
    expect(out).toContain('A report is: decision taken + action executed + result verified.');
    expect(out).toContain('"I asked X" or "검증 중" is not a result');
    expect(out).toContain('attach a tracking wake (time + what you will check)');
    expect(out).toContain('Verify it yourself before you report (git, gh, `elanous logs`, the release checklist).');
    expect(out).toContain('Never claim what you did not verify');
  });

  test('old negative-only deferral lines are gone', () => {
    const out = coordinatorText();
    expect(out).not.toContain('이미 주인이 있는 일은 주인에게 먼저 묻는다');
    expect(out).not.toContain('판정·착지는 지정된 자리와 경로(리뷰·판정·착지 줄)로만 한다');
    expect(out).not.toContain('너는 구현 손이 아니라 조율자다');
    expect(out).not.toContain('not to wait for replies');
  });

  test('profile is session-stable (identical across rebuilds, cache pin)', () => {
    const first = coordinatorText();
    resetUniversalPreambleCache();
    expect(coordinatorText()).toBe(first);
  });
});

// ELN-FIRST-PRINCIPLE-IN-PROMPT — 제1원칙(관측 → 인지 → 셀프 힐링)이 모든 자리 계약의 맨 앞에 실린다. 기대값 = 독립 리터럴.
test('seat contract opens with the elanous first principle in order observe → recognize → self-heal', () => {
  for (const seatRole of ['coordinator', 'hand'] as const) {
    const out = text(buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole }));
    const head = '## Seat operating contract (every elanous seat)\n\nelanous first principle (제1원칙): observe → recognize → self-heal\n';
    expect(out).toContain(head);
    const start = out.indexOf(head);
    const observe = out.indexOf('- Observe (관측) with first-class CLIs', start);
    const recognize = out.indexOf('- Recognize (인지) top-down: repeated pattern (반복 꼴, L4)', start);
    const heal = out.indexOf('- Self-heal (셀프 힐링): fix the root cause', start);
    const persistence = out.indexOf('\nPersistence\n', start);
    expect(observe).toBeGreaterThan(start);
    expect(recognize).toBeGreaterThan(observe);
    expect(heal).toBeGreaterThan(recognize);
    expect(persistence).toBeGreaterThan(heal);
    expect(out).toContain('An observation gap is itself a defect to fix.');
    expect(out).toContain('(HITL ⊕ 정보)');
    expect(out).toContain('No symptom patches (regex, wording add-ons).');
    expect(out).toContain('three faces (세 얼굴): observation · decision basis · repair & handoff');
    expect(out).toContain('Coordinator seats: every check, retro, and bulletin follows observe → recognize (L4→L5→L6) → heal → verify.');
  }
});
