import { CdpUnavailable, createCdpClientFromEndpoint, type CdpClient, type CdpNavigationResult } from '../browser-cdp/client.js';
import { saveAttachmentBlob, type SaveAttachmentResult } from '../boot/attachment-store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { debug } from '../debug/log.js';
import { getHarnessRunId } from './harness-space.js';
import { pageTargetIds, planTabReclaim } from './browser-act-tabs.js';
import { captureWithTimeout, describeCaptureFailure, DEFAULT_CAPTURE_TIMEOUT_MS } from './browser-capture-timeout.js';
import { assessLanding } from './browser-act-landing.js';
import { decideActionBoundary } from './browser-act-boundary.js';
// ⛔ 카테고리·이벤트를 «박지 않는다» — 그 상수는 이 어긋남을 막으려고 만든 것인데 아무도 안 썼다(2026-08-28).
import { BROWSER_ACT_CATEGORY, BROWSER_ACT_EVENT } from './browser-act-step.js';
import { CLICK_KIND_EXPRESSION, decideReversibility, type ClickKind, type ReversibilityPolicy } from './browser-act-reversibility.js';
import type { PersonaProfile } from '../persona/types.js';

/**
 * 조작이 «그 자리에서» 관측한 사실.
 *
 * ⛔⭐⭐ ***왜 결과에 싣나***: 재현(`harness replay`)이 「지금」을 만들 때
 *    `elanous logs` 를 다시 spawn 해서 «가장 최근 행»을 집었다 — 즉 ***시간 근접으로 조인***했다.
 *    ⚠️ 그것은 조인이 아니다: 같은 창에 다른 봇(또는 카나리아 4대)이 조작하면 «남의 행»을 집는다
 *    (`personaId` 가 null 이면 «아무 필터도 없다»). 400ms 잠은 조인이 아니라 «희망»이었다.
 *  ⇒ 🔑 그러니 조작이 «자기가 본 것»을 직접 돌려준다 — 그러면 조인은 «신원»이다.
 */
export interface BrowserActionObserved {
  coordinates: BrowserActionCoordinates | null;
  captureOutcome: BrowserActionCaptureOutcome;
  /** 「가려던 곳」 — 누르기 «전»에 읽은 `<a href>` 의 절대 URL. 이동이 아니거나 못 쟀으면 null. */
  clickedHref?: string | null;
  /** 「실제로 간 곳」 — 이동 «뒤»의 `location.href`. ⚠️ 위와 다를 수 있다(리다이렉트 등). */
  landedUrl?: string | null;
  /** 그 둘을 견준 «판정». ⛔ 「다르다」가 아니라 «얼마나 갈렸나»다 — {@link assessLanding}. */
  landingVerdict?: string;
}

export type BrowserActionResult =
  | { ok: true; url: string; target: string; observed?: BrowserActionObserved }
  | { ok: false; url: string; target: string; reason: 'unarmed' | 'load-unavailable' | 'load-timeout' | 'session-unavailable' | 'execution-failed'; error?: string };

function isBrowserSessionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof CdpUnavailable || ['AsideSessionUnavailableError', 'BrowserSessionUnavailableError'].includes(error.name)) return true;
  return /^aside\s+session\b[\s\S]{0,40}\b(?:unavailable|blocked|disconnected|closed|refused|timed?\s*out)\b/i.test(error.message);
}

/**
 * 🔬⭐⭐⭐ **누가 이 조작을 했나** — ⛔ `probe` 가 2026-08-30(37차)에 «네 번째»로 붙었다.
 *
 * 🚨 왜 필요했나 — ***카나리아의 살아있음 탐침이 봇으로 «행세»하고 있었다***:
 * ```
 * 📏 실측 2026-08-30   관측 11행 전부  kind=bot · persona=<봇> · entryPoint=src/index.ts:harness browser-act
 *                      ⇒ 탐침과 «그 봇의 진짜 조작»이 ***한 글자도 안 다르다***
 * 📏 그 결과            newsbot 궤적 104걸음 중 ***87이 탐침***(84%) — 봇의 진짜 조작은 17
 *                      ⇒ 「재현할 수 있다」가 실은 ***「탐침을 재현할 수 있다」***였다
 * ```
 * 🪞 36차가 이 자리에서 «세 번» 반증됐다(RFC §23b-4) — `browserActions:'none'` · 탐침 예외 플래그 ·
 *    「무해한 한 곳만 선언」. 셋 다 ***같은 곳에서 죽었다: 탐침이 그 봇으로 행세한다.***
 * ⇒ 🔑 그래서 고치는 것은 «경계»가 아니라 ***「누가」***다.
 *
 * ⛔⭐ **`probe` 는 «면제»가 아니다** — 경계(actionHosts)는 ***그대로 적용된다***.
 *    36차가 「탐침을 예외로」를 명시로 기각했다(*그 플래그가 그대로 우회로다*). 여기서 바뀌는 것은
 *    ***귀속 하나뿐***이고, 그 덕에 판정기들이 「봇의 것」과 「내 탐침」을 «가를 수 있게» 된다.
 */
export type BrowserActionAttributionKind = 'run' | 'bot' | 'probe' | 'entry-point';

export interface BrowserActionAttribution {
  kind: BrowserActionAttributionKind;
  entryPoint: string;
}

