/** CV-3 Showroom MVP — type definitions
 *  ([RFC v4](../../../../../내부 문서 `PLAN-cv-3-showroom-mvp-2026-05-07`)).
 *
 *  D2: Panel kind = `chat` (P1) · `agent` (P5 codex/claude/gemini CLI)
 *  D10: panel 별 자기 daemon sessionId (Showroom = client-side state)
 *  D11: state = `live` (broadcast 받음) · `mute` (skip dispatch) ·
 *       `freeze` (현재 결과 frozen · 새 turn 무시)
 *  D16: panel close 의 archive 는 P6 named save 에서 처리 — P1 은
 *       memory 만 (탭 닫으면 사라짐 · ephemeral)
 */

/** P5 — chat (direct LLM API) · agent (CLI brand · D1 P5 RFC). */
export type ShowroomPanelKind = 'chat' | 'agent';

/** P5 — agent CLI brand. provider 와 lock (D2 P5 RFC). real CLI
 *  sub-process spawn 은 P5.x follow-up — 본 P5 PR 은 UX foundation. */
export type ShowroomAgentBrand = 'codex' | 'claude' | 'gemini';

/** D11 — broadcast 참여 상태. */
export type ShowroomPanelState = 'live' | 'mute' | 'freeze';

/** §6.1 — role hint for auto-target via prompt classifier. mirrors
 *  AgentRoomRoleHint (`src/agent-room/types.ts`) so canonical TUI ↔
 *  PWA semantic stays single. user-assigned per panel · no default. */
export type ShowroomRoleHint = 'plan' | 'exec' | 'review' | 'reflect';

export interface ShowroomPanel {
  /** client-side 식별자 — `@name` mention 의 base 가 됨 (D12) */
  id: string;
  kind: ShowroomPanelKind;
  /** chat panel: provider 식별자. Showroom 의 default + named provider pool
   *  (`claude` `gemini` `grok` `codex` 또는 빈 문자열 = daemon default).
   *  agent panel: brand 와 lock (P5 D2) — agentBrandToProvider 로 채움. */
  provider: string;
  /** P5 — agent kind 의 brand (codex/claude/gemini CLI). chat kind 면
   *  undefined. immutable after panel create (D6 P5 RFC). */
  agentBrand?: ShowroomAgentBrand;
  /** §6.1 — user-assigned role hint. classifyPromptRole 가 matching
   *  하면 mention 0 시 auto-target. broadcast 의도면 undefined 두기. */
  roleHint?: ShowroomRoleHint;
  /** §6.4 — persona binding (PersonaProfile.personaId reference).
   *  daemon's multi-llm-bridge looks up via global PersonaRegistry +
   *  prepends `assemblePersonaPrompt(persona, base)` at runCoreTurn
   *  systemPrompt. Q3=Hybrid: when the bound persona's `brand` is
   *  explicit, the PWA enforces panel.provider = persona.brand and
   *  locks the picker (UI side · client-driven). undefined = no
   *  persona attached (default chat panel behavior). */
  personaId?: string;
  /** daemon-issued sessionId (panel handshake 후 발급).
   *  null = 아직 연결 전 (acp connect 에서 onSession 콜백으로 채워짐). */
  sessionId: string | null;
  state: ShowroomPanelState;
}

export type ShowroomLayoutMode = 'horizontal' | 'vertical';

export interface ShowroomState {
  /** logical id — URL share / localStorage / P6 named save 의 키. */
  id: string;
  panels: ShowroomPanel[];
  /** D7 — desktop 은 horizontal · iPad mini/mobile 은 vertical (responsive
   *  로 자동 결정). 본 필드는 사용자가 explicit override 할 때만 사용 (P2+). */
  layoutMode?: ShowroomLayoutMode;
  /** P6 named save 의 placeholder. P1 = always undefined. */
  name?: string;
}

