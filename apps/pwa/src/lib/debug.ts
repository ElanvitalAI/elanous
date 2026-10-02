/**
 * Browser-side debug.log — mirrors src/debug-log.ts contract.
 *
 * console.debug 로컬 출력 + **데몬 포워딩** (통합 로그 패브릭 LF2 ·
 * 2026-07-13): 매 debugLog 를 LogRecord 로 변환해 100ms 배치로
 * `POST /v1/debug-logs/batch`(platform=pwa) 에 전송 — iOS
 * DebugLogForwarder 아크(2026-05-15) 동형. 서버가 debug-tap JSONL +
 * logs.db 에 적재하므로 `elanous logs --surface pwa` / PWA Logs 대시보드
 * (LF4) 에서 크로스서피스 조회된다.
 *
 * 노브 (localStorage — settings UI 는 후속):
 *   elanous.pwa.debug.forward       'off' 로 포워딩 중단 (기본 on)
 *   elanous.pwa.debug.forwardLevel  이 레벨 이상만 전송 — debug|info|warn|error
 *                                  (기본 debug = 전부 · severity 는 category
 *                                  접미사에서 유도 — 서버 deriveLogLevel 동일 규칙)
 *
 * 전송 실패는 큐에 남겨 재시도(캡 500·오래된 것부터 드롭) — 오프라인/
 * HMR dev(cross-origin 404) 에서도 콘솔 출력은 불변. 페이지 이탈 시
 * sendBeacon 으로 마지막 배치 flush.
 */

let enabled = true; // PWA default on; toggleable via setDebugEnabled(false)

export function setDebugEnabled(value: boolean): void {
  enabled = value;
}

// ── 포워더 ───────────────────────────────────────────────────────────

interface WireRecord {
  ts: string;
  category: string;
  event: string;
  data?: unknown;
  source: { platform: 'pwa' };
}

type ForwardLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<ForwardLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 서버 deriveLogLevel 과 동일한 접미사 규칙(클라 프리필터용). */
export function deriveForwardLevel(category: string): ForwardLevel {
  const last = category.slice(category.lastIndexOf('.') + 1).toLowerCase();
  if (/^(error|exception|crash|fail|failed)$/.test(last)) return 'error';
  if (/^(warn|degraded|timeout)$/.test(last)) return 'warn';
  if (/^(boot|ready|start|begin|open|ok|done|resolve|end|stop|close)$/.test(last)) return 'info';
  return 'debug';
}

const FLUSH_MS = 100;
/** TERM1 · 10-02 — 운영 포워더의 배치 간격. 100ms 이던 때는 터미널에서 키 하나마다 POST 하나가 나갔다
 *  (격리 데몬 실측: 키 → +100ms `/v1/debug-logs/batch`). 1.5초로 모으고, 한 배치가 차면 그 자리에서 보낸다
 *  (잃지 않는다 · 페이지 이탈은 sendBeacon 이 그대로 비운다). 클래스 기본(100ms)은 시험이 쓴다. */
export const PWA_FLUSH_MS = 1_500;
const MAX_BATCH = 100;
const QUEUE_CAP = 500;
const ENDPOINT = '/v1/debug-logs/batch';
/** ⛔ 실패 재시도 백오프 상한 — 오프라인 탭이 영원히 두드리지 않게. */
const RETRY_MAX_MS = 30_000;
/** ⛔⭐⭐⭐ 전송 타임아웃 — **없으면 관측이 «조용히 죽는다».**
 *
 *  📏 2026-08-22 실측(17차 `[F]`): 데몬을 재시작하자 ***PWA 로그가 통째로 끊겼다.***
 *  그 사이 채팅 턴은 «정상으로 돌았고»(답이 왔다), 관측만 15분 넘게 0건이었다.
 *  ⇒ 기전: `flush()` 는 `inFlight` 면 즉시 return 하는데, `await fetch(...)` 가
 *    ***영영 pending 이면 `finally` 도 안 돌아 `inFlight` 가 영영 true*** 로 남는다.
 *    `keepalive: true` 요청은 커넥션이 끊겨도 브라우저가 오래 붙들 수 있다.
 *  🔑 ***그리고 그것은 「조용하다」*** — 콘솔에도, 서버에도, 사용자 화면에도 아무 흔적이 없다.
 *  ⇒ 리로드하면 회복된다(실측) — 즉 «영구 손상»이 아니라 «그 창이 눈을 잃는» 것이다.
 *  ⛔ 그래서 상한을 둔다. 실패는 큐를 유지하므로 다음 push 가 다시 시도한다. */
