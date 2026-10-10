// ── elanous → codex PTY RFC mission driver ──
//
// ROADMAP-elanous-is-all-pty-unified-autonomy §1 3차(역전): 엘라누스가 codex 를 PTY 로 인보크해
// 미션을 RFC(입력→결과확인→재입력)로 완주시킨다.
//   - codex --yolo (무프롬프트) · 구독 모드(OPENAI_API_KEY 스크럽·API 과금 0)
//   - CWD→git worktree 분기(격리) · 브레인=elanous streamLLM(codex 화면 읽고 다음 행동 결정)
//   - 막히면 omni-crawl 자율 검색 → worktree 파일로 떨궈 codex 에 read 지시(TUI 멀티라인 회피)
//   - 증거 게이트(doc 존재 / tsc 0 / test pass)로 완료 판정 후 commit
// 재사용: startPty(Bun 네이티브 PTY)·createWorktree·streamLLM·worktreeHasChanges·commitWorktree.
import { execFileSync, spawnSync, spawn as spawnChild } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync, readlinkSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { startPty, mintPtyId, onPtyEvent, type PtyHandle, type StartOpts } from '../pty-shell/registry.js';
import { withChildPtyIdentity } from '../agent/pty-identity.js';
import { NESTED_AGENT_ENV_BLOCKLIST } from '../agent/nested-agent-env.js';
import { getNestDepth } from '../agent/nest-depth.js';
import { gateNestedElanousLaunch, nestedDepthCodexArgs, readNestedElanousDepth } from '../harness/nested-elanous-policy.js';
import { createWorktree, resolveMainRepoRoot, type CreateWorktreeOpts } from '../git-fs/worktree.js';
import { configuredWorktreeRoot, getUserConfig } from '../user-config.js';
import { worktreeHasChanges, commitWorktree, changedFiles } from '../self-implement/seams.js';
import { streamLLM, type LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { emitPtyDecision, type DecisionInput } from './pty-decision.js';
import { observeExternalEvent } from '../context-bus/external-events.js';
import { emitSessionEvent, type SessionEventInput } from '../context-bus/session-events.js';
import { emitDecision } from '../live/detail-switch.js';
import { resolvePtyWebAddress } from '../cli/pty-web-address.js';
import { verdictForFinalPtyScreen } from '../cli/pty-drive-verdict.js';
import { reemitPtyUsage } from '../budget/pty-usage-reemit.js';
import { classifyAuthError } from '../oauth/codex.js';
import { normalizeFallbackChain, type FallbackStep } from '../oauth/fallback-chain.js';
import { runPtyControlLoop, controlDepsForHandle, type ControlDecision, type ControlObservation, type RunSupervisor } from '../autopilot/pty-control-loop.js';
import { probeControlStance, stanceBlocksWrite } from '../pty-shell/pty-control-stance.js';
import { mapControlStance, supervisionObservationFields } from '../self-implement/supervision-vocabulary.js';
import { createLlmControlBrain, type StreamLLMFn } from '../autopilot/llm-control-brain.js';
import { buildExecutorPtyRef, execSurfaceId } from '../self-implement/executor-contract.js';
import { runWithControlObserve } from '../capture/control-observe-adapter.js';
import { buildMissionProvision, sanitizeForPtyInput, type ProvisionRequest, type ProvisionResult } from './provision.js';
import { checkClaudeSubscription } from './claude-subscription.js';
import { handoffMission, waitForHumanLogin, type HandoffOperations } from './handoff.js';
import { dispatchOpenPullRequest } from '../tool-runtime/git-pr-runtime.js';
import { runClaudeHeadless } from './claude-headless.js';
import { installPluginInsideAgent, type PluginRequest, type PluginDeps } from './in-agent-plugin.js';
import { planMissionResources, type ResourceLadderDeps, type ResourcePlan } from './resource-ladder.js';
import { ensureRunId } from '../harness/harness-space.js';
import { recordHarnessWorktreeProvenance } from '../harness/harness-worktree-add.js';
import { resolveInstanceName } from '../instance-identity.js';
import { getChannelBus } from '../terminal-matrix/index.js';
import { envLiteral } from '../platform/env-literal.js';
import { publishSelfReportFrame } from '../capture/self-report-frame.js';
import { buildExecutorSelfReportFrame } from '../self-implement/executor-frame.js';
import { classifierFrameLines, classifyFrameState, type FrameState } from '../capture/frame-state-detect.js';
import { isKeyframeMoment, keyframePath, writeKeyframePng } from '../capture/keyframe-capture.js';
import type { ChannelBus } from '../terminal-matrix/channel-bus.js';
import {
  parseTestOutput, parseBrainDecision, screenNeedsTrust,
} from './parse.js';
import { assessTypecheckExecution, tscEnv, type TypecheckError } from '../typecheck-ratchet.js';
import { classifyAgainstBaseline } from '../self-implement/gate-baseline.js';
import type { IngestionEntry } from '../agent-substrate/execution/ingestion-policy.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PTY 미션의 «벽시계» 상수 — 기본값이 운영 동작이다.
 *  ⭐ GATE-SPEED ③(2026-10-08): 가짜 PTY 시험이 시험마다 준비 대기 1.5 s ⊕ 키 간격 0.8 s 를 «실제로» 잤다
 *  (driver.test.ts 74건 · 게이트 423 s). 시험은 `setAgentMissionTimingForTest` 로 줄이고 끝나면 되돌린다.
 *  ⛔ 운영 경로는 이 함수를 부르지 않는다 — 값은 아래 기본값 그대로다. */
interface AgentMissionTiming {
  /** 준비·신뢰 화면이 «조용해졌다»로 보는 무출력 시간. */
  readyQuietMs: number;
  /** waitForQuiet 의 폴링 간격. */
  pollMs: number;
  /** 미션 문면과 Enter 사이 간격(TUI 가 붙여넣기를 한 덩어리로 받게). */
  keystrokeGapMs: number;
  /** 자원 사다리 시한 타이머 — 시험은 ms 를 기록하고 즉시 쏠 수 있다. */
  scheduleTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}
const DEFAULT_AGENT_MISSION_TIMING: AgentMissionTiming = {
  readyQuietMs: 1500,
  pollMs: 300,
  keystrokeGapMs: 800,
  scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
};
let missionTiming: AgentMissionTiming = DEFAULT_AGENT_MISSION_TIMING;
/** 시험 전용 심 — 바꾼 값을 되돌리는 함수를 돌려준다. */
export function setAgentMissionTimingForTest(over: Partial<AgentMissionTiming>): () => void {
  const previous = missionTiming;
  missionTiming = { ...previous, ...over };
  return () => { missionTiming = previous; };
}

/** Terminate the PTY process and every descendant found before signalling it. */
export async function terminateMissionProcessTree(rootPid: number, deps: {
  processTable?: () => string;
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  wait?: (ms: number) => Promise<void>;
} = {}): Promise<number[]> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
  const processTable = deps.processTable ?? (() => execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }));
  const children = new Map<number, number[]>();
  try {
    for (const line of processTable().split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      const siblings = children.get(ppid) ?? [];
      siblings.push(pid);
      children.set(ppid, siblings);
    }
  } catch (error) {
    debug.log('agent-mission', 'process-tree-snapshot-failed', { rootPid, error: String(error) }, { level: 'warn' });
  }
  const visited = new Set<number>();
  const order: number[] = [];
  const collect = (pid: number): void => {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const child of children.get(pid) ?? []) collect(child);
    order.push(pid);
  };
  collect(rootPid);
  for (const pid of order) {
    try { signal(pid, 'SIGTERM'); } catch { /* The process may already have exited. */ }
  }
  await (deps.wait ?? sleep)(2000);
  for (const pid of order) {
    try {
      signal(pid, 0);
      signal(pid, 'SIGKILL');
    } catch { /* The process has exited or is no longer accessible. */ }
  }
  return order;
}

/** Bounded classifier-compatible screen tail retained with each screen observation. */
export const SCREEN_LOG_TAIL_MAX_LINES = 10;
/** Maximum code points retained for each logged screen-tail line. */
export const SCREEN_LOG_TAIL_MAX_LINE_LENGTH = 160;

/** Builds the bounded screen payload without changing the screen used for control or classification. */
export function buildScreenLogPayload(label: string, screen: string): {
  label: string;
  chars: number;
  tail: string[];
  tailTruncated: boolean;
} {
  let tailTruncated = false;
  const tail = classifierFrameLines(screen).slice(-SCREEN_LOG_TAIL_MAX_LINES).map((line) => {
    const chars = [...line];
    if (chars.length <= SCREEN_LOG_TAIL_MAX_LINE_LENGTH) return line;
    tailTruncated = true;
    return chars.slice(0, SCREEN_LOG_TAIL_MAX_LINE_LENGTH).join('');
  });
  return { label, chars: screen.length, tail, tailTruncated };
}

export type EvidenceMode =
  | { kind: 'doc'; glob: RegExp; dirRel: string }          // 문서 산출(플랜 등)
  | { kind: 'tsc' }                                         // 변경 + tsc 0
  | { kind: 'test'; testPath: string; fileRel?: string };   // 변경 + tsc 0 + 특정 test pass

// ── Agent backend (agent-agnostic PTY RFC) ──
//   elanous 이 PTY 로 모는 코딩 에이전트를 교체 가능하게 추상화. 지금은 codex, 이후 claude/gemini/grok 확장.
//   (폴더/개념이 codex-mission 이던 것을 agent-mission 으로 일반화 — driver 는 backend 만 바꾸면 된다.)
export interface AgentBackend {
  name: 'codex' | 'claude' | 'gemini' | 'grok' | 'aside';
  /** PTY 실행 커맨드/인자. */
  cmd: string;
  args: string[];
  /** 구독 모드 위해 스크럽할 env 키(API 과금 회피). */
  scrubEnv?: string[];
  /** 초기 신뢰/권한 프롬프트 처리 — 스크린 보고 필요 시 키 입력. 처리했으면 true. */
  handleTrust?(screen: string, write: (s: string) => void): boolean;
}

/** codex --yolo 백엔드(구독 모드·trust=1). 첫 backend. */
export const codexBackend: AgentBackend = {
  name: 'codex',
  cmd: 'codex',
  // 🩸 09-26: 시작 때 «Update available» 창이 떴고 미션 두뇌의 Enter 가 `brew upgrade --cask codex` 를 돌려 codex 가 스스로
  //    종료했다(pty-mission-failed). 도는 중의 판 교체는 다른 codex 프로세스의 짝 바이너리(code-mode-host)까지 지운다 —
  //    같은 날 옛 app-server(0.154.0)가 «지워진 폴더»에서 짝을 찾다 도구 실행을 전부 잃었다. 자식은 업데이트를 묻지 않는다.
  args: ['--yolo', '-c', 'check_for_update_on_startup=false'],
  scrubEnv: ['OPENAI_API_KEY'],
  handleTrust: (screen, write) => {
    if (screenNeedsTrust(screen)) { write('1\r'); return true; }
    return false;
  },
};

// ── U3: claude/gemini/grok PTY backend 실구현 ──
//   각 CLI 의 인터랙티브 PTY 모드를 auto-approve 플래그로 열어(codex --yolo 와 동형) 컨트롤 브레인이
//   화면을 보며 몰 수 있게 한다. API 키는 scrubEnv 로 제거해 구독(oauth) 모드 강제(과금 회피·codex 패턴).
//   플래그 출처(각 CLI --help): claude=--dangerously-skip-permissions · gemini=--yolo(전툴 자동승인) ·
//   grok=--always-approve(전툴 자동승인).
//   ⚠️ handleTrust 는 codex 전용(응답키 '1\r' 은 codex 메뉴 고유) — 다른 CLI 의 첫 trust/확인 화면
//   응답키는 미검증이라 fabricate 하지 않는다(잘못된 키 주입이 무처리보다 나쁨). auto-approve 플래그가
//   툴 권한 스트림을 우회하고, 첫 확인 화면은 LLM 컨트롤 브레인이 관측·응답한다. 결정론 fast-path 는
//   백엔드별 도그푸드 후 추가(선택 실증 스코프 = 선택·spawn 정합).

// scrubEnv 는 구독(oauth) 모드를 우선시키기 위해 각 CLI 의 알려진 과금 경로 env 를 스크럽한다(대표: 과금
//   회피). 단일 API 키만 지우면 대체 인증(Anthropic AUTH_TOKEN·Bedrock/Vertex 스위치·Gemini Vertex/ADC)
//   이 새어 과금될 수 있으므로 프로바이더 스위치·대체 토큰까지 지워 남는 경로를 oauth 로그인으로 좁힌다.
//   ⚠️ "알려진 경로"까지의 보장 — CLI 가 새 과금 env 를 추가하면 추적 필요(flag/scrub drift 는 테스트로 감시).

/** claude Code 백엔드 — --dangerously-skip-permissions(권한 자동)·구독(oauth) 모드.
 *  scrub: API 키 + 대체 인증 토큰(ANTHROPIC_AUTH_TOKEN) + 프로바이더 스위치(Bedrock/Vertex/Foundry) → oauth 로 좁힘.
 *  CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY 가 unset 이면 다른 provider 의 creds 가 있어도 그 경로로 라우팅되지 않는다. */
export const claudeBackend: AgentBackend = {
  name: 'claude',
  cmd: 'claude',
  args: ['--dangerously-skip-permissions'],
  // CLAUDE_CODE_OAUTH_TOKEN: a launching Claude Code session exports its own token; the child must use the
  //   machine's stored login, never the parent session's (09-29 🅞: status read `oauth_token` → «api-key» · 대표 R2).
  scrubEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  // 🩸 09-29 S6: new worktree → «Accessing workspace … ❯ No, exit / Yes, I trust this folder». The default is «No», so
  //    the brain spent all 16 steps on this screen. Move to «Yes» (↓) then confirm (Enter) on the next observation —
  //    the worktree is an isolated tree elanous created (same reasoning as agy).
  handleTrust: (screen, write) => {
    const choice = claudeTrustChoice(screen);
    if (choice === 'no-selected') { write('\x1b[B'); return true; }
    if (choice === 'yes-selected') { write('\r'); return true; }
    return false;
  },
};

/** claude reads «text + Enter» arriving in one chunk as a paste, so the Enter becomes a newline and nothing is sent
 *  (09-29 실물: three brain inputs piled up in the input box). Send the text, then Enter on its own a moment later. */
export function submitSeparately(inject: (text: string) => boolean, delay: (fn: () => void) => void = (fn) => { setTimeout(fn, 250); }): (text: string) => boolean {
  return (text) => {
    if (text.length < 2 || !/\r$/.test(text)) return inject(text);
    if (!inject(text.slice(0, -1))) return false;
    delay(() => { inject('\r'); });
    return true;
  };
}

/** claude 첫 화면의 폴더 신뢰 메뉴 — 어느 줄이 선택돼 있나(기본 선택 = «No, exit»). */
export function claudeTrustChoice(screen: string): 'no-selected' | 'yes-selected' | null {
  if (!/Yes, I trust this folder/.test(screen) || !/(?:Accessing workspace|Quick safety check)/.test(screen)) return null;
  if (/^\s*[❯>]\s*(?:\d+\.\s*)?Yes, I trust this folder/m.test(screen)) return 'yes-selected';
  if (/^\s*[❯>]\s*(?:\d+\.\s*)?No, exit/m.test(screen)) return 'no-selected';
  return null;
}

/** gemini 백엔드 — ⭐ 실행체는 **Antigravity CLI(`agy`)** 다(대표 2026-08-18 결정).
 *
 *  ⛔⭐⭐⭐ 왜 `gemini` 가 아닌가 — ***그 CLI 는 «죽었다»***(2026-08-19 라이브 실측):
 *    `gemini -p "…"` ⇒ IneligibleTierError · ineligibleTiers=[{ reasonCode:'UNSUPPORTED_CLIENT',
 *      tierId:'free-tier', tierName:'Gemini Code Assist for individuals' }]
 *      "This client is no longer supported … migrate to the Antigravity suite of products"
 *    ⚠️ 그런데 «인증만» 보면 산다 — cloudcode-pa.googleapis.com:loadCodeAssist 는 HTTP 200 을 낸다.
 *      ⇒ 📌 ***「인증이 산다」와 「쓸 수 있다」는 다른 값이다.*** 200 을 보고 「된다」고 읽지 마라.
 *    📄 배경·측정 = 내부 문서 `RFC-gemini-to-antigravity-cli-migration-2026-08-18` §4e-0
 *
 *  ⭐ 이름(`gemini`)은 «그대로 둔다»(대표 지시) — provider id·brand·budget·router 20+ 자리가 그 낱말을
 *    쓰고, 그것들은 이 backend 와 «다른 축»이다. 바뀌는 것은 «실행체»뿐이다.
 *
 *  🙋 ⛔ **사람 칸이 하나 있다** — `agy` 는 자기 OAuth 를 요구한다(client_id·redirect_uri 가 gemini-cli 와
 *    «다르다» · scope 에 aicode 포함). `~/.gemini/oauth_creds.json` 을 «안 쓴다».
 *    ⇒ 사람이 `agy` 를 한 번 띄워 로그인해야 자식이 무인으로 돈다. 그 전에는 자식이
 *      "Authentication required. Please visit the URL to log in:" 으로 «이름을 대고» 멎는다.
 *
 *  scrub: API 키(GEMINI/GOOGLE) + Vertex/ADC 트리거 → 과금 경로 차단, 남는 건 구독 로그인.
 *    ⚠️ agy 도 `GEMINI_API_KEY` 를 «본다»(CHANGELOG 1.1.13) — 그래서 이 목록이 여전히 필요하다. */
export const geminiBackend: AgentBackend = {
  name: 'gemini',
  cmd: 'agy',
  args: ['--dangerously-skip-permissions'],
  scrubEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
  // 🩸 09-27(agy 1.2.12): 새 워크트리마다 «Do you trust the contents of this project?» 메뉴가 먼저 뜨고 첫 줄이
  //    «> Yes, I trust this folder» 다. 처리가 없어 미션 문장이 이 메뉴로 들어가 사라졌고, 두뇌가 약 10분 뒤에야
  //    다시 보냈다(탐침 run 06:03 → 06:13). 기본 선택(신뢰)을 Enter 로 고른다 — 워크트리는 elanous 가 만든 격리 트리다.
  handleTrust: (screen, write) => {
    if (agyNeedsTrust(screen)) { write('\r'); return true; }
    return false;
  },
};

/** agy 첫 화면의 폴더 신뢰 메뉴(기본 선택 = 신뢰). */
export function agyNeedsTrust(screen: string): boolean {
  return /Do you trust the contents of this project\?/.test(screen) && /Yes, I trust this folder/.test(screen);
}

