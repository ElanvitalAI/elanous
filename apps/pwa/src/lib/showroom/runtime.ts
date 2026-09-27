/** CV-3 Showroom MVP — pure runtime helpers (logic isolated · testable).
 *  ([RFC v4](../../../../../내부 문서 `PLAN-cv-3-showroom-mvp-2026-05-07`)).
 *
 *  D10: broadcast = client-side N call dispatcher (각 panel 의 자기
 *       sessionId 으로 동시 `runChatTurnAcp` Promise.all). 진짜
 *       multi-LLM broadcast (M-A) 직접 구현. daemon 측 multi-LLM
 *       dispatch 미지원으로 인한 client-side 패턴.
 *  D11: live panel 만 dispatch · mute/freeze 는 skip.
 */

import type { PromptUserContentBlock } from '../daemon-client';
import type {
  ChainEdge,
  ClipboardContext,
  ShowroomAudioContext,
  ShowroomVideoContext,
  PriorAnswer,
  ShowroomAgentBrand,
  ShowroomPanel,
  ShowroomRoleHint,
  TerminalContext,
  ToolCallState,
  UrlContext,
} from './types';

/** P3 — dispatch options. `userContent` 는 PWA chat 의 multi-part user
 *  message 패턴 (image/file attachment ContentBlock[]). agent 측에서는
 *  이 block 이 LLM input 의 multimodal slot 으로 들어감. PromptUserContentBlock
 *  은 daemon-client 의 type 그대로 forward. */
export interface PanelDispatchOptions {
  userContent?: PromptUserContentBlock[];
}

/** Panel 의 broadcast handler — 부모 ShowroomLayout 이 input 받아
 *  invoke. dispatch 의 결과는 panel 자체 state (messages array) 로
 *  반영되며 promise 는 turn 종료까지 resolve 하지 않음. */
export type PanelDispatcher = (
  userText: string,
  opts?: PanelDispatchOptions,
) => Promise<void>;

/** Broadcast 의 핵심 — live panel 의 dispatcher 만 동시 invoke.
 *
 *  - mute / freeze panel 은 skip (D11)
 *  - dispatcher 가 등록 안 된 panel (handshake 진행중 등) 은 skip
 *  - Promise.allSettled 로 한 panel 의 실패가 다른 panel 을 막지 않음
 *
 *  return 은 settled result array — caller 가 logging 또는 toast 용도. */
export async function broadcastToPanels(
  panels: readonly ShowroomPanel[],
  dispatchers: ReadonlyMap<string, PanelDispatcher>,
  userText: string,
  opts?: PanelDispatchOptions,
): Promise<readonly PromiseSettledResult<void>[]> {
  const targets = panels
    .filter((p) => p.state === 'live')
    .map((p) => dispatchers.get(p.id))
    .filter((d): d is PanelDispatcher => typeof d === 'function');
  if (targets.length === 0) return [];
  return Promise.allSettled(targets.map((d) => d(userText, opts)));
}

/** Targeted dispatch — `@name` mention 으로 1 panel 만 invoke (P2).
 *  P1 에서는 내부 helper 로만 노출 (UI mention picker 는 P2). */
export async function dispatchToPanel(
  panelId: string,
  dispatchers: ReadonlyMap<string, PanelDispatcher>,
  userText: string,
  opts?: PanelDispatchOptions,
): Promise<PromiseSettledResult<void> | null> {
  const dispatcher = dispatchers.get(panelId);
  if (!dispatcher) return null;
  const settled = await Promise.allSettled([dispatcher(userText, opts)]);
  return settled[0] ?? null;
}

/** D12 helper — provider + numeric 자동 generation. 같은 provider 가
 *  N>1 일 때만 numeric suffix.
 *
 *  P5 D3 — agent kind 의 displayName = `${brand}-cli` (chat 의 brand
 *  과 disambiguation). collision counting 은 kind+brand 조합으로
 *  계산되어 chat 'codex' 와 agent 'codex-cli' 가 namespace 분리. */
export function panelDisplayName(panel: ShowroomPanel, allPanels: readonly ShowroomPanel[]): string {
  const base = panelDisplayBase(panel);
  const sameKey = allPanels.filter((p) => panelDisplayBase(p) === base);
  if (sameKey.length <= 1) return base;
  const idx = sameKey.findIndex((p) => p.id === panel.id);
  return `${base}-${idx + 1}`;
}

/** P5 — display name base (kind + brand/provider). agent kind 는
 *  `${brand}-cli` · chat 은 `provider || 'default'`. */
function panelDisplayBase(panel: ShowroomPanel): string {
  if (panel.kind === 'agent' && panel.agentBrand) {
    return `${panel.agentBrand}-cli`;
  }
  return panel.provider || 'default';
}

let _idCounter = 0;
function nextCounter(): string {
  _idCounter = (_idCounter + 1) % 4096;
  return _idCounter.toString(36).padStart(2, '0');
}

export function newPanelId(): string {
  return `p-${Date.now().toString(36)}-${nextCounter()}`;
}

export function newShowroomId(): string {
  return `sr-${Date.now().toString(36)}-${nextCounter()}`;
}

/** Showroom offline fallback provider pool.
 *
 *  RFC #2161 Phase 3 (2026-05-11) — the authoritative provider list
 *  now comes from `useResolvedView()` (registry catalog). This array
 *  stays as the offline / pre-fetch fallback so the dropdown is never
 *  empty during initial paint or when the daemon is unreachable.
 *  Phase 8 cleanup will retire this constant once every consumer
 *  threads through the hook (or the daemon ships its own bootstrap
 *  payload). */
export const SHOWROOM_PROVIDERS: readonly string[] = ['', 'claude', 'gemini', 'grok', 'codex'];

/** P5 — agent CLI brand 풀 (D1 P5 RFC). */
export const SHOWROOM_AGENT_BRANDS: readonly ShowroomAgentBrand[] = [
  'codex',
  'claude',
  'gemini',
];

/** P5 — agent brand → provider mapping (D2 P5 RFC · provider lock).
 *  현재 P5 PR 에서는 brand === provider (동일 LLM API path 사용 ·
 *  P5.x 에서 sub-process spawn 으로 evolve). */
export function agentBrandToProvider(brand: ShowroomAgentBrand): string {
  return brand;
}

/** P5.x — agent brand → daemon ACP backend id (real CLI sub-process
 *  spawn · #1959). Mirrors `nexus/chat/backend-mapping.ts` canonical
 *  mapping (NEXUS chat label → AcpBackendId). codex CLI uses the
 *  app-server transport · claude/gemini use plain ACP stdio. */
export function agentBrandToBackend(
  brand: ShowroomAgentBrand,
): 'codex-app-server' | 'claude' | 'gemini' {
  switch (brand) {
    case 'codex':
      return 'codex-app-server';
    case 'claude':
      return 'claude';
    case 'gemini':
      return 'gemini';
  }
}

/** P1 default — 2 panel · 둘다 daemon default provider · live. 사용자가
 *  add panel + provider 변경하여 multi-LLM 비교 시작. */
