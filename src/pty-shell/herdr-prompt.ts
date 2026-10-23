// `eln herdr prompt <대상> "<문장>" [--wait] [--timeout MS]` — herdr pane 의 elanous TUI 를 밖에서 깨운다.
//
// 왜 herdr `agent prompt` 가 아닌가(10-22 실측 · herdr 소스 v0.9.1·v0.9.5·main 5bd900d 동일):
//   `src/app/api/agents.rs` 의 prompt·send-keys 는 `terminal.effective_known_agent()`(내장 kind 라벨)와
//   `runtime_hosts_agent`(전경 프로세스가 그 kind)를 요구한다. «Add Herdr support to your agent» 계약대로
//   자기 이름(`elanous`)으로 신고한 agent 는 list·get·wait·read·알림은 되지만 prompt 는
//   `agent_not_ready: … is not an active named agent` 로 늘 거부된다.
// 그래서 같은 의미를 여기서 낸다:
//   ① `herdr agent get` — 신고 라벨이 elanous 이고 idle/done 인지(blocked/working/unknown 은 입력 0 으로 거부)
//   ② `herdr pane run <pane> <문장>` — agent prompt 와 «같은 바이트»: herdr 의 `pane run` 은 pane 의 bracketed-paste
//      모드를 따라 `ESC[200~문장ESC[201~` ⊕ Enter 를 한 번에 쓴다(격리 세션 실측 · `pane send-text` 는 날 바이트라 쓰지 않는다)
//   ③ --wait — 제출 뒤 활동 창(5000ms) 안에 working/blocked 를 관측해야 하고(아니면 agent_prompt_stalled),
//      그 뒤 idle/done/blocked 정착까지 기다린다. 호출자 timeout 이 먼저 끝나면 timeout. herdr agent prompt --wait 의미 그대로.
// 관측: debug.log('pty.herdr', 'prompt', { target, paneId, accepted, reason, status, ms }) 한 줄.
// 호출자 둘: CLI `eln herdr prompt`(라벨 elanous 만) ⊕ 우편 깨움 `src/loops/msg-wake.ts`(anyAgent · beforeSubmit 으로 재해석·opt-in·마감 관문).
// 신고 계약(herdr-agent-report.ts)은 건드리지 않는다 — 이 명령은 그 신고(working/idle)를 «읽기만» 한다.

import { spawn } from 'node:child_process';

import { debug } from '../debug/log.js';

export const HERDR_PROMPT_ACTIVITY_WINDOW_MS = 5000;
const HERDR_PROMPT_AGENT = 'elanous';
const CALL_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 1500;
const OUTPUT_CAP = 64 * 1024;

export interface HerdrCliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** herdr CLI 한 번. timeoutMs 가 Infinity 면 끝없이 기다린다. */
export type HerdrCliRunner = (argv: readonly string[], timeoutMs: number) => Promise<HerdrCliResult>;

export interface HerdrPromptOpts {
  readonly target: string;
  readonly text: string;
  readonly wait?: boolean;
  /** 호출자 timeout(제출 포함) — 없으면 정착 대기는 끝이 없다(herdr 와 같다). */
  readonly timeoutMs?: number;
  /**
   * 라벨 확인을 끈다 — 호출자가 대상을 이미 정했을 때(우편 깨움: 자리 폴더 `herdr.pane`). 상태 확인(idle/done 만)과
   * 제출(`pane run`)은 그대로다. CLI(`eln herdr prompt`)는 켜지 않는다 — herdr 내장 kind 는 herdr agent prompt 몫.
   */
  readonly anyAgent?: boolean;
  /** `agent get` 이 agent_not_found 면 `pane get` 의 agent_status 로 떨어진다(우편 깨움 · #30261 전 경로와 같은 관문).
   *  10-22 cct 아래 Claude 자리가 agent get 에서 간헐적으로 안 잡혀 깨움 18건이 failed 됐다. */
  readonly paneFallback?: boolean;
}

/** 상태 확인을 통과한 대상 — `beforeSubmit` 이 본다. */
export interface HerdrPromptView {
  readonly agent: string;
  readonly status: string;
  readonly paneId: string;
}

export interface HerdrPromptDeps {
  readonly run?: HerdrCliRunner;
  readonly now?: () => number;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** 시험용 — 제출 뒤 활동 관측 창. 기본 5000ms(herdr 의미). */
  readonly activityWindowMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * 상태 확인 «뒤»·제출 «바로 앞» 호출자 관문 — 이유 문자열을 돌려주면 입력 0 으로 그 이유로 끝난다(accepted:false).
   * 우편 깨움이 대상 재해석·opt-in 재확인·마감을 여기서 본다(조회 사이 바뀐 것에 넣지 않는다).
   */
  readonly beforeSubmit?: (view: HerdrPromptView) => string | undefined;
}

