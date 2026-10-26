// Context signal collection.
//
// Signals are pure structured facts derived from the environment and
// the recent conversation. The gate (P4) reads them via a switch
// table — no LLM call, no heuristic scoring at runtime. Adding a
// signal is cheap; a new entry here + a branch in gate.ts.
//
// Signals are cached by fingerprint so the gate's memo stays warm;
// collectSignals() is cheap on re-entry within the same turn.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join as joinPath } from 'node:path';

import { getFirecrawlConfig } from '../registry/discovery/config.js';
import { getSessionCwd } from '../session/working-dir.js';
import type { ModelFamily } from '../models/prompts.js';
import type { SkillTier } from '../skills/runner.js';

/** Structured facts the gate uses. All fields are booleans or narrow
 *  enums so comparisons remain trivial. Extend this interface, then
 *  add a branch in `gate.ts`, then document the mapping near the
 *  consuming gate rule. */
export interface SignalSnapshot {
  // Filesystem fingerprint
  hasPython: boolean;
  hasNodeProject: boolean;
  hasGitRemote: boolean;

  // Recent conversation
  intentResearch: boolean;
  /** Deep multi-source research route; quick fact lookups remain capped. */
  researchAgent?: boolean;
  intentDiagram: boolean;
  recentNetworkError: boolean;

  // Arc H — intent scopes for tool count discipline. Each boolean is
  // independent; the gate uses them to add scopes on top of the default
  // `'coding'` scope. See `src/tool-hints/gate.ts` Step 2.5.
  intentBrowse: boolean;
  intentViz: boolean;
  intentCapture: boolean;
  /** Arc H follow-up — remote/fleet management intent (acp · agent
   *  room · iphone · budget · policy · llm nodes · team · hitl). */
  intentOpsFleet: boolean;
  /** Arc H follow-up — local dashboard UI intent (windows · panes ·
   *  terminal matrix/modal · context inspector · layout · vw ·
   *  widget · scenario). */
  intentOpsUi: boolean;
  /** ⭐ 2026-07-27 — **실행/변경 의도**(구현·재현·수리·테스트 실행·PR/머지·워크트리).
   *
   *  이 신호만 `'coding'` 스코프를 웜-preload 로 열어 배틀쉽 8종
   *  (EnterWorktree·SelfImplement·SelfOrchestrate·RunDevHarness·SolveMission·
   *  run_tests·GitCommit·MergePullRequest)을 active 로 승격한다.
   *
   *  ⚠️ **일부러 좁다.** 다른 intent 들은 "false positive 가 나도 boost 를 살짝 밀 뿐"
   *  이지만 이건 **무거운 스키마 8개를 프롬프트에 싣는다**. 그래서 코드 *명사*
   *  (함수·파일·버그)가 아니라 실행 *동사*(구현해·재현해·고쳐·돌려·머지)를 요구한다 —
   *  "이 구조 설명해줘" 같은 조사/설계 요청은 걸리지 않아야 한다. */
  intentCoding: boolean;

  // Model + env
  modelFamily?: ModelFamily;
  modelTier?: SkillTier;
  paidKeyGrok: boolean;
  paidCliFirecrawl: boolean;

  // Terminal session registry (P15)
  /** True when any session is foreground OR background. */
  hasActivePtyModal: boolean;
  /** Count of backgrounded sessions — informs Focus boost. */
  backgroundedPtyCount: number;
  /** Kind of the current foreground session (if any) — flags
   *  gate rules to be conservative with destructive tools when a
   *  coding-agent session is driving. */
  foregroundSessionKind?: 'shell' | 'coding-agent';
  /** Any session has attentionLevel >= 2 — boosts observe. */
  hasSessionAttention: boolean;

  /** sha1 prefix of the above — stable across calls when nothing
   *  changed; used by the gate as a cache key. */
  fingerprint: string;
}

/** Terminal-session facts passed in from the host. Kept out of the
 *  main SignalContext so headless callers (tests, non-dashboard
 *  entry points) can skip it cleanly. */