const POST_TIMEOUT_MS = 10_000;

/** ⭐ 「끝나지 않는 것」에 상한을 씌운다. 타임아웃이면 throw — 호출자가 실패로 다룬다.
 *  ⛔ 원래 promise 를 «취소하지는 못한다»(그건 전송기의 몫) — 여기서는 «기다리기를» 그만둘 뿐이다. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`debug-forward timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

/** ⛔⭐⭐⭐ **포워더가 «자기 건강»을 센다** — 19차 `[F]`.
 *
 *  📏 왜: 2026-08-22 실측으로 관측이 8분간 0건이었는데 ***아무도 그 사실을 몰랐다.***
 *  회복된 뒤에도 「몇 건을 잃었나」를 물을 자리가 없었다 — 큐 상한 초과분을
 *  `splice` 로 ***조용히 버리고 세지 않았기 때문이다.***
 *  🔑 이 저장소의 규칙: ***세었으면 내보낸다. 그리고 「모른다」를 「없다」로 접지 않는다.*** */
export interface ForwarderHealth {
  /** 지금 큐에 남은 레코드 수. */
  pending: number;
  /** 연속 실패 횟수 — 성공하면 0으로. */
  consecutiveFailures: number;
  /** 마지막 성공 업로드 시각(ms). 한 번도 성공 못 했으면 `null`. */
  lastOkAt: number | null;
  /** ⛔ 큐 상한을 넘겨 «버린» 누적 레코드 수 — 영영 잃은 것이다. */
  droppedByCap: number;
  /** 대체 통로(ACP)로 내보낸 누적 배치 수. */
  fallbackBatches: number;
}

/** ⭐ 대체 전송기 — HTTP 가 굶을 때 쓸 «살아 있는» 통로(현재는 ACP WebSocket).
 *  ⛔ 등록되지 않으면 폴백은 «없다» — 그 경우에도 동작은 이 수리 이전과 같다. */
export type DebugFallbackTransport = (body: string) => Promise<boolean>;

let fallbackTransport: DebugFallbackTransport | null = null;

/** ACP 연결을 소유한 쪽이 이걸 불러 폴백을 연다(`null` 로 해제). */
export function setDebugForwardFallback(fn: DebugFallbackTransport | null): void {
  fallbackTransport = fn;
}

/** ⛔ 몇 번 연속 실패하면 대체 통로를 쓰나. 1회는 «흔한 일»(재시작·일시 오류)이라 참는다. */
const FALLBACK_AFTER_FAILURES = 2;

export class DebugForwarder {
  private queue: WireRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;
  private lastOkAt: number | null = null;
  private droppedByCap = 0;
  private fallbackBatches = 0;
  /** 직전 flush 가 실패였나 — 회복 순간을 «한 번만» 알리기 위한 표시. */
  private wasFailing = false;

  constructor(
    private readonly fetchFn: (body: string) => Promise<boolean> = defaultPost,
    private readonly minLevel: ForwardLevel = 'debug',
    /** ⭐ 시험이 줄일 수 있게 열어 둔다 — 기본은 `POST_TIMEOUT_MS`. */
    private readonly postTimeoutMs: number = POST_TIMEOUT_MS,
    private readonly flushMs: number = FLUSH_MS,
  ) {}

  health(): ForwarderHealth {
    return {
      pending: this.queue.length,
      consecutiveFailures: this.consecutiveFailures,
      lastOkAt: this.lastOkAt,
      droppedByCap: this.droppedByCap,
      fallbackBatches: this.fallbackBatches,
    };
  }

