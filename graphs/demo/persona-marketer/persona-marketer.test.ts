import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph, decideGraphApproval } from '../../../src/graph-runner/runner.js';

const graphPath = resolve(import.meta.dir, 'persona-marketer.yaml');
const fixturePath = resolve(import.meta.dir, 'fixtures/marketer-scenario.yaml');
const fieldFeedPath = resolve(import.meta.dir, '../../field/field-feed.yaml');

type Fixture = {
  persona: { name: string; label: string; brand_tone: string };
  input: { event_photos: Array<{ file: string; aspect: string; subject: string }> };
};

type GraphSpec = {
  graph_id: string;
  entry_node: string;
  terminal_nodes: string[];
  nodes: Array<{ node_id: string; kind: string; recipe?: string; max_visits: number }>;
  edges: Array<{ from: string; on: string; map: Record<string, string> }>;
};

const loadFixture = (): Fixture => parseYaml(readFileSync(fixturePath, 'utf-8')) as Fixture;

test('판정: 장면 끝까지 도달하며 게시 대기 카드로 종결한다(자동 게시 0)', async () => {
  const fixture = loadFixture();
  const root = mkdtempSync(join(tmpdir(), 'persona-marketer-'));
  let brandToneVisits = 0;
  const commands: string[] = [];
  const toneNeedsRewrite = fixture.persona.brand_tone.includes('과장 없는 사실형');
  const fake = async (command: string) => {
    commands.push(command);
    if (command.includes('brand-tone')) {
      brandToneVisits += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ outcome: toneNeedsRewrite && brandToneVisits === 1 ? 'rework' : 'ok', brand_tone: fixture.persona.brand_tone }) + '\n',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }) + '\n', stderr: '' };
  };
  try {
    const first = await runGraph(graphPath, {
      input: { event_photos: fixture.input.event_photos, persona: fixture.persona },
      deps: { root, runBash: fake },
    });
    expect(first.status).toBe('awaiting-approval');
    expect(first.pending?.nodeId).toBe('pre-post-check');
    expect(first.path).toEqual(['event-photos', 'reel', 'feed-text', 'brand-tone', 'feed-text', 'brand-tone', 'pre-post-check']);
    expect(first.pending?.message).toBe('{"kind":"게시 대기","auto_post":0}');
    expect(brandToneVisits).toBe(2);
    expect(commands).toHaveLength(6);
    expect(commands.every((command) => ['event-photos', 'reel', 'feed-text', 'brand-tone'].some((recipe) => command.includes(recipe)))).toBe(true);
    expect(commands.some((command) => /\b(post|publish)\b/i.test(command))).toBe(false);
    decideGraphApproval(first.graphId, first.runId, 'approved', fixture.persona.label, root);
    const done = await runGraph(graphPath, { resumeRunId: first.runId, deps: { root, runBash: fake } });
    expect(done.status).toBe('done');
    expect(done.path).toEqual(['event-photos', 'reel', 'feed-text', 'brand-tone', 'feed-text', 'brand-tone', 'pre-post-check', 'done']);
    expect(done.path.at(-1)).toBe('done');
    const graph = parseYaml(readFileSync(graphPath, 'utf-8')) as GraphSpec;
    expect(graph.nodes.map(({ node_id }) => node_id)).not.toContain('post');
    expect(commands.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('마케터 장면 흐름(RFC §A3 ③): 행사 사진 → 세로 영상·피드 글 → 게시 전 확인(브랜드 톤 루프) → 게시 대기', () => {
  const graph = parseYaml(readFileSync(graphPath, 'utf-8')) as GraphSpec;
  expect(graph.entry_node).toBe('event-photos');
  expect(graph.terminal_nodes).toEqual(['done', 'failed']);
  expect(graph.nodes.map(({ node_id }) => node_id)).toEqual([
    'event-photos',
    'reel',
    'feed-text',
    'brand-tone',
    'pre-post-check',
    'done',
    'failed',
  ]);
  expect(graph.nodes.find(({ node_id }) => node_id === 'pre-post-check')?.recipe).toBe('approval:pre-post-check');
  expect(graph.edges).toContainEqual({ from: 'brand-tone', on: 'outcome', map: { rework: 'feed-text', ok: 'pre-post-check', fail: 'failed', error: 'failed' } });
  expect(graph.edges).toContainEqual({ from: 'feed-text', on: 'outcome', map: { ok: 'brand-tone', rework: 'brand-tone', error: 'failed' } });
});

test('기존 필드 피드 기본 동작 보존 — 독립 마케터 데모가 필드 피드 선언을 바꾸지 않는다', () => {
  const raw = readFileSync(fieldFeedPath, 'utf-8');
  expect(raw).toContain('graph_id: field-feed');
  const fieldFeed = parseYaml(raw) as GraphSpec;
  expect(fieldFeed.graph_id).toBe('field-feed');
  expect(fieldFeed.entry_node).toBe('reel');
  expect(fieldFeed.terminal_nodes).toEqual(['done', 'failed']);
  expect(fieldFeed.nodes.map(({ node_id }) => node_id)).toEqual(['reel', 'feed', 'post', 'deliver', 'done', 'failed']);
  expect(fieldFeed.nodes.find(({ node_id }) => node_id === 'post')?.recipe).toBe('approval:post');
  expect(fieldFeed).not.toHaveProperty('persona_marketer');
});