export interface TerminalSessionSignals {
  hasActiveModal: boolean;
  backgroundedCount: number;
  foregroundKind?: 'shell' | 'coding-agent';
  hasAttention: boolean;
}

export interface SignalContext {
  /** Current working directory. Defaults to getSessionCwd() (WD7). */
  cwd?: string;
  /** The active user turn's text (for intent matching). */
  recentUserText?: string;
  /** Recent tool results. Looked at for error patterns. */
  recentToolResults?: Array<{ tool: string; text: string; isError?: boolean }>;
  /** Active model family + tier (from the chat state). */
  modelFamily?: ModelFamily;
  modelTier?: SkillTier;
  /** Terminal session facts (P15). Host collects + passes. */
  terminal?: TerminalSessionSignals;
}

/** Regex for "the last request failed on the network" heuristic.
 *  Kept conservative so we don't boost api_call on every 404 — only
 *  on transport-layer failures. */
const NETWORK_ERROR_RE = /\b(ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|network (is )?unreachable|ssl handshake|certificate (has )?expired|fetch failed)\b/i;

// Split by script: ASCII uses \b boundaries to avoid mid-word hits
// ("chartered", "researching the"). Korean words skip \b — in a non-u
// regex, \b never sees Hangul as \w so boundary matches never fire
// against CJK. Accept bare-substring match for Korean; the false
// positive rate is fine because these signals only nudge a boost.
const RESEARCH_ASCII_RE = /\b(research|find out|look up|investigate|latest (on|news)|what (are|is|does))\b/i;
const RESEARCH_KO_RE = /(최신|뉴스|찾아(?:줘|봐)|알아봐|조사|리서치)/;
const RESEARCH_SKILL_RE = /\b(?:omni[ -]market|omni[ -]crawl|social[ -]pulse)\b/i;
const RESEARCH_EXPLANATION_RE = /(?:왜|이유|원인|전망|분석|비교|조사|\bwhy\b|\bcause\b|\boutlook\b|\banalysis\b|\bcompare\b)/i;
const RESEARCH_TOPIC_RE = /(?:금리|채권|시장|경제|물가|환율|주가|기업|산업|정책|선거|역사|기후|질병|의학|과학|\bbond\b|\byield\b|\bmarket\b|\beconomy\b|\binflation\b|\bstock\b|\bpolicy\b|\belection\b|\bhistory\b|\bclimate\b|\bhealth\b|\bscience\b)/i;
const RESEARCH_CODING_RE = /(?:코드|함수|버그|테스트|빌드|커밋|하니스|설정|오류|구현|수리|고쳐|수정|저장소|\brepo\b|\bcode\b|\bfunction\b|\bbug\b|\btest\b|\bbuild\b|\bcommit\b|\bconfig\b|\bimplement\b|\bfix\b)/i;
const DEEP_RESEARCH_INTENT_TERMS = [
  'research', 'deep research', 'triangulate', 'compare sources',
  'multiple sources', 'community reaction', 'reddit reaction',
  'x reaction', 'trend', 'sentiment', '여러 소스', '깊게 조사',
  '리서치', '반응', '트렌드', '여론', '비교 조사', '교차검증',
] as const;

function hasResearchTurnIntent(text: string | undefined): boolean {
  if (!text) return false;
  if (matchesIntent(text, RESEARCH_ASCII_RE, RESEARCH_KO_RE)) return true;
  return isResearchAgentIntent(text);
}

/** Shared research/agent verdict for surface routing and the tool catalog.
 *  Keep the historical deep-research words before the new coding veto so
 *  existing explicit surface choices retain their meaning. */
