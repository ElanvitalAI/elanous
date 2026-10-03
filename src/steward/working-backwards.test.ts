import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../task-cards/card-store.js';
import { authorIntakeGoals } from '../intake-plane/author-goals.js';
import { runIntakeCheck } from '../intake-plane/check.js';
import { classifyIssue, installedCapabilities, type StewardAsk } from './triage-plan.js';
import { runStewardStage, scheduleTriage, type StewardDeps, type TriageIssue } from './triage.js';
import { readLaunchLedger } from './launch.js';
import { recordWorkingBackwardsOnCards } from './working-backwards.js';

const signal = '판정 신호: 조건 = 사용자가 새 명령을 입력한다; 관측 = 제안된 화면을 본다; 기대 = 처리 결과가 나타난다.';
const prfaq = `## ① 한 줄\nElanous proposes a new workflow.\n부제: 사용자에게\n## ② 문제\n사용자는 새 결과가 필요하다.\n## ③ 해결\n새 명령으로 결과를 본다.\n## ④ 대표의 말\n대표 확인 대기\n## ⑤ 시작하기\n구현 전 가설\n## ⑥ 고객 FAQ\n| 질문 | 답 | 근거 |\n|---|---|---|\n| 누가 쓰나? | 사용자 | 소원 |\n| 왜 쓰나? | 새 결과 | 소원 |\n| 무엇을 얻나? | 화면 | 초안 |\n## ⑦ 내부 FAQ\n| 질문 | 답 |\n|---|---|\n| 왜 지금? | 소원 |\n## ⑧ 판정 기준\n- ${signal}\n`;
const manual = '구현 전 가설: 사용자가 칠 명령 `elanous new-action` · 보게 될 화면: 결과 화면 (제안).';

