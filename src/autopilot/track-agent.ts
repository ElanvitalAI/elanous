import { execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { debug, redactSecretText } from '../debug/log.js';
import { getOrCreatePersonaSession } from '../session/index.js';
import { getUserConfig } from '../user-config.js';
import { decideBudget, readBudgetInputsLive } from '../self-implement/budget-gate.js';
import { loadTrackRegistry } from './mission-phase-track.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export type TrackAgentInput = { missionId: string; taskId: string; title: string; prompt: string; track: string };
export type TrackAgentDecision = { action: 'say' | 'hold'; reason?: string };
export type TrackAgentResult = { status: 'launched' | 'held' | 'failed'; detail?: string };
export type TrackAgentRunner = {
  decideTrackAction: (input: TrackAgentInput) => Promise<TrackAgentDecision> | TrackAgentDecision;
  executeTrackAction: (decision: TrackAgentDecision, input: TrackAgentInput) => Promise<TrackAgentResult> | TrackAgentResult;
};

type RunnerDeps = {
  run?: (args: string[]) => Promise<{ stdout: string }>;
  /** Resolves once the child is spawned; `exited` settles when that run ends (the concurrency slot is held until then). */
  launch?: (args: string[]) => Promise<void | { exited?: Promise<unknown> }>;
  checkBudget?: () => Promise<boolean>;
  session?: (persona: string) => string;
  root?: string;
  maxConcurrent?: number;
};
const root = resolve(import.meta.dir, '../..');
// The installed package is not a git checkout — the daemon's target repository comes first.
const repoDir = (): string => process.env.ELANOUS_TOOL_CWD?.trim() || root;
const exec = promisify(execFile);
const log = (event: string, data: Record<string, unknown>) => {
  try { debug.log('autopilot.track-agent', event, data); } catch { /* observation is fail-soft */ }
};
/** The daemon's own universe, resolved once and pinned on the child (config ⊕ state) — the harness isolates its own workers. */
export function universeLaunch(args: readonly string[], root: string = effectiveInstanceRoot()): { argv: string[]; env: NodeJS.ProcessEnv } {
  return { argv: ['bin/elanous.mjs', '--config-dir', root, ...args], env: { ...process.env, ELANOUS_STATE_DIR: root } };
}
const runCli = async (args: string[]): Promise<{ stdout: string }> => {
  const { argv, env } = universeLaunch(args);
  return exec('bun', argv, { cwd: repoDir(), env, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
};
const forbidden = /\b(?:delete|remove|deploy|publish|release|restart|reboot|merge|force|pay|purchase|secret|credential|sudo|rm\s+-rf|config\s+set)\b|(?:^|\s)--prod\b|삭제|배포|게시|릴리스|재시작|재부팅|병합|결제|자격|비밀|강제/i;
let running = 0;

function context(input: TrackAgentInput, repo: string): string {
  const track = loadTrackRegistry().find(({ id }) => id === input.track);
  if (!track) throw new Error('unknown track');
  const docs = resolve(repo, 'docs');
  let handoff = '';
  let decisionTable = '';
  try { decisionTable = readFileSync(resolve(repo, 'CLAUDE.md'), 'utf8').slice(0, 8_000); }
  catch { decisionTable = '(없음)'; }
  try {
    const latest = readdirSync(docs)
      .filter((name) => name.startsWith(`HANDOFF-${input.track}-`) && name.endsWith('.md'))
      .sort().at(-1);
    if (latest) handoff = `${latest}\n${readFileSync(resolve(docs, latest), 'utf8').slice(0, 12_000)}`;
  } catch { /* missing handoff is explicitly marked in the prompt */ }
  return [
    `트랙 ${input.track} 소유: ${track.owns.join(', ')}`,
    `최근 인계 문서: ${handoff || '(없음)'}`,
    `CLAUDE.md 진입·결정표: ${decisionTable}`,
    `미션 ${input.missionId} · 페이즈 ${input.taskId} · ${input.title}`,
    input.prompt,
    '도구를 호출하지 마라. 허용 판정: say 또는 hold. 금지: 운영 설정/원장 쓰기, 재시작, 배포, 삭제, 강제 브랜치, 결제, 타인 PR 병합.',
    'JSON 객체 하나만 답하라: {"action":"say"|"hold","reason":"판정 이유"}.',
  ].join('\n\n');
}

export async function decideTrackAction(input: TrackAgentInput, deps: RunnerDeps = {}): Promise<TrackAgentDecision> {
  try {
    const prompt = context(input, deps.root ?? repoDir());
    const persona = `track-${input.track}`;
    const session = deps.session?.(persona) ?? getOrCreatePersonaSession(persona).id;
    const { stdout } = await (deps.run ?? runCli)(['agent', '--session', session, '--json', '--no-tools', prompt]);
    const envelope: unknown = JSON.parse(stdout.trim());
    if (!envelope || typeof envelope !== 'object' || typeof (envelope as { reply?: unknown }).reply !== 'string') throw new Error('invalid agent response');
    const reply = (envelope as { reply: string }).reply.trim();
    const decision: unknown = JSON.parse(reply);
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('invalid decision');
    const values = decision as Record<string, unknown>;
    if (!['say', 'hold'].includes(String(values.action)) || (values.reason !== undefined && typeof values.reason !== 'string')
      || Object.keys(values).some((key) => !['action', 'reason'].includes(key))) throw new Error('invalid decision');
    if (typeof values.reason === 'string' && forbidden.test(values.reason)) throw new Error('forbidden action');
    return decision as TrackAgentDecision;
  } catch (error) {
    log('decision-failed', { track: input.track, taskId: input.taskId, error: redactSecretText(String(error)) });
    return { action: 'hold', reason: '판정 실패 — 사람 확인' };
  }
}

export async function executeTrackAction(decision: TrackAgentDecision, input: TrackAgentInput, deps: RunnerDeps = {}): Promise<TrackAgentResult> {
  if (decision.action !== 'say') return { status: 'held', detail: decision.reason ?? '사람 확인' };
  if (forbidden.test(`${input.title}\n${input.prompt}`)) return { status: 'held', detail: '금지 작업 — 사람 확인' };
  if (!loadTrackRegistry().some(({ id }) => id === input.track)) return { status: 'held', detail: '트랙 미정 — 사람 확인' };
  try {
    const checkBudget = deps.checkBudget ?? (async () => {
      const action = decideBudget(await readBudgetInputsLive()).action;
      return action === 'proceed' || action === 'next-provider';
    });
    const allowed = await checkBudget();
    if (!allowed) return { status: 'held', detail: '예산 관문' };
  } catch (error) {
    log('budget-failed', { track: input.track, taskId: input.taskId, error: redactSecretText(String(error)) });
    return { status: 'held', detail: '예산 관문 측정 실패' };
  }
  const configured = deps.maxConcurrent ?? getUserConfig().autopilot?.trackAgent?.maxConcurrent ?? 2;
  const limit = Number.isSafeInteger(configured) && configured > 0 ? Math.min(2, configured) : 2;
  if (running >= limit) return { status: 'held', detail: '동시 실행 상한' };
  running++;
  let held = false;
  try {
    const launch = deps.launch ?? (async (args: string[]) => {
      const { argv, env } = universeLaunch(args);
      const child = spawn('bun', argv, { cwd: repoDir(), env, stdio: 'ignore', detached: true });
      const exited = new Promise<void>((done) => { child.once('exit', () => done()); child.once('error', () => done()); });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => { child.unref(); resolve(); });
        child.once('error', reject);
      });
      return { exited };
    });
    const handle = await launch(['harness', 'say', '--no-auto-merge', `${input.title}\n${input.prompt}`]);
    if (handle && handle.exited) {
      held = true;
      void handle.exited.finally(() => { running--; log('run-exited', { track: input.track, taskId: input.taskId, running }); });
    }
    log('launched', { track: input.track, taskId: input.taskId, running });
    return { status: 'launched', detail: 'detached harness say' };
  } catch (error) {
    log('launch-failed', { track: input.track, taskId: input.taskId, error: redactSecretText(String(error)) });
    return { status: 'failed', detail: '하니스 발사 실패' };
  } finally {
    if (!held) running--;
  }
}
