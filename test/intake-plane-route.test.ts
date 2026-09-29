import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  expect(routeIntakeItem(r, id, check, {}, NOW)).toEqual({ id, goals: 1, manual: 1, review: 1, grounding: 1, release: 0, unmeasured: 0, measured: 4, dryRun: false });
  const out = intakeOutboxDir(r);
  expect(lines(join(out, 'goals', '2026-09-26.jsonl'))[0]).toMatchObject({ id, fact: 'elanous 에 `foo bar` 가 있다', patterns: ['foo bar'], commit: 'abc' });
  expect(lines(join(out, 'manual', '2026-09-26.jsonl'))[0]).toMatchObject({ id, evidence: ['docs/x.md:1'] });
  expect(lines(join(out, 'review', '2026-09-26.jsonl'))[0]).toMatchObject({ id, fact: 'elanous 는 `qux` 를 한다', note: '/vault/note.md' });
  expect(lines(join(out, 'grounding.jsonl'))).toEqual([{ path: '/vault/note.md', kind: 'local-docs', tag: 'intake:youtube', at: NOW, id }]);
  expect(listIntakeItems(r)[0].status).toBe('routed');
});

test('모든 주장을 못 쟀으면 건너뛰고 재대조할 수 있게 상태·큐를 그대로 둔다; 일부만 못 쟀으면 나머지는 나눈다', () => {
  const r = root();
  ingestIntakeItems(r, 'youtube', [
    { url: 'https://youtu.be/aaaaaaaaaaa' },
    { url: 'https://youtu.be/bbbbbbbbbbb' },
  ], NOW, quiet);
  const [a, b] = listIntakeItems(r).map((item) => item.id);
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  markIntakeItem(r, a!, { status: 'absorbed', output: { kind: 'note', ref: '/vault/a.md' } }, NOW);
  markIntakeItem(r, b!, { status: 'absorbed', output: { kind: 'note', ref: '/vault/b.md' } }, NOW);
  const missing = (n: number): IntakeCheckJson['items'][number] => ({ fact: `주장 ${n}`, current: '대조 실패', verdict: '못 쟀다' });
  const resultA = routeIntakeItem(r, a!, { items: [1, 2, 3, 4].map(missing) }, {}, NOW);
  expect(resultA).toMatchObject({ skipped: '모든 주장을 못 쟀다 — 대조를 다시 돌려라', measured: 0, unmeasured: 4, goals: 0, grounding: 0 });
  expect(listIntakeItems(r).find((item) => item.id === a)?.status).toBe('absorbed');
  expect(existsSync(intakeOutboxDir(r))).toBe(false);
  const resultB = routeIntakeItem(r, b!, { items: [
    { fact: '새 기능', current: '전수 0건', verdict: '없음' }, missing(1), missing(2),
  ] }, {}, NOW);
  expect(resultB).toMatchObject({ goals: 1, unmeasured: 2, measured: 1, grounding: 1 });
  expect(resultB.skipped).toBeUndefined();
  expect(listIntakeItems(r).find((item) => item.id === b)?.status).toBe('routed');
  expect(lines(join(intakeOutboxDir(r), 'goals', '2026-09-26.jsonl'))).toHaveLength(1);
  expect(lines(join(intakeOutboxDir(r), 'grounding.jsonl'))).toHaveLength(1);
});

test('CLI route 는 전부 미측정 시 JSON·텍스트 모두 실패 종료하고 항목을 다시 대조할 수 있게 둔다', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const r = root();
  ingestIntakeItems(r, 'youtube', [{ url: 'https://youtu.be/aaaaaaaaaaa' }], NOW, quiet);
  const id = listIntakeItems(r)[0]!.id;
  markIntakeItem(r, id, { status: 'absorbed' }, NOW);
  const checkFile = join(r, 'check.json');
  writeFileSync(checkFile, JSON.stringify({ items: [{ fact: '주장', current: '대조 실패', verdict: '못 쟀다' }] }));
  for (const json of [false, true]) {
    const args = [join(repo, 'bin/elanous.mjs'), `--test=${r}`, 'intake', 'route', id, '--check-json', checkFile, ...(json ? ['--json'] : [])];
    const result = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(1);
    if (json) expect(JSON.parse(result.stdout)).toMatchObject({ skipped: '모든 주장을 못 쟀다 — 대조를 다시 돌려라', unmeasured: 1, measured: 0 });
    else expect(result.stdout).toContain(`${id}: 건너뜀 — 모든 주장을 못 쟀다 — 대조를 다시 돌려라`);
    expect(listIntakeItems(r)[0]?.status).toBe('absorbed');
  }
  ingestIntakeItems(r, 'youtube', [{ url: 'https://youtu.be/bbbbbbbbbbb' }], NOW, quiet);
  const nextId = listIntakeItems(r).find((item) => item.id !== id)!.id;
  markIntakeItem(r, nextId, { status: 'absorbed' }, NOW);
  writeFileSync(checkFile, JSON.stringify({ items: [
    { fact: '새 기능', current: '전수 0건', verdict: '없음' },
    { fact: '주장', current: '대조 실패', verdict: '못 쟀다' },
  ] }));
  const partial = spawnSync(process.execPath, [join(repo, 'bin/elanous.mjs'), `--test=${r}`, 'intake', 'route', nextId, '--check-json', checkFile], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
  expect(partial.status, partial.stderr).toBe(0);
  expect(partial.stdout).toContain(`${nextId} → 골 후보 1 · 매뉴얼 후보 0 · 판단 필요 0 · 그라운딩 후보 0 · 못 쟀다 1`);
  expect(listIntakeItems(r).find((item) => item.id === nextId)?.status).toBe('routed');
}, 30_000); // CLI 를 두 번 띄운다 — mbp 에서 약 9초(2026-09-27 실측 · 기본 5초 초과)

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