export function isResearchAgentIntent(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (DEEP_RESEARCH_INTENT_TERMS.some((term) => lower.includes(term))) return true;
  if (RESEARCH_CODING_RE.test(text)) return false;
  return RESEARCH_SKILL_RE.test(text)
    || (RESEARCH_EXPLANATION_RE.test(text) && RESEARCH_TOPIC_RE.test(text));
}
const DIAGRAM_ASCII_RE = /\b(diagrams?|flowcharts?|sequence|mermaid|graphs?|charts?|visuali[sz]e|architecture)\b/i;
const DIAGRAM_KO_RE = /(시퀀스|플로우|다이어그램|도식|그래프|시각화|아키텍처|구조도)/;

// Arc H — intent scope regex. Conservative ASCII \b boundaries + bare
// Korean substring match (same rule as RESEARCH/DIAGRAM above). Each
// scope flips its boolean in the SignalSnapshot; the gate unions those
// with the always-on `'coding'` scope.
const BROWSE_ASCII_RE = /\b(browser|browse|navigate|omni[-_]?search|youtube|fetch url|open url|https?:\/\/)\b/i;
const BROWSE_KO_RE = /(브라우저|웹페이지|유튜브|방문해|크롤|크롤링|페이지 열어)/;
const VIZ_ASCII_RE = /\b(mermaid|charts?|plots?|graphs?|visuali[sz]e|market|quotes?|ticker|stock price)\b/i;
const VIZ_KO_RE = /(다이어그램|차트|그래프|시세|시각화|머메이드|주가)/;
const CAPTURE_ASCII_RE = /\b(screenshots?|captures?|capture this|paste image|pty snapshot|snapshot pane)\b/i;
const CAPTURE_KO_RE = /(스크린샷|스크린 ?샷|캡처|캡쳐|화면 ?(저장|찍|캡)|pty ?스냅)/;
// Arc H follow-up — ops scope split. fleet = remote/management axis;
// ui = local dashboard surface axis. The two can both activate on the
// same turn ("dashboard + phone notify"); gate unions both with coding.
const OPS_FLEET_ASCII_RE = /\b(iphone|ipad|hitl|budgets?|policy|policies|llm (node|fleet)|fleet|acp[ _-]session|announce|agent room|agent handoff|team (create|delete)|send message|notify (me|phone))\b/i;
const OPS_FLEET_KO_RE = /(아이폰|아이패드|예산|정책|함대|알림 ?보내|폰으로|휴대폰|팀 ?생성|팀 ?삭제)/;
const OPS_UI_ASCII_RE = /\b(windows?|panes?|splits?|dashboards?|terminal (matrix|modal|channel|pipe)|layout preset|virtual windows?|vw_|scenarios?|input mode|input binding|widgets?|context (panes?|windows?|tools|widgets|workspace))\b/i;
const OPS_UI_KO_RE = /(창|패널|분할|대시보드|터미널 ?매트릭스|터미널 ?모달|레이아웃|가상 ?창|버추얼 ?윈도우|시나리오|위젯|컨텍스트)/;

