import type {
  AcpConfig, AsideConfig, AutoReviewConfig, BackgroundReasoningConfig, DashboardConfig, DebugConfig, DesignConfig, DiscordConfig, ErrorReportsConfig, EventSeat, EventsConfig, FinanceConfig, GateRemoteConfig, GoalsConfig, HarnessBudgetGateConfig, HqConfig, IntakeConfig, LLMConfig, LogsConfig, LspConfig, McpConfig, NotificationsConfig, ObsidianConfig, OnboardingConfig, PersonaLoopConfig, PlanConfig, ProjectConfig, RegistryConfig, RoleLlmConfig, RoleModelConfig, RoleModelTierConfig, SeatLoopConfig, SessionFabricConfig, ShellConfig, SkillRouterConfig, SkillsConfig, StewardLoopMode, TasteConfig, TelegramConfig, ToolsConfig, VoiceConfig, VwConfig, WebSearchConfig
} from "./types.js";
import type { ChatConfig } from "./chat.js";
import type { OrchestratorLoopConfig } from "./orchestrator.js";
import type { GroundingConfig } from "../grounding/sources.js";
import type { BudgetUserConfig, ModelTierUserConfig, SmartDefaultsUserConfig } from "../model-tier/types.js";

export interface UserConfig {
  /** Next TUI options. `unattended` makes confirmation/clarification paths non-blocking. */
  tui?: { sidetab?: 'off' | 'collapsed' | 'open'; unattended?: boolean };
  projects?: Record<string, ProjectConfig>;
  /** Default personal topic watch; absent = enabled when user sources exist. */
  watch?: { enabled?: boolean };
  starter?: { topics?: string[] };
  /** GUARD-ONE-a: omitted means shadow. `live` is parsed for the later cutover, but `elanous guardian tick`
   *  refuses it until a human-confirmed operational change (GUARD-ONE-a ships shadow only). */
  guardian?: { mode?: 'shadow' | 'live'; /** Orphan CLI GC on the guardian tick: off = no ps collection, shadow (default) = evidence only, on = evidence then SIGTERM. */ orphanGc?: 'off' | 'shadow' | 'on' };
  /** Task-agent live move allow-list (`src/task-agent/live-moves.ts` validates its vocabulary).
   *  Absent = env ELANOUS_TASK_AGENT_LIVE_MOVES, else none (pure shadow). */
  taskAgent?: { liveMoves?: string[]; /** TA-REJUDGE-PERIODIC — steward tick runs `tasks rejudge --all` every N minutes (absent/0 = off). */ rejudgeEveryMinutes?: number; /** 1-minute load average above which that tick is skipped (default 60). */ rejudgeMaxLoad?: number; /** TA-REPAIR-TICK-CAP — new repair launches per `tasks rejudge --all` (default 3, 0 = none). */ repairMaxPerTick?: number; /** Old cards are skipped by periodic rejudge after this many hours (default 72). */ rejudgeMaxAgeHours?: number; /** TA-LAND-AFTER-REVIEW — opt-in external queue adapter, never a direct merge command. */ landQueue?: { command: string; remote: string }; parentHost?: { host?: string; cwd?: string; elanous?: string; configDir?: string; podPool?: string; approvalCapacity?: number } | Array<{ host?: string; cwd?: string; elanous?: string; configDir?: string; podPool?: string; approvalCapacity?: number }> };
  events?: EventsConfig;
  /** GATE-REMOTE — see GateRemoteConfig. Absent = defaults (auto on · node-b · load 20 · cap 2). */
  gateRemote?: GateRemoteConfig;
  /** Explicit HTTPS destination for doctor diagnostics; absent means no upload. */
  diagnostics?: { uploadUrl?: string };
  /** HQ lease (본부 임대 · 10-04 HQ-HB/HQ-FENCE): arbiter host over ssh, this host's name, per-role fail-open when the arbiter is unreachable (default: fail closed). */
  hq?: HqConfig;
  /** Root CLI help audience; absent or invalid means owner. */
  cli?: { helpRole?: 'owner' | 'contributor' | 'general' };
  /** Daemon public demonstration mode; absent means off. */
  nexus?: { demoMode?: boolean; relay?: { enabled?: boolean; url?: string; identityFile?: string } };
  /** Execution-phase HITL answer deadline; absent means 30 minutes. */
  hitl?: { executionDeadlineMinutes?: number };
  /** Outbound notifications. quietHours is `off` or `HH:MM-HH:MM` KST; absent keeps 00:00-06:30. */
  outbound?: { deferredMaxAttempts?: number; quietHours?: 'off' | string };
  coo?: { linearProject?: string };
  decisions?: { linearProjection: { enabled: boolean }; requireCrossCheck: boolean;
    crossCheckNeighbor: Record<EventSeat, EventSeat>; crossCheckWaitMinutes: number };
  /** Per-seat goal and Pod limits; missing or invalid limits use seat-budget defaults. */
  org?: { budget?: Record<string, { dailyGoals?: number; concurrentPods?: number }> };
  /** Steward and seat loops are parsed independently. An absent seat defaults to shadow. */
  loops?: { owners?: Record<string, EventSeat>; defaultOwner?: EventSeat; orchestrator?: OrchestratorLoopConfig; steward?: { mode?: StewardLoopMode; linearTeam?: string; roles?: Record<string, { maxConcurrent?: number }>; budget?: number; tracks?: Record<string, string>; alertAfterFailures?: number; launch?: 'off' | 'shadow' | 'live'; maxParallel?: number; podPool?: string }; seat?: SeatLoopConfig; persona?: PersonaLoopConfig };
  /** 🔐 Pod 의 Grok API 키 과금은 명시 opt-in 만. 생략·잘못된 값은 false.
   *  budgetGate 와 같은 `harness` 객체다 — 중복 선언이면 뒤 타입이 앞을 지운다. */
  harness?: { /** KNOWHOW-PACK-TO-SUPERVISORS: child goal injection is legacy opt-in; omitted = off. */ knowhowChildInjection?: boolean; edgeRail?: { canaryOkRuns?: number; failureMultiplier?: number; minSamples?: number }; /** Goal authoring grade; absent or invalid config resolves to full. */ authorGrade?: 'full' | 'lite'; revertGuard?: { depth: number }; pod?: { grokApiKeyOptIn: boolean }; budgetGate?: HarnessBudgetGateConfig; exposeGate?: 'warn' | 'strict'; difficultyPlacement?: boolean; defaultRepo?: string; /** Optional GitHub repository name (owner/repo), distinct from the local defaultRepo path. */ repo?: string; /** `auto` = SUBSTRATE-ROUTE: routeAutoSubstrate 가 pod/local 을 고른다(신호가 없으면 pod). */ substrate?: 'local' | 'pod' | 'auto'; podPool?: string; /** IMAGE-ONE-SOURCE: Pod 발사가 당길 기준 이미지 커밋(hex 12~40 · 레지스트리 태그 = 앞 12자리). 없으면 종전대로 HEAD 비교·굽기. */ imageCommit?: string; /** Number of recent image tags to retain after registry push, excluding active Pod tags. */ registryTagKeep?: number; worktreeAddTimeoutSec?: number; queue?: { seatCap?: Partial<Record<'OP' | 'TC' | 'MK' | 'UX', number>>; /** Direct `harness say|ask` goes through the seat queue first (ONEDOOR-2). Absent = env ELANOUS_HARNESS_QUEUE_DIRECT_SAY, else off. */ directSay?: boolean; /** SEAT-CAP-STALE: a run whose last ledger progress is older than this stops holding its seat. Absent = env ELANOUS_HARNESS_QUEUE_STALE_RUN_MINUTES, else 30. */ staleRunMinutes?: number; /** Seat-less runs count in one bucket with this cap instead of every seat. Absent = env ELANOUS_HARNESS_QUEUE_UNKNOWN_SEAT_CAP, else 2. */ unknownSeatCap?: number; /** QUEUE-BURST: most launches one scheduled tick may make (30 s apart, each within seat cap and Pod pool headroom). Absent or invalid = 5; 1 = one launch per tick. */ burstMax?: number }; /** `harness say` 문장을 Pod 안에서 저작부터 돌릴지. 생략·false = 끔(호스트가 저작). */ authorOnPod?: boolean; /** SIBLING-RESYNC-ON-MERGE: most open sibling PR file inventories fetched per merge. Absent or invalid = 40. */ siblingResync?: { maxFetch?: number }; /** Stopped-PR repair goals: shadow records only (default); live enqueues them. */ helper?: { repair?: 'shadow' | 'live'; /** Live launches allowed per UTC day. Absent or invalid means 3. */ repairPerDay?: number };
  /** Nested elanous launches. Only depth 0 may set `allow`. Absent or any other value refuses. A depth >= 1 `--nested-elanous allow` is ignored. */
  nestedElanous?: 'allow' | 'refuse';
  /** Maximum nested elanous depth; safe positive integer, default 2. */
  nestedElanousMaxDepth?: number;
  /** Minutes a Pod launch may wait in one stage (admission · pool slot) before a `launch-stalled` event; positive number, default 15. */
  launchStallMinutes?: number;
  /** Follow-up goal after a merged harness PR. Omitted and anything but `live` record only. */
  followUp?: 'shadow' | 'live';
};
  /** ☸️ Pod 실행 칸 — `pool` = 기존 기본 풀(`컨텍스트[@ssh호스트][:상한][#k3d-레지스트리:포트]` 쉼표 · 앞이 우선). harness 실행은 인자·ELANOUS_POD_POOL·harness.podPool 다음으로 읽는다. */
  pod?: { pool?: string; /** Host-local private warm provider config path. Env ELANOUS_WARM_POD_PROVIDER_CONFIG overrides this; absent path defaults to warm-pod-provider.json beside config.json. */ warmProviderConfig?: string; /** 호스트 Git 미러 디렉터리 — Pod Job 에 읽기 전용으로 마운트한다. */ hostMirror?: string; /** 원격 그라운딩 엔드포인트(호스트 nexus · tailnet 주소) — Pod 가 토큰으로 «질의→인용»만 묻는다(P13). */ groundingUrl?: string; /** 읽기 전용 Pod lease 권장에 쓰는 계정별 동시 수. */ lease?: { perAccount?: number }; /** 실측 권고를 Pod 발사 기본값으로 쓸지 (기본 off). */ memory?: { adviseDefaults?: boolean }; /** 명령 Job 자식 로그(child.log) 상한 바이트. 양의 정수만. 넘으면 끝부분 우선. */ childLogMaxBytes?: number; /** Warm reuse controls: shadow consumers stay off by default; validated gate shard execution is live by default with a literal-false emergency switch. */ warmReuse?: { gateRecheck?: boolean; /** Gate warm shards default live after simulation; literal false is the emergency kill switch. */ gateShardExecution?: boolean; land?: boolean; ta?: boolean; /** 연속 일치 표본 하한(양의 정수 · 기본 3). */ minMatchSamples?: number } };
  skillRouter: SkillRouterConfig;
  llm: LLMConfig;
  skills: SkillsConfig;
  obsidian: ObsidianConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  finance: FinanceConfig;
  onboarding: OnboardingConfig;
  debug: DebugConfig;
  logs: LogsConfig;
  shell: ShellConfig;
  chat: ChatConfig;
  /** ER1 — optional so older fixtures stay valid; absent = defaults. */
  errorReports?: ErrorReportsConfig;
  voice: VoiceConfig;
  intake: IntakeConfig;
  dashboard: DashboardConfig;
  vw: VwConfig;
  acp: AcpConfig;
  lsp: LspConfig;
  plan: PlanConfig;
  goals: GoalsConfig;
  registry: RegistryConfig;
  // ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 2 W2.9.
  //   User-level knob for the tier-flip / deferred-tools machinery.
  //   `tools.deferred.mode='off'` shuttles every catalog spec to the
  //   provider every turn (pre-Wave-2 behaviour) — used for A/B
  //   baseline measurement and ad-hoc diagnosis.
  tools: ToolsConfig;
  // M1-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1):
  //   Three optional sub-trees that drive the friction-free model
  //   selection UX. All three are sparse — undefined means "use the
  //   zero-config default" (Balanced tier, no budget cap, auto-suggest
  //   on). See `src/model-tier/types.ts` for the type definitions.
  modelTier?: ModelTierUserConfig;
  budget?: BudgetUserConfig;
  smartDefaults?: SmartDefaultsUserConfig;
  /** Sparse model aliases by execution role; missing or empty values fall through. */
  roleModels?: RoleModelConfig;
  /** Sparse provider-agnostic model tier preferences by execution role. */
  roleModelTiers?: RoleModelTierConfig;
  /** 역할별 provider(⊕ tier·model) — 전역 `llm.provider` 를 «역할 단위»로 덮는 유일한 config 자리. */
  roleLlm?: RoleLlmConfig;
  /** P1 멀티서피스 세션 shadow fan-out 게이트(sparse·기본 OFF). */
  sessionFabric?: SessionFabricConfig;
  /** Layer2 Taste substrate 수집 게이트(P4·기본 OFF·opt-in). */
  taste?: TasteConfig;
  /** 웹 검색 프로바이더 게이트(기본 OFF — `isTavilySearchEnabled()` 로만 읽는다). */
  webSearch?: WebSearchConfig;
  /** OpenDesign 시안 생성. 기본 없음 = 꺼짐. url 이 없으면 클라이언트가 호출하지 않는다. */
  design?: DesignConfig;
  /** G8 무인 리뷰루프 auto-review 라벨 자동부착 모드(sparse·기본 opt-in). §2b ROADMAP-elanous-is-all. */
  autoReview?: AutoReviewConfig;
  /** 표시·집계 시간대 (IANA 이름 · 예 `Asia/Seoul`). 2026-07-24 신설.
   *
   *  종전엔 시간대를 **선언할 자리 자체가 없어서** 각 파일이 `'Asia/Seoul'` 을 문자열로
   *  박거나(9곳) UTC 를 그대로 표시했다(~40곳). 그 결과 같은 제품의 두 서피스가 9시간
   *  어긋났고, LLM 컨텍스트 팩에 UTC 가 사실로 주입됐다.
   *
   *  생략(권장)하면 `src/time/format.ts` 의 `resolveTimeZone()` 이 `process.env.TZ` →
   *  OS 설정(`Intl`) → `UTC` 순으로 해석한다. launchd 데몬은 TZ 를 물려받지 못하므로
   *  OS 설정이 실질 기본이 된다. 명시는 여러 머신에서 표기를 고정하고 싶을 때만.
   *
   *  ⚠️ 저장·전송은 언제나 UTC ISO 다. 이 값은 **표시와 날짜키에만** 영향한다. */
  timezone?: string;
  // W7-후속 (2026-05-12 · iOS Phase 0.5 production wire):
  //   Outbound notification channel settings. Sparse — when `apns`
  //   isn't present or any required field is missing, the daemon
  //   wires the ios-push channel with transport=undefined (resolves
  //   to 'transport-not-configured' if a route attempts to send).
  //   See `src/notifications/outbound-boot.ts` for the boot wire.
  notifications?: NotificationsConfig;
  // B 트랙 Phase 2 (RFC-elanous-mcp-client-2026-05-12 · 2026-05-12):
  //   External MCP servers (xcrun mcpbridge · xcodebuildmcp · …)
  //   that the NEXUS boot wire spawns + registers as proxy
  //   ToolRuntimes. Sparse — undefined or empty servers[] = no-op.
  //   See `src/nexus/boot/register-mcp-clients.ts` for the boot wire.
  mcp?: McpConfig;
  aside?: AsideConfig;
  // W9e-FU U5 (2026-05-12) — `background-reasoning.llm.*` drives the
  // Patcher daemon's LLM callable wire. When omitted, `buildPatcherSubstrate`
  // surfaces `patcher-llm-deps-missing` and stays dormant. The resolver
  // (`src/background-reasoning/patcher-llm-resolver.ts`) consumes the
  // resolved config and produces `entityExtractorCallable` +
  // `embeddingCallable` via fetch against the OpenAI-compatible endpoint.
  backgroundReasoning?: BackgroundReasoningConfig;
  /** §5-③ — autonomous idle-continuation. When `enabled` (default
   *  false) the NEXUS daemon starts a ContinuationScheduler that drives
   *  an active auto-mode goal on idle. Off by default: this ignites
   *  self-firing turns, so it stays opt-in. */
  dispatch?: { enabled?: boolean };
  /** next-fluent(태스크 완료 시 다음 액션 1-클릭 칩·2026-07-15). 라우트는 늘 켬.
   *  `personas` 켜면 로컬 LLM 이유 부여(기본 결정론·무비용). */
  nextFluent?: { personas?: boolean; models?: Record<string, string> };
  /** Ops Observability P3 — 셀프교정 자율 경계. health check 크론이 이상 감지 시
   *  자동 개입(재큐/재시작)까지 할지. 기본 disarmed(관측+알림만·HITL). 매매/재부팅은
   *  이 게이트가 armed 여도 항상 제외. 대표 결정 전까지 undefined=false. */
  ops?: { selfHeal?: { armed?: boolean }; cronRepoRoot?: string };
  /** 승인 뒤 조율 채널 페이즈 배달(기본 OFF) 및 트랙 에이전트(기본 OFF, 최대 동시 2개). */
  autopilot?: {
    trackCourier?: { enabled?: boolean; channelPr?: number; handoffMinutes?: number };
    trackAgent?: { enabled: boolean; maxConcurrent: number; shadow: boolean; shadowMaxDecisionsPerDay: number };
  };
  /** 하니스 예산 게이트 설정. 판정은 P15 — 여기선 칸만 싣는다. 파서는 항상 기본을 채운다.
   *  선택이다 — 기존 UserConfig 리터럴이 이 칸 없이 컴파일되게 한다. 해석기는 없으면 기본을 쓴다.
   *  타입 칸은 위 `harness.budgetGate` 한 곳이다(중복 선언 금지). */
  /** 그라운딩 출처 레지스트리. 잘못된 항목은 경고와 함께 건너뛴다. 없으면 빈 목록. */
  grounding?: GroundingConfig;
  raw: Record<string, unknown>;
  // Phase 2 (PLAN-config-unification-elanous-root-2026-05-10):
  //   NEXUS schema co-resident at root of `~/.elanous/config.json`.
  //   Read by `src/nexus/config/user-config.ts:readUserConfig` for daemon
  //   state · exposed here so `elanous config get/set global.nexus.*` and
  //   `tabs.<id>.*` resolve through the same dotted-path resolver as
  //   Path A keys (llm.provider · skillRouter.* · etc.). Type 'version'
  //   matches the on-disk key — there is no Path A collision.
  version?: number;
  global?: Record<string, unknown>;
  tabs?: Record<string, Record<string, unknown>>;
}
