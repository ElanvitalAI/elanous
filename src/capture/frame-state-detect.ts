// ── Capture substrate · region-rule 화면 상태 감지 (PLAN §7 P1 · 프론티어 차용 #1) ──
//
// herdr `src/detect/manifest.rs` 의 선언적 규칙엔진을 TS 로 이식: 렌더 화면 위 **region-스코프
// 우선순위 규칙**으로 상태(idle/working/blocked/unknown)를 분류. ML·타이머 진실 아님 — 라이브 버퍼
// 하단 텍스트 매칭. [[RESEARCH-pty-multiplexer-frontier-herdr-orca-2026-07-24]] §1-1·§5 #1.
//
// ⭐ 왜 P1 에 필요한가: 기존 P1(`frame-log-diagnosis`)의 frame-side 신호는 "화면이 변했나"뿐이라
// 약하다. 이 모듈이 화면을 **상태로 분류**하면 drift = *분류된 화면-상태* ⊕ *로그-상태* 로 강해진다
// (herdr 화면 렌즈 + elanous 로그 렌즈 = §4 두-렌즈 대조). 분류 결과는 #5 이벤트로그에도 기록돼
// `waitForSurfaceState` 의 생산자가 된다(#1=생산자, #5=전송로).
//
// 규칙셋은 herdr claude/codex 규칙 + 범용 chrome. elanous 대시보드·codex 자식 공통 신호를 커버하되
// **주입 가능**(per-agent 규칙은 후속). region DSL·matcher 게이트는 herdr 와 동형.

/** 상태 어휘 — `pty-event-log` `SurfaceState` 와 정합(화면-측 기본은 idle/working/blocked/unknown 분류·
 *  waiting/done 은 주입 규칙 또는 후속 훅-측에서). */
export type FrameState = 'idle' | 'working' | 'blocked' | 'waiting' | 'done' | 'unknown';

/** 화면 슬라이스 선택자 — herdr region DSL 부분집합(가장 쓰이는 것). */
export type Region =
  | { readonly kind: 'whole' }
  | { readonly kind: 'bottomLines'; readonly n: number }  // 하단 N개 비어있지 않은 라인(라이브 프롬프트)
  | { readonly kind: 'topLines'; readonly n: number };

/** matcher 게이트 — herdr contains/regex/line_regex + all/any/not 중첩. */
export type Matcher =
  | { readonly kind: 'contains'; readonly text: string }   // region 텍스트 소문자 부분일치
  | { readonly kind: 'regex'; readonly re: RegExp }         // region 전체 텍스트 test
  | { readonly kind: 'lineRegex'; readonly re: RegExp }     // 임의 단일 라인 test
  | { readonly kind: 'all'; readonly of: readonly Matcher[] }
  | { readonly kind: 'any'; readonly of: readonly Matcher[] }
  | { readonly kind: 'not'; readonly of: Matcher };

export interface StateRule {
  readonly state: FrameState;
  readonly priority: number;   // 최고 우선순위 매치승(herdr priority)
  readonly region: Region;
  readonly match: Matcher;
  /** 라이브 chrome 신호(scrollback 아님) — 증거 품질(herdr visible_*). */
  readonly visible?: boolean;
  readonly label: string;      // explain 용
}

