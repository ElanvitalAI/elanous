import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSeatBootSystemMessages, startSeatBootConversation } from '../seat/seat-boot-preamble.js';
import { seatHandoffStateRoot } from '../memory.js';
import { buildOpHandoffRecall } from './seat-handoff-recall.js';

test('OP restart recalls decisions, landing lesson, open PRs and appointments on first turn', () => {
  const home = mkdtempSync(join(tmpdir(), 'op-handoff-restart-'));
  const op = join(home, 'elanous-hq', 'seat-state', 'OP');
  mkdirSync(op, { recursive: true });
  writeFileSync(join(op, 'DECISIONS-OP.tsv'), '2026-11-21 17:03\tDEMO-SWAP-FREE\t데모 교체 허용\tTG\n');
  writeFileSync(join(op, 'LANDING-KNOWHOW.md'), '# 착지 노하우\n| L42 | 판정 뒤 head 변경 | 재검토 | 새 head 재판정 | 사례 |\n');
  writeFileSync(join(op, 'OPEN-PR-TRIAGE.tsv'), '# OPEN-PR-TRIAGE 11-21 20:10 KST · 열림 2\nPR\t주분류\t부분류\t상태\t무변경\tmergeable\t브랜치\t제목\n39457\t리뷰 중\t-\tready\t1h\tMERGEABLE\top/route\tELS route fix\n');
  writeFileSync(join(op, 'HANDOFF-OP-to-eln-codex-1122.md'), '# OP 인계\n- 시각: 11-22 07:30 OP 전환 약속\n');
  const cwd = join(home, 'elanous-hq', 'seats', 'OP');
  const deps = { home, msgPath: join(home, 'absent.db'), env: {}, now: () => new Date('2026-11-22T00:00:00+09:00') };
  try {
    startSeatBootConversation({ reason: 'boot' });
    const first = String(buildSeatBootSystemMessages({ cwd }, deps)[0]?.content ?? '');
    expect(first.split('\n')[0]).toBe('OP 첫 턴: PR 목록은 과거 스냅샷이다. 진행 중 PR을 말하기 전에 현재 GitHub 정본을 다시 확인하고, 조회 실패면 확인 불가로 말하라.');
    expect(first).toContain('DEMO-SWAP-FREE');
    writeFileSync(join(op, 'DECISIONS-OP.tsv'), '2026-11-21 18:00\tNEW-DECISION\tafter restart\tTG\n');
    expect(buildSeatBootSystemMessages({ cwd }, deps)[0]?.content).toBe(first);
    startSeatBootConversation({ reason: 'session-new' });
    const card = buildSeatBootSystemMessages({ cwd }, deps)[0]?.content ?? '';
    expect(card).toContain('어제 결정');
    expect(card).toContain('NEW-DECISION');
    expect(card).not.toContain('DEMO-SWAP-FREE');
    expect(card).toContain('LANDING-KNOWHOW');
    expect(card).toContain('L42');
    expect(card).toContain('진행 중 PR');
    expect(card).toContain('39457');
    expect(card).toContain('약속');
    expect(card).toContain('07:30 OP 전환');
  } finally {
    startSeatBootConversation({ reason: 'session-clear' });
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing and linked OP sources are explicit, and isolated state never reads the home copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-handoff-isolated-'));
  const home = join(root, 'home');
  const isolated = join(root, 'isolated');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
  mkdirSync(join(isolated, 'seat-state', 'OP'), { recursive: true });
  expect(seatHandoffStateRoot(home, { ELANOUS_STATE_DIR: isolated })).toBe(join(isolated, 'seat-state'));
  writeFileSync(join(home, 'elanous-hq', 'seat-state', 'OP', 'DECISIONS-OP.tsv'), '2026-11-21 17:03\tSECRET-HOME-DECISION\tshould not leak\tOP\n');
  symlinkSync(join(home, 'elanous-hq', 'seat-state', 'OP', 'DECISIONS-OP.tsv'), join(isolated, 'seat-state', 'OP', 'DECISIONS-OP.tsv'));
  try {
    const block = buildOpHandoffRecall(join(isolated, 'seat-state'), new Date('2026-11-22T07:30:00+09:00'));
    expect(block).toContain('DECISIONS-OP.tsv]: 읽기 실패');
    expect(block).toContain('LANDING-KNOWHOW.md]: 없음');
    expect(block).not.toContain('SECRET-HOME-DECISION');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP directory and its parent cannot link outside the trusted handoff root', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-handoff-parent-link-'));
  const outside = join(root, 'outside');
  const home = join(root, 'home');
  const op = join(home, 'elanous-hq', 'seat-state', 'OP');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state'), { recursive: true });
  writeFileSync(join(outside, 'DECISIONS-OP.tsv'), '2026-11-21 17:03\tOUTSIDE-SECRET\tshould not appear\tOP\n');
  const cwd = join(home, 'elanous-hq', 'seats', 'OP');
  const deps = { home, msgPath: join(root, 'absent.db'), env: {}, now: () => new Date('2026-11-22T07:30:00+09:00') };
  try {
    symlinkSync(outside, op);
    startSeatBootConversation({ reason: 'boot' });
    const card = buildSeatBootSystemMessages({ cwd }, deps)[0]?.content ?? '';
    expect(card).toContain('OP 첫 턴 회상');
    expect(card).toContain('격리 경계 거부');
    expect(card).not.toContain('OUTSIDE-SECRET');
    rmSync(op);
    rmSync(join(home, 'elanous-hq'), { recursive: true });
    symlinkSync(outside, join(home, 'elanous-hq'));
    mkdirSync(join(outside, 'seat-state', 'OP'), { recursive: true });
    writeFileSync(join(outside, 'seat-state', 'OP', 'DECISIONS-OP.tsv'), '2026-11-21 17:03\tPARENT-SECRET\tshould not appear\tOP\n');
    startSeatBootConversation({ reason: 'session-new' });
    const parentCard = buildSeatBootSystemMessages({ cwd }, deps)[0]?.content ?? '';
    expect(parentCard).toContain('격리 경계 거부');
    expect(parentCard).not.toContain('PARENT-SECRET');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