/** xAI grok Build CLI 백엔드 — --always-approve(전툴 자동승인)·구독(grok login) 모드.
 *  scrub: XAI/GROK API 키 전부 → 남는 인증 = ~/.grok/auth.json(grok login oauth).
 *  ⚠️ 바이너리는 xAI install.sh 가 ~/.grok/bin/grok 에 둔다 — cron/launchd 최소 PATH 에선 ensure-bin-path
 *  보강 필요할 수 있음(codex 와 동일하게 cmd 는 PATH 해석). */
export const grokBackend: AgentBackend = {
  name: 'grok',
  cmd: 'grok',
  args: ['--always-approve'],
  scrubEnv: ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'],
};

/** Aside Browser agent backend — `aside exec --help` confirms `--effort low`; `ultrabrowse` enables the highest thinking level and proactive mode. */
export const asideBackend: AgentBackend = {
  name: 'aside',
  cmd: 'aside',
  args: ['exec', '--effort', 'low'],
  // Aside uses its selected account; cost control is the explicit CLI effort flag, not environment-variable scrubbing.
  scrubEnv: [],
};

const AGENT_BACKENDS: Record<string, AgentBackend> = {
  codex: codexBackend,
  claude: claudeBackend,
  gemini: geminiBackend,
  grok: grokBackend,
  aside: asideBackend,
};

const FORCED_ENV_BY_BACKEND: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  grok: { GROK_DISABLE_API_KEY_AUTH: '1' },
};

/**
 * 선택된 backend 로 PTY spawn 에 넘길 파라미터(cmd·args·env)를 구성한다(순수·테스트 seam).
 * env 는 baseEnv 복사 후 backend.scrubEnv 키와 공용 중첩-실행 표지를 각각 제거한다. 전자는 지정 backend 의 알려진
 * 과금 경로(API 키·대체 인증·프로바이더 스위치)를 좁혀 구독(oauth) 모드를 우선하고, 후자는 부모 중첩 상태가 PTY 자식에
 * 전파되지 않게 한다. backend 강제 env 는 스크럽 뒤에 적용하되 바깥에서 설정한 값은 보존한다. driver 의 실 spawn 은 이
 * 결과에 TERM·ELANOUS_RUN_ID 만 덧댄다.
 * 이 함수로 "선택 → spawn 파라미터" 실행경로가 백엔드별로 단위 검증된다(U3 선택 실증).
 */
export function resolveBackendSpawn(
  backend: AgentBackend,
  baseEnv: Record<string, string | undefined>,
): { cmd: string; args: string[]; env: Record<string, string>; unsetEnv: string[]; nestedEnvRemovedCount: number; forcedEnv: string[] } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v != null) env[k] = v;
  for (const k of backend.scrubEnv ?? []) delete env[k];
  const forcedEnv: string[] = [];
  for (const [key, value] of Object.entries(FORCED_ENV_BY_BACKEND[backend.name] ?? {})) {
    if (!(key in env)) {
      env[key] = value;
      forcedEnv.push(key);
    }
  }
  let nestedEnvRemovedCount = 0;
  for (const key of NESTED_AGENT_ENV_BLOCKLIST) {
    if (key in env) {
      delete env[key];
      nestedEnvRemovedCount += 1;
    }
  }
  // 지운 키 이름 — PTY 합성이 로그인 셸 캡처본에서 되살리지 않게 그대로 넘긴다(강제 env 로 다시 넣은 키는 뺀다).
  //   ⚠️ 과금 스크럽 키만 — 중첩 표지는 정체성 allowlist 가 다시 싣는 키가 있어 이 PR 의 범위 밖이다.
  const unsetEnv = [...new Set(backend.scrubEnv ?? [])].filter((k) => !(k in env));
  // Codex drops parent env under shell_environment_policy inherit=core, so the nested-depth
  // marker rides on argv (`-c shell_environment_policy.set.ELANOUS_NESTED_DEPTH="<child>"` — TOML 문자열).
  // Backends that cannot carry it are refused only when a nested elanous launch was requested.
  const args = [...backend.args, ...nestedDepthCodexArgs(backend.name, getNestDepth() + 1)];
  return { cmd: backend.cmd, args, env, unsetEnv, nestedEnvRemovedCount, forcedEnv };
}

/** Claude's strict MCP override is per-child; never edit the user's Claude settings. */
export function prepareClaudeChildSpawn(
  spawn: ReturnType<typeof resolveBackendSpawn>,
  options: { readonly backendName: string; readonly depth: number; readonly allowNestedElanous: boolean; readonly tempRoot?: string },
): { readonly args: string[]; readonly cleanup: () => void; readonly configPath?: string } {
  // Backend identity, not the command string — an absolute-path claude binary is still the Claude backend.
  if (options.backendName !== 'claude' || (options.depth === 0 && options.allowNestedElanous)) {
    return { args: [...spawn.args], cleanup: () => {} };
  }
  const dir = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'elanous-claude-mcp-'));
  try {
    const configPath = join(dir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    return { args: [...spawn.args, '--strict-mcp-config', '--mcp-config', configPath], configPath,
      cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Refuse a requested nested elanous launch when this backend cannot carry the depth marker.
 * Unset depth is 0. A normal mission spawn (`nestedLaunchRequested: false`) is never refused here.
 */
export function refuseNestedElanousOnBackend(input: {
  readonly backendName: string;
  readonly nestedLaunchRequested: boolean;
  readonly allow?: boolean;
  readonly configAllow?: boolean;
  readonly env?: Record<string, string | undefined>;
}): { readonly refused: boolean; readonly reason?: string; readonly depth: number } {
  const depth = readNestedElanousDepth(input.env);
  const decision = gateNestedElanousLaunch({
    backendName: input.backendName,
    depth,
    nestedLaunchRequested: input.nestedLaunchRequested,
    ...(input.allow === true ? { allow: true } : {}),
    ...(input.configAllow === true ? { configAllow: true } : {}),
  });
  if (input.nestedLaunchRequested && !decision.allowed) {
    return { refused: true, reason: decision.reason, depth };
  }
  return { refused: false, depth };
}

/** Build the mission PTY options after identity is preallocated for child env propagation. */
export function buildAgentMissionPtySpawnOptions(opts: {
  readonly backend: AgentBackend;
  readonly spawn: { cmd: string; args: string[]; env: Record<string, string>; unsetEnv?: readonly string[] };
  readonly workdir: string;
  readonly nickname: string;
}): StartOpts {
  const id = mintPtyId(opts.backend.name);
  return {
    id,
    cmd: opts.spawn.cmd,
    args: opts.spawn.args,
    workdir: opts.workdir,
    env: withChildPtyIdentity(opts.spawn.env, id),
    ...(opts.spawn.unsetEnv?.length ? { unsetEnv: opts.spawn.unsetEnv } : {}),
    cols: 110,
    rows: 40,
    kind: opts.backend.name,
    nickname: opts.nickname,
    accessMode: 'auto',
  };
}

/** 등록된 agent backend 이름들(CLI 안내·에러 메시지·확장 검증용). */
export function agentBackendNames(): string[] {
  return Object.keys(AGENT_BACKENDS);
}

/**
 * ⛔⭐⭐ **백엔드를 «미지정»으로 뒀을 때 — codex 가 소진됐으면 체인의 다음 칸으로.**
 *
 * 왜 여기인가: `resolveBackend()` 의 「미지정 → codex」가 이 저장소에서 codex 축이 끝나는
 * 유일한 «선택» 지점이다. 판정기(`fallback-chain.ts`)를 만들어 놓고 안 꽂으면 그것이
 * 이 저장소가 이름 붙인 **F38(심은 뚫려 있고 꽂는 사람이 없다)** 이다.
 *
 * ⛔ 불변식 셋(윗 모듈에서 그대로 이어받는다):
 *   ① **사람이 이름을 «명시»했으면 이 함수는 «안» 불린다** — 의도가 이긴다(호출자가 위에서 갈린다).
 *   ② **기본 체인은 `['codex-rotate', 'grok']`** 이며 claude-pty 는 명시 구성에서만 선택된다.
 *   ③ **조용히 바꾸지 않는다** — 바꿨으면 관측에 남긴다. 조용한 폴백은 이 파일이 이미
 *      거부한 형태다(위 `resolveBackend` 주석: *"조용한 codex 폴백은 애그노스틱 위반"*).
 *
 * ⛔ 판정 실패는 삼킨다 — 체인 때문에 백엔드가 «안 뜨는» 일은 없어야 한다. 그때는 codex.
 */
export function resolveDefaultBackend(
  /** ⛔ 테스트 심 — 실 스토어·실 자격 없이 판정을 주입한다. */
  deps: { readonly decide?: () => { action: string; backend?: string } } = {},
): AgentBackend {
  try {
    const decide = deps.decide
      ?? (() => {
        // ⛔ 지연 로드 — 이 모듈은 부팅 초기에 읽히는데 oauth 축은 스토어·config 를 건드린다.
        //   정적 import 로 끌어오면 「백엔드 이름 하나 물어보려다」 디스크를 깨우게 된다.
        const { resolveRunFallback } = require('../oauth/codex-account-store.js') as typeof import('../oauth/codex-account-store.js');
        return resolveRunFallback();
      });
    const decision = decide();
    if (decision.action === 'switch-backend' && (decision.backend === 'grok' || decision.backend === 'claude')) {
      debug.log('agent-mission.backend', 'fallback-switch', { from: 'codex', to: decision.backend, reason: 'codex-exhausted' });
      return decision.backend === 'claude' ? claudeBackend : grokBackend;
    }
  } catch (err) {
    debug.log('agent-mission.backend', 'fallback-failed', { message: (err as Error)?.message }, { level: 'warn' });
  }
  return codexBackend;
}

/**
 * 이름으로 backend 해석. **미지정 → 디폴트 codex**(외부 에이전트 파이프라인 기본값·대표 허용).
 * ⚠️ U1(솔루션 애그노스틱) — **명시 지정한 미등록 backend 는 조용히 codex 로 폴백하지 않고 명시 에러**.
 *   조용한 폴백은 "선택 계약이 애그노스틱한 척하고 실배선은 codex 하나"인 것을 은폐한다(대표 지적:
 *   "지정해도 못 쓰는 게 결함"). U3 에서 claude/gemini/grok 실등록 완료(codex/claude/gemini/grok).
 *   설계 = [[PLAN-unified-selfdev-cli-runDevPipeline-2026-07-25]] §3/§7 U1/U3.
 */
export function resolveBackend(name?: string): AgentBackend {
  const key = name?.trim();
  if (!key) return resolveDefaultBackend(); // 미지정/빈값/공백 = 디폴트 codex (⊕ 소진 시 체인)
  const b = AGENT_BACKENDS[key];
  if (!b) {
    throw new Error(
      `알 수 없는 agent backend '${key}'. 등록된 backend: ${agentBackendNames().join(', ')}. ` +
      `조용한 codex 폴백은 애그노스틱 위반이라 차단.`,
    );
  }
  return b;
}

/** ⛔ export 하지 않는다 — 소비자가 «이 파일 안»뿐이다(무인 리뷰 must-fix).
 *  ⭐ 이 저장소가 오늘 여러 번 본 형태다: 「만들었는데 아무도 안 부르는 공개 표면」.
 *  외부 계약이 «실제로» 필요해지면 그때 export 한다. */
interface RuntimeFallbackState {
  readonly attemptedSteps: ReadonlySet<FallbackStep>;
  readonly descents: number;
  readonly maxDescents: number;
}

interface RuntimeFallbackContext extends RuntimeFallbackState {
  readonly fallbackEligible: boolean;
}

/** 초기 백엔드의 체인 위치부터 남은 칸만 재시도한다. 실제 전환은 각 칸의 판정이 허용해야 한다. */
export function initialRuntimeFallback(backend: AgentBackend, chain: readonly FallbackStep[]): RuntimeFallbackContext {
  const step: FallbackStep = backend.name === 'grok' ? 'grok' : backend.name === 'claude' ? 'claude-pty' : 'codex-rotate';
  const position = chain.indexOf(step);
  return {
    fallbackEligible: true,
    attemptedSteps: new Set<FallbackStep>([step]),
    descents: 0,
    // 초기 칸이 체인에 «없으면»(예: chain=['grok'] 인데 기본 codex 로 떴다) 체인 전체가 남은 칸이다 —
    // 종전(codex 면 1칸)보다 줄이지 않는다.
    maxDescents: position < 0 ? chain.filter((s) => s !== step).length : chain.length - position - 1,
  };
}

/** 한도 실패에만 재판정한다. 새·미시도 체인 칸과 최초 남은 칸 상한을 모두 만족해야 이동한다. */
export function decideRuntimeFallback(
  failure: unknown,
  currentStep: FallbackStep,
  state: RuntimeFallbackState,
  decide: (input: { currentStep: FallbackStep; currentCredentialRateLimited: true }) => { action: string; backend?: string },
): AgentBackend | null {
  if (classifyAuthError(failure).errorKind !== 'rate-limited' || state.descents >= state.maxDescents) return null;
  const decision = decide({ currentStep, currentCredentialRateLimited: true });
  if (decision.action !== 'switch-backend') return null;
  const nextStep = decision.backend === 'grok' ? 'grok' : decision.backend === 'claude' ? 'claude-pty' : null;
  if (!nextStep || state.attemptedSteps.has(nextStep)) return null;
  return nextStep === 'claude-pty' ? claudeBackend : grokBackend;
}

export interface AgentMissionSpec {
  /** 에이전트에 보낼 미션 프롬프트(마지막 줄에 MISSION-COMPLETE 지시 포함 권장). */
  mission: string;
  /** repo 루트(기본: CWD 에서 resolveMainRepoRoot). */
  repo?: string;
  /** 새 worktree 브랜치명. workdir 모드에서는 관측 라벨(선택). */
  branch?: string;
  /** 저장소 worktree 대신 직접 실행할 비-git 작업 폴더. */
  workdir?: string;
  /** 호출자의 벽시계 마감/취소 신호. */
  signal?: AbortSignal;
  /** 분기 base(기본 HEAD). 이전 미션 산출 위에 쌓으려면 그 브랜치명. */
  base?: string;
  /** 완료 증거 판정. */
  evidence: EvidenceMode;
  /** RFC 최대 라운드(기본 16). */
  maxRounds?: number;
  /** 화면 무변화 회복 문턱(ms, 기본 45초). */
  recoverAfterMs?: number;
  /** 완료 시 자동 commit(기본 true). */
  commit?: boolean;
  /** 스크린 캡처 저장 디렉토리. */
  screensDir?: string;
  /** omni-crawl main.ts 경로. */
  omniCrawlPath?: string;
  /** 구동할 에이전트 backend(기본 codexBackend). claude/gemini/grok 확장점. */
  agent?: AgentBackend;
  /** Claude CLI 비대화형 stream-json 실행. 다른 backend 에서는 거부. */
  headless?: boolean;
  /** Install in the agent's own UI before sending the mission. */
  plugin?: Pick<PluginRequest, 'plugin' | 'marketplace'>;
  /** Pre-mission resource judgment; off skips it. */
  resources?: 'on' | 'off';
  /** Only the caller's explicit backend selection, not the resolved default. */
  backendExplicit?: string;
  /** Explicit backend sequence; transitions use the same handoff coordinator as brain decisions. */
  chain?: readonly ('codex' | 'claude' | 'elanous')[];
  /**
   * ★ elanous 내부 프롬프트 인핸싱(가산·anti-drift) — 원문 verbatim 보존 + 커버리지 체크리스트 부착.
   * 명시 override(undefined 면 entry 정책이 결정: elanous-apparatus→ON·external-verbatim→OFF·§6e capability 구동).
   * 켜면 mission 을 파일(.mission-prompt.md)로 떨궈 에이전트에 read 지시(TUI 멀티라인 페이스트 위험 회피).
   */
  enhance?: boolean;
  /** ★ 진입 클래스(§6e·capability 구동) — enhance mode-gating. 기본 elanous-apparatus(elanous 가 원문 prep→ON).
   *  외부 에이전트가 프롬프트를 직접 크래프트했거나 상위 elanous 중첩이면 external-verbatim(→OFF). */
  entry?: IngestionEntry;
  /** 인핸싱 산출물 유형 힌트(예: 'PPT 발표덱', 'PLAN 문서'). */
  deliverableHint?: string;
  /**
   * ★ entry-independent 기억 주입(PLAN §6e FIX) — elanous 기억을 가산 grounding 컨텍스트로(프롬프트 무접촉·
   * 인핸싱과 독립). 어떤 진입이든 기본 ON(false 로만 끔). external-verbatim(인핸싱 OFF)에서도 원문 안 건드림.
   */
  memory?: boolean;
  /** PTY 닉네임(휴먼 리더블·goto 로 나중 접근). 기본 branch. */
  nickname?: string;
  /**
   * True only when this mission is itself a nested elanous launch.
   * A backend that cannot carry the depth marker is then refused.
   * Absent means an ordinary mission spawn — never refused for a missing marker.
   */
  nestedElanousLaunch?: boolean;
  /** Explicit depth-0 allow from the caller (e.g. `--nested-elanous allow`). Ignored at depth >= 1. Config `harness.nestedElanous` also counts at depth 0. */
  nestedElanousAllow?: boolean;
  /** Concurrent missions may share one decision stream alias without sharing a PTY or worktree. */
  decisionMissionId?: string;
  /** ⭐⭐ 그 브랜치를 이미 쥔 «소유» 워크트리가 있으면 지우지 말고 그대로 재사용하라고 요청한다
   *  (`createWorktree` 의 같은 이름 인자로 그대로 내려간다 · 판정은 거기 `gateWorktreeReuse` 가 한다).
   *
   *  왜: 외부 에이전트 백엔드로 PR 을 낸 뒤 그 PR 의 리뷰 수리 라운드를 «같은 브랜치»에 이어 붙이려 하면
   *  종전엔 워크트리 생성에서 막혀 사람이 손으로 지우고 다시 쏴야 했다(실측 2026-08-11).
   *
   *  ⛔ 기본은 미지정 = **종전 그대로**(재사용 요청 없음 → 이미 쥔 워크트리가 있으면 거부/리셋).
   *     안전장치를 «푸는» 스위치이므로 호출자가 명시할 때만 실린다 — 여기서 조건을 완화하지 않는다. */
  reuseOwnedWorktree?: boolean;
}
/** @deprecated codex 특정 이름 — agent-agnostic 리네임. AgentMissionSpec 을 쓰라. */
export type CodexMissionSpec = AgentMissionSpec;

export interface AgentMissionResult {
  ok: boolean;
  worktree: string;
  branch: string | null;
  reason?: 'aborted' | 'outside-write' | 'origin-not-github';
  pr?: 'skipped';
  paths?: string[];
  rounds: number;
  evidencePath: string | null;
  /** The evidence check outcome, independent of the final mission and DRIVE-OK verdicts. */
  evidenceSatisfied?: boolean;
  committed: boolean;
  usedOmniCrawl: boolean;
  detail: string;
  ptyId?: string;
  webUrl?: string | null;
  driveVerdict?: ReturnType<typeof verdictForFinalPtyScreen>['kind'];
}
/** @deprecated codex 특정 이름 — AgentMissionResult 을 쓰라. */
export type CodexMissionResult = AgentMissionResult;

/** Test seams for the mission boundary; production defaults remain the registry and worktree implementations. */
export interface AgentMissionDeps {
  startPty?: (opts: StartOpts) => PtyHandle;
  createWorktree?: typeof createWorktree;
  recordWorktreeProvenance?: typeof recordHarnessWorktreeProvenance;
  runControlLoop?: typeof runPtyControlLoop;
  /** Capture decisions in tests without replacing the process-wide debug logger. */
  emitPtyDecision?: typeof emitPtyDecision;
  /** Inject controller responses while keeping the production control loop. */
  controlStream?: StreamLLMFn;
  resolvePtyWebAddress?: typeof resolvePtyWebAddress;
  resolveRunFallback?: (input: { currentStep: FallbackStep; currentCredentialRateLimited: true }) => { action: string; backend?: string };
  /** 재귀 재시도 사이에만 전달되는 런 로컬 폴백 진행 상태. */
  runtimeFallback?: RuntimeFallbackContext;
  reemitPtyUsage?: typeof reemitPtyUsage;
  checkClaudeSubscription?: typeof checkClaudeSubscription;
  runClaudeHeadless?: typeof runClaudeHeadless;
  checkEvidence?: typeof checkEvidence;
  commitWorktree?: typeof commitWorktree;
  dispatchOpenPullRequest?: typeof dispatchOpenPullRequest;
  /** Optional context-journal sink for isolated missions. */
  emitContextEvent?: (input: SessionEventInput) => void;
  /** Internal continuation retains the original mission's context-event owner. */
  contextEventRun?: boolean;
  /** Carries a PR number back to the outer mission's context event. */
  onMissionPrNumber?: (number: number) => void;
  terminateProcessTree?: typeof terminateMissionProcessTree;
  repoStatus?: (repo: string) => string | Promise<string>;
  emitDecision?: typeof emitDecision;
  onPtyStarted?: (handle: PtyHandle, stop: () => void) => void;
  onHeadlessStarted?: (pid: number, kill: () => void) => void;
  isMissionAborted?: () => boolean;
  awaitMission?: <T>(pending: Promise<T>) => Promise<T>;
  onControlPending?: (pending: Promise<unknown>) => void;
  onControlActive?: (pending: Promise<unknown>) => void;
  /** Upper bound for waiting on control stages after cancel (default 10s). */
  cancelDrainMs?: number;
  handoffOperations?: Partial<HandoffOperations>;
  /** Internal continuation: retain this exact worktree rather than calling createWorktree again. */
  handoffWorktree?: { path: string; branch: string; base: string };
  originalMission?: string;
  /** The last controller reason from the previous backend (not a PTY transcript). */
  previousSummary?: string;
  initialTsc?: ReturnType<typeof collectTscDiagnostics> | null;
  installPlugin?: typeof installPluginInsideAgent;
  pluginDeps?: PluginDeps;
  resourceLadder?: ResourceLadderDeps;
  planMissionResources?: typeof planMissionResources;
}

const DEFAULT_OMNI = `${process.env.HOME}/.claude/skills/omni-crawl/scripts/main.ts`;

// ── PTY idle 감지 ──
async function waitForQuiet(h: PtyHandle, quietMs: number, maxWaitMs: number): Promise<'quiet' | 'timeout' | 'exited'> {
  const start = Date.now(); h.drainDelta(); let last = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!h.isAlive()) return 'exited';
    const d = h.drainDelta();
    if (d.length > 0) last = Date.now();
    else if (Date.now() - last >= quietMs) return 'quiet';
    await sleep(missionTiming.pollMs);
  }
  return 'timeout';
}

// ── omni-crawl (자율 폴백) ──
// ⚠️ graceful — omni-crawl 은 `npx tsx` 외부 프로세스+네트워크라 실패가 흔하다(타임아웃·네트워크·JSON
//   파싱). 실패를 throw 하면 control loop 이 error termination 으로 미션 전체를 죽인다(회귀). 원본처럼
//   실패 메시지를 문자열로 반환해 context 로 기록하고 계속한다 — search 는 보조 폴백이지 미션 킬러가 아니다.
function omniCrawl(query: string, omniPath: string): string {
  try {
    // ⭐npx/tsx PATH 의존 제거(근본 동작 수리) — `npx tsx` 는 PATH 의 nvm bin + 전역 tsx 에 의존해,
    //   제한된 PATH(데몬/미션/self-implement child)서 ENOENT 로 죽던 근본(cron PATH 무음실패 계열).
    //   elanous 는 bun 런타임이고 bun 은 TS 를 네이티브 실행하므로(tsx 불필요), 현재 실행 파일 절대경로
    //   (process.execPath=bun)로 직접 돌린다 → PATH 무관·tsx 불필요·더 빠름. omni-crawl 은 자체 initEnv 로
    //   .env(절대경로)를 로드하니 API 키도 cwd/셸 env 와 무관하게 채워진다.
    const out = execFileSync(process.execPath, [omniPath, query, '--json', '--mode', 'deep'], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024,
    });
    const m = out.match(/---BEGIN_OMNI_CRAWL_JSON---([\s\S]*?)---END_OMNI_CRAWL_JSON---/);
    if (!m) return out.slice(-4000);
    const j = JSON.parse(m[1]!) as { results?: Array<{ engine: string; summary?: string; items?: Array<{ title: string; url: string; text?: string }> }> };
    const parts: string[] = [];
    for (const r of j.results ?? []) {
      if (r.summary) parts.push(`## ${r.engine}\n${r.summary}`);
      for (const it of (r.items ?? []).slice(0, 5)) parts.push(`- ${it.title} ${it.url}\n  ${(it.text || '').slice(0, 700)}`);
    }
    return parts.join('\n\n').slice(0, 8000);
  } catch (e) { return `omni-crawl 실패: ${(e as Error).message}`; }
}