export interface FrameStateVerdict {
  readonly state: FrameState;
  readonly matchedLabel: string | null;
  readonly visible: boolean;
  /** herdr `agent explain` 축소판 — 매치한 규칙 라벨들(디버그/HITL). */
  readonly evaluated: readonly string[];
  /** unknown일 때만 규칙 검사가 본 하단 구역의 정리된 진단 입력. */
  readonly unknownInput?: readonly string[];
  /**
   * ⭐ unknown일 때만 — **본 범위 «밖»에서는 물었을** 규칙 라벨들.
   *
   * ⛔ 「화면에 신호가 «없었다»」와 「신호가 «창 밖»이라 «못 봤다»」는 다른 값이다.
   *   region 이 `whole` 인 규칙은 볼 밖이 없으므로 후보가 될 수 없다(계산에서 제외).
   * ⚠️ 이 값은 **진단**이다 — 재분류하지 않는다(`state` 는 그대로 `unknown`).
   *   임계도 만들지 않는다: 「몇 개면 idle 로 친다」 같은 판단은 여기서 하지 않는다.
   *
   * 📏 왜 필요한가(2026-08-11 실측 · `MEAS-T57`): 디스크에 남은 실제 미션 화면 **76개**
   *   (codex 32 · claude 44)를 `AGENT_MISSION_STATE_RULES` 로 분류하니 unknown 이 **50개**였고,
   *   ***그 50개 전부가 화면 어딘가에 프롬프트 기호를 갖고 있었다***. 비율은 backend 와 무관하게
   *   codex 66% · claude 66% 로 같았다 ⇒ 축은 backend 가 아니라 **region 크기 대 입력 에코 길이**다.
   *   같은 세션의 «연속 두 프레임»에서 갈린 실물도 있다(`05-s3-input`=idle → `06-s4-input`=unknown).
   */
  readonly outOfRegionCandidates?: readonly string[];
}

/** unknown 진단에 보존하는 하단 정리 라인의 최대 개수. */
export const UNKNOWN_INPUT_MAX_LINES = 10;
/** unknown 진단의 각 정리 라인 최대 코드포인트 길이. */
export const UNKNOWN_INPUT_MAX_LINE_LENGTH = 160;

// ── region / matcher 평가 (순수) ──

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const BOX_RE = /[│┃|┌┐└┘─━┄┅┈┉╭╮╯╰═║╔╗╚╝├┤┬┴┼╠╣╦╩╬▏▕]/g;

function cleanLine(l: string): string {
  return l.replace(ANSI_RE, '').replace(BOX_RE, ' ').replace(/[ \t]+/g, ' ').trim();
}

/** 프레임 → 분류기가 소비하는 비어있지 않은 정리된 라인들. */
export function classifierFrameLines(frame: string): string[] {
  return frame.split('\n').map(cleanLine).filter((l) => l.length > 0);
}

function selectRegionLines(lines: readonly string[], region: Region): string[] {
  switch (region.kind) {
    case 'whole': return [...lines];
    case 'bottomLines': return lines.slice(Math.max(0, lines.length - region.n));
    case 'topLines': return lines.slice(0, region.n);
  }
}

/** `RegExp.test` on a `g`/`y`-flagged regex advances `lastIndex`, making
 *  results order-dependent across calls. Rules are injectable, so reset before
 *  every test to keep classification deterministic (review must-fix). */
function reTest(re: RegExp, s: string): boolean {
  if (re.global || re.sticky) re.lastIndex = 0;
  return re.test(s);
}

function matcherMatches(regionText: string, regionLines: readonly string[], m: Matcher): boolean {
  switch (m.kind) {
    case 'contains': return regionText.toLowerCase().includes(m.text.toLowerCase());
    case 'regex': return reTest(m.re, regionText);
    case 'lineRegex': return regionLines.some((l) => reTest(m.re, l));
    case 'all': return m.of.every((sub) => matcherMatches(regionText, regionLines, sub));
    case 'any': return m.of.some((sub) => matcherMatches(regionText, regionLines, sub));
    case 'not': return !matcherMatches(regionText, regionLines, m.of);
  }
}

/** ⭐herdr 프로세스-명 매칭 축소판 — manifest `cmd`(+kind)에서 어느 코딩 에이전트인지 도출.
 *  wait 의 agent 핀(identity)이 실제로 매치하려면 생산자가 agent 를 채워야 한다(review must-fix:
 *  agent 미기록이면 agent-pin wait 영구 미매치). bun/node wrapper 뒤 실행도 cmd 문자열로 잡는다. */
export function detectAgentFromCmd(cmd: string | undefined, kind?: string): string | undefined {
  const c = (cmd ?? '').toLowerCase();
  if (/\bcodex\b/.test(c)) return 'codex';
  if (/\bclaude\b/.test(c)) return 'claude';
  if (/\bgemini\b/.test(c)) return 'gemini';
  if (/\bgrok\b/.test(c)) return 'grok';
  // elanous 자신(대시보드 TUI·self-implement 자식) — bin/elanous.mjs / elanous chat.
  if (/elanous(\.mjs)?\b/.test(c) || kind === 'tui' || kind === 'self') return 'elanous';
  return undefined;
}

