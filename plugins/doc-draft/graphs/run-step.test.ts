import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../../../src/graph-runner/runner.js';
import { installPlugin } from '../../../src/plugins/install/plugin-install.js';

const dir = import.meta.dir;
const graphFile = join(dir, 'doc-draft.yaml');
const graph = parseYaml(readFileSync(graphFile, 'utf8')) as {
  nodes: { node_id: string; recipe?: string; max_visits: number }[];
  edges: { from: string; map: Record<string, string> }[];
};
const recipes = parseYaml(readFileSync(join(dir, 'recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
const good = {
  'exec-onepager': '# 행사 준비 임원 보고\n\n## 요약\n행사 준비 현황을 점검하고 현재 확인 가능한 사항을 임원에게 보고하는 초안입니다.\n\n## 핵심 숫자\n자료 미제공 — 확인 필요. 점검 수치를 확인한 뒤 보고에 반영해야 합니다.\n\n## 결정 요청\n담당자에게 필요한 자료의 취합과 행사 진행 여부에 관한 결정을 요청합니다.\n\n## 다음 단계\n자료를 검증하고 문안을 다시 확인한 후 승인 여부를 결정합니다.',
  'promo-post': '# 행사 안내 초안\n\n마케터스 나이트 행사를 소개하는 홍보 글의 초안입니다. 참가자는 새로운 아이디어를 나누고 서로의 경험을 공유할 수 있습니다. 정확한 행사 시간과 장소는 주최 측 확인 후 추가합니다.',
  memo: '# 진행 메모 초안\n\n오늘의 회의에서 논의할 주제를 정리한 일반 메모입니다. 확인된 사항을 검토하고 담당자에게 필요한 다음 업무를 전달하기 전 내용의 정확성을 다시 점검합니다.',
};
const fakeSource = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
if (process.env.DOC_DRAFT_CALL_LOG) appendFileSync(process.env.DOC_DRAFT_CALL_LOG, JSON.stringify({command,args,cwd:process.cwd(),toolCwd:process.env.ELANOUS_TOOL_CWD ?? null})+'\\n');
if (command !== 'ask') process.exit(2);
if (process.env.DOC_DRAFT_NO_BARE && args.includes('--bare')) { console.error("unknown option '--bare'"); process.exit(1); }
const prompt = args.at(-1) || '';
if (process.env.DOC_DRAFT_KEEP_NEUTRAL && !prompt.startsWith('Review this draft')) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  writeFileSync(process.env.DOC_DRAFT_KEEP_NEUTRAL, process.cwd());
  mkdirSync(process.cwd() + '/.elanous');
  writeFileSync(process.cwd() + '/.elanous/another-process.txt', 'keep this file');
}
if (process.env.DOC_DRAFT_FAIL_ASK) { console.error('ask unavailable'); process.exit(1); }
if (prompt.startsWith('Review this draft')) {
  console.log(JSON.stringify({reply:JSON.stringify({ok: !process.env.DOC_DRAFT_REJECT,reason:'requested item missing'})}));
} else {
  const kind = prompt.match(/Write ONE (exec-onepager|promo-post|memo) document/)?.[1];
  const samples = ${JSON.stringify(good)};
  console.log(JSON.stringify({reply:process.env.DOC_DRAFT_BAD_DRAFT || samples[kind]}));
}
`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doc-draft-test-'));
  const bin = join(root, 'fake-elanous');
  writeFileSync(bin, fakeSource);
  chmodSync(bin, 0o755);
  return { root, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function graphRun(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const f = fixture();
  const previous = process.env.DOC_DRAFT_ELANOUS_BIN;
  const oldEnv = Object.fromEntries(Object.keys(extraEnv).map(key => [key, process.env[key]]));
  process.env.DOC_DRAFT_ELANOUS_BIN = f.bin;
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;
  try {
    const state = await runGraph(graphFile, { input, deps: { root: f.root } });
    return { state, root: f.root, bin: f.bin, cleanup: f.cleanup };
  } catch (error) { f.cleanup(); throw error; }
  finally {
    if (previous === undefined) delete process.env.DOC_DRAFT_ELANOUS_BIN;
    else process.env.DOC_DRAFT_ELANOUS_BIN = previous;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('metadata exposes planner keys and draft-only graph with single-visit recipes', () => {
  const plugin = JSON.parse(readFileSync(join(dir, '../plugin.json'), 'utf8')) as Record<string, any>;
  expect(plugin.description).toBe('Drafts one document from a request — executive one-pager, promo or event post, memo. Drafts only; never published.');
  expect(plugin.extensions['ai.elanous'].graphs).toEqual(['./graphs/doc-draft.yaml']);
  expect(plugin.extensions['ai.elanous'].capabilities).toEqual(['fs:workdir', 'proc:bun', 'proc:elanous']);
  expect(Object.keys(JSON.parse(readFileSync(join(dir, '../examples/brief-sample.json'), 'utf8')))).toEqual(['kind', 'topic', 'context', 'audience', 'language', 'outDir']);
  const steps = ['draft', 'check', 'report'];
  expect(graph.nodes.map(n => n.node_id)).toEqual([...steps, 'done', 'failed']);
  for (const [index, name] of steps.entries()) {
    expect(graph.nodes[index]).toMatchObject({ recipe: `cmd:${name}`, max_visits: 1 });
    expect(recipes[name]?.command).toBe(`bun "$ELANOUS_GRAPH_DIR/run-step.ts" ${name}`);
    expect(graph.edges[index]).toMatchObject({ from: name, map: { ok: steps[index + 1] ?? 'done', fail: 'failed' } });
  }
  expect(graph.nodes.slice(3).every(node => node.max_visits === 1)).toBe(true);
});

test('doc-draft installs and its graph is discoverable by the COO planner', async () => {
  const f = fixture();
  try {
    const installed = await installPlugin(join(dir, '..'), { root: f.root, yes: true });
    expect(installed.name).toBe('doc-draft');
    expect(existsSync(join(installed.path, 'graphs', 'doc-draft.yaml'))).toBe(true);
    const { installedPluginGraphs } = await import('../../../src/exec-requests/planner.js');
    const found = installedPluginGraphs(join(f.root, 'plugins'));
    expect(found.errors).toEqual([]);
    expect(found.graphs.find(item => item.id === 'doc-draft')).toMatchObject({
      inputKeys: ['kind', 'topic', 'context', 'audience', 'language', 'outDir'],
    });
  } finally { f.cleanup(); }
});

test('all three kinds reach done and write only a checked Markdown draft with structured final JSON', async () => {
  for (const kind of ['exec-onepager', 'promo-post', 'memo']) {
    const f = fixture();
    const previous = process.env.DOC_DRAFT_ELANOUS_BIN;
    process.env.DOC_DRAFT_ELANOUS_BIN = f.bin;
    try {
      const outDir = join(f.root, 'out');
      const state = await runGraph(graphFile, { input: { kind, topic: 'Prepare a document about the event', context: 'No verified numbers yet', audience: 'leadership', language: 'ko', outDir }, deps: { root: f.root } });
      expect(state.status).toBe('done');
      expect(state.path).toEqual(['draft', 'check', 'report', 'done']);
      const result = JSON.parse(String(state.nodes[2]?.output).trim().split('\n').at(-1)!) as { outcome: string; file: string; words: number };
      expect(result.outcome).toBe('ok');
      expect(result.file).toBe(join(outDir, 'draft.md'));
      const markdown = readFileSync(result.file, 'utf8');
      expect(markdown).toBe(good[kind as keyof typeof good] + '\n');
      expect(result.words).toBe(markdown.trim().split(/\s+/u).length);
      expect(markdown.split('\n')[0]).toStartWith('# ');
      if (kind === 'exec-onepager') for (const section of ['요약', '핵심 숫자', '결정 요청', '다음 단계']) expect(markdown).toContain(`## ${section}`);
      expect(existsSync(join(outDir, 'report.json'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DOC_DRAFT_ELANOUS_BIN;
      else process.env.DOC_DRAFT_ELANOUS_BIN = previous;
      f.cleanup();
    }
  }
}, 30000);

test('missing or invalid kind and missing topic route straight to failed without an ask or file', async () => {
  for (const input of [{ topic: 'Meeting' }, { kind: 'other', topic: 'Meeting' }, { kind: 'memo' }, { kind: 'memo', topic: '  ' }]) {
    const f = fixture();
    const log = join(f.root, 'calls.jsonl');
    const prior = process.env.DOC_DRAFT_ELANOUS_BIN;
    process.env.DOC_DRAFT_ELANOUS_BIN = f.bin;
    process.env.DOC_DRAFT_CALL_LOG = log;
    try {
      const state = await runGraph(graphFile, { input, deps: { root: f.root } });
      expect(state.status).toBe('failed');
      expect(state.path).toEqual(['draft', 'failed']);
      expect(String(state.nodes[0]?.output)).toMatch(/"outcome":"fail"/);
      expect(existsSync(join(f.root, 'graph-runs', 'doc-draft', state.runId, 'draft.md'))).toBe(false);
      expect(existsSync(log)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.DOC_DRAFT_ELANOUS_BIN;
      else process.env.DOC_DRAFT_ELANOUS_BIN = prior;
      delete process.env.DOC_DRAFT_CALL_LOG;
      f.cleanup();
    }
  }
});

test('check refuses placeholders, missing one-pager section, false publication, bad length, and negative review before report', async () => {
  for (const [draft, extraEnv] of [
    ['# Event\n\n## 요약\nThis is a short paragraph with enough words to pass the minimum required word count. [insert figure]', {}],
    [good['exec-onepager'].replace('## 결정 요청', '## 기타'), {}],
    [good['exec-onepager'].replace('담당자에게 필요한 자료의 취합과 행사 진행 여부에 관한 결정을 요청합니다.', ''), {}],
    [good['exec-onepager'].replace('자료를 검증하고', '게시했습니다. 자료를 검증하고'), {}],
    [good['exec-onepager'].replace('자료를 검증하고', 'Already published. 자료를 검증하고'), {}],
    ['# Title\n\nToo short.', {}],
    [good['exec-onepager'], { DOC_DRAFT_REJECT: '1' }],
  ] as const) {
    const f = await graphRun({ kind: 'exec-onepager', topic: 'Report event readiness' }, { DOC_DRAFT_BAD_DRAFT: draft, ...extraEnv });
    try {
      expect(f.state.status).toBe('failed');
      expect(f.state.path).toEqual(['draft', 'check', 'failed']);
      expect(String(f.state.nodes[1]?.output)).toContain('"outcome":"fail"');
      expect(existsSync(join(f.root, 'graph-runs', 'doc-draft', f.state.runId, 'draft.md'))).toBe(false);
    } finally { f.cleanup(); }
  }
}, 30000);

test('a Markdown link is not an unfilled placeholder (운영 실측 10-02 — [elanous.ai](https://…) 가 오판됐다)', async () => {
  const linked = good['promo-post'].replace('주최 측 확인 후 추가합니다.', '주최 측 확인 후 추가합니다. 자세한 안내는 [elanous.ai](https://elanous.ai) 에서 볼 수 있습니다.');
  const f = await graphRun({ kind: 'promo-post', topic: 'Event' }, { DOC_DRAFT_BAD_DRAFT: linked });
  try {
    expect(f.state.status).toBe('done');
    expect(f.state.path).toEqual(['draft', 'check', 'report', 'done']);
  } finally { f.cleanup(); }
  const bare = await graphRun({ kind: 'promo-post', topic: 'Event' }, { DOC_DRAFT_BAD_DRAFT: good['promo-post'] + ' [회사 이름]' });
  try {
    expect(bare.state.status).toBe('failed');
    expect(String(bare.state.nodes[1]?.output)).toContain('unfilled placeholder');
  } finally { bare.cleanup(); }
}, 30000);

test('ask runs from an empty temporary folder, uses bare JSON with legacy fallback, and never invokes publish/send/pay', async () => {
  const f = fixture();
  const caller = join(f.root, 'caller');
  await Bun.write(join(caller, 'AGENTS.md'), 'Secret project instructions');
  const log = join(f.root, 'calls.jsonl');
  const prior = process.env.DOC_DRAFT_ELANOUS_BIN;
  process.env.DOC_DRAFT_ELANOUS_BIN = f.bin;
  process.env.DOC_DRAFT_CALL_LOG = log;
  process.env.DOC_DRAFT_NO_BARE = '1';
  const priorCwd = process.cwd();
  try {
    process.chdir(caller);
    const state = await runGraph(graphFile, { input: { kind: 'memo', topic: 'Meeting', outDir: join(f.root, 'drafts') }, deps: { root: f.root } });
    expect(state.status).toBe('done');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[]; cwd: string; toolCwd: string | null });
    expect(calls.map(call => call.args.slice(0, -1))).toEqual([['--bare', '--json'], ['--json'], ['--bare', '--json'], ['--json']]);
    expect(calls.every(call => call.command === 'ask' && call.cwd.includes('doc-draft-') && call.cwd !== caller && call.toolCwd === null)).toBe(true);
    expect(calls.every(call => !existsSync(call.cwd))).toBe(true);
    expect(calls.map(call => call.args.at(-1)).join(' ')).not.toContain('Secret project instructions');
  } finally {
    process.chdir(priorCwd);
    if (prior === undefined) delete process.env.DOC_DRAFT_ELANOUS_BIN;
    else process.env.DOC_DRAFT_ELANOUS_BIN = prior;
    delete process.env.DOC_DRAFT_CALL_LOG;
    delete process.env.DOC_DRAFT_NO_BARE;
    f.cleanup();
  }
}, 30000);