export interface MissionSearchOpts {
  readonly worktree: string;
  readonly omniPath: string;
  readonly crawl?: (query: string, omniPath: string) => string;
}

/** omni-crawl 결과를 mission-local context로 영속한다. ⚠️search 는 미션 킬러가 아니다 — crawl(주입 포함)
 *  또는 파일쓰기가 실패해도 실패 메시지를 context 로 기록하고 계속한다(원본 graceful 시맨틱·미션 무중단). */
export function createMissionSearch(opts: MissionSearchOpts): (query: string, step?: number) => Promise<void> {
  const crawl = opts.crawl ?? omniCrawl;
  return async (query, step) => {
    debug.log('agent-mission', 'omni-crawl', { step, query: query.slice(0, 120) });
    let info: string;
    try { info = crawl(query, opts.omniPath); }
    catch (e) { info = `omni-crawl 실패: ${(e as Error).message}`; } // 주입 crawl 이 throw 해도 미션 무중단
    try { writeFileSync(join(opts.worktree, '.mission-context.md'), `# elanous 가 omni-crawl 로 수집한 정보\n\n${info}\n`); }
    catch (e) { debug.log('agent-mission', 'search-context-write-failed', { step, error: (e as Error).message }); } // 기록 실패를 관측 가능하게(계약 정합·review)
  };
}

// ── 증거 게이트 ──
type TscExecutor = (wt: string) => { ran: boolean; diagnostics: TypecheckError[]; failure?: string; output?: string };

type TypecheckBaselineResult = {
  readonly ok: boolean;
  readonly baselineErrors: number;
  readonly newErrors: string[];
  readonly failure?: string;
};

type EvidenceCheckDeps = {
  readonly baseline?: readonly TypecheckError[];
  readonly executeTsc?: TscExecutor;
  readonly runTest?: (wt: string, testPath: string) => { ok: boolean; out: string };
  readonly hasChanges?: (wt: string) => boolean;
  /** Worktree-relative paths this mission changed (uncommitted · untracked · committed since fork). */
  readonly changedPaths?: (wt: string) => readonly string[];
  /** Non-git mission: compare against the files present before execution, not only mtime. */
  readonly startedAt?: number;
  readonly initialFiles?: ReadonlyMap<string, string>;
  /** test mode: whether the worktree is a TypeScript project (default: tsconfig.json exists). */
  readonly hasTsconfig?: boolean;
};

export function checkEvidence(
  wt: string,
  ev: EvidenceMode,
  deps: EvidenceCheckDeps = {},
): { ok: boolean; path: string | null; retry?: string } {
  const baseline = deps.baseline ?? [];
  const executeTsc = deps.executeTsc ?? collectTscDiagnostics;
  const testRunner = deps.runTest ?? runTest;
  const hasChanges = deps.hasChanges ?? worktreeHasChanges;
  if (ev.kind === 'doc') {
    const dir = join(wt, ev.dirRel);
    if (!existsSync(dir)) return { ok: false, path: null, retry: `${ev.dirRel} 아래 문서가 아직 없다.` };
    // Only a document this mission wrote counts: a matching file that was already in the
    // worktree (e.g. an old PLAN-*.md) passed round 0 without any work (🅞 09-27).
    const changed = deps.startedAt === undefined ? (deps.changedPaths ?? changedFiles)(wt) : [];
    const dirPrefix = `${ev.dirRel.replace(/\/+$/, '')}/`;
    const isChanged = (f: string) => {
      if (deps.startedAt !== undefined) {
        try {
          const stat = statSync(join(dir, f));
          return stat.isFile() && stat.mtimeMs >= deps.startedAt
            && (!deps.initialFiles || deps.initialFiles.get(f) !== fileFingerprint(join(dir, f)));
        } catch { return false; }
      }
      return changed.some((c) => c === `${dirPrefix}${f}` || (c.endsWith('/') && `${dirPrefix}${f}`.startsWith(c)));
    };
    const matching = readdirSync(dir).filter((f) => ev.glob.test(f));
    const hit = matching.find(isChanged);
    if (hit) return { ok: true, path: join(dir, hit) };
    return { ok: false, path: null, retry: matching.length
      ? `${ev.dirRel} 아래 이름이 맞는 문서는 있지만 이번 미션이 쓴 것이 아니다 — 새로 작성하거나 고쳐라.`
      : `${ev.dirRel} 아래 대상 문서가 아직 없다.` };
  }
  if (!hasChanges(wt)) return { ok: false, path: null, retry: '아직 변경사항이 없다. 실제 파일을 작성하라.' };
  if (ev.kind === 'tsc') {
    const tsc = runTsc(wt, baseline, executeTsc);
    debug.log('agent-mission', 'verify', { evidence: ev.kind, baselineErrors: tsc.baselineErrors, newErrors: tsc.newErrors.length, ok: tsc.ok });
    if (!tsc.ok) return { ok: false, path: null, retry: `tsc 실패. 다음 에러를 고쳐라:\n${(tsc.failure ?? tsc.newErrors.join('\n')).slice(0, 1500)}` };
    return { ok: true, path: wt };
  }
  // test — 기준선 판정은 tsc evidence 전용이다. 기존 전체 tsc → runTest 순서와 문구를 보존한다.
  //   종전 포맷 계약(무회귀): 파싱된 진단은 앞 25개만 싣고(parseTscErrors(out).slice(0,25)), 파싱 결과가
  //   없으면 비파싱 원시 출력의 **끝** 1500자(out.slice(-1500))를 쓴다. output.slice(0,1500)(앞부분)로
  //   바꾸면 종전 문구와 어긋나 수용기준을 위반한다.
  if (ev.fileRel && !existsSync(join(wt, ev.fileRel))) return { ok: false, path: null, retry: `${ev.fileRel} 가 아직 없다.` };
  // 🩸 09-29 S6(retry-demo): without a tsconfig.json tsc prints its help and exits 1, so a mission whose tests passed
  //    2/2 was sent «tsc 실패» with the help text as the error. The test is the evidence the caller asked for — the
  //    tsc pre-check only applies to a TypeScript project.
  const tsc: ReturnType<TscExecutor> = deps.hasTsconfig ?? existsSync(join(wt, 'tsconfig.json')) ? executeTsc(wt) : { ran: true, diagnostics: [] };
  if (!tsc.ran || tsc.diagnostics.length > 0) {
    const parsed = tsc.diagnostics.map((diagnostic) => diagnostic.line);
    const errors = parsed.slice(0, 25).join('\n') || (tsc.output ?? tsc.failure ?? '').slice(-1500);
    return { ok: false, path: null, retry: `tsc 실패. 다음 에러를 고쳐라:\n${errors.slice(0, 1500)}` };
  }
  const t = testRunner(wt, ev.testPath);
  if (!t.ok) return { ok: false, path: null, retry: `테스트 실패/부재:\n${t.out.slice(0, 1200)}` };
  return { ok: true, path: ev.fileRel ? join(wt, ev.fileRel) : wt };
}

type TscExecFile = typeof execFileSync;

