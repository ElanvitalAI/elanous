import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateGraphYaml } from '../nexus/api/graph-kinds.js';
import { runGraph, validateUnitCalls } from '../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { handTask, readTaskCard, selectTaskComposition } from '../task-agent/task-hand.js';
import { composeMissionGraph, missionGraphIssues } from './mission-compose.js';

const root = join(import.meta.dir, '../..');
const standard = readFileSync(join(root, 'graphs/work/research-report.yaml'), 'utf8');
const answer = (yaml: string) => `BASE: work-research-report-rehearsal\nSLUG: mission-report\nSUMMARY: 보고서 작성 검증\n\`\`\`yaml\n${yaml}\`\`\``;
const rearranged = standard.replace('done: verify, rework: make-doc', 'done: verify, rework: verify');

test('MISSION-GRAPH-COMPOSE: 정상 미션은 가장 가까운 표준 조합에서 동사 단위만 조합하고 원장 옆에 검증 그래프와 선택 이유를 남긴다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-'));
  const ledger = join(dir, 'task-agent-actions.json');
  const prompts: string[] = [];
  try {
    const result = await handTask({ id: 'ta-compose-report', text: '출처를 조사해 보고서를 작성하고 검증해', completion: 'research-report',
      statePath: ledger, composeGraph: true, composeCallLLM: async prompt => { prompts.push(prompt); return answer(rearranged); } });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('verb-make-doc@1');
    expect(JSON.parse(readFileSync(join(dir, 'ta-compose-report.composition.json'), 'utf8')).reason).toContain('composed:');
    expect(result.card.composition?.file).not.toBe('graphs/work/research-report.yaml');
    expect(result.card.graphSelectedBy).toBe('mission-compose');
    // Generated paths must be next to the task ledger, not in the source template tree.
    expect(result.card.composition!.file).toStartWith(dir);
    const yaml = readFileSync(result.card.composition!.file, 'utf8');
    expect(validateGraphYaml('harness', yaml).ok).toBe(true);
    expect(yaml).toContain('done: verify, rework: verify');
    expect(yaml).not.toContain('done: verify, rework: make-doc');
    expect(validateUnitCalls(parseGraphTemplateYaml(yaml).template!, result.card.composition!.file).size).toBe(3);
    const dry = await runGraph(result.card.composition!.file, { dryRun: true, deps: { root: join(dir, 'dry-run'), log: () => {} } });
    expect(dry.status).toBe('done');
    expect(dry.executed).toBe(0);
    const graph = parseYaml(yaml) as { nodes: Array<{ kind: string; call?: string }> };
    expect(graph.nodes.filter(node => node.kind !== 'gate').map(node => node.call)).toEqual(['verb-research@1', 'verb-make-doc@1', 'verb-verify@1']);
    expect(readTaskCard(result.card.id, ledger)?.composition).toEqual(result.card.composition);
    expect(readFileSync(join(dir, `${result.card.id}.composition.json`), 'utf8')).toContain('research-report.yaml');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: merge 앞 gate 누락은 거절하고 표준 조합으로 강등하며 생성 원문과 이유를 기록한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-reject-'));
  const ledger = join(dir, 'task-agent-actions.json');
  const unsafe = standard.replace('node_id: verify', 'node_id: merge')
    .replace('done: verify', 'done: merge').replace('from: verify', 'from: merge');
  try {
    const result = await composeMissionGraph({ text: 'PR을 merge 해', completion: 'research-report', ledgerPath: ledger, cardId: 'ta-merge', root, standard: selectTaskComposition('research-report') },
      { callLLM: async () => answer(unsafe) });
    expect(result.selection.composition?.file).toBe('graphs/work/research-report.yaml');
    expect(result.reason).toContain('I1~I3: merge 앞 gate 없음');
    expect(readFileSync(join(dir, 'ta-merge.generated.yaml'), 'utf8')).toContain('node_id: merge');
    expect(readFileSync(join(dir, 'ta-merge.composition.json'), 'utf8')).toContain('I1~I3: merge 앞 gate 없음');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: 문면에 맞는 graphs/work 표준 조합을 고정 fallback보다 우선한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-nearest-'));
  try {
    const ledger = join(dir, 'task-agent-actions.json');
    const result = await composeMissionGraph({ text: 'research report 작성', completion: 'artifact', ledgerPath: ledger,
      cardId: 'ta-nearest', root, standard: selectTaskComposition('artifact') },
    { callLLM: async () => answer(standard) });
    expect(result.reason).toContain('문면 선택 graphs/work/research-report.yaml');
    expect(result.reason).toContain('composed:');
    expect(JSON.parse(readFileSync(join(dir, 'ta-nearest.composition.json'), 'utf8')).base).toBe('graphs/work/research-report.yaml');
    expect(result.selection.composition?.file).toBe(join(dir, 'ta-nearest.generated.yaml'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: 다른 표준 조합을 고른 뒤 거절하면 그 표준 조합으로 강등한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-nearest-fallback-'));
  try {
    const result = await composeMissionGraph({ text: 'research report 작성', completion: 'artifact',
      ledgerPath: join(dir, 'task-agent-actions.json'), cardId: 'ta-nearest-rejected', root,
      standard: selectTaskComposition('artifact') }, { callLLM: async () => answer('graph_id: [invalid') });
    expect(result.reason).toContain('문면 선택 graphs/work/research-report.yaml');
    expect(result.selection.composition?.file).toBe('graphs/work/research-report.yaml');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: live hand는 생성된 원장 옆 파일로 graph-run을 발사한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-live-'));
  const ledger = join(dir, 'task-agent-actions.json');
  const paths: string[] = [];
  try {
    const result = await handTask({ id: 'ta-compose-live', text: '조사해서 보고서를 검증해', completion: 'research-report',
      statePath: ledger, composeGraph: true, live: true, composeCallLLM: async () => answer(standard),
      graphRunner: async (file, options) => {
        paths.push(file);
        expect(options.input).toMatchObject({ ask: '조사해서 보고서를 검증해' });
        return { graphId: 'generated', runId: options.runId!, status: 'done', path: [], nodes: [], executed: 0,
          dryRun: false, statePath: join(dir, 'run.json') };
      } });
    expect(paths).toEqual([result.card.composition!.file]);
    expect(result.card.status).toBe('launched');
    expect(readTaskCard(result.card.id, ledger)?.composition).toEqual(result.card.composition);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: 권한 표는 동사 밖 노드와 런처 변경을 거절한다', () => {
  const rogue = standard.replace('call: verb-make-doc@1', 'call: verb-unknown@1');
  expect(missionGraphIssues(rogue, standard, root).join(' ')).toContain('권한 표');
  const switched = standard.replace('launcher: graph-run', 'launcher: harness-say');
  expect(missionGraphIssues(switched, standard, root).join(' ')).toContain('I6');
  const unguardedMerge = standard.replace('node_id: verify', 'node_id: merge')
    .replace('done: verify', 'done: merge').replace('from: verify', 'from: merge');
  expect(missionGraphIssues(unguardedMerge, standard, root).join(' ')).toContain('I1~I3: merge 앞 gate 없음');
  const escalated = standard.replace('tools: worktree-write', 'tools: harness-say');
  expect(missionGraphIssues(escalated, standard, root).join(' ')).toContain('권한');
  const rerouted = standard.replace('done: verify, rework:', 'done: done, rework:');
  expect(missionGraphIssues(rerouted, standard, root).join(' ')).toContain('I4:');
});

test('MISSION-GRAPH-COMPOSE: 표준의 비종료 gate를 그대로 둔 조합은 허용한다', () => {
  const base = parseYaml(standard) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  base.nodes.push({ node_id: 'checkpoint', kind: 'gate', recipe: 'none', max_visits: 1 });
  (base.edges.find(edge => edge.from === 'make-doc')!.map as Record<string, string>).done = 'checkpoint';
  base.edges.push({ from: 'checkpoint', on: 'outcome', map: { done: 'verify', failed: 'failed' } });
  const yaml = stringifyYaml(base);
  expect(missionGraphIssues(yaml, yaml, root)).toEqual([]);
});

test('MISSION-GRAPH-COMPOSE: 프로젝트 또는 draft claim 거절은 생성 파일을 남기지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-preflight-'));
  const ledger = join(dir, 'task-agent-actions.json');
  const id = 'ta-preflight';
  let calls = 0;
  const input = { id, text: '보고서 작성 검증', completion: 'research-report' as const,
    statePath: ledger, composeGraph: true, composeCallLLM: async () => { calls++; return answer(standard); } };
  try {
    await expect(handTask({ ...input, project: { id: 'missing', target: join(dir, 'absent') } })).rejects.toThrow('대상 디렉터리가 없습니다');
    expect(calls).toBe(0);
    expect(existsSync(join(dir, `${id}.generated.yaml`))).toBe(false);
    expect(existsSync(join(dir, `${id}.composition.json`))).toBe(false);
    await expect(handTask({ ...input, draftClaim: { pr: 1, labels: ['elanous:running'] } })).rejects.toThrow('claim-unobserved');
    expect(calls).toBe(0);
    expect(existsSync(join(dir, `${id}.generated.yaml`))).toBe(false);
    expect(existsSync(join(dir, `${id}.composition.json`))).toBe(false);
    await expect(handTask({ ...input, writeGuard: () => false })).rejects.toThrow('다른 넘김이 가져갔다');
    expect(calls).toBe(1);
    expect(existsSync(join(dir, `${id}.generated.yaml`))).toBe(false);
    expect(existsSync(join(dir, `${id}.composition.json`))).toBe(false);
    expect(existsSync(join(dir, 'recipes.yaml'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: 외부 효과 동사를 새 노드에 추가하면 I5 권한 검사로 거절한다', () => {
  const base = parseYaml(standard) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  const extra = structuredClone(base);
  const verify = extra.nodes.find(node => node.node_id === 'verify')!;
  extra.nodes.push({ ...verify, node_id: 'publish-again', call: 'verb-publish@1' });
  (extra.edges.find(edge => edge.from === 'verify')!.map as Record<string, string>).done = 'publish-again';
  extra.edges.push({ from: 'publish-again', on: 'outcome', map: { done: 'done', rework: 'verify', 'needs-human': 'failed', failed: 'failed' } });
  expect(missionGraphIssues(stringifyYaml(extra), standard, root).join(' ')).toContain('I5: 외부 효과 동사 추가 금지');
});

test('MISSION-GRAPH-COMPOSE: 원장 옆 레시피가 표준과 다르면 덮어쓰지 않고 강등한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-recipe-'));
  const existing = 'unreviewed: { command: echo unsafe }\n';
  writeFileSync(join(dir, 'recipes.yaml'), existing);
  try {
    const result = await composeMissionGraph({ text: '보고서를 검증해', completion: 'research-report',
      ledgerPath: join(dir, 'task-agent-actions.json'), cardId: 'ta-recipe', root,
      standard: selectTaskComposition('research-report') }, { callLLM: async () => answer(standard) });
    expect(result.selection.composition?.file).toBe('graphs/work/research-report.yaml');
    expect(result.reason).toContain('recipes.yaml');
    expect(readFileSync(join(dir, 'recipes.yaml'), 'utf8')).toBe(existing);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: 원장 옆 shadow 유닛은 권한 검증에서 강등한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-shadow-unit-'));
  const ledger = join(dir, 'task-agent-actions.json');
  mkdirSync(join(dir, 'units'));
  writeFileSync(join(dir, 'units/make-doc.yaml'), readFileSync(join(root, 'graphs/units/verbs/make-doc.yaml'), 'utf8')
    .replace("recipe: 'cmd:headless-goal-loop'", "recipe: 'cmd:unreviewed-execution'"));
  try {
    const result = await composeMissionGraph({ text: '보고서 작성 검증', completion: 'research-report', ledgerPath: ledger,
      cardId: 'ta-shadow-unit', root, standard: selectTaskComposition('research-report') }, { callLLM: async () => answer(standard) });
    expect(result.selection.composition?.file).toBe('graphs/work/research-report.yaml');
    expect(result.reason).toContain('권한 표: 동사 단위 미해석 verb-make-doc@1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MISSION-GRAPH-COMPOSE: opt-in 꺼짐은 LLM 호출 없이 고정 조합과 카드 모양을 지킨다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-compose-off-'));
  const ledger = join(dir, 'task-agent-actions.json');
  let calls = 0;
  try {
    const fixed = selectTaskComposition('research-report');
    const result = await handTask({ id: 'ta-compose-off', text: '보고서를 작성해', completion: 'research-report', statePath: ledger,
      composeCallLLM: async () => { calls++; return answer(standard); } });
    expect(calls).toBe(0);
    expect(result.card.composition).toEqual(fixed.composition);
    expect(result.card.graphSelectedBy).toBe('completion');
    expect(result.card.history).toEqual([]);
    expect(readTaskCard(result.card.id, ledger)?.composition).toEqual(fixed.composition);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
