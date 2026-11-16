import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGraph } from '../runner.js';
import { createSourcePlanningRegistry, type PlanningModelReply } from '../capability-providers/source-planning.js';
import { ARCHITECTURE_SECTIONS, APP_BUILD_MAX_REPAIRS } from './contracts.js';
import { extractMermaidBlocks } from './mermaid-parse.js';

const graph = fileURLToPath(new URL('../../../plugins/elanous-app-build/graph/app-build-plan.yaml', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const assumptions = { assumptions: [{ statement: 'assumed: Use local SQLite until an extension is explicitly approved.', source: 'assumed' }] };
const diagrams: Record<string, string> = {
  context: '```mermaid\ngraph TD\n Browser-->API\n API-->SQLite\n```',
  dataModel: '```mermaid\nerDiagram\n RECORD {\n string id PK\n }\n```',
  sequences: '```mermaid\nsequenceDiagram\n participant Browser\n participant API\n Browser->>API: POST record\n API-->>Browser: Created record\n```',
};
const testStrategy = [{ id: 'roundtrip', kind: 'api', target: 'Validate a record round trip', testFile: 'test/source.test.ts', device: 'bun-test-sandbox', command: ['bun', 'test', './test/source.test.ts'] }];
const architecture = { testStrategyTitle: 'Test strategy', testStrategy, markdown: ARCHITECTURE_SECTIONS.map(key => '## ' + key + '\nConcrete synthetic ' + key
  + (diagrams[key] ? '\n' + diagrams[key] : '') + (key === 'api' ? '\n[API implementation](backend/source.ts)' : '')).join('\n'),
  sections: Object.fromEntries(ARCHITECTURE_SECTIONS.map(key => [key, 'Concrete synthetic ' + key])) };
const invalidMermaidArchitecture = { ...architecture,
  markdown: architecture.markdown.replace(' }\n```', ' }\n User ||--o{ Order : 포함\n```') };
const fixedErCode = extractMermaidBlocks(invalidMermaidArchitecture.markdown)[1]!.code.replace(' : 포함', ' : "포함"');
const roles = ['architecture', 'database', 'backend', 'frontend', 'test', 'seed'];
const plan = { plan: roles.map((role, index) => ({ path: role === 'architecture' ? 'ARCHITECTURE.md' : role === 'test' ? 'test/source.test.ts' : role + '/source.ts', purpose: role,
  role, dependsOn: index ? ['ARCHITECTURE.md'] : [] })) };
function model(text: unknown): PlanningModelReply { return { text: typeof text === 'string' ? text : JSON.stringify(text), provider: 'fixture-configured', model: 'fixture-configured-model' }; }
function parsedOutput(value: unknown): { error?: string; evidence?: { attempts?: unknown[] }; result?: Record<string, unknown> } {
  return typeof value === 'string' ? JSON.parse(value) : value && typeof value === 'object' ? value : {};
}
function root(): string { const path = mkdtempSync(join(tmpdir(), 'staged-plan-')); roots.push(path); return path; }
function valueFor(prompt: string): unknown {
  if (prompt.includes('Stage: assumptions.')) return assumptions;
  if (prompt.includes('Stage: architecture.')) return architecture;
  return plan;
}

test('actual graph runs ordered stages and repairs a clarification response without claiming a built app', async () => {
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    return model(prompts.length === 1 ? { assumptions: [{ statement: 'assumed: Which database would you like?', source: 'assumed' }] } : valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Build a general application with requested synthetic data.', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
  const outputs = Object.fromEntries(state.nodes.map(node => [node.nodeId, parsedOutput(node.output)])) as Record<string, { result?: Record<string, unknown>; evidence?: Record<string, unknown> }>;
  expect(outputs['file-plan']?.result?.planningComplete).toBe(true);
  expect(outputs['file-plan']?.result?.buildComplete).toBe(false);
  expect(outputs['file-plan']?.result?.nextStage).toBe('files');
  expect(outputs['file-plan']?.result?.repairUsed).toBe(1);
  expect(outputs.architecture?.evidence?.model).toBe('fixture-configured-model');
  expect(prompts.filter(prompt => prompt.includes('Stage: architecture.'))).toHaveLength(1);
  expect(prompts.at(-1)).toContain('Use local SQLite');
});

test('actual graph repairs only one failed ERD body and then reaches file planning', async () => {
  let architectureCalls = 0;
  let repairCalls = 0;
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.startsWith('Repair only these Mermaid code bodies.')) {
      repairCalls++;
      return model({ replacements: [{ index: 1, kind: 'erDiagram', code: fixedErCode }] });
    }
    if (prompt.includes('Stage: architecture.')) { architectureCalls++; return model(invalidMermaidArchitecture); }
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Build an application with synthetic data.', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
  expect(architectureCalls).toBe(1);
  expect(repairCalls).toBe(1);
  const output = parsedOutput(state.nodes.find(node => node.nodeId === 'architecture')?.output);
  expect(output.result?.repairUsed).toBe(1);
  expect(output.evidence).toMatchObject({ mermaidFailedBlocks: 1,
    mermaidParseReceipts: [
      { index: 0, diagnostic: null },
      { index: 1, kind: 'erDiagram', diagnostic: 'MERMAID_PARSE_ERROR' },
      { index: 2, diagnostic: null },
    ], mermaidReparseReceipts: [{ index: 1, kind: 'erDiagram', diagnostic: null }] });
  const repaired = (output.result?.architecture as { markdown: string }).markdown;
  const before = extractMermaidBlocks(invalidMermaidArchitecture.markdown);
  const after = extractMermaidBlocks(repaired);
  expect(output.evidence).toMatchObject({ mermaidParseReceipts: before.map(block => ({
    index: block.index, kind: block.kind, sourceSha256: block.sourceSha256 })) });
  expect(JSON.stringify(output.evidence)).not.toContain('User ||--o{ Order');
  expect(after[0]!.sourceSha256).toBe(before[0]!.sourceSha256);
  expect(after[2]!.sourceSha256).toBe(before[2]!.sourceSha256);
  expect(repaired).toContain('## Test strategy');
  expect(prompts.find(prompt => prompt.startsWith('Repair only'))).not.toContain(before[0]!.code);
});

test('actual graph repairs a parser-valid unquoted Korean node label before file planning', async () => {
  const invalid = { ...architecture, markdown: architecture.markdown.replace('Browser-->API', 'Browser[관람객]-->API') };
  const before = extractMermaidBlocks(invalid.markdown);
  const corrected = before[0]!.code.replace('Browser[관람객]', 'Browser["관람객"]');
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.startsWith('Repair only these Mermaid code bodies.')) return model({ replacements: [{ index: 0, kind: 'graph', code: corrected }] });
    if (prompt.includes('Stage: architecture.')) return model(invalid);
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: '콘서트 앱 생성', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true,
    deps: { root: root(), capabilityProviders: registry } });
  expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
  expect(prompts.filter(prompt => prompt.startsWith('Repair only'))).toHaveLength(1);
  const output = parsedOutput(state.nodes.find(node => node.nodeId === 'architecture')?.output);
  expect(output.evidence).toMatchObject({ mermaidFailedBlocks: 1,
    mermaidParseReceipts: [{ index: 0, diagnostic: 'MERMAID_LABEL_POLICY_ERROR' },
      { index: 1, diagnostic: null }, { index: 2, diagnostic: null }],
    mermaidReparseReceipts: [{ index: 0, diagnostic: null }] });
  const repaired = (output.result?.architecture as { markdown: string }).markdown;
  const after = extractMermaidBlocks(repaired);
  expect(repaired.slice(0, before[0]!.begin)).toBe(invalid.markdown.slice(0, before[0]!.begin));
  expect(after.slice(1).map(block => block.sourceSha256)).toEqual(before.slice(1).map(block => block.sourceSha256));
  expect(prompts.find(prompt => prompt.startsWith('Repair only'))).toContain('MERMAID_LABEL_POLICY_ERROR');
});

