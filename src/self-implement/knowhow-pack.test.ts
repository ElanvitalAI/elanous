import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWHOW_PACK_MAX_BYTES, selectKnowhowPack, selectRelevantAuthoringLessons } from './knowhow-pack.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'knowhow-pack-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/roles/TC'), { recursive: true });
  const file = join(root, 'docs/roles/TC/KNOWHOW.md');
  writeFileSync(file, [
    '# TC',
    '## K-TC-1 scope-escape 의 경로 확인 (작성 2026-10-20)',
    '- 상황: src/self-implement/orchestrator.ts 에서 scope-escape 발생.',
    '- 처방(힐링): 대상 경로 밖 편집 여부를 먼저 확인한다.',
    '- 출처: 사례 1 · 상태: active',
    '## K-TC-2 일반 지식 (작성 2026-10-20)',
    '- 상황: src/other/file.ts 변경.',
    '- 출처: 사례 2 · 상태: active',
    '## K-TC-3 퇴역 지식 (작성 2026-10-20)',
    '- 상황: src/self-implement/orchestrator.ts 에서 scope-escape 발생.',
    '- 출처: 사례 3 · 상태: stale',
  ].join('\n'));
  return { root, file };
}

test('selects only matching promoted repository knowhow, bounded and without changing the source', () => {
  const { root, file } = fixture();
  const before = createHash('sha256').update(readFileSync(file)).digest('hex');
  const goal = '대상 경로: src/self-implement/orchestrator.ts\n실패 서명: scope-escape';
  const pack = selectKnowhowPack(root, goal);
  expect(pack.ids).toEqual(['K-TC-1']);
  expect(pack.reason).toBe('selected');
  expect(pack.text).toContain('대상 경로 밖 편집 여부');
  expect(pack.text).not.toContain('K-TC-3');
  expect(pack.bytes).toBe(Buffer.byteLength(pack.text));
  expect(pack.bytes).toBeLessThanOrEqual(KNOWHOW_PACK_MAX_BYTES);
  expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
  expect(selectKnowhowPack(root, `${pack.text}\n\n${goal}`)).toMatchObject({ ids: [], reason: 'marker-present' });
});

test('adds a bounded goal document and only the connected graph-unit chain for its target paths', () => {
  const { root } = fixture();
  const goalPath = join(root, 'docs/goals/GOAL-feature.md');
  mkdirSync(join(root, 'docs/goals'), { recursive: true });
  writeFileSync(goalPath, '# Feature goal\n## TRACED PATHS\n- src/feature/entry.ts\n');
  mkdirSync(join(root, 'graphs/work'), { recursive: true });
  mkdirSync(join(root, 'graphs/units/feature'), { recursive: true });
  mkdirSync(join(root, 'graphs/units/unrelated'), { recursive: true });
  writeFileSync(join(root, 'graphs/work/feature.yaml'), 'graph_id: work-feature\nnodes:\n  - { node_id: implement, call: feature@1 }\n');
  writeFileSync(join(root, 'graphs/work/other.yaml'), 'graph_id: work-other\nnodes:\n  - { node_id: implement, call: unrelated@1 }\n');
  writeFileSync(join(root, 'graphs/units/feature/unit.yaml'), 'graph_id: feature\nversion: 1\nsource: [src/feature/entry.ts]\nnodes: []\n');
  writeFileSync(join(root, 'graphs/units/unrelated/unit.yaml'), 'graph_id: unrelated\nversion: 1\nsource: [src/other/entry.ts]\nnodes: []\n');
  const before = createHash('sha256').update(readFileSync(goalPath)).digest('hex');

  const pack = selectKnowhowPack(root, 'implement feature', undefined, { goalFile: 'docs/goals/GOAL-feature.md' });

  expect(pack.text).toContain('## GOAL DOCUMENT');
  expect(pack.text).toContain('## GRAPH BLUEPRINT');
  expect(pack.text).toContain('work-feature → feature');
  expect(pack.text).not.toContain('work-other');
  expect(pack.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'goal', path: 'docs/goals/GOAL-feature.md', bytes: Buffer.byteLength(readFileSync(goalPath)) }),
    expect.objectContaining({ kind: 'blueprint', path: 'graphs/work/feature.yaml' }),
    expect.objectContaining({ kind: 'blueprint', path: 'graphs/units/feature/unit.yaml' }),
  ]));
  expect(pack.bytes).toBe(Buffer.byteLength(pack.text));
  expect(pack.bytes).toBeLessThanOrEqual(KNOWHOW_PACK_MAX_BYTES);
  expect(createHash('sha256').update(readFileSync(goalPath)).digest('hex')).toBe(before);
});

