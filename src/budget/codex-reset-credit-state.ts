// 리셋 크레딧 «가용 수»의 직전 관측값을 담는 얇은 상태 파일.
//
// ⛔⭐ 왜 별도 파일인가: `codex-reset-credits.ts` 는 «네트워크 계약»만 알고, 어디에 저장하는지는
//   모른다(그래서 그 모듈이 순수하게 시험된다). 저장 위치는 인스턴스 격리 축이라 여기서 정한다.
// ⛔ 실패를 «값으로» 다루는 것은 «읽기»다 — 읽기 실패는 「이전을 모른다」(undefined)로 접는다.
//   ⚠️ **쓰기는 던진다**(4R should-fix — 초판 주석은 「삼킨다」라 «거짓»이었다):
//     `writeAvailabilityState` 는 예외를 그대로 올리고, 그것을 삼키는 것은 «호출자»다
//     (`observeResetCreditAvailability` 가 try 로 감싸 `availability-persist-failed` 로 관측한다).
//     ⇒ 직접 부르는 쪽은 «자기가» 감싸야 한다. 여기서 삼키면 저장 실패가 영영 안 보인다.
//   ⭐ 반면 `writeQuotaSignal` 은 «판정 신호»라 조회를 막으면 안 되므로 자기가 삼킨다(아래 주석).

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import type { CodexResetCredit } from './codex-reset-credits.js';
import type { ResetCreditExpiryAxis } from './types.js';

/**
 * 현재 응답의 가용 리셋권 만료 시각만 읽는다. 경고 창은 호출자가 설정에서 공급하며,
 * 상태 파일을 읽거나 쓰지 않는다. `undefined` 창은 임박 여부를 판정할 수 없어 오류로 드러낸다.
 */
export function describeResetCreditExpiry(
  credits: readonly CodexResetCredit[],
  warningWindowMs: number | undefined,
  nowMs: number = Date.now(),
): ResetCreditExpiryAxis {
  if (!Number.isFinite(nowMs)) return { status: 'unavailable', detail: 'invalid-current-time' };
  if (!Number.isFinite(warningWindowMs) || warningWindowMs === undefined || warningWindowMs < 0) {
    return { status: 'unavailable', detail: 'invalid-warning-window' };
  }
  const available = credits.filter((credit) => credit.status === 'available');
  if (available.length === 0) return { status: 'none' };

  const expiryMs = available
    .map((credit) => credit.expires_at === null ? Number.NaN : Date.parse(credit.expires_at))
    .filter((value) => Number.isFinite(value));
  if (expiryMs.length === 0) return { status: 'unknown-expiry' };

  const earliest = Math.min(...expiryMs);
  const hasUnknownExpiry = expiryMs.length !== available.length;
  const expiresAt = new Date(earliest).toISOString();
  if (earliest < nowMs) return { status: 'expired', expiresAt, hasUnknownExpiry };
  if (earliest <= nowMs + warningWindowMs) return { status: 'expiring-soon', expiresAt, hasUnknownExpiry };
  return { status: 'available', expiresAt, hasUnknownExpiry };
}

/** ⭐ `ELANOUS_STATE_DIR` 을 존중한다 — `--test` 격리에서 운영 상태를 만지지 않기 위해서다.
 *  ⛔ export 하지 않는다 — 소비처가 없는 공개 표면은 만들지 않는다(1R must-fix).
 *
 *  ⭐⭐ **뿌리 계산은 `codexCredentialRoot()` «한 자»를 쓴다**(2026-08-19 · `OBS-T110` 후속).
 *   📏 이 함수는 «이미» 옳은 규칙(명시 존중 · 파생 무시)을 갖고 있었고, 어긋난 것은 쿼터 신호 쪽이었다.
 *   ⛔ 그런데 «한 자리»가 더 갈려 있었다: `authStorePath()` 는 `XDG_CONFIG_HOME` 을 존중하는데
 *     여기는 «안» 했다 ⇒ XDG 를 쓰는 환경에서 ***자격과 그 상태가 또 갈린다***.
 *   ⇒ 🔑 그래서 세 자리(auth · quota signal · reset credit)가 «한 규칙»을 쓰게 묶는다. */