/**
 * ⭐herdr evaluate_loaded_manifest — 규칙을 평가해 최고 우선순위 매치의 상태를 반환.
 * 동점은 먼저 등록된 규칙 유지(priority > best 만 교체). 매치 0 → unknown.
 */
export function classifyFrameState(frame: string, rules: readonly StateRule[] = DEFAULT_STATE_RULES): FrameStateVerdict {
  const lines = classifierFrameLines(frame);
  let best: StateRule | null = null;
  const evaluated: string[] = [];
  for (const rule of rules) {
    const regionLines = selectRegionLines(lines, rule.region);
    const regionText = regionLines.join('\n');
    if (matcherMatches(regionText, regionLines, rule.match)) {
      evaluated.push(rule.label);
      if (!best || rule.priority > best.priority) best = rule;
    }
  }
  if (!best) {
    const unknownInput = lines
      .slice(-UNKNOWN_INPUT_MAX_LINES)
      .map((line) => [...line].slice(0, UNKNOWN_INPUT_MAX_LINE_LENGTH).join(''));
    // ⭐ 「신호가 없었다」와 「신호가 «창 밖»이라 못 봤다」를 가른다 — 재분류는 «하지 않는다».
    //   region 이 whole 인 규칙은 이미 전부를 봤으므로 「밖」이 없다 ⇒ 후보에서 제외한다.
    const wholeText = lines.join('\n');
    const outOfRegionCandidates: string[] = [];
    for (const rule of rules) {
      if (rule.region.kind === 'whole') continue;
      if (matcherMatches(wholeText, lines, rule.match)) outOfRegionCandidates.push(rule.label);
    }
    return { state: 'unknown', matchedLabel: null, visible: false, evaluated, unknownInput, outOfRegionCandidates };
  }
  return { state: best.state, matchedLabel: best.label, visible: best.visible ?? false, evaluated };
}

// ── 기본 규칙셋 (herdr claude/codex + 범용 chrome · 주입 가능) ──
// 우선순위: blocked(100) > working(90) > idle(50). working 스피너가 프롬프트보다 우선(herdr 동형).
//
// ⚠️ 생산 범위(계약·review should-fix): 기본 규칙셋은 화면-측에서 **idle/working/blocked/unknown**
// 만 생산한다. `waiting`/`done` 은 (a) 주입 규칙 또는 (b) 후속 orca-式 에이전트 훅(프로토콜 레벨·
// `request_user_input`→waiting·프로세스 exit→done) 이 생산한다. 따라서 `waitForSurfaceState({until:
// ['done']})` 은 done 을 생산하는 프로듀서가 배선되기 전엔 매치하지 않는다(기본 화면 분류만으로는 timeout).