  push(rec: WireRecord): void {
    if (LEVEL_ORDER[deriveForwardLevel(rec.category)] < LEVEL_ORDER[this.minLevel]) return;
    this.queue.push(rec);
    if (this.queue.length > QUEUE_CAP) {
      // ⛔⭐ **버린 수를 «센다»** — 예전엔 조용히 splice 만 했다.
      //   🔑 그러면 회복된 뒤에도 「무엇을 잃었나」를 아무도 못 묻는다.
      const overflow = this.queue.length - QUEUE_CAP;
      this.droppedByCap += overflow;
      this.queue.splice(0, overflow);
    }
    if (this.queue.length >= MAX_BATCH && !this.inFlight) {
      if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
      void this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => { void this.flush(); }, this.flushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.inFlight || this.queue.length === 0) return;
    const batch = this.queue.slice(0, MAX_BATCH);
    this.inFlight = true;
    let ok = false;
    // ⛔⭐⭐ **상한을 «여기»에도 둔다** — `defaultPost` 만 막으면 주입된 `fetchFn`(테스트·다른 전송기)이
    //   영영 pending 할 때 포워더가 그대로 잠긴다. 🔑 ***잠기면 그 창은 「눈을 잃고」 그것이 조용하다.***
    //   ⚠️ 타임아웃 뒤에도 원래 promise 는 계속 살아 있을 수 있다 — 결과를 «무시»할 뿐이다.
    //     그래서 큐를 비우지 않는다(아래 `if (ok)`): 중복 전송이 유실보다 낫고, 서버가 멱등이다.
    const body = JSON.stringify({ records: batch });
    try { ok = await withTimeout(this.fetchFn(body), this.postTimeoutMs); }
    catch { ok = false; }
    finally { this.inFlight = false; }

    if (!ok) {
      this.consecutiveFailures += 1;
      // ⛔⭐⭐⭐ **HTTP 가 굶으면 «살아 있는» 통로로 나간다.**
      //   📏 실측(2026-08-22): SSE 가 커넥션 한도를 먹어 HTTP 가 전부 큐에 섰을 때
      //   ***WebSocket 은 멀쩡히 돌고 있었다*** — 그 창에서 채팅은 계속 됐다.
      //   🔑 제1원칙: 판정 결과가 흐르는 채널은 그 판정의 대상이 쓸 수 없어야 한다.
      //   ⚠️ 폴백이 성공해도 `ok` 로 치지 «않는다» — 큐는 유지해 HTTP 회복 시 정상 경로로
      //     다시 올린다. 중복은 서버가 멱등이라 유실보다 낫다(기존 정책과 같다).
      if (this.consecutiveFailures >= FALLBACK_AFTER_FAILURES && fallbackTransport) {
        try {
          const sent = await fallbackTransport(JSON.stringify({
            records: [...batch, this.blockedNotice()],
          }));
          if (sent) this.fallbackBatches += 1;
        } catch { /* 폴백도 죽었으면 더 할 수 있는 게 없다 — 큐는 남는다 */ }
      }
      this.wasFailing = true;
      // ⛔⭐⭐⭐ **스스로 재시도한다 — 「다음 push」를 기다리지 않는다.**
      //
      //   📏 2026-08-22 라이브에서 «이 자리»가 결함으로 드러났다(19차 `[F]`):
      //   HTTP 를 굶긴 채 턴을 보냈는데 ***폴백이 끝내 안 떴다.***
      //   ⇒ 기전: 옛 정책은 *"백오프를 push 케이던스에 자연 위임"* 이었다. 그런데
      //     ***앱이 조용해지면 push 가 없고, 그러면 flush 도 없고, 연속 실패가 1에서 멈춘다.***
      //     ⇒ 폴백 문턱(2회)에 ***영영 도달하지 못한다.***
      //   🔑 ***「막혔을 때 스스로 못 움직이는 복구 장치」는 복구 장치가 아니다.***
      //   ⚠️ 내 시험은 두 번 push 해서 이걸 «못 잡았다» — 자가 자기 편한 입력만 준 또 한 번의 예.
      //
      //   ⭐ 백오프는 지수로, 상한을 둔다 — 오프라인 탭이 10초마다 영원히 두드리지 않게.
      this.scheduleRetry();
      return;
    }

    const prevOkAt = this.lastOkAt;
    this.lastOkAt = Date.now();
    const failures = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    this.queue.splice(0, batch.length);
    // ⭐⭐ **회복을 «말한다»** — 조용히 돌아오면 「그동안 아무 일 없었다」로 읽힌다.
    //   ⛔ 이 레코드가 없으면 `droppedByCap` 은 영영 아무도 못 본다.
    if (this.wasFailing) {
      this.wasFailing = false;
      this.queue.push({
        ts: new Date().toISOString(),
        category: 'pwa.debug-forwarder.recovered',
        event: 'recovered',
        data: {
          consecutiveFailures: failures,
          droppedByCap: this.droppedByCap,
          fallbackBatches: this.fallbackBatches,
          pending: this.queue.length,
          // ⭐ 무인 리뷰 must-fix(PR #11391): *"`lastOkAt` 이 회복 레코드에 «없다»"* — 옳다.
          //   🔑 「언제부터 눈이 멀었나」를 답하려면 «직전 성공 시각»이 있어야 한다.
          //   ⚠️ 이 시점의 `lastOkAt` 은 «방금» 갱신됐으므로 그 «전» 값을 싣는다.
          previousOkAt: prevOkAt,
        },
        source: { platform: 'pwa' },
      });
    }
    if (this.queue.length > 0 && this.timer === null) {
      this.timer = setTimeout(() => { void this.flush(); }, this.flushMs);
    }
  }