/** P6 — named showroom save (persistent layout).
 *
 *  D6 Hybrid · default ephemeral — 사용자가 명시 save 시 named slot
 *  으로 localStorage 에 저장. 다음 세션에서 같은 layout 재현 가능.
 *
 *  P6 minimum 은 client-side only (localStorage). cross-device 동기화
 *  (daemon-side store) 는 P6.2 (사용자 vision 후).
 *
 *  보존되는 부분: panels (membership · provider · state) + layoutMode.
 *  보존 안 되는 부분: panels.sessionId (load 시 fresh handshake) ·
 *  attachments (ephemeral) · terminalContexts (ephemeral) ·
 *  priorAnswers (ephemeral · turn-scoped).
 */
export interface SavedShowroomLayout {
  /** localStorage key 의 slot 식별자 — 사용자 입력 name. */
  name: string;
  /** save 시점 (epoch ms · sort key). */
  savedAt: number;
  /** panels 의 essential subset (sessionId 제외 — load 시 새 handshake). */
  panels: Array<{
    id: string;
    kind: ShowroomPanelKind;
    provider: string;
    /** P5 — agent kind 의 brand (codex/claude/gemini CLI). chat kind 면
     *  undefined. legacy localStorage entry (P5 이전) load 시 default = chat. */
    agentBrand?: ShowroomAgentBrand;
    /** §6.1 — role hint preserved across save/load (DAG 의 일부). */
    roleHint?: ShowroomRoleHint;
    /** §6.4 — persona binding preserved across save/load. */
    personaId?: string;
    state: ShowroomPanelState;
  }>;
  layoutMode?: ShowroomLayoutMode;
}

/** DM-3 — prior-answer cross-reference (RFC v4 §6.2 · 진짜 가치 axis).
 *
 *  한 panel 의 assistant 답변을 다음 turn 의 input context 로 promote.
 *  사용자가 message 에서 "promote" 클릭 → ShowroomState 의 priorAnswers
 *  에 chip 형태로 추가 → 다음 broadcast 시 prompt prefix 에
 *  `<prior_answer>` block 으로 prepend.
 *
 *  P5+ (mixed history mode · daemon-side cross-model context) 는 본
 *  client-side promotion 의 진화 path — 사용자가 명시 chip 으로
 *  promote 안 해도 daemon 이 panel 간 history 자동 mix.
 */
export interface PriorAnswer {
  /** client-side id — chip identifier. */
  id: string;
  /** "@codex 답변 (17:30)" 같은 사용자 인지 가능한 label. */
  label: string;
  /** 답변 text — assistant message 의 markdown 본문. */
  text: string;
  /** 어느 panel 에서 promote? — id (panel.id). */
  sourcePanelId: string;
  /** 어느 provider 의 답변 — chip color hint 으로 사용 가능. */
  sourceProvider: string;
  /** promote 시점 (epoch ms). */
  promotedAt: number;
  /** §3.4 (BACKLOG-showroom-cv-3-post-dm-stage-4-2026-05-09):
   *  promote 가 어느 broadcast turn 동안 일어났는지. ShowroomLayout 의
   *  turnIndex (1-based · 첫 broadcast = 1) 를 그대로 받음. chip render
   *  시 `T{n}` 로 prominent 표시 — "어느 turn 답변인지 안 보임" UX gap
   *  해결. */
  turnNumber: number;
  /** §3.4 multi-select toggle. true (default) = next broadcast 의
   *  prefix 에 포함. false = chip 은 표시되지만 prefix 에서 skip ·
   *  사용자가 selectively 활성화 가능. */
  enabled: boolean;
}

/** §6.7 — agent-to-agent direct routing (RFC v4 §6.7).
 *
 *  Panel A 의 stream finalize 시점에 자동으로 Panel B 에 forward.
 *  §6.2 prior-answer 의 자동화 버전 — 사용자가 promote 버튼 누르지
 *  않아도 edge 가 정의돼 있으면 자동 cross-reference deliberation.
 *
 *  edge 는 directed (from → to). cycle 금지 · self-route 금지 ·
 *  duplicate 금지 (addChainEdge 가 검사). enabled toggle 로 일시
 *  정지 가능.
 *
 *  TUI auto-relay (`src/showroom/auto-relay/`) 의 PWA 적응 — byte-idle
 *  detection 대신 `dmPanelStates[panelId].streaming` transition
 *  `true → false` 직접 감지로 trigger.
 */