export interface BrowserActionRequest {
  url: string;
  target: string;
  armed: boolean;
  /** Profile selected by the existing persona lookup caller. */
  persona?: PersonaProfile;
  /**
   * 🔬 **이 조작은 «살아있음 탐침»이다** — 봇의 «자기 행동»이 아니다.
   * ⛔ 경계를 «넓히지 않는다»(그러면 우회로다). 바뀌는 것은 ***관측의 귀속*** 하나뿐이다.
   */
  probe?: boolean;
  /** Named caller used when neither a harness run nor persona owns the action. */
  entryPoint?: string;
}

export interface BrowserActionCoordinates {
  x: number;
  y: number;
}

export interface BrowserActionDeps {
  connect?: (port?: number) => Promise<CdpClient>;
  port?: number;
  execute?: (client: CdpClient, target: string) => Promise<BrowserActionCoordinates>;
  loadWaitTimeoutMs?: number;
  saveAttachment?: (blob: Blob, filename: string) => Promise<SaveAttachmentResult>;
  observe?: (event: string, data: Record<string, unknown>) => void;
  /** 관측 캡처의 시한(ms). 기본 5,000. ⛔ 0 이하는 「시한 없음」이 아니라 «즉시 timeout» 이다. */
  captureTimeoutMs?: number;
  /**
   * 조작 «뒤» 화면을 이 경로에도 쓴다(png).
   *
   * ⛔ 첨부 저장소는 `/tmp` 에 산다 — macOS 가 그것을 «지운다».
   *    ⇒ 무인 루틴의 증거가 «며칠 뒤 사라진다». 그래서 「남길 자리」를 부르는 쪽이 정하게 한다.
   * ⛔ 실패해도 조작을 «막지 않는다» — 다만 «조용하지도 않다»(관측에 shotError 로 남는다).
   */
  shotPath?: string;
  /**
   * 클릭이 «연» 새 탭을 회수할지. 기본 true.
   * ⛔ `false` 는 「누수를 허용한다」가 아니라 ***「이 실행에선 CDP HTTP 를 안 부른다」***는 뜻이다
   *    (시험·격리 실행이 그 왕복을 원치 않을 때).
   */
  reclaimOpenedTabs?: boolean;
  /**
   * ⚖️ 누를 수 있는 «종류». 기본 `navigation-only`.
   * ⛔ `any` 는 「안전을 끈다」가 아니라 ***「사람이 그 한 번을 명시로 열었다」***는 뜻이다.
   *    ⛔ 무인 루틴은 이것을 쓰면 «안 된다» — 되돌리기가 «없기» 때문이다.
   */
  reversibilityPolicy?: ReversibilityPolicy;
  getRunId?: () => string | null;
}

const DEFAULT_LOAD_WAIT_TIMEOUT_MS = 3_000;

type LoadWaitOutcome = 'event' | 'timeout' | 'unavailable';

interface CdpLoadWait {
  waitFor(navigation: CdpNavigationResult): Promise<LoadWaitOutcome>;
  dispose(): void;
}

function createCdpLoadWait(client: CdpClient, timeoutMs: number): CdpLoadWait | undefined {
  if (!client.on) return undefined;

  let expected: Pick<CdpNavigationResult, 'frameId' | 'loaderId'> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveOutcome: ((outcome: LoadWaitOutcome) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  const bufferedEvents: Array<Record<string, unknown>> = [];

  const isExpectedLoad = (params: Record<string, unknown>): boolean =>
    params.name === 'load' && params.frameId === expected?.frameId && params.loaderId === expected?.loaderId;
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    try { unsubscribe?.(); } catch { /* optional event cleanup is fail-soft */ }
    unsubscribe = undefined;
  };
  const settle = (outcome: LoadWaitOutcome) => {
    if (settled) return;
    settled = true;
    dispose();
    resolveOutcome?.(outcome);
  };
  const receive = (params: Record<string, unknown>) => {
    if (!expected) {
      bufferedEvents.push(params);
      return;
    }
    if (isExpectedLoad(params)) settle('event');
  };

  try {
    unsubscribe = client.on('Page.lifecycleEvent', (event) => receive(event.params));
  } catch {
    dispose();
    return undefined;
  }

  return {
    async waitFor(navigation) {
      if (!navigation.loaderId) {
        dispose();
        return 'unavailable';
      }
      expected = { frameId: navigation.frameId, loaderId: navigation.loaderId };
      if (bufferedEvents.some(isExpectedLoad)) {
        settled = true;
        dispose();
        return 'event';
      }
      return new Promise<LoadWaitOutcome>((resolve) => {
        resolveOutcome = resolve;
        timer = setTimeout(() => settle('timeout'), timeoutMs);
      });
    },
    dispose,
  };
}

