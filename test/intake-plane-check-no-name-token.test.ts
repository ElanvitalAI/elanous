import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  GAP_VERDICTS,
  intakeCheckReportJson,
  renderIntakeCheckReport,
  runIntakeCheck,
  runIntakeCheckDocument,
  type IntakeCheckDeps,
} from '../src/intake-plane/check.js';
import { buildIntakeDocumentStageCallables } from '../src/intake-plane/runtime-callables.js';
import { createIntakeFakeRepo } from './helpers/intake-fake-repo.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(over: Partial<IntakeCheckDeps> = {}): IntakeCheckDeps {
  return { ...createIntakeFakeRepo(dirs, 'intake-no-name-'), listFiles: () => [], ...over };
}

const unnamed = 'elanous 는 목표 수행 중 정보가 모자라면 사용자에게 질문한다';
const missingName = ['missing', 'feature', 'q7x9'].join('-');
const named = `elanous 는 \`${missingName}\` 를 지원한다`;

test('unnamed --fact cannot search the whole sentence or write a gap draft', () => {
  let probes = 0;
  const deps = fixture({ listFiles: () => { probes++; return []; } });
  const report = runIntakeCheck([{ text: unnamed }], deps);
  const item = report.items[0]!;
  expect(item.verdict).toBe('판단 필요');
  expect(item.current).toContain('잴 이름이 없다');
  expect(item.line).toContain('잴 이름이 없다');
  expect(item.patterns).toEqual([]);
  expect(probes).toBe(0);
  expect(report.goalDraftPaths).toEqual([]);
  expect(item.goalDraftPath).toBeUndefined();
  expect(intakeCheckReportJson(report).goalDraftPaths).toEqual([]);
  expect(existsSync(deps.draftDir!)).toBe(false);
});

test('a named absent fact remains 없음 and writes only its gap draft', () => {
  const deps = fixture();
  const report = runIntakeCheck([{ text: named }], deps);
  expect(GAP_VERDICTS).toEqual(['없음']);
  expect(report.items[0]?.verdict).toBe('없음');
  expect(report.items[0]?.patterns).toContain(`rg -F -e ${missingName}`);
  expect(report.goalDraftPaths).toHaveLength(1);
  expect(report.items[0]?.goalDraftPath).toBe(report.goalDraftPaths[0]);
  expect(readFileSync(report.goalDraftPaths[0]!, 'utf8')).toContain('- 판정: 없음');
});

test('mixed synchronous and asynchronous document preprocessing preserves unnamed claims without false drafts', async () => {
  const output = JSON.stringify({
    claims: [
      { text: unnamed, quote: '인용 하나', lens: 'L3 하니스 운영' },
      { text: named, quote: '인용 둘', lens: 'L1 능력' },
    ],
    discards: [{ quote: '다른 인용', reason: '대조할 사실이 아님' }],
  });
  for (const asyncCaller of [false, true]) {
    const deps = fixture({ preprocess: asyncCaller ? async () => output : () => output });
    const report = asyncCaller
      ? await runIntakeCheckDocument([], deps, { document: '원문' })
      : runIntakeCheck([], deps, { document: '원문' });
    expect(report.keptClaims).toBe(2);
    expect(report.unnamedClaims).toBe(1);
    expect(intakeCheckReportJson(report).unnamedClaims).toBe(1);
    expect(renderIntakeCheckReport(report)).toContain('unnamedClaims: 1');
    expect(report.discardedFacts).toBe(1);
    expect(report.discards?.[0]?.reason).toBe('대조할 사실이 아님');
    expect(report.items.map((item) => item.verdict)).toEqual(['판단 필요', '없음']);
    expect(report.items[0]?.current).toContain('잴 이름이 없다');
    expect(report.items[0]?.quotes[0]).toContain('인용 하나');
    expect(report.items[0]?.goalDraftPath).toBeUndefined();
    expect(report.goalDraftPaths).toHaveLength(1);
    expect(report.goalDraftPaths[0]).toBe(report.items[1]!.goalDraftPath!);
  }
});

test('production preprocess prompt requires a backticked searchable name for every claim', async () => {
  let prompt = '';
  const stages = buildIntakeDocumentStageCallables({
    resolveRoleProvider: () => ({ provider: { name: 'fixture' } }),
    streamLLM: async (messages) => {
      prompt = messages[0]?.content ?? '';
      return JSON.stringify({ claims: [], discards: [{ quote: 'q', reason: 'r' }] });
    },
  });
  await stages.preprocess({ document: '문서', lenses: ['L1 능력'] });
  expect(prompt).toMatch(/각 주장마다.*저장소.*검색할 수 있는.*이름.*반드시 백틱\(`이름`\)/);
  expect(prompt).toContain('잴 이름을 특정할 수 없다면 주장을 만들지 말고 discards');
});