/** Braille 스피너(claude/codex working 표식) + 블록 스피너. */
const SPINNER_RE = /[⠀-⣿⣿⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/;

export const DEFAULT_STATE_RULES: readonly StateRule[] = [
  // BLOCKED — 승인/선택 UI(사람 입력 대기). herdr claude bash_permission_prompt·generic.
  // ⚠️ 커서 마커(❯/›/>)가 옵션 라인에 있어야 blocked — 일반 번호목록("1. foo\n2. bar")은
  // 대화형 선택이 아니므로 오탐 금지(review must-fix). herdr 도 `❯ 1. yes` 커서를 요구.
  {
    state: 'blocked', priority: 100, visible: true, label: 'permission-select',
    region: { kind: 'bottomLines', n: 10 },
    match: { kind: 'all', of: [
      { kind: 'lineRegex', re: /^\s*[❯›>]\s*1\.\s/ }, // 커서-마킹된 옵션 1(대화형 선택)
      { kind: 'lineRegex', re: /^\s*[❯›>]?\s*2\.\s/ },
    ] },
  },
  {
    state: 'blocked', priority: 100, visible: true, label: 'select-cancel-prompt',
    region: { kind: 'bottomLines', n: 10 },
    match: { kind: 'all', of: [
      { kind: 'contains', text: 'enter to' },
      { kind: 'contains', text: 'esc to cancel' },
    ] },
  },
  {
    state: 'blocked', priority: 95, visible: true, label: 'yes-no-inline',
    region: { kind: 'bottomLines', n: 6 },
    match: { kind: 'any', of: [
      { kind: 'contains', text: 'do you want to proceed' },
      { kind: 'regex', re: /\(y\/n\)|\[y\/n\]/i },
    ] },
  },
  // WORKING — 스피너 / esc-to-interrupt(에이전트 실행 중). herdr claude/codex working.
  {
    state: 'working', priority: 90, visible: true, label: 'spinner-or-interrupt',
    region: { kind: 'bottomLines', n: 4 },
    match: { kind: 'any', of: [
      { kind: 'lineRegex', re: SPINNER_RE },
      { kind: 'contains', text: 'esc to interrupt' },
      { kind: 'contains', text: 'ctrl+c to' },
    ] },
  },
  {
    state: 'working', priority: 90, visible: true, label: 'elanous-tui-turn-in-progress',
    region: { kind: 'bottomLines', n: 10 },
    match: { kind: 'lineRegex', re: /\(\s*\d+(?:\.\d+)?(?:ms|h|m|s)(?:\s+\d+(?:\.\d+)?(?:ms|h|m|s))*\b[^)]*·\s*esc 중단\s*\)/ },
  },
  // IDLE — 프롬프트만(입력 대기 없이). ⚠️ 반드시 **행 시작** 프롬프트 글리프(❯/›)여야 — 앵커
  // 없으면 `result > next`·Markdown 인용(`> …`) 등 일반 출력을 idle 로 오분류(review must-fix).
  // 모호한 `>` 는 제거(prompt vs quote/redirect 구분 불가) — 실 프롬프트 글리프 ❯/› + 커서 ▌ 만.
  {
    state: 'idle', priority: 50, visible: true, label: 'bare-prompt',
    region: { kind: 'bottomLines', n: 3 },
    match: { kind: 'lineRegex', re: /^\s*[❯›](\s|$)|▌/ },
  },
];

/** self-implement 자식 `elanous chat --tools --goal-loop` viewport 전용 주입 규칙.
 * `GOAL-COMPLETE`는 산문 부정문에도 등장하므로 contains가 아닌 단독 정리 라인만 완료로 본다.
 * 완료 화면에도 tool 행은 남아 working이 매치하므로 done(110)은 working(90)·blocked(100)보다 높다.
 * tool 행은 작업과 결과 사이에서 사라지지 않는 안정 신호로 유지해 working/unknown 플래핑과 과도한
 * 키프레임을 막는다. 화면 움직임은 상태와 직교하며 observeFrame의 stall 판정이 담당한다. */