function clickExpression(target: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(target)});
    if (!element) throw new Error('browser action target not found: ' + ${JSON.stringify(target)});
    if (!(element instanceof HTMLElement)) throw new Error('browser action target is not an HTMLElement: ' + ${JSON.stringify(target)});
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('browser action target has no clickable area: ' + ${JSON.stringify(target)});
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) throw new Error('browser action target is outside the viewport: ' + ${JSON.stringify(target)});
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) throw new Error('browser action target is obscured: ' + ${JSON.stringify(target)});
    // ⚖️ 되돌릴 수 없는 클릭을 «구조로» 가른다 — ⛔ 별도 CDP 왕복을 «안 만든다».
    const kind = ${CLICK_KIND_EXPRESSION};
    // ⛔⭐⭐ ***「어디로 가는가」를 같이 가져온다*** — 이 축은 «되돌릴 수 없는» 조작이고,
    //    되돌릴 수 없는 것의 최소 요건은 ***「어디로 갔는지 안다」***이다.
    //    📏 2026-08-28 전수: 관측 행의 목적지류 키가 target(선택자)·url(출발지) 둘뿐이었다 —
    //       봇이 클릭한 «뒤 어디에 있는지»를 아무도 몰랐다.
    //    ⚠️ 이 주석은 템플릿 리터럴 «안»이다 — 백틱을 쓰면 문자열이 끊긴다(한 번 밟았다).
    //    ⭐ 여기서 얻는 것은 «공짜»다 — 분류기가 이미 href 를 읽는다(추가 왕복 0).
    const href = (element instanceof HTMLAnchorElement && element.getAttribute('href') !== null)
      ? element.href           // ⇐ 절대 URL 로 해석된 것(상대 경로를 그대로 남기면 나중에 못 푼다)
      : null;
    // ⛔ 사람이 「무엇을 눌렀나」를 읽을 수 있게 «보이는 글»도 짧게 남긴다(선택자만으론 못 읽는다).
    const text = (element.innerText || element.textContent || '').trim().slice(0, 120) || null;
    return { x, y, kind, href, text };
  })()`;
}

function parseCoordinates(value: unknown): BrowserActionCoordinates {
  if (!value || typeof value !== 'object') throw new Error('browser action did not return click coordinates');
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('browser action returned invalid click coordinates');
  }
  return { x, y };
}

/** 클릭이 «무엇을» 눌렀나 — 좌표만으로는 사람도 재현도 못 읽는다. */
export interface ClickedElement {
  /** 🚧 경계 판정. ⛔ `undeclared` 가 「안전하다」가 «아니다» — 「아무도 안 정했다」다. */
  boundaryVerdict?: 'inside' | 'outside' | 'undeclared' | 'offsite-navigation';
  coordinates: BrowserActionCoordinates;
  /** `<a href>` 의 «절대» URL. 이동이 아니면 null. */
  href: string | null;
  /** 사람이 읽을 수 있는 짧은 글. 없으면 null. */
  text: string | null;
}

async function executeClick(
  client: CdpClient,
  target: string,
  policy: ReversibilityPolicy = 'navigation-only',
  /** 이 조작이 «여는» 주소 — 경계 판정에 쓴다. */
  url = '',
  /** 그 봇이 선언한 경계. ⛔ 없으면 «막지 않는다»(관측만 한다). */
  boundaryHosts?: readonly string[],
  /** 🆕 목적지를 미리 못 적는 봇이 «명시»한 값. 기본은 `blocked`(지금까지와 같다). */
  offsiteNavigation?: 'blocked' | 'allowed',
): Promise<ClickedElement> {
  const probed = await client.evaluate(clickExpression(target));
  const coordinates = parseCoordinates(probed);
  // ⚖️ ⛔ ***누르기 «전»에*** 정한다 — 누른 뒤의 판정은 판정이 아니라 «기록»이다.
  const kind = (probed as { kind?: unknown } | null)?.kind;
  const decision = decideReversibility({
    kind: typeof kind === 'string' ? (kind as ClickKind) : undefined,
    policy,
  });
  if (!decision.allowed) throw new Error(`browser action refused (${decision.kind}): ${decision.detail}`);

  // 🚧⭐ ***경계는 「되돌릴 수 없음」의 유일한 대책이다*** — 그리고 여기가 «누르기 전»이다.
  //    ⛔ 착지 뒤에 아는 것(landingVerdict)은 «경보»이지 방지가 아니다.
  const probedHref = (probed as { href?: unknown } | null)?.href;
  const boundary = decideActionBoundary({
    ...(boundaryHosts === undefined ? {} : { hosts: boundaryHosts }),
    url,
    href: typeof probedHref === 'string' && probedHref !== '' ? probedHref : null,
    // ⛔ `kind` 를 «같이» 넘긴다 — 「이동에 한해」라는 한정이 이 값 없이는 성립하지 않는다.
    ...(typeof kind === 'string' ? { kind: kind as 'navigation' | 'submit' | 'other' } : {}),
    ...(offsiteNavigation === undefined ? {} : { offsiteNavigation }),
  });
  if (!boundary.allowed) throw new Error(`browser action refused (boundary): ${boundary.detail}`);
  if (!client.click) throw new Error('browser action input dispatch is unavailable');
  await client.click(coordinates);
  const probe = probed as { href?: unknown; text?: unknown } | null;
  return {
    boundaryVerdict: boundary.verdict,
    coordinates,
    href: typeof probe?.href === 'string' && probe.href !== '' ? probe.href : null,
    text: typeof probe?.text === 'string' && probe.text !== '' ? probe.text : null,
  };
}

function attachmentFilename(): string {
  return `browser-action-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
}

