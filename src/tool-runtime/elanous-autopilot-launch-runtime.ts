import type { LLMToolSpec } from '../llm/tool-spec.js';
// PLAN-codex-app-server-hermes-parity §5 Phase H1·6b (2026-05-16) —
// `elanous_autopilot_launch` MCP tool. Codex turn calls this to fire a
// elanous autopilot mission against a chosen backend (claude / gemini /
// grok / codex-app-server) inside the codex's working directory.
//
// Sync MVP — the call blocks until the mission terminates. Caps are
// tighter than the CLI's defaults so we stay inside codex's
// `tool_timeout_sec = 600` budget without surprising codex with a
// stalled tool. Heavy missions should go through `elanous autopilot run`
// directly; this tool targets short pivots ("explore X" · "patch Y")
// that complete within ~2 min.
//
// CRITICAL: the retired `elanous autopilot` CLI used to write agent
// text to `process.stdout` and envelopes to `process.stderr`. Codex's
// MCP transport uses stdio for JSON-RPC — bare process.stdout writes
// would corrupt the channel. We bypass the CLI helper and drive the
// AutopilotLoopDriver directly with in-memory accumulators.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AcpAgent, type AcpAgentOpts } from '../acp/client.js';
import { AcpAgentManager } from '../acp/agent-manager.js';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import { lintGoalFile, formatGoalFileLintFinding, type GoalFileLintFinding } from '../self-implement/goal-author.js';
import { createRepositoryReferencedFileReader, type ReferencedFileReader } from '../self-implement/goal-file-reader.js';
import {
  AutopilotLoopDriver,
  type AutopilotResult,
} from '../autopilot/agent-loop.js';
import { AcpTurnRunner } from '../autopilot/runner.js';
import { heuristicPlanConfig } from '../autopilot/planner.js';

import type { ToolRuntime } from './types.js';

export interface ElanousAutopilotLaunchArgs {
  /** Mission text. Required. */
  mission?: string;
  /** Backend id (default 'claude'). */
  backend?: string;
  /** Max iterations (1..10 · default 1). */
  maxIterations?: number;
  /** Max wall-clock ms (1000..480000 · default 120000). */
  maxWallClockMs?: number;
  /** Max accumulated output chars (1000..1000000 · default 100000). */
  maxOutputChars?: number;
  /** Working directory for the spawned agent. Default daemon cwd. */
  cwd?: string;
  /** Parse mission for numbered/bulleted plan markers. Default false. */
  autoPlan?: boolean;
  /** Authored goal file to lint before spawning the agent. Required for fail-closed launch. */
  goalFile?: string;
}

export interface ElanousAutopilotLaunchResult extends Record<string, unknown> {
  output: string;
  ok: boolean;
  termination: AutopilotResult['termination'];
  iterations: number;
  /** Accumulated assistant text across all iterations. */
  text: string;
  /** Count of feedback envelopes emitted (full envelopes are dropped
   *  to keep the MCP payload small — heavy missions can produce many). */
  envelopeCount: number;
  durationMs: number;
  /** Pre-launch lint diagnostics, including non-blocking warnings. */
  diagnostics: GoalFileLintFinding[];
}

const CAP_ITERATIONS = 10;
const CAP_WALLCLOCK_MS = 480_000;
const CAP_OUTPUT_CHARS = 1_000_000;
const DEFAULT_ITERATIONS = 1;
const DEFAULT_WALLCLOCK_MS = 120_000;
const DEFAULT_OUTPUT_CHARS = 100_000;
const MIN_WALLCLOCK_MS = 1000;
const MIN_OUTPUT_CHARS = 1000;

function isLaunchBlockingGoalFileFinding(
  finding: GoalFileLintFinding,
  _diagnostics: readonly GoalFileLintFinding[],
): boolean {
  if (finding.level !== 'ERROR') return false;
  if (finding.check !== 'required-section-order') return true;
  return finding.orderCause !== 'missing-required-section';
}

export function buildElanousAutopilotLaunchTool(): LLMToolSpec {
  return {
    name: 'elanous_autopilot_launch',
    description:
      'Run a elanous autopilot mission to completion (sync MVP). Spawns an ACP agent (codex default · JDG-S9), drives the AutopilotLoopDriver, and returns aggregated text + termination. Strict caps (default 1 iteration / 120s wall-clock) — heavy missions belong in `elanous autopilot run`. MCP callback only.',
    parameters: {
      type: 'object',
      required: ['mission'],
      properties: {
        mission: {
          type: 'string',
          description: 'Mission text describing the goal for the autopilot loop.',
        },
        backend: {
          type: 'string',
          description: "Backend id (default: DEFAULT_REVIEW_BACKEND = codex · JDG-S9). Valid: elanous-builtin, codex-app-server, claude, gemini, grok.",
        },
        maxIterations: {
          type: 'integer',
          description: 'Max loop iterations (1..10 · default 1).',
          minimum: 1,
          maximum: CAP_ITERATIONS,
        },
        maxWallClockMs: {
          type: 'integer',
          description: 'Max wall-clock ms (1000..480000 · default 120000).',
          minimum: MIN_WALLCLOCK_MS,
          maximum: CAP_WALLCLOCK_MS,
        },
        maxOutputChars: {
          type: 'integer',
          description: 'Max accumulated chars (1000..1000000 · default 100000).',
          minimum: MIN_OUTPUT_CHARS,
          maximum: CAP_OUTPUT_CHARS,
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the spawned agent (default daemon cwd).',
        },
        autoPlan: {
          type: 'boolean',
          description: 'Parse mission for numbered/bulleted plan markers (default false).',
        },
        goalFile: {
          type: 'string',
          description: 'Authored goal file to lint before launch; ERROR findings block agent spawn.',
        },
      },
      additionalProperties: false,
    },
  };
}

