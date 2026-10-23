import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWHOW_DOC_RELATIVE_PATH, buildKnowhowPack, evaluateExpectation, isReadOnlyCommand, knowhowAdvice,
  loadKnowhowPack, matchKnowhowItem, measureKnowhowItem, parseKnowhowDoc, readOnlyRunner,
  resolveKnowhowDocPath, type KnowhowItem,
} from './knowhow-pack.js';

const DOC = `# KNOWHOW

## K-OP-001 착지 거부
- 상황: 리뷰가 «main 보다 뒤» 라며 착지를 거부한다
- 신호(관측): rejudge 해도 fromHead 가 같다
- 처방(힐링): 앞머리에 rebase 한 줄을 넣는다
- 재는 명령: \`git rev-list --count ..origin/main\`
- 기대: ≥1
- 유효 조건: 상시
- 출처: 10-01 #1 · 상태: active

## K-OP-002 지난 항목
- 상황: 지난 판의 잠금 순서
- 재는 명령: \`git status --porcelain\`
- 기대: 0 줄
- 출처: 10-01 #2 · 상태: superseded

## K-OP-003 재는 명령 없음
- 상황: 아직 재는 방법을 모르는 항목
- 기대: 사람 확인
- 출처: 10-01 #3 · 상태: active

## K-OP-004 자리표시자 명령
- 상황: 명령 자리를 비워 둔 항목
- 재는 명령: \`(없음 — 아직 정하지 않음)\`
- 기대: 사람 확인
- 출처: 10-01 #4 · 상태: active
`;

function itemDoc(id: string, title: string, situation: string): string {
  return `## ${id} ${title}
- 상황: ${situation}
- 재는 명령: \`git status --porcelain\`
- 기대: 0 줄
- 출처: 10-01 · 상태: active
`;
}

function fixtureItem(overrides: Partial<KnowhowItem> = {}): KnowhowItem {
  return {
    id: 'K-OP-900', title: '재는 시험', status: 'active', situation: '시험 상황', signal: '시험 신호',
    prescription: '시험 처방', command: 'git status --porcelain', expectation: '0 줄', validWhen: '상시',
    source: '시험 · 상태: active', ...overrides,
  };
}

test('pack keeps only active items that carry a measurement command, sorted by id', () => {
  const items = parseKnowhowDoc(DOC);
  expect(items.map(item => item.id)).toEqual(['K-OP-001']);
  expect(items[0]!.command).toBe('git rev-list --count ..origin/main');
  expect(items[0]!.expectation).toBe('≥1');
  expect(items[0]!.prescription).toBe('앞머리에 rebase 한 줄을 넣는다');
});

test('pack carries a version and a content hash that changes when an item body changes', () => {
  const first = buildKnowhowPack(parseKnowhowDoc(DOC), '/tmp/knowhow.md');
  const again = buildKnowhowPack(parseKnowhowDoc(DOC), '/tmp/knowhow.md');
  expect(first.version).toBe('K3');
  expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
  expect(again.hash).toBe(first.hash);
  const changed = buildKnowhowPack(parseKnowhowDoc(DOC.replace('rebase 한 줄을 넣는다', 'merge 를 쓴다')), '/tmp/knowhow.md');
  expect(changed.hash).not.toBe(first.hash);
});

