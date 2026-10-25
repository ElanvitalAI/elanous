import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';
import { STAGE_GIT_IDENTITY, STAGE_LOCALE, codePoints, gitStageIdentity, hasGlobalGitIdentity, initGitWithExplicitIdentity, stageHasCommand,
  withLinuxEnv } from '../testing/linux-env.js';
import { compareCodePoints, compareVersionish, execPlanPrompt, installedGraphs, installedPluginGraphs, latestFieldFolder, planExecRequest,
  seatTitles } from './planner.js';
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

// LINUX-STAGE ① 이모지·로케일 — 사진 시각이 같은 두 현장 폴더의 승자는 «코드포인트» 최대여야 한다.
// `localeCompare` 는 ICU 콜레이션을 쓰므로 '🎉party' 와 '2026-10-23' 의 대소가 로케일·플랫폼마다 뒤집힌다.
test('equal-mtime field folders settle on the code-point winner, not the locale collation', async () => {
  const root = rootOf();
  const dated = join(root, 'field', '2026-10-23');
  const party = join(root, 'field', '🎉party');
  mkdirSync(dated, { recursive: true });
  mkdirSync(party);
  writeFileSync(join(dated, 'a.jpg'), 'dated');
  writeFileSync(join(party, 'b.png'), 'party');
  for (const photo of [join(dated, 'a.jpg'), join(party, 'b.png')]) utimesSync(photo, new Date(3000), new Date(3000));
  // 이모지는 코드포인트로 센다 — '🎉party'.length 는 7(UTF-16)이지만 코드포인트는 6이다.
  expect(codePoints('🎉party')).toEqual(['🎉', 'p', 'a', 'r', 't', 'y']);
  expect(compareCodePoints(party, dated)).toBe(1);
  expect(latestFieldFolder(root)).toBe(party);
});

// LINUX-STAGE ② 콜레이션 — 플러그인 버전 선택은 «숫자는 수치로, 나머지는 코드포인트로» 여야 한다.
test('plugin versions order by numbers then code points — the collation never picks the build', () => {
  const install = (plugins: string, version: string, name: string): void => {
    const graphs = join(plugins, 'official', 'card-followup', version, 'graphs');
    mkdirSync(graphs, { recursive: true });
    writeFileSync(join(graphs, 'recipes.yaml'), '{}');
    writeFileSync(join(graphs, 'card-followup.yaml'), 'graph_id: card-followup\n');
    writeFileSync(join(dirname(graphs), 'plugin.json'), JSON.stringify({ name, description: 'Photo follow-up' }));
  };
  const root = rootOf();
  const tagged = join(root, 'tagged');
  install(tagged, '1.0.0-Zebra', 'Zebra build');
  install(tagged, '1.0.0-alpha', 'alpha build');
  expect(compareVersionish('1.0.0-alpha', '1.0.0-Zebra')).toBe(1);
  expect(installedPluginGraphs(tagged).graphs.find(graph => graph.id === 'card-followup')?.title).toBe('alpha build');
  // 보존 — 숫자 구간은 수치로 비교한다(1.0.10 이 1.0.9 보다 새 버전).
  const numeric = join(root, 'numeric');
  install(numeric, '1.0.9', 'build 1.0.9');
  install(numeric, '1.0.10', 'build 1.0.10');
  expect(installedPluginGraphs(numeric).graphs.find(graph => graph.id === 'card-followup')?.title).toBe('build 1.0.10');
});

// LINUX-STAGE ③ 환경 무대 — 기본 인자(grok · 글로벌 git 신원 · HOME · 로케일에 기대는 자리)를 그대로 지나도 계획이 선다.
test('planner defaults plan inside the isolated Linux stage: no grok, no global git identity, C.UTF-8', async () => {
  await withLinuxEnv(async (stage) => {
    expect(STAGE_LOCALE).toBe('C.UTF-8');
    expect(stageHasCommand(stage, 'grok')).toBe(false);
    expect(hasGlobalGitIdentity(stage)).toBe(false);
    initGitWithExplicitIdentity(stage);
    expect(gitStageIdentity(stage)).toEqual(STAGE_GIT_IDENTITY);
    const seats = seatTitles();
    expect(seats.length).toBeGreaterThan(0);
    const plans = await planExecRequest('현장 사진으로 피드 정리 🎉', {
      judge: async (text, graphs, gotSeats, attachments, fieldFolder) => {
        expect(gotSeats).toEqual(seats);
        expect(attachments).toEqual([]);
        // 격리 state 에는 field 폴더가 없다 — 개발 머신의 현장 폴더가 새어 들어오면 안 된다.
        expect(fieldFolder).toBeNull();
        expect(graphs.map(graph => graph.id)).toContain('field-feed');
        expect(text).toContain('🎉');
        return [{ seat: gotSeats[0]!, title: '현장 피드', graphId: 'field-feed', inputs: {} }];
      },
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.graphId).toBe('field-feed');
    expect(plans[0]!.output).toBeDefined();
    expect(plans[0]!.reason).toBeUndefined();
  });
});

// LINUX-STAGE ④ 배선 — 고친 규칙이 «생산 기본값» 을 그대로 지나 judge 에 닿는지(직접 호출이 아니라 입구를 지난다).
test('planExecRequest default fieldFolder hands the code-point winner to the judge', async () => {
  await withLinuxEnv(async (stage) => {
    const dated = join(stage.state, 'field', '2026-10-23');
    const party = join(stage.state, 'field', '🎉party');
    mkdirSync(dated, { recursive: true });
    mkdirSync(party);
    writeFileSync(join(dated, 'a.jpg'), 'dated');
    writeFileSync(join(party, 'b.png'), 'party');
    for (const photo of [join(dated, 'a.jpg'), join(party, 'b.png')]) utimesSync(photo, new Date(4000), new Date(4000));
    let seen: string | null | undefined;
    await planExecRequest('현장 사진으로 피드 정리', {
      judge: async (_text, _graphs, gotSeats, _attachments, fieldFolder) => {
        seen = fieldFolder;
        return [{ seat: gotSeats[0]!, title: '현장 피드', graphId: 'field-feed', inputs: {} }];
      },
    });
    expect(seen).toBe(party);
  });
});