export interface DispatchOpts {
  /** Override agent factory (tests). Production callers omit. */
  spawnAgent?: (backend: string, cwd: string) => Promise<AcpAgent>;
  /** Override the canonical ACP manager (tests). Ignored when spawnAgent is injected. */
  agentManager?: Pick<AcpAgentManager, 'getAgent'>;
  /** Test-only factory for the per-dispatch manager. */
  createAgentManager?: () => AcpAgentManager;
  /** Override goal text reader (tests). Production callers read the requested file. */
  readGoalFile?: (path: string) => string;
  /** Override current branch lookup (tests). Production callers query git in the launch cwd. */
  branch?: (cwd: string) => string;
  /** Override repository-bounded traced-file reader (tests). */
  readReferencedFile?: ReferencedFileReader;
}

export async function dispatchElanousAutopilotLaunch(
  args: ElanousAutopilotLaunchArgs = {},
  opts: DispatchOpts = {},
): Promise<ElanousAutopilotLaunchResult> {
  const t0 = Date.now();
  const mission =
    typeof args.mission === 'string' ? args.mission.trim() : '';
  if (mission.length === 0) {
    return {
      output: '(mission required)',
      ok: false,
      termination: { kind: 'error', message: 'mission-required' },
      iterations: 0,
      text: '',
      envelopeCount: 0,
      durationMs: Date.now() - t0,
      diagnostics: [],
    };
  }
  const backend =
    typeof args.backend === 'string' && args.backend.length > 0
      ? args.backend
      : 'claude';
  const cwd =
    typeof args.cwd === 'string' && args.cwd.length > 0
      ? args.cwd
      : process.cwd();
  // ⛔⭐⭐ `goalFile` 은 **선택**이다(2026-08-01 교차 리뷰 지적 · [T]).
  //   주면 발사 전 린트하고 ERROR 면 막는다(fail-closed). **안 주면 종전대로 발사**한다.
  //   ⚠️ 필수로 만들면 기존 MCP 호출자가 전부 깨진다 — 그건 이 골이 요구한 것이 아니다.
  //   ⊕ `#6348`(elanous dev)이 `--allow-no-evidence` 탈출구를 둔 것과 같은 형태다.
  const lintRequested = typeof args.goalFile === 'string' && args.goalFile.trim().length > 0;
  // ⛔⭐ 우회를 **관측에 남긴다**(2026-08-01 교차 리뷰 지적 · [T]) — `dev-pipeline` 의
  //   `goal-file-evidence-bypassed` 와 같은 형태. 안 남기면 ***"몇 번 우회했나" 를 셀 수 없다***
  //   ⇒ 제1원칙(자율/셀프힐 로직엔 관측을 반드시 남긴다) 위반이고, 다음 창이 0 을 "안 썼다" 로 오독한다.
  if (!lintRequested) debug.log('autopilot-launch', 'goal-lint-skipped', { reason: 'no-goal-file', mission: mission.slice(0, 80) });
  let diagnostics: GoalFileLintFinding[] = [];
  if (lintRequested) try {
    const goalFile = resolve(cwd, args.goalFile as string);
    const document = (opts.readGoalFile ?? ((path: string) => readFileSync(path, 'utf8')))(goalFile);
    const branch = (opts.branch ?? ((directory: string) => {
      const result = runGitCommand(directory, ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    }))(cwd);
    diagnostics = lintGoalFile(document, branch, {
      readReferencedFile: opts.readReferencedFile ?? createRepositoryReferencedFileReader(cwd),
    });
    if (diagnostics.some((finding) => isLaunchBlockingGoalFileFinding(finding, diagnostics))) {
      return {
        output: diagnostics.map(formatGoalFileLintFinding).join('\n'),
        ok: false,
        termination: { kind: 'error', message: 'goal-lint-failed' },
        iterations: 0,
        text: '',
        envelopeCount: 0,
        durationMs: Date.now() - t0,
        diagnostics,
      };
    }
  } catch (error) {
    return {
      output: `(goal lint failed: ${error instanceof Error ? error.message : String(error)})`,
      ok: false,
      termination: { kind: 'error', message: 'goal-lint-failed' },
      iterations: 0,
      text: '',
      envelopeCount: 0,
      durationMs: Date.now() - t0,
      diagnostics: [],
    };
  }
  const maxIterations = clampIntInclusive(
    args.maxIterations,
    1,
    CAP_ITERATIONS,
    DEFAULT_ITERATIONS,
  );
  const maxWallClockMs = clampIntInclusive(
    args.maxWallClockMs,
    MIN_WALLCLOCK_MS,
    CAP_WALLCLOCK_MS,
    DEFAULT_WALLCLOCK_MS,
  );
  const maxOutputChars = clampIntInclusive(
    args.maxOutputChars,
    MIN_OUTPUT_CHARS,
    CAP_OUTPUT_CHARS,
    DEFAULT_OUTPUT_CHARS,
  );

  const ownedManager = !opts.spawnAgent && !opts.agentManager
    ? (opts.createAgentManager?.() ?? new AcpAgentManager())
    : undefined;
  const agentManager = opts.agentManager ?? ownedManager;
  let agent: AcpAgent | null = null;
  try {
    agent = opts.spawnAgent
      ? await opts.spawnAgent(backend, cwd)
      : await spawnElanousAutopilotAgent(backend, cwd, undefined, agentManager);
    const sessionId = await agent.newSession();
    let accumulated = '';
    let envelopeCount = 0;

    const planConfig = args.autoPlan ? heuristicPlanConfig(mission) : {};

    const driver = new AutopilotLoopDriver({
      runner: new AcpTurnRunner(agent, sessionId),
      sessionId,
      mission,
      maxIterations,
      maxWallClockMs,
      maxOutputChars,
      onEnvelope: () => {
        envelopeCount += 1;
      },
      onUpdate: (update: unknown) => {
        const u = update as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        };
        if (
          u.sessionUpdate === 'agent_message_chunk' &&
          u.content?.type === 'text' &&
          typeof u.content.text === 'string'
        ) {
          accumulated += u.content.text;
        }
      },
      ...planConfig,
    });

    const result = await driver.run();
    return {
      output: `autopilot ${result.termination.kind} · ${result.iterations} iter · ${accumulated.length} chars`,
      ok: result.termination.kind === 'success',
      termination: result.termination,
      iterations: result.iterations,
      text: accumulated,
      envelopeCount,
      durationMs: Date.now() - t0,
      diagnostics,
    };
  } catch (e) {
    return {
      output: `(autopilot failed: ${e instanceof Error ? e.message : e})`,
      ok: false,
      termination: {
        kind: 'error',
        message: String(e instanceof Error ? e.message : e),
      },
      iterations: 0,
      text: '',
      envelopeCount: 0,
      durationMs: Date.now() - t0,
      diagnostics,
    };
  } finally {
    if (agent && opts.spawnAgent) {
      try {
        await agent.stop();
      } catch {
        // best-effort — driver may have already triggered cancel
      }
    }
    try {
      await ownedManager?.dispose();
    } catch {
      // best-effort — cleanup must not replace the tool result
    }
  }
}

