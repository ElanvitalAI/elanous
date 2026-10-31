import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO1104_STAGE_CONFIG } from './demo1104-stage.config.js';
import { createDemo1104ParallelScenes, createDemo1104TuiTabAdapters, createDemoRunGraphSurfaceAdapter, createDemoTelegramDryRunAdapter, DEMO1104_SURFACES, type DemoSurfaceId } from './demo1104-parallel-scenes.js';
import type { TerminalSession } from '../../src/terminal/session-registry.js';
import { appendTopicBriefingTelegramDryRun } from '../../src/intake-plane/actions.js';
import { stringify as stringifyYaml } from 'yaml';

const VIDEO_SOURCES = { V1: 'file:///demo/highlights/V1.mp4', V2: 'file:///demo/highlights/V2.mp4', V3: 'file:///demo/highlights/V3.mp4', V4: 'file:///demo/highlights/V4.mp4', V5: 'file:///demo/highlights/V5.mp4', V6: 'file:///demo/highlights/V6.mp4' };

const adapterSet = (events: string[], fail?: DemoSurfaceId) => Object.fromEntries(DEMO1104_SURFACES.map(surface => [surface.id, {
  async start() { events.push(`start:${surface.id}`); },
  async runAct(act: { id: string }) { events.push(`run:${surface.id}:${act.id}`); if (fail === surface.id) throw new Error('injected scene failure'); },
  async showVideo(video: string, act: { id: string }) { events.push(`video:${surface.id}:${act.id}:${video}`); },
}])) as unknown as Parameters<typeof createDemo1104ParallelScenes>[0];