export type HerdrPromptReason =
  | 'submitted' | 'settled'
  | 'empty_agent_prompt' | 'not_elanous' | 'agent_blocked' | 'agent_working' | 'agent_unknown'
  | 'agent_prompt_stalled' | 'timeout'
  | string; // herdr 오류 코드 그대로(agent_not_found · pane_not_found …)

export interface HerdrPromptResult {
  readonly ok: boolean;
  /** 문장이 pane 에 들어갔나(실패여도 true 일 수 있다 — 재제출 전에 화면을 읽어라). */
  readonly accepted: boolean;
  readonly reason: HerdrPromptReason;
  readonly target: string;
  readonly paneId?: string;
  readonly agent?: string;
  readonly status?: string;
  readonly message?: string;
  readonly ms: number;
}

interface AgentView {
  readonly agent: string;
  readonly status: string;
  readonly paneId: string;
  readonly seq: number;
}

/** herdr 오류 봉투(stderr 또는 stdout JSON `{"error":{code,message}}`). 없으면 undefined. */
function herdrError(r: HerdrCliResult): { code: string; message: string } | undefined {
  for (const text of [r.stderr, r.stdout]) {
    const t = text.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = (JSON.parse(t) as { error?: { code?: unknown; message?: unknown } }).error;
      if (e && typeof e === 'object') {
        return { code: typeof e.code === 'string' ? e.code : 'herdr_error', message: typeof e.message === 'string' ? e.message : '' };
      }
    } catch { /* not an envelope */ }
  }
  if (r.code === 0) return undefined;
  return { code: r.code === null ? 'herdr_killed' : `herdr_rc_${r.code}`, message: r.stderr.trim().slice(0, 240) };
}

function agentOf(r: HerdrCliResult): AgentView | undefined {
  try {
    const a = (JSON.parse(r.stdout.trim()) as { result?: { agent?: Record<string, unknown> } }).result?.agent;
    if (!a || typeof a.pane_id !== 'string') return undefined;
    return {
      agent: typeof a.agent === 'string' ? a.agent : '',
      status: typeof a.agent_status === 'string' ? a.agent_status : 'unknown',
      paneId: a.pane_id,
      seq: typeof a.state_change_seq === 'number' ? a.state_change_seq : 0,
    };
  } catch {
    return undefined;
  }
}

/** `pane get` 봉투에서 agent·agent_status — paneFallback 전용(agent get 이 못 찾을 때). seq 는 없다(0). */
function paneViewOf(r: HerdrCliResult): AgentView | undefined {
  if (herdrError(r)) return undefined;
  try {
    const p = (JSON.parse(r.stdout.trim()) as { result?: { pane?: Record<string, unknown> } }).result?.pane;
    if (!p || typeof p.pane_id !== 'string' || typeof p.agent_status !== 'string') return undefined;
    return { agent: typeof p.agent === 'string' ? p.agent : '', status: p.agent_status, paneId: p.pane_id, seq: 0 };
  } catch {
    return undefined;
  }
}

