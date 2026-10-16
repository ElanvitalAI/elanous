// ── ACP Claude Code 를 «구현» 실행기로 (CLAUDE-IMPL-LANE · `--child-llm-provider claude-acp`) ──
//
// acp-reviewer.ts 의 짝이다. 리뷰어는 read-only 라 읽기 툴만 허가하지만, 구현 실행기는 런 워크트리 안에서
// 쓰기·실행을 허가해야 한다. 대표 대표 결정(10-12): ACP 세션 권한 모드는 호스트 설정(auto)을 그대로 두고
// 바꾸지 않으며, approver 가 불려도 «워크트리 밖 경로 쓰기»를 거부하지 않고 허가하되 insideWorktree 로 관측한다.
// 자식은 claude 구독 ACP 어댑터(`claude-agent-acp`)이며 env 는 subscriptionReviewerSpawn 의 과금 스크럽
// (ANTHROPIC_API_KEY 등 제거)을 그대로 쓴다 — 지우지 않으면 구독이 아니라 API 로 과금된다.
import { isAbsolute, relative, resolve } from 'node:path';
import { AcpAgent, type AcpAgentOpts } from '../acp/client.js';
import { debug } from '../debug/log.js';
import { subscriptionReviewerSpawn } from '../self-dev/review-provider-fallback.js';
import type { SubscriptionReviewerSpec } from '../user-config.js';
import { isReadOnlyReviewTool } from './acp-reviewer.js';

const WRITE_TOOL_KINDS = new Set(['edit', 'delete', 'move']);
const PATH_INPUT_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'destination', 'source'] as const;

export interface ImplementerPermissionRequest {
  title: string;
  kind?: string;
  rawInput?: unknown;
}

export interface ImplementerPermissionDecision {
  tool: string;
  path: string | null;
  /** 판정에 쓴 경로가 워크트리 안인가 — 경로가 없으면 null. 밖이어도 허가한다(대표 10-12); 이 칸이 그 관측이다. */
  insideWorktree: boolean | null;
  decision: 'allow' | 'deny';
}

function requestedPaths(rawInput: unknown): string[] {
  if (!rawInput || typeof rawInput !== 'object') return [];
  const input = rawInput as Record<string, unknown>;
  return PATH_INPUT_KEYS.flatMap((key) => (typeof input[key] === 'string' && input[key] ? [input[key] as string] : []));
}