  /** 실패 뒤 «스스로» 다음 시도를 건다. 지수 백오프 · 상한 `RETRY_MAX_MS`.
   *  ⛔ 이미 타이머가 걸려 있으면 겹쳐 걸지 않는다. */
  private scheduleRetry(): void {
    if (this.timer !== null) return;
    if (this.queue.length === 0) return;
    const backoff = Math.min(this.flushMs * 2 ** this.consecutiveFailures, RETRY_MAX_MS);
    this.timer = setTimeout(() => { void this.flush(); }, backoff);
  }

  /** ⭐ 폴백 배치에 «왜 이 통로로 왔는지»를 같이 싣는다.
   *  ⛔ 이 한 줄이 없으면 데몬은 레코드만 받고 ***「HTTP 가 막혔다」는 사실은 못 받는다.*** */
  private blockedNotice(): WireRecord {
    return {
      ts: new Date().toISOString(),
      // 접미사 `blocked` 는 severity 규칙에 없어 debug 로 간다 —
      // ⚠️ 일부러다. 이 레코드는 «신호»이지 장애가 아니고, 폭주하면 잡음이 된다.
      category: 'pwa.debug-forwarder.http-blocked',
      event: 'http-blocked',
      data: {
        consecutiveFailures: this.consecutiveFailures,
        pending: this.queue.length,
        droppedByCap: this.droppedByCap,
        lastOkAt: this.lastOkAt,
        via: 'acp-fallback',
      },
      source: { platform: 'pwa' },
    };
  }

  /** 페이지 이탈 flush — sendBeacon(헤더 불가·same-origin 이라 auth 통과). */
  beaconFlush(): void {
    if (this.queue.length === 0) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const batch = this.queue.slice(0, MAX_BATCH);
        const blob = new Blob([JSON.stringify({ records: batch })], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) this.queue.splice(0, batch.length);
      }
    } catch { /* best-effort */ }
  }

  get pending(): number { return this.queue.length; }
}