/** 관측 캡처의 결말 — ⛔ `attachmentRef: null` «하나»로 뭉치면 「왜 없는지」를 영영 못 묻는다. */
export type BrowserActionCaptureOutcome =
  | 'ok'
  | 'timeout'
  | 'error'
  | 'not-saved'
  /**
   * 화면을 «안 물었다» — 실패한 조작의 관측이 이 값을 낸다(#13620).
   * ⛔ 이 칸이 유니온에 «없어서» 타입이 «거짓말»을 하고 있었다:
   *    실제 값은 나가고 있는데 타입은 「그럴 리 없다」고 말했다(2026-08-28 발견).
   * 🔑 「실패」와 «다른 값»이다 — 요구가 «없었으니» 실패도 아니다.
   */
  | 'not-requested';

/**
 * 「클릭이 이동을 «시작이라도» 했나」를 재는 창.
 *
 * 📏 실측 2026-08-28(봇 4대 · 실제 사이트): 이동하는 클릭의 첫 lifecycle 이벤트 = ***79 · 436 · 454 · 540 ms***.
 *    이동 «안» 하는 클릭 = ***이벤트 없음***.
 * ⇒ 최대 관측의 약 3배. ⚠️ 표본 4 — 이 선을 넘는 이동이 있으면 'none' 으로 오독된다.
 * ⛔ 이 값을 «늘리는» 것으로 문제를 고치지 마라 — 그러면 비이동 클릭이 다시 그만큼 느려진다.
 *    넘는 표본이 보이면 ***왜 그 이동이 느린가***를 먼저 물어라.
 */
const POST_CLICK_START_WINDOW_MS = 1_500;


function resolveBrowserActionAttribution(
  request: BrowserActionRequest,
  runId: string | null,
): BrowserActionAttribution {
  const entryPoint = request.entryPoint?.trim() || 'unknown';
  // 🔬⭐ **탐침이 «가장 먼저»다** — 「누가 했나」에 가장 구체적으로 답하는 값이기 때문이다.
  //    ⛔ 뒤에 두면 persona 가 있는 순간 다시 'bot' 으로 접혀 ***행세가 그대로 남는다***.
  if (request.probe === true) return { kind: 'probe', entryPoint };
  if (runId) return { kind: 'run', entryPoint };
  if (request.persona?.personaId) return { kind: 'bot', entryPoint };
  return { kind: 'entry-point', entryPoint };
}

/**
 * 👁️ **`timeout` 은 던진 예외가 «없다» — 그래서 「무엇이」에 답할 것이 없다.**
 *
 * ⛔ 그렇다고 이름 없이 두면 그 실패는 «셀 수만 있고 고칠 수 없다».
 * ⇒ 📌 그래서 캡처 «주위»에서 알 수 있는 것을 적는다: ***클릭 뒤에 이동이 일어났나.***
 *
 * 📏 실측 2026-08-27: 이동을 «일으키는» 클릭에서 화면 도착 11/32(34%) ↔ 이동 «없는» 클릭 16/16(100%).
 *    그리고 `error` 갈래는 스스로 이름을 냈다 — `Error: Not attached to an active page`.
 *    ⇒ `timeout` 갈래도 같은 뿌리인지 «재려면» 이 관측이 필요하다. ⚠️ 아직 «가설»이고 이것이 그 자다.
 *
 * ⛔ 추가 왕복을 «하지 않는다** — 이미 오는 이벤트를 «세기»만 한다. 물으러 가면 그 물음도 매달릴 수 있다.
 */
/** 클릭이 일으킨 이동의 load 대기 결말 — ⛔ 화면 캡처 시한(`captureOutcome`)과 «다른» 값이다. */
export type PostClickLoadWaitOutcome = 'none' | 'event' | 'timeout';

export type PostClickNavigationWatch = {
  /** 클릭 뒤 관측된 lifecycle 이벤트 이름들(중복 제거·순서 유지). */
  seen(): readonly string[];
  /**
   * 클릭이 새 문서를 열었으면 그 문서의 `load` 까지 기다린다.
   * 클릭 반환 직후 seen 이 비어도 `init` 이 곧 올 수 있다 — 이미 연 구독으로 기존 시한 안에서 판별한다.
   * 시한이 지나도 이벤트가 없으면 `'none'` (이동 없음). `init` 만 보고 `load` 가 없으면 `'timeout'`.
   * ⛔ 시한이 없으면 이 대기 하나가 조작 전체를 영원히 멎게 한다. 0 이하는 즉시 확정.
   */
  waitForLoad(timeoutMs: number): Promise<PostClickLoadWaitOutcome>;
  dispose(): void;
};