export const GOAL_LOOP_STATE_RULES: readonly StateRule[] = [
  ...DEFAULT_STATE_RULES,
  {
    state: 'done', priority: 110, visible: true, label: 'goal-loop-complete',
    region: { kind: 'bottomLines', n: 6 },
    match: { kind: 'lineRegex', re: /^GOAL-COMPLETE$/ },
  },
  {
    state: 'working', priority: 90, visible: true, label: 'goal-loop-tool-activity',
    region: { kind: 'whole' },
    match: { kind: 'any', of: [
      { kind: 'lineRegex', re: /^\s*[\u23FA\u25CF]\s+\w+\(/ },
      { kind: 'lineRegex', re: /^\s*\u21B3\s/ },
    ] },
  },
  {
    state: 'idle', priority: 60, visible: true, label: 'goal-loop-session-summary',
    region: { kind: 'bottomLines', n: 3 },
    match: { kind: 'regex', re: /\[session [0-9a-f]{6,}/ },
  },
];

/** agent-mission Claude viewport 전용 주입 규칙.
 * Claude의 고정 chrome 네 줄 위에도 프롬프트·작업 표식이 남으므로 그 구역을 확장한다.
 * `MISSION-COMPLETE`는 산문에 인용될 수 있어 단독 정리 라인만 완료로 본다. */
export const AGENT_MISSION_STATE_RULES: readonly StateRule[] = [
  ...DEFAULT_STATE_RULES,
  {
    state: 'done', priority: 110, visible: true, label: 'agent-mission-complete',
    region: { kind: 'bottomLines', n: 10 },
    match: { kind: 'lineRegex', re: /^MISSION-COMPLETE$/ },
  },
  {
    state: 'working', priority: 90, visible: true, label: 'agent-mission-spinner-or-interrupt',
    region: { kind: 'bottomLines', n: 8 },
    match: { kind: 'any', of: [
      { kind: 'lineRegex', re: SPINNER_RE },
      { kind: 'contains', text: 'esc to interrupt' },
      { kind: 'contains', text: 'ctrl+c to' },
    ] },
  },
  {
    state: 'idle', priority: 60, visible: true, label: 'agent-mission-bare-prompt',
    region: { kind: 'bottomLines', n: 8 },
    match: { kind: 'lineRegex', re: /^\s*[❯›](\s|$)|▌/ },
  },
];

// ── 자기보고 턴 ⊕ 화면 추정 정합 (H10 조각 1 · TUI-H10-HEALTH-REPORT) ──
//
// 🩸 10-16 실측: 같은 `eln pty state opt` 가 `state=working`(화면 추정 — 스크롤백에 남은 «· Streaming… (5s · esc 중단)»
//   줄을 `elanous-tui-turn-in-progress` 가 물었다)과 `turn=idle`(TUI 가 스스로 적은 값)을 «동시에» 냈다(#55 이원 판정).
//   OP·TF 는 둘 중 무엇을 믿을지 몰라 herdr 화면을 긁었다.
// ⇒ 원천은 하나다: TUI 가 스스로 적은 턴(`tui-run-state` → manifest)이 있으면 그것이 «바쁜가/한가한가»를 정한다.
//   화면 추정은 턴 값이 «모를 때»와, 턴과 모순되지 않는 «더 구체적인» 상태(승인 대기 blocked·waiting·done)일 때만 쓴다.
//   ⛔ 화면 추정은 버리지 않는다 — `screenState` 로 같이 내서 둘이 갈린 순간이 관측에 남게 한다.

/** TUI 가 스스로 적은 턴(manifest `turnState`). 'unknown' = 기록 없음·죽은 행. */
export type SelfReportedTurn = 'busy' | 'idle' | 'unknown';

export interface ReconciledFrameState {
  /** 바깥에 내는 하나의 상태. */
  readonly state: FrameState;
  /** 'turn' = 자기보고 턴이 정했다(화면과 같았던 경우 포함) · 'screen' = 화면 추정을 그대로 썼다. */
  readonly source: 'turn' | 'screen';
  /** 화면 분류 원값(화면을 못 읽었으면 'unknown'). */
  readonly screenState: FrameState;
  /** 화면 추정이 턴과 «모순»돼 턴이 덮어썼나 — 관측 이벤트를 남길 자리. */
  readonly overridden: boolean;
}

/**
 * 화면 추정과 자기보고 턴을 하나로 접는다(순수).
 * - turn=busy: 화면 blocked·waiting 은 «턴 안의 더 구체적인 상태»라 유지, 그 밖(idle·unknown·done·working)은 working.
 * - turn=idle: 화면 blocked·waiting·done 은 유지(한가할 때 뜨는 선택 UI 등), working·unknown 은 idle.
 * - turn=unknown: 화면 추정 그대로.
 */
export function reconcileFrameStateWithTurn(screenState: FrameState, turn: SelfReportedTurn): ReconciledFrameState {
  if (turn === 'unknown') return { state: screenState, source: 'screen', screenState, overridden: false };
  if (turn === 'busy') {
    if (screenState === 'blocked' || screenState === 'waiting') return { state: screenState, source: 'screen', screenState, overridden: false };
    return { state: 'working', source: 'turn', screenState, overridden: screenState !== 'working' && screenState !== 'unknown' };
  }
  if (screenState === 'blocked' || screenState === 'waiting' || screenState === 'done') return { state: screenState, source: 'screen', screenState, overridden: false };
  return { state: 'idle', source: 'turn', screenState, overridden: screenState === 'working' };
}
