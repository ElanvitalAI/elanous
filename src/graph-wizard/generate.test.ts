import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../graph-runner/runner.js';
import { WIZARD_ARCHETYPES } from './archetypes.js';
import { runWizardStepWithRetries } from './steps.js';
import { GraphWizardInputError, HARNESS_EXAMPLE, parseNodeAnnotations, stepIssues, WORKFLOW_EXAMPLE, generateGraphFromPrompt, pickBaseTemplate, listWizardTemplates, summarizeChange, validateWizardYaml, wizardGraphId } from './generate.js';

const graphsDir = join(import.meta.dir, '../../graphs');
const fenced = (yaml: string, extra = '') => `${extra}SLUG: news digest\nSUMMARY: 뉴스 요약 그래프\n\`\`\`yaml\n${yaml}\`\`\`\n`;
const broken = HARNESS_EXAMPLE.replace('kind: hitl', 'kind: alien');

function stub(replies: string[]) {
  const prompts: string[] = [];
  return { prompts, callLLM: async (prompt: string) => { prompts.push(prompt); return replies[Math.min(prompts.length - 1, replies.length - 1)]!; } };
}

test('examples in the prompt pass the same validator the API uses', () => {
  expect(validateWizardYaml('harness', HARNESS_EXAMPLE)).toEqual([]);
  expect(validateWizardYaml('workflow', WORKFLOW_EXAMPLE)).toEqual([]);
});

test('valid on the first try: ok, forced fresh id, base from the template list, no save', async () => {
  const llm = stub([fenced(HARNESS_EXAMPLE, 'BASE: lecture-note\n')]);
  const result = await generateGraphFromPrompt({ prompt: '매일 아침 AI 뉴스를 모아 요약해서 보내' }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() });
  expect(result.ok).toBe(true);
  expect(result.attempts).toBe(1);
  expect(result.issues).toEqual([]);
  expect(result.base).toBe('lecture-note');
  expect(result.id).toMatch(/^news-digest-[0-9a-f]{6}$/);
  expect((parseYaml(result.yaml) as { graph_id: string }).graph_id).toBe(result.id);
  expect(result.summary).toContain('뉴스 요약 그래프');
  expect(result.summary).toContain('노드 7개');
  expect(llm.prompts[0]).toContain('agent, gate, git, judge, observe, hitl, subgraph');
});

test('invalid then fixed: issues are fed back and the second attempt passes', async () => {
  const llm = stub([fenced(broken), fenced(HARNESS_EXAMPLE)]);
  const result = await generateGraphFromPrompt({ prompt: 'news' }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() });
  expect(result.ok).toBe(true);
  expect(result.attempts).toBe(2);
  expect(llm.prompts[1]).toContain('직전 시도가 검증에 실패했다');
  expect(llm.prompts[1]).toContain('alien');
});

test('invalid three times: ok false with the last yaml and its issues', async () => {
  const llm = stub([fenced(broken)]);
  const result = await generateGraphFromPrompt({ prompt: 'news' }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() });
  expect(result.ok).toBe(false);
  expect(result.attempts).toBe(3);
  expect(llm.prompts).toHaveLength(3);
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.yaml).toContain('alien');
});

test('runnable shape: an unknown recipe form is an issue', () => {
  expect(validateWizardYaml('harness', HARNESS_EXAMPLE.replace("recipe: 'cmd:send'", 'recipe: send-it')).join('\n')).toContain('nodes/send/recipe');
});

test('edit path keeps the current id and stable node ids, and summarizes the counted change', async () => {
  const current = HARNESS_EXAMPLE.replace('graph_id: example-digest', 'graph_id: my-digest');
  const edited = current
    .replace('  - { node_id: done,', "  - { node_id: archive, kind: agent, recipe: 'cmd:archive', max_visits: 1 }  # 보관 | custom | 노션에 보관\n  - { node_id: done,")
    .replace('{ from: send, on: outcome, map: { ok: done, fail: failed } }',
      '{ from: send, on: outcome, map: { ok: archive, fail: failed } }\n  - { from: archive, on: outcome, map: { ok: done, fail: failed } }');
  const llm = stub([`SUMMARY: 보관 단계 추가\n\`\`\`yaml\n${edited.replace('graph_id: my-digest', 'graph_id: renamed')}\`\`\``]);
  const result = await generateGraphFromPrompt(
    { prompt: '보내고 나면 보관해', currentYaml: current, history: [{ role: 'user', text: '뉴스 요약 그래프 만들어' }] },
    { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set(['my-digest']) },
  );
  expect(result.ok).toBe(true);
  expect(result.id).toBe('my-digest');
  expect(result.yaml).toContain('graph_id: my-digest');
  expect(result.base).toBeUndefined();
  expect(result.summary).toContain('노드 1개 추가: 보관');
  expect(result.summary).toContain('간선 2개 추가');
  expect(result.summary).toContain('간선 1개 재연결');
  expect(llm.prompts[0]).toContain('지금 그래프');
  expect(llm.prompts[0]).toContain('뉴스 요약 그래프 만들어');
});