test('preserves explicit missing-input and selector reasons without reinjecting a goal-file marker', () => {
  const { root } = fixture();
  const absent = selectKnowhowPack(root, 'goal', undefined, { goalFile: null });
  expect(absent.text).toContain('reason=goal-document-not-configured');
  expect(absent.knowhowReason).toBe('no-path-overlap');
  mkdirSync(join(root, 'docs/goals'), { recursive: true });
  writeFileSync(join(root, 'docs/goals/GOAL-marker.md'), '# Prior\n[KNOWHOW-PACK v1 ids=K-TC-1]\n대상 경로: src/self-implement/orchestrator.ts\n');
  const marked = selectKnowhowPack(root, 'goal', undefined, { goalFile: 'docs/goals/GOAL-marker.md' });
  expect(marked.text).toContain('reason=knowhow-marker-already-present');
  expect(marked.text).not.toContain('[KNOWHOW-PACK v1');
});

test('keeps graph chains distinct when different root graphs call the same unit', () => {
  const { root } = fixture();
  mkdirSync(join(root, 'docs/goals'), { recursive: true });
  mkdirSync(join(root, 'graphs/work'), { recursive: true });
  mkdirSync(join(root, 'graphs/units'), { recursive: true });
  writeFileSync(join(root, 'docs/goals/GOAL-feature.md'), '# Goal\n## TRACED PATHS\n- src/shared.ts\n');
  writeFileSync(join(root, 'graphs/units/shared.yaml'), 'graph_id: shared\nsource: [src/shared.ts]\nnodes: []\n');
  writeFileSync(join(root, 'graphs/work/a.yaml'), 'graph_id: root-a\nnodes:\n  - { node_id: call, call: shared@1 }\n');
  writeFileSync(join(root, 'graphs/work/b.yaml'), 'graph_id: root-b\nnodes:\n  - { node_id: call, call: shared@1 }\n');
  const pack = selectKnowhowPack(root, 'goal', undefined, { goalFile: 'docs/goals/GOAL-feature.md' });
  expect(pack.text).toContain('root-a → shared');
  expect(pack.text).toContain('root-b → shared');
});

test('combined goal, blueprint, and selected knowhow remain within the shared UTF-8 cap', () => {
  const { root, file } = fixture();
  mkdirSync(join(root, 'docs/goals'), { recursive: true });
  mkdirSync(join(root, 'graphs/work'), { recursive: true });
  mkdirSync(join(root, 'graphs/units'), { recursive: true });
  writeFileSync(join(root, 'docs/goals/GOAL-feature.md'), `# Goal\n## TRACED PATHS\n- src/self-implement/orchestrator.ts\n${'설명'.repeat(1800)}\n`);
  writeFileSync(join(root, 'graphs/units/shared.yaml'), 'graph_id: shared\nsource: [src/self-implement/orchestrator.ts]\nnodes: []\n');
  writeFileSync(join(root, 'graphs/work/shared.yaml'), 'graph_id: root-shared\nnodes:\n  - { node_id: call, call: shared@1 }\n');
  writeFileSync(file, '## K-TC-1 scope-escape\n- 상황: src/self-implement/orchestrator.ts scope-escape.\n- 처방: bounded lesson\n- 출처: test · 상태: active\n');
  const pack = selectKnowhowPack(root, 'scope-escape', ['src/self-implement/orchestrator.ts'], { goalFile: 'docs/goals/GOAL-feature.md' });
  expect(pack.text).toContain('root-shared → shared');
  expect(pack.ids).toEqual(['K-TC-1']);
  expect(pack.bytes).toBe(Buffer.byteLength(pack.text, 'utf8'));
  expect(pack.bytes).toBeLessThanOrEqual(KNOWHOW_PACK_MAX_BYTES);
});

