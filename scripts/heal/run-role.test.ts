import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';
import { appendRunLedgerEntry, runLedgerDir } from '../../src/self-implement/run-ledger.js';
import { roleResult } from './run-role.js';

const ROOT = join(import.meta.dir, '../..');
const HEAL = join(ROOT, 'graphs/heal/heal-loop.yaml');

function graphRun(input: unknown): { status: number; json: { status?: string; path?: string[]; nodes?: Array<{ nodeId: string; output?: string }> } } {
  const root = mkdtempSync(join(tmpdir(), 'heal-run-'));
  const child = spawnSync('bun', ['bin/elanous.mjs', '--test', 'graph', 'run', HEAL, '--input', JSON.stringify(input), '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ELANOUS_INSTANCE_ROOT: root },
    timeout: 120_000,
  });
  rmSync(root, { recursive: true, force: true });
  const line = (child.stdout ?? '').split('\n').map((row) => row.trim()).filter((row) => row.startsWith('{')).at(-1) ?? '';
  return { status: child.status ?? 1, json: line ? JSON.parse(line) as { status?: string; path?: string[]; nodes?: Array<{ nodeId: string; output?: string }> } : {} };
}

function outputOf(json: { nodes?: Array<{ nodeId: string; output?: string }> }, nodeId: string): Record<string, unknown> | undefined {
  const raw = json.nodes?.find((node) => node.nodeId === nodeId)?.output;
  if (typeof raw !== 'string') return undefined;
  const line = raw.split('\n').map((row) => row.trim()).filter(Boolean).at(-1);
  return line?.startsWith('{') ? JSON.parse(line) as Record<string, unknown> : undefined;
}

test('⑴ 문서만 미검증이면 acknowledge · done · next=review', () => {
  const { json } = graphRun({ failure: { failedTests: 0, unverified: ['docs/a.md'] } });
  expect(json.path).toContain('acknowledge');
  expect(json.status).toBe('done');
  expect(outputOf(json, 'acknowledge')?.next).toBe('review');
}, 120_000);

test('⑵ importer 미실행은 heal-harness 를 거쳐 triage 로 돌아온다', () => {
  const { json } = graphRun({ failure: { failedTests: 0, importerUnrunTests: 1, unverified: ['src/a.ts'] } });
  expect(json.path).toContain('heal-harness');
  expect(json.path?.filter((id) => id === 'triage').length).toBeGreaterThan(1);
  expect(outputOf(json, 'heal-harness')).toMatchObject({ outcome: 'fail', reason: 'not-wired' });
}, 120_000);

test('⑶ 할당량 주장 ⊕ 계정 0 은 verify-evidence corrected · 계정 없음', () => {
  const { json } = graphRun({ failure: { failedTests: 0, environmentClaim: '할당량 소진', environmentEvidence: { accountCount: 0 } } });
  expect(json.path).toContain('verify-evidence');
  expect(outputOf(json, 'verify-evidence')).toMatchObject({ outcome: 'corrected', 'corrected-kind': 'no-account' });
}, 120_000);

test('⑷ 할당량 주장 ⊕ exit 127 은 verify-evidence corrected · 바이너리 없음', () => {
  const { json } = graphRun({ failure: { failedTests: 0, environmentClaim: '할당량 소진', environmentEvidence: { exitCode: 127, stderr: 'node: not found' } } });
  expect(json.path).toContain('verify-evidence');
  expect(outputOf(json, 'verify-evidence')).toMatchObject({ outcome: 'corrected', 'corrected-kind': 'binary-missing' });
}, 120_000);