test('edit without a keepable id is rejected instead of silently becoming a new graph; LLM errors propagate', async () => {
  const llm = stub([fenced(HARNESS_EXAMPLE)]);
  await expect(generateGraphFromPrompt({ prompt: 'x', currentYaml: HARNESS_EXAMPLE.replace('graph_id: example-digest\n', '') }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() }))
    .rejects.toBeInstanceOf(GraphWizardInputError);
  expect(llm.prompts).toHaveLength(0);
  await expect(generateGraphFromPrompt({ prompt: 'x' }, { callLLM: async () => { throw new Error('llm down'); }, graphsDir, existingIds: () => new Set() }))
    .rejects.toThrow('llm down');
});

test('runnable: recipes map cmd nodes to library steps and approvals to Korean prompts, and the dry-run walks to done', async () => {
  const llm = stub([fenced(HARNESS_EXAMPLE)]);
  const result = await generateGraphFromPrompt({ prompt: '뉴스' }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() });
  expect(result.ok).toBe(true);
  expect(result.dryRun).toEqual({ status: 'done', path: ['collect', 'summarize', 'check', 'approve', 'send', 'done'] });
  expect(result.labels).toMatchObject({ collect: '뉴스 수집', approve: '발송 승인', done: '완료' });
  expect(result.steps!.collect).toEqual({ label: '뉴스 수집', step: 'web-search', arg: '오늘 AI 뉴스' });
  const recipes = parseYaml(result.recipes!) as Record<string, { command?: string; approval?: string }>;
  expect(recipes.collect!.command).toBe("elanous graph step web-search --arg '오늘 AI 뉴스'");
  expect(recipes.send!.command).toContain('graph step telegram-send');
  expect(recipes.approve!.approval).toBe('발송 승인 — 승인할까요?');
  const dir = mkdtempSync(join(tmpdir(), 'graph-wizard-dry-'));
  try {
    writeFileSync(join(dir, 'g.yaml'), result.yaml);
    writeFileSync(join(dir, 'recipes.yaml'), result.recipes!);
    const state = await runGraph(join(dir, 'g.yaml'), { dryRun: true, deps: { root: join(dir, 'state') } });
    expect(state.status).toBe('done');
    expect(state.executed).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cmd node without a library step is fed back as an issue (names alone do not run)', async () => {
  const bare = HARNESS_EXAMPLE.replace('  # 텔레그램 발송 | telegram-send', '');
  const llm = stub([fenced(bare), fenced(HARNESS_EXAMPLE)]);
  const result = await generateGraphFromPrompt({ prompt: '뉴스' }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() });
  expect(result.ok).toBe(true);
  expect(result.attempts).toBe(2);
  expect(llm.prompts[1]).toContain('nodes/send');
});

test('archetypes validate and walk; retry=N stays inside the step (no new retry nodes or loop edges)', async () => {
  for (const archetype of WIZARD_ARCHETYPES) expect(validateWizardYaml('harness', archetype.text)).toEqual([]);
  const before = HARNESS_EXAMPLE;
  const after = HARNESS_EXAMPLE
    .replace('# 뉴스 수집 | web-search | 오늘 AI 뉴스', '# 뉴스 수집 | web-search | 오늘 AI 뉴스 | retry=3')
    .replace('# 텔레그램 발송 | telegram-send', '# 텔레그램 발송 | telegram-send | | retry=3')
    .replace('  - { node_id: done,', "  - { node_id: tell-me, kind: agent, recipe: 'cmd:tell-me', max_visits: 1 }  # 실패 알림 | notify-me | 3번 넘게 실패했다\n  - { node_id: done,")
    .replace('{ from: collect, on: outcome, map: { ok: summarize, fail: failed } }', '{ from: collect, on: outcome, map: { ok: summarize, fail: tell-me } }')
    .replace('{ from: send, on: outcome, map: { ok: done, fail: failed } }', '{ from: send, on: outcome, map: { ok: done, fail: tell-me } }\n  - { from: tell-me, on: outcome, map: { ok: failed, fail: failed } }');
  const llm = stub(['SUMMARY: 재시도와 알림\n```yaml\n' + after + '```']);
  const result = await generateGraphFromPrompt({ prompt: '실패하면 다시 시도하고 3번 넘으면 나한테 알려줘', currentYaml: before }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() });
  expect(result.ok).toBe(true);
  expect(result.steps!.collect).toEqual({ label: '뉴스 수집', step: 'web-search', arg: '오늘 AI 뉴스', retries: 3 });
  expect(result.steps!.send).toEqual({ label: '텔레그램 발송', step: 'telegram-send', retries: 3 });
  const recipes = parseYaml(result.recipes!) as Record<string, { command?: string }>;
  expect(recipes.collect!.command).toBe("elanous graph step web-search --arg '오늘 AI 뉴스' --retries 3");
  expect(result.summary).toContain('노드 1개 추가: 실패 알림 · 간선 2개 추가 · 간선 2개 재연결 · 재시도 설정 2개 노드');
  expect(llm.prompts[0]).toContain('retry=N');
});