export function collectTscDiagnostics(wt: string, execute: TscExecFile = execFileSync): { ran: boolean; diagnostics: TypecheckError[]; failure?: string; output?: string } {
  const startedAt = Date.now();
  try {
    const out = String(execute('bunx', ['tsc', '--noEmit'], { cwd: wt, encoding: 'utf8', timeout: 240000, maxBuffer: 20 * 1024 * 1024, env: tscEnv() }) ?? '');
    const assessed = assessTypecheckExecution({ out, status: 0, signal: null, durationMs: Date.now() - startedAt });
    return { ran: assessed.executed, diagnostics: assessed.diagnostics, ...(assessed.executed ? {} : { failure: assessed.failureLog, output: out }) };
  } catch (error: unknown) {
    const x = error as { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
    const out = `${x.stdout ?? ''}${x.stderr ?? ''}`;
    const normalDiagnosticExit = x.status === 1 || x.status === 2;
    const assessed = assessTypecheckExecution({ out, status: x.status ?? null, signal: x.signal ?? null, ...(normalDiagnosticExit ? {} : { error }), durationMs: Date.now() - startedAt });
    return { ran: assessed.executed, diagnostics: assessed.diagnostics, ...(assessed.executed ? {} : { failure: `${assessed.failureLog}\n${out.slice(-1500)}`, output: out }) };
  }
}

export function runTsc(
  wt: string,
  baseline: readonly TypecheckError[] = [],
  execute: TscExecutor = collectTscDiagnostics,
): TypecheckBaselineResult {
  const current = execute(wt);
  if (!current.ran) return { ok: false, baselineErrors: baseline.length, newErrors: [], failure: current.failure ?? 'tsc 실행 실패' };
  const comparison = classifyAgainstBaseline(baseline, current.diagnostics, (diagnostic) => diagnostic.line);
  const newErrors = comparison.introduced.map((diagnostic) => diagnostic.line);
  return { ok: newErrors.length === 0, baselineErrors: baseline.length, newErrors, ...(newErrors.length ? { failure: newErrors.slice(0, 25).join('\n') } : {}) };
}
function runTest(wt: string, testPath: string): { ok: boolean; out: string } {
  // ⚠️ bun test 의 pass/fail 요약은 STDERR 로 나간다. execFileSync 는 stdout 만 반환하므로
  // "N pass" 를 놓쳐 거짓실패했다(2026-07-23 미션4 에서 규명). spawnSync 로 stdout+stderr 를
  // 모두 캡처한다. spawnSync 는 비-0 종료에도 throw 하지 않아 실패 케이스도 동일 경로로 처리.
  const r = spawnSync('bun', ['test', testPath], { cwd: wt, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const parsed = parseTestOutput(out);
  // ⭐OH8 증거 — 지정 파일이 0개 매칭이면(경로 오타·no-match) bun 은 exit 0·pass 흡수로
  // 거짓 통과하던 근본. 재작업 메시지가 "왜"를 알도록 증거 라인을 앞에 붙인다.
  const evidence = parsed.hasRunSummary
    ? (parsed.ranFiles === 0
        ? `⚠ 증거: "${testPath}" 가 0개 파일 매칭 — 아무 테스트도 실행되지 않았다(경로 오타?). exit0/pass 흡수 거짓통과 차단.\n`
        : `증거: ${parsed.ranFiles}파일 · ${parsed.pass} pass / ${parsed.fail} fail.\n`)
    : '';
  return { ok: parsed.ok, out: evidence + out.slice(-700) };
}

// ── 커버리지 게이트용 산출물 텍스트 수집 ──
//   evidence 가 파일(doc 모드)이면 그 파일, 아니면 워크트리 변경 텍스트류(.md/.txt/.html/코드) concat(캡).
function gatherArtifactText(wt: string, evPath: string | null): string {
  try {
    if (evPath && evPath !== wt && existsSync(evPath) && statSync(evPath).isFile()) {
      return readFileSync(evPath, 'utf8');
    }
  } catch { /* noop */ }
  try {
    const files = changedFiles(wt).filter((f) => /\.(md|txt|html?|tsx?|jsx?|json|py)$/i.test(f) && !f.startsWith('.mission-'));
    const parts: string[] = [];
    let total = 0;
    for (const f of files) {
      try {
        const t = readFileSync(join(wt, f), 'utf8');
        parts.push(`# ${f}\n${t}`);
        total += t.length;
        if (total > 40000) break;
      } catch { /* noop */ }
    }
    return parts.join('\n\n');
  } catch { return ''; }
}

// ── mission RFC brain → canonical 3-action control brain adapter ──
export interface MissionVerifyDoneOpts {
  readonly worktree: string;
  readonly evidence: EvidenceMode;
  readonly checklist: readonly string[];
  readonly coverageRetries: number;
  readonly checkEvidence?: typeof checkEvidence;
  readonly gatherArtifactText?: typeof gatherArtifactText;
  readonly verifyCoverage?: (text: string, checklist: string[]) => Promise<{ covered: string[]; missing: string[]; ratio: number; method: string }>;
}

/** Evidence는 파일/컴파일/테스트 gate(hard·최종 ok 결정), coverage는 enhanced checklist의 best-effort
 * anti-drift gate다. ⭐coverage 는 retry budget 동안만 되먹이고, 소진되면 미달을 로그로 가시화하고
 * 수락한다(visible omission·원본 시맨틱). coverage 를 hard-fail 로 만들면 최종 ok 는 어차피 evidence
 * gate(finalEv)가 결정하는데 control loop 만 budget 까지 헛돌며 자식을 불필요하게 계속 찌른다(무한 되먹임). */
export function createMissionVerifyDone(opts: MissionVerifyDoneOpts): (obs?: ControlObservation) => Promise<{ ok: true } | { ok: false; retry: string }> {
  const evidenceCheck = opts.checkEvidence ?? checkEvidence;
  const artifactText = opts.gatherArtifactText ?? gatherArtifactText;
  let coverageRetries = opts.coverageRetries;
  return async (obs) => {
    const ev = evidenceCheck(opts.worktree, opts.evidence);
    debug.log('agent-mission', 'verify', { step: obs?.step, ok: ev.ok, path: ev.path, retry: ev.retry?.slice(0, 100) });
    if (!ev.ok) return { ok: false as const, retry: `${ev.retry ?? '증거가 아직 부족하다.'}\n고친 뒤 MISSION-COMPLETE 라고 답하라.\r` };
    if (!opts.checklist.length) return { ok: true as const };
    const verifyCoverage = opts.verifyCoverage ?? (async (text, checklist) => (await import('../prompt-enhance/coverage.js')).verifyCoverage(text, checklist, {}));
    const cov = await verifyCoverage(artifactText(opts.worktree, ev.path), [...opts.checklist]);
    debug.log('agent-mission', 'coverage', {
      step: obs?.step, covered: cov.covered.length, missing: cov.missing.length,
      ratio: Number(cov.ratio.toFixed(2)), method: cov.method, coverageRetries,
    });
    if (!cov.missing.length) return { ok: true as const };
    // ★ 예산 소진 — 미달을 가시화하고 수락한다(visible omission). evidence 는 이미 충족했고 최종 ok 는
    //   evidence gate 가 결정하므로, 여기서 계속 hard-fail 하면 budget 낭비만 늘 뿐 결과는 안 바뀐다.
    if (coverageRetries <= 0) {
      debug.log('agent-mission', 'coverage-exhausted', { step: obs?.step, missing: cov.missing.length });
      return { ok: true as const };
    }
    coverageRetries -= 1;
    const list = cov.missing.slice(0, 20).map((m) => `- ${m}`).join('\n');
    return {
      ok: false as const,
      retry: `증거는 충족했으나 원문 커버리지 미달 — 다음 항목이 산출물에 빠졌거나 일반화됐다:\n${list}\n이 항목들을 원문 그대로 반영한 뒤(요약·생략 금지) MISSION-COMPLETE 라고 답하라. 남은 커버리지 재시도: ${coverageRetries}.\r`,
    };
  };
}

export interface MissionControlBrainOpts {
  readonly mission: string;
  readonly evidenceReady: () => boolean;
  readonly search: (query: string, step?: number) => Promise<void> | void;
  /** PTY에서 실행 중인 에이전트. 미지정 시 기존 codex 기본값을 유지한다. */
  readonly backend?: AgentBackend;
  /** ★ P4 — 역량 프로비저닝(감독이 자식의 없는 패키지/도구를 격리 worktree 에 자율 설치). 미주입 시 provision
   *  행동은 no-op(wait)로 폴백 = 무회귀. 반환 detail 을 자식에 input 으로 전달(설치됨/거부 안내). */
  readonly provision?: (req: ProvisionRequest) => Promise<ProvisionResult>;
  readonly stream?: StreamLLMFn;
  readonly handoffEnabled?: boolean;
  /** Screen-grounded brain summary for the next backend, never the raw PTY screen. */
  readonly onSummary?: (summary: string) => void;
  readonly onDecision?: (text: string, reply?: { question: string; answer: string }) => void;
  readonly recoverAfterMs?: number;
  readonly initialCommand?: string;
  readonly onRecover?: (blocked: string, action: string) => void;
}

/** 기존 5-action mission 판단을 canonical PTY control-loop 결정으로 축소한다. search는 이 경계에서만
 * 부작용(context 기록)을 끝내고, child에는 context를 읽고 계속하라는 단일 input만 전달한다. */
export type MissionControlBrain = RunSupervisor & {
  /** Report whether the last returned input was accepted by the PTY; recovery stages and events commit only on acceptance. */
  readonly onInputResult: (text: string, accepted: boolean) => void;
};

export function createMissionControlBrain(opts: MissionControlBrainOpts): MissionControlBrain {
  const history: string[] = [];
  const backendName = (opts.backend ?? codexBackend).name;
  // ★ P4 dedup(제한적 재시도·리뷰) — (layer:spec)별 시도횟수. 성공 시 영구 차단, 실패는 최대 2회까지
  //   허용(일시 네트워크/프로세스 오류는 재시도, 지속 실패는 루프 차단).
  const provisionAttempts = new Map<string, number>();
  const PROVISION_MAX_ATTEMPTS = 2;
  const recoverAfterMs = opts.recoverAfterMs ?? 45_000;
  if (!Number.isFinite(recoverAfterMs) || recoverAfterMs <= 0) throw new Error('recoverAfterMs must be positive');
  let lastScreen: string | undefined;
  let repeatedQuestion = 0;
  let lastQuestion: string | undefined;
  let recoveryStage = 0;
  let pendingReplayBlocked: string | undefined;
  // The recovery input returned by the last decide(); committed (stage advance + event) only when the PTY accepts it.
  let pendingRecovery: { blocked: string; action: string; text: string; replay?: boolean } | undefined;
  let lastCommand = opts.initialCommand ?? opts.mission;
  const llmBrain = createLlmControlBrain({
    goal: opts.mission,
    stream: opts.stream,
    maxTokens: 500,
    temperature: 0.2,
    messageBuilder: (obs, controlHistory): LLMMessage[] => {
      const sys = `너는 elanous 다. ${backendName}(외부 코딩 에이전트)를 PTY 로 열어 미션을 완주시키는 컨트롤러다.
 ${backendName} 의 현재 화면을 보고 **다음 행동 하나**를 JSON 으로만 결정하라.

 미션 요지: ${opts.mission.slice(0, 400)}

 행동(action):
 - "wait": ${backendName} 가 아직 작업 중(도구 실행/생성)이면 대기.
 - "verify": ${backendName} 가 MISSION-COMPLETE/완료를 주장하면 증거 게이트(내가 실행)로 검증. 완료주장 시 이걸 우선.
 - "send": ${backendName} 가 멈추거나 계속 진행이 필요하면 짧고 명확한 지시(text). 화면의 질문에 직접 답하는 경우에만 reason 을 Answering question: <화면의 질문 원문> 으로 기록하라. 다른 send 의 reason 은 종전처럼 행동 이유를 적어라.
 - "search": ${backendName} 가 정보/라이브러리/문법/외부자원에 막혔으면 omni-crawl 로 조사(query). ⭐외부 힌트 없이 스스로 판단.
${opts.handoffEnabled ? ` - "handoff": 다른 담당자로 넘길 때 to(codex/claude/elanous), mission(다음 지시), carry(diff/summary 선택). carry=summary 면 reason 에 화면에서 확인한 리뷰 지적을 구체적으로 요약하라(다음 backend 에 전달된다). claude 리뷰 뒤 지적은 codex 에 summary 로 되돌려라. elanous 는 증거 게이트와 PR.
 - "ask-human": 화면에 로그인 URL/장치 코드가 보이면 reason, url/code(보이는 것만). 토큰·자격파일을 열지 마라.` : ''}${opts.provision ? `
 - "provision": ${backendName} 가 **없는 Node 패키지**에 막혔으면(예: "Cannot find module 'X'"·"Module not found: X") 격리 worktree 에 자율 설치(spec=**npm 패키지명**, layer="pkg"). ⚠️Node 패키지만 — 파이썬/시스템 도구(pip·apt·brew)는 아직 미지원이니 provision 하지 말고 다른 방법(search·send)으로. 내가 설치 후 재시도를 지시한다.` : ''}
 증거상태: ${opts.evidenceReady() ? '충족(완료 가능)' : '아직'}.
 JSON 만: {"action":"...","text":"...","query":"...","spec":"...","layer":"pkg","reason":"..."}`;
      const recent = history.slice(-4).join(' | ') || controlHistory.slice(-4).join(' | ') || '없음';
      return [
        { role: 'system', content: sys },
        { role: 'user', content: `스텝 ${obs.step}. 최근행동: ${recent}\n\n=== ${backendName} 화면 ===\n${obs.screen.slice(-3500)}` },
      ];
    },
    decisionFromRaw: async (raw, obs): Promise<ControlDecision> => {
      const decision = parseBrainDecision(raw);
      history.push(`s${obs.step}:${decision.action}`);
      debug.log('agent-mission', 'brain', { step: obs.step, action: decision.action,
        ...(decision.action === 'ask-human' ? {} : { reason: decision.reason.slice(0, 120) }) });
      // A '?' on screen alone does not establish that this send answered it. Only an
      // explicit question citation in the brain's reason can attribute the reply.
      const citedQuestion = /^Answering question:\s*(.+\?)\s*$/i.exec(decision.reason)?.[1]?.trim();
      const question = citedQuestion && classifierFrameLines(obs.screen).find((line) => line === citedQuestion);
      opts.onDecision?.(`step ${obs.step}: ${decision.action}${decision.action === 'ask-human' ? '' : ` — ${decision.reason || decision.text || decision.query || ''}`}`,
        decision.action === 'send' && decision.text?.trim() && question ? { question, answer: decision.text } : undefined);
      if (decision.reason && decision.action !== 'ask-human') opts.onSummary?.(decision.reason.slice(0, 2000));
      if (decision.action === 'handoff' && decision.to && decision.mission) return { action: 'handoff', to: decision.to, mission: decision.mission, ...(decision.carry ? { carry: decision.carry } : {}) };
      if (decision.action === 'ask-human') return { action: 'ask-human', reason: decision.reason, ...(decision.url ? { url: decision.url } : {}), ...(decision.code ? { code: decision.code } : {}) };
      if (decision.action === 'send') {
        lastCommand = decision.text || 'continue';
        return { action: 'input', text: `${lastCommand}\r` };
      }
      if (decision.action === 'verify' || decision.action === 'done') return { action: 'done', reason: decision.reason || 'agent completed' };
      if (decision.action === 'search') {
        await opts.search(decision.query || opts.mission.slice(0, 120), obs.step);
        // ★ child 에게 저장 경로를 명시해야 조사 결과를 찾는다 — 경로 안내 제거는 회귀(review·원본 시맨틱).
        return { action: 'input', text: '조사 결과를 .mission-context.md 에 저장했다. 읽고 계속 진행하라.\r' };
      }
      // ★ P4 provision(search 와 동형 부작용 동사) — 감독이 자식 역량을 격리 worktree 에 자율 설치 후 재시도 지시.
      //   미배선(opts.provision 없음)이면 wait 폴백(무회귀). spec 없으면 무의미 → wait.
      if (decision.action === 'provision') {
        if (!opts.provision || !decision.spec) return { action: 'wait' };
        // ★ dedup(제한적 재시도·review) — (layer:spec)별 시도 상한(성공=영구차단·99, 실패=최대 2회). 일시
        //   오류는 재시도하되 지속 실패/성공 후 반복은 차단(설치루프·네트워크 낭비 방지). spec sanitize.
        const key = `${decision.layer ?? 'pkg'}:${decision.spec}`;
        const attempts = provisionAttempts.get(key) ?? 0;
        if (attempts >= PROVISION_MAX_ATTEMPTS) {
          return { action: 'input', text: `'${sanitizeForPtyInput(decision.spec, 80)}' 는 이번 미션에서 이미 provision 을 시도했다. 재설치 말고 다른 방법(search·직접 구현)으로 진행하라.\r` };
        }
        provisionAttempts.set(key, attempts + 1);
        // ★ graceful(search 동형·review) — provisioner 예외가 decide 밖으로 전파되면 제어루프가 error 종료로
        //   미션을 죽인다. 실패도 자식에 "설치 없이 계속" input 으로 내부화(미션 무중단).
        try {
          const res = await opts.provision({ layer: decision.layer ?? 'pkg', spec: decision.spec, ...(decision.reason ? { reason: decision.reason } : {}) });
          if (res.ok) provisionAttempts.set(key, 99); // 성공 = 영구 차단(재설치 불요)
          // ★ PTY 주입 직전 경계에서도 sanitize(심층방어) — 주입 가능한 provision 구현이 제어문자/개행을 detail 에
          //   담아도 PTY 로 추가 라인·시퀀스가 안 새게. 기본 구현은 이미 안전하나 경계에서 재보장.
          return { action: 'input', text: `${sanitizeForPtyInput(res.detail, 400)}\r` };
        } catch (e) {
          debug.log('agent-mission', 'provision-error', { spec: decision.spec, error: e instanceof Error ? e.message : String(e) }, { level: 'warn' });
          return { action: 'input', text: '설치 시도 중 오류가 발생했다. 설치 없이 다른 방법으로 진행하라.\r' };
        }
      }
      return { action: 'wait' };
    },
  });
  return {
    onInputResult: (text, accepted) => {
      const recovery = pendingRecovery;
      // Only the input this brain returned settles its recovery step (a trust answer in between does not).
      if (!recovery || recovery.text !== text) return;
      pendingRecovery = undefined;
      if (!accepted) return;
      if (recovery.replay) { pendingReplayBlocked = undefined; opts.onRecover?.(recovery.blocked, recovery.action); return; }
      recoveryStage += 1;
      if (recovery.action === 'Ctrl-C and replay previous command') pendingReplayBlocked = recovery.blocked;
      else opts.onRecover?.(recovery.blocked, recovery.action);
    },
    decide: async (obs, signal) => {
      pendingRecovery = undefined;
      if (signal?.aborted) return { action: 'wait' };
      const lines = classifierFrameLines(obs.screen);
      // Only the active bottom line can be a repeated prompt; a question left in
      // scrollback while new work appears is not a request for input.
      const tail = lines.at(-1);
      const question = tail && /\?(?:\s*\[[^\]\r\n]+\])?\s*$/.test(tail) ? tail : undefined;
      const screenChanged = lastScreen !== undefined && obs.screen !== lastScreen;
      if (screenChanged) recoveryStage = 0;
      repeatedQuestion = question ? (!screenChanged && question === lastQuestion ? repeatedQuestion + 1 : 1) : 0;
      lastQuestion = question;
      lastScreen = obs.screen;
      if (pendingReplayBlocked !== undefined) {
        // Ctrl-C consumes its own step; replay on the next observation even when the
        // interrupted child keeps redrawing a non-prompt screen. A rejected replay is retried.
        const text = `${lastCommand}\r`;
        pendingRecovery = { blocked: pendingReplayBlocked, action: 'Ctrl-C and replay previous command', text, replay: true };
        return { action: 'input', text };
      }
      const blocked = repeatedQuestion >= 3 ? `same question repeated three times: ${question}`
        : (obs.sameScreenMs ?? 0) >= recoverAfterMs ? `screen unchanged for ${obs.sameScreenMs}ms` : undefined;
      if (blocked && opts.evidenceReady()) return { action: 'done', reason: 'Evidence ready on stalled screen' };
      if (blocked && !signal?.aborted) {
        const action = ['Enter', 'Esc', 'Ctrl-C and replay previous command', 'Human needed'] as const;
        const next = action[Math.min(recoveryStage, 3)]!;
        if (next !== 'Human needed') {
          const text = next === 'Enter' ? '\r' : next === 'Esc' ? '\x1b' : '\x03';
          pendingRecovery = { blocked, action: next, text };
          return { action: 'input', text };
        }
        recoveryStage += 1;
        opts.onRecover?.(blocked, next);
        const summary = lines.slice(-3).join(' | ').slice(0, 240) || '(empty screen)';
        return { action: 'no-progress', terminal: true, reason: `사람 필요 · 마지막 화면 요약: ${summary}` };
      }
      return llmBrain.decide(obs, signal);
    },
  };
}

/**
 * ★ U5(감독 통일 seam) — ReAct 제어루프 관측(화면)을 executor SelfReportFrame 으로 통일 프레임 버스에 발행.
 *
 * 감독 통일 §4 obstacle-1(observe→SelfReportFrame): #5379(P3b)가 headless goal-loop·TUI 는 프레임 버스로
 * 발행했으나 **ReAct 제어루프(runPtyControlLoop·agent-mission 이 구동)는 아무것도 발행 안 함** → 프레임 버스가
 * PTY 감독 계열을 못 봄. 이 seam 이 그 갭을 닫는다 — headless 와 **동일 빌더**(buildExecutorSelfReportFrame·
 * surfaceId=exec:<ptyId>·K4 runId join) 재사용(재발명 0)해 fleet/observatory/G5 구독자가 agent-mission 화면도
 * 관측·검증 접합. 순수하게 bus 를 받아 테스트 가능. publishSelfReportFrame 은 내부 fail-soft(관측이 관측대상을
 * 안 깸)이나, ★제1원칙: build 단계의 지속적 실패도 은폐 안 되게 호출부에서 관측을 남긴다.
 */
export function publishControlObservationFrame(
  bus: ChannelBus,
  obs: { screen: string },
  ident: { ptyId: string; instance: string; at: number; runId?: string; pngRef?: string },
): void {
  publishSelfReportFrame(bus, buildExecutorSelfReportFrame({
    ptyId: ident.ptyId,
    rendered: obs.screen,
    at: ident.at,
    instance: ident.instance,
    ...(ident.runId ? { runId: ident.runId } : {}),
    // ★ keyframe pngRef 포워딩(agent-cli backend·#5386 확장) — 전이 순간에만 실림(never inline·on-demand).
    ...(ident.pngRef ? { pngRef: ident.pngRef } : {}),
  }));
}

/** ★ keyframe 렌더 timeout(ms·리뷰) — renderPng(sharp 래스터화)이 느리거나 행에 걸려도 프레임 발행을
 *  무기한 지연하지 않게 바운드. 초과 시 null(=pngRef 생략·발행 진행). */
const KEYFRAME_RENDER_TIMEOUT_MS = 2000;

/** renderPng 를 timeout 으로 감싼다 — 초과=null(fail-soft). 타이머는 항상 정리(누수 방지). */
async function raceKeyframeRender(render: () => Promise<Buffer | null> | Buffer | null): Promise<Buffer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), KEYFRAME_RENDER_TIMEOUT_MS); });
  try {
    return await Promise.race([Promise.resolve(render()), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * runPtyControlLoop 의 onStep 훅 factory — 매 제어스텝에 프레임 버스 발행(신규) + 화면 전사(기존)를 수행.
 * runAgentMission 이 실제로 이 factory 를 배선하므로, 반환 함수 + 배선 가드(source)를 함께 테스트하면
 * "제어루프 경유 프레임 발행"을 회귀 검증한다.
 *
 * ⚠️ **범위**: agent-mission 의 onStep 배선에만 적용 — 범용 runPtyControlLoop·타 ReAct 호출자(elanous drive
 *    등)는 자동 합류 안 함(각자 배선 필요).
 * ⚠️ **실패 계약(정직)**: 두 관측은 대칭이 아니다 —
 *    · 발행은 **fail-soft**: publishSelfReportFrame 이 bus.publish 실패를 설계상 내부에서 삼킨다(#5379 계약·
 *      관측이 관측대상을 안 깸). 별도 바깥 try/catch 없음 — buildExecutorSelfReportFrame 은 typed string
 *      화면에서 throw 하지 않는 정상 불변이라, 억지 catch 로 빌더 결함을 은폐하지 않는다(불변 깨지면 표면화).
 *    · capture 는 **예외 전파**: 기존 semantics 그대로(전사/증거 계약 불변·EMIT seam 범위 밖 변경 금지).
 *    발행을 **먼저** 수행 → capture 가 실패로 전파되더라도 프레임은 이미 발행돼 유실되지 않는다.
 */
export function makeMissionObserveStep(deps: {
  capture: (label: string) => Promise<unknown> | unknown;
  renderPng?: () => Promise<Buffer | null> | Buffer | null;
  bus: ChannelBus;
  ident: { ptyId: string; instance: string; runId?: string };
  now?: () => number;
  onPublishedFrame?: (obs: ControlObservation) => void;
}): (obs: ControlObservation, decision: ControlDecision) => Promise<void> {
  const now = deps.now ?? ((): number => Date.now());
  let lastFrameState: FrameState | null = null;
  let keyframeSeq = 0;
  return async (obs, decision) => {
    let pngRef: string | undefined;
    try {
      const state = classifyFrameState(obs.screen).state;
      const moment = isKeyframeMoment(lastFrameState, state);
      // ★ best-effort·무재시도(리뷰): 상태는 캡처 성공과 무관하게 갱신 → 전이당 최대 1회 시도. 일시 렌더 실패 시
      //   그 전이의 keyframe 은 놓치되(재시도 없음·반복 캡처 비용 회피), 다음 전이는 정상 캡처. 관측이 미션을 안 막음.
      lastFrameState = state;
      if (moment && deps.renderPng) {
        // ★ 발행 우선 보장(리뷰): renderPng 를 timeout 으로 바운드 → 느린/행 렌더가 프레임 발행을 지연 안 시킴
        //   (초과=null=pngRef 생략·발행 진행). fail-soft 계약 복원.
        const png = await raceKeyframeRender(deps.renderPng);
        if (png) {
          const path = keyframePath(deps.ident.runId ?? 'unknown', deps.ident.ptyId, keyframeSeq, state);
          if (writeKeyframePng(path, png)) {
            pngRef = path;
            debug.log('agent-mission', 'keyframe-capture', { ptyId: deps.ident.ptyId, runId: deps.ident.runId, seq: keyframeSeq, state });
            keyframeSeq += 1;
          }
        }
      }
    } catch (e) {
      debug.log('agent-mission', 'keyframe-fail', { ptyId: deps.ident.ptyId, error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    }
    // 발행 먼저(publishSelfReportFrame 내부 fail-soft·capture 종속 제거). 억지 catch 없음(빌더 정상 불변).
    publishControlObservationFrame(deps.bus, obs, {
      ptyId: deps.ident.ptyId, instance: deps.ident.instance, at: now(),
      ...(deps.ident.runId ? { runId: deps.ident.runId } : {}),
      ...(pngRef ? { pngRef } : {}),
    });
    deps.onPublishedFrame?.(obs);
    // capture 는 원 semantics 유지 — 예외 전파(증거/전사 계약 불변).
    await deps.capture(`s${obs.step}-${decision.action}`);
  };
}

/** 미션 spec → `createWorktree` 인자. ⭐ 이 마디를 «함수»로 꺼낸 이유는 사슬을 물 수 있게 하려는 것이다 —
 *  `runAgentMission` 본체는 PTY 를 띄우므로 테스트가 못 부르고, 그러면 「호출자가 준 값이 워크트리 생성까지
 *  갔나」를 구조적으로 확인할 방법이 없다(인라인 객체 리터럴은 그 자리에서만 산다).
 *  ⛔ 문면은 종전 그대로다 — `reuseOwnedWorktree` 는 spec 이 «명시»했을 때만 실린다(미지정=키 자체가 없다). */
export function buildMissionWorktreeRequest(
  spec: Pick<AgentMissionSpec, 'branch' | 'base' | 'reuseOwnedWorktree'>,
  ctx: { repoRoot: string; worktreeRoot: string },
): CreateWorktreeOpts {
  return {
    repoRoot: ctx.repoRoot, branch: spec.branch!, worktreeRoot: ctx.worktreeRoot, resetExisting: true,
    ...(spec.base ? { base: spec.base } : {}),
    ...(spec.reuseOwnedWorktree === true ? { reuseOwnedWorktree: true } : {}),
  };
}

export function buildMissionWorktreeProvenance(branch: string, createdAt = new Date().toISOString()): {
  owner: string;
  command: 'elanous agent-mission';
  createdAt: string;
} {
  return { owner: `agent:${branch}`, command: 'elanous agent-mission', createdAt };
}

export function recordMissionWorktreeProvenance(
  worktreePath: string,
  provenance: ReturnType<typeof buildMissionWorktreeProvenance>,
  record: typeof recordHarnessWorktreeProvenance = recordHarnessWorktreeProvenance,
): void {
  try {
    record(worktreePath, provenance);
    debug.log('agent-mission', 'provenance-recorded', { path: worktreePath, ...provenance });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('agent-mission', 'provenance-failed', { path: worktreePath, ...provenance, reason }, { level: 'warn' });
    throw new Error(`agent-mission worktree provenance failed — ${reason}`);
  }
}

// ══════════════════ 메인 ══════════════════
export const AGENT_MISSION_TAKEOVER_WAIT_MS = 1_800_000;

function containingGitRepo(dir: string): string | null {
  const probe = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : null;
}

function missionRepoStatus(repo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnChild('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: repo });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`git status failed (${code}): ${err}`)));
  });
}

function statusEntries(status: string): Map<string, string> {
  const nulDelimited = status.includes('\0');
  const entries = nulDelimited ? status.split('\0') : status.split('\n');
  const paths = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    // Porcelain -z lists the source of a rename in the following entry; its path is literal.
    if (nulDelimited && /[RC]/.test(entry.slice(0, 2))) i++;
    const raw = nulDelimited ? entry.slice(3) : entry.slice(3).replace(/^.* -> /, '');
    if (raw) paths.set(raw, entry.slice(0, 2));
  }
  return paths;
}

function insideWorkdir(repo: string, workdir: string, path: string): boolean {
  const root = realpathSync(repo);
  const folder = realpathSync(workdir);
  const candidate = resolve(root, path);
  const rel = relative(folder, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function initialEvidenceFiles(workdir: string, evidence: Extract<EvidenceMode, { kind: 'doc' }>): Map<string, string> {
  const dir = join(workdir, evidence.dirRel);
  const files = new Map<string, string>();
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    if (!evidence.glob.test(name)) continue;
    const fingerprint = fileFingerprint(join(dir, name));
    if (fingerprint !== null) files.set(name, fingerprint);
  }
  return files;
}

function fileFingerprint(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch { return null; }
}

function linkedTargetFingerprint(path: string, seen: Set<string> = new Set()): string | null {
  try {
    const real = realpathSync(path);
    // A link cycle is hashed as a marker; the content was already hashed on the first visit.
    if (seen.has(real)) return 'cycle';
    const stat = statSync(real);
    if (stat.isFile()) return fileFingerprint(real);
    if (!stat.isDirectory()) return null;
    seen.add(real);
    const hash = createHash('sha256');
    for (const entry of readdirSync(real, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(real, entry.name);
      // Follow nested links too: writing through `link/nested` changes the nested target, not the link text.
      const content = linkedTargetFingerprint(child, seen) ?? 'missing';
      hash.update(entry.name).update(entry.isSymbolicLink() ? `link:${readlinkSync(child)}:${content}` : content);
    }
    return hash.digest('hex');
  } catch { return null; }
}

// Git control files change what git and its hooks execute. Objects, the index and refs churn during
// ordinary reads and sibling worktrees, so they are not compared.
const GIT_CONTROL_ENTRIES = ['config', 'config.worktree', 'hooks', 'info'];

function gitControlFingerprints(root: string, add: (label: string, hash: string | null) => void): void {
  const dotGit = join(root, '.git');
  const dirs: Array<{ dir: string; label: string }> = [];
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory()) dirs.push({ dir: dotGit, label: '.git' });
    else if (stat.isFile()) {
      add('.git', fileFingerprint(dotGit));
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (gitdir) {
        const dir = resolve(root, gitdir);
        dirs.push({ dir, label: '.git:gitdir' });
        const common = existsSync(join(dir, 'commondir')) ? readFileSync(join(dir, 'commondir'), 'utf8').trim() : '';
        if (common) dirs.push({ dir: resolve(dir, common), label: '.git:common' });
      }
    }
  } catch { return; }
  const walk = (absolute: string, label: string): void => {
    try {
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        for (const name of readdirSync(absolute).sort()) walk(join(absolute, name), `${label}/${name}`);
      } else add(label, stat.isSymbolicLink() ? `link:${readlinkSync(absolute)}:${linkedTargetFingerprint(absolute)}` : fileFingerprint(absolute));
    } catch { /* Absent control files are compared as absent. */ }
  };
  for (const { dir, label } of dirs) for (const name of GIT_CONTROL_ENTRIES) walk(join(dir, name), `${label}/${name}`);
}

function externalLinks(dir: string, workdir: string, label: (path: string) => string): Map<string, string | null> {
  const links = new Map<string, string | null>();
  const folder = realpathSync(workdir);
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' && entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) {
        try {
          const target = realpathSync(path);
          const rel = relative(folder, target);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            links.set(label(path), linkedTargetFingerprint(target));
          }
        } catch { /* A broken link cannot be used to write an existing target. */ }
      }
    }
  };
  visit(dir);
  return links;
}