test('reports explicit reasons when the configured goal or a related graph chain is absent', () => {
  const { root } = fixture();
  expect(selectKnowhowPack(root, 'goal', undefined, { goalFile: 'docs/goals/missing.md' }).text).toContain('goal-document-missing-or-outside-repository');
  mkdirSync(join(root, 'docs/goals'), { recursive: true });
  writeFileSync(join(root, 'docs/goals/GOAL-feature.md'), '# Goal\n## TRACED PATHS\n- src/feature.ts\n');
  expect(selectKnowhowPack(root, 'goal', undefined, { goalFile: 'docs/goals/GOAL-feature.md' }).text).toContain('no-related-blueprint');
  expect(selectKnowhowPack(root, 'goal', undefined, { goalFile: null }).text).toContain('goal-document-not-configured');
});

test('does not read a goal document through a symlink or outside the repository', () => {
  const { root } = fixture();
  mkdirSync(join(root, 'docs/goals'), { recursive: true });
  const external = join(tmpdir(), `outside-goal-${Date.now()}.md`);
  writeFileSync(external, '# confidential external goal');
  roots.push(external);
  symlinkSync(external, join(root, 'docs/goals/external.md'));

  for (const goalFile of ['docs/goals/external.md', external]) {
    const pack = selectKnowhowPack(root, 'goal', undefined, { goalFile });
    expect(pack.text).toContain('goal-document-missing-or-outside-repository');
    expect(pack.text).not.toContain('confidential external goal');
  }
});