async function defaultPost(body: string): Promise<boolean> {
  // 상대 URL — PWA 는 데몬 origin 에서 서빙(same-origin auth 통과). HMR
  // dev(:3210 cross-origin)에선 404 → 실패로 큐 유지(콘솔은 불변).
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
    // ⛔⭐ 상한이 «없으면» 이 await 이 영영 안 끝나고 포워더가 잠긴다(`POST_TIMEOUT_MS` 주석).
    //   ⚠️ `AbortSignal.timeout` 이 없는 환경(구형·일부 테스트 런타임)에서는 그냥 건너뛴다 —
    //     그 경우 동작은 «이 수리 이전»과 같고, 더 나빠지지는 않는다.
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? { signal: AbortSignal.timeout(POST_TIMEOUT_MS) }
      : {}),
  });
  return res.ok;
}

function readForwardKnobs(): { forward: boolean; level: ForwardLevel } {
  try {
    const forward = window.localStorage.getItem('elanous.pwa.debug.forward') !== 'off';
    const raw = window.localStorage.getItem('elanous.pwa.debug.forwardLevel');
    const level: ForwardLevel = raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'debug';
    return { forward, level };
  } catch {
    return { forward: true, level: 'debug' };
  }
}

let forwarder: DebugForwarder | null | undefined; // undefined=미초기화 · null=비활성

function getForwarder(): DebugForwarder | null {
  if (forwarder !== undefined) return forwarder;
  // SSG/테스트(Node) 가드 — 브라우저에서만 포워딩.
  if (typeof window === 'undefined') { forwarder = null; return null; }
  const knobs = readForwardKnobs();
  if (!knobs.forward) { forwarder = null; return null; }
  const f = new DebugForwarder(defaultPost, knobs.level, POST_TIMEOUT_MS, PWA_FLUSH_MS);
  try {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') f.beaconFlush();
    });
  } catch { /* non-DOM 환경 */ }
  forwarder = f;
  return f;
}

export function _resetDebugForwarderForTest(): void { forwarder = undefined; }

// ── debugLog — 기존 시그니처 불변 (호출처 350곳 무수정) ────────────────

export function debugLog(category: string, snapshot?: unknown): void {
  if (!enabled) return;
  if (typeof console === 'undefined') return;
  const ts = new Date().toISOString();
  if (snapshot !== undefined) {
    // Inline-stringify the snapshot so CDP / file capture see the actual
    // payload instead of `Object`. Caps at 800 chars to keep noisy
    // chunks from drowning the log; passing `snapshot` as a separate
    // arg too lets devtools still expand it interactively.
    let inline = '';
    try {
      const seen = new WeakSet<object>();
      inline = JSON.stringify(snapshot, (_k, v) => {
        if (typeof v === 'bigint') return `${v.toString()}n`;
        if (typeof v === 'function') return `[fn ${v.name || 'anon'}]`;
        if (v && typeof v === 'object') {
          if (seen.has(v as object)) return '[circular]';
          seen.add(v as object);
        }
        return v;
      });
    } catch (e) {
      inline = `[unserializable: ${String(e)}]`;
    }
    if (inline && inline.length > 800) inline = inline.slice(0, 797) + '...';
    console.debug(`[${ts}] ${category} ${inline}`, snapshot);
    forwardRecord(ts, category, inline);
  } else {
    console.debug(`[${ts}] ${category}`);
    forwardRecord(ts, category, undefined);
  }
}

function forwardRecord(ts: string, category: string, inline: string | undefined): void {
  const f = getForwarder();
  if (!f) return;
  // event = 마지막 세그먼트 — 서버 severity 유도(접미사 규칙)와 정합.
  // data 는 캡 처리된 inline(JSON 문자열)을 재파싱해 구조 보존 — 서버가
  // 다시 stringify 하므로 문자열 그대로 보내면 이중 인용이 된다. 800자
  // 컷 등으로 파싱 불가면 문자열 폴백.
  const event = category.slice(category.lastIndexOf('.') + 1) || category;
  let data: unknown;
  if (inline !== undefined && inline !== '') {
    try { data = JSON.parse(inline); } catch { data = inline; }
  }
  f.push({
    ts,
    category,
    event,
    ...(data !== undefined ? { data } : {}),
    source: { platform: 'pwa' },
  });
}