// ⭐ 실행/변경 의도 — `'coding'` 스코프의 웜-preload 스위치(2026-07-27).
//
// 발단(실측): 자연어를 데몬에 던졌더니 `deferred:[SelfImplement,RunDevHarness,SolveMission]
// · unhydratable:[] · warmPreloaded:0` 이 나왔다. 태그(`intentScope:'coding'`)는 붙어
// 있는데 **그걸 켜 줄 신호가 없어** 배틀쉽이 영원히 name-only 로 남았고, 에이전트는
// 조사만 하다 "도구 한도" 라며 끝냈다(툴 14개 중 ToolSearch·SelfImplement 0건).
//
// ⚠️ 어휘 선정 원칙 — **동사가 있어야 한다.** 코드 명사(버그·함수·리팩토링)만으로는
//    안 걸리게 해서 조사·설계 대화가 8개 스키마를 끌고 오지 않게 한다.
//    ASCII 는 \b 경계와 목적어를, 한글은 어간 뒤 실행 어미를 요구한다.
const CODING_ASCII_RE = /(?:^|[.!?]\s*)(?:(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:(?:implement|reimplement|fix|patch|refactor|merge|reproduce|repro)\s+\S+|run (?:the )?tests?|open a pr|(?:use|create|open|enter) (?:a )?worktree|self[- ]?(?:build|implement|dev)|dogfood))/i;
// ⚠️ 의문 어미는 실행 의도가 아니다(2026-07-27 2라운드) — `했(?:다|어|…)?` 의 선택적 그룹이
//    `했` 단독을 허용해 "수정**했나요**?"·"구현**했나요**?" 가, `해(?:줘|…)?` 가 `해` 단독을
//    허용해 "수정**해야 할까요**?" 가 걸렸다. 어간 상태를 **묻는** 문장이지 시키는 문장이 아니다.
//    ⇒ 어미 바로 뒤에 의문 형태소가 붙으면 부정선읽기로 뺀다.
//    ⚠️ **문장 어디든 `?` 가 있으면 취소**하는 방식은 쓰지 않는다 — "수정해줘 그리고 결과를
//       알려줄래?" 처럼 명시적 실행 요청까지 죽는다(2라운드가 그 함정에 빠져 수렴 실패했다).
//       취소는 **어미에 직접 붙은 의문**만 본다.
//    ⚠️ 형태소를 넉넉히 나열한다 — 3차 리뷰가 `수정했**을까요**?` 를 짚었고, 일반화해 재보니
//       `습니까`·`던가`·`해**도 될까요**` 도 같이 샜다. 하나씩 좇지 말고 종결 어미군으로 잡는다.
//    ⚠️ 그리고 이 취소는 **모든 분기**에 걸어야 한다 — 4차 리뷰가 짚었듯 한 분기(어간+어미)에만
//       걸었더니 "해결해**야 할까요**?"·"테스트 실행**했나요**?"·"머지해**도 될까요**?" 가 샜다.
//    ⚠️⚠️ **부정선읽기(`(?!…)`)로는 이걸 못 막는다** — 5차 리뷰가 잡았다. "수정해**요**?" 는
//       `수정해요` 로 매치했다가 선읽기에 막히면 정규식이 `요` 를 **되뱉고**(백트래킹)
//       `수정해` 로 다시 매치해 통과한다. 선읽기는 "이 경로만" 막을 뿐 대안 경로를 못 막는다.
//       ⇒ 선읽기를 버리고 **2단**으로 간다 — ①동사군을 탐욕적으로 매치하고 ②매치 뒤 꼬리를
//         **JS 로** 따로 본다. 정규식 하나에 두 판단을 태우지 않으니 백트래킹이 개입할 수 없다
//         (`resolveAutoReview` 가 이미 같은 형태다 · 재발명 0).
//    ⊕ 6차 리뷰: **명사화 질문**도 꼬리다 — "테스트를 실행**하는 방법이 뭐예요**?" 는 동사군이
//      걸리지만 실행 요청이 아니라 *방법을 묻는* 문장이다. `…하는/한/할 + 방법·절차·이유…` 가
//      오면 그 매치는 실행이 아니다. (다중 매치 구조라 같은 문장에 진짜 실행 매치가 따로 있으면
//      그쪽이 살아남는다 — 예: "수정하는 방법대로 고쳐줘" 의 `고쳐`.)
const KO_INTERROGATIVE_TAIL_RE = /^\s*(?:(?:했|해|하)?\s*(?:나요|나\?|니\?|냐|는가|은가|까요|을까|ㄹ까|습니까|던가|지\?|죠\?|요\?|\?|야\s*(?:할|하|되)|도\s*(?:될|되)|[이가]\s*(?:뭐|무엇|어떤))|(?:하는|한|할|되는|된)\s*(?:방법|방식|법|절차|과정|이유|원리|의미))/;
// ⚠️ 목적격 조사를 허용한다 — 4차 리뷰: "테스트**를** 돌려줘" 가 안 걸렸다(`테스트 ?(돌려|실행)`).
const CODING_KO_VERBS = String.raw`(?:구현|재현|수리|수정)(?:해(?:줘|봐|요|라)?|하(?:여|자|라|였)|했(?:다|어|어요|습니다)?)`
  + String.raw`|고쳐|해결해|만들어|자율로|셀프 ?(?:빌드|구현|개발)|워크트리[를을]? ?(?:떠|만들|열|들어가)`
  + String.raw`|테스트[를을]? ?(?:돌려|실행)|머지해|pr[를을]? ?(?:열어|올려)`;