export function createDefaultPanels(): ShowroomPanel[] {
  return [
    { id: newPanelId(), kind: 'chat', provider: '', sessionId: null, state: 'live' },
    { id: newPanelId(), kind: 'chat', provider: '', sessionId: null, state: 'live' },
  ];
}

/** P5 — agent panel factory. brand 가 provider lock + kind 가 agent.
 *  immutable kind/brand (D6 P5 RFC) — 한번 만들어진 agent panel 의
 *  brand 변경 불가 (close + new 만 가능). */
export function newAgentPanel(brand: ShowroomAgentBrand): ShowroomPanel {
  return {
    id: newPanelId(),
    kind: 'agent',
    provider: agentBrandToProvider(brand),
    agentBrand: brand,
    sessionId: null,
    state: 'live',
  };
}

/** P5 — chat panel factory (Add Chat UI 용). createDefaultPanels 가
 *  inline 으로 만들던 것을 헬퍼로 추출 — P5 의 Add Chat 분리 후 재사용. */
export function newChatPanel(provider: string = ''): ShowroomPanel {
  return {
    id: newPanelId(),
    kind: 'chat',
    provider,
    sessionId: null,
    state: 'live',
  };
}

/** P2 — mention parser. input text 에서 `@displayName` 토큰 추출 +
 *  매칭되는 panel 목록 + remainder text. broadcast vs targeted 결정에
 *  사용.
 *
 *  - mention 매치 안 되면 broadcast (모든 live panel · D11)
 *  - 1 개 이상 매치 → targeted (해당 panel 들만 · live 상태 무관)
 *  - `@all` 은 explicit broadcast (mute/freeze 무시 · live 만)
 *  - 동일 displayName 의 mention 중복 시 unique panel 만
 *
 *  mention regex: `@` 뒤에 영숫자/dash · word boundary 까지. `@codex-2`
 *  `@chat-1` 같이 D12 의 numeric suffix 도 매치.
 */
const MENTION_RE = /@([a-zA-Z][a-zA-Z0-9-]{0,31})/g;

export interface MentionParseResult {
  /** `@name` 매치된 panel 목록 (unique · 등장 순서 보존). */
  targets: ShowroomPanel[];
  /** `@all` 명시 여부 (broadcast 등가). */
  broadcastAll: boolean;
  /** 입력 text 에서 매치된 mention 토큰 그대로 (display 용). */
  mentions: readonly string[];
  /** mention 매치 실패 (panel 에 없는 이름). 잘못된 mention 은
   *  silent 하게 무시하지만, UI 가 hint 로 surface 가능. */
  unknown: readonly string[];
}

export function parseMentions(
  text: string,
  panels: readonly ShowroomPanel[],
): MentionParseResult {
  const targets: ShowroomPanel[] = [];
  const seen = new Set<string>();
  const mentions: string[] = [];
  const unknown: string[] = [];
  let broadcastAll = false;
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[1];
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower === 'all') {
      broadcastAll = true;
      mentions.push('@all');
      continue;
    }
    // panel match — case-insensitive · displayName 또는 raw provider
    const matchedPanel = panels.find((p) => {
      const dn = panelDisplayName(p, panels).toLowerCase();
      return dn === lower;
    });
    if (matchedPanel) {
      if (!seen.has(matchedPanel.id)) {
        seen.add(matchedPanel.id);
        targets.push(matchedPanel);
      }
      mentions.push(`@${token}`);
    } else {
      unknown.push(token);
    }
  }
  return { targets, broadcastAll, mentions, unknown };
}

/** P2 — dispatch decision. mention 있으면 targeted (active state 무관) ·
 *  없으면 broadcast (live panel only · D11). `@all` 은 explicit
 *  broadcast 도 같은 path.
 *
 *  §6.1 (auto-route field) — mode 'targeted' 가 mention 0 + role
 *  classifier hit 으로 auto 설정된 경우 surface. UI 가 indicator 로
 *  사용자에게 보여줄 수 있게 routedBy 명시. */
export interface DispatchPlan {
  /** dispatch 받을 panel 목록 (필터 적용 후). */
  targets: ShowroomPanel[];
  /** broadcast (모든 live panel) vs targeted (mention 매치만). */
  mode: 'broadcast' | 'targeted';
  /** §6.1 — targeted 의 결정 근거. 'mention' = 사용자 @ · 'role-classify'
   *  = mention 0 + classifyPromptRole hit + matching panel · undefined
   *  = broadcast. mention 이 항상 우선 (사용자 명시 override). */
  routedBy?: 'mention' | 'role-classify';
  /** §6.1 — role-classify 시 적중한 role. surface 용 (UI hint). */
  classifiedRole?: ShowroomRoleHint;
}

export interface PlanDispatchOpts {
  /** R6 Task 5 · §6.1 LLM-judge — caller (typically the async
   *  augment in `planDispatchWithLlmJudge`) supplies a role hint to
   *  bypass the synchronous `classifyPromptRole` keyword pass. The
   *  hint is honoured only when no `@mention` is present. */
  roleHint?: ShowroomRoleHint;
}

export function planDispatch(
  text: string,
  panels: readonly ShowroomPanel[],
  opts: PlanDispatchOpts = {},
): DispatchPlan {
  const { targets: mentioned, broadcastAll } = parseMentions(text, panels);
  if (broadcastAll) {
    // explicit @all → broadcast (mention list 무관).
    return {
      targets: panels.filter((p) => p.state === 'live'),
      mode: 'broadcast',
    };
  }
  if (mentioned.length > 0) {
    return { targets: mentioned, mode: 'targeted', routedBy: 'mention' };
  }
  // §6.1 — mention 없으면 role classifier 시도. matching panel 1 개 일
  // 때만 auto-target (다수 매치 시 broadcast 가 자연스러움 · race
  // 회피). live · mute 무관 (targeted 는 state 무관 dispatch).
  const role = opts.roleHint ?? classifyPromptRole(text);
  if (role) {
    const matched = panels.filter((p) => p.roleHint === role);
    if (matched.length === 1) {
      return {
        targets: matched,
        mode: 'targeted',
        routedBy: 'role-classify',
        classifiedRole: role,
      };
    }
  }
  return {
    targets: panels.filter((p) => p.state === 'live'),
    mode: 'broadcast',
  };
}

/** §6.1 — role 별 keyword 사전 (Korean + English).
 *
 *  matching 방식:
 *  - 한국어 keyword (CJK 포함) → substring (word boundary 불필요).
 *  - 영문 keyword → word boundary regex (case-insensitive). "spec" 이
 *    "retrospective" 안에서 부분 매치하지 않게 방지.
 *
 *  ROLE_PRIORITY 는 ambiguity resolve 의 tie-breaker. review · reflect
 *  · plan 같은 "meta-task" verb 는 broad 한 exec keyword (code/write/
 *  build) 보다 우선 — "Review the code" 는 review 의도가 명확. plan 은
 *  exec 보다 우선 — "구현 계획 짜줘" 는 계획 의도. */
