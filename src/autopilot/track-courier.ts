import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug, redactSecretText } from '../debug/log.js';
import { TaskStore } from '../task-orchestrator/store.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { inferPhaseTrack, loadTrackRegistry, trackPostIds } from './mission-phase-track.js';
import type { TrackAgentInput, TrackAgentRunner } from './track-agent.js';

type CourierConfig = NonNullable<NonNullable<UserConfig['autopilot']>['trackCourier']>;
type Comment = { body: string; created_at: string };
const errorMessage = (error: unknown): string => redactSecretText(error instanceof Error ? error.message : String(error));
export type TrackAlive = { alive: boolean; lastPostAt: string | null; reason: 'recent-post' | 'stale' | 'no-post' | 'unmeasured' };
export type PhaseRoute = { taskId: string; title: string; prompt: string; track: string | null; route: 'human' | 'agent' | 'unassigned'; reason: string };
export type CourierDeps = {
  store?: TaskStore;
  config?: CourierConfig;
  now?: number;
  listComments?: () => Promise<Comment[]> | Comment[];
  post?: (body: string) => Promise<void> | void;
  trackAgent?: { enabled: boolean };
  agentRunner?: TrackAgentRunner;
};

const repoRoot = resolve(import.meta.dir, '../..');
const execFileAsync = promisify(execFile);
const log = (event: string, data: Record<string, unknown>) => {
  try { debug.log('autopilot.track-courier', event, data); } catch { /* observation is fail-soft */ }
};
const configFor = (deps: CourierDeps): CourierConfig => deps.config ?? getUserConfig().autopilot?.trackCourier ?? {};
const minutesFor = (config: CourierConfig): number =>
  typeof config.handoffMinutes === 'number' && Number.isFinite(config.handoffMinutes) && config.handoffMinutes > 0 ? config.handoffMinutes : 60;

