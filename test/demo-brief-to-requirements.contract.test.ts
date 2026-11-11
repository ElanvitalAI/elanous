import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPlugin } from '../src/plugins/install/plugin-install.js';
import { installedPluginGraphs } from '../src/exec-requests/planner.js';
import { convertBriefToRequirements, type BriefInput, type AbsorbBriefInput } from '../src/graph-runner/briefing-requirements/convert.js';
import { isTicketingArchitecturePrompt } from '../src/graph-runner/scene4-turn-policy.js';
import { simCli } from '../src/ux-sim/in-process-cli.js';

const dir = join(import.meta.dir, '../plugins/demo-brief-to-requirements');
const sample = JSON.parse(readFileSync(join(dir, 'examples/ticketing-brief.json'), 'utf8')) as BriefInput;

test('grounded briefing and accepted suggestion become exactly three traceable lines', () => {
  const receipt = convertBriefToRequirements(sample);
  expect(receipt.lines).toHaveLength(3);
  expect(receipt.sourceScrapIds).toEqual(['scrap-ticketing-article']);
  expect(receipt.lines[1]).toContain('설계 가정');
  expect(receipt.lines[2]).toContain('중복 예매 0건');
  expect(receipt.prompt.split('\n')).toEqual(receipt.lines);
});

test('cross-owner acceptance and missing source evidence fail closed', () => {
  expect(() => convertBriefToRequirements({ ...sample, acceptance: { ...sample.acceptance, owner: 'other' } })).toThrow('same-owner');
  expect(() => convertBriefToRequirements({ ...sample, briefing: { ...sample.briefing, topics: [{ summary: '대기열', sourceScrapIds: [] }] } })).toThrow('source scrap IDs');
});

test('scene 2/3 graph records adapt without fabricated topics, acceptance or article capacity', () => {
  const raw: AbsorbBriefInput = { memberId: 'member-a',
    briefing: { id: 'brief-a', memberId: 'member-a', scrapIds: ['scrap-a'], todos: [], groups: [
      { title: '접속 폭주 시 공정한 대기열', scrapId: 'scrap-a' },
      { title: '같은 좌석 중복 예매 0건과 결제 실패 복구', scrapId: 'scrap-a' },
    ] },
    suggestion: { id: 'suggest-a', appId: 'concert-ticketing', change: '티켓팅 서비스 만들기', evidenceScrapIds: ['scrap-a'] },
    build: { status: 'done', suggestionId: 'suggest-a', memberId: 'member-a' } };
  const receipt = convertBriefToRequirements(raw);
  expect(receipt.lines).toHaveLength(3);
  expect(receipt.sourceScrapIds).toEqual(['scrap-a']);
  expect(receipt.assumptionSource).toBe('scene4-demo-default');
  expect(receipt.lines[1]).toContain('100,000');
  expect(receipt.lines[1]).toContain('원문 기사 수치가 아님');
  expect(receipt.lines[2]).toContain('질문 없이');
  expect(() => convertBriefToRequirements({ ...raw, build: { status: 'failed', suggestionId: 'suggest-a' } })).toThrow('accepted suggestion build');
  expect(() => convertBriefToRequirements({ ...raw, memberId: 'member-b' })).toThrow('same-owner');
  expect(() => convertBriefToRequirements({ ...raw, briefing: { ...raw.briefing, memberId: undefined } })).toThrow('same-owner');
  expect(() => convertBriefToRequirements({ ...raw, build: { ...raw.build, memberId: undefined } })).toThrow('same-owner');
  expect(() => convertBriefToRequirements({ ...raw, suggestion: { ...raw.suggestion, evidenceScrapIds: ['foreign'] } })).toThrow('source scrap IDs');
  const splitEvidence: AbsorbBriefInput = { ...raw,
    briefing: { ...raw.briefing, scrapIds: ['scrap-a', 'scrap-b'], groups: [
      { title: '공정한 대기열', scrapId: 'scrap-a' }, { title: '관계없는 광고 정책', scrapId: 'scrap-b' },
    ] }, suggestion: { ...raw.suggestion, evidenceScrapIds: ['scrap-a'] } };
  expect(convertBriefToRequirements(splitEvidence).lines[2]).not.toContain('광고 정책');
  expect(() => convertBriefToRequirements({ ...splitEvidence,
    suggestion: { ...splitEvidence.suggestion, evidenceScrapIds: ['scrap-b'] },
    briefing: { ...splitEvidence.briefing, groups: [{ title: '공정한 대기열', scrapId: 'scrap-a' }] },
  })).toThrow('suggestion evidence must link');
  const opaqueApp = convertBriefToRequirements({ ...raw, suggestion: { ...raw.suggestion, appId: 'app-123' } });
  expect(opaqueApp.lines[0]).toContain('티켓팅 서비스');
  expect(opaqueApp.lines[0]).not.toContain('app 123');
  const namedApp = convertBriefToRequirements({ ...raw, suggestion: { ...raw.suggestion,
    appId: 'ticketing-service', change: '결제 실패 복구 구현하기' } });
  expect(namedApp.lines[0]).toContain('ticketing service');
  expect(namedApp.lines[0]).toContain('결제 실패 복구');
  expect(isTicketingArchitecturePrompt(namedApp.prompt)).toBe(true);
  const withPoints = convertBriefToRequirements({ ...raw, briefing: { ...raw.briefing,
    groups: [{ summary: '공정한 대기열', points: ['좌석 중복 예매 0건', '결제 실패 복구'], scrapId: 'scrap-a' }],
  } });
  expect(withPoints.lines[2]).toContain('좌석 중복 예매 0건');
  expect(withPoints.lines[2]).toContain('결제 실패 복구');
  expect(isTicketingArchitecturePrompt(withPoints.prompt)).toBe(true);
});