/** 기본 러너 — HERDR_BIN_PATH(없으면 PATH 의 herdr). HERDR_SOCKET_PATH 등 env 는 그대로 넘긴다. */
export function defaultHerdrCliRunner(env: NodeJS.ProcessEnv = process.env): HerdrCliRunner {
  const bin = env.HERDR_BIN_PATH?.trim() || 'herdr';
  return (argv, timeoutMs) => new Promise<HerdrCliResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...argv], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: HerdrCliResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        finish({ code: null, stdout, stderr: stderr || 'herdr call timed out' });
      }, Math.max(1, timeoutMs))
      : undefined;
    child.stdout?.on('data', (c: Buffer | string) => { if (stdout.length < OUTPUT_CAP) stdout += String(c); });
    child.stderr?.on('data', (c: Buffer | string) => { if (stderr.length < OUTPUT_CAP) stderr += String(c); });
    child.on('error', (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

export async function herdrPrompt(opts: HerdrPromptOpts, deps: HerdrPromptDeps = {}): Promise<HerdrPromptResult> {
  const now = deps.now ?? Date.now;
  const run = deps.run ?? defaultHerdrCliRunner(deps.env);
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) => debug.log('pty.herdr', event, data));
  const windowMs = deps.activityWindowMs ?? HERDR_PROMPT_ACTIVITY_WINDOW_MS;
  const start = now();
  const deadline = opts.timeoutMs !== undefined ? start + opts.timeoutMs : undefined;
  const remaining = (): number => (deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadline - now()));
  const callCap = (): number => Math.min(CALL_TIMEOUT_MS, Math.max(1, remaining()));

  let view: AgentView | undefined;
  const done = (ok: boolean, accepted: boolean, reason: HerdrPromptReason, message?: string): HerdrPromptResult => {
    const result: HerdrPromptResult = {
      ok, accepted, reason, target: opts.target,
      ...(view ? { paneId: view.paneId, agent: view.agent, status: view.status } : {}),
      ...(message ? { message } : {}),
      ms: Math.max(0, Math.round(now() - start)),
    };
    log('prompt', { target: opts.target, paneId: view?.paneId, accepted, reason, status: view?.status, ms: result.ms });
    return result;
  };

  if (opts.text.length === 0) return done(false, false, 'empty_agent_prompt', 'prompt text must not be empty');

  // ① 대상 확인
  const got = await run(['agent', 'get', opts.target], callCap());
  const getErr = herdrError(got);
  if (getErr) {
    if (!(opts.paneFallback && getErr.code === 'agent_not_found')) return done(false, false, getErr.code, getErr.message);
    const pane = paneViewOf(await run(['pane', 'get', opts.target], callCap()));
    if (!pane) return done(false, false, getErr.code, getErr.message);
    log('prompt-pane-fallback', { target: opts.target, paneId: pane.paneId, agent: pane.agent, status: pane.status });
    view = pane;
  } else view = agentOf(got);
  if (!view) return done(false, false, 'unparseable_agent_get');
  if (!opts.anyAgent && view.agent !== HERDR_PROMPT_AGENT) {
    return done(false, false, 'not_elanous', `agent label ${view.agent || '(none)'} — use herdr agent prompt for herdr-supported agents`);
  }
  if (view.status === 'blocked') return done(false, false, 'agent_blocked', 'agent is blocked and requires interactive input');
  if (view.status === 'working') return done(false, false, 'agent_working', 'agent is working — wait for idle first');
  if (view.status !== 'idle' && view.status !== 'done') return done(false, false, 'agent_unknown', `agent status ${view.status}`);
  const seq0 = view.seq;
  const paneId = view.paneId;
  const veto = deps.beforeSubmit?.({ agent: view.agent, status: view.status, paneId });
  if (veto !== undefined) return done(false, false, veto);

  // ② 제출 — agent prompt 와 같은 bracketed text ⊕ Enter 한 번
  const sent = await run(['pane', 'run', paneId, opts.text], callCap());
  const sendErr = herdrError(sent);
  if (sendErr) return done(false, false, sendErr.code, sendErr.message);
  if (!opts.wait) return done(true, true, 'submitted');

  const refresh = async (): Promise<AgentView | undefined> => {
    const r = await run(['agent', 'get', paneId], CALL_TIMEOUT_MS);
    const v = herdrError(r) ? undefined : agentOf(r);
    if (v) view = v;
    return v;
  };
  const settledStatus = (s: string): boolean => s === 'idle' || s === 'done' || s === 'blocked';

  // ③ 활동 관측(working/blocked) — 창 안에 없으면 stalled, 호출자 timeout 이 먼저면 timeout
  const win = Math.min(windowMs, remaining());
  const activity = await run(['agent', 'wait', paneId, '--until', 'working', '--until', 'blocked', '--timeout', String(Math.max(1, Math.floor(win)))], win + KILL_GRACE_MS);
  const actErr = herdrError(activity);
  if (actErr) {
    const v = await refresh();
    // wait 를 걸기 전에 턴이 이미 돌고 끝났다 — seq 가 움직였고 정착 상태면 성공이다.
    if (v && v.seq > seq0 && settledStatus(v.status)) return done(true, true, 'settled');
    if (!(v && v.seq > seq0 && v.status === 'working')) {
      if (actErr.code !== 'timeout') return done(false, true, actErr.code, actErr.message);
      return done(false, true, remaining() <= 0 ? 'timeout' : 'agent_prompt_stalled', 'no working/blocked activity observed after submission');
    }
  } else {
    const v = agentOf(activity);
    if (v) view = v;
    if (v?.status === 'blocked') return done(true, true, 'settled');
  }

  // ④ 정착(idle/done/blocked)까지
  const rem = remaining();
  const settleArgs = ['agent', 'wait', paneId, ...(Number.isFinite(rem) ? ['--timeout', String(Math.max(1, Math.floor(rem)))] : [])];
  const settled = await run(settleArgs, Number.isFinite(rem) ? rem + KILL_GRACE_MS : Number.POSITIVE_INFINITY);
  const setErr = herdrError(settled);
  if (setErr) {
    await refresh();
    return done(false, true, setErr.code, setErr.message);
  }
  const v = agentOf(settled);
  if (v) view = v;
  return done(true, true, 'settled');
}