test('empty selections say which source or relevance boundary stopped injection', () => {
  const { root, file } = fixture();
  expect(selectKnowhowPack(join(root, 'missing'), '대상 경로: src/self-implement/orchestrator.ts')).toMatchObject({ ids: [], reason: 'source-unreadable' });
  writeFileSync(file, '## K-TC-9 retired\n- 상황: src/self-implement/orchestrator.ts.\n- 출처: 사례 · 상태: stale\n');
  expect(selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts')).toMatchObject({ ids: [], reason: 'no-promoted-section' });
  writeFileSync(file, '## K-TC-9 active\n- 상황: src/self-implement/orchestrator.ts.\n- 출처: 사례 · 상태: active\n');
  expect(selectKnowhowPack(root, '대상 경로: src/unrelated/file.ts')).toMatchObject({ ids: [], reason: 'no-path-overlap' });
  writeFileSync(file, `## K-TC-9 active\n- 상황: src/self-implement/orchestrator.ts.\n- 처방: ${'가'.repeat(KNOWHOW_PACK_MAX_BYTES)}\n- 출처: 사례 · 상태: active\n`);
  expect(selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts')).toMatchObject({ ids: [], reason: 'over-budget' });
});

test('returns an empty pack for unrelated goals and excludes a source symlink outside roles', () => {
  const { root } = fixture();
  expect(selectKnowhowPack(root, '대상 경로: src/unrelated.ts').ids).toEqual([]);
  mkdirSync(join(root, 'docs/roles/UX'), { recursive: true });
  symlinkSync(join(root, 'docs/roles/TC/KNOWHOW.md'), join(root, 'docs/roles/UX/KNOWHOW.md'));
  const pack = selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts');
  expect(pack.ids).toEqual(['K-TC-1']);
});

test('sentence punctuation matches the path but an identical basename elsewhere does not', () => {
  const { root, file } = fixture();
  writeFileSync(file, readFileSync(file, 'utf8') + '\n## K-TC-4 different index\n- 상황: src/other/index.ts 변경.\n- 출처: 사례 4 · 상태: active\n');
  expect(selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts.').ids).toEqual(['K-TC-1']);
  expect(selectKnowhowPack(root, '대상 경로: src/unrelated/index.ts.').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: src/unrelated/index.ts.\n실패 서명: scope-escape').ids).toEqual([]);
});

test('selects no more than three entries within the UTF-8 byte budget', () => {
  const { root, file } = fixture();
  const sections = Array.from({ length: 8 }, (_, index) => `## K-TC-${index + 10} target\n- 상황: src/self-implement/orchestrator.ts.\n- 처방: ${'가'.repeat(450)}\n- 출처: 사례 · 상태: active`).join('\n');
  writeFileSync(file, sections);
  const pack = selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts');
  expect(pack.ids.length).toBeLessThanOrEqual(3);
  expect(pack.bytes).toBeLessThanOrEqual(KNOWHOW_PACK_MAX_BYTES);
  expect(pack.ids.length).toBeGreaterThan(0);
});

test('three-entry limit applies when all four small entries fit the byte budget', () => {
  const { root, file } = fixture();
  writeFileSync(file, Array.from({ length: 4 }, (_, index) => `## K-TC-${index + 10} target\n- 상황: src/self-implement/orchestrator.ts.\n- 출처: 사례 · 상태: active`).join('\n'));
  const pack = selectKnowhowPack(root, '대상 경로: src/self-implement/orchestrator.ts');
  expect(pack.ids).toEqual(['K-TC-10', 'K-TC-11', 'K-TC-12']);
  expect(pack.bytes).toBeLessThan(KNOWHOW_PACK_MAX_BYTES);
});

test('authoring lessons select only relevant path or class entries, with stable IDs and a two-entry cap', () => {
  const { root } = fixture();
  const directory = join(root, 'docs/goal-context');
  mkdirSync(directory, { recursive: true });
  const rows = [
    { cell: 'old path', class: 'b-stale-path', lesson: '대상 경로가 현재 진입점인지 확인한다', paths: 'src/self-implement/orchestrator.ts' },
    { cell: 'umbrella', class: 'g-umbrella-scope', lesson: '포괄 골을 작은 경계로 나눈다', paths: '' },
    { cell: 'unrelated', class: 'e-format-trap', lesson: 'Use exact JSON formatting', paths: 'docs/unrelated.md' },
  ];
  writeFileSync(join(directory, '05-authoring-lessons.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const ask = 'Umbrella request: unsupported path src/self-implement/orchestrator.ts; split this broad goal.';
  const selected = selectRelevantAuthoringLessons(root, ask);
  expect(selected.status).toBe('loaded');
  expect(selected.ids).toHaveLength(2);
  expect(selected.ids[0]).toMatch(/^AL-[a-f0-9]{10}$/u);
  expect(selected.prompt).toContain('대상 경로가 현재 진입점인지 확인한다');
  expect(selected.prompt).toContain('포괄 골을 작은 경계로 나눈다');
  expect(selected.prompt).not.toContain('exact JSON formatting');
  expect(Buffer.byteLength(selected.prompt, 'utf8')).toBeLessThanOrEqual(2_000);
  expect(selectRelevantAuthoringLessons(root, ask).ids).toEqual(selected.ids);
});

test('authoring lesson selector fails open for absent or malformed optional ledger', () => {
  const { root } = fixture();
  expect(selectRelevantAuthoringLessons(root, 'Ordinary goal').status).toBe('missing');
  const directory = join(root, 'docs/goal-context');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '05-authoring-lessons.jsonl'), '{bad json\n');
  expect(selectRelevantAuthoringLessons(root, 'Ordinary goal')).toMatchObject({ status: 'malformed', ids: [], prompt: '', invalidRows: 1 });
});

test('next goal author receives path-relevant landed implementation feedback from the run ledger', () => {
  const { root } = fixture();
  const stateDir = mkdtempSync(join(tmpdir(), 'knowhow-feedback-state-'));
  roots.push(stateDir);
  mkdirSync(join(stateDir, 'run-ledger'), { recursive: true });
  const prior = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  try {
    writeFileSync(join(stateDir, 'run-ledger', 'run-0123456789abcdef0123456789abcdef.jsonl'), `${JSON.stringify({
      runId: 'run-0123456789abcdef0123456789abcdef', event: 'impl-findings-feedback', data: {
        prNumber: 4321, paths: ['src/self-implement/goal-author.ts'],
        requirements: 'keep the authoring boundary explicit', newScope: 'include merged implementation notes', remaining: ['wire the bounded selector'],
      },
    })}\n`);
    const selected = selectRelevantAuthoringLessons(root, 'Update src/self-implement/goal-author.ts from the landed feedback.', stateDir);
    expect(selected.ids).toContain('IF-4321');
    expect(selected.prompt).toContain('구현이 밝힌 요구사항: keep the authoring boundary explicit');
    expect(selected.prompt).toContain('남은 것: wire the bounded selector');
  } finally {
    if (prior === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = prior;
  }
});

test('canonical authoring ledger keeps valid closed-world lessons available while ignoring legacy other rows', () => {
  const repo = join(import.meta.dir, '..', '..');
  const selected = selectRelevantAuthoringLessons(repo, 'Umbrella goal touches src/self-implement/goal-author.ts and should be split by scope.');
  expect(selected.status).toBe('loaded');
  expect(selected.invalidRows).toBe(3);
  expect(selected.ids.length).toBeGreaterThan(0);
  expect(selected.ids.length).toBeLessThanOrEqual(2);
  expect(selected.prompt).toContain('g-umbrella-scope');
});

test('authoring lesson budget counts UTF-8 bytes, not JavaScript characters', () => {
  const { root } = fixture();
  const directory = join(root, 'docs/goal-context');
  mkdirSync(directory, { recursive: true });
  const rows = [
    { cell: 'large', class: 'b-stale-path', lesson: '가'.repeat(900), paths: 'src/self-implement/orchestrator.ts' },
    { cell: 'small', class: 'b-stale-path', lesson: '경로를 확인한다', paths: 'src/self-implement/orchestrator.ts' },
  ];
  writeFileSync(join(directory, '05-authoring-lessons.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const selected = selectRelevantAuthoringLessons(root, 'unsupported path src/self-implement/orchestrator.ts');
  expect(selected.prompt).not.toContain('가가가');
  expect(Buffer.byteLength(selected.prompt, 'utf8')).toBeLessThanOrEqual(2_000);
  expect(selected.prompt).toContain('경로를 확인한다');
});

test('preserves package prefixes and treats docs paths as explicit goal paths', () => {
  const { root, file } = fixture();
  writeFileSync(file, [
    '## K-TC-20 client scope\n- 상황: packages/client/src/index.ts scope-escape.\n- 출처: 사례 · 상태: active',
    '## K-TC-21 server scope\n- 상황: packages/server/src/index.ts scope-escape.\n- 출처: 사례 · 상태: active',
  ].join('\n'));
  expect(selectKnowhowPack(root, '대상 경로: packages/client/src/index.ts. 실패: scope-escape').ids).toEqual(['K-TC-20']);
  expect(selectKnowhowPack(root, '대상 경로: docs/one.md. 실패: scope-escape').ids).toEqual([]);
  expect(selectKnowhowPack(root, '실패 서명: scope-escape').ids).toEqual([]);
});

test('repository-root filenames are excluded and zero path matches never inject', () => {
  const { root, file } = fixture();
  writeFileSync(file, '## K-TC-30 package config\n- 상황: package.json no-progress.\n- 출처: 사례 · 상태: active\n');
  expect(selectKnowhowPack(root, '대상 경로: tsconfig.json\n실패 서명: no-progress').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: package.json\n실패 서명: no-progress').ids).toEqual([]);
  writeFileSync(file, '## K-TC-31 general\n- 상황: no-progress.\n- 출처: 사례 · 상태: active\n');
  expect(selectKnowhowPack(root, '대상 경로: package.json\n실패 서명: no-progress').ids).toEqual([]);
});

test('rejects paths outside the repository and matches other file extensions exactly', () => {
  const { root, file } = fixture();
  writeFileSync(file, [
    '## K-TC-40 TypeScript path\n- 상황: src/foo.ts.\n- 출처: 사례 · 상태: active',
    '## K-TC-41 Go path\n- 상황: src/foo.go.\n- 출처: 사례 · 상태: active',
    '## K-TC-42 Vue path\n- 상황: src/foo.vue.\n- 출처: 사례 · 상태: active',
  ].join('\n'));
  expect(selectKnowhowPack(root, '대상 경로: ../src/foo.ts').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: /src/foo.ts').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: ./src/foo.ts').ids).toEqual([]);
  expect(selectKnowhowPack(root, '대상 경로: src/foo.go.').ids).toEqual(['K-TC-41']);
  expect(selectKnowhowPack(root, '대상 경로: src/foo.vue.').ids).toEqual(['K-TC-42']);
});