test('actual graph stops when the repair keeps a parser-valid unquoted Korean label', async () => {
  const invalid = { ...architecture, markdown: architecture.markdown.replace('Browser-->API', 'Browser[관람객]-->API') };
  const failed = extractMermaidBlocks(invalid.markdown)[0]!;
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.startsWith('Repair only these Mermaid code bodies.')) return model({ replacements: [
      { index: 0, kind: 'graph', code: failed.code },
    ] });
    if (prompt.includes('Stage: architecture.')) return model(invalid);
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: '콘서트 앱 생성', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true,
    deps: { root: root(), capabilityProviders: registry } });
  expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
  expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
});

test('actual graph repairs or stops a parser-valid --x Unicode sequence endpoint before file planning', async () => {
  const invalid = { ...architecture, markdown: architecture.markdown.replace('Browser->>API: POST record',
    'Browser--x"관람객": POST record') };
  const before = extractMermaidBlocks(invalid.markdown);
  const fixed = before[2]!.code.replace('--x"관람객"', '--xAudience');
  for (const replacement of [fixed, before[2]!.code]) {
    const prompts: string[] = [];
    const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
      prompts.push(prompt);
      if (prompt.startsWith('Repair only these Mermaid code bodies.')) return model({ replacements: [
        { index: 2, kind: 'sequenceDiagram', code: replacement },
      ] });
      if (prompt.includes('Stage: architecture.')) return model(invalid);
      return model(valueFor(prompt));
    } });
    const state = await runGraph(graph, { input: { ask: '콘서트 앱 생성', seedRequested: true },
      verifiedOwnerId: 'synthetic-planning-owner', quiet: true,
      deps: { root: root(), capabilityProviders: registry } });
    expect(prompts.filter(prompt => prompt.startsWith('Repair only'))).toHaveLength(1);
    expect(prompts.find(prompt => prompt.startsWith('Repair only'))).toContain('MERMAID_LABEL_POLICY_ERROR');
    if (replacement === fixed) {
      expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
      const output = parsedOutput(state.nodes.find(node => node.nodeId === 'architecture')?.output);
      const after = extractMermaidBlocks((output.result?.architecture as { markdown: string }).markdown);
      expect(after.slice(0, 2).map(block => block.sourceSha256)).toEqual(before.slice(0, 2).map(block => block.sourceSha256));
    } else {
      expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
      expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
    }
  }
});