test('installed graph emits a receipt from the briefing sample', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-brief-requirements-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true });
    const catalog = installedPluginGraphs(join(root, 'plugins')).graphs;
    expect(catalog.find(graph => graph.id === 'demo-brief-to-requirements')?.inputKeys).toEqual(['briefPath', 'outDir']);
    expect(catalog.find(graph => graph.id === 'demo-scene4-architecture')?.inputKeys).toContain('prompt');
    const outDir = join(root, 'receipt');
    const input = { briefPath: join(dir, 'examples/ticketing-brief.json'), outDir };
    const run = await simCli(['graph', 'run', join(installed.path, 'graphs/brief-to-requirements.yaml'), '--input', JSON.stringify(input), '--json'],
      { mode: 'spawn', stateRoot: join(root, 'isolation'), cwd: root, allowPaths: [['graph', 'run']], timeoutMs: 30_000 });
    expect({ exit: run.exitCode, stderr: run.stderr.slice(-500) }).toMatchObject({ exit: 0 });
    const text = readFileSync(join(outDir, 'requirements.txt'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(3);
    const receipt = JSON.parse(readFileSync(join(outDir, 'requirements.json'), 'utf8')) as { sourceScrapIds: string[] };
    expect(receipt.sourceScrapIds).toEqual(['scrap-ticketing-article']);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('installed graph consumes scene 2/3 records with a labeled demo capacity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-absorb-records-'));
  try {
    const installed = await installPlugin(dir, { root, yes: true });
    const outDir = join(root, 'receipt');
    const input = { briefPath: join(dir, 'examples/absorb-ticketing-records.json'), outDir };
    const run = await simCli(['graph', 'run', join(installed.path, 'graphs/brief-to-requirements.yaml'),
      '--input', JSON.stringify(input), '--json'], { mode: 'spawn', stateRoot: join(root, 'isolation'), cwd: root,
      allowPaths: [['graph', 'run']] });
    expect(run.exitCode).toBe(0);
    const receipt = JSON.parse(readFileSync(join(outDir, 'requirements.json'), 'utf8')) as { assumptionSource: string; lines: string[] };
    expect(receipt.assumptionSource).toBe('scene4-demo-default');
    expect(receipt.lines).toHaveLength(3);
    expect(receipt.lines[2]).toContain('결제 실패 복구');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