export interface ChainEdge {
  /** client-side id. */
  id: string;
  /** source panel.id — finalize 시점에 forward trigger. */
  fromPanelId: string;
  /** target panel.id — forward 받음 (target 의 dmPanelStates 에
   *  user message + streaming start). */
  toPanelId: string;
  /** wrap mode: 'plain' = source text 그대로 user input · 'prior' =
   *  `<prior_answer>` block + routePrompt (default 한국어). */
  wrapMode: 'plain' | 'prior';
  /** wrap='prior' 시 block 다음에 붙는 prompt. trim 후 빈 문자열이면
   *  default 'DEFAULT_ROUTE_PROMPT' 사용. */
  routePrompt?: string;
  /** edge 활성 toggle · false 면 forward trigger 무시. default true. */
  enabled: boolean;
  /** D3 (BACKLOG candidate · 2026-05-11) — HITL gate. true 면 forward
   *  trigger 시 즉시 fire 하지 않고 사용자 confirm modal 거친 후 fire.
   *  cancel 시 source 의 finalize 는 보존하되 target 으로의 dispatch
   *  는 skip. default false (legacy auto-forward 유지). */
  hitl?: boolean;
  /** create timestamp (epoch ms). */
  createdAt: number;
}

/** §6.3 — URL context source. user 입력 URL → daemon fetch + HTML
 *  strip → text body → `<url_context>` block prefix on next dispatch.
 *  daemon endpoint: `POST /v1/context/fetch-url` (text returned 그대로
 *  block 에 들어감 · 길이 cap 은 daemon 측 결정). multiple pin OK.
 *
 *  ephemeral · 다음 dispatch 후 자동 clear (terminal/clipboard/prior 와
 *  같은 lifecycle). */
export interface UrlContext {
  /** client-side id — UI key + chip identifier. */
  id: string;
  /** 사용자 라벨 (default = page title 또는 URL host). */
  label: string;
  /** 입력 URL · 그대로 block attribute 에 surface. */
  url: string;
  /** 페이지 본문 text (HTML strip 후). */
  text: string;
  /** fetch 시점 (epoch ms). */
  fetchedAt: number;
}

/** R6 Task 4 · §6.3 — Video context source. file picker → keyframe
 *  extracted via canvas API → metadata block prepended to dispatch
 *  prompt. The keyframe itself is pushed onto `attachments[]` so any
 *  vision-capable model receives the visual; the `<video_context>`
 *  block carries duration/dimensions/mime as text for non-vision
 *  models so the room is still informed about what was attached.
 *
 *  ephemeral · 다음 dispatch 후 자동 clear. */
export interface ShowroomVideoContext {
  /** client-side id — UI key + chip identifier. */
  id: string;
  /** 사용자 라벨 (default = "video · MM:SS · WxH · YYYY-MM-DD"). */
  label: string;
  /** 원본 파일명 (input.files[i].name) — block attribute 로 surface. */
  filename: string;
  /** mime/type from the FileList entry. */
  mimeType: string;
  /** decoded duration in seconds (rounded). */
  durationSec: number;
  /** keyframe pixel dimensions. */
  widthPx: number;
  heightPx: number;
  /** keyframe data URL (image/png base64) — used inline in the block
   *  AND copied into `attachments[]` so vision-capable models receive
   *  it via the standard upload pipeline. */
  frameDataUrl: string;
  /** capture timestamp (epoch ms). */
  capturedAt: number;
}

/** R6 Task 4 · §6.3 — Audio context source. file picker → metadata
 *  + optional STT transcript → `<audio_context>` block. The minimum-
 *  viable land surfaces metadata (duration / mime / size) and an
 *  optional user-typed transcript; full STT (browser Web Speech API
 *  doesn't accept file inputs cleanly) defers to a daemon-side Whisper
 *  bridge in a follow-up.
 *
 *  ephemeral · 다음 dispatch 후 자동 clear. */