test('ask preserves files written into its temporary directory while it runs', async () => {
  const f = fixture();
  const marker = join(f.root, 'neutral-location');
  const previous = process.env.DOC_DRAFT_ELANOUS_BIN;
  process.env.DOC_DRAFT_ELANOUS_BIN = f.bin;
  process.env.DOC_DRAFT_KEEP_NEUTRAL = marker;
  try {
    const state = await runGraph(graphFile, { input: { kind: 'memo', topic: 'Meeting' }, deps: { root: f.root } });
    expect(state.status).toBe('done');
    const neutralDir = readFileSync(marker, 'utf8');
    expect(readFileSync(join(neutralDir, '.elanous', 'another-process.txt'), 'utf8')).toBe('keep this file');
  } finally {
    if (previous === undefined) delete process.env.DOC_DRAFT_ELANOUS_BIN;
    else process.env.DOC_DRAFT_ELANOUS_BIN = previous;
    delete process.env.DOC_DRAFT_KEEP_NEUTRAL;
    if (existsSync(marker)) {
      const neutralDir = readFileSync(marker, 'utf8');
      rmSync(neutralDir, { recursive: true, force: true });
    }
    f.cleanup();
  }
});

test('ask failure routes draft to failed without writing an output file', async () => {
  const f = await graphRun({ kind: 'memo', topic: 'Meeting' }, { DOC_DRAFT_FAIL_ASK: '1' });
  try {
    expect(f.state.status).toBe('failed');
    expect(f.state.path).toEqual(['draft', 'failed']);
    expect(String(f.state.nodes[0]?.output)).toContain('ask unavailable');
    expect(existsSync(join(f.root, 'graph-runs', 'doc-draft', f.state.runId, 'draft.md'))).toBe(false);
  } finally { f.cleanup(); }
});