async function defaultComments(channelPr: number, now: number, handoffMinutes: number): Promise<Comment[]> {
  const since = new Date(now - Math.max(120, handoffMinutes) * 60_000).toISOString();
  const repo = process.env.CH_REPO || 'ElanvitalAI/elanous';
  const { stdout } = await execFileAsync('gh', ['api', '--paginate', '--slurp',
    `repos/${repo}/issues/${channelPr}/comments?since=${encodeURIComponent(since)}`],
  { cwd: repoRoot, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed.every(Array.isArray)) throw new Error('comments response is not paged arrays');
  return parsed.flat() as Comment[];
}

async function defaultPost(body: string, channelPr: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'track-courier-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    await execFileAsync('bash', [join(repoRoot, 'scripts/coord-post.sh'), file], {
      cwd: repoRoot, env: { ...process.env, CH_PR: String(channelPr), COORD_ID: 'E' }, timeout: 20_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The absence of a successful observation is never evidence of an absent human. */
export async function trackAlive(track: string, deps: CourierDeps = {}): Promise<TrackAlive> {
  const now = deps.now ?? Date.now();
  const config = configFor(deps);
  try {
    if (!deps.listComments && !config.channelPr) return { alive: true, lastPostAt: null, reason: 'unmeasured' };
    const comments = await (deps.listComments ?? (() => defaultComments(config.channelPr!, now, minutesFor(config))))();
    if (!Array.isArray(comments)) throw new Error('comments response is not an array');
    const timestamps = comments
      .filter((c) => c && typeof c.body === 'string' && trackPostIds(track).some((id) => c.body.startsWith(`**[${id}]**`)))
      .map((c) => Date.parse(c.created_at))
      .filter((at) => Number.isFinite(at) && at <= now);
    if (!timestamps.length) return { alive: false, lastPostAt: null, reason: 'no-post' };
    const latest = Math.max(...timestamps);
    return { alive: now - latest <= minutesFor(config) * 60_000, lastPostAt: new Date(latest).toISOString(),
      reason: now - latest <= minutesFor(config) * 60_000 ? 'recent-post' : 'stale' };
  } catch {
    return { alive: true, lastPostAt: null, reason: 'unmeasured' };
  }
}

export async function routeMissionPhases(missionId: string, deps: CourierDeps = {}): Promise<PhaseRoute[]> {
  const store = deps.store ?? new TaskStore();
  let phases: Array<{ id: string; title: string; prompt: string }>;
  try {
    phases = store.listTasks({ goalSlug: missionId })
      .filter((task) => task.surface.kind === 'subagent')
      .map((task) => ({ id: task.id, title: task.title, prompt: task.surface.kind === 'subagent' ? task.surface.prompt : '' }));
  } finally { if (!deps.store) store.close(); }
  const registry = loadTrackRegistry();
  const inferred = phases.map((phase) => ({ phase, match: inferPhaseTrack(`${phase.title}\n${phase.prompt}`, registry) }));
  const tracks = [...new Set(inferred.map(({ match }) => match.track).filter((track): track is string => track !== null))];
  const alive = new Map(await Promise.all(tracks.map(async (track) => [track, await trackAlive(track, deps)] as const)));
  const routes: PhaseRoute[] = inferred.map(({ phase, match }) => {
    if (!match.track) return { taskId: phase.id, title: phase.title, prompt: phase.prompt, track: null, route: 'unassigned', reason: match.reason };
    const state = alive.get(match.track)!;
    return { taskId: phase.id, title: phase.title, prompt: phase.prompt, track: match.track,
      route: state.alive ? 'human' : 'agent', reason: state.reason === 'recent-post' || state.reason === 'stale'
        ? `${Math.floor(((deps.now ?? Date.now()) - Date.parse(state.lastPostAt!)) / 60_000)}분 ${state.reason === 'recent-post' ? '전 발신' : '무발신'}`
        : state.reason === 'no-post' ? '최근 2시간 무발신' : 'unmeasured' };
  });
  log('routed', { missionId, phases: routes.map(({ taskId, track, route, reason }) => ({ taskId, track, route, reason })) });
  return routes;
}

async function deliverTrackAgentResult(missionId: string, route: PhaseRoute & { track: string }, channelPr: number, deps: CourierDeps): Promise<void> {
  try {
    const runner: TrackAgentRunner = deps.agentRunner ?? await import('./track-agent.js');
    const input: TrackAgentInput = { missionId, taskId: route.taskId, title: route.title, prompt: route.prompt, track: route.track };
    const decision = await runner.decideTrackAction(input);
    const result = await runner.executeTrackAction(decision, input);
    const status = redactSecretText(result.status).replace(/\s+/g, ' ').trim();
    const detail = result.detail && redactSecretText(result.detail).replace(/\s+/g, ' ').trim();
    const body = `**[E]** {{TS}} ${route.track} · ${route.taskId} · ${status}${detail ? ` · ${detail}` : ''}`;
    try {
      await (deps.post ?? ((text) => defaultPost(text, channelPr)))(body);
      log('agent-result-posted', { missionId, taskId: route.taskId, track: route.track, status });
    } catch (error) {
      log('agent-result-post-failed', { missionId, taskId: route.taskId, track: route.track,
        error: errorMessage(error) });
    }
  } catch (error) {
    log('agent-failed', { missionId, taskId: route.taskId, track: route.track,
      error: errorMessage(error) });
  }
}

export async function deliverMissionPhases(missionId: string, deps: CourierDeps = {}): Promise<void> {
  const config = configFor(deps);
  if (config.enabled !== true) return;
  if (!config.channelPr) { log('post-skipped', { missionId, reason: 'channelPr 미설정' }); return; }
  try {
    const routes = await routeMissionPhases(missionId, { ...deps, config });
    const marks = new Map(loadTrackRegistry().map(({ id, mark }) => [id, mark]));
    const body = [
      `**[E]** {{TS}} 🧭 미션 ${missionId} 승인됨 — 페이즈 배달`,
      ...routes.map(({ taskId, title, track, route, reason }) =>
        `→ ${marks.get(track ?? 'S') ?? '🅢'} ${title.replace(/\s+/g, ' ').trim()} · ${route}(${route === 'unassigned' ? '트랙 미정' : reason}${route === 'agent' ? ' · 트랙 에이전트 대기 — R5' : ''}) · ${taskId}`),
      '집으면 이 코멘트에 `[<트랙>] 집음 <taskId>` 로 답',
    ].join('\n');
    await (deps.post ?? ((text) => defaultPost(text, config.channelPr!)))(body);
    log('posted', { missionId, channelPr: config.channelPr, phases: routes.length });
    if ((deps.trackAgent ?? getUserConfig().autopilot?.trackAgent)?.enabled === true) {
      for (const route of routes) {
        if (route.route !== 'agent' || !route.track) continue;
        const agentRoute = { ...route, track: route.track };
        const channelPr = config.channelPr;
        setImmediate(() => { void deliverTrackAgentResult(missionId, agentRoute, channelPr, deps); });
      }
    }
  } catch (error) {
    log('post-failed', { missionId, error: error instanceof Error ? error.message : String(error) });
  }
}