const CODING_KO_RE = new RegExp(`(?:${CODING_KO_VERBS})`, 'gi');   // ⚠️ i — "PR 올려줘" 처럼 대문자로 쓴다

/** 한국어 실행 의도 — 동사군 매치 하나라도 **꼬리가 의문형이 아니면** 실행 의도다.
 *  (매치가 여럿일 수 있다: "수정해줘 그리고 재현했나요?" → 앞 매치가 실행이므로 true) */
function koCodingIntent(text: string): boolean {
  // ⚠️ 방어적 초기화 — **지금은 load-bearing 이 아니다.** `matchAll` 은 정규식을 복제해 돌므로
  //    이 `/g` 의 `lastIndex` 는 여기서 진행되지 않는다(빼도 테스트가 안 깨지는 걸 확인했다).
  //    남겨두는 이유는 나중에 누가 이 상수에 `.test()`/`.exec()` 를 붙이면 그 순간부터
  //    호출 순서에 답이 의존하기 때문이다. 없어도 되는 줄이라고 오해하지 말라는 뜻으로 적어 둔다.
  CODING_KO_RE.lastIndex = 0;
  for (const m of text.matchAll(CODING_KO_RE)) {
    if (!KO_INTERROGATIVE_TAIL_RE.test(text.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

function matchesIntent(text: string | undefined, ascii: RegExp, ko: RegExp): boolean {
  if (!text) return false;
  return ascii.test(text) || ko.test(text);
}

function hasPaidCliFirecrawl(): boolean {
  try {
    return getFirecrawlConfig().apiKey.length > 0;
  } catch {
    return false;
  }
}

export function collectSignals(ctx: SignalContext = {}): SignalSnapshot {
  // WD7 — signal detection (python / node / git) reads from the
  // session working directory so tool hints follow the active project.
  const cwd = ctx.cwd ?? getSessionCwd();

  const snapshot: SignalSnapshot = {
    hasPython: detectPython(cwd),
    hasNodeProject: existsSync(joinPath(cwd, 'package.json')),
    hasGitRemote: detectGitRemote(cwd),

    intentResearch: hasResearchTurnIntent(ctx.recentUserText),
    researchAgent: isResearchAgentIntent(ctx.recentUserText),
    intentDiagram: matchesIntent(ctx.recentUserText, DIAGRAM_ASCII_RE, DIAGRAM_KO_RE),
    recentNetworkError: hasRecentNetworkError(ctx.recentToolResults),

    intentBrowse: matchesIntent(ctx.recentUserText, BROWSE_ASCII_RE, BROWSE_KO_RE),
    // ⚠️ 한국어는 `matchesIntent` 의 단순 test 로 못 한다 — 꼬리 판정이 2단이다(위 주석).
    intentCoding: !!ctx.recentUserText
      && (CODING_ASCII_RE.test(ctx.recentUserText) || koCodingIntent(ctx.recentUserText)),
    intentViz: matchesIntent(ctx.recentUserText, VIZ_ASCII_RE, VIZ_KO_RE),
    intentCapture: matchesIntent(ctx.recentUserText, CAPTURE_ASCII_RE, CAPTURE_KO_RE),
    intentOpsFleet: matchesIntent(ctx.recentUserText, OPS_FLEET_ASCII_RE, OPS_FLEET_KO_RE),
    intentOpsUi: matchesIntent(ctx.recentUserText, OPS_UI_ASCII_RE, OPS_UI_KO_RE),

    modelFamily: ctx.modelFamily,
    modelTier: ctx.modelTier,
    paidKeyGrok: !!(process.env.XAI_API_KEY && process.env.XAI_API_KEY.trim()),
    paidCliFirecrawl: hasPaidCliFirecrawl(),

    hasActivePtyModal: ctx.terminal?.hasActiveModal ?? false,
    backgroundedPtyCount: ctx.terminal?.backgroundedCount ?? 0,
    foregroundSessionKind: ctx.terminal?.foregroundKind,
    hasSessionAttention: ctx.terminal?.hasAttention ?? false,

    fingerprint: '', // filled below
  };
  snapshot.fingerprint = fingerprintOf(snapshot);
  return snapshot;
}

function detectPython(cwd: string): boolean {
  // Check marker files rather than scanning for *.py — avoids an
  // O(repo) walk on every turn. False negatives for repos that use
  // plain .py without tooling config are acceptable; gate rules
  // target projects with Python infrastructure.
  return existsSync(joinPath(cwd, 'pyproject.toml'))
      || existsSync(joinPath(cwd, 'setup.py'))
      || existsSync(joinPath(cwd, 'requirements.txt'))
      || existsSync(joinPath(cwd, 'Pipfile'))
      || existsSync(joinPath(cwd, 'poetry.lock'));
}

function detectGitRemote(cwd: string): boolean {
  const gitConfig = joinPath(cwd, '.git', 'config');
  if (!existsSync(gitConfig)) return false;
  try {
    const raw = readFileSync(gitConfig, 'utf-8');
    return /\[remote "/.test(raw);
  } catch {
    return false;
  }
}

function hasRecentNetworkError(
  results: Array<{ tool: string; text: string; isError?: boolean }> | undefined,
): boolean {
  if (!results || results.length === 0) return false;
  // Only the last 5 results matter; the user has moved on past
  // anything older.
  const tail = results.slice(-5);
  for (const r of tail) {
    if (NETWORK_ERROR_RE.test(r.text)) return true;
  }
  return false;
}

function fingerprintOf(s: SignalSnapshot): string {
  const pieces = [
    s.hasPython ? 'py' : '-',
    s.hasNodeProject ? 'node' : '-',
    s.hasGitRemote ? 'git' : '-',
    s.intentResearch ? 'research' : '-',
    s.researchAgent ? 'research-agent' : '-',
    s.intentDiagram ? 'diagram' : '-',
    s.recentNetworkError ? 'neterr' : '-',
    s.modelFamily ?? '-',
    s.modelTier ?? '-',
    s.paidKeyGrok ? 'grok' : '-',
    s.paidCliFirecrawl ? 'fc' : '-',
    s.hasActivePtyModal ? 'pty' : '-',
    s.backgroundedPtyCount > 0 ? `bg${Math.min(s.backgroundedPtyCount, 8)}` : '-',
    s.foregroundSessionKind ?? '-',
    s.hasSessionAttention ? 'attn' : '-',
    s.intentBrowse ? 'browse' : '-',
    s.intentViz ? 'viz' : '-',
    s.intentCapture ? 'capture' : '-',
    s.intentOpsFleet ? 'ops-fleet' : '-',
    s.intentOpsUi ? 'ops-ui' : '-',
  ].join('|');
  return createHash('sha1').update(pieces).digest('hex').slice(0, 12);
}

/** Exported for tests and /hint show debug dumps. */
export function signalsSummary(s: SignalSnapshot): string {
  const on = (k: keyof SignalSnapshot, label: string) => (s[k] ? label : null);
  const parts = [
    on('hasPython', 'python'),
    on('hasNodeProject', 'node'),
    on('hasGitRemote', 'git-remote'),
    on('intentResearch', 'intent:research'),
    on('intentDiagram', 'intent:diagram'),
    on('recentNetworkError', 'neterr'),
    on('paidKeyGrok', 'grok-key'),
    on('paidCliFirecrawl', 'firecrawl-key'),
    s.modelFamily ? `model:${s.modelFamily}` : null,
    s.modelTier ? `tier:${s.modelTier}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? '(no signals)' : parts.join(' ');
}