export interface ShowroomAudioContext {
  /** client-side id. */
  id: string;
  /** 사용자 라벨 (default = "audio · MM:SS · YYYY-MM-DD"). */
  label: string;
  /** 원본 파일명. */
  filename: string;
  /** mime/type from the FileList entry. */
  mimeType: string;
  /** decoded duration in seconds (rounded). */
  durationSec: number;
  /** size in bytes for chip preview. */
  sizeBytes: number;
  /** Optional manual transcript. Empty string when the user hasn't
   *  pasted/typed one yet — block still surfaces metadata. */
  transcript: string;
  /** load timestamp (epoch ms). */
  loadedAt: number;
}

/** §6.3 — Clipboard context source. browser navigator.clipboard 로
 *  read → `<clipboard_context>` block. text/plain only (image
 *  clipboard 은 future · attachment pipeline 활용 가능).
 *
 *  ephemeral · 다음 dispatch 후 자동 clear. */
export interface ClipboardContext {
  /** client-side id. */
  id: string;
  /** 사용자 라벨 (default = "clipboard · N chars · HH:MM"). */
  label: string;
  /** clipboard text. */
  text: string;
  /** read 시점 (epoch ms). */
  pastedAt: number;
}

/** DM stage 3 FU (HANDOFF §3.2 · 2026-05-09) — agent CLI tool_call
 *  lifecycle as observed per panel. The Showroom client keeps a map
 *  of these per panel.modelId, updated by the multi-llm-bridge
 *  forwarding `tool_call` / `tool_call_update` SessionUpdate variants
 *  through `pushSessionUpdate(_, _meta.elanous.modelId)`.
 *
 *  Used by ShowroomPanel to render an activity pill ("3 tools · 2 running")
 *  in the header + an expandable list per tool. Reset on each new turn
 *  (when the parent emits a stop reason or fresh user message).
 */
export interface ToolCallState {
  /** ACP `toolCallId` — stable across `tool_call` (initial pending) and
   *  subsequent `tool_call_update` events. */
  id: string;
  /** Tool name from the agent CLI (e.g. `read_file`, `bash`, `grep`).
   *  Mirrors `update.title` per ACP server.ts:929 emit shape. */
  name: string;
  /** Lifecycle stage as the agent CLI reported it. `pending` is the
   *  default a fresh `tool_call` ships with; `in_progress` indicates
   *  active streaming; terminal states are `completed` / `failed`. */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Raw input args (the LLM's tool invocation arguments). Optional
   *  because some agent CLIs don't surface inputs (privacy filter). */
  input?: Readonly<Record<string, unknown>>;
  /** Raw output (when terminal). Stringified for compact preview. */
  output?: string;
  /** First-seen timestamp (epoch ms). Sort key in the activity list. */
  startedAt: number;
  /** Last-update timestamp (epoch ms). Snapshot for "stale" hints. */
  updatedAt: number;
}

/** P4 — terminal context source (snapshot pin · D14).
 *
 *  P4.1 (현재 land) = client-side paste minimum — 사용자가 terminal
 *  output 을 paste 해서 pin. daemon-side scrollback API 는 P4.2
 *  (사용자 결정 후 별 PR — architecture 영향). RFC §4.4 의 frozen
 *  snapshot · last N lines 의도는 client paste 도 일종 frozen.
 *
 *  broadcast 시 prompt 에 `<terminal_context label="...">...</terminal_context>`
 *  block 으로 prepend. multiple context pin 시 순서대로 prepend.
 */
export interface TerminalContext {
  /** client-side id — UI key + chip identifier. */
  id: string;
  /** 사용자가 정한 label (default = "terminal · Last N lines · timestamp"). */
  label: string;
  /** terminal output (raw text · 사용자 paste OR P4.2 의 daemon API 결과). */
  text: string;
  /** pin 시점 timestamp (epoch ms). */
  pinnedAt: number;
}