test('resident pack reloads when the doc lands a new item, without a code deploy', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowhow-pack-'));
  const docPath = join(root, 'KNOWHOW.md');
  try {
    writeFileSync(docPath, itemDoc('K-OP-101', '첫 항목', '첫 상황'));
    const before = loadKnowhowPack(docPath)!;
    expect(before.items.map(item => item.id)).toEqual(['K-OP-101']);
    expect(loadKnowhowPack(docPath)).toBe(before);
    writeFileSync(docPath, `${itemDoc('K-OP-101', '첫 항목', '첫 상황')}\n${itemDoc('K-OP-102', '둘째 항목', '둘째 상황')}`);
    const after = loadKnowhowPack(docPath)!;
    expect(after.items.map(item => item.id)).toEqual(['K-OP-101', 'K-OP-102']);
    expect(after.hash).not.toBe(before.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('matching needs two words shared with 상황·신호 and ignores the item id title noise', () => {
  const pack = buildKnowhowPack(parseKnowhowDoc(`${itemDoc('K-OP-201', '착지 거부', '리뷰가 main 보다 뒤 라며 착지를 거부한다')}`
    + `\n${itemDoc('K-OP-202', '메뉴 추천', '점심 메뉴를 고르는 규칙')}`), '/tmp/knowhow.md');
  const hit = matchKnowhowItem(pack, '리뷰가 main 보다 뒤 라며 착지를 거부한다', 0)!;
  expect(hit.item.id).toBe('K-OP-201');
  expect(hit.matchedTokens.length).toBeGreaterThanOrEqual(2);
  expect(matchKnowhowItem(pack, '리뷰가', 0)).toBeNull();
  expect(matchKnowhowItem(pack, '그리고 지금 어떻게', 0)).toBeNull();
});

test('real OP KNOWHOW inventory answers the behind-main landing question with one item', () => {
  const docPath = resolveKnowhowDocPath()!;
  const pack = loadKnowhowPack(docPath)!;
  expect(pack.items.length).toBeGreaterThan(10);
  const match = matchKnowhowItem(pack, 'PR 착지가 «main 보다 뒤» 라며 거부됐다 — rejudge 해도 fromHead 와 toHead 가 같다');
  expect(match?.item.id).toBe('K-OP-083');
  expect(matchKnowhowItem(pack, '오늘 점심 메뉴 추천해줘')).toBeNull();
});

test('read-only allowlist runs reads and refuses every writer', () => {
  expect(isReadOnlyCommand('rg -c "같은 순간" docs/roles/OP/KNOWHOW.md')).toEqual({ ok: true });
  expect(isReadOnlyCommand('git rev-list --count origin/main')).toEqual({ ok: true });
  expect(isReadOnlyCommand('git worktree list | rg elanous')).toEqual({ ok: true });
  expect(isReadOnlyCommand('eln tasks show t-1')).toEqual({ ok: true });
  const refused = ['git push origin main', 'git branch -D feature', 'git checkout main', 'rm -rf build',
    'eln tasks rejudge 12345', 'eln release publish', 'cat a > b', 'rg x $(git rev-parse HEAD)', 'git commit -m x'];
  for (const command of refused) {
    expect(isReadOnlyCommand(command).ok).toBe(false);
  }
});

test('expectation comparison judges counts and lower bounds and admits what it cannot read', () => {
  expect(evaluateExpectation('≥1', '3\n').verdict).toBe('confirmed');
  expect(evaluateExpectation('2 줄', '3\n').verdict).toBe('stale');
  expect(evaluateExpectation('≥1', '0').verdict).toBe('stale');
  expect(evaluateExpectation('0 줄', '').verdict).toBe('confirmed');
  expect(evaluateExpectation('0 줄', 'a\nb\n').verdict).toBe('stale');
  expect(evaluateExpectation('참 (사람)', 'whatever').verdict).toBe('unverifiable');
});

test('measurement reports unmeasured for a guarded or failing command and stale on mismatch', () => {
  const guarded = measureKnowhowItem(fixtureItem({ command: 'eln tasks rejudge 12345' }), () => ({ status: 0, output: '' }));
  expect(guarded.freshness).toBe('unmeasured');
  expect(guarded.detail).toContain('읽기 전용 허용 목록 밖');

  const skipped = measureKnowhowItem(fixtureItem(), () => ({ status: -1, output: '', skipped: 'placeholder 미치환' }));
  expect(skipped.freshness).toBe('unmeasured');

  const failed = measureKnowhowItem(fixtureItem(), () => ({ status: 2, output: '' }));
  expect(failed.freshness).toBe('unmeasured');
  expect(failed.detail).toContain('rc=2');

  const confirmed = measureKnowhowItem(fixtureItem({ expectation: '≥1' }), () => ({ status: 0, output: '4' }));
  expect(confirmed).toEqual({ freshness: 'confirmed', detail: '기대 ≥1 · 실제 4' });

  const stale = measureKnowhowItem(fixtureItem({ expectation: '≥1' }), () => ({ status: 0, output: '0' }));
  expect(stale.freshness).toBe('stale');
});

test('advice quotes the pack identity, the item id and the measurement it was judged by', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowhow-advice-'));
  const docPath = join(root, 'KNOWHOW.md');
  try {
    writeFileSync(docPath, itemDoc('K-OP-777', '착지 거부', '리뷰가 main 보다 뒤 라며 착지를 거부한다')
      + `\n${itemDoc('K-OP-778', '잠금 순서', '잠금 해제 순서를 지킨다')}`
      + `\n${itemDoc('K-OP-779', '판 올림', '판 번호를 먼저 올린다')}`
      + `\n${itemDoc('K-OP-780', '카나리', '카나리 확인 뒤 배포한다')}`
      + `\n${itemDoc('K-OP-781', '문서 지도', '지도 갱신 메모를 남긴다')}`);
    const commands: string[] = [];
    const advice = knowhowAdvice('리뷰가 main 보다 뒤 라며 착지를 거부한다', {
      docPath, runCommand: command => { commands.push(command); return { status: 0, output: '' }; },
    })!;
    expect(advice.item.id).toBe('K-OP-777');
    expect(advice.packVersion).toBe('K3');
    expect(advice.packHash).toMatch(/^[0-9a-f]{16}$/);
    expect(advice.freshness).toBe('confirmed');
    expect(commands).toEqual(['git status --porcelain']);
    expect(knowhowAdvice('리뷰가', { docPath, runCommand: () => ({ status: 0, output: '' }) })).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the shipped K-OP-083 measurement runs read-only against the repository and its 기대 holds', () => {
  const docPath = resolveKnowhowDocPath()!;
  const repoRoot = docPath.slice(0, -(KNOWHOW_DOC_RELATIVE_PATH.length + 1));
  const item = loadKnowhowPack(docPath)!.items.find(candidate => candidate.id === 'K-OP-083')!;
  expect(item.command).toContain('rejudge-on-head.ts');
  const measured = measureKnowhowItem(item, readOnlyRunner(repoRoot));
  expect(measured.freshness).toBe('confirmed');
  expect(measured.detail).toContain('기대 ≥1');
});