test('report fails without replacing an existing draft.md in the chosen outDir', async () => {
  const f = fixture();
  const outDir = join(f.root, 'existing');
  mkdirSync(outDir);
  const original = '# Keep this draft\n\nPreviously written by a person.\n';
  writeFileSync(join(outDir, 'draft.md'), original);
  const previous = process.env.DOC_DRAFT_ELANOUS_BIN;
  process.env.DOC_DRAFT_ELANOUS_BIN = f.bin;
  try {
    const state = await runGraph(graphFile, { input: { kind: 'memo', topic: 'Meeting', outDir }, deps: { root: f.root } });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['draft', 'check', 'report', 'failed']);
    expect(String(state.nodes[2]?.output)).toContain('"outcome":"fail"');
    expect(String(state.nodes[2]?.output)).toContain('draft already exists');
    expect(readFileSync(join(outDir, 'draft.md'), 'utf8')).toBe(original);
  } finally {
    if (previous === undefined) delete process.env.DOC_DRAFT_ELANOUS_BIN;
    else process.env.DOC_DRAFT_ELANOUS_BIN = previous;
    f.cleanup();
  }
});

test('default output directory is next to graph run state', async () => {
  const f = await graphRun({ kind: 'memo', topic: 'Meeting' });
  try {
    const output = JSON.parse(String(f.state.nodes[2]?.output)) as { file: string };
    expect(output.file).toBe(join(f.root, 'graph-runs', 'doc-draft', f.state.runId, 'draft.md'));
    expect(existsSync(output.file)).toBe(true);
  } finally { f.cleanup(); }
});

test('planner-style kind wording is normalized — «executive one-pager» · «홍보 글» · «메모» reach done', async () => {
  // 10-01 운영 실측: COO 가 kind 에 «executive one-pager» 를 넣어 draft 가 0.01초 만에 failed.
  for (const [kind, expected] of [['executive one-pager', 'exec-onepager'], ['행사 홍보 글', 'promo-post'], ['메모', 'memo']] as const) {
    const f = fixture();
    const previous = process.env.DOC_DRAFT_ELANOUS_BIN;
    process.env.DOC_DRAFT_ELANOUS_BIN = f.bin;
    try {
      const outDir = join(f.root, 'out');
      const state = await runGraph(graphFile, { input: { kind, topic: 'Prepare a document about the event', context: 'No verified numbers yet', language: 'ko', outDir }, deps: { root: f.root } });
      expect(state.status).toBe('done');
      expect(readFileSync(join(outDir, 'draft.md'), 'utf8')).toBe(good[expected] + '\n');
    } finally {
      if (previous === undefined) delete process.env.DOC_DRAFT_ELANOUS_BIN;
      else process.env.DOC_DRAFT_ELANOUS_BIN = previous;
      f.cleanup();
    }
  }
}, 30000);
