import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';
import { execPlanPrompt, installedGraphs, latestFieldFolder, planExecRequest } from './planner.js';
import { OUTPUT_KINDS } from './default-outputs.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const rootOf = () => { const root = mkdtempSync(join(tmpdir(), 'exec-planner-')); roots.push(root); return root; };

test('only opted-in runnable core graphs (including subdirectories) appear, while mine remains available', async () => {
  const root = rootOf();
  const mine = join(root, 'graphs');
  mkdirSync(mine);
  writeFileSync(join(mine, 'recipes.yaml'), '{}');
  writeFileSync(join(mine, 'mine.yaml'), 'graph_id: mine\nloop:\n  title: 내 그래프\n');
  const plugin = join(root, 'plugins', 'official', 'card-followup', '1.0.0');
  mkdirSync(join(plugin, 'graphs'), { recursive: true });
  mkdirSync(join(plugin, 'examples'));
  writeFileSync(join(plugin, 'graphs', 'recipes.yaml'), '{}');
  writeFileSync(join(plugin, 'graphs', 'card-followup.yaml'), 'graph_id: card-followup\n');
  writeFileSync(join(plugin, 'plugin.json'), '{"name":"Card","description":"Photo follow-up"}');
  writeFileSync(join(plugin, 'examples', 'card.json'), '{"image":"sample.jpg"}');
  const graphs = await installedGraphs(defaultGraphsDir(), mine);
  expect(graphs.find(g => g.id === 'field-feed')).toMatchObject({ inputKeys: ['folder'], path: join(defaultGraphsDir(), 'field', 'field-feed.yaml') });
  expect(graphs.map(g => g.id)).toContain('mine');
  expect(graphs.find(g => g.id === 'card-followup')?.inputKeys).toEqual(['image']);
  // Release, steward, heal and harness graphs must never be assignable from a plain request.
  for (const id of ['release-loop', 'steward', 'heal-loop', 'landing-heal', 'nightly-audit', 'self-implement', 'implement-loop', 'plan-loop', 'launch-loop', 'test-diet', 'intake-daily', 'docs-publish'])
    expect(graphs.map(g => g.id)).not.toContain(id);
  const coreIds = graphs.filter(g => g.path.startsWith(defaultGraphsDir())).map(g => g.id);
  expect(coreIds.sort()).toEqual(['field-feed', 'lecture-note', 'youtube-summary']);
  expect(graphs.find(g => g.id === 'youtube-summary')).toMatchObject({
    path: join(defaultGraphsDir(), 'video', 'youtube-summary.yaml'), inputKeys: ['url', 'format'],
  });
  const core = join(root, 'core');
  mkdirSync(core);
  writeFileSync(join(core, 'no.yaml'), 'graph_id: no\nloop:\n  exec_request: false\n');
  expect((await installedGraphs(core, mine)).map(g => g.id)).toEqual(['mine', 'card-followup']);
  writeFileSync(join(core, 'yes.yaml'), 'graph_id: yes\nloop:\n  exec_request: true\n  inputs: [file]\n');
  expect((await installedGraphs(core, mine)).find(g => g.id === 'yes')).toMatchObject({ inputKeys: ['file'], path: join(core, 'yes.yaml') });
});

test('attachments and newest photo-bearing field folder reach the judge and image/folder inputs', async () => {
  const root = rootOf();
  const old = join(root, 'field', 'old');
  const current = join(root, 'field', 'current');
  mkdirSync(old, { recursive: true }); mkdirSync(current);
  writeFileSync(join(old, 'a.jpg'), 'old');
  writeFileSync(join(current, 'a.png'), 'new');
  utimesSync(join(old, 'a.jpg'), new Date(1000), new Date(1000));
  utimesSync(join(current, 'a.png'), new Date(2000), new Date(2000));
  expect(latestFieldFolder(root)).toBe(current);
  const empty = rootOf();
  mkdirSync(join(empty, 'field', 'no-photos'), { recursive: true });
  expect(latestFieldFolder(empty)).toBeNull();
  expect(execPlanPrompt('질문', [], ['CMO'], [], null)).not.toContain('알려진 값: 오늘 현장 폴더');
  const photo = join(root, 'uploads', 'card.jpg');
  const graphs = [{ id: 'card-followup', title: 'Card', description: '', path: '/card.yaml', inputKeys: ['image'] },
    { id: 'field-feed', title: 'Feed', description: '', path: '/feed.yaml', inputKeys: ['folder'] }];
  const attachments = [{ name: 'card.jpg', path: photo }];
  const prompt = execPlanPrompt('명함 초안', graphs, ['CMO'], attachments, current);
  expect(prompt).toContain(`첨부: card.jpg (이미지) — ${photo}`);
  expect(prompt).toContain(`알려진 값: 오늘 현장 폴더 = ${current}`);
  const plan = await planExecRequest('명함 초안', { graphs: async () => graphs, seats: () => ['CMO'], attachments,
    fieldFolder: () => current, judge: async (_text, _graphs, _seats, gotAttachments, gotField) => {
      expect(gotAttachments).toEqual(attachments);
      expect(gotField).toBe(current);
      return [{ seat: 'CMO', title: '명함 초안', graphId: 'card-followup', inputs: {} },
        { seat: 'CMO', title: '피드', graphId: 'field-feed', inputs: {} }];
    } });
  // The attached card photo is an upload, not a photo of that field folder — the feed must not guess the folder (review r1).
  expect(plan.map(p => p.inputs)).toEqual([{ image: photo }, {}]);
  expect(plan[1]!.reason).toContain('folder');
  expect(readFileSync(join(defaultGraphsDir(), 'field', 'field-feed.yaml'), 'utf8')).toContain('exec_request: true');
});

