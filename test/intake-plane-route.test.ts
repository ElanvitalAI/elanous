import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from '../src/intake-plane/items.js';
import { intakeOutboxDir, routeIntakeItem, type IntakeCheckJson } from '../src/intake-plane/route.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'intake-route-')); roots.push(r); return r; };
const quiet = () => {};
const NOW = '2026-09-26T10:00:00.000Z';
const lines = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const check: IntakeCheckJson = {
  commit: 'abc',
  items: [
    { fact: 'elanous 에 `foo bar` 가 있다', current: '전수 0건', verdict: '없음', patterns: ['foo bar'] },
    { fact: 'elanous 는 `baz` 를 한다', current: '문서·주석 언급만 있다 — 동작 근거가 없다', verdict: '판단 필요', evidence: [{ summary: 'docs/x.md:1' }] },
    { fact: 'elanous 는 `qux` 를 한다', current: '이름은 있으나 설계 판단이 필요하다', verdict: '판단 필요' },
    { fact: 'elanous 에 `run` 이 있다', current: '근거 있음', verdict: '있음' },
  ],
};

function absorbed(r: string, source: 'youtube' | 'telegram-saved', text?: string) {
  ingestIntakeItems(r, source, [{ url: 'https://youtu.be/aaaaaaaaaaa', ...(text ? { text } : {}) }], NOW, quiet);
  const id = listIntakeItems(r)[0].id;
  markIntakeItem(r, id, { status: 'absorbed', output: { kind: 'note', ref: '/vault/note.md' } }, NOW);
  return id;
}

test('「없음」은 goals · 문서뿐인 「판단 필요」는 manual · 그 밖의 「판단 필요」는 review · 노트는 grounding 후보 · 항목은 routed', () => {
  const r = root();
  const id = absorbed(r, 'youtube');
  expect(routeIntakeItem(r, id, check, {}, NOW)).toEqual({ id, goals: 1, manual: 1, review: 1, grounding: 1, release: 0, dryRun: false });
  const out = intakeOutboxDir(r);
  expect(lines(join(out, 'goals', '2026-09-26.jsonl'))[0]).toMatchObject({ id, fact: 'elanous 에 `foo bar` 가 있다', patterns: ['foo bar'], commit: 'abc' });
  expect(lines(join(out, 'manual', '2026-09-26.jsonl'))[0]).toMatchObject({ id, evidence: ['docs/x.md:1'] });
  expect(lines(join(out, 'review', '2026-09-26.jsonl'))[0]).toMatchObject({ id, fact: 'elanous 는 `qux` 를 한다', note: '/vault/note.md' });
  expect(lines(join(out, 'grounding.jsonl'))).toEqual([{ path: '/vault/note.md', kind: 'local-docs', tag: 'intake:youtube', at: NOW, id }]);
  expect(listIntakeItems(r)[0].status).toBe('routed');
});

test('이미 routed 면 다시 나누지 않는다 · 같은 노트는 grounding 에 한 번만', () => {
  const r = root();
  const id = absorbed(r, 'youtube');
  routeIntakeItem(r, id, check, {}, NOW);
  expect(routeIntakeItem(r, id, check, {}, NOW).skipped).toBe('이미 routed');
  expect(lines(join(intakeOutboxDir(r), 'grounding.jsonl'))).toHaveLength(1);
});

test('⛔ 개인 메모 원문(원장 text)은 큐에 싣지 않는다', () => {
  const r = root();
  const id = absorbed(r, 'telegram-saved', '비밀 메모 문장');
  routeIntakeItem(r, id, check, {}, NOW);
  const out = intakeOutboxDir(r);
  const all = [join(out, 'goals', '2026-09-26.jsonl'), join(out, 'manual', '2026-09-26.jsonl'), join(out, 'grounding.jsonl')]
    .map((f) => existsSync(f) ? readFileSync(f, 'utf8') : '').join('\n');
  expect(all.includes('비밀 메모 문장')).toBe(false);
  expect(all).toContain('intake:telegram-saved');
});

test('dry-run 은 큐·상태를 바꾸지 않는다 · 없는 id 는 건너뛴다', () => {
  const r = root();
  const id = absorbed(r, 'youtube');
  expect(routeIntakeItem(r, id, check, { dryRun: true }, NOW)).toMatchObject({ goals: 1, manual: 1, review: 1, grounding: 1, dryRun: true });
  expect(existsSync(intakeOutboxDir(r))).toBe(false);
  expect(listIntakeItems(r)[0].status).toBe('absorbed');
  expect(routeIntakeItem(r, 'nope', check).skipped).toBe('원장에 없는 id');
});

test('O4 — 「있음」이면서 실행 코드 근거가 있으면 릴리스 노트 바깥 맥락 · 근거 파일의 마지막 착지 커밋을 싣는다', () => {
  const r = root();
  const id = absorbed(r, 'youtube');
  const withCode: IntakeCheckJson = {
    tree: '/repo',
    items: [
      { fact: 'elanous 에 `intake queue` 가 있다', current: '실행 근거 있음', verdict: '있음', evidence: [{ axis: 'repo', repoKind: 'behavior', path: 'src/intake-plane/items.ts', line: 200 }] },
      { fact: 'elanous 는 `docs-only` 를 한다', current: '문서 근거', verdict: '있음', evidence: [{ axis: 'repo', repoKind: 'document', path: 'docs/x.md' }] },
    ],
  };
  const asked: string[] = [];
  const res = routeIntakeItem(r, id, withCode, { lastCommitOf: (tree, path) => { asked.push(`${tree}|${path}`); return 'c0ffee'; } }, NOW);
  expect(res.release).toBe(1);
  expect(asked).toEqual(['/repo|src/intake-plane/items.ts']);
  expect(lines(join(intakeOutboxDir(r), 'release', '2026-09-26.jsonl'))).toEqual([{
    id, at: NOW, kind: 'docs', title: 'elanous 에 `intake queue` 가 있다', summary: '실행 근거 있음',
    sources: ['https://www.youtube.com/watch?v=aaaaaaaaaaa'], evidence: ['src/intake-plane/items.ts:200'], suggestedSection: '바깥 맥락', landedSha: 'c0ffee',
  }]);
});

test('큐 파일 날짜는 KST — 07:00 KST 크론(UTC 로는 전날 22:00)의 산출이 그날 다이제스트 파일에 든다', () => {
  const r = root();
  const id = absorbed(r, 'youtube');
  routeIntakeItem(r, id, check, {}, '2026-09-25T22:00:00.000Z');
  const out = intakeOutboxDir(r);
  expect(lines(join(out, 'goals', '2026-09-26.jsonl'))).toHaveLength(1);
  expect(existsSync(join(out, 'goals', '2026-09-25.jsonl'))).toBe(false);
});