test('runnable guards: shared recipe names, retry above the cap, and a merge without approval are fed back', async () => {
  const shared = HARNESS_EXAMPLE.replace("recipe: 'cmd:send'", "recipe: 'cmd:collect'");
  expect(stepIssues(shared, parseNodeAnnotations(shared)).join('\n')).toContain("recipe 'cmd:collect'");
  const many = HARNESS_EXAMPLE.replace('# 텔레그램 발송 | telegram-send', '# 텔레그램 발송 | telegram-send | | retry=11');
  expect(stepIssues(many, parseNodeAnnotations(many)).join('\n')).toContain('retry=11');
  const merge = HARNESS_EXAMPLE.replace('# 텔레그램 발송 | telegram-send', '# 머지 | gh-pr-merge')
    .replace('{ from: approve, on: outcome, map: { ok: send, fail: failed } }', '{ from: approve, on: outcome, map: { ok: done, fail: failed } }')
    .replace('{ from: check, on: outcome, map: { ok: approve, rework: summarize, fail: failed } }', '{ from: check, on: outcome, map: { ok: send, approve: approve, rework: summarize, fail: failed } }');
  expect(stepIssues(merge, parseNodeAnnotations(merge)).join('\n')).toContain('PR 머지 앞에는');
  expect(stepIssues(HARNESS_EXAMPLE, parseNodeAnnotations(HARNESS_EXAMPLE))).toEqual([]);
});

test('step retries: a failing step is retried in place up to N more times', () => {
  let calls = 0;
  const result = runWizardStepWithRetries('x', undefined, 3, () => { calls += 1; return calls < 3 ? { outcome: 'fail' } : { outcome: 'ok', text: 'y' }; });
  expect(result).toMatchObject({ outcome: 'ok', tries: 3 });
  expect(runWizardStepWithRetries('x', undefined, 2, () => ({ outcome: 'fail' })).tries).toBe(3);
});

test('workflow kind validates with the workflow parser and forces name', async () => {
  const llm = stub([fenced(WORKFLOW_EXAMPLE)]);
  const result = await generateGraphFromPrompt({ prompt: 'digest', kind: 'workflow' }, { callLLM: llm.callLLM, graphsDir, existingIds: () => new Set() });
  expect(result.ok).toBe(true);
  expect((parseYaml(result.yaml) as { name: string }).name).toBe(result.id);
});

test('ids never collide with an existing graph and base picking prefers runnable templates', () => {
  const first = wizardGraphId('x', 'news digest', new Set());
  expect(wizardGraphId('x', 'news digest', new Set([first]))).toBe(`${first}-2`);
  expect(wizardGraphId('한글만', undefined, new Set())).toMatch(/^graph-[0-9a-f]{6}$/);
  const templates = listWizardTemplates(graphsDir);
  const news = pickBaseTemplate('매일 아침 AI 뉴스 모아서 요약해 텔레그램으로 보내줘', templates);
  expect(news?.template.id).toBe('wizard-collect-summarize-send');
  expect(news?.reason).toContain('뉴스');
  expect(pickBaseTemplate('PR이 올라오면 리뷰하고 must-fix가 없으면 머지', templates)?.template.id).toBe('wizard-review-merge');
  expect(pickBaseTemplate('경쟁 제품 가격을 조사해서 표로 정리하고 내가 승인하면 노션에 올려', templates)?.template.id).toBe('wizard-research-approve-publish');
  expect(pickBaseTemplate('강의 자료 노트', templates)?.template.runnable).toBe(true);
  expect(summarizeChange('harness', undefined, HARNESS_EXAMPLE)).toContain('새 그래프');
});