test('field feed does not infer a folder from a photo attached from another event or an unassociated upload', async () => {
  const root = rootOf();
  const old = join(root, 'field', 'old');
  const latest = join(root, 'field', 'latest');
  mkdirSync(old, { recursive: true }); mkdirSync(latest);
  const photo = join(old, 'event.jpg');
  writeFileSync(photo, 'old'); writeFileSync(join(latest, 'event.jpg'), 'latest');
  const graphs = [{ id: 'field-feed', title: 'Feed', description: '', path: '/feed.yaml', inputKeys: ['folder'] }];
  const plan = (path: string, inputs: Record<string, unknown> = {}) => planExecRequest('사진으로 피드', {
    graphs: async () => graphs, seats: () => ['CMO'], attachments: [{ name: 'event.jpg', path }],
    fieldFolder: () => latest, judge: async () => [{ seat: 'CMO', title: '현장 피드', graphId: 'field-feed', inputs }],
  });
  const mismatch = (await plan(photo))[0]!;
  expect(mismatch.inputs.folder).toBeUndefined();
  expect(mismatch.reason).toContain('folder');
  expect((await plan(photo, { folder: latest }))[0]!.reason).toContain('folder');
  expect((await plan(photo, { folder: old }))[0]!.reason).toBeUndefined();
  const upload = join(root, 'uploads', 'event.jpg');
  mkdirSync(join(root, 'uploads')); writeFileSync(upload, 'uploaded');
  expect((await plan(upload))[0]!.reason).toContain('folder');
  expect((await plan(join(latest, 'event.jpg')))[0]!.inputs.folder).toBe(latest);
});

test('missing and unknown model outputs are filled for graph and seat-answer rows', async () => {
  const graphs = [{ id: 'demo', title: 'Demo', description: '', path: '/demo.yaml' }];
  const base = { graphs: async () => graphs, seats: () => ['CMO'], fieldFolder: () => null };
  const rows = [
    { seat: 'CMO', title: '10-08 데모 발표 자료 만들어 줘', graphId: 'demo', inputs: {}, after: [], output: 'weird' },
    { seat: 'CMO', title: '경쟁사 세 곳 비교 조사', graphId: '', inputs: {}, after: [0] },
  ];
  const before = debug.events(500).length;
  const weird = await planExecRequest('자료와 조사', { ...base, judge: async () => rows });
  expect(debug.events(500).slice(before).filter(ev => ev.category === 'exec.plan' && ev.event === 'default-output').map(ev => {
    const data = ev.data as { kind: string; source: string };
    return { kind: data.kind, source: data.source };
  }))
    .toEqual([{ kind: 'slides', source: 'rule' }, { kind: 'research', source: 'rule' }]);
  expect(weird.map(({ output }) => output)).toEqual(['slides', 'research']);
  expect(weird[1]).toMatchObject({ graphId: '', after: [0], reason: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다' });
  expect(weird.every(({ output }) => output !== undefined && Object.hasOwn(OUTPUT_KINDS, output))).toBe(true);

  const missing = await planExecRequest('정리와 질문', { ...base, judge: async () => [
    { seat: 'CMO', title: '이번 주 캠페인 결과 정리해 줘', graphId: 'demo', inputs: {} },
    { seat: 'CMO', title: '설치는 어떻게 해?', graphId: '', inputs: {} },
  ] });
  expect(missing.map(({ output }) => output)).toEqual(['report', 'answer']);
  expect(missing.every(({ output }) => output !== undefined && Object.hasOwn(OUTPUT_KINDS, output))).toBe(true);

  const mixed = await planExecRequest('캠페인 결과 정리 발표 자료 만들어 줘', { ...base, judge: async () => [
    { seat: 'CMO', title: '캠페인 결과 정리 발표 자료 만들어 줘', graphId: 'demo', inputs: {}, output: 'weird' },
    { seat: 'CMO', title: '캠페인 결과 정리 발표 자료 만들어 줘', graphId: '', inputs: {} },
  ] });
  expect(mixed.map(({ output }) => output)).toEqual(['slides', 'slides']);
});

test('model output survives on both graph and seat-answer rows; video needs an installed graph', async () => {
  const graphs = [{ id: 'video-graph', title: 'Video', description: '', path: '/video.yaml' }];
  expect(execPlanPrompt('발표', graphs, ['CMO'], [], null)).toContain('"output":"report|slides|research|post|video|answer"');
  const before = debug.events(500).length;
  const plans = await planExecRequest('영상과 게시글', { graphs: async () => graphs, seats: () => ['CMO'], fieldFolder: () => null,
    judge: async () => [
      { seat: 'CMO', title: '영상', graphId: 'video-graph', inputs: {}, output: 'video' },
      { seat: 'CMO', title: '공지', graphId: '', inputs: {}, output: 'post' },
      { seat: 'CMO', title: '릴스', graphId: '', inputs: {}, output: 'video' },
      { seat: 'CMO', title: '영상', graphId: '', inputs: {} },
    ],
  });
  expect(plans.map(({ output }) => output)).toEqual(['video', 'post', 'report', 'report']);
  expect(debug.events(500).slice(before).filter(ev => ev.category === 'exec.plan' && ev.event === 'default-output').map(ev => {
    const data = ev.data as { kind: string; source: string };
    return { kind: data.kind, source: data.source };
  }))
    .toEqual([
      { kind: 'video', source: 'model' }, { kind: 'post', source: 'model' },
      { kind: 'report', source: 'rule' }, { kind: 'report', source: 'rule' },
    ]);
});