function resetCreditStatePath(homePath?: string): string {
  const root = codexCredentialRoot();
  if (!homePath?.trim()) return join(root, 'budget', 'codex-reset-credit-availability.json');
  const key = createHash('sha256').update(normalizeHome(homePath)).digest('hex').slice(0, 12);
  return join(root, 'budget', `codex-reset-credit-availability-${key}.json`);
}

interface AvailabilityState {
  availableCount?: number;
  observedAt?: string;
}

/** 직전 관측값. ⛔ 파일이 없거나 깨졌으면 «0 이 아니라» undefined — 그래야 첫 관측이 「부여」로 안 세어진다. */
export function readAvailabilityState(homePath?: string): number | undefined {
  try {
    const raw = readFileSync(resetCreditStatePath(homePath), 'utf8');
    const parsed = JSON.parse(raw) as AvailabilityState;
    const n = parsed?.availableCount;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeAvailabilityState(availableCount: number, homePath?: string): void {
  const path = resetCreditStatePath(homePath);
  mkdirSync(dirname(path), { recursive: true });
  const next: AvailabilityState = { availableCount, observedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** 가용 크레딧 관측의 신선도 상한. 쿼터 신호와 같은 판정 창을 써서 오래된 `available`이 회전을 막지 않게 한다. */
const AVAILABILITY_STATE_MAX_AGE_MS = 60 * 60 * 1000;

/** 판정용 가용 수. 관측이 없거나 손상·미래·만료면 `undefined`(모름)이며 `0`(없음)이 아니다. */
export function readFreshAvailabilityState(nowMs: number = Date.now(), homePath?: string): number | undefined {
  try {
    const raw = readFileSync(resetCreditStatePath(homePath), 'utf8');
    const parsed = JSON.parse(raw) as AvailabilityState;
    const availableCount = parsed?.availableCount;
    const observedAt = parsed?.observedAt ? Date.parse(parsed.observedAt) : Number.NaN;
    const age = nowMs - observedAt;
    if (
      typeof availableCount !== 'number' || !Number.isFinite(availableCount)
      || !Number.isFinite(observedAt) || age < 0 || age > AVAILABILITY_STATE_MAX_AGE_MS
    ) return undefined;
    return availableCount;
  } catch {
    return undefined;
  }
}

// ─── 쿼터 신호(디스크 경유) ──────────────────────────────────────────
//
// ⛔⭐⭐⭐ **왜 디스크인가**(2026-08-05 무인 리뷰가 냄새를 맡은 자리): `UsageStore` 는 «프로세스 안»
//   메모리이고 `initBudgetStore` 는 **TUI 대시보드에서만** 불린다. 그래서 headless `elanous dev` 런은
//   그 store 가 «영영 비어» 있고, 쿼터 얼굴이 «한 번도 안 뜬다** — 만들었는데 아무도 안 부르는 형태다.
//   ✅ 그래서 fetch 가 성공할 때 신호를 «파일로» 남기고, 판정층은 그 파일만 읽는다.
//   ⛔ 판정 경로에서 네트워크를 치지 않는다(실측: 그 호출이 2분 15초 매달린 적이 있다).
//   ⛔ 그리고 «낡은 것»을 「지금 사실」로 읽지 않는다 — 나이 상한을 넘으면 undefined(모른다)다.

const QUOTA_SIGNAL_MAX_AGE_MS = 60 * 60 * 1000;   // 1시간 — 주간 창(10080분)에 비해 충분히 짧다

interface QuotaSignalState {
  rateLimitReached?: string | null;
  /** 브랜드 총량 창의 사용률. 옛 신호에는 없을 수 있다. */
  usedPercent?: number;
  observedAt?: string;
  /** ⭐ 이 관측이 «어느 홈»을 잰 것인가. 파일 이름은 해시라 사람이 못 읽는다. */
  measuredHome?: string;
  /** 선불 크레딧 잔액·보유(대표 09-28 크레딧 정책 — 한도가 찬 뒤 «어느 계정 크레딧으로» 갈지 고르는 재료). */
  creditsBalance?: number;
  hasCredits?: boolean;
}

/**
 * ⛔⭐⭐⭐ **신호는 「어느 계정을 잰 것인가」를 들고 있어야 한다** (2026-08-05).
 *
 * 종전엔 파일이 «하나»였다. 계정이 하나일 때는 맞았지만, 계정을 이름으로 가른 뒤에는
 * ***A 를 재고 쓴 「찼다」를 B 의 것으로 읽는다.*** 회전(S4)을 그 위에 얹으면
 * 「A 가 찼으니 B 로 간다 → B 도 찼다고 나온다 → 되돌아간다」가 된다.
 *
 * ⭐ **키는 「elanous 의 계정 이름」이 아니라 「실제로 잰 홈」이다.** 측정은 `codex app-server` 를
 *   띄워서 하고 그 프로세스가 읽는 것은 `CODEX_HOME` 이다. 이름으로 키를 잡으면
 *   `CODEX_HOME=<B> elanous provider codex usage` 가 «B 를 재고 default 로 적는다» —
 *   판정층이 피판정층과 다른 자를 쓰는 그 형태다.
 *
 * ⛔⭐⭐ **「기본 계정은 종전 파일 이름」이라는 특례를 «두지 않는다»**(리뷰 must-fix).
 *   그 특례는 「기본」을 «지금의 CODEX_HOME»으로 판정할 수밖에 없고, 그러면
 *   그 값이 A→B 로 바뀌는 순간 ***A 가 쓴 종전 파일을 B 의 신호로 읽는다*** — 고치려던 그 병이다.
 *   ⭐ 그리고 **하위호환은 여기서 값이 없다** — 신호는 «1시간»이면 만료된다.
 *     옛 파일을 지키려고 오판 위험을 안을 이유가 없다. 다음 관측이 곧 채운다.
 */
function normalizeHome(p: string): string {
  // ⛔ 같은 홈의 «다른 표기»(끝 슬래시 · 상대 경로 · `..` · 심볼릭 링크)가 다른 파일로 갈리면
  //   한 계정이 «두 신호»를 갖는다 — 회전이 그 둘을 다른 계정으로 읽는다(리뷰 must-fix).
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { return abs; }
}

/** 명시 루트가 없으면 정식 인스턴스 상태 뿌리에, 있으면 호출자 뿌리에 신호를 둔다. */
/**
 * ⛔⭐⭐⭐⭐ **쿼터 신호는 «자격과 같은 뿌리»에 산다 — 우주로 갈리지 않는다.**
 *
 * 🚨 왜 바꿨나(2026-08-19 · 🅢 실측 ⊕ 🅣 확인):
 *   `authStorePath()` 는 ***절대 우주로 안 갈린다***(XDG 만 본다). 그런데 이 함수는
 *   `elanousStateRoot()` 를 써서 ***갈렸다*** ⇒ ***자격은 공유인데 그 자격의 «상태»만 갈렸다.***
 *   ⇒ 격리 우주(자식 워크트리)가 ***19시간 낡은*** 자기 신호를 읽고 `usedPercent=unknown` 이 되어,
 *     회전이 ***이미 100% 인 계정을 골라*** 429 로 죽었다(골 «둘»이 그 경로로 죽었다).
 * ⭐ 그리고 이것은 «설계 판단»이 아니라 ***구현이 자기 머리말을 안 따른 것***이다 —
 *   `QuotaSignalStorageOpts.root` 머리말이 이미 ***"생략하면 «공유 자격 뿌리»를 쓴다"*** 라고 적혀 있었다.
 * ⛔ 격리가 필요한 호출자(테스트 등)는 ***`root` 를 «명시»한다*** — 그 길은 그대로다.
 */
export function codexCredentialRoot(): string {
  // ⛔⭐⭐⭐ **「명시 격리」와 「파생 격리」를 «가른다» — 이것이 이 수리의 핵심이다.**
  //   ⓐ `ELANOUS_STATE_DIR` 이 «명시»로 서 있으면 ⇒ 부른 쪽이 «의도적으로» 격리한 것이다. 존중한다.
  //      (격리 테스트가 그 길을 쓴다 — 안 존중하면 테스트가 사람의 진짜 `~/.elanous/budget` 에 쓴다)
  //   ⓑ 그런데 자식 워크트리의 우주는 ***env 가 아니라 «트리에서 파생»***된다(3층 test 파생).
  //      ⛔ 그것까지 신호를 가르면 ***아무도 의도하지 않은 격리***가 생기고, 그 안의 신호는
  //      갱신하는 사람이 없어 «19시간» 낡는다 ⇒ 회전이 100% 인 계정을 고른다 ⇒ 429.
  //   ⇒ 🔑 그래서 ***「누가 격리를 «말했나»」***로 가른다. 말한 적 없으면 자격과 «같은 뿌리»다.
  // ⛔⭐⭐⭐ **「명시」인지 «물어본다»** — env 에 값이 있다고 명시가 아니다(2026-08-19 · `OBS-T114`).
  //   하니스가 자식을 띄울 때 ***파생된 우주 뿌리를 `ELANOUS_STATE_DIR` 로 «채워 넣는다»***
  //   (`agent/identity-env.ts` `buildPtyEnv`). 그 값을 「사람이 격리를 말했다」로 읽으면
  //   ***자식이 갱신되지 않는 자기 우주를 보고 전 계정 `unknown`*** 이 된다 ⇒ 회전이 100% 계정을 고른다.
  //   ⇒ 🔑 그래서 ***출처를 «값으로» 받아*** 파생이면 무시한다. 출처를 안 주는 옛 자식은
  //     종전대로 존중된다(호환) — 새 자식부터 갈린다.
  const explicitIsolation = process.env.ELANOUS_STATE_DIR_SOURCE?.trim() === 'derived'
    ? undefined
    : process.env.ELANOUS_STATE_DIR?.trim();
  if (explicitIsolation) return explicitIsolation;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  // ⛔ `authStorePath()` 와 «같은 규칙»을 쓴다 — 두 자로 나뉘면 한쪽만 고쳐 다시 갈린다.
  return xdg ? join(xdg, 'elanous') : join(homedir(), '.elanous');
}

export function quotaSignalDir(root?: string): string {
  return join(root?.trim() || codexCredentialRoot(), 'budget');
}

function quotaSignalPath(homePath?: string, root?: string): string {
  // ⛔⭐ 루트 계산을 «중복하지 않는다»(리뷰 should-fix) — 종전엔 여기와 `quotaSignalDir` 이
  //   각자 계산해서, 한쪽만 고치면 ***상태 화면과 실제 신호 경로가 다시 갈릴 수 있었다.***
  //   이 축이 오늘 계속 고쳐 온 「두 자」 형태다. ⇒ 한 자를 쓴다.
  const target = normalizeHome(homePath?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
  const key = createHash('sha256').update(target).digest('hex').slice(0, 12);
  return join(quotaSignalDir(root), `codex-quota-signal-${key}.json`);
}

export interface QuotaSignalStorageOpts {
  /** 명시적인 테스트·호출자 격리 뿌리. 생략하면 공유 자격 뿌리를 쓴다. */
  readonly root?: string;
}

/** fetch 가 성공할 때마다 부른다. ⛔ 실패는 삼킨다 — 관측이 조회를 막지 않는다.
 *  두 번째 문자열 인자는 기존 홈 전용 호출과의 호환을 위한 것이다. */
export function writeQuotaSignal(
  rateLimitReached: string | undefined,
  usedPercentOrHome?: number | string,
  homePath?: string,
  storage?: QuotaSignalStorageOpts,
  credits?: { readonly balance?: number; readonly hasCredits?: boolean },
): void {
  try {
    const usedPercent = typeof usedPercentOrHome === 'number' && Number.isFinite(usedPercentOrHome)
      ? Math.max(0, Math.min(100, usedPercentOrHome))
      : undefined;
    const home = typeof usedPercentOrHome === 'string' ? usedPercentOrHome : homePath;
    const path = quotaSignalPath(home, storage?.root);
    mkdirSync(dirname(path), { recursive: true });
    const next: QuotaSignalState = {
      rateLimitReached: rateLimitReached ?? null,
      ...(usedPercent === undefined ? {} : { usedPercent }),
      observedAt: new Date().toISOString(),
      measuredHome: normalizeHome(home?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')),
      ...(typeof credits?.balance === 'number' && Number.isFinite(credits.balance) ? { creditsBalance: credits.balance } : {}),
      ...(typeof credits?.hasCredits === 'boolean' ? { hasCredits: credits.hasCredits } : {}),
    };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch { /* fail-soft */ }
}

function readFreshQuotaSignal(nowMs: number, homePath?: string, storage?: QuotaSignalStorageOpts): QuotaSignalState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(quotaSignalPath(homePath, storage?.root), 'utf8')) as QuotaSignalState;
    const want = normalizeHome(homePath?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
    if (parsed?.measuredHome !== want) return undefined;
    const observedAt = parsed?.observedAt ? Date.parse(parsed.observedAt) : Number.NaN;
    const age = nowMs - observedAt;
    if (!Number.isFinite(observedAt) || age < 0 || age > QUOTA_SIGNAL_MAX_AGE_MS) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * ⭐ 판정층이 읽는 유일한 자리. 셋을 구분한다:
 *   true      — 최근에 「찼다」고 관측됐다
 *   undefined — 신호가 없거나 «낡았다»(모른다). ⛔ false 로 뭉개지 않는다
 */
export function readQuotaSignal(nowMs: number = Date.now(), homePath?: string, storage?: QuotaSignalStorageOpts): boolean | undefined {
  return readFreshQuotaSignal(nowMs, homePath, storage)?.rateLimitReached ? true : undefined;
}

/** 최근의 유효한 신호가 관측된 시각(ms). 파일 부재·손상·다른 홈·미래·한 시간 초과는 모두 모른다. */
/**
 * ⛔⭐⭐⭐ **나이는 «만료돼도» 알아야 한다**(리뷰 must-fix · 2026-08-07).
 *
 * `readQuotaSignalObservedAt` 은 «판정용»이라 나이 상한을 넘으면 `undefined` 로 접는다 — 옳다.
 * 그런데 표면이 그것만 쓰면 ***가장 필요한 순간에 나이를 못 보여 준다***: 운영자에게
 * 「65분 전」과 「3일 전」은 완전히 다른 진단이다(전자는 곧 갱신되고, 후자는 갱신이 «죽었다»).
 * ⇒ 이 함수는 «신선함을 안 따지고» 관측 시각만 낸다. 홈 신원 대조와 파싱은 그대로 한다.
 * ⛔ 판정에는 쓰지 않는다 — 판정은 여전히 위 함수가 한다(두 자를 갈라 두는 것이 «의도»다).
 */
export function readQuotaSignalObservedAtRaw(nowMs: number = Date.now(), homePath?: string, storage?: QuotaSignalStorageOpts): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(quotaSignalPath(homePath, storage?.root), 'utf8')) as QuotaSignalState;
    const want = normalizeHome(homePath?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
    if (parsed?.measuredHome !== want) return undefined;
    const at = parsed?.observedAt ? Date.parse(parsed.observedAt) : Number.NaN;
    // ⛔ «미래» 시각은 손상으로 본다(리뷰 should-fix) — 그대로 내면 나이가 «음수»가 되어
    //   화면이 「-30분 전」 같은 비문을 말한다. 판정 경로가 이미 같은 규율을 쓴다(시계 역행).
    if (!Number.isFinite(at) || at > nowMs) return undefined;   // ⭐ 주입된 now 를 쓴다(리뷰 should-fix)
    return at;
  } catch {
    return undefined;
  }
}

export function readQuotaSignalObservedAt(nowMs: number = Date.now(), homePath?: string, storage?: QuotaSignalStorageOpts): number | undefined {
  const observedAt = readFreshQuotaSignal(nowMs, homePath, storage)?.observedAt;
  const parsed = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 최근의 크레딧 잔액·보유. 옛 파일·낡은 신호·다른 홈은 모두 모른다(빈 객체). */
export function readQuotaSignalCredits(nowMs: number = Date.now(), homePath?: string, storage?: QuotaSignalStorageOpts): { balance?: number; hasCredits?: boolean } {
  const s = readFreshQuotaSignal(nowMs, homePath, storage);
  return {
    ...(typeof s?.creditsBalance === 'number' && Number.isFinite(s.creditsBalance) ? { balance: s.creditsBalance } : {}),
    ...(typeof s?.hasCredits === 'boolean' ? { hasCredits: s.hasCredits } : {}),
  };
}

/** 최근의 브랜드 총량 사용률. 옛 파일·낡은 신호·다른 홈은 모두 모른다. */
export function readQuotaSignalUsedPercent(nowMs: number = Date.now(), homePath?: string, storage?: QuotaSignalStorageOpts): number | undefined {
  const usedPercent = readFreshQuotaSignal(nowMs, homePath, storage)?.usedPercent;
  return typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100
    ? usedPercent
    : undefined;
}