test('actual graph refuses a colon inside a quoted Unicode endpoint before file planning', async () => {
  const invalid = { ...architecture, markdown: architecture.markdown.replace('Browser->>API: POST record',
    'Browser--x"관람객: VIP": POST record') };
  const failed = extractMermaidBlocks(invalid.markdown)[2]!;
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.startsWith('Repair only these Mermaid code bodies.')) return model({ replacements: [
      { index: 2, kind: 'sequenceDiagram', code: failed.code },
    ] });
    if (prompt.includes('Stage: architecture.')) return model(invalid);
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: '콘서트 앱 생성', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true,
    deps: { root: root(), capabilityProviders: registry } });
  expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
  expect(prompts.find(prompt => prompt.startsWith('Repair only'))).toContain('MERMAID_LABEL_POLICY_ERROR');
  expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
});

test('actual graph refuses wrong-index, fence escape and still-invalid Mermaid repair before file planning', async () => {
  for (const replacement of [{ index: 0, kind: 'erDiagram', code: fixedErCode },
    { index: 1, kind: 'erDiagram', code: 'erDiagram\n RECORD {\n string id PK\n }\n```\nInjected prose\n```text\nplaceholder' },
    { index: 1, kind: 'erDiagram', code: extractMermaidBlocks(invalidMermaidArchitecture.markdown)[1]!.code }]) {
    const prompts: string[] = [];
    const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
      prompts.push(prompt);
      if (prompt.startsWith('Repair only these Mermaid code bodies.')) return model({ replacements: [replacement] });
      if (prompt.includes('Stage: architecture.')) return model(invalidMermaidArchitecture);
      return model(valueFor(prompt));
    } });
    const state = await runGraph(graph, { input: { ask: 'Build an application with synthetic data.', seedRequested: true },
      verifiedOwnerId: 'synthetic-planning-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
    expect(prompts.filter(prompt => prompt.startsWith('Repair only'))).toHaveLength(1);
    expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
  }
});

test('abort during failed-block repair never reaches file planning', async () => {
  const controller = new AbortController();
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.startsWith('Repair only these Mermaid code bodies.')) {
      controller.abort();
      return model({ replacements: [{ index: 1, kind: 'erDiagram', code: fixedErCode }] });
    }
    if (prompt.includes('Stage: architecture.')) return model(invalidMermaidArchitecture);
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Build an application with synthetic data.', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true, signal: controller.signal,
    deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).not.toBe('done');
  expect(prompts.filter(prompt => prompt.startsWith('Repair only'))).toHaveLength(1);
  expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
});

test('spent planning repair budget blocks Mermaid regeneration and file planning', async () => {
  let assumptionCalls = 0;
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.includes('Stage: assumptions.')) return model(++assumptionCalls <= APP_BUILD_MAX_REPAIRS
      ? { assumptions: [{ statement: 'assumed: Which app?', source: 'assumed' }] } : assumptions);
    if (prompt.includes('Stage: architecture.')) return model(invalidMermaidArchitecture);
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Build an application with synthetic data.', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true,
    deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
  expect(prompts.some(prompt => prompt.startsWith('Repair only'))).toBe(false);
  expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
});