test('역할 recipe 는 러너가 카탈로그+recipes.yaml command 로 실행한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-role-recipe-'));
  try {
    const state = await runGraph(HEAL, {
      input: { failure: { failedTests: 0, unverified: ['docs/a.md'] } },
      deps: { root },
      runId: 'role-recipe',
    });
    expect(state.path).toContain('acknowledge');
    expect(state.status).toBe('done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('카탈로그에 없는 접두 없는 recipe 는 실행 전 거절', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-unknown-role-'));
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'not-a-role:\n  command: "echo no"\n');
  writeFileSync(graph, `graph_id: unknown-role\nversion: 1\nentry_node: n\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: n, kind: judge, recipe: not-a-role, max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: n\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  try {
    await expect(runGraph(graph, { deps: { root } })).rejects.toThrow('unknown command recipe for n: not-a-role');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('카탈로그 역할이라도 command 가 없으면 거절', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-role-no-cmd-'));
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'triage:\n  approval: "nope"\n');
  writeFileSync(graph, `graph_id: role-no-cmd\nversion: 1\nentry_node: n\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: n, kind: judge, recipe: triage, max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: n\n    on: outcome\n    map: { ok: done }\n`);
  try {
    await expect(runGraph(graph, { deps: { root } })).rejects.toThrow('unknown command recipe for n: triage');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runRole(role: string, ctx: unknown, stateDir?: string, env: Record<string, string> = {}): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'heal-ctx-'));
  const context = join(dir, 'ctx.json');
  writeFileSync(context, JSON.stringify(ctx));
  const child = spawnSync('bun', ['scripts/heal/run-role.ts', role], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ...(stateDir ? { ELANOUS_STATE_DIR: stateDir } : {}), ...env },
  });
  rmSync(dir, { recursive: true, force: true });
  const line = child.stdout.trim().split('\n').at(-1) ?? '{}';
  return JSON.parse(line) as Record<string, unknown>;
}

function git(cwd: string, args: string[]): void {
  const child = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
}

function deletedWorktree(): string {
  const repo = mkdtempSync(join(tmpdir(), 'heal-wt-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'heal@example.com']);
  git(repo, ['config', 'user.name', 'heal']);
  writeFileSync(join(repo, 'kept.ts'), 'export const kept = 1;\n');
  mkdirSync(join(repo, 'src/cli'), { recursive: true });
  writeFileSync(join(repo, 'src/cli/daemon-attach.ts'), 'export const gone = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'keep both']);
  git(repo, ['rm', 'src/cli/daemon-attach.ts']);
  git(repo, ['commit', '-m', 'delete daemon-attach']);
  return repo;
}

test('지운 파일은 collect 가 표시하고 triage 가 untestable', () => {
  const worktree = deletedWorktree();
  try {
    const collect = runRole('observe-ledger', {
      input: { failure: { failedTests: 0, introduced: 0, unverified: ['src/cli/daemon-attach.ts'] }, worktree },
      outputs: {},
    });
    expect(collect.entries).toEqual([{ failedTests: 0, introduced: 0, unverified: ['-src/cli/daemon-attach.ts'] }]);
    expect(collect.addedFacts).toEqual(['unverified']);
    const triage = runRole('triage', {
      input: { failure: { failedTests: 0, introduced: 0, unverified: ['src/cli/daemon-attach.ts'] } },
      outputs: { collect },
    });
    expect(triage.outcome).toBe('untestable');
    expect(triage.evidence).toContain('unverified ← collect');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('남아 있는 파일은 표시하지 않고 untestable 이 아니다', () => {
  const worktree = deletedWorktree();
  try {
    const collect = runRole('observe-ledger', {
      input: { failure: { failedTests: 0, introduced: 0, unverified: ['kept.ts'] }, worktree },
      outputs: {},
    });
    expect((collect.entries as Array<{ unverified: string[] }>)[0]?.unverified).toEqual(['kept.ts']);
    expect(collect.addedFacts).toEqual([]);
    const triage = runRole('triage', {
      input: { failure: { failedTests: 0, introduced: 0, unverified: ['kept.ts'] } },
      outputs: { collect },
    });
    expect(triage.outcome).not.toBe('untestable');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('git 이 unknown 이면 삭제 표시를 붙이지 않는다', () => {
  const collect = runRole('observe-ledger', {
    nodeId: 'collect',
    input: { failure: { failedTests: 0, unverified: ['src/cli/daemon-attach.ts'] }, worktree: '/no/such/worktree' },
    outputs: {},
  });
  expect((collect.entries as Array<{ unverified: string[] }>)[0]?.unverified).toEqual(['src/cli/daemon-attach.ts']);
  expect(collect.addedFacts).toEqual([]);
});

test('원장의 마지막 게이트 사실만 없는 칸에 채운다', () => {
  const state = mkdtempSync(join(tmpdir(), 'heal-ledger-'));
  const runId = 'run-heal-gate';
  try {
    appendRunLedgerEntry({ runId, event: 'gate', data: { introduced: 9, timedOut: 0 } }, runLedgerDir(state));
    appendRunLedgerEntry({ runId, event: 'gate', data: { introduced: 0, timedOut: 1 } }, runLedgerDir(state));
    const found = runRole('observe-deeper', { input: { runId, failure: { failedTests: 0 } }, outputs: {} }, state);
    expect(found.outcome).toBe('ok');
    expect(found.signature).toMatchObject({ failedTests: 0, introduced: 0, timedOut: 1 });
    expect(found.addedFacts).toEqual(['introduced', 'timedOut']);
    const kept = runRole('observe-deeper', { input: { runId, failure: { failedTests: 0, timedOut: 7 } }, outputs: {} }, state);
    expect(kept.signature).toMatchObject({ timedOut: 7, introduced: 0 });
    expect(kept.addedFacts).toEqual(['introduced']);
    const none = runRole('observe-deeper', { input: { runId, failure: { failedTests: 0, introduced: 0, timedOut: 1 } }, outputs: {} }, state);
    expect(none).toMatchObject({ outcome: 'empty', reason: 'no-new-facts', addedFacts: [] });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('ground-external 검색 근거는 triage 의 기존 재작업 간선과 노트까지 닿는다', () => {
  const failure = { failedTests: 1, errorText: 'TypeError: x is not a function' };
  const ctx = { input: { failure }, outputs: { 'observe-deeper': { outcome: 'empty' } } };
  let query = '';
  const ground = roleResult('ground-external', ctx, { search: (text) => {
    query = text;
    return { results: [{ items: [
      { title: 'API', url: 'https://docs.test/1', text: 'a'.repeat(220) },
      { title: 'Issue', url: 'https://docs.test/2', text: 'known failure' },
    ] }] };
  } });
  expect(query).toBe(failure.errorText);
  expect(ground).toMatchObject({ outcome: 'ok', query: failure.errorText, count: 2, ms: expect.any(Number), addedFacts: ['citations'], citations: [
    { title: 'API', url: 'https://docs.test/1', snippet: 'a'.repeat(200) },
    { title: 'Issue', url: 'https://docs.test/2', snippet: 'known failure' },
  ] });
  const outputs = { ...ctx.outputs, 'ground-external': ground };
  const triage = roleResult('triage', { input: { failure }, outputs });
  expect(triage.outcome).toBe('child-fixable');
  expect(triage.evidence).toContain('citations ← ground-external');
  const note = roleResult('rework-note', { input: { failure }, outputs });
  expect(note['rework-note']).toContain('https://docs.test/1');
  expect(note['rework-note']).toContain('https://docs.test/2');
});

test('collect 에만 인용이 있어도 triage 재작업 노트에 동일한 URL을 남긴다', () => {
  const citation = { title: 'Collected docs', url: 'https://docs.test/collected', snippet: 'Fix' };
  const ctx = {
    input: { failure: { failedTests: 1 } },
    outputs: {
      collect: { outcome: 'ok', entries: [{ failedTests: 1, citations: [citation] }] },
      'observe-deeper': { outcome: 'empty' },
      'ground-external': { outcome: 'empty', reason: 'no-results' },
    },
  };
  expect(roleResult('triage', ctx).outcome).toBe('child-fixable');
  expect(roleResult('rework-note', ctx)['rework-note']).toContain(citation.url);
});

test('ground-external 0건과 예외는 empty, 뒤 triage 는 exhausted', () => {
  const failure = { failedTests: 1, errorText: 'TypeError: x is not a function' };
  const ctx = { input: { failure }, outputs: { 'observe-deeper': { outcome: 'empty' } } };
  for (const search of [() => ({ results: [{ items: [] }] }), () => { throw new Error('offline'); }, () => ({ missing: true })]) {
    const ground = roleResult('ground-external', ctx, { search });
    expect(ground).toMatchObject({ outcome: 'empty', reason: 'no-results', addedFacts: [] });
    expect(roleResult('triage', { ...ctx, outputs: { ...ctx.outputs, 'ground-external': ground } }).outcome).toBe('exhausted');
  }
});

test('errorText 없으면 시험 이름 앞 셋을 검색하며 결과는 최대 5건', () => {
  const names = ['one', 'two', 'three', 'four'];
  let query = '';
  const result = roleResult('ground-external', { input: { failure: { failedTests: 4, failedTestNames: names } } }, {
    search: (text) => { query = text; return { results: [{ items: Array.from({ length: 7 }, (_, i) => ({ title: `test ${i}`, url: `https://docs.test/${i}`, text: 'fix' })) }] }; },
  });
  expect(query).toBe('one two three');
  expect((result.citations as unknown[]).length).toBe(5);
});