export async function spawnElanousAutopilotAgent(
  backend: string,
  cwd: string,
  createAgent?: (opts: AcpAgentOpts) => AcpAgent,
  agentManager?: Pick<AcpAgentManager, 'getAgent'>,
): Promise<AcpAgent> {
  const agentOpts: Omit<AcpAgentOpts, 'backendId'> = {
    cwd,
    log: (message) => debug.log('elanous-autopilot-launch', 'agent-log', { backend, message }),
  };
  if (createAgent) {
    const agent = createAgent({ backendId: backend, ...agentOpts });
    try {
      await agent.start();
    } catch (error) {
      await agent.stop().catch(() => {});
      throw error;
    }
    return agent;
  }
  if (!agentManager) throw new Error('agentManager-required');
  return agentManager.getAgent(backend, agentOpts);
}

function clampIntInclusive(
  raw: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < min || n > max) return fallback;
  return n;
}

type ElanousAutopilotLaunchDispatcher = (
  args: ElanousAutopilotLaunchArgs,
) => Promise<ElanousAutopilotLaunchResult>;

let runtimeDispatcher: ElanousAutopilotLaunchDispatcher = dispatchElanousAutopilotLaunch;

/** Test seam for the default runtime's harness dispatcher. */
export function setElanousAutopilotLaunchRuntimeDispatcherForTest(
  dispatcher?: ElanousAutopilotLaunchDispatcher,
): void {
  runtimeDispatcher = dispatcher ?? dispatchElanousAutopilotLaunch;
}

export const elanousAutopilotLaunchRuntime: ToolRuntime<
  ElanousAutopilotLaunchArgs,
  ElanousAutopilotLaunchResult
> = {
  id: 'elanous_autopilot_launch',
  spec: buildElanousAutopilotLaunchTool(),
  async run(req) {
    return runtimeDispatcher(req);
  },
};