function repoFingerprints(repo: string, workdir: string, paths: readonly string[]): Map<string, string | null> {
  const fingerprints = new Map<string, string | null>();
  const root = realpathSync(repo);
  const folder = realpathSync(workdir);
  const inside = (absolute: string): boolean => {
    const rel = relative(folder, absolute);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === '.git') continue;
      const absolute = join(dir, entry.name);
      if (inside(absolute)) continue;
      const path = relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) {
        fingerprints.set(path, `link:${readlinkSync(absolute)}`);
        try {
          const target = realpathSync(absolute);
          if (!target.startsWith(`${root}${sep}`) && target !== root) {
            fingerprints.set(path, `link:${readlinkSync(absolute)}:${linkedTargetFingerprint(target)}`);
          }
        } catch { /* Broken link. */ }
      }
      else fingerprints.set(path, fileFingerprint(absolute));
    }
  };
  // Include ignored files as well as tracked/untracked paths: git status alone cannot see them.
  visit(root);
  gitControlFingerprints(root, (label, hash) => fingerprints.set(label, hash));
  for (const path of paths) {
    if (insideWorkdir(repo, workdir, path) || fingerprints.has(path)) continue;
    fingerprints.set(path, fileFingerprint(resolve(root, path)));
  }
  return fingerprints;
}

/** Abort owns the PTY tree even while the control brain or an external tool is awaiting. */
export async function runAgentMission(spec: AgentMissionSpec, deps: AgentMissionDeps = {}): Promise<AgentMissionResult> {
  if (spec.signal?.aborted) {
    debug.log('agent-mission', 'aborted', { workdir: spec.workdir, pids: [], reason: 'aborted' });
    return { ok: false, reason: 'aborted', worktree: spec.workdir ?? '', branch: spec.workdir ? null : spec.branch ?? null,
      rounds: 0, evidencePath: null, committed: false, usedOmniCrawl: false, detail: 'aborted' };
  }
  if (spec.workdir && spec.evidence.kind !== 'doc') throw new Error('workdir 모드는 doc 증거만');
  const workdir = spec.workdir;
  const status = deps.repoStatus ?? missionRepoStatus;
  // Compare the repository that contains the workdir, not the launcher's cwd: a workdir outside any repository
  // (e.g. a media folder) must not be failed by unrelated writes in the launcher's tree, such as its own logs.
  const repo = workdir ? (spec.repo ?? containingGitRepo(workdir)) : null;
  if (workdir && !repo) debug.log('agent-mission', 'workdir-outside-repo', { workdir, pids: [], reason: 'links-only' });
  const signal = spec.signal;
  let before = '';
  let beforeFingerprints = new Map<string, string | null>();
  let beforeLinks = new Map<string, string | null>();
  if (workdir) {
    let stopWaiting!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => { stopWaiting = () => reject(new Error('MISSION_ABORTED')); });
    signal?.addEventListener('abort', stopWaiting, { once: true });
    try {
      if (repo) {
        before = await Promise.race([status(repo), interrupted]);
        beforeFingerprints = repoFingerprints(repo, workdir, [...statusEntries(before).keys()]);
      }
      beforeLinks = externalLinks(workdir, workdir, (path) => path);
    } catch (error) {
      if (!signal?.aborted) throw error;
      debug.log('agent-mission', 'aborted', { workdir, pids: [], reason: 'aborted' });
      return { ok: false, reason: 'aborted', worktree: workdir, branch: null,
        rounds: 0, evidencePath: null, committed: false, usedOmniCrawl: false, detail: 'aborted' };
    } finally { signal?.removeEventListener('abort', stopWaiting); }
  }
  const startedAt = Date.now();
  const contextOwner = !deps.contextEventRun;
  const contextRunId = contextOwner ? ensureRunId() : undefined;
  let contextPrNumber: number | undefined;
  const emitContext = (kind: 'task-claimed' | 'task-done', detail: string): void => {
    if (!contextOwner) return;
    try {
      (deps.emitContextEvent ?? emitSessionEvent)({ kind, seat: 'TC', text: `Agent mission ${detail}: ${spec.mission.split(/\r?\n/, 1)[0]}`,
        ref: `runId=${contextRunId}${contextPrNumber === undefined ? '' : ` PR=#${contextPrNumber}`}` });
    } catch (error) {
      try { debug.log('agent-mission', 'context-event-failed', { kind, runId: contextRunId, error: String(error) }, { level: 'warn' }); } catch { /* fail-soft */ }
    }
  };
  emitContext('task-claimed', 'claimed');
  let result: AgentMissionResult | undefined;
  try {
  const initialFiles = workdir && spec.evidence.kind === 'doc' ? initialEvidenceFiles(workdir, spec.evidence) : undefined;
  let handle: PtyHandle | undefined;
  let childPid: number | undefined;
  let killChild: (() => void) | undefined;
  let stopPty: (() => void) | undefined;
  let abort!: () => void;
  let cancelled = false;
  let controlPending: Promise<unknown> | undefined;
  let controlSettled = false;
  let activeControl: Promise<unknown> | undefined;
  let activeSettled = false;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      if (cancelled) return;
      cancelled = true;
      debug.log('agent-mission', 'aborted', { workdir, pids: childPid ? [childPid] : handle?.pid ? [handle.pid] : [], reason: 'aborted' });
      void (async () => {
        stopPty?.();
        const pid = childPid ?? handle?.pid;
        try {
          if (pid) {
            const pids = await (deps.terminateProcessTree ?? terminateMissionProcessTree)(pid);
            debug.log('agent-mission', 'tree-killed', { workdir, pids, reason: 'aborted' });
          }
        } finally {
          if (handle) try { handle.kill(); } catch { /* Already exited. */ }
          killChild?.();
        }
      })().then(() => reject(new Error('MISSION_ABORTED')), reject);
    };
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (cancelled) await aborted;
    const body = runAgentMissionBody(spec, { ...deps, contextEventRun: true, onMissionPrNumber: (number) => {
      contextPrNumber = number;
      try { deps.onMissionPrNumber?.(number); } catch { /* context propagation never changes a mission result */ }
    }, onControlActive: (pending) => {
      activeSettled = false;
      activeControl = pending.then(() => { activeSettled = true; }, () => { activeSettled = true; });
    }, onControlPending: (pending) => {
      controlSettled = false;
      controlPending = pending.then(() => { controlSettled = true; }, () => { controlSettled = true; });
    }, awaitMission: (pending) => Promise.race([pending, aborted]), isMissionAborted: () => cancelled, onPtyStarted: (h, stop) => { handle = h; stopPty = stop; deps.onPtyStarted?.(h, stop); if (signal?.aborted) abort(); }, onHeadlessStarted: (pid, kill) => { childPid = pid; killChild = kill; deps.onHeadlessStarted?.(pid, kill); if (signal?.aborted) abort(); } }, startedAt, initialFiles);
    if (signal) {
      try { result = await Promise.race([body, aborted]); }
      catch (error) {
        if (cancelled) {
          // The tree is already terminated by abort; a stage not tied to cancellation (e.g. ownership wait)
          // must not hold the return forever, so the drain is bounded.
          const drain = (async () => {
            await body.catch(() => {});
            if (activeControl && !activeSettled) await activeControl;
            if (controlPending && !controlSettled) await controlPending;
          })();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const drained = await Promise.race([drain.then(() => true), new Promise<false>((done) => { timer = setTimeout(() => done(false), deps.cancelDrainMs ?? 10_000); })]);
          clearTimeout(timer);
          if (!drained) debug.log('agent-mission', 'cancel-drain-timeout', { workdir, pids: childPid ? [childPid] : handle?.pid ? [handle.pid] : [], reason: 'aborted' });
        }
        throw error;
      }
    } else result = await body;
    if (cancelled) await aborted;
  } catch (error) {
    if (!cancelled) throw error;
    result = { ok: false, reason: 'aborted', worktree: workdir ?? '', branch: workdir ? null : spec.branch ?? null,
      rounds: 0, evidencePath: null, committed: false, usedOmniCrawl: false, detail: 'aborted' };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (workdir) {
    let after = '';
    if (repo) {
      let stopWaiting!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => { stopWaiting = () => reject(new Error('MISSION_ABORTED')); });
      signal?.addEventListener('abort', stopWaiting, { once: true });
      try { after = await Promise.race([status(repo), interrupted]); }
      catch (error) {
        if (!signal?.aborted) throw error;
        after = await status(repo);
      } finally { signal?.removeEventListener('abort', stopWaiting); }
    }
    // A cancel that lands during the final inspection still cancels the mission; it never reports success.
    if (signal?.aborted && result.reason !== 'aborted') {
      debug.log('agent-mission', 'aborted', { workdir, pids: [], reason: 'aborted-during-final-inspection' });
      result = { ...result, ok: false, reason: 'aborted', committed: false, detail: 'aborted' };
    }
    const afterEntries = statusEntries(after);
    const beforeEntries = statusEntries(before);
    const afterFingerprints = repo
      ? repoFingerprints(repo, workdir, [...new Set([...beforeFingerprints.keys(), ...afterEntries.keys()])])
      : new Map<string, string | null>();
    const paths = [...afterFingerprints].filter(([path, hash]) =>
      (beforeFingerprints.has(path) && beforeFingerprints.get(path) !== hash)
      || (!beforeFingerprints.has(path) && hash !== null)
      || (afterEntries.has(path) && beforeEntries.get(path) !== afterEntries.get(path)))
      .map(([path]) => path);
    for (const [link, hash] of externalLinks(workdir, workdir, (path) => path)) {
      if (beforeLinks.get(link) !== hash && !paths.includes(link)) paths.push(link);
    }
    paths.sort();
    if (paths.length) {
      debug.log('agent-mission', 'outside-write', { workdir, pids: [], reason: paths.join(', ') });
      (deps.emitDecision ?? emitDecision)({ kind: 'ESCALATE', what: '작업 폴더 밖 쓰기', reason: paths.join(', '), purpose: '사람이 확인한다', target: 'human' });
      result = { ...result, ok: false, reason: 'outside-write', paths, committed: false };
      return result;
    }
  }
  return result;
  } finally { emitContext('task-done', result?.ok ? 'completed' : 'ended'); }
}