const ROLE_PRIORITY: readonly ShowroomRoleHint[] = [
  'review', 'reflect', 'plan', 'exec',
];

const ROLE_KEYWORDS: Record<ShowroomRoleHint, readonly string[]> = {
  plan: [
    '계획', '기획', '설계', '구상', '아키텍처', '디자인',
    'plan', 'design', 'architect', 'spec', 'roadmap',
  ],
  exec: [
    '구현', '코드', '작성', '만들어', '수정', '구축', '코딩',
    'implement', 'code', 'write', 'build', 'create', 'fix',
  ],
  review: [
    '리뷰', '검토', '평가', '점검', '검사', '비판',
    'review', 'critique', 'evaluate', 'check', 'audit',
  ],
  reflect: [
    '회고', '반성', '돌아보', '성찰', '교훈', '되짚',
    'reflect', 'retrospective', 'lesson', 'postmortem',
  ],
};

/** §6.1 — Korean (CJK) detector. */
const CJK_RE = /[ㄱ-ㆎ가-힣]/;

/** §6.1 — keyword regex cache (English only · word boundary case-i). */
const KEYWORD_RE_CACHE = new Map<string, RegExp>();

function keywordMatches(text: string, lower: string, keyword: string): boolean {
  if (CJK_RE.test(keyword)) {
    // Korean: substring on raw text (Korean has no case folding).
    return text.includes(keyword);
  }
  let re = KEYWORD_RE_CACHE.get(keyword);
  if (!re) {
    re = new RegExp(`\\b${keyword.toLowerCase()}\\b`);
    KEYWORD_RE_CACHE.set(keyword, re);
  }
  return re.test(lower);
}

/** §6.1 — classify prompt → role hint. keyword sufficient signal · LLM
 *  필요 없는 가벼운 heuristic. 우선순위 ROLE_PRIORITY 로 ambiguity
 *  resolve. 매치 없으면 null (호출자가 broadcast fallback).
 *
 *  - 한국어 keyword: substring · case 없음 (Korean has no fold).
 *  - 영문 keyword: word boundary case-insensitive — "spec" 이
 *    "retrospective" 부분 매치 안 됨 · "Implementing" 은 \bimplement\b
 *    로는 매치 안 됨 (root form 만 노린 의도).
 *
 *  주의: 매우 단순 heuristic — 정확도 향상은 P2+ 에서 LLM judge 또는
 *  fine-tuned classifier 로 evolve 가능. */
export function classifyPromptRole(text: string): ShowroomRoleHint | null {
  const lower = text.toLowerCase();
  for (const role of ROLE_PRIORITY) {
    const keywords = ROLE_KEYWORDS[role];
    if (keywords.some((k) => keywordMatches(text, lower, k))) {
      return role;
    }
  }
  return null;
}

/** §6.1 — exposed for tests. */
export function roleKeywordsFor(role: ShowroomRoleHint): readonly string[] {
  return ROLE_KEYWORDS[role];
}

/** R6 FU.5 (2026-05-09) — localStorage helpers for the PWA backend
 *  toggle. Storage keys mirror the daemon env shape:
 *    elanous.showroom.roleJudgeBackend = 'keyword' | 'local-llm'
 *    elanous.showroom.roleJudgeModel   = '<model id>' (optional)
 *  Defaults to 'keyword' (opt-in safe). */
export type ShowroomRoleJudgeBackend = 'keyword' | 'local-llm';

const ROLE_JUDGE_BACKEND_KEY = 'elanous.showroom.roleJudgeBackend';
const ROLE_JUDGE_MODEL_KEY = 'elanous.showroom.roleJudgeModel';

export function readRoleJudgeBackendFromStorage(): ShowroomRoleJudgeBackend {
  if (typeof window === 'undefined') return 'keyword';
  try {
    const v = window.localStorage.getItem(ROLE_JUDGE_BACKEND_KEY);
    return v === 'local-llm' ? 'local-llm' : 'keyword';
  } catch { return 'keyword'; }
}

export function writeRoleJudgeBackendToStorage(value: ShowroomRoleJudgeBackend): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ROLE_JUDGE_BACKEND_KEY, value); }
  catch { /* swallow */ }
}

export function readRoleJudgeModelFromStorage(): string {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(ROLE_JUDGE_MODEL_KEY) ?? ''; }
  catch { return ''; }
}

export function writeRoleJudgeModelToStorage(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (value && value.length > 0) window.localStorage.setItem(ROLE_JUDGE_MODEL_KEY, value);
    else window.localStorage.removeItem(ROLE_JUDGE_MODEL_KEY);
  } catch { /* swallow */ }
}

/** R6 Task 5 · §6.1 — async LLM-judge augment for `planDispatch`.
 *
 *  Composes:
 *  1. The synchronous `planDispatch` (mention parse + keyword classify).
 *  2. If the keyword classifier produced no role AND the layout
 *     enabled the LLM-judge backend, call the daemon's
 *     `/v1/showroom/role-judge` endpoint (hybrid composer wraps the
 *     keyword + local-llm tiers).
 *
 *  The synchronous result is returned immediately when it already
 *  has a non-null role — we never overwrite a confident keyword
 *  match. A null role + judge enabled triggers the network call;
 *  the response is bounded by the daemon's own 200ms timeout, so
 *  callers that await this still feel snappy.
 *
 *  When the judge endpoint is unavailable / times out, the function
 *  returns the raw keyword-tier `planDispatch` answer (broadcast
 *  fallback intact). */
export async function planDispatchWithLlmJudge(
  text: string,
  panels: readonly ShowroomPanel[],
  judge: ((prompt: string) => Promise<{
    role: ShowroomRoleHint | null;
    source: 'keyword' | 'local-llm' | 'fallback';
  }>) | null,
): Promise<DispatchPlan> {
  const sync = planDispatch(text, panels);
  // Mention paths + keyword-classified paths short-circuit — only
  // pure-broadcast (no signal at all) paths consult the LLM judge.
  if (sync.mode !== 'broadcast' || sync.classifiedRole) return sync;
  if (!judge) return sync;
  try {
    const judgeOut = await judge(text);
    if (judgeOut.role === null) return sync;
    // Re-run planDispatch with a `roleHint` taken from the judge.
    return planDispatch(text, panels, { roleHint: judgeOut.role });
  } catch {
    return sync;
  }
}

/** P2.5 — typeahead match. textarea 의 cursor pos 기준 직전 `@<partial>`
 *  토큰 검출 후 매칭되는 panel 목록 + token range 반환. UI 가 dropdown
 *  표시 / hide 결정에 사용.
 *
 *  - `@` 직후 알파벳/digit/dash 가 0+ characters 인 cursor 위치만 trigger
 *  - 매치되는 panel display name (D12) prefix 검색 · case-insensitive
 *  - `@` 토큰의 시작 / 끝 offset 도 반환 (insertMention 시 토큰 replace)
 *  - 매치 없으면 null (UI dropdown hide)
 */