test('observe-deeper 가 찾은 errorText 는 ground-external 질의가 되고 입력 문면은 유지된다', () => {
  const runId = 'run-heal-text';
  const entries = [{ runId, event: 'gate', data: { errorText: 'ledger text' } }];
  const input = { runId, failure: { failedTests: 1 } };
  const deeper = roleResult('observe-deeper', { input }, { loadLedger: () => entries });
  expect(deeper).toMatchObject({ signature: { errorText: 'ledger text' }, addedFacts: ['errorText'] });
  let query = '';
  roleResult('ground-external', { input, outputs: { 'observe-deeper': deeper } }, { search: (text) => { query = text; return []; } });
  expect(query).toBe('ledger text');
  const supplied = roleResult('observe-ledger', { input: { failure: { failedTests: 1, errorText: 'supplied' } } });
  expect(supplied.entries).toEqual([{ failedTests: 1, errorText: 'supplied' }]);
  expect(roleResult('observe-deeper', { input: { runId, failure: { failedTests: 1, errorText: 'supplied' } } }, { loadLedger: () => entries })).toMatchObject({ outcome: 'empty', reason: 'no-new-facts' });
});

test('기본 omni-crawl 호출은 실제 fc-dev JSON 출력의 URL을 END 유무와 무관하게 추출하고 실패는 empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-search-'));
  const bin = join(root, 'npx');
  const called = join(root, 'args.json');
  const ctx = { input: { failure: { failedTests: 1, errorText: 'TypeError: x is not a function' } } };
  const env = { PATH: `${root}:${process.env.PATH ?? ''}`, HEAL_SEARCH_ARGS: called };
  // Recorded from omni-crawl/scripts/main.ts --engine fc-dev --json with a deterministic /search/developer response.
  const crawlOutput = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OmniCrawl
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
쿼리:   pydantic validation error
모드:   auto
엔진:   fc-dev
이유:   --engine fc-dev

  [fc-dev] 개발자 인덱스: "pydantic validation error" (k=5)
  [fc-dev] 1개 아티팩트