async function runAgentMissionBody(spec: AgentMissionSpec, deps: AgentMissionDeps, startedAt: number, initialFiles?: ReadonlyMap<string, string>): Promise<AgentMissionResult> {
  const backend = spec.agent ?? (spec.chain?.[0] && spec.chain[0] !== 'elanous' ? resolveBackend(spec.chain[0]) : resolveDefaultBackend());
  if (spec.chain && (spec.chain[0] !== backend.name || !['codex,claude,elanous', 'codex,claude,codex,elanous'].some((allowed) => allowed === spec.chain!.join(',') || (deps.handoffWorktree && allowed.endsWith(`,${spec.chain!.join(',')}`))))) throw new Error('invalid agent mission chain');
  if (spec.chain && spec.commit === false && spec.chain.includes('elanous')) throw new Error('elanous PR handoff requires commit authorization');
  if (spec.headless && spec.chain) throw new Error('--headless cannot run a PTY handoff chain');
  if (spec.headless && backend.name !== 'claude') throw new Error('--headless 는 --backend claude 전용입니다');
  if (spec.plugin && (spec.headless || (backend.name !== 'codex' && backend.name !== 'claude'))) throw new Error('--plugin 은 codex/claude PTY 전용입니다');
  if (spec.workdir && spec.chain) throw new Error('workdir 모드는 넘기기 사슬을 쓰지 않는다');
  const runtimeFallback = deps.runtimeFallback ?? {
    ...initialRuntimeFallback(backend, normalizeFallbackChain(getUserConfig().llm?.fallbackChain).chain),
    fallbackEligible: spec.agent === undefined && !spec.chain,
  };
  const spawnPty = deps.startPty ?? startPty;
  const createMissionWorktree = deps.createWorktree ?? createWorktree;
  const recordWorktreeProvenance = deps.recordWorktreeProvenance ?? recordHarnessWorktreeProvenance;
  const repoRoot = spec.repo ?? resolveMainRepoRoot(process.cwd()) ?? process.cwd();
  if (!spec.workdir && !spec.branch) throw new Error('branch is required without workdir');
  const maxRounds = spec.maxRounds ?? 16;
  const omniPath = spec.omniCrawlPath ?? DEFAULT_OMNI;
  const screensDir = spec.screensDir ?? join(process.env.TMPDIR || '/tmp', `agent-mission-${backend.name}-${spec.branch}`);
  mkdirSync(screensDir, { recursive: true });

  debug.log('agent-mission', 'start', { agent: backend.name, branch: spec.branch, base: spec.base ?? 'HEAD', evidence: spec.evidence.kind, repoRoot });
  // ★ capability 구동(2026-07-23) — 롤·capability 를 선언·관측하고, **활성 집합이 enhance behavior 를 구동**한다
  //   (선언 ∩ §6e 진입정책). agent-mission = controller 가 executor:agent 를 몰다. 진입 기본 elanous-apparatus
  //   (elanous 가 원문 prep → enhance ON) · 명시 spec.enhance override 우선 · 외부/중첩은 external-verbatim 전달.
  const { describeRole } = await import('../agent-substrate/execution/roles.js');
  const { resolveActiveCapabilities } = await import('../agent-substrate/execution/capabilities.js');
  // 기본 external-verbatim(보수·무회귀) — 프롬프트를 함부로 인핸싱하지 않음. elanous-apparatus 는 도어가 명시 선언
  //   (agent-mission CLI = elanous-apparatus → ON). 명시 spec.enhance override 는 여전히 최우선.
  const missionEntry = spec.entry ?? 'external-verbatim';
  const caps = resolveActiveCapabilities('agent-mission', {
    entry: missionEntry,
    ...(spec.enhance !== undefined ? { explicitEnhance: spec.enhance } : {}),
  });
  const enhanceActive = caps.has('enhance');
  debug.log('agent-mission', 'role', {
    role: 'controller', executor: describeRole({ role: 'executor', executorKind: 'agent', agentBackend: backend.name }),
    entry: missionEntry, capabilities: [...caps.active], enhanceActive,
  });
  // 구독 모드 — backend 지정 env 키 스크럽 후 강제 env까지 적용해 cmd·args·env를 순수 seam으로 구성한다.
  // forcedEnv 이름의 후속 로깅은 이 착지의 의도적 경계이며, spawn에는 같은 seam의 env가 그대로 흐른다.
  const spawnParams = resolveBackendSpawn(backend, process.env);
  const nestedRefusal = refuseNestedElanousOnBackend({
    backendName: backend.name,
    nestedLaunchRequested: spec.nestedElanousLaunch === true,
    ...(spec.nestedElanousAllow === true ? { allow: true } : {}),
    ...(getUserConfig().harness?.nestedElanous === 'allow' ? { configAllow: true } : {}),
    env: process.env,
  });
  if (nestedRefusal.refused) {
    debug.log('agent-mission.nested', 'refused', { agent: backend.name, depth: nestedRefusal.depth, reason: nestedRefusal.reason });
    return {
      ok: false, worktree: spec.workdir ?? '', branch: spec.branch ?? null, rounds: 0,
      evidencePath: null, committed: false, usedOmniCrawl: false,
      detail: `nested elanous refused (${nestedRefusal.reason})`,
    };
  }
  const env = spawnParams.env;
  if (backend.name === 'claude') {
    const status = (deps.checkClaudeSubscription ?? checkClaudeSubscription)({ env });
    debug.log('agent-mission.claude-subscription', 'status', {
      ok: status.ok, authMethod: status.authMethod, apiProvider: status.apiProvider, reason: status.reason,
    });
    if (!status.ok) {
      const action = status.reason === 'logged-out'
        ? 'Run `claude login` to authenticate a Claude subscription, then retry.'
        : status.reason === 'api-key'
          ? 'Claude is using API-key/provider authentication rather than a Claude subscription. Run `claude login` with a subscription account, then retry.'
          : 'Run `claude auth status --json` and check the Claude CLI/login, then retry.';
      return {
        ok: false, worktree: spec.workdir ?? '', branch: spec.branch ?? null, rounds: 0,
        evidencePath: null, committed: false, usedOmniCrawl: false,
        detail: `Claude subscription check failed (${status.reason}). ${action}`,
      };
    }
  }
  // ⭐ 이 자리는 «별칭»(createMissionWorktree)이라 소스 스캔이 못 찾았고 타입 검사가 찾았다
  //    — 리뷰 3R must-fix ② 가 경고한 그 형태다(별칭·래퍼는 정규식으로 못 센다).
  if (deps.isMissionAborted?.()) throw new Error('MISSION_ABORTED');
  const wt = spec.workdir
    ? { path: spec.workdir, branch: spec.branch ?? null, base: null }
    : deps.handoffWorktree ?? createMissionWorktree(buildMissionWorktreeRequest(spec, { repoRoot, worktreeRoot: configuredWorktreeRoot() }));
  if (spec.workdir) debug.log('agent-mission', 'workdir-mode', { workdir: wt.path, pids: [], reason: 'non-git' });
  else {
    if (!deps.handoffWorktree) recordMissionWorktreeProvenance(wt.path, buildMissionWorktreeProvenance(spec.branch!), recordWorktreeProvenance);
    debug.log('agent-mission', 'worktree', { path: wt.path, branch: wt.branch, base: wt.base });
  }
  const baselineTsc = spec.evidence.kind === 'tsc' ? (deps.initialTsc ?? collectTscDiagnostics(wt.path)) : null;
  const evidenceCheck: typeof checkEvidence = (worktree, evidence) => evidence.kind === 'tsc' && baselineTsc
    ? checkEvidence(worktree, evidence, { baseline: baselineTsc.diagnostics, executeTsc: baselineTsc.ran ? collectTscDiagnostics : () => baselineTsc })
    : checkEvidence(worktree, evidence, spec.workdir ? { startedAt, initialFiles } : {});
  const verifyEvidence: typeof checkEvidence = spec.workdir ? evidenceCheck : deps.checkEvidence ?? evidenceCheck;
  // Resolve identity before either child path; both receive the same run ID through env.
  if (deps.isMissionAborted?.()) throw new Error('MISSION_ABORTED');
  const runId = ensureRunId();
  env.ELANOUS_RUN_ID = runId;
  if (spec.headless === true) {
    // The non-interactive child receives the mission on stdin, never via a PTY or argv.
    // Keep the same enhancement and additive memory policy as the interactive mission.
    let prompt = spec.mission;
    let checklist: string[] = [];
    if (enhanceActive) {
      const { enhancePrompt } = await import('../prompt-enhance/enhance.js');
      const enhanced = await enhancePrompt(spec.mission, {
        ...(spec.deliverableHint ? { deliverableHint: spec.deliverableHint } : {}),
      });
      prompt = enhanced.enhanced;
      checklist = enhanced.checklist;
      debug.log('agent-mission', 'enhance', {
        checklist: checklist.length, enhancedBy: enhanced.enhancedBy,
        origChars: enhanced.original.length, enhancedChars: prompt.length, verbatimPreserved: enhanced.verbatimPreserved,
      });
    }
    if (spec.memory !== false) {
      const { recallMemoryContext } = await import('../agent-substrate/execution/memory-context.js');
      const mem = await recallMemoryContext(spec.mission.slice(0, 300), { limit: 5 });
      if (mem) { prompt = `${prompt}\n\n${mem}`; debug.log('agent-mission', 'memory', { injected: true, chars: mem.length }); }
      else debug.log('agent-mission', 'memory', { injected: false });
    }
    if (deps.isMissionAborted?.()) throw new Error('MISSION_ABORTED');
    const headlessRun = (deps.runClaudeHeadless ?? runClaudeHeadless)({ cwd: wt.path, prompt, env: envLiteral(env), maxTurns: maxRounds, onSpawn: deps.onHeadlessStarted });
    const result = await (deps.awaitMission ? deps.awaitMission(headlessRun) : headlessRun);
    debug.log('agent-mission', 'headless-result', {
      ok: result.ok, reason: result.reason, exitCode: result.exitCode,
      sessionId: result.sessionId, numTurns: result.numTurns, toolEvents: result.toolEvents,
      malformedLines: result.malformedLines, durationMs: result.durationMs,
    });
    if (!result.ok) return {
      ok: false, worktree: wt.path, branch: wt.branch, rounds: result.numTurns ?? 0,
      evidencePath: null, committed: false, usedOmniCrawl: false,
      detail: `Claude headless failed (${result.reason}; exit ${result.exitCode ?? 'unknown'}). Check the Claude CLI and retry.`,
    };
    if (deps.isMissionAborted?.()) return { ok: false, reason: 'aborted', worktree: wt.path, branch: wt.branch,
      rounds: result.numTurns ?? 0, evidencePath: null, committed: false, usedOmniCrawl: false, detail: 'aborted' };
    const finalEv = verifyEvidence(wt.path, spec.evidence);
    if (!finalEv.ok) return {
      ok: false, worktree: wt.path, branch: wt.branch, rounds: result.numTurns ?? 0,
      evidencePath: null, evidenceSatisfied: false, committed: false, usedOmniCrawl: false,
      detail: `미완(증거 부족): ${finalEv.retry ?? '증거가 아직 부족하다.'}`,
    };
    if (checklist.length) {
      const { verifyCoverage } = await import('../prompt-enhance/coverage.js');
      const coverage = await verifyCoverage(gatherArtifactText(wt.path, finalEv.path), checklist, {});
      debug.log('agent-mission', 'coverage', { covered: coverage.covered.length, missing: coverage.missing.length,
        ratio: Number(coverage.ratio.toFixed(2)), method: coverage.method, coverageRetries: 0 });
      if (coverage.missing.length) debug.log('agent-mission', 'coverage-exhausted', { missing: coverage.missing.length });
    }
    let committed = false;
    if (!deps.isMissionAborted?.() && !spec.workdir && (spec.commit ?? true)) {
      const c = (deps.commitWorktree ?? commitWorktree)(wt.path, `chore(agent-mission): ${spec.branch} — claude-in-elanous headless 산출`);
      committed = c.ok;
      debug.log('agent-mission', 'commit', { ok: c.ok, out: c.out.slice(0, 120) });
      if (!c.ok) {
        debug.log('agent-mission', 'result', { ok: false, rounds: result.numTurns ?? 0, evidencePath: finalEv.path, committed: false, usedOmni: false });
        return { ok: false, worktree: wt.path, branch: wt.branch, rounds: result.numTurns ?? 0,
          evidencePath: finalEv.path, evidenceSatisfied: true, committed: false, usedOmniCrawl: false,
          detail: `미완(자동 커밋 실패): ${c.out.slice(0, 120)}` };
      }
    }
    debug.log('agent-mission', 'result', { ok: true, rounds: result.numTurns ?? 0, evidencePath: finalEv.path, committed, usedOmni: false });
    return { ok: true, worktree: wt.path, branch: wt.branch, rounds: result.numTurns ?? 0,
      evidencePath: finalEv.path, evidenceSatisfied: true, committed, usedOmniCrawl: false, detail: '완료(증거 충족)' };
  }
  env.TERM = 'xterm-256color';
  // Claude's per-child MCP override is held until the PTY exits, not until the control loop returns.
  const claudeChild = backend.name === 'claude'
    ? prepareClaudeChildSpawn(spawnParams, { backendName: backend.name, depth: readNestedElanousDepth(process.env), allowNestedElanous: spec.nestedElanousAllow === true || getUserConfig().harness?.nestedElanous === 'allow' })
    : undefined;
  // ⭐run-identity — runId was resolved before either headless or PTY spawn.
  debug.log('agent-mission', 'spawn', { agent: backend.name, cmd: `${spawnParams.cmd} ${(claudeChild?.args ?? spawnParams.args).join(' ')}`, scrubbed: backend.scrubEnv ?? [], nestedEnvRemovedCount: spawnParams.nestedEnvRemovedCount, runId });
  // PTY 정체성 — kind(=backend)·nickname(goto 로 나중 접근)·accessMode='auto'(헤드리스 자율·brain 이 write 소유).
  const ptyOpts = buildAgentMissionPtySpawnOptions({
    backend,
    spawn: { cmd: spawnParams.cmd, args: claudeChild?.args ?? spawnParams.args, env, unsetEnv: spawnParams.unsetEnv },
    workdir: wt.path,
    nickname: spec.nickname ?? spec.branch ?? backend.name,
  });
  const childStartedAt = Date.now();
  let liveDirty = false, liveChunks = 0;
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  let usageReemitted = false;
  let childSessionId: string | undefined;
  let sessionOutput = '';
  let claudeCleanupTimer: ReturnType<typeof setInterval> | undefined;
  const cleanupClaude = (): void => {
    if (claudeCleanupTimer) clearInterval(claudeCleanupTimer);
    claudeChild?.cleanup();
  };
  const offLive = onPtyEvent((ev) => {
    if (ev.id !== ptyOpts.id) return;
    if (ev.type === 'output') {
      liveDirty = true; liveChunks += 1;
      if (backend.name === 'codex' && !childSessionId) {
        sessionOutput = (sessionOutput + ev.chunk).slice(-8192);
        childSessionId = sessionOutput.match(/Session ID:\s*([0-9a-f]{8}-[0-9a-f-]{27,})/i)?.[1];
      }
    }
    if (ev.type === 'exit') {
      offLive();
      if (liveTimer) clearInterval(liveTimer);
      cleanupClaude();
    }
    if (ev.type === 'exit' && backend.name === 'codex' && !usageReemitted) {
      usageReemitted = true;
      if (!childSessionId) {
        debug.log('agent-mission', 'pty-usage-session-unidentified', { runId, ptyId: ptyOpts.id }, { level: 'warn' });
      }
      try {
        (deps.reemitPtyUsage ?? reemitPtyUsage)({
          codexHome: env.CODEX_HOME || join(env.HOME || homedir(), '.codex'),
          runId,
          workdir: wt.path,
          sessionId: childSessionId ?? '',
          sinceMs: childStartedAt,
        });
      } catch (error) {
        debug.log('agent-mission', 'pty-usage-reemit-failed', {
          runId, error: error instanceof Error ? error.message : String(error),
        }, { level: 'warn' });
      }
    }
  });
  let h: PtyHandle;
  if (deps.isMissionAborted?.()) { offLive(); cleanupClaude(); throw new Error('MISSION_ABORTED'); }
  try { h = spawnPty(ptyOpts); }
  catch (error) { offLive(); cleanupClaude(); throw error; }
  if (!h.isAlive()) cleanupClaude();
  else if (claudeChild) {
    // A test-injected PTY may not emit registry events; keep the config until its handle exits.
    claudeCleanupTimer = setInterval(() => {
      if (!h.isAlive()) cleanupClaude();
    }, 1000);
    claudeCleanupTimer.unref();
  }
  if (backend.name === 'codex') observeExternalEvent({ origin: 'codex-agent-mission', kind: 'started',
    summary: 'Codex agent mission started', source: `elanous://agent-mission/${encodeURIComponent(runId)}/${encodeURIComponent(h.id)}` });
  let contextFinished = false;
  const finishContext = (ok: boolean): void => {
    if (contextFinished || backend.name !== 'codex') return;
    contextFinished = true;
    observeExternalEvent({ origin: 'codex-agent-mission', kind: 'finished',
      summary: `Codex agent mission ${ok ? 'completed' : 'failed'}`,
      source: `elanous://agent-mission/${encodeURIComponent(runId)}/${encodeURIComponent(h.id)}` });
  };
  deps.onPtyStarted?.(h, () => { if (liveTimer) clearInterval(liveTimer); offLive(); finishContext(false); cleanupClaude(); });
  if (deps.isMissionAborted?.()) { finishContext(false); cleanupClaude(); return { ok: false, reason: 'aborted', worktree: wt.path, branch: wt.branch,
    rounds: 0, evidencePath: null, committed: false, usedOmniCrawl: false, detail: 'aborted' }; }
  const executorRef = buildExecutorPtyRef({
    ptyId: h.id,
    backend: backend.name,
    runId, // child env(ELANOUS_RUN_ID)와 동일 — spawn 前 확정
    spaceId: env.ELANOUS_HARNESS_SPACE_ID,
    instance: resolveInstanceName(),
  });
  debug.log('agent-mission', 'pty', { id: h.id, kind: h.kind, nickname: h.nickname, accessMode: h.accessMode, executorRef });
  const webAddress = (deps.resolvePtyWebAddress ?? resolvePtyWebAddress)(h.id);
  process.stderr.write(`[agent-mission] pty=${h.id} watch=${webAddress.webUrl ?? `(web unavailable: ${webAddress.pwaUnavailableReason ?? 'not-resolved'})`}\n`);
  debug.log('agent-mission', 'pty-link', { id: h.id, webUrl: webAddress.webUrl, webUrlSource: webAddress.webUrlSource });

  const decisionIdentity = { missionId: spec.decisionMissionId ?? runId, sessionId: runId, terminalId: h.id, agent: backend.name };
  const decisionEvent = (event: Omit<DecisionInput, keyof typeof decisionIdentity>): void => {
    try { (deps.emitPtyDecision ?? emitPtyDecision)({ ...decisionIdentity, ...event } as DecisionInput); }
    catch { /* Observation must not change mission control or handoff. */ }
  };

  // ⭐P2 arbiter: the child is accessMode='auto' (brain-owned), so the driver —
  // the autonomous brain — must write as 'agent' or the arbiter denies it. This
  // makes "protected autonomy" real: a human attaching mid-mission (read) can't
  // inject unless they takeover (auto→write, needs 'open' policy). `h['write']`
  // form so the drive helper isn't caught by the h.write→drive rewrite.
  //
  // 초기 미션 전송 중 소유권을 잃으면 write 를 시도하지 않는다. 제어 루프에 들어간 뒤의
  // takeover 는 awaitOwnership 으로 기다리며, 사람이 release 하면 미션을 재개한다.
  const drive = (s: string): void => {
    if (deps.isMissionAborted?.()) return;
    // ⭐공용 seam(P2b P-a′) — 판정은 `pty-control-stance` 한 곳. 집행(throw)은 종전 그대로다(무회귀).
    const stance = probeControlStance(h, 'agent', (e) =>
      debug.log('agent-mission', 'hascontrol-error', { id: h.id, error: (e as Error)?.message ?? String(e) }));
    if (stanceBlocksWrite(stance)) {
      debug.log('agent-mission', 'yield-to-human', { id: h.id, mode: h.accessMode, stance,
        reason: stance === 'unknown'
          ? 'control ownership unverifiable — 조회 실패라 takeover 여부를 단정할 수 없다'
          : 'arbiter denied agent write — 사람 takeover',
        ...supervisionObservationFields(mapControlStance(stance, 'halt')) });
      // ⚠️ `unknown`(조회 실패)을 *사람 takeover* 로 단정하지 않는다 — 구조화 로그와 문구가 어긋나면
      //   진단이 엉뚱한 곳을 판다. 집행(중단)은 종전과 같다.
      throw new Error(stance === 'unknown'
        ? 'AGENT_YIELDED: PTY 소유권 조회 실패(unverifiable) — 자율 미션 중단'
        : 'AGENT_YIELDED: PTY 제어가 사람에게 이양됨(takeover) — 자율 미션 중단');
    }
    h['write'](s, 'agent');
    decisionEvent({ step: 'input', text: s === '\r' ? 'Sent Enter' : `Sent ${s.startsWith('\x1b') ? 'key' : 'text'}: ${s.startsWith('\x1b') ? 'navigation' : s}` });
  };

  let seq = 0;
  const capture = async (label: string): Promise<string> => {
    const s = await h.renderScreen();
    try { writeFileSync(join(screensDir, `${String(++seq).padStart(2, '0')}-${label}.txt`), s); } catch { /* noop */ }
    debug.log('agent-mission', 'screen', buildScreenLogPayload(label, s));
    return s;
  };

  // ── 라이브 포워딩 (P0a·B2 근본수리) — registry push 버스(onPtyEvent) 구독 → 연속 화면 스트림.
  //   종전엔 라운드 경계 renderScreen 1회만(waitForQuiet 가 라운드 내 출력 삼킴) = 스냅샷만. 이제 출력 chunk
  //   마다 dirty 표시 → 디바운스 타이머가 live.txt 갱신(cat 으로 실시간 관측)+하트비트. controller/PWA 도 같은
  //   버스 구독 가능(중첩 포워딩 씨앗). 능력 신설 아님 — 이미 있는 버스를 미션 드라이버에 배선.
  const liveFile = join(screensDir, 'live.txt');
  liveTimer = setInterval(() => {
    if (!liveDirty) return;
    liveDirty = false;
    void h.renderScreen().then((s) => {
      try { writeFileSync(liveFile, s); } catch { /* noop */ }
      if (liveChunks % 20 === 0) debug.log('agent-mission', 'live', { chunks: liveChunks, tail: s.slice(-80).replace(/\s+/g, ' ') });
    }).catch(() => { /* noop */ });
  }, 800);
  const stopLive = (ok = false): void => { if (liveTimer) clearInterval(liveTimer); offLive(); if (ok) finishContext(true); };
  try {

  // ready + trust — backend 별 신뢰/권한 프롬프트 처리(codex=1, 이후 백엔드는 자체 handler).
  await (deps.awaitMission ? deps.awaitMission(waitForQuiet(h, missionTiming.readyQuietMs, 20000)) : waitForQuiet(h, missionTiming.readyQuietMs, 20000));
  if (deps.isMissionAborted?.()) throw new Error('MISSION_ABORTED');
  let screen = await (deps.awaitMission ? deps.awaitMission(capture('ready')) : capture('ready'));
  if (deps.isMissionAborted?.()) throw new Error('MISSION_ABORTED');
  // A trust menu can need more than one key (claude: ↓ to «Yes», then Enter) — answer until it is gone, at most 3 times.
  //   🩸 09-29: one pass sent only ↓, the mission text went into the menu and its Enter confirmed «Yes» instead of
  //   submitting the mission, which then sat unsent in the input box.
  for (let pass = 0; pass < 3 && backend.handleTrust?.(screen, (s) => {
    drive(s);
    // Moving the selection is only input; the trust question is answered when the choice is confirmed.
    if (s === '\r') decisionEvent({ step: 'answer', text: 'Answered folder trust prompt', detail: { question: 'Trust this folder?', answer: 'Confirm selected choice' } });
  }); pass++) {
    debug.log('agent-mission', 'trust', { agent: backend.name, action: 'handled', pass });
    const trusted = (async () => { await waitForQuiet(h, missionTiming.readyQuietMs, 15000); return capture('trusted'); })();
    screen = await (deps.awaitMission ? deps.awaitMission(trusted) : trusted);
  }

  let resourcePlan: ResourcePlan | undefined;
  // Only an explicit `on` runs the ladder (the CLI passes `on` by default). Library callers and fake-PTY
  // tests that leave it unset keep the pre-ladder behaviour — 09-29 #21849 made them wait on a real LLM.
  if (spec.resources === 'on') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      resourcePlan = await Promise.race([
        (deps.planMissionResources ?? planMissionResources)(spec.mission, deps.resourceLadder ?? {}, {
          backend: spec.backendExplicit,
          plugin: spec.plugin ? `${spec.plugin.plugin}@${spec.plugin.marketplace}` : undefined,
          resources: spec.resources,
          deadlineMs: 20_000,
        }),
        new Promise<never>((_resolve, reject) => { timer = missionTiming.scheduleTimeout(() => reject(new Error('resource ladder timeout (20s)')), 20_000); }),
      ]);
      debug.log('agent-mission.resources', 'planned', {
        have: resourcePlan.have.length, gaps: resourcePlan.gaps.length,
        suggestedPlugin: resourcePlan.plugin?.plugin, suggestedBackend: resourcePlan.backend?.name,
        executedBackend: backend.name,
      });
    } catch (error) {
      debug.log('agent-mission.resources', 'plan-failed', { reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    } finally { if (timer) clearTimeout(timer); }
  }
  const suggestedPlugin = resourcePlan?.plugin?.source === 'official-index' && !spec.plugin
    && !spec.headless && (backend.name === 'codex' || backend.name === 'claude')
    && resourcePlan.plugin.marketplace === 'elanous'
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resourcePlan.plugin.plugin)
    ? { plugin: resourcePlan.plugin.plugin, marketplace: resourcePlan.plugin.marketplace } : undefined;
  const requestedPlugin = spec.plugin ?? suggestedPlugin;
  let installedPlugin: typeof requestedPlugin;
  if (requestedPlugin) {
    try {
      const plugin = await (deps.installPlugin ?? installPluginInsideAgent)(
        { agent: backend.name as 'codex' | 'claude', ...requestedPlugin }, h,
        { ...(backend.handleTrust ? { handleTrust: backend.handleTrust } : {}), ...deps.pluginDeps, write: drive },
      );
      if (plugin.outcome !== 'installed') {
        if (spec.plugin) {
          stopLive();
          try { h.kill(); } catch { /* already exited */ }
          return { ok: false, worktree: wt.path, branch: wt.branch, rounds: 0, evidencePath: null,
            committed: false, usedOmniCrawl: false, detail: `플러그인 설치 ESCALATE (${plugin.reason}) — 미션은 전송하지 않았다` };
        }
        debug.log('agent-mission.resources', 'install-failed', { plugin: requestedPlugin.plugin, reason: plugin.reason }, { level: 'warn' });
      } else installedPlugin = requestedPlugin;
    } catch (error) {
      if (spec.plugin) throw error;
      debug.log('agent-mission.resources', 'install-failed', { plugin: requestedPlugin.plugin, reason: 'installer-error' }, { level: 'warn' });
    }
  }

  // ★ elanous 내부 인핸싱(opt-in) — 원문 verbatim 보존 + 커버리지 체크리스트 부착(anti-drift).
  //   외부(1차)는 원문을 재해석 없이 넘기고, 인핸싱은 elanous(2차) 안에서만 가산적으로 일어난다.
  let missionText = spec.mission;
  let checklist: string[] = [];
  if (enhanceActive) {
    const { enhancePrompt } = await import('../prompt-enhance/enhance.js');
    const enh = await enhancePrompt(spec.mission, {
      ...(spec.deliverableHint ? { deliverableHint: spec.deliverableHint } : {}),
    });
    missionText = enh.enhanced;
    checklist = enh.checklist;
    debug.log('agent-mission', 'enhance', {
      checklist: enh.checklist.length, enhancedBy: enh.enhancedBy,
      origChars: enh.original.length, enhancedChars: enh.enhanced.length, verbatimPreserved: enh.verbatimPreserved,
    });
  }

  // ★ entry-independent 기억 (PLAN §6e FIX) — 어떤 진입이든 elanous 기억을 가산 컨텍스트로(프롬프트 무접촉·
  //   인핸싱과 독립·mirage 가드). 인핸싱 OFF(external-verbatim)에서도 원문 안 건드리고 기억만 얹음.
  if (spec.memory !== false) {
    const { recallMemoryContext } = await import('../agent-substrate/execution/memory-context.js');
    const mem = await recallMemoryContext(spec.mission.slice(0, 300), { limit: 5 });
    if (mem) { missionText = `${missionText}\n\n${mem}`; debug.log('agent-mission', 'memory', { injected: true, chars: mem.length }); }
    else debug.log('agent-mission', 'memory', { injected: false });
  }

  if (installedPlugin) missionText = `${missionText}\n\n설치된 ${installedPlugin.plugin} 플러그인에서 실제 스킬을 확인하고 ${installedPlugin.plugin}:<skill> 형식으로 해당 스킬을 사용하라.`;
  if (resourcePlan) {
    const safeName = (name: string) => sanitizeForPtyInput(name, 80)
      .replace(/\b(?:bearer|secret|password|token|api.?key|authorization)\s*[:=]\s*\S+|(?:sk-[\w-]+|gh[pousr]_[\w-]+|github_pat_[\w-]+|AIza[\w-]+|xox[baprs]-[\w-]+)/gi, '[redacted]')
      .replace(/https?:\/\/\S+/gi, '[redacted]');
    const have = resourcePlan.have.slice(0, 5).map(safeName);
    const gaps = resourcePlan.gaps.slice(0, 5).map(gap => safeName(gap.need));
    missionText = `${missionText}\n\n[elanous 자원]\n보유: ${have.join(', ') || '없음'}\n설치: ${installedPlugin ? `${installedPlugin.plugin}@${installedPlugin.marketplace}` : '없음'}\n미충족: ${gaps.join(', ') || '없음'}`;
  }
  if (deps.isMissionAborted?.()) throw new Error('MISSION_ABORTED');
  // 미션 전송 — 인핸싱/기억으로 가공됐으면(멀티라인) 파일로 떨궈 read 지시(TUI 멀티라인 위험·verbatim 보존).
  //   원문 그대로면(단문) 타이핑.
  let submittedCommand = spec.mission;
  const submittedInputs: string[] = [];
  if (missionText !== spec.mission) {
    const pf = join(wt.path, '.mission-prompt.md');
    try { writeFileSync(pf, missionText); } catch { /* noop */ }
    const note = enhanceActive
      ? '.mission-prompt.md 파일을 읽고 그 안의 미션을 완수하라. [elanous 인핸싱]의 커버리지 체크리스트 모든 항목을 산출물에 빠짐없이 반영하고(요약·일반화 금지), 완료하면 MISSION-COMPLETE 라고 답하라.'
      : '.mission-prompt.md 파일을 읽고 그 안의 미션을 완수하라(원문 그대로·[elanous 기억]은 참조 컨텍스트). 완료하면 MISSION-COMPLETE 라고 답하라.';
    debug.log('agent-mission', 'mission-send', { via: 'file', file: '.mission-prompt.md', chars: missionText.length, enhanced: enhanceActive });
    submittedCommand = note;
    submittedInputs.push(note);
    drive(note); await sleep(missionTiming.keystrokeGapMs); drive('\r');
  } else {
    debug.log('agent-mission', 'mission-send', { via: 'type', chars: spec.mission.length });
    submittedInputs.push(spec.mission);
    drive(spec.mission); await sleep(missionTiming.keystrokeGapMs); drive('\r');
  }

  let usedOmni = false;
  let controllerSummary = deps.previousSummary ?? '';
  let reviewSummary = '';
  let coverageRetries = enhanceActive && checklist.length ? 2 : 0;
  let pendingAnswer: { text: string; question: string; answer: string } | undefined;
  const search = createMissionSearch({ worktree: wt.path, omniPath });
  const brain = createMissionControlBrain({
    mission: spec.mission,
    backend,
    stream: deps.controlStream,
    handoffEnabled: true,
    recoverAfterMs: spec.recoverAfterMs,
    initialCommand: submittedCommand,
    onRecover: (blocked, action) => { decisionEvent({ step: 'recover', text: action, detail: { blocked, action } }); },
    onSummary: (summary) => { controllerSummary = summary; },
    onDecision: (text, reply) => {
      pendingAnswer = reply ? { text: `${reply.answer || 'continue'}\r`, ...reply } : undefined;
      decisionEvent({ step: 'judge', text });
    },
    evidenceReady: () => spec.chain && spec.chain.length > 1 ? true : verifyEvidence(wt.path, spec.evidence).ok,
    search: async (query, step) => {
      usedOmni = true;
      await search(query, step);
    },
    // ★ P4 역량 프로비저닝(2026-07-25) — 감독이 자식의 없는 Node 패키지를 **worktree(wt.path)** 에 자율 설치.
    //   정책 게이트(pkg 만·안전 spec·매니저 allowlist·--ignore-scripts) + worktree-local node_modules. ⚠️ 완전
    //   sandbox 는 아님(설치 코드는 import 시 실행·서브프로세스 write 는 #4 경계 밖) — 자세한 격리 한계는 provision.ts 헤더. 관측=autopilot.provision.
    //   buildMissionProvision 팩토리로 배선(wt.path→cwd 를 DI 로 행동검증 가능·소스 tripwire 불요).
    provision: buildMissionProvision(wt.path),
  });
  // A trust/permission prompt can appear after the first screen (09-29 S6: codex 0.157 showed «Folder access»
  // 70 s after launch, after the one-shot check). Answer it at every step with the backend's own bytes
  // before asking the LLM — otherwise the mission text is typed into the prompt and the run stalls.
  const trustAwareBrain: RunSupervisor = {
    decide: (obs, signal) => {
      decisionEvent({ step: 'read', text: `step ${obs.step} (${obs.state}): ${classifierFrameLines(obs.screen).at(-1) ?? 'empty screen'}` });
      pendingAnswer = undefined;
      let answer: string | undefined;
      if (backend.handleTrust?.(obs.screen, (bytes) => { answer = bytes; }) && answer !== undefined) {
        debug.log('agent-mission', 'trust', { agent: backend.name, action: 'handled-in-loop', step: obs.step });
        decisionEvent({ step: 'judge', text: `step ${obs.step}: trust prompt` });
        // Only the confirming Enter answers the trust question; a navigation key stays an input event.
        if (answer === '\r') pendingAnswer = { text: answer, question: 'Trust this folder?', answer: 'Confirm selected choice' };
        emitDecision({ kind: 'ROUTE', what: `${backend.name} 폴더 신뢰 화면 → 계속`, reason: '시작 뒤 늦게 뜬 신뢰 확인', purpose: '미션을 이어 간다', target: backend.name, phase: 'implement' });
        return { action: 'input', text: answer };
      }
      return brain.decide(obs, signal);
    },
  };
  let pendingHandoff: { to: 'codex' | 'claude'; mission: string; summary: string } | undefined;
  let gatedHandoff = false;
  let handoffPrSkipped = false;
  let transitionFailure: string | undefined;
  const handoffOps: HandoffOperations = {
    start: async (to, mission) => { pendingHandoff = { to, mission, summary: controllerSummary }; },
    claudeLoggedIn: () => (deps.checkClaudeSubscription ?? checkClaudeSubscription)({ env: resolveBackendSpawn(claudeBackend, process.env).env }).ok,
    screen: () => h.renderScreen(),
    alive: () => h.isAlive(),
    login: async (worktree) => {
      const loginSpawn = resolveBackendSpawn(claudeBackend, process.env);
      const handle = spawnPty(buildAgentMissionPtySpawnOptions({
        backend: claudeBackend,
        spawn: { cmd: loginSpawn.cmd, args: ['login'], env: { ...loginSpawn.env, TERM: 'xterm-256color' }, unsetEnv: loginSpawn.unsetEnv },
        workdir: worktree,
        nickname: `${spec.branch}-login`,
      }));
      return { screen: () => handle.renderScreen(), alive: () => handle.isAlive(), close: () => handle.kill() };
    },
    sleep: async (ms) => { await sleep(ms); },
    notify: async (card) => {
      const { sendOutbound } = await import('../domains/outbound-alert.js');
      if (!sendOutbound([card.text, card.url, card.code].filter(Boolean).join('\n'), 'agent-mission')) {
        throw new Error('agent mission login card delivery failed');
      }
    },
    gateAndPr: async (worktree) => {
      if (spec.commit === false) throw new Error('elanous PR handoff requires commit authorization');
      const ev = (deps.checkEvidence ?? evidenceCheck)(worktree, spec.evidence);
      if (!ev.ok) throw new Error(`handoff evidence gate failed: ${ev.retry ?? 'missing evidence'}`);
      const promptFile = join(worktree, '.mission-prompt.md');
      let promptExisted = false;
      try { lstatSync(promptFile); promptExisted = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (promptExisted) unlinkSync(promptFile);
      debug.log('agent-mission', 'handoff-prompt-file-removed', { existed: promptExisted });
      const stagedPrompt = execFileSync('git', ['ls-files', '--cached', '--', '.mission-prompt.md'], { cwd: worktree, encoding: 'utf8' });
      if (stagedPrompt.trim()) {
        execFileSync('git', ['rm', '-f', '--cached', '--', '.mission-prompt.md'], { cwd: worktree, encoding: 'utf8' });
      }
      if (execFileSync('git', ['ls-files', '--cached', '--', '.mission-prompt.md'], { cwd: worktree, encoding: 'utf8' }).trim()) {
        throw new Error('handoff prompt file remains in commit index');
      }
      const commit = (deps.commitWorktree ?? commitWorktree)(worktree, `chore(agent-mission): ${spec.branch} handoff`);
      if (!commit.ok) throw new Error(`handoff commit failed: ${commit.out}`);
      execFileSync('git', ['push', '-u', 'origin', `HEAD:${spec.branch}`], { cwd: worktree, encoding: 'utf8', timeout: 120_000 });
      const pushUrls = execFileSync('git', ['remote', 'get-url', '--push', '--all', 'origin'], { cwd: worktree, encoding: 'utf8' }).trim().split('\n');
      if (!pushUrls.length || !pushUrls.every((url) => /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)[^/]+\/[^/]+\/?$/i.test(url))) {
        handoffPrSkipped = true;
        debug.log('agent-mission', 'handoff-pr-skipped', { reason: 'origin-not-github' });
      } else {
        const opened = (deps.dispatchOpenPullRequest ?? dispatchOpenPullRequest)({ title: `agent-mission: ${spec.branch}`, body: deps.originalMission ?? spec.mission, head: spec.branch, base: spec.base ?? 'main' }, { cwd: worktree });
        if (opened.number !== null) deps.onMissionPrNumber?.(opened.number);
      }
      gatedHandoff = true;
    },
    ...deps.handoffOperations,
  };
  const verifyDone = createMissionVerifyDone({
    worktree: wt.path,
    evidence: spec.evidence,
    checklist,
    coverageRetries,
    checkEvidence: verifyEvidence,
  });
  // ★ P3b-2 observe 어댑터(2026-07-25) — EMIT-side(makeMissionObserveStep)가 프레임 버스에 흘리는 executor
  //   화면을 **구조화 진행 다이제스트**(state+요약·throttle)로 압축해 observe 서피스(로그 패브릭)에 노출한다.
  //   raw 화면(self screen/manifest)이 아닌 "지금 뭐 하나" 서사. brain 무접촉·순수 관측·재발명 0(버스 구독 +
  //   classifyFrameState). 조회=`elanous logs --category agent-mission.observe`. runWithControlObserve seam 이
  //   attach→run→cleanup(성공·예외·fail-soft attach) 전 경로를 소유(누수·관측예외로부터 미션 보호). runId
  //   필터로 이 run 의 프레임만 관측(PTY 재사용 시 타 run 혼입 방지). 텔레그램/TUI sink 는 얇은 후속 부착.
  // ★ 동일 버스 인스턴스 보장(리뷰 should-fix) — observe 구독과 EMIT(makeMissionObserveStep)이 **같은** 버스를
  //   봐야 프레임이 흐른다. getChannelBus() 를 두 번 부르지 말고 지역 캐시로 구조적 보장.
  const bus = getChannelBus();
  const observeStep = makeMissionObserveStep({
    capture,
    renderPng: () => h.renderScreenPng(),
    bus,
    ident: { ptyId: h.id, instance: resolveInstanceName(), runId },
  });
  debug.log('agent-mission', 'takeover-wait', { id: h.id, maxWaitMs: AGENT_MISSION_TAKEOVER_WAIT_MS });
  const controlRun = runWithControlObserve(
    bus, execSurfaceId(h.id),
    (d) => debug.log('agent-mission.observe', 'progress', { surfaceId: d.surfaceId, state: d.state, summary: d.summary, unknownInput: d.unknownInput, frame: d.frameCount, runId: d.runId }),
    () => {
      const handleDeps = controlDepsForHandle(h);
      const inject = backend.name === 'claude' ? submitSeparately(handleDeps.inject) : handleDeps.inject;
      const pending = (deps.runControlLoop ?? runPtyControlLoop)(trustAwareBrain, {
        ...handleDeps,
        inject: (text) => {
          const reply = pendingAnswer?.text === text ? pendingAnswer : undefined;
          pendingAnswer = undefined;
          const accepted = inject(text);
          if (accepted) {
            submittedInputs.push(text);
            decisionEvent({ step: 'input', text: `Sent ${text.startsWith('\x1b') ? 'key' : 'text'}: ${text.startsWith('\x1b') ? 'navigation' : text}` });
          }
          // Recovery stages and recover events are committed only after the PTY accepted the input.
          brain.onInputResult(text, accepted);
          if (accepted) {
            if (reply) decisionEvent({ step: 'answer', text: 'Answered agent question', detail: { question: reply.question, answer: reply.answer } });
          }
          return accepted;
        },
        injectKey: handleDeps.injectKey && ((name, repeat) => {
          const accepted = handleDeps.injectKey!(name, repeat);
          if (accepted) decisionEvent({ step: 'input', text: `Pressed ${name}${repeat ? ` ×${repeat}` : ''}`, detail: { keys: name } });
          return accepted;
        }),
        ...(deps.isMissionAborted ? {
          controlStance: () => deps.isMissionAborted!() ? 'unknown' as const : probeControlStance(h, 'agent', (e) =>
            debug.log('agent-mission', 'hascontrol-error', { id: h.id, error: (e as Error)?.message ?? String(e) })),
        } : {}),
        awaitOwnership: { maxWaitMs: AGENT_MISSION_TAKEOVER_WAIT_MS },
        settle: async () => {
          // A frozen screen goes quiet after 6 s, so stall recovery is still observed; work that keeps
          // drawing output keeps the original 360 s settle and round budget.
          const quiet = waitForQuiet(h, 6000, 360000);
          await (deps.awaitMission ? deps.awaitMission(quiet) : quiet);
        },
      // ★ U5 — 제어스텝 관측: 프레임 버스 발행(PTY 감독 계열 통일 합류·headless #5379 와 동일 seam) + 화면 전사.
      //   발행 먼저·내부 fail-soft(관측이 미션 안 깸)·capture 는 예외 전파(원 semantics). 배선=makeMissionObserveStep.
      onStep: async (obs, decision) => {
        await observeStep(obs, decision);
        if (backend.name === 'claude') {
          // Keep only review findings, not authentication screens or a raw PTY transcript.
          const finding = obs.screen.match(/(?:review findings?|finding|issues?|지적|문제)\s*[:：]\s*([^\r\n]+)/i)?.[1]?.trim();
          if (finding && !/login|log in|sign in|https?:\/\/|token|cookie|password|장치 코드|로그인/i.test(finding)) {
            reviewSummary = `${reviewSummary}\n${finding}`.trim().slice(-3500);
          }
        }
      },
      verifyDone: spec.chain && spec.chain.length > 1 ? async () => ({ ok: true as const }) : async (obs) => {
        const verdict = await verifyDone(obs);
        if (!verdict.ok) decisionEvent({ step: 'recover', text: 'Evidence check requires another attempt', detail: { blocked: verdict.retry, action: 'Retry after fixing evidence' } });
        return verdict;
      },
      handoff: async (decision, obs) => {
        try {
          if (spec.chain && decision.to !== spec.chain[1]) throw new Error(`chain order violation: expected ${spec.chain[1] ?? 'completion'}, got ${decision.to}`);
          if (await handoffMission(decision, wt.path, handoffOps, reviewSummary || controllerSummary) === 'gated') gatedHandoff = true;
        } catch (error) {
          transitionFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      askHuman: async (decision) => {
        try {
          await waitForHumanLogin(decision, handoffOps);
          decisionEvent({ step: 'answer', text: 'Human login question resolved', detail: { question: decision.reason, answer: 'Login completed' } });
        } catch (error) {
          transitionFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      }, { maxSteps: maxRounds, stuckLimit: maxRounds + 1 });
      deps.onControlActive?.(pending);
      return pending;
    },
    { onSettled: (digestCount) => debug.log('agent-mission.observe', 'summary', { digestCount }), observeOpts: { expectRunId: runId } },
  );
  deps.onControlPending?.(controlRun);
  const control = await (deps.awaitMission ? deps.awaitMission(controlRun) : controlRun);
  if (deps.isMissionAborted?.()) throw new Error('MISSION_ABORTED');
  if (control.termination.kind === 'success' && !control.handoff && spec.chain && spec.chain.length > 1) {
    const to = spec.chain[1]!;
    try {
      if (await handoffMission({ action: 'handoff', to, mission: to === 'claude' ? 'Review changes and report findings; do not rewrite the original mission.' : to === 'codex' ? `Address the review findings and finish the original mission.\nOriginal mission:\n${deps.originalMission ?? spec.mission}` : deps.originalMission ?? spec.mission, carry: to === 'claude' ? 'diff' : 'summary' }, wt.path, handoffOps, reviewSummary || controllerSummary) === 'gated') gatedHandoff = true;
    } catch (error) {
      stopLive();
      try { h.kill(); } catch { /* noop */ }
      throw error;
    }
  }
  const nextChain = spec.chain?.slice(1);
  if (transitionFailure || (control.termination.kind !== 'success' && pendingHandoff)) {
    stopLive();
    try { h.kill(); } catch { /* noop */ }
    throw new Error(transitionFailure ?? 'handoff was requested but the PTY control loop did not finish successfully');
  }
  if (pendingHandoff) {
    stopLive();
    try { h.kill(); } catch { /* noop */ }
    const next = pendingHandoff;
    return runAgentMission({ ...spec, plugin: undefined, agent: resolveBackend(next.to), mission: next.mission, chain: nextChain && nextChain.length > 1 ? nextChain : undefined, enhance: false, memory: false }, { ...deps, handoffWorktree: { path: wt.path, branch: wt.branch!, base: wt.base! }, originalMission: deps.originalMission ?? spec.mission, previousSummary: next.summary, initialTsc: baselineTsc, runtimeFallback: { ...runtimeFallback, fallbackEligible: false } });
  }
  // A gate/PR handoff only counts as success when the control loop itself did not end in error.
  if (gatedHandoff && control.termination.kind !== 'error') {
    // The gate hands off a branch, not a file: record what is known instead of mislabeling the worktree directory.
    decisionEvent({ step: 'done', text: 'Mission handoff gate completed', detail: { result: { kind: 'text', ref: `branch ${wt.branch}` } } });
    stopLive(true);
    try { h.kill(); } catch { /* noop */ }
    return { ok: true, worktree: wt.path, branch: wt.branch, rounds: control.steps, evidencePath: wt.path, committed: true, usedOmniCrawl: usedOmni,
      ...(handoffPrSkipped ? { pr: 'skipped' as const, reason: 'origin-not-github' as const } : {}),
      evidenceSatisfied: true, detail: handoffPrSkipped ? '완료(증거 게이트·push·PR 생략)' : '완료(증거 게이트·PR)' };
  }
  const done = control.termination.kind === 'success';
  const round = control.steps;
  if (control.termination.kind === 'error') {
    const failure = new Error(control.termination.message);
    const resolveRunFallback = deps.resolveRunFallback
      ?? ((input: { currentStep: FallbackStep; currentCredentialRateLimited: true }) => {
        const { resolveRunFallback: resolve } = require('../oauth/codex-account-store.js') as typeof import('../oauth/codex-account-store.js');
        return resolve(process.env, input);
      });
    const currentStep: FallbackStep = backend.name === 'grok' ? 'grok' : backend.name === 'claude' ? 'claude-pty' : 'codex-rotate';
    const nextBackend = runtimeFallback.fallbackEligible ? decideRuntimeFallback(
      failure,
      currentStep,
      runtimeFallback,
      resolveRunFallback,
    ) : null;
    debug.log('agent-mission.backend', 'runtime-fallback', {
      errorKind: classifyAuthError(failure).errorKind,
      credentialRateLimited: classifyAuthError(failure).errorKind === 'rate-limited',
      selectedChainStep: nextBackend?.name ?? null,
      attemptedChainSteps: [...runtimeFallback.attemptedSteps],
      descents: runtimeFallback.descents,
      maxFallbackDescents: runtimeFallback.maxDescents,
    });
    if (nextBackend && !deps.isMissionAborted?.()) {
      decisionEvent({ step: 'recover', text: `Switching ${backend.name} to ${nextBackend.name}`, detail: { blocked: control.termination.message, action: `Retry with ${nextBackend.name}` } });
      const nextStep: FallbackStep = nextBackend.name === 'grok' ? 'grok' : nextBackend.name === 'claude' ? 'claude-pty' : 'codex-rotate';
      stopLive();
      if (h.pid) await (deps.terminateProcessTree ?? terminateMissionProcessTree)(h.pid);
      try { h.kill(); } catch { /* noop */ }
      const nextSpec = { ...spec, agent: nextBackend, reuseOwnedWorktree: true };
      const nextDeps = {
        ...deps,
        runtimeFallback: {
          ...runtimeFallback,
          attemptedSteps: new Set([...runtimeFallback.attemptedSteps, nextStep]),
          descents: runtimeFallback.descents + 1,
        },
      };
      // Keep the original signal owner and outside-write baseline across a replacement PTY.
      return spec.signal || spec.workdir ? runAgentMissionBody(nextSpec, nextDeps, startedAt, initialFiles) : runAgentMission(nextSpec, nextDeps);
    }
  }
  debug.log('agent-mission', 'control-result', { termination: control.termination.kind, steps: control.steps });
  if (control.termination.kind === 'cancelled') {
    stopLive();
    throw new Error('AGENT_YIELDED: PTY 제어가 사람에게 이양됨(takeover) — 자율 미션 중단');
  }

  if (deps.isMissionAborted?.()) return { ok: false, reason: 'aborted', worktree: wt.path, branch: wt.branch,
    rounds: round, evidencePath: null, committed: false, usedOmniCrawl: usedOmni, detail: 'aborted' };
  const finalEv = verifyEvidence(wt.path, spec.evidence);
  const finalScreen = await h.renderScreen();
  const driveVerdict = verdictForFinalPtyScreen({ screen: finalScreen, inputHistory: submittedInputs, exitCode: h.exitCode ?? null, artifactEvidence: finalEv.ok });
  debug.log('agent-mission', 'drive-ok', { verdict: driveVerdict.kind, reason: driveVerdict.reason.slice(0, 200), evidence: finalEv.ok });
  const recoverExhausted = control.termination.kind === 'stuck' && control.termination.reason.startsWith('사람 필요');
  const accepted = finalEv.ok && !recoverExhausted && driveVerdict.kind !== 'done-but-failed';
  const evidencePath = accepted ? finalEv.path : null;
  let committed = false;
  if (!deps.isMissionAborted?.() && !spec.workdir && accepted && (spec.commit ?? true)) {
    const c = (deps.commitWorktree ?? commitWorktree)(wt.path, `chore(agent-mission): ${spec.branch} — ${backend.name}-in-elanous PTY RFC 산출`);
    committed = c.ok;
    debug.log('agent-mission', 'commit', { ok: c.ok, out: c.out.slice(0, 120) });
  }
  debug.log('agent-mission', 'result', { ok: accepted, rounds: round, evidencePath, committed, usedOmni });
  decisionEvent({ step: 'done', text: accepted ? 'Mission evidence accepted' : 'Mission ended without sufficient evidence', detail: { result: { kind: evidencePath ? 'file' : 'text', ref: evidencePath ?? (control.termination.kind === 'error' ? control.termination.message : recoverExhausted ? control.termination.reason : 'evidence unavailable') } } });
  stopLive(accepted);
  if (h.pid) await terminateMissionProcessTree(h.pid);
  try { h.kill(); } catch { /* noop */ }

  return {
    ok: accepted, worktree: wt.path, branch: wt.branch, rounds: round,
    evidencePath, evidenceSatisfied: finalEv.ok, committed, usedOmniCrawl: usedOmni,
    ptyId: h.id, webUrl: webAddress.webUrl, driveVerdict: driveVerdict.kind,
    detail: recoverExhausted ? control.termination.reason : driveVerdict.kind === 'done-but-failed' ? `미완(DRIVE-OK: ${driveVerdict.reason})` : driveVerdict.kind === 'success-unverified' && finalEv.ok ? '완료(증거)' : done ? '완료(증거 충족)' : (finalEv.ok ? '증거 충족(루프 종료)' : '미완(증거 부족)'),
  };
  } finally { stopLive(); finishContext(false); if (!h.isAlive() || deps.isMissionAborted?.()) cleanupClaude(); }
}

/** @deprecated codex 특정 이름 — runAgentMission 을 쓰라(codex 는 기본 backend). */
export const runCodexMission = runAgentMission;