export function createPostClickNavigationWatch(
  client: CdpClient,
  /** 첫 `Page.navigate` 의 로더 식별자. ⛔ 이것과 «같은» loaderId 의 이벤트는 그 이동의 잔향이지 클릭의 결과가 아니다. */
  baselineLoaderId: string | undefined,
): PostClickNavigationWatch | undefined {
  if (!client.on) return undefined;
  const seen: string[] = [];
  let unsubscribe: (() => void) | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  /** ⛔ 「이동이 시작도 안 했나」를 재는 짧은 창의 타이머. 위 waitForLoad 의 주석이 그 근거다. */
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let loadSettled = false;
  let loadWaiters: Array<(outcome: PostClickLoadWaitOutcome) => void> = [];
  let expected: { frameId: unknown; loaderId: unknown } | undefined;
  let targetLoadSeen = false;
  const isTargetLoad = (params: Record<string, unknown>): boolean =>
    params.name === 'load'
    && expected !== undefined
    && params.frameId === expected.frameId
    && params.loaderId === expected.loaderId;
  const outcomeFromSeen = (): PostClickLoadWaitOutcome => {
    if (targetLoadSeen) return 'event';
    if (seen.length === 0) return 'none';
    return 'timeout';
  };
  const finishLoadWait = (outcome: PostClickLoadWaitOutcome) => {
    if (loadSettled) return;
    loadSettled = true;
    if (loadTimer !== undefined) clearTimeout(loadTimer);
    loadTimer = undefined;
    if (startTimer !== undefined) clearTimeout(startTimer);
    startTimer = undefined;
    const waiters = loadWaiters;
    loadWaiters = [];
    for (const waiter of waiters) waiter(outcome);
  };
  const dispose = () => {
    finishLoadWait(outcomeFromSeen());
    try { unsubscribe?.(); } catch { /* optional event cleanup is fail-soft */ }
    unsubscribe = undefined;
  };
  try {
    unsubscribe = client.on('Page.lifecycleEvent', (event) => {
      const params = event.params ?? {};
      const name = params.name;
      if (typeof name !== 'string') return;
      // ⛔ 첫 이동의 잔향을 «클릭이 일으킨 이동»으로 세지 않는다 —
      //    그러면 이동하는 클릭과 안 하는 클릭이 «같은 값»을 내고, 이 관측이 아무것도 안 가른다.
      //    📏 실측 2026-08-27: 그렇게 세니 `a`(이동)와 `h1`(비이동)의 산출이 «똑같았다».
      const loaderId = params.loaderId;
      if (baselineLoaderId !== undefined && loaderId === baselineLoaderId) return;
      if (!seen.includes(name)) seen.push(name);
      // ⛔ 아무 load 나 새 문서의 안정이 아니다 — 대상 init 의 frameId·loaderId 와 같은 load 만 완료다.
      if (name === 'init' && expected === undefined && loaderId !== undefined) {
        expected = { frameId: params.frameId, loaderId };
      }
      if (isTargetLoad(params)) {
        targetLoadSeen = true;
        finishLoadWait('event');
      }
    });
  } catch {
    dispose();
    return undefined;
  }
  return {
    seen: () => seen,
    waitForLoad(timeoutMs) {
      if (targetLoadSeen) return Promise.resolve('event');
      if (timeoutMs <= 0) return Promise.resolve(outcomeFromSeen());
      return new Promise<PostClickLoadWaitOutcome>((resolve) => {
        loadWaiters.push(resolve);
        if (targetLoadSeen) {
          finishLoadWait('event');
          return;
        }
        if (loadTimer === undefined) {
          loadTimer = setTimeout(() => finishLoadWait(outcomeFromSeen()), timeoutMs);
        }
        // ⛔⭐ **「이동이 «시작도» 안 했다」를 시한 «전체»로 기다리지 않는다.**
        //    📏 실측 2026-08-28(봇 4대): 이동하는 클릭의 «첫» lifecycle 이벤트는
        //       ***79 · 436 · 454 · 540 ms*** 에 왔다(최대 540 · n=4).
        //       이동 «안» 하는 클릭은 ***이벤트가 아예 «없었다»***.
        //    ⇒ 🔑 그러므로 짧은 창 안에 «아무 일도» 없으면 그것은 「기다릴 것이 없다」다.
        //    ⚠️ 표본이 4다 — 그 선을 넘은 것은 «0/4» 이지만 «작다». 넘으면 어떻게 되나:
        //       느린 이동이 'none' 으로 읽히고 캡처가 이동 «한가운데»에서 나간다(옛 34% 로 되돌아간다).
        //    ⇒ 그래서 최대 관측(540ms)의 «약 3배»를 두고, 부르는 쪽이 바꿀 수 있게 남긴다.
        if (startTimer === undefined) {
          const startWindow = Math.min(POST_CLICK_START_WINDOW_MS, timeoutMs);
          startTimer = setTimeout(() => {
            // 아무 lifecycle 도 «못 봤으면» 이동이 없었던 것이다.
            if (seen.length === 0) finishLoadWait('none');
          }, startWindow);
        }
      });
    },
    dispose,
  };
}

/** ⛔ 「이동했다」와 「이동을 못 쟀다」를 다른 값으로 낸다 — 뭉치면 「이동 안 함」으로 «읽힌다». */
export function describePostClickNavigation(watch: PostClickNavigationWatch | undefined): string | null {
  if (!watch) return null;
  const seen = watch.seen();
  if (seen.length === 0) return 'none';
  return seen.join(',');
}