export interface MentionTypeaheadMatch {
  /** `@` 의 시작 offset (이 인덱스의 character 가 `@`). */
  tokenStart: number;
  /** `@` 토큰의 끝 offset (exclusive · cursor pos 또는 이후 word). */
  tokenEnd: number;
  /** `@` 직후 사용자가 입력한 partial (소문자화 안 됨 · UI 표시용). */
  partial: string;
  /** matching panel 목록 (display name prefix · `@all` 도 후보). */
  matches: ShowroomPanel[];
  /** `@all` 매치 여부 (panel 외에 별도 후보 — chip 형태). */
  allMatches: boolean;
}

const MENTION_TYPEAHEAD_RE = /(^|\s)@([a-zA-Z0-9-]*)$/;

export function matchMentionTypeahead(
  text: string,
  cursorPos: number,
  panels: readonly ShowroomPanel[],
): MentionTypeaheadMatch | null {
  const head = text.slice(0, cursorPos);
  const m = MENTION_TYPEAHEAD_RE.exec(head);
  if (!m) return null;
  const partial = m[2] ?? '';
  // `@` 의 시작 offset = match end - partial.length - 1 ('@' 1 chr)
  const tokenStart = head.length - partial.length - 1;
  const tokenEnd = cursorPos;
  const partialLower = partial.toLowerCase();
  const matches = panels.filter((p) => {
    const dn = panelDisplayName(p, panels).toLowerCase();
    return dn.startsWith(partialLower);
  });
  const allMatches = 'all'.startsWith(partialLower);
  return { tokenStart, tokenEnd, partial, matches, allMatches };
}

/** P2.5 — auto-unmute. targeted mention 으로 받는 panel 이 mute 인 경우
 *  자동으로 live 으로 전환. 사용자가 명시적으로 mute 한 panel 도 mention
 *  하면 의도가 "이 turn 만은 받음" — UX 자연스러움.
 *
 *  freeze 는 그대로 (사용자가 명시 frozen 한 panel 의 결과 보존 의도).
 *  return = 새 panels array (panel.state 변경 적용 · immutable update). */
export function autoUnmuteForDispatch(
  panels: readonly ShowroomPanel[],
  mentionedTargetIds: readonly string[],
): ShowroomPanel[] {
  if (mentionedTargetIds.length === 0) return panels.slice();
  const mentioned = new Set(mentionedTargetIds);
  let changed = false;
  const next = panels.map((p) => {
    if (mentioned.has(p.id) && p.state === 'mute') {
      changed = true;
      return { ...p, state: 'live' as const };
    }
    return p;
  });
  return changed ? next : panels.slice();
}

/** P2 — input text 에서 mention 토큰 제거. agent prompt 로 보내는
 *  text 에서 `@codex` 같은 mention 을 제거하면 LLM 이 dispatch 의도를
 *  context 로 잘못 해석하지 않음. (현재 P2 minimum 은 mention 보존 — UI
 *  intent surface 용 · LLM 도 mention 을 명시적으로 인지 가능. P2.5 에서
 *  toggle 가능.) */
export function stripMentions(text: string): string {
  return text.replace(MENTION_RE, '').replace(/\s+/g, ' ').trim();
}

/** P4 — terminal context 를 prompt prefix 로 직렬화.
 *
 *  Format (각 pin 마다 1 block · 순서 보존):
 *  ```
 *  <terminal_context label="...">
 *  <text>
 *  </terminal_context>
 *  ```
 *
 *  N>0 pin 시 prefix + "\n\n" + userText. 0 pin 시 빈 문자열.
 *  agent 가 `<terminal_context>` tag 를 자동 파싱하지 않더라도 LLM
 *  가 자연어로 인지 가능 (Markdown fenced code 와 유사 패턴).
 *
 *  P4.1 (현재) = 단순 string concat. P4.2 (daemon API) 에서는 같은
 *  format 을 daemon-side 에서 fill 가능.
 */