test('launches both TUI tabs, web graph, and Telegram together and records all surfaces ready', async () => {
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapters = Object.fromEntries(DEMO1104_SURFACES.map(surface => [surface.id, {
    async start() { events.push(`enter:${surface.id}`); await barrier; events.push(`ready:${surface.id}`); },
    async runAct() {}, async showVideo() {},
  }])) as unknown as Parameters<typeof createDemo1104ParallelScenes>[0];
  const stage = createDemo1104ParallelScenes(adapters);
  const starting = stage.start();
  await Bun.sleep(0);
  expect(events.filter(event => event.startsWith('enter:'))).toHaveLength(4);
  expect(events.some(event => event.startsWith('ready:'))).toBe(false);
  release();
  await starting;
  expect(events.filter(event => event.startsWith('ready:'))).toHaveLength(4);
  expect(stage.snapshot().surfaces.map(surface => surface.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
  expect(stage.snapshot().lanes.map(lane => lane.status)).toEqual(['started', 'started']);
});

test('a single surface failure makes the scene transition every surface to its highlight video', async () => {
  const events: string[] = [];
  const stage = createDemo1104ParallelScenes(adapterSet(events, 'web-run-graph'));
  await stage.start();
  await stage.runActNow('act-4');
  expect(events.filter(event => event.startsWith('video:'))).toHaveLength(4);
  expect(stage.snapshot().acts.find(act => act.id === 'act-4')?.status).toBe('video');
  expect(stage.snapshot().transitions[0]).toMatchObject({ actId: 'act-4', videoId: 'V4', trigger: 'failure', status: 'shown' });
});

test('a failing surface aborts sibling work and late results cannot publish after video fallback', async () => {
  const events: string[] = [];
  let siblingSignal: AbortSignal | undefined;
  const adapters = Object.fromEntries(DEMO1104_SURFACES.map(surface => [surface.id, {
    async start() {},
    async runAct(_act: { id: string }, signal: AbortSignal) {
      if (surface.id === 'claude-code-tui') {
        siblingSignal = signal;
        await Bun.sleep(20);
        if (!signal.aborted) events.push('late:TUI');
        else events.push('cleanup:TUI');
        return;
      }
      if (surface.id === 'web-run-graph') throw new Error('graph failed');
    },
    async showVideo(_video: string, act: { id: string }) { events.push(`video:${surface.id}:${act.id}`); },
  }])) as unknown as Parameters<typeof createDemo1104ParallelScenes>[0];
  const stage = createDemo1104ParallelScenes(adapters);
  await stage.start();
  await stage.runActNow('act-3');
  await Bun.sleep(30);
  expect(siblingSignal?.aborted).toBe(true);
  expect(events).not.toContain('late:TUI');
  expect(events).toContain('cleanup:TUI');
  expect(events.filter(event => event.startsWith('video:'))).toHaveLength(4);
  expect(events.indexOf('cleanup:TUI')).toBeLessThan(events.findIndex(event => event.startsWith('video:')));
});

test('terminal adapters spawn two sessions through the existing coding-agent registry seam and drive only research/build scenes', async () => {
  const spawned: string[] = [];
  const ran: string[] = [];
  const fakeSession = (id: string) => ({ id }) as unknown as TerminalSession;
  const adapters = createDemo1104TuiTabAdapters({
    registry: {} as never, cwd: '/demo', termSize: () => ({ cols: 120, rows: 40 }),
    videoSources: VIDEO_SOURCES,
    spawnAgent: ({ brand }) => { spawned.push(brand); return fakeSession(brand); },
    async runMission(session, act) { ran.push(`${session.id}:${act.id}`); },
    async showVideo() {},
  });
  await Promise.all([adapters['claude-code-tui'].start(new AbortController().signal), adapters['codex-tui'].start(new AbortController().signal)]);
  await Promise.all([adapters['claude-code-tui'].runAct(DEMO1104_STAGE_CONFIG.acts[0]!, new AbortController().signal),
    adapters['codex-tui'].runAct(DEMO1104_STAGE_CONFIG.acts[0]!, new AbortController().signal)]);
  await Promise.all([adapters['claude-code-tui'].runAct(DEMO1104_STAGE_CONFIG.acts[2]!, new AbortController().signal),
    adapters['codex-tui'].runAct(DEMO1104_STAGE_CONFIG.acts[2]!, new AbortController().signal)]);
  expect(spawned.sort()).toEqual(['claude-code', 'codex']);
  expect(ran).toEqual(['claude-code:act-2', 'codex:act-2']);
});

test('web screen streams the checked-in editor graph through its run API and Telegram records file-only receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo1104-surfaces-test-'));
  const telegramFile = join(root, 'telegram', 'dry-run.jsonl');
  const telegramStateDir = join(root, 'state');
  const recipesFile = join(root, 'editor-recipes.yaml');
  writeFileSync(recipesFile, stringifyYaml(Object.fromEntries(['plan', 'build', 'review', 'publish', 'done'].map(name => [name,
    { command: `printf '{"outcome":"ok"}\\n'`, timeout_ms: 1_000 }]))));
  const graphYaml = readFileSync(join(import.meta.dir, '../../graphs/demo/inside-seed.yaml'), 'utf8');
  const views: Array<{ runId: string; status: string; path: string[] }> = [];
  const videoTransitions: string[] = [];
  const web = createDemoRunGraphSurfaceAdapter({ graphId: 'inside-seed', graphYaml, recipesFile,
    videoSources: VIDEO_SOURCES,
    onView: (view) => views.push(view), onVideo: (transition) => { videoTransitions.push(`${transition.videoId}:${transition.source}`); } });
  const telegram = createDemoTelegramDryRunAdapter({ file: telegramFile, stateDir: telegramStateDir, linearIssueId: 'demo-issue-1', videoSources: VIDEO_SOURCES });
  const events: string[] = [];
  const stage = createDemo1104ParallelScenes({
    ...adapterSet(events),
    'web-run-graph': web,
    telegram,
  });
  try {
    await stage.start();
    await stage.runActNow('act-1');
    expect(views.some(view => view.status === 'done' && view.path.join(',') === 'plan,build,review,publish,done')).toBe(true);
    expect(existsSync(telegramFile)).toBe(true);
    const rows = readFileSync(telegramFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; text: string });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'issue' });
    expect(rows[0]!.text).toContain('아침 브리핑');
    const receipts = JSON.parse(readFileSync(join(telegramStateDir, 'intake', 'topic-briefing-deliveries.json'), 'utf8')) as Record<string, { telegramSent: boolean; linearCommented: boolean }>;
    expect(Object.values(receipts)).toEqual([expect.objectContaining({ telegramSent: true, linearCommented: true })]);
    await web.showVideo('V1', DEMO1104_STAGE_CONFIG.acts[1]!, new AbortController().signal);
    expect(videoTransitions).toEqual(['V1:file:///demo/highlights/V1.mp4']);
    await telegram.runAct(DEMO1104_STAGE_CONFIG.acts[1]!, new AbortController().signal);
    expect(readFileSync(telegramFile, 'utf8').trim().split('\n')).toHaveLength(1);
    await telegram.showVideo('V1', DEMO1104_STAGE_CONFIG.acts[1]!, new AbortController().signal);
    expect(JSON.parse(readFileSync(telegramFile, 'utf8').trim().split('\n')[1]!)).toMatchObject({ kind: 'video', videoId: 'V1', source: 'file:///demo/highlights/V1.mp4', actId: 'act-1' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(telegram.runAct(DEMO1104_STAGE_CONFIG.acts[1]!, aborted.signal)).rejects.toThrow('Telegram dry-run superseded');
    expect(readFileSync(telegramFile, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(stage.snapshot().acts.find(act => act.id === 'act-1')?.status).toBe('live');
  } finally {
    web.close();
    telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph adapter does not finish cancellation until its active editor command has stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo1104-graph-cancel-test-'));
  const marker = join(root, 'late-command-output');
  const recipesFile = join(root, 'editor-recipes.yaml');
  const command = `sleep 0.2; touch '${marker}'`;
  writeFileSync(recipesFile, stringifyYaml(Object.fromEntries(['plan', 'build', 'review', 'publish', 'done'].map(name => [name,
    { command, timeout_ms: 2_000 }]))));
  const graphYaml = readFileSync(join(import.meta.dir, '../../graphs/demo/inside-seed.yaml'), 'utf8');
  const controller = new AbortController();
  let abortScheduled = false;
  const adapter = createDemoRunGraphSurfaceAdapter({ graphId: 'inside-seed', graphYaml, recipesFile, videoSources: VIDEO_SOURCES,
    onView(view) {
      if (!abortScheduled && view.currentNode) {
        abortScheduled = true;
        setTimeout(() => controller.abort(), 20);
      }
    }, onVideo() {} });
  try {
    await expect(adapter.runAct(DEMO1104_STAGE_CONFIG.acts[0]!, controller.signal)).rejects.toThrow('graph screen run aborted');
    expect(abortScheduled).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally { adapter.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Telegram adapter receipt is retryable after failure and prevents duplicate file-only delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo1104-telegram-retry-test-'));
  const telegramFile = join(root, 'telegram', 'dry-run.jsonl');
  const stateDir = join(root, 'state');
  const issueId = 'demo-issue-retry';
  let failFirstSend = true;
  const adapter = createDemoTelegramDryRunAdapter({ file: telegramFile, stateDir, linearIssueId: issueId, videoSources: VIDEO_SOURCES, appendDryRun(file, input) {
      if (failFirstSend) { failFirstSend = false; throw new Error('file system unavailable'); }
      appendTopicBriefingTelegramDryRun(file, input);
    } });
  try {
    const act = DEMO1104_STAGE_CONFIG.acts[1]!;
    const signal = new AbortController().signal;
    await expect(adapter.runAct(act, signal)).rejects.toThrow('file system unavailable');
    expect(existsSync(join(stateDir, 'intake', 'topic-briefing-deliveries.json'))).toBe(false);
    await adapter.runAct(act, signal);
    await adapter.runAct(act, signal);
    const rows = readFileSync(telegramFile, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(stateDir, 'intake', 'topic-briefing-deliveries.json'), 'utf8')) as Record<string, { telegramSent: boolean }>;
    expect(Object.values(receipt)).toEqual([expect.objectContaining({ telegramSent: true })]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