test('Korean request keeps canonical architecture keys and Korean planning prose across all stages', async () => {
  const titles: Record<string, string> = { context: '시스템 맥락', dataModel: '데이터 모델', api: 'API 계약',
    sequences: '핵심 흐름', deployment: '배포 구성', security: '보안', tradeOffs: '설계 대안', operations: '운영' };
  const koreanDiagrams: Record<string, string> = {
    context: '```mermaid\ngraph TD\n Browser["사용자"]-->API\n API-->Database["데이터베이스"]\n```',
    dataModel: '```mermaid\nerDiagram\n SEAT ||--o{ BOOKING : "포함"\n```',
    sequences: '```mermaid\nsequenceDiagram\n participant User as "사용자"\n User->>API: "예약 요청"\n API-->>User: "예약 결과"\n```',
  };
  const koreanArchitecture = { testStrategyTitle: '시험 전략', testStrategy: testStrategy.map(item => ({ ...item, target: '생성 후 조회한 값이 일치해야 한다' })), markdown: ARCHITECTURE_SECTIONS.map(key => `## ${key} — ${titles[key]}\n${titles[key]} 설계 설명`
    + (koreanDiagrams[key] ? `\n${koreanDiagrams[key]}` : '')
    + (key === 'api' ? '\n[API 구현](backend/source.ts)' : '')).join('\n'),
    sections: Object.fromEntries(ARCHITECTURE_SECTIONS.map(key => [key, `${titles[key]} 설계 설명`])) };
  for (const ask of ['콘서트 티케팅 시스템을 만들어서 가상 데이터로 채워 넣고 배포해줘',
    'Build a concert ticketing app. Write all planning documents in Korean. 한국어로 작성해줘.']) {
    const prompts: string[] = [];
    const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
      prompts.push(prompt);
      return model(prompt.includes('Stage: assumptions.')
        ? { assumptions: [{ statement: 'assumed: 로컬 SQLite를 사용한다.', source: 'assumed' }] }
        : prompt.includes('Stage: architecture.') ? koreanArchitecture
          : { plan: plan.plan.map(item => ({ ...item, purpose: '구현과 검증을 위한 파일' })) });
    } });
    const state = await runGraph(graph, { input: { ask, seedRequested: true },
      verifiedOwnerId: 'synthetic-planning-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
    expect(prompts).toHaveLength(3);
    expect(prompts.every(prompt => prompt.includes('language of the user request'))).toBe(true);
    expect(prompts.find(prompt => prompt.includes('Stage: architecture.'))).toContain('## context — 시스템 맥락');
    expect(prompts.find(prompt => prompt.includes('Stage: architecture.'))).toContain('use ASCII identifiers');
    expect(prompts.find(prompt => prompt.includes('Stage: file-plan.'))).toContain('로컬 SQLite를 사용한다.');
    const output = parsedOutput(state.nodes.find(node => node.nodeId === 'file-plan')?.output);
    expect(output.result?.planningComplete).toBe(true);
    expect(output.result?.repairUsed).toBe(0);
  }
});