export function formatTerminalContextPrefix(
  contexts: readonly TerminalContext[],
): string {
  if (contexts.length === 0) return '';
  const blocks = contexts.map((ctx) => {
    const safeLabel = ctx.label.replace(/[<>"]/g, '_');
    return `<terminal_context label="${safeLabel}">\n${ctx.text}\n</terminal_context>`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}

/** P4 — terminal context id generator. */
export function newTerminalContextId(): string {
  return `tc-${Date.now().toString(36)}-${nextCounter()}`;
}

/** P4 — default label 자동 generation (사용자가 명시 안 했을 때).
 *  format: "terminal · N lines · HH:MM" */
export function defaultTerminalContextLabel(text: string, now: number = Date.now()): string {
  const lines = text.split('\n').length;
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `terminal · ${lines} lines · ${hh}:${mm}`;
}

/** DM-3 — prior-answer prompt prefix 직렬화 (RFC v4 §6.2 진짜 가치).
 *
 *  Format (각 promotion 마다 1 block · 순서 보존 · terminal_context
 *  패턴 미러):
 *  ```
 *  <prior_answer source="@codex" provider="codex">
 *  <text>
 *  </prior_answer>
 *  ```
 *
 *  N>0 promotion 시 prefix + "\n\n" + userText (terminal_context
 *  prefix 다음에 옴 · §dispatchText 의 ordering: terminal → prior →
 *  user). agent 가 `<prior_answer>` tag 자동 인식 안 해도 LLM 가
 *  자연어 이해 가능. */
export function formatPriorAnswerPrefix(
  priors: readonly PriorAnswer[],
): string {
  // §3.4 (BACKLOG-showroom-cv-3-post-dm-stage-4-2026-05-09): only chips
  // with `enabled !== false` participate in the broadcast. Disabled
  // chips remain visible in the UI for selective promotion later.
  const active = priors.filter((p) => p.enabled !== false);
  if (active.length === 0) return '';
  const blocks = active.map((p) => {
    const safeLabel = p.label.replace(/[<>"]/g, '_');
    const safeProvider = p.sourceProvider.replace(/[<>"]/g, '_');
    return `<prior_answer source="${safeLabel}" provider="${safeProvider}">\n${p.text}\n</prior_answer>`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}

export function newPriorAnswerId(): string {
  return `pa-${Date.now().toString(36)}-${nextCounter()}`;
}

/** DM-3 — default label (사용자가 명시 안 했을 때).
 *  format (§3.4): "T{n} @<displayName> · HH:MM" — turn 번호 prominent
 *  · displayName 은 D12 의 numeric suffix 가능 (`@codex-2` 같은) ·
 *  turnNumber 0 (or undefined for legacy callers) 면 prefix 생략. */
export function defaultPriorAnswerLabel(
  panel: ShowroomPanel,
  allPanels: readonly ShowroomPanel[],
  now: number = Date.now(),
  turnNumber: number = 0,
): string {
  const dn = panelDisplayName(panel, allPanels);
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const turn = turnNumber > 0 ? `T${turnNumber} ` : '';
  return `${turn}@${dn} · ${hh}:${mm}`;
}

/** §6.3 — URL context prompt prefix.
 *
 *  Format (각 pin 마다 1 block · 순서 보존):
 *  ```
 *  <url_context url="..." title="...">
 *  <text>
 *  </url_context>
 *  ```
 *
 *  N>0 pin 시 prefix + "\n\n" + 다음 단계. 0 pin 시 빈 문자열. */
export function formatUrlContextPrefix(
  contexts: readonly UrlContext[],
): string {
  if (contexts.length === 0) return '';
  const blocks = contexts.map((ctx) => {
    const safeUrl = ctx.url.replace(/[<>"]/g, '_');
    const safeLabel = ctx.label.replace(/[<>"]/g, '_');
    return `<url_context url="${safeUrl}" title="${safeLabel}">\n${ctx.text}\n</url_context>`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}

export function newUrlContextId(): string {
  return `uc-${Date.now().toString(36)}-${nextCounter()}`;
}

/** §6.3 — default URL label · prefer page title-ish (caller passes ·
 *  fallback host extraction). */
export function defaultUrlContextLabel(url: string, fallback?: string): string {
  if (fallback && fallback.trim().length > 0) return fallback.trim();
  try {
    const u = new URL(url);
    return u.hostname || url;
  } catch {
    return url;
  }
}

/** §6.3 — Clipboard context prompt prefix.
 *
 *  Format:
 *  ```
 *  <clipboard_context label="...">
 *  <text>
 *  </clipboard_context>
 *  ```
 *
 *  N>0 pin 시 prefix + "\n\n". 0 pin 시 빈 문자열. */
export function formatClipboardContextPrefix(
  contexts: readonly ClipboardContext[],
): string {
  if (contexts.length === 0) return '';
  const blocks = contexts.map((ctx) => {
    const safeLabel = ctx.label.replace(/[<>"]/g, '_');
    return `<clipboard_context label="${safeLabel}">\n${ctx.text}\n</clipboard_context>`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}

export function newClipboardContextId(): string {
  return `cc-${Date.now().toString(36)}-${nextCounter()}`;
}

/** §6.3 — default clipboard label · "clipboard · N chars · HH:MM". */
export function defaultClipboardContextLabel(
  text: string,
  now: number = Date.now(),
): string {
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `clipboard · ${text.length} chars · ${hh}:${mm}`;
}

/** R6 Task 4 · §6.3 — Video context prompt prefix.
 *
 *  Format (each pin · order preserved):
 *  ```
 *  <video_context label="..." filename="..." mime="..."
 *                 duration="MM:SS" dimensions="WxH">
 *  <frame data="data:image/png;base64,..." />
 *  </video_context>
 *  ```
 *
 *  N>0 pin → prefix + "\n\n". 0 pin → empty string. */
export function formatVideoContextPrefix(
  contexts: readonly ShowroomVideoContext[],
): string {
  if (contexts.length === 0) return '';
  const blocks = contexts.map((ctx) => {
    const sLabel = ctx.label.replace(/[<>"]/g, '_');
    const sName = ctx.filename.replace(/[<>"]/g, '_');
    const sMime = ctx.mimeType.replace(/[<>"]/g, '_');
    const dur = formatDurationMmSs(ctx.durationSec);
    const dims = `${ctx.widthPx}x${ctx.heightPx}`;
    return `<video_context label="${sLabel}" filename="${sName}" mime="${sMime}" duration="${dur}" dimensions="${dims}">\n<frame data="${ctx.frameDataUrl}" />\n</video_context>`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}

export function newVideoContextId(): string {
  return `vc-${Date.now().toString(36)}-${nextCounter()}`;
}

/** R6 Task 4 · §6.3 — default video label · "video · MM:SS · WxH · YYYY-MM-DD". */
export function defaultVideoContextLabel(
  durationSec: number,
  widthPx: number,
  heightPx: number,
  now: number = Date.now(),
): string {
  const dur = formatDurationMmSs(durationSec);
  const dims = `${widthPx}x${heightPx}`;
  const d = new Date(now);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `video · ${dur} · ${dims} · ${yyyy}-${mm}-${dd}`;
}

/** R6 Task 4 · §6.3 — Audio context prompt prefix.
 *
 *  Format (each pin):
 *  ```
 *  <audio_context label="..." filename="..." mime="..."
 *                 duration="MM:SS" size="N bytes">
 *  <transcript>...</transcript>
 *  </audio_context>
 *  ```
 *
 *  Transcript element is omitted when empty so non-STT consumers
 *  know to ignore the slot. N>0 pin → prefix + "\n\n". */
export function formatAudioContextPrefix(
  contexts: readonly ShowroomAudioContext[],
): string {
  if (contexts.length === 0) return '';
  const blocks = contexts.map((ctx) => {
    const sLabel = ctx.label.replace(/[<>"]/g, '_');
    const sName = ctx.filename.replace(/[<>"]/g, '_');
    const sMime = ctx.mimeType.replace(/[<>"]/g, '_');
    const dur = formatDurationMmSs(ctx.durationSec);
    const head = `<audio_context label="${sLabel}" filename="${sName}" mime="${sMime}" duration="${dur}" size="${ctx.sizeBytes} bytes">`;
    const body = ctx.transcript.trim().length > 0
      ? `\n<transcript>${ctx.transcript}</transcript>\n`
      : '\n';
    return `${head}${body}</audio_context>`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}

export function newAudioContextId(): string {
  return `ac-${Date.now().toString(36)}-${nextCounter()}`;
}

/** R6 Task 4 · §6.3 — default audio label · "audio · MM:SS · YYYY-MM-DD". */
export function defaultAudioContextLabel(
  durationSec: number,
  now: number = Date.now(),
): string {
  const dur = formatDurationMmSs(durationSec);
  const d = new Date(now);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `audio · ${dur} · ${yyyy}-${mm}-${dd}`;
}

/** Pure helper — format a non-negative second count into "M:SS" (or
 *  "MM:SS"). Negative / NaN clamps to "0:00". Exported for tests. */
export function formatDurationMmSs(sec: number): string {
  const safe = Number.isFinite(sec) && sec >= 0 ? Math.floor(sec) : 0;
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** §6.7 — default route prompt when wrap='prior' edge 의 routePrompt
 *  가 비어있을 때 사용. 한국어 default · LLM 이 자연어로 review 의도
 *  파악. */
export const DEFAULT_ROUTE_PROMPT = '위의 답변을 검토해주세요.';

export function newChainEdgeId(): string {
  return `ce-${Date.now().toString(36)}-${nextCounter()}`;
}

export type AddChainEdgeFailure = 'self-route' | 'cycle' | 'duplicate';

export interface AddChainEdgeOk {
  ok: true;
  edge: ChainEdge;
  edges: ChainEdge[];
}

export interface AddChainEdgeFail {
  ok: false;
  reason: AddChainEdgeFailure;
}

export interface AddChainEdgeOpts {
  wrapMode?: 'plain' | 'prior';
  routePrompt?: string;
  enabled?: boolean;
  /** D3 (2026-05-11) — when true, the resulting edge ships with
   *  `hitl: true` so its forward trigger pauses for a user confirm
   *  modal in ShowroomLayout instead of firing immediately. */
  hitl?: boolean;
}

/** §6.7 — directed cycle detect. adding edge `from → to` creates cycle
 *  iff `to` can already reach `from` via existing edges. BFS from `to`
 *  looking for `from`. self-route (from === to) 도 cycle 로 취급. */
export function wouldCreateCycle(
  edges: readonly ChainEdge[],
  fromPanelId: string,
  toPanelId: string,
): boolean {
  if (fromPanelId === toPanelId) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.fromPanelId) ?? [];
    list.push(e.toPanelId);
    adjacency.set(e.fromPanelId, list);
  }
  const visited = new Set<string>();
  const queue: string[] = [toPanelId];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === fromPanelId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    const next = adjacency.get(node);
    if (next) queue.push(...next);
  }
  return false;
}

/** §6.7 — add chain edge with safety checks (self-route · duplicate ·
 *  cycle). 각 reject 는 reason 으로 surface (UI hint 용). */
export function addChainEdge(
  edges: readonly ChainEdge[],
  fromPanelId: string,
  toPanelId: string,
  opts: AddChainEdgeOpts = {},
): AddChainEdgeOk | AddChainEdgeFail {
  if (fromPanelId === toPanelId) {
    return { ok: false, reason: 'self-route' };
  }
  if (edges.some((e) => e.fromPanelId === fromPanelId && e.toPanelId === toPanelId)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (wouldCreateCycle(edges, fromPanelId, toPanelId)) {
    return { ok: false, reason: 'cycle' };
  }
  const trimmedPrompt = opts.routePrompt?.trim();
  const edge: ChainEdge = {
    id: newChainEdgeId(),
    fromPanelId,
    toPanelId,
    wrapMode: opts.wrapMode ?? 'prior',
    ...(trimmedPrompt ? { routePrompt: trimmedPrompt } : {}),
    enabled: opts.enabled ?? true,
    ...(opts.hitl ? { hitl: true } : {}),
    createdAt: Date.now(),
  };
  return { ok: true, edge, edges: [...edges, edge] };
}

/** §6.7 — remove edge by id. unknown id = no-op (returns same-content
 *  array). */
export function removeChainEdge(
  edges: readonly ChainEdge[],
  edgeId: string,
): ChainEdge[] {
  return edges.filter((e) => e.id !== edgeId);
}

/** §6.7 — outgoing edges from `panelId` (enabled 무관 · 호출자가 필터). */
export function findEdgesFrom(
  edges: readonly ChainEdge[],
  panelId: string,
): ChainEdge[] {
  return edges.filter((e) => e.fromPanelId === panelId);
}

/** §6.7 — panel close 시 호출. 해당 panel 이 endpoint 인 모든 edge 제거.
 *  변경 없으면 same-reference 보존 (caller 의 useEffect 안정). */
export function pruneEdgesForPanel(
  edges: readonly ChainEdge[],
  panelId: string,
): ChainEdge[] {
  const filtered = edges.filter(
    (e) => e.fromPanelId !== panelId && e.toPanelId !== panelId,
  );
  return filtered.length === edges.length ? edges.slice() : filtered;
}

/** §6.7 — compose forward text. wrap='plain' = sourceText 그대로 ·
 *  wrap='prior' = `<prior_answer>` block + routePrompt (default 한국어).
 *
 *  format ('prior' mode):
 *  ```
 *  <prior_answer source="@codex" provider="codex">
 *  <sourceText>
 *  </prior_answer>
 *
 *  <routePrompt>
 *  ```
 *
 *  agent 가 `<prior_answer>` tag 인식 안 해도 LLM 자연어 이해 가능 ·
 *  formatPriorAnswerPrefix 와 동일 패턴 (DM-3 §6.2 mirror). */
export function composeForwardText(
  edge: ChainEdge,
  sourceText: string,
  sourceProvider: string,
  sourceLabel: string,
): string {
  if (edge.wrapMode === 'plain') {
    return sourceText;
  }
  const safeLabel = sourceLabel.replace(/[<>"]/g, '_');
  const safeProvider = sourceProvider.replace(/[<>"]/g, '_');
  const block = `<prior_answer source="${safeLabel}" provider="${safeProvider}">\n${sourceText}\n</prior_answer>`;
  const prompt = edge.routePrompt?.trim() || DEFAULT_ROUTE_PROMPT;
  return `${block}\n\n${prompt}`;
}

/** DM stage 3 (#1956 → #1983 → 본 PR) — daemon multi-LLM mode is now
 *  default ON. The legacy P1-P4 panel-local ACP path was removed; DM
 *  stage 1 (chat) + stage 2 (agent · daemon dual-role manager) handle
 *  all multi-LLM dispatch. The storage key is retained as an explicit
 *  OFF override (legacy fallback safety hatch · also lets existing
 *  `'true'` values keep working). Read returns `true` unless the key
 *  is explicitly stored as `'false'`. */
export const DM_MODE_LOCALSTORAGE_KEY = 'elanous.showroom.dmMode';

export function readDmModeFromStorage(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return true;
  try {
    return window.localStorage.getItem(DM_MODE_LOCALSTORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeDmModeToStorage(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (enabled) window.localStorage.removeItem(DM_MODE_LOCALSTORAGE_KEY);
    else window.localStorage.setItem(DM_MODE_LOCALSTORAGE_KEY, 'false');
  } catch {
    /* swallow quota / SecurityError */
  }
}

/** DM-2 — daemon multi-LLM hint (server-side `_meta.elanous.multiLlm`
 *  shape mirror). client-side helpers build this from the live panel
 *  state so daemon's `bridgeMultiLlmCoreTurnsToAcp` fans out into N
 *  parallel `runCoreTurn`s.
 *
 *  See: src/acp/multi-llm-bridge.ts (daemon side · DM-1 · #1933) ·
 *  내부 문서 `PLAN-cv-3-daemon-multi-llm-2026-05-08` (RFC v2 · 13 D). */
export interface MultiLlmTargetWire {
  id: string;
  provider: string;
  model?: string;
  /** DM-2 wire seam (DM-3 mixed mode 가 활성 시 채워짐) — daemon 이
   *  per-target seed messages 로 그대로 사용. P1-P4 기간엔 항상
   *  undefined. */
  messages?: unknown[];
  /** DM stage 2 (#1982 follow-up) — when the panel is an agent CLI
   *  panel, the client opt-in adds these so daemon's multi-LLM bridge
   *  routes via globalDualRoleManager (real codex/claude/gemini sub-
   *  process) instead of the LLM API. Chat panels MUST omit. */
  kind?: 'agent';
  backend?: 'codex-app-server' | 'claude' | 'gemini';
  /** §6.4 — persona binding (PersonaProfile.personaId). daemon resolves
   *  via global PersonaRegistry + assemblePersonaPrompt. unknown id =
   *  no-op fallback (base systemPrompt only). */
  personaId?: string;
  /** DM stage 4 (2026-05-09 night) — panel's last assistant turn,
   *  shipped when historyMode === 'mixed' so the daemon can prepend
   *  sibling lastAssistant blocks (`<prior_answer model=X>`) to each
   *  target's user prompt for cross-model deliberation automation.
   *  Caller fills via `extractLastAssistantText(panelMessages)`. */
  lastAssistant?: string;
}

export interface MultiLlmHintWire {
  targets: readonly MultiLlmTargetWire[];
  historyMode?: 'isolated' | 'mixed';
}

/** Build the `_meta.elanous.multiLlm` blob from active panel state.
 *  Targets only `live` panels (mute / freeze 는 dispatch 제외 · D11).
 *
 *  DM stage 2 (FU · #1976) — `includeAgent` opts 으로 agent panel 도
 *  hint targets 에 포함 가능. daemon-side multi-backend dispatch 는
 *  P5.x.+ BACKLOG (현재 DM-1 bridge 는 direct LLM API 만 supports) ·
 *  client-side wire seam 만 land. caller (ShowroomLayout) 가 명시
 *  활성화 한 경우만 동작.
 *
 *  DM stage 4 (2026-05-09 night) — `lastAssistantByPanelId` opt 로
 *  panel 별 lastAssistant text 전달. historyMode === 'mixed' 일 때
 *  daemon 이 sibling 의 lastAssistant 를 `<prior_answer model=X>`
 *  block 으로 묶어 user prompt 에 prepend. */
export function buildMultiLlmHint(
  panels: readonly ShowroomPanel[],
  opts: {
    historyMode?: 'isolated' | 'mixed';
    includeAgent?: boolean;
    lastAssistantByPanelId?: Readonly<Record<string, string | undefined>>;
  } = {},
): MultiLlmHintWire | null {
  const targets: MultiLlmTargetWire[] = panels
    .filter((p) => p.state === 'live' && (p.kind === 'chat' || (opts.includeAgent && p.kind === 'agent')))
    .map((p) => {
      const t: MultiLlmTargetWire = { id: p.id, provider: p.provider };
      // DM stage 2 — agent panel marks itself + carries backend so the
      // daemon multi-LLM bridge routes via dual-role-manager.
      if (p.kind === 'agent' && p.agentBrand) {
        t.kind = 'agent';
        t.backend = agentBrandToBackend(p.agentBrand);
      }
      // §6.4 — forward personaId to daemon (multi-llm-bridge resolves
      // via PersonaRegistry + assemblePersonaPrompt). undefined here =
      // no-op (base systemPrompt only).
      if (p.personaId) t.personaId = p.personaId;
      // DM stage 4 — fold the panel's last assistant text into the
      // wire when caller supplied the map. The daemon ignores this
      // unless historyMode === 'mixed' so it's safe to always attach
      // (extra payload bytes only when the panel actually has a
      // prior reply).
      if (opts.lastAssistantByPanelId) {
        const last = opts.lastAssistantByPanelId[p.id];
        if (typeof last === 'string' && last.length > 0) {
          t.lastAssistant = last;
        }
      }
      return t;
    });
  if (targets.length === 0) return null;
  const hint: MultiLlmHintWire = { targets };
  if (opts.historyMode) hint.historyMode = opts.historyMode;
  return hint;
}

/** DM stage 4 — extract the last assistant text from a panel's
 *  ChatMessage[] history. Used by ShowroomLayout to build the
 *  `lastAssistantByPanelId` map at broadcast time. Returns
 *  undefined when the panel has no assistant turn yet (first
 *  broadcast). Empty-text assistant placeholders (mid-stream) are
 *  also rejected. */
export function extractLastAssistantText(
  messages: ReadonlyArray<{ role?: string; text?: string }> | null | undefined,
): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && typeof m.text === 'string' && m.text.length > 0) {
      return m.text;
    }
  }
  return undefined;
}

/** DM stage 4 — historyMode persistence (localStorage). Default
 *  'mixed' (opt-out) since 2026-05-11 (BACKLOG §3.7 flip) — Cost gate
 *  modal (PR #2192) ships first so unexpected token spend is gated by
 *  user confirm. Users who prefer panel isolation opt out via the
 *  Showroom header pill, which writes 'isolated' to storage. */
const HISTORY_MODE_KEY = 'elanous.showroom.historyMode';

export function readHistoryModeFromStorage(): 'isolated' | 'mixed' {
  if (typeof window === 'undefined') return 'mixed';
  try {
    const v = window.localStorage.getItem(HISTORY_MODE_KEY);
    return v === 'isolated' ? 'isolated' : 'mixed';
  } catch {
    return 'mixed';
  }
}

export function writeHistoryModeToStorage(mode: 'isolated' | 'mixed'): void {
  if (typeof window === 'undefined') return;
  try {
    if (mode === 'isolated') window.localStorage.setItem(HISTORY_MODE_KEY, 'isolated');
    else window.localStorage.removeItem(HISTORY_MODE_KEY);
  } catch {
    // swallow — storage may be disabled (private browsing)
  }
}

/** Wrap the hint inside the `_meta.elanous.multiLlm` envelope so
 *  callers ship it verbatim as `prompt._meta`. */
export function wrapMultiLlmMeta(hint: MultiLlmHintWire): {
  elanous: { multiLlm: MultiLlmHintWire };
} {
  return { elanous: { multiLlm: hint } };
}

/** DM-2 — parse `update._meta.elanous` to extract per-panel routing
 *  info. Returns null when the update is the legacy single-LLM
 *  shape (no `modelId`). */
export interface MultiLlmUpdateMeta {
  modelId: string;
  provider?: string;
  stopReason?: 'end_turn' | 'cancelled' | 'error';
  error?: string;
}

/** DM stage 3 FU (HANDOFF §3.2) — extract a `tool_call` /
 *  `tool_call_update` SessionUpdate's payload. Returns null when the
 *  update isn't a tool call event or when it's missing required
 *  fields. The Showroom client uses this to drive a per-panel
 *  `Record<id, ToolCallState>` that powers the activity pill +
 *  expandable list (re-add of #1985's panel-local viz, removed when
 *  DM stage 3 routing replaced the panel-local ACP path).
 *
 *  Wire shape mirrors `apps/pwa/src/lib/chat-runtime.ts:606+` plus the
 *  daemon-side `pushToolCall` / `pushToolResult` (server.ts:929+):
 *    - `tool_call`        → kind='call'   · status='pending' default
 *    - `tool_call_update` → kind='update' · status echoed verbatim
 */
export interface ShowroomToolCallEvent {
  kind: 'call' | 'update';
  id: string;
  /** ACP `title` field — tool name (`read_file`, `bash`, …). May be
   *  empty for tool_call_update when only status flips. */
  name: string;
  status: ToolCallState['status'];
  input?: Readonly<Record<string, unknown>>;
  /** Compact stringified preview of the tool result (when terminal). */
  output?: string;
}

function normalizeStatus(raw: unknown, kind: 'call' | 'update'): ToolCallState['status'] {
  if (raw === 'pending' || raw === 'in_progress' || raw === 'completed' || raw === 'failed') {
    return raw;
  }
  // Fallbacks matching chat-runtime's pragmatic mapping (line 620):
  // explicit-but-unknown statuses are treated as 'failed' on update,
  // and a fresh tool_call without status defaults to 'pending'.
  return kind === 'call' ? 'pending' : 'failed';
}

function stringifyOutput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
  try {
    const json = JSON.stringify(raw);
    if (!json) return undefined;
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return undefined;
  }
}

export function parseShowroomToolCallEvent(
  update: unknown,
): ShowroomToolCallEvent | null {
  if (!update || typeof update !== 'object') return null;
  const u = update as {
    sessionUpdate?: unknown;
    toolCallId?: unknown;
    title?: unknown;
    status?: unknown;
    rawInput?: unknown;
    rawOutput?: unknown;
  };
  const isCall = u.sessionUpdate === 'tool_call';
  const isUpdate = u.sessionUpdate === 'tool_call_update';
  if (!isCall && !isUpdate) return null;
  if (typeof u.toolCallId !== 'string' || u.toolCallId.length === 0) return null;
  const kind: 'call' | 'update' = isCall ? 'call' : 'update';
  const ev: ShowroomToolCallEvent = {
    kind,
    id: u.toolCallId,
    name: typeof u.title === 'string' ? u.title : '',
    status: normalizeStatus(u.status, kind),
  };
  if (u.rawInput && typeof u.rawInput === 'object') {
    ev.input = u.rawInput as Readonly<Record<string, unknown>>;
  }
  const out = stringifyOutput(u.rawOutput);
  if (out !== undefined) ev.output = out;
  return ev;
}

/** Apply a decoded ShowroomToolCallEvent to a per-panel ToolCallState
 *  map (Record<id, ToolCallState>). Pure · returns a new map (never
 *  mutates input). Strategy:
 *
 *   - `kind === 'call'`: insert (or refresh if id reused — agent CLI
 *     sometimes re-emits a tool_call for retry; treat as restart).
 *   - `kind === 'update'`: merge into existing entry. If no entry
 *     exists yet (out-of-order arrival), create one with the update's
 *     fields filled best-effort.
 *
 *  Caller passes `now` so tests can pin timestamps. */
export function applyToolCallEvent(
  prev: Readonly<Record<string, ToolCallState>>,
  event: ShowroomToolCallEvent,
  now: number,
): Record<string, ToolCallState> {
  const next: Record<string, ToolCallState> = { ...prev };
  const existing = next[event.id];
  if (event.kind === 'call' || !existing) {
    const seed: ToolCallState = {
      id: event.id,
      name: event.name || existing?.name || '',
      status: event.status,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    };
    if (event.input) seed.input = event.input;
    else if (existing?.input) seed.input = existing.input;
    if (event.output !== undefined) seed.output = event.output;
    else if (existing?.output !== undefined) seed.output = existing.output;
    next[event.id] = seed;
    return next;
  }
  // kind === 'update' & existing — merge.
  const merged: ToolCallState = {
    ...existing,
    status: event.status,
    updatedAt: now,
  };
  if (event.name) merged.name = event.name;
  if (event.input) merged.input = event.input;
  if (event.output !== undefined) merged.output = event.output;
  next[event.id] = merged;
  return next;
}

/** DM stage 3 FU display polish (BACKLOG #5 · 2026-05-09) — derive
 *  the (name, meta) pair the ShowroomPanel tool list row should
 *  render for a single ToolCallState. Two display problems we hit
 *  during dogfood:
 *
 *   1. Codex CLI sets `update.title` to the *entire bash command*
 *      (e.g., `/bin/zsh -lc "rg -n \"foo\" src/x.ts && ..."`) —
 *      300+ chars in the row, no usable identifier.
 *   2. The same bash command is also surfaced as `input.command`
 *      (the LLM-side tool argument), so the row repeats itself.
 *
 *  Approach (intentionally dumb):
 *
 *   - Truncate name to NAME_MAX with ellipsis.
 *   - Pick the first input entry (or output as fallback) as meta.
 *     Truncate to META_MAX.
 *   - Suppress meta when name and meta are effectively redundant
 *     (one contains the other after lowercasing + trimming the
 *     truncation ellipsis). This catches the codex CLI bash case
 *     without per-CLI heuristics.
 *
 *  Pure function — exported for unit testing without a render. */
export interface ToolListEntryDisplay {
  /** Up to NAME_MAX chars, ellipsis suffix when truncated. */
  name: string;
  /** First-input or output preview · null when redundant with name
   *  or unavailable. Up to META_MAX chars, ellipsis suffix when
   *  truncated. */
  meta: string | null;
}

const TOOL_LIST_NAME_MAX = 56;
const TOOL_LIST_META_MAX = 96;

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function looksRedundant(name: string, meta: string): boolean {
  const norm = (s: string) =>
    s.replace(/…$/, '').replace(/^command=/, '').trim().toLowerCase();
  const a = norm(name);
  const b = norm(meta);
  if (!a || !b) return false;
  if (a === b) return true;
  // Meta usually has a `key=value` shape; strip the key and re-check
  // against name (so `command=/bin/zsh ...` vs name `/bin/zsh ...`).
  const eq = b.indexOf('=');
  const bValue = eq >= 0 ? b.slice(eq + 1).trim() : b;
  if (bValue && (a.startsWith(bValue) || bValue.startsWith(a))) return true;
  return false;
}

export function formatToolListEntry(
  tc: { name: string; input?: Readonly<Record<string, unknown>>; output?: string },
): ToolListEntryDisplay {
  const rawName = tc.name && tc.name.length > 0 ? tc.name : '(unnamed)';
  const name = clamp(rawName, TOOL_LIST_NAME_MAX);

  let metaSource: string | null = null;
  if (tc.input) {
    const entries = Object.entries(tc.input);
    if (entries.length > 0) {
      const [k, v] = entries[0]!;
      const vStr =
        typeof v === 'string' ? v
          : v === null ? 'null'
            : v === undefined ? 'undefined'
              : JSON.stringify(v);
      metaSource = `${k}=${vStr}`;
    }
  } else if (tc.output && tc.output.length > 0) {
    metaSource = tc.output;
  }

  if (metaSource === null) return { name, meta: null };

  const meta = clamp(metaSource, TOOL_LIST_META_MAX);
  if (looksRedundant(rawName, metaSource)) return { name, meta: null };
  return { name, meta };
}

export function parseMultiLlmUpdateMeta(
  update: unknown,
): MultiLlmUpdateMeta | null {
  if (!update || typeof update !== 'object') return null;
  const meta = (update as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return null;
  const elanous = (meta as { elanous?: unknown }).elanous;
  if (!elanous || typeof elanous !== 'object') return null;
  const m = elanous as Record<string, unknown>;
  if (typeof m.modelId !== 'string' || m.modelId.length === 0) return null;
  const out: MultiLlmUpdateMeta = { modelId: m.modelId };
  if (typeof m.provider === 'string') out.provider = m.provider;
  if (
    m.stopReason === 'end_turn'
    || m.stopReason === 'cancelled'
    || m.stopReason === 'error'
  ) {
    out.stopReason = m.stopReason;
  }
  if (typeof m.error === 'string') out.error = m.error;
  return out;
}