async function observeBrowserAction(
  client: CdpClient,
  request: BrowserActionRequest,
  clicked: ClickedElement,
  deps: BrowserActionDeps,
  navigationWatch: PostClickNavigationWatch | undefined,
  postClickLoadWait: PostClickLoadWaitOutcome | null,
  tabs?: { planned: number; reclaimed: number; detail: string },
): Promise<BrowserActionObserved> {
  let attachmentRef: string | null = null;
  let captureOutcome: BrowserActionCaptureOutcome = 'error';
  // ⛔ 실패는 «자기 이름을 대야» 한다 — 라벨만 내면 그 실패는 셀 수만 있고 고칠 수 없다.
  let captureError: string | null = null;
  // ⛔ 「썼다」와 「못 썼다」를 다른 값으로 — 뭉치면 증거 없음이 «조용해진다».
  let shotSavedTo: string | null = null;
  let shotError: string | null = null;
  const { coordinates, href: clickedHref, text: clickedText } = clicked;
  // ⛔⭐ 「실제로 간 곳」은 이동 «뒤»에만 잴 수 있다 — 그래서 load 대기 «다음»인 여기서 읽는다.
  //    ⚠️ 실패해도 조작 판정을 바꾸지 않는다(fail-soft) — 「못 쟀다」는 null 이다.
  const landedUrl = await client.evaluate('location.href')
    .then((v) => (typeof v === 'string' && v !== '' ? v.slice(0, 500) : null))
    .catch(() => null);
  // ⛔⭐ 출발지를 «같이» 넘긴다 — 그래야 「이 페이지가 안 움직였다」를 리다이렉트와 가를 수 있다.
  //    📏 VM 실물(2026-08-28): target="_blank" 클릭이 landedUrl=출발지인데 `same-host` 로 읽혔다.
  const landing = assessLanding(clickedHref, landedUrl, request.url);
  const captureTimeoutMs = deps.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const captured = await captureWithTimeout(client, captureTimeoutMs);
  if ('stalled' in captured) {
    captureOutcome = 'timeout';
  } else if ('failed' in captured) {
    captureOutcome = 'error';
    captureError = captured.reason;
  } else {
    try {
      const saved = await (deps.saveAttachment ?? ((blob, filename) => saveAttachmentBlob({ blob, filename })))(
        new Blob([new Uint8Array(captured.png)], { type: 'image/png' }),
        attachmentFilename(),
      );
      if (saved.ok) { attachmentRef = saved.entry.path; captureOutcome = 'ok'; }
      else { captureOutcome = 'not-saved'; captureError = describeCaptureFailure(saved.reason ?? 'attachment save returned ok=false without a reason'); }
      // ⛔ 부르는 쪽이 「남길 자리」를 줬으면 «거기에도» 쓴다 — 첨부 저장소는 /tmp 라 사라진다.
      if (deps.shotPath) {
        try {
          mkdirSync(dirname(deps.shotPath), { recursive: true });
          writeFileSync(deps.shotPath, captured.png);
          shotSavedTo = deps.shotPath;
        } catch (error) { shotError = describeCaptureFailure(error); }
      }
    } catch (error) { captureOutcome = 'error'; captureError = describeCaptureFailure(error); }
  }

  try {
    const runId = deps.getRunId ? deps.getRunId() : getHarnessRunId() || null;
    (deps.observe ?? ((event, data) => debug.log(BROWSER_ACT_CATEGORY, event, data)))(BROWSER_ACT_EVENT, {
      url: request.url,
      target: request.target,
      coordinates,
      attachmentRef,
      // ⛔⭐⭐ 성공 행도 `ok` 를 «싣는다» — 실패 쪽 주석이 *"소비자가 한 질의로 둘을 다 세게. 대신 `ok` 로 가른다"*
      //    라고 «약속»해 놓고 성공 쪽에 이 키가 «없었다»(2026-08-28 전수: 성공 48행에 ok 키 0개 · 실패 5행에만 있었다).
      //    🚨 그 비대칭의 «실제 피해»: 실패 행은 `captureOutcome: 'not-requested'` 를 내는데,
      //       카나리아의 눈이 그것을 ***「화면을 «안 물었다» — 실패가 아니다」***로 읽었다.
      ok: true,
      // ⛔ 「화면 참조가 없다」와 「왜 없는지」는 다른 값이다 — 뭉치면 매달림이 «조용해진다»
      captureOutcome,
      // ⛔ 그리고 「왜 없는지」는 «라벨»이 아니라 «문면»이다. 라벨만 내면 이 주석이 스스로를 어긴다.
      //    timeout 은 「무엇이」가 없다 — 대신 ***얼마를 기다렸나***가 그 답이다.
      captureError,
      captureTimeoutMs: captureOutcome === 'ok' ? null : captureTimeoutMs,
      // ⛔ timeout 은 예외가 «없어서» captureError 가 비는데, 그때 남는 유일한 단서가 이것이다.
      //    'none' = 이동 이벤트를 «못 봤다» · null = «잴 수 없었다»(구독 자체가 불가) — 둘은 다른 값이다.
      postClickLifecycle: describePostClickNavigation(navigationWatch),
      // ⛔⭐⭐ ***되돌릴 수 없는 조작의 최소 요건은 「어디로 갔는지 안다」다.***
      //    clickedHref = 「가려던 곳」(누르기 «전»에 읽은 것) · landedUrl = 「실제로 간 곳」(이동 «뒤»)
      //    ⚠️ 둘은 다를 수 있다(리다이렉트·해시·쿼리 변형) — 그래서 «두 값»으로 둔다.
      //    ⛔ null 은 「없다」가 아니라 「못 쟀다」일 수 있다 — 심(deps.execute)으로 오면 못 잰다.
      clickedHref,
      clickedText,
      landedUrl,
      // 🚧⭐ ***「경계 없이 도는 조작이 몇 건인가」를 «세려고» 싣는다.***
      //    ⛔ 이 수를 안 세면 「경계를 조여도 되나」를 영영 못 판단한다(관측 먼저 · 그 다음 조인다).
      boundaryVerdict: clicked.boundaryVerdict ?? null,
      // ⛔⭐ 두 값을 «싣기만» 하면 아무도 안 견준다 — 견준 «판정»을 같이 남긴다.
      //    📏 2026-08-28 실측: 측정 가능한 클릭 11건 중 8건이 링크가 말한 곳과 «달랐다»
      //       (전부 www 계열 리다이렉트 · 다른 사이트로 간 것은 0건).
      //    ⇒ 그러므로 「다르다」를 빨강으로 만들면 안 된다 — 놀랄 일은 `cross-host` 뿐이다.
      landingVerdict: landing.verdict,
      landingSurprising: landing.surprising,
      // ⛔ 부르는 쪽이 준 자리에 «썼나» — 안 줬으면 둘 다 null(요구가 없었으니 실패도 아니다)
      shotSavedTo,
      shotError,
      // 🧹 ⛔ 「몇 개 열렸나」와 「몇 개 닫았나」를 다른 값으로 — 뭉치면 누수가 «조용해진다».
      tabsPlanned: tabs?.planned ?? null,
      tabsReclaimed: tabs?.reclaimed ?? null,
      tabsDetail: tabs?.detail ?? null,
      // ⛔ 이동 load 대기 시한과 화면 캡처 시한은 «다른» 실패다 — 한 라벨로 뭉치면 고칠 자리를 못 가른다.
      postClickLoadWait,
      runId,
      personaId: request.persona?.personaId ?? null,
      attribution: resolveBrowserActionAttribution(request, runId),
    });
  } catch { /* action observation emission is fail-soft */ }
  // ⛔ 관측 «발신»이 실패해도 이 사실은 돌려준다 — 부르는 쪽(재현)의 조인은 스토어에 안 달렸다.
  return { coordinates, captureOutcome, clickedHref, landedUrl, landingVerdict: landing.verdict };
}