test('explicit English output wins over Korean source context through the real planning graph', async () => {
  const prompts: string[] = [];
  const englishArchitecture = { ...architecture, markdown: architecture.markdown.replace(/^## (\w+)$/gmu,
    (_match, key: string) => `## ${key} — ${key} design`) };
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    return model(prompt.includes('Stage: assumptions.') ? assumptions
      : prompt.includes('Stage: architecture.') ? englishArchitecture : plan);
  } });
  const state = await runGraph(graph, { input: { ask: 'Write the architecture and explanations in English. 참고 자료는 한국어 현장 노트입니다. Build a concert ticketing app.', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
  expect(prompts).toHaveLength(3);
  expect(prompts.every(prompt => prompt.includes('Follow an explicit requested output language'))).toBe(true);
  const architecturePrompt = prompts.find(prompt => prompt.includes('Stage: architecture.'))!;
  expect(architecturePrompt).toContain('## context\n');
  expect(architecturePrompt).toContain('requested output language');
  expect(architecturePrompt).not.toContain('## dataModel — 데이터 모델\n');
  const output = parsedOutput(state.nodes.find(node => node.nodeId === 'file-plan')?.output);
  expect(output.result?.repairUsed).toBe(0);
});

test('actual graph fails after a bounded repeated question instead of accepting early completion', async () => {
  let calls = 0;
  const registry = createSourcePlanningRegistry({ callLLM: async () => { calls++; return model({ assumptions: [{ statement: 'assumed: 무엇을 만들까요?', source: 'assumed' }] }); } });
  const state = await runGraph(graph, { input: { ask: 'Build an application.', seedRequested: false }, verifiedOwnerId: 'synthetic-planning-owner',
    quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['assumptions', 'failed']);
  expect(calls).toBe(APP_BUILD_MAX_REPAIRS + 1);
  const failed = parsedOutput(state.nodes.find(node => node.nodeId === 'assumptions')?.output);
  expect(failed.error).toBe('contract-exhausted');
  expect(failed.evidence?.attempts).toContainEqual({ provider: 'source-planning', reason: 'PLANNING_OUTPUT_REPAIR_EXHAUSTED' });
});

test('actual graph refuses incomplete architecture and never advances to file planning', async () => {
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => { prompts.push(prompt);
    return model(prompt.includes('Stage: assumptions.') ? assumptions : { markdown: 'Done', sections: { api: 'Only API' } }); } });
  const state = await runGraph(graph, { input: { ask: 'Build an application.', seedRequested: false }, verifiedOwnerId: 'synthetic-planning-owner',
    quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
  expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
});

test('an injected negative checker blocks file planning', async () => {
  for (const checkArchitecture of [() => ({ ok: false, issues: [{ code: 'missing-heading' }] })]) {
    const prompts: string[] = [];
    const registry = createSourcePlanningRegistry({ checkArchitecture, callLLM: async prompt => {
      prompts.push(prompt); return model(valueFor(prompt));
    } });
    const state = await runGraph(graph, { input: { ask: 'Build an application.' }, verifiedOwnerId: 'synthetic-planning-owner',
      quiet: true, deps: { root: root(), capabilityProviders: registry } });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
    expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
  }
});

test('default production registry checks actual Markdown headings even with all structured section fields', async () => {
  const prompts: string[] = [];
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    return model(prompt.includes('Stage: architecture.') ? { ...architecture, markdown: '# Only a summary' } : valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Build an application.' }, verifiedOwnerId: 'synthetic-planning-owner',
    quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['assumptions', 'architecture', 'failed']);
  expect(prompts.some(prompt => prompt.includes('Stage: file-plan.'))).toBe(false);
});

test('architecture repair prompt names the canonical sections for misplaced diagrams and missing link', async () => {
  const prompts: string[] = [];
  let architectureCalls = 0;
  const misplaced = { ...architecture, markdown: architecture.markdown
    .replace(diagrams.context, '').replace(diagrams.sequences, '')
    .replace('[API implementation](backend/source.ts)', 'API implementation')
    + '\n## Context Diagram\n' + diagrams.context + '\n## Sequence\n' + diagrams.sequences };
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.includes('Stage: architecture.')) return model(++architectureCalls === 1 ? misplaced : architecture);
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Build an application with synthetic data.', seedRequested: true }, verifiedOwnerId: 'synthetic-planning-owner',
    quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
  expect(architectureCalls).toBe(2);
  const architecturePrompts = prompts.filter(prompt => prompt.includes('Stage: architecture.'));
  expect(architecturePrompts[0]).toContain('## context\n');
  expect(architecturePrompts[0]).toContain('## sequences\n');
  expect(architecturePrompts[0]).toContain('## references\n');
  expect(architecturePrompts[0]).toContain('```mermaid\n```');
  expect(architecturePrompts[0]).toContain('graph or flowchart syntax');
  expect(architecturePrompts[0]).toContain('sequenceDiagram syntax');
  expect(architecturePrompts[1]).toContain('ARCHITECTURE_CHECK_FAILED');
  expect(architecturePrompts[1]).toContain('inside ## context');
  expect(architecturePrompts[1]).toContain('inside ## sequences');
  expect(architecturePrompts[1]).toContain('## references section');
  const output = parsedOutput(state.nodes.find(node => node.nodeId === 'file-plan')?.output);
  expect(output.result?.planningComplete).toBe(true);
  expect(output.result?.buildComplete).toBe(false);
});

test('file-plan repair prompt names unsupported roles without relaxing the contract', async () => {
  const prompts: string[] = [];
  let filePlanCalls = 0;
  const invalidPlan = { plan: plan.plan.map((item, index) => ({ ...item,
    role: index === 1 ? 'deployment' : item.role === 'test' ? 'tests' : item.role })) };
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.includes('Stage: file-plan.')) return model(++filePlanCalls === 1 ? invalidPlan : plan);
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Build an application with synthetic data.', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
  expect(filePlanCalls).toBe(2);
  const filePlanPrompts = prompts.filter(prompt => prompt.includes('Stage: file-plan.'));
  expect(filePlanPrompts[0]).toContain('architecture, frontend, backend, database, test, seed, config, asset');
  expect(filePlanPrompts[0]).toContain('deployment script or Docker file has role config');
  expect(filePlanPrompts[0]).toContain('test file has role test (singular)');
  expect(filePlanPrompts[1]).toContain('role deployment is outside the allowed list');
  expect(filePlanPrompts[1]).toContain('use config for deployment');
  expect(filePlanPrompts[1]).toContain('role tests is outside the allowed list');
  expect(filePlanPrompts[1]).toContain('use test for tests');
  const output = parsedOutput(state.nodes.find(node => node.nodeId === 'file-plan')?.output);
  expect(output.result?.planningComplete).toBe(true);
  expect(output.result?.buildComplete).toBe(false);
});