function insideWorktree(worktree: string, target: string): boolean {
  const rel = relative(resolve(worktree), resolve(worktree, target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 허가 판정(순수 함수). 쓰기 계열(edit·delete·move)은 경로가 있으면 워크트리 안팎을 가리지 않고 허가한다
 *  (대표 10-12 — 밖 쓰기 거부를 걷었다 · insideWorktree 로 관측만 한다). 실행(execute)·읽기 계열은 허가,
 *  그 외(모르는 kind)는 경로가 있을 때만 허가 — 경로 없는 쓰기·모르는 요청은 여전히 거부. */
export function decideImplementerPermission(req: ImplementerPermissionRequest, worktree: string): ImplementerPermissionDecision {
  const paths = requestedPaths(req.rawInput);
  const outside = paths.find((p) => !insideWorktree(worktree, p));
  const tool = req.title.slice(0, 80);
  const shown = outside ?? paths[0] ?? null;
  const inside = paths.length === 0 ? null : outside === undefined;
  const verdict = (allow: boolean): ImplementerPermissionDecision => ({ tool, path: shown, insideWorktree: inside, decision: allow ? 'allow' : 'deny' });
  if (req.kind && WRITE_TOOL_KINDS.has(req.kind)) return verdict(paths.length > 0);
  if (req.kind === 'execute') return verdict(true);
  if (isReadOnlyReviewTool(req.kind, req.title)) return verdict(true);
  return verdict(paths.length > 0);
}

export interface AcpImplementerOpts {
  /** 런 워크트리 — ACP 자식의 cwd 이자 쓰기 허용 경계. */
  worktree: string;
  /** 자식 env 의 원천(기본 process.env). 과금 키는 subscriptionReviewerSpawn 이 제거한다. */
  env?: NodeJS.ProcessEnv;
  /** cct 실행기가 `teamclaude env --no-mitm` 에서 읽은 프록시 주소. */
  proxyBaseUrl?: string;
  spec?: SubscriptionReviewerSpec;
  /** 모델 별칭 — 지정 시 session/set_model 로 고정. */
  model?: string;
  /** 이어갈 ACP 세션 id — 주면 newSession 대신 loadSession 으로 이어간다. */
  resumeSessionId?: string;
  /** 구현 1턴 최대 대기(ms). 초과 시 cancel → throw. 기본 1_800_000. */
  timeoutMs?: number;
  /** spawn → initialize → session 준비까지의 단일 기한(ms). 기본 60_000. */
  handshakeTimeoutMs?: number;
  /** 테스트용 ACP 에이전트 생성기. */
  createAgent?: (opts: AcpAgentOpts) => AcpAgent;
}

export interface AcpImplementerResult {
  text: string;
  sessionId: string;
  allowed: number;
  denied: number;
}

const OBS = 'agent-substrate.acp-implementer';

/** Claude ACP's default preset imports user/project plugins and MCP servers into every
 * prompt snapshot. The implementation child only needs the built-in coding tools. */
export const CLAUDE_IMPLEMENTER_META = {
  claudeCode: { options: {
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    settingSources: [],
    plugins: [],
    mcpServers: {},
    strictMcpConfig: true,
  } },
} as const;

export function makeAcpImplementer(opts: AcpImplementerOpts): (prompt: string) => Promise<AcpImplementerResult> {
  return async (prompt) => {
    const spawn = subscriptionReviewerSpawn(opts.spec ?? { provider: 'claude-acp' }, opts.env ?? process.env, opts.proxyBaseUrl);
    const timeoutMs = opts.timeoutMs ?? 1_800_000;
    const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 60_000;
    let allowed = 0;
    let denied = 0;
    const agentOpts: AcpAgentOpts = {
      backendId: 'claude',
      backendSpec: spawn.backendSpec,
      env: spawn.env,
      cwd: opts.worktree,
      log: (message) => debug.log(OBS, 'agent-log', { message }),
      permissionApprover: async (req) => {
        const verdict = decideImplementerPermission(req, opts.worktree);
        if (verdict.decision === 'allow') allowed++; else denied++;
        debug.log(OBS, 'permission', {
          tool: verdict.tool, path: verdict.path, insideWorktree: verdict.insideWorktree, allowed: verdict.decision === 'allow',
        });
        return verdict.decision === 'allow';
      },
    };
    const agent = opts.createAgent ? opts.createAgent(agentOpts) : new AcpAgent(agentOpts);
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const withinHandshake = <T>(step: Promise<T>): Promise<T> => Promise.race([step, new Promise<never>((_, reject) => {
      handshakeTimer = setTimeout(() => reject(new Error(`ACP handshake timeout (${handshakeTimeoutMs}ms)`)), handshakeTimeoutMs);
    })]).finally(() => { if (handshakeTimer) clearTimeout(handshakeTimer); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let text = '';
    try {
      await withinHandshake(agent.start());
      let sid: string;
      if (opts.resumeSessionId) {
        await withinHandshake(agent.loadSession({ sessionId: opts.resumeSessionId, cwd: opts.worktree, _meta: CLAUDE_IMPLEMENTER_META }));
        sid = opts.resumeSessionId;
      } else {
        sid = await withinHandshake(agent.newSession(CLAUDE_IMPLEMENTER_META));
      }
      if (opts.model) await withinHandshake(agent.selectSessionModel(sid, opts.model));
      debug.log(OBS, 'start', { cwd: opts.worktree, model: opts.model ?? '(default)', resumed: Boolean(opts.resumeSessionId) });
      timer = setTimeout(() => { timedOut = true; agent.cancel(sid).catch(() => { /* noop */ }); }, timeoutMs);
      await agent.prompt(sid, [{ type: 'text', text: prompt }], (u) => {
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text) text += u.content.text;
      });
      if (timedOut) throw new Error(`ACP 구현 타임아웃(${timeoutMs}ms)`);
      debug.log(OBS, 'done', { chars: text.length, allowed, denied });
      return { text, sessionId: sid, allowed, denied };
    } catch (e) {
      debug.log(OBS, 'error', { message: (e as Error).message, allowed, denied }, { level: 'error' });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      try { await agent.stop(); } catch (e) {
        debug.log(OBS, 'stop-fail', { message: (e as Error).message }, { level: 'error' });
      }
    }
  };
}