/**
 * ⛔ **실패한 조작이 관측에 «한 줄도» 안 남았다.**
 *
 * 📏 실측 2026-08-27: 위키백과 첫 링크를 클릭하려 하니 도구가 «정당하게» 거부했다
 *    (`browser action target is outside the viewport: a`) — 그런데 `harness.browser-act` 에 ***행이 0개***였다.
 *    ⇒ 🚨 그러면 봇 루틴의 브라우저 단계가 그렇게 실패해도 ***관측으로는 「아무 일도 없었다」***로 보인다.
 *
 * 🔑 그리고 이 축의 카나리아(`sees=`)는 «관측 행»을 찾아 판정한다 —
 *    행이 없으면 「측정 불가」가 되고, ***왜 못 했는지는 영영 안 남는다.***
 *
 * ⛔ 성공 행과 «같은 이벤트 이름»을 쓴다 — 소비자가 한 질의로 둘을 다 세게. 대신 `ok` 로 가른다.
 */
async function observeBrowserActionFailure(
  request: BrowserActionRequest,
  reason: string,
  error: string | null,
  deps: BrowserActionDeps,
): Promise<void> {
  try {
    const runId = deps.getRunId ? deps.getRunId() : getHarnessRunId() || null;
    (deps.observe ?? ((event, data) => debug.log(BROWSER_ACT_CATEGORY, event, data)))(BROWSER_ACT_EVENT, {
      url: request.url,
      target: request.target,
      // ⛔ 실패는 좌표도 화면도 «없다» — 있는 척하지 않는다.
      coordinates: null,
      attachmentRef: null,
      captureOutcome: 'not-requested',
      captureError: null,
      captureTimeoutMs: null,
      postClickLifecycle: null,
      postClickLoadWait: null,
      // ⭐ 성공 행에는 없는 두 칸 — 이것이 이 행을 «실패»로 읽게 한다.
      ok: false,
      failureReason: reason,
      failureError: error,
      runId,
      personaId: request.persona?.personaId ?? null,
      attribution: resolveBrowserActionAttribution(request, runId),
    });
  } catch { /* action observation emission is fail-soft */ }
}

/**
 * 🧹 CDP HTTP 끝점으로 «페이지 목록»을 읽는다. ⛔ 시한을 «반드시» 준다 —
 * 이 축의 병이 「에러가 아니라 영영 안 옴」이고, 정리가 조작을 멎게 하면 안 된다.
 */
async function readPageTargets(port: number, timeoutMs: number): Promise<{ ids: string[]; readable: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ids: [], readable: false };
    return { ids: pageTargetIds(await res.text()), readable: true };
  } catch { return { ids: [], readable: false }; }
}