test('new-capability drafts precede launch, quote the card signal in the goal; installed capability does not draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-working-backwards-'));
  const issues: TriageIssue[] = [
    { identifier: 'ELA-501', ref: 'a', title: 'new-action outcome', body: '새로운 흐름을 원한다' },
    { identifier: 'ELA-502', ref: 'b', title: '기존 steward 그래프 실행', body: '설치된 그래프로 처리' },
  ];
  const inventory = { graphs: ['steward'], plugins: [], commands: ['help'] };
  const ask: StewardAsk = async (prompt, role) => {
    if (role === 'planning' && prompt.includes('워킹 백워드')) return { prfaq, manual, signals: [signal] };
    if (role === 'classify') return prompt.includes('ELA-501')
      ? { rung: 4, why: '새 흐름 구현', capability: 'new-capability' }
      : { rung: 2, why: '이미 있는 그래프', capability: 'existing-capability' };
    return { plans: issues.map((issue, index) => ({ issue: issue.identifier, priority: index, dependsOn: [], owner: null })) };
  };
  try {
    expect((await classifyIssue(issues[1]!, async prompt => {
      expect(prompt).toContain('"steward"');
      return { rung: 2, why: '이미 있는 그래프', capability: 'existing-capability' };
    }, inventory)).rung).toBe(2);
    mkdirSync(join(root, 'steward'), { recursive: true });
    writeFileSync(join(root, 'steward', 'issues.json'), JSON.stringify(issues));
    const stage: StewardDeps = { root, getSecret: async () => 'test-key', ask, decide: () => true,
      fetch: Object.assign(async () => new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 }), { preconnect: () => {} }) };
    await runStewardStage('triage', stage);
    await runStewardStage('schedule', stage);
    const rows = JSON.parse(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8')) as ReturnType<typeof scheduleTriage>;
    expect(rows.map(row => [row.rung, row.capability])).toEqual([[4, 'new-capability'], [2, 'existing-capability']]);
    await runStewardStage('report', { ...stage, sendDigest: async () => {} });
    const store = new CardStore(root);
    try {
      // The schedule stage already recorded the (shadow) launch — after the drafts.
      const card = store.listCards().find(row => row.goalId === 'linear:ELA-501')!;
      expect(card.sections.map(section => section.key.split(':')[0])).toEqual(['intake', 'triage', 'prfaq', 'manual', 'launch']);
      const promise = card.sections.find(section => section.key.startsWith('prfaq:'))!;
      expect(promise.content).toContain('부제: 사용자에게');
      expect(promise.content).toContain('## ② 문제');
      expect(promise.content).toContain('## ③ 해결');
      expect(promise.content.split('⑥ 고객 FAQ')[1]!.split('⑦ 내부 FAQ')[0]!.match(/^\|[^|]+\?\s*\|[^|]+\|/gm)).toHaveLength(3);
      expect(card.sections.find(section => section.key.startsWith('manual:'))!.content).toContain('elanous new-action');
      const existing = store.listCards().find(row => row.goalId === 'linear:ELA-502')!;
      expect(existing.sections.filter(section => section.key.startsWith('prfaq:'))).toHaveLength(0);
      expect(existing.sections.filter(section => section.key.startsWith('manual:'))).toHaveLength(0);
      const goal = 'docs/goals/ASK-new-action.md';
      mkdirSync(join(root, 'docs/goals'), { recursive: true });
      const checked = runIntakeCheck([{
        text: '사용자가 `new-action`으로 처리 결과를 확인한다', sourceRef: 'linear:ELA-501',
      }], {
        root, readFile: path => readFileSync(path, 'utf8'), commit: () => 'test',
        comparer: () => ({ verdict: '없음', current: '미구현', evidence: [], patterns: [], failures: [] }),
        draftDir: join(root, 'drafts'), log: () => {},
      }, { ruler: { capabilities: [], surfaces: [], promises: [], failures: [] } });
      expect(checked.items[0]!.fact).not.toBe(issues[0]!.title);
      expect(checked.items[0]!.sourceRef).toBe('linear:ELA-501');
      const outcomes = await authorIntakeGoals(checked.items, {
        root, listGoalDocs: () => [], lintErrors: () => 0,
        author: async prompt => {
          expect(prompt).toContain(signal);
          const document = '# 새 골\n## 판정 신호\n\n## 경계\n구현 전\n';
          writeFileSync(join(root, goal), document);
          return { path: goal, document };
        },
      }, { source: 'steward' });
      expect(outcomes[0]?.status).toBe('authored');
      const written = readFileSync(join(root, goal), 'utf8');
      const decisionSection = written.split('## 판정 신호')[1]!.split('## 경계')[0]!;
      expect(decisionSection).toContain(signal);
      expect(decisionSection).toContain(`출처: 카드 linear:ELA-501 / ${promise.key}`);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing capability verdict proceeds without a draft (triage is not blocked)', async () => {
  const issue: TriageIssue = { identifier: 'ELA-503', ref: 'c', title: 'new-action', body: '새 능력 소원' };
  const row = await classifyIssue(issue, async () => ({ rung: 4, why: 'work' }), { graphs: [], plugins: [], commands: [] });
  expect(row).toMatchObject({ issue: 'ELA-503', rung: 4, why: 'work' });
  expect(row.capability).toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), 'steward-missing-verdict-'));
  const store = new CardStore(root);
  try {
    await recordWorkingBackwardsOnCards([{
      issue: issue.identifier, rung: 4, why: 'work', dependsOn: [], priority: 0, disposition: 'now',
    }], [issue], store, async () => { throw new Error('must not draft'); });
    expect(store.listCards()).toHaveLength(0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a draft that is not JSON stops the steward report like any invalid draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-nonjson-draft-'));
  const issue: TriageIssue = { identifier: 'ELA-505', ref: 'e', title: 'new-action request', body: '새 명령 소원' };
  mkdirSync(join(root, 'steward'), { recursive: true });
  writeFileSync(join(root, 'steward', 'issues.json'), JSON.stringify([issue]));
  writeFileSync(join(root, 'steward', 'schedule.json'), JSON.stringify([{
    issue: issue.identifier, rung: 4, why: 'new', capability: 'new-capability',
    priority: 0, dependsOn: [], disposition: 'now',
  }]));
  let comments = 0;
  try {
    await expect(runStewardStage('report', {
      root, getSecret: async () => 'test-key', ask: async () => 'not json at all',
      fetch: Object.assign(async () => { comments++; return new Response('{}'); }, { preconnect: () => {} }),
      sendDigest: async () => {}, warn: () => {},
    })).rejects.toThrow('Invalid working-backwards draft');
    expect(comments).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('steward report cannot advance a new-capability when its draft is invalid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-invalid-draft-'));
  const issue: TriageIssue = { identifier: 'ELA-504', ref: 'd', title: 'new-action request', body: '새 명령 소원' };
  mkdirSync(join(root, 'steward'), { recursive: true });
  writeFileSync(join(root, 'steward', 'issues.json'), JSON.stringify([issue]));
  writeFileSync(join(root, 'steward', 'schedule.json'), JSON.stringify([{
    issue: issue.identifier, rung: 4, why: 'new', capability: 'new-capability',
    priority: 0, dependsOn: [], disposition: 'now',
  }]));
  let comments = 0;
  try {
    await expect(runStewardStage('report', {
      root, getSecret: async () => 'test-key', ask: async () => ({ prfaq: 'invalid', manual, signals: [signal] }),
      fetch: Object.assign(async () => { comments++; return new Response('{}'); }, { preconnect: () => {} }),
      sendDigest: async () => {}, warn: () => {},
    })).rejects.toThrow('Invalid working-backwards draft');
    expect(comments).toBe(0);
    const store = new CardStore(root);
    try { expect(store.listCards()[0]?.sections.some(section => section.key.startsWith('prfaq:'))).toBe(false); }
    finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed inventory reads graph ids and plugin names from the installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-inventory-'));
  try {
    mkdirSync(join(root, 'graphs')); mkdirSync(join(root, 'plugins', 'example'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'elanous.mjs'), 'console.log("  present-command  existing command\\n  --flag           option");');
    writeFileSync(join(root, 'graphs', 'present.yaml'), 'graph_id: installed-graph\n');
    const inventory = installedCapabilities(root);
    expect(inventory.graphs).toContain('installed-graph');
    expect(inventory.plugins).toContain('example');
    expect(inventory.commands).toEqual(['present-command']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one invalid draft sends only that wish to hitl; the other wish and the ordinary row still launch (shadow)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-draft-one-bad-'));
  const issues: TriageIssue[] = [
    { identifier: 'ELA-510', ref: 'a', title: 'new-action good', body: '새 흐름 A' },
    { identifier: 'ELA-511', ref: 'b', title: 'new-action bad', body: '새 흐름 B' },
    { identifier: 'ELA-512', ref: 'c', title: '기존 그래프 실행', body: '설치된 그래프' },
  ];
  const ask: StewardAsk = async (prompt, role) => {
    if (role === 'planning' && prompt.includes('워킹 백워드')) return prompt.includes('ELA-511') ? 'not json' : { prfaq, manual, signals: [signal] };
    if (role === 'classify') return prompt.includes('ELA-512')
      ? { rung: 4, why: '기존 그래프', capability: 'existing-capability' }
      : { rung: 4, why: '새 흐름 구현', capability: 'new-capability' };
    return { plans: issues.map((issue, index) => ({ issue: issue.identifier, priority: index, dependsOn: [], owner: null })) };
  };
  try {
    mkdirSync(join(root, 'steward'), { recursive: true });
    writeFileSync(join(root, 'steward', 'issues.json'), JSON.stringify(issues));
    const stage: StewardDeps = { root, getSecret: async () => 'test-key', ask, decide: () => true,
      fetch: Object.assign(async () => new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 }), { preconnect: () => {} }) };
    await runStewardStage('triage', stage);
    await runStewardStage('schedule', stage);
    const rows = JSON.parse(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8')) as ReturnType<typeof scheduleTriage>;
    expect(rows.find(row => row.issue === 'ELA-511')).toMatchObject({ rung: 'hitl', disposition: 'hitl', why: 'working-backwards draft invalid' });
    const ledger = readLaunchLedger(root);
    expect(Object.keys(ledger.launches).sort()).toEqual(['ELA-510', 'ELA-512']);
    expect(ledger.hitl['ELA-511']).toBeDefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