총 1건 수집 (1개 엔진 · 비용: fc-dev ~2cr)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

---BEGIN_OMNI_CRAWL_JSON---
{
  "query": "pydantic validation error",
  "mode": "auto",
  "engines": ["fc-dev"],
  "totalItems": 1,
  "costs": ["fc-dev ~2cr"],
  "savedPath": null,
  "results": [{
    "engine": "fc-dev",
    "totalItems": 1,
    "summary": null,
    "items": [{
      "url": "https://www.typescriptlang.org/docs/handbook/2/functions.html",
      "title": "Functions",
      "text": "A TypeError can result from calling a value that is not a function.",
      "author": "doc:typescript"
    }]
  }]
}
---END_OMNI_CRAWL_JSON---
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  try {
    for (const output of [
      crawlOutput,
      crawlOutput.slice(0, crawlOutput.indexOf('---END_OMNI_CRAWL_JSON---')),
      `${crawlOutput.slice(0, crawlOutput.indexOf('---END_OMNI_CRAWL_JSON---'))}\nTrailing stdout after JSON`,
    ]) {
      writeFileSync(bin, `#!/usr/bin/env bun\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.HEAL_SEARCH_ARGS!, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(output)});\n`);
      chmodSync(bin, 0o755);
      const found = runRole('ground-external', ctx, undefined, env);
      expect(found).toMatchObject({ outcome: 'ok', query: ctx.input.failure.errorText, count: 1, ms: expect.any(Number), addedFacts: ['citations'], citations: [{
        title: 'Functions', url: 'https://www.typescriptlang.org/docs/handbook/2/functions.html',
        snippet: 'A TypeError can result from calling a value that is not a function.',
      }] });
      expect(JSON.parse(readFileSync(called, 'utf8'))).toEqual(['tsx', join(homedir(), '.claude/skills/omni-crawl/scripts/main.ts'), ctx.input.failure.errorText, '--engine', 'fc-dev', '--json']);
    }
    writeFileSync(bin, '#!/usr/bin/env bun\nconsole.log("---BEGIN_OMNI_CRAWL_JSON---\\n{bad json}\\n---END_OMNI_CRAWL_JSON---");\n');
    expect(runRole('ground-external', ctx, undefined, env)).toMatchObject({ outcome: 'empty', reason: 'no-results' });
    writeFileSync(bin, '#!/usr/bin/env bun\nconsole.log("no JSON marker");\n');
    expect(runRole('ground-external', ctx, undefined, env)).toMatchObject({ outcome: 'empty', reason: 'no-results' });
    writeFileSync(bin, '#!/usr/bin/env bun\nprocess.exit(1);\n');
    expect(runRole('ground-external', ctx, undefined, env)).toMatchObject({ outcome: 'empty', reason: 'no-results' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run-role 은 컨텍스트의 실패 서명을 정규화해 마지막 줄 JSON 을 낸다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heal-ctx-'));
  const context = join(dir, 'ctx.json');
  writeFileSync(context, JSON.stringify({ graphId: 'g', runId: 'r', nodeId: 'collect', input: { failure: { failedTests: 0, unverified: ['docs/a.md'] } }, outputs: {} }));
  const child = spawnSync('bun', ['scripts/heal/run-role.ts', 'observe-ledger'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context } });
  rmSync(dir, { recursive: true, force: true });
  const line = child.stdout.trim().split('\n').at(-1)!;
  expect(JSON.parse(line)).toMatchObject({ outcome: 'ok', entries: [{ failedTests: 0, unverified: ['docs/a.md'] }] });
  expect(readFileSync(join(ROOT, 'graphs/heal/recipes.yaml'), 'utf8')).toContain('bun scripts/heal/run-role.ts triage');
});