/** ⛔ 실패해도 조작을 막지 않는다 — 다만 «조용하지도 않다»(몇 개 닫혔나를 돌려준다). */
async function closePageTargets(port: number, ids: readonly string[], timeoutMs: number): Promise<number> {
  let closed = 0;
  for (const id of ids) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`,
        { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) closed += 1;
    } catch { /* 한 탭을 못 닫아도 나머지를 시도한다 */ }
  }
  return closed;
}

const TAB_RECLAIM_TIMEOUT_MS = 4_000;

/** Executes exactly one human-armed browser click through an attached CDP page. */
export async function performBrowserAction(request: BrowserActionRequest, deps: BrowserActionDeps = {}): Promise<BrowserActionResult> {
  if (!request.armed) {
    await observeBrowserActionFailure(request, 'unarmed', null, deps);
    return { ok: false, url: request.url, target: request.target, reason: 'unarmed' };
  }

  let client: CdpClient | undefined;
  let loadWait: CdpLoadWait | undefined;
  try {
    const cdpPort = request.persona?.browserPort ?? deps.port ?? 9222;
    client = await (deps.connect ?? createCdpClientFromEndpoint)(cdpPort);
    loadWait = createCdpLoadWait(client, deps.loadWaitTimeoutMs ?? DEFAULT_LOAD_WAIT_TIMEOUT_MS);
    if (!loadWait) {
      await observeBrowserActionFailure(request, 'load-unavailable', 'page lifecycle subscription is unavailable', deps);
      return { ok: false, url: request.url, target: request.target, reason: 'load-unavailable', error: 'page lifecycle subscription is unavailable' };
    }
    const navigation = await client.navigate(request.url);
    if (navigation.errorText) throw new Error(navigation.errorText);
    const loadOutcome = await loadWait.waitFor(navigation);
    if (loadOutcome === 'unavailable') {
      await observeBrowserActionFailure(request, 'load-unavailable', 'navigation did not provide a loaderId', deps);
      return { ok: false, url: request.url, target: request.target, reason: 'load-unavailable', error: 'navigation did not provide a loaderId' };
    }
    if (loadOutcome === 'timeout') {
      const loadError = `page load timed out after ${deps.loadWaitTimeoutMs ?? DEFAULT_LOAD_WAIT_TIMEOUT_MS}ms`;
      await observeBrowserActionFailure(request, 'load-timeout', loadError, deps);
      return { ok: false, url: request.url, target: request.target, reason: 'load-timeout', error: loadError };
    }
    // 🧹 클릭 «전»의 탭 목록 — 조작 뒤 «새로 열린 것»만 회수하기 위한 기준선.
    //    ⛔ 모르는 탭을 지우지 않는다. 사람이 열어 둔 것을 «회수 대상으로 삼지 않는다».
    const tabsBefore = deps.reclaimOpenedTabs === false
      ? { ids: [] as string[], readable: false }
      : await readPageTargets(cdpPort, TAB_RECLAIM_TIMEOUT_MS);
    // ⛔ 클릭 «전»에 건다 — 클릭이 일으킨 이동은 클릭이 돌아오기 전에 시작될 수 있다.
    const navigationWatch = createPostClickNavigationWatch(client, navigation.loaderId);
    // ⛔ `finally` 밖에서 돌려줘야 해서 앞에 선언한다 — 관측이 fail-soft 라 여기가 비는 일은 없다.
    let observed: BrowserActionObserved | undefined;
    try {
      // ⛔ `deps.execute` 심은 «좌표만» 돌려주는 옛 계약을 그대로 둔다 — 시험이 그것을 쓴다.
      //    그 경로로 오면 href·text 는 «못 잰 것»이지 「없는 것」이 아니다 ⇒ null 로 둔다.
      const clicked: ClickedElement = deps.execute
        ? { coordinates: parseCoordinates(await deps.execute(client, request.target)), href: null, text: null }
        : await executeClick(client, request.target, deps.reversibilityPolicy ?? 'navigation-only',
            request.url, request.persona?.actionHosts, request.persona?.offsiteNavigation);
      const coordinates = clicked.coordinates;
      // 클릭 반환 뒤 `init` 이 올 수 있다. 이미 연 lifecycle 구독으로 기존 시한 안에서 판별하고,
      // 이동이 보이면 그 문서의 load 뒤에 화면을 찍는다. 추가 CDP 왕복·고정 sleep 없음.
      const postClickLoadWait = navigationWatch
        ? await navigationWatch.waitForLoad(deps.loadWaitTimeoutMs ?? DEFAULT_LOAD_WAIT_TIMEOUT_MS)
        : null;
      // 🧹 관측(캡처) «뒤»에 회수한다 — 먼저 닫으면 찍을 화면이 사라진다.
      const tabsAfter = deps.reclaimOpenedTabs === false
        ? { ids: [] as string[], readable: false }
        : await readPageTargets(cdpPort, TAB_RECLAIM_TIMEOUT_MS);
      const plan = planTabReclaim({
        before: tabsBefore.ids, after: tabsAfter.ids,
        beforeReadable: tabsBefore.readable, afterReadable: tabsAfter.readable,
      });
      const reclaimed = plan.close.length === 0 ? 0 : await closePageTargets(cdpPort, plan.close, TAB_RECLAIM_TIMEOUT_MS);
      observed = await observeBrowserAction(client, request, clicked, deps, navigationWatch, postClickLoadWait,
        { planned: plan.close.length, reclaimed, detail: plan.detail });
    } finally {
      navigationWatch?.dispose();
    }
    return { ok: true, url: request.url, target: request.target, observed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = isBrowserSessionUnavailable(error) ? 'session-unavailable' : 'execution-failed';
    await observeBrowserActionFailure(request, reason, message, deps);
    return { ok: false, url: request.url, target: request.target, reason, error: message };
  } finally {
    loadWait?.dispose();
    if (client) {
      try { await client.close(); } catch { /* closing an attached page is fail-soft */ }
    }
  }
}