test('file-plan receives exact architecture references and retries a missing target before completion', async () => {
  const prompts: string[] = [];
  let planCalls = 0;
  const architectureWithReference = { ...architecture,
    markdown: architecture.markdown + '\n[Local deployment notes](deploy/local-compose.md)' };
  const repairedPlan = { plan: [...plan.plan, { path: 'deploy/local-compose.md', purpose: 'Local deployment notes',
    role: 'config', dependsOn: ['ARCHITECTURE.md'] }] };
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    prompts.push(prompt);
    if (prompt.includes('Stage: architecture.')) return model(architectureWithReference);
    if (prompt.includes('Stage: file-plan.')) return model(++planCalls === 1 ? plan : repairedPlan);
    return model(assumptions);
  } });
  const state = await runGraph(graph, { input: { ask: 'Build an application with synthetic data.', seedRequested: true },
    verifiedOwnerId: 'synthetic-planning-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['assumptions', 'architecture', 'file-plan', 'done']);
  expect(planCalls).toBe(2);
  const filePlanPrompts = prompts.filter(prompt => prompt.includes('Stage: file-plan.'));
  expect(filePlanPrompts[0]).toContain('"architectureReferencePaths":["backend/source.ts","deploy/local-compose.md"]');
  expect(filePlanPrompts[0]).toContain('every exact path in architectureReferencePaths');
  expect(filePlanPrompts[0]).toContain('target at most 12 total files');
  expect(filePlanPrompts[0]).toContain('never omit a required file solely to hit the 12-file target');
  expect(filePlanPrompts[1]).toContain('missing-reference-target "deploy/local-compose.md"');
  expect(filePlanPrompts[1]).toContain('add this exact file path to the plan, or remove its reference');
  const output = parsedOutput(state.nodes.find(node => node.nodeId === 'file-plan')?.output);
  expect(output.result?.planningComplete).toBe(true);
  expect((output.result?.plan as Array<{ path: string }>).some(item => item.path === 'deploy/local-compose.md')).toBe(true);
});

test('planning requires a strategy and refuses a file plan omitting its selected test file', async () => {
  const noStrategy = { ...architecture, testStrategy: undefined };
  let calls = 0;
  const registry = createSourcePlanningRegistry({ callLLM: async prompt => {
    if (prompt.includes('Stage: architecture.')) { calls++; return model(noStrategy); }
    return model(valueFor(prompt));
  } });
  const state = await runGraph(graph, { input: { ask: 'Create an app', seedRequested: true },
    verifiedOwnerId: 'synthetic-owner', quiet: true, deps: { root: root(), capabilityProviders: registry } });
  expect(state.path).not.toContain('file-plan');
  expect(calls).toBe(APP_BUILD_MAX_REPAIRS + 1);
  const missing = createSourcePlanningRegistry({ callLLM: async prompt => model(prompt.includes('Stage: file-plan.')
    ? { plan: plan.plan.map(file => file.role === 'test' ? { ...file, path: 'test/other.test.ts' } : file) } : valueFor(prompt)) });
  const absent = await runGraph(graph, { input: { ask: 'Create an app', seedRequested: true },
    verifiedOwnerId: 'synthetic-owner', quiet: true, deps: { root: root(), capabilityProviders: missing } });
  expect(absent.status).not.toBe('done');
});
