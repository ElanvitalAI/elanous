// codex 계정을 elanous «정본 스토어»에 들이고 조회한다.
//
// ⛔⭐ 왜 필요한가: 공식 CLI 로 로그인하면 토큰은 «그 홈»에만 있다. elanous 는 정본을
//   `~/.elanous/auth.json` 에서 읽으므로, 들여오지 않으면 그 계정으로 «실행»할 수 없다
//   (조회는 되는데 실행은 안 되던 그 자리 · MANUAL-llm-provider-operations §3a).
// ⛔ 토큰 «값»은 어디에도 출력하지 않는다 — accountId 앞 8자만(R-LLM2).

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DEFAULT_CODEX_ACCOUNT, codexStoreKey, accountNameFromStoreKey, isValidAccountName, isCodexStoreKey,
  resolveCodexAccount, effectiveCodexHome, type CodexHomeSource, type CodexAccountResolution,
} from './codex-account.js';
import { authStorePath, defaultCodexHome, listProviders, loadTokens, saveTokens } from './store.js';
import { readFreshAvailabilityState, quotaSignalDir, readQuotaSignal, readQuotaSignalUsedPercent, readQuotaSignalObservedAt, readQuotaSignalObservedAtRaw } from '../budget/codex-reset-credit-state.js';
import { getUserConfig } from '../user-config.js';
import {
  decideCodexRotation, observeRotation, applyRotation, readCodexAccountRotationConfig, rotatedChildEnv,
  codexAccountThresholdPercent,
  type RotationCandidate,
} from './codex-account-rotation.js';
import { debug } from '../debug/log.js';
import {
  decideFallback, normalizeFallbackChain, grokQuotaFromUsageSnapshot,
  type FallbackDecision, type FallbackInput, type RotationOutcome,
} from './fallback-chain.js';
import { resolveGrokCredential } from '../grok/credential.js';
import { sendOutbound } from '../domains/outbound-alert.js';

type CodexAccountOutboundSender = (text: string, kind?: string) => boolean;

function defaultCodexAccountOutboundSender(text: string, kind?: string): boolean {
  return sendOutbound(text, kind);
}

let codexAccountOutboundSender: CodexAccountOutboundSender = defaultCodexAccountOutboundSender;

/** 테스트에서 기존 기본 outbound 경로를 가로챈다. */
export function _setCodexAccountOutboundSenderForTesting(sender: CodexAccountOutboundSender | null): void {
  codexAccountOutboundSender = sender ?? defaultCodexAccountOutboundSender;
}

/** ⛔⭐ 정적 import 로 읽는다 — 종전 `require()` 는 ESM 에서 «정의되지 않을 수 있고», 그러면
 *  fail-soft 가 삼켜 ***config false 가 영영 무시된다***(리뷰 should-fix: 노브가 no-op 이 된다).
 *  ⚠️ 순환 없음을 확인했다 — user-config 는 oauth 를 안 끌어온다. */
type RotationConfig = { llm?: { codexAccountRotation?: boolean; codexAccountAlerts?: boolean; codexAccountRotationThresholdPercent?: unknown; codexAccountRotationThresholdPercentByAccount?: Readonly<Record<string, unknown>>; fallbackChain?: unknown } };

function readUserConfig(): RotationConfig {
  return getUserConfig();
}

/** ⛔ 테스트 심 — 「표면이 설정을 실제로 읽는가」를 무는 유일한 방법이다.
 *  ESM 네임스페이스는 얼려 있어 모듈 함수를 밖에서 못 바꾼다(레포의 `_setXForTesting` 관용구와 동형). */
let configReader: () => RotationConfig = readUserConfig;
export function _setRotationConfigReaderForTesting(
  fn: (() => RotationConfig) | null,
): void {
  configReader = fn ?? readUserConfig;
}

export type ImportResult =
  | { ok: true; storeKey: string; accountIdPrefix: string }
  | { ok: false; kind: 'bad-name' | 'unreadable' | 'no-tokens'; message: string };

export async function importCodexAccountFromHome(
  name: string,
  home: string,
  /** ⛔ 테스트 격리 심 — 안 주면 정본 스토어. 실제 ~/.elanous 를 테스트가 만지지 않게 한다. */
  storePath?: string,
): Promise<ImportResult> {
  if (!isValidAccountName(name)) {
    return { ok: false, kind: 'bad-name', message: `계정 이름이 부적격이다: ${name} (영숫자로 시작 · 구분자·공백 금지)` };
  }
  // ⛔ `default` 는 «예약»이다 — 그 이름으로 들이면 기존 `openai-codex` 항목을 덮어써
  //   운영 인증을 갈아치운다(1R should-fix). 그건 「들여오기」가 아니라 「교체」다.
  if (name === DEFAULT_CODEX_ACCOUNT) {
    return { ok: false, kind: 'bad-name', message: `'${DEFAULT_CODEX_ACCOUNT}' 는 예약된 이름이다 — 기존 계정을 덮어쓰게 되므로 거부한다` };
  }
  // ⛔⭐⭐⭐ 홈은 «절대 경로»로 못 박아 저장한다(5R must-fix).
  //   상대 경로를 그대로 영속하면, 나중에 «다른 cwd»에서 토큰이 갱신될 때 미러가
  //   `<그때의 cwd>/<상대경로>/auth.json` 으로 간다 — 즉 ***토큰이 엉뚱한 곳에 적힌다.***
  //   ⇒ 읽을 때의 cwd 와 쓸 때의 cwd 가 같다는 보장이 «없다»(데몬·하니스 자식은 특히).
  const expanded = resolve(home.startsWith('~') ? join(process.env.HOME ?? '', home.slice(1)) : home);
  let parsed: { tokens?: { access_token?: string; refresh_token?: string; account_id?: string }; auth_mode?: string };
  try {
    parsed = JSON.parse(await readFile(join(expanded, 'auth.json'), 'utf8'));
  } catch (error) {
    return { ok: false, kind: 'unreadable', message: `${join(expanded, 'auth.json')} 를 못 읽었다 (${(error as Error).message})` };
  }
  const access = parsed?.tokens?.access_token;
  const refresh = parsed?.tokens?.refresh_token;
  if (!access || !refresh) {
    return { ok: false, kind: 'no-tokens', message: '그 홈에 access/refresh 토큰이 없다 — 먼저 그 홈으로 codex login 하라' };
  }
  const storeKey = codexStoreKey(name);
  // ⛔ 미러를 «끈다» — 들여오는 시점에 그 홈을 다시 쓰면 원본을 건드리게 된다. 읽기만 한다.
  // ⛔ `expiresAt: null` — 그 홈의 auth.json 은 만료 시각을 «안 적는다». 모르는 것을 지어내지 않는다.
  //   ⇒ 첫 사용 때 갱신 판정이 「모른다」로 떨어지고, 필요하면 그때 refresh 가 돈다.
  // ⭐⭐ 홈을 «토큰과 함께» 저장한다 — 이후 갱신 때 미러가 «그 홈으로만» 간다(주변 env 무관).
  saveTokens(storeKey, { accessToken: access, refreshToken: refresh, expiresAt: null },
    { authMode: parsed?.auth_mode ?? 'chatgpt', mirrorCodex: false, codexHome: expanded },
    storePath ?? authStorePath());
  // ⛔ 외부 파일의 값이다 — 문자열이라고 «가정»하지 않는다(4R should-fix).
  //   손상된 auth.json 이 런타임 예외가 아니라 「모른다」로 떨어지게 한다.
  const rawId = parsed?.tokens?.account_id;
  const accountIdPrefix = typeof rawId === 'string' && rawId.length > 0 ? rawId.slice(0, 8) : '(없음)';
  return { ok: true, storeKey, accountIdPrefix };
}

export interface ActiveCodexAccountView {
  readonly name: string;
  readonly storeKey: string;
  /** 계정 «이름»이 어디서 왔나. ⭐ `rotated` = 리밋 때문에 시스템이 넘긴 것(사람이 고른 게 아니다). */
  readonly source: CodexAccountResolution['source'];
  /** ⭐ 실제로 미러·영속이 가는 홈. `undefined` = 어디에도 안 간다. */
  readonly home: string | undefined;
  /** 그 홈이 어디서 왔나. */
  readonly homeSource: CodexHomeSource;
  /** env 가 «다른» 홈을 선언했으면 그 값 — 표면이 감추면 안 된다. */
  readonly declaredHome?: string;
}

/**
 * ⛔⭐⭐⭐ **표면이 말할 「활성 계정」 — 런타임과 «같은 자»로 잰다**(4R must-fix).
 *
 * 종전 CLI 는 `resolveCodexAccount().home`(= env 해석)을 그대로 찍었다. 그런데 실제 미러·영속은
 * 정본 기록의 `codexHome` 이 이긴다 ⇒ 둘이 갈리면 ***CLI 가 거짓 상태를 보고했다.***
 * ⛔ 판정층(표면)이 피판정층과 다른 자를 쓰면 안 된다 — 그래서 이 뷰가 `effectiveCodexHome()` 을 쓴다.
 */
/**
 * ⛔⭐⭐ **그 홈의 신호가 «이 계정의 것»이라는 근거가 있나** (2026-08-20 · 대표 지시 · `OBS-T188`).
 *
 * 왜 필요한가 — `effectiveCodexHome` 은 정본이 홈을 모르는 기본 계정을 `~/.codex` 로 «떨어뜨리고»
 * `source: 'default'` 를 낸다. 그 홈의 할당량 신호는 ***누가 썼는지 보증되지 않는다*** —
 * 다른 계정이 같은 홈을 거쳐 갔을 수 있다.
 *
 * 📏 실측(2026-08-20 · [F] 발견 · [T] 재현):
 * ```
 * status      지금 계정 default (source=default) · 사용=0% · 찼나=모름   ⇒ 판정 "not-reached · 정상이다"
 * 실제 호출    third (weekly 100% 소진) 로 나가서 429
 *             429 의 resets_at 1787572020 = third 의 리셋 시각과 «분 단위» 일치
 * 대조        provider codex usage --account default
 *             → "계정 'default' 의 홈을 정본이 모른다 — 먼저 account import 하라"
 * ```
 * 🔑 ⇒ ***CLI 는 「못 잰다」고 «거부»하는데 회전 판정기는 같은 홈에서 「0%」를 «측정값»으로 썼다.***
 * 그래서 「못 쟀다」가 「비어 있다」로 읽히고 ***소진된 자격 위에 그대로 머물렀다.***
 *
 * ⭐ `decideCodexRotation` 은 「모른다」를 «이미» 다룬다(`currentUsageUnknown` → 후보 탐색으로 간다).
 * 막고 있던 것은 판정 로직이 아니라 ***그 입력을 만들 때 「모른다」가 「0%」로 접힌 것***이다.
 *
 * ⛔ `store`(정본이 안다)·`env`(사람이 명시)는 귀속된다. `default`(근거 없이 떨어짐)와
 * `none`(홈 없음)은 귀속되지 않는다.
 * ⚠️ 계정이 하나뿐인 환경은 후보가 없어 `no-candidate` 로 끝나므로 동작이 안 바뀐다.
 */
export function signalAttributableToAccount(home: { readonly source: CodexHomeSource }): boolean {
  return home.source === 'store' || home.source === 'env';
}

export function activeCodexAccountView(
  env: NodeJS.ProcessEnv = process.env,
  storePath?: string,
): ActiveCodexAccountView {
  // ⛔⭐⭐⭐ 표면은 런타임과 «같은 자»를 쓴다(리뷰 must-fix) — 회전까지 반영한 계정이다.
  //   종전엔 회전 «전» 값을 찍어, 리밋으로 넘어간 뒤에도 표면이 옛 계정을 말했다.
  //   ⛔ 그리고 여기에 「주입 가능한 resolver」를 두지 «않는다» — 아무도 안 쓰는 확장은
  //     계약만 넓히고 두 자가 갈릴 자리를 새로 만든다(리뷰 must-fix).
  const account = resolveCodexAccountForRun(env, storePath ? { storePath } : {});
  const stored = loadTokens(account.storeKey, storePath ?? authStorePath());
  const eff = effectiveCodexHome(account, stored, env);
  return {
    name: account.name,
    storeKey: account.storeKey,
    source: account.source,
    home: eff.home,
    homeSource: eff.source,
    ...(eff.declaredHome ? { declaredHome: eff.declaredHome } : {}),
  };
}

/**
 * ⛔⭐⭐⭐ **이 런이 실제로 쓸 계정** — 리밋이면 넘긴다(`S4`).
 *
 * 판정 «자체»는 순수 함수(`decideCodexRotation`)가 하고, 여기서는 그 함수가 볼 것을 «모아» 준다:
 * 지금 계정 · 명시 여부 · config · 계정별 쿼터 신호. ⇒ 「무엇을 보고 정했나」가 인자로 남는다.
 *
 * ⛔ 결정 넷(대표 2026-08-05): ①전환만 자동(크레딧 소비 안 함) ②기본 ON, config 로 끔
 *   ③사람이 명시한 계정은 «안» 넘긴다 ④「모른다」로는 «안» 넘긴다.
 */
/** ⛔⭐⭐⭐ **한 런은 한 계정이다** (리뷰 must-fix).
 *  호출마다 다시 판정하면, 같은 런 안에서 신호가 바뀌는 순간 ***두 계정의 토큰이 섞인다***
 *  (`loadFreshCodexAuthState` 는 요청마다 불린다). ⇒ 런 신원으로 «못 박는다».
 *  ⭐ 부수 효과로 계정 수에 비례하던 동기 디스크 I/O 도 런당 «한 번»으로 준다(리뷰 should-fix).
 *  ⛔ 런 신원이 «없으면» 고정하지 않는다 — 아래 본문 주석 참조(데몬이 영원히 고정되는 것을 막는다). */
interface RunPin {
  readonly resolution: CodexAccountResolution;
  /** ⛔ 핀이 «갇혔는지»를 싸게 재려면 그 계정의 홈이 필요하다. 모르면 재지 못하므로 그대로 둔다. */
  readonly home: string | undefined;
}
const pinnedByRun = new Map<string, RunPin>();
/** ⛔ 상한 — 장수 프로세스에서 runId 수만큼 «영구히» 자라면 안 된다(리뷰 should-fix).
 *  넘치면 가장 오래된 것부터 버린다(삽입 순서 = Map 의 순회 순서). 버려도 «재판정»할 뿐이라 안전하다. */
const PIN_MAX = 256;

/** ⛔ 테스트 심 — 고정을 푼다. 프로덕션에서는 부르지 않는다. */
export function _resetCodexRotationPinForTesting(): void {
  pinnedByRun.clear();
}

/** ⛔⭐⭐ 후보 조립은 «한 자»여야 한다 — 실행 경로와 조회(dry-run)가 다른 자를 쓰면
 *  ***CLI 가 「이렇게 돈다」고 말한 것과 실제로 도는 것이 갈린다.*** 이 트랙이 오늘 그 형태를
 *  네 번 만났다(`activeCodexAccountView` 의 4R must-fix 가 같은 자리다). ⇒ 둘이 이것을 «같이» 쓴다. */
/**
 * ⛔ 핀이 «갇혔나» — 그 계정 «하나»의 할당량 신호만 본다(후보 전수 조립보다 훨씬 싸다).
 * ⛔ 「모른다」는 «넘었다»가 아니다 — 모르면 false 를 돌려 종전 동작을 유지한다.
 *   (모름을 소진으로 읽으면 신호가 없는 기계에서 매 호출 재판정이 돌아 핀이 «무의미»해진다.)
 */
function pinnedAccountExhausted(home: string, accountName: string): boolean {
  const now = Date.now();
  if (readQuotaSignal(now, home) === true) return true;
  const used = readQuotaSignalUsedPercent(now, home);
  if (typeof used !== 'number' || !Number.isFinite(used)) return false;
  // ⛔ 판정이 쓰는 «같은 자»를 쓴다 — 여기서 임계를 다시 지으면 핀과 판정이 갈린다.
  const threshold = codexAccountThresholdPercent(accountName, {
    thresholdPercent: rotationThresholdFromConfig(),
    thresholdPercentByAccount: rotationThresholdsByAccountFromConfig(),
  });
  return used >= threshold;
}

function buildRotationCandidates(path: string, now: number, env: NodeJS.ProcessEnv = process.env): RotationCandidate[] {
  return listCodexAccountsInStore(path)
    .map((row) => {
      const stored = loadTokens(row.storeKey, path);
      // ⛔ 홈을 모르는 «이름» 계정은 후보가 «아니다» — 모르는 곳으로 넘기지 않는다.
      // ⭐ 기본 계정(`openai-codex`)은 정본에 홈을 안 적는다 — 그 홈은 «기본 위치»(`CODEX_HOME` 또는 `~/.codex`)로
      //    이미 정해져 있다(`resolveCodexAccount` · `effectiveCodexHome` 과 같은 해석). 종전엔 이 계정이 후보에서
      //    통째로 빠져, Pod 배분이 default 를 1% 로 두고 «codex 모두 95% 이상 → grok» 으로 갔다(🅢 2026-09-27).
      const home = stored?.codexHome
        ?? (row.storeKey === 'openai-codex' ? resolveCodexAccount({ CODEX_HOME: env.CODEX_HOME } as unknown as NodeJS.ProcessEnv).home : undefined); // CODEX_HOME 한 칸만(이름 계정 설정을 안 끼운다 · 🅢 #21079 의도) — unknown 단언: Next 타입은 ProcessEnv 에 NODE_ENV 를 필수로 더해 PWA 빌드가 깨졌다
      if (!home) return null;
      const usedPercent = readQuotaSignalUsedPercent(now, home);
      return {
        name: row.name,
        storeKey: row.storeKey,
        home,
        reached: readQuotaSignal(now, home),
        ...(usedPercent === undefined ? {} : { usedPercent }),
      };
    })
    .filter((c): c is RotationCandidate => c !== null);
}

function formatUsedPercent(value: number | undefined): string {
  return value === undefined ? 'unknown' : `${value}%`;
}

interface CodexAccountUsageSnapshot {
  readonly knownAccountCount: number;
  /**
   * ⛔⭐⭐⭐ **「어느 신호 디렉터리를 읽고 이 수를 냈나」**(2026-08-19 · `OBS-T113`).
   *
   * 🚨 왜 있나 — 실패 산출물이 `usage: default=unknown team=unknown third=unknown` 이라고만 말했다.
   *   그 한 줄로는 ***「신호가 낡았나 · 아예 없나 · 내가 다른 우주를 봤나 · 옛 코드인가」***를
   *   ***원리상 못 가른다***. 실제로 두 세션이 그 줄 하나로 «세 번» 서로 다른 진단을 냈다.
   * ⇒ 🔑 그래서 ***수 옆에 「어디서 읽었나」를 «값으로» 붙인다***(`F45` — 기준점을 값에).
   */
  readonly signalDir?: string;
  readonly accounts: readonly {
    readonly name: string;
    readonly usedPercent: number | null;
    readonly resetCreditAvailability: 'available' | 'unavailable' | 'unknown';
  }[];
}

function usageSnapshotForStore(path: string, now: number): CodexAccountUsageSnapshot {
  const accounts = listCodexAccountsInStore(path).map((account) => {
    // ⛔⭐ 홈 해석은 쿼터 새로고침과 «같은 정본»이다 — `loadTokens(...).codexHome` 만 보면
    //   기본 계정(기록된 홈이 없음)이 영영 미지가 되어 reset-credit-unknown 으로 도망친다.
    const stored = loadTokens(account.storeKey, path) ?? null;
    const home = effectiveCodexHome(
      { name: account.name, storeKey: account.storeKey, home: defaultCodexHome(), source: 'default' },
      stored,
      process.env,
    ).home?.trim();
    return {
      name: account.name,
      usedPercent: home ? readQuotaSignalUsedPercent(now, home) ?? null : null,
      resetCreditAvailability: resetCreditAvailability(home, now),
    };
  });
  return { knownAccountCount: accounts.length, accounts, signalDir: quotaSignalDir() };
}

let usageSnapshotReader: typeof usageSnapshotForStore = usageSnapshotForStore;

/** 테스트에서 스토어·쿼터 스냅샷 준비 실패를 재현한다. */
export function _setCodexAccountUsageSnapshotReaderForTesting(
  reader: typeof usageSnapshotForStore | null,
): void {
  usageSnapshotReader = reader ?? usageSnapshotForStore;
}

function formatUsageSnapshot(snapshot: CodexAccountUsageSnapshot): string {
  const accounts = snapshot.accounts.map((account) =>
    `${account.name}=${formatUsedPercent(account.usedPercent ?? undefined)} resetCredit=${account.resetCreditAvailability}`,
  ).join(', ') || '(no stored accounts)';
  // ⛔⭐ 「어디서 읽었나」를 «항상» 붙인다 — 이 줄이 사람에게 도달하는 «유일한» 진단인 경우가 많다.
  //   ⚠️ 값이 없으면 «안 붙인다** — 「모른다」를 빈 경로로 적지 않는다.
  return snapshot.signalDir ? `${accounts} @ ${snapshot.signalDir}` : accounts;
}

/** ⛔⭐ 알림 축은 «회전 축과 별개»다 — 2026-08-17 대표 지시("회전을 끄라는 게 아니라 텔레그램 알림만").
 *  종전엔 노브가 `codexAccountRotation` 하나뿐이라, 알림을 끄려면 ***회전(= 구독 과금 경로)까지 죽였다.***
 *  실물: 그날 30분에 133건이 나갔고(13.5초당 1건) 끄는 유일한 길이 회전 정지였는데,
 *  그러자 한도 100% 인 기본 계정에 «고정»돼 구현이 막히는 반대편 사고로 갔다.
 *  ⇒ 기본은 ON 이고 «명시적 false 일 때만» 조용해진다. */
function codexAccountAlertsEnabled(): boolean {
  try {
    return configReader().llm?.codexAccountAlerts !== false;
  } catch {
    return true; // fail-open — 설정을 못 읽는다고 알림을 죽이지 않는다
  }
}

function notifyCodexAccountEvent(event: 'rotation' | 'reset-credit-consumed', details: Record<string, unknown>, text: string): void {
  // ⛔ 끄더라도 «조용히» 사라지지 않는다 — 「왜 알림이 안 오나」를 나중에 로그로 답할 수 있어야 한다.
  if (!codexAccountAlertsEnabled()) {
    debug.log('oauth.codex-account', 'outbound-suppressed', {
      event,
      reason: 'alerts-disabled',
      knob: 'llm.codexAccountAlerts',
      ...details,
    });
    return;
  }
  const attempt = () => {
    const delivered = codexAccountOutboundSender(text, 'alert');
    debug.log('oauth.codex-account', 'outbound', { event, delivered, ...details });
  };
  try {
    attempt();
  } catch (error) {
    debug.log('oauth.codex-account', 'outbound-failed', {
      event,
      message: error instanceof Error ? error.message : String(error),
      ...details,
    }, { level: 'warn' });
  }
}

function notifyCodexAccountEventWithUsage(
  event: 'rotation' | 'reset-credit-consumed',
  path: string,
  now: number,
  details: (usageSnapshot: CodexAccountUsageSnapshot) => Record<string, unknown>,
  text: (usageSnapshot: CodexAccountUsageSnapshot) => string,
): void {
  try {
    const usageSnapshot = usageSnapshotReader(path, now);
    notifyCodexAccountEvent(event, details(usageSnapshot), text(usageSnapshot));
  } catch (error) {
    debug.log('oauth.codex-account', 'outbound-failed', {
      event,
      message: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' });
  }
}

export function notifyCodexResetCreditConsumed(
  account: Pick<CodexAccountResolution, 'name'>,
  remainingCount: number | undefined,
  deps: { readonly storePath?: string; readonly now?: number } = {},
): void {
  const path = deps.storePath ?? authStorePath();
  notifyCodexAccountEventWithUsage('reset-credit-consumed', path, deps.now ?? Date.now(),
    (usageSnapshot) => ({
      account: account.name,
      remainingCount: remainingCount ?? null,
      knownAccountCount: usageSnapshot.knownAccountCount,
      usage: usageSnapshot.accounts,
    }),
    (usageSnapshot) => `🔄 Codex reset credit consumed\naccount: ${account.name}\nremaining: ${remainingCount ?? 'unknown'}\naccountCount: ${usageSnapshot.knownAccountCount}\nusage: ${formatUsageSnapshot(usageSnapshot)}`);
}

/** ⛔ 설정 읽기가 실패해도 조회를 막지 않는다 — 못 읽으면 판정기가 기본 임계를 쓴다. */
function rotationThresholdFromConfig(): unknown {
  try { return configReader().llm?.codexAccountRotationThresholdPercent; } catch { return undefined; }
}

function rotationThresholdsByAccountFromConfig(): Readonly<Record<string, unknown>> | undefined {
  try { return configReader().llm?.codexAccountRotationThresholdPercentByAccount; } catch { return undefined; }
}

/** «먼저 쓸» 계정 순서. ⛔ 문자열 배열이 아니면 「없음」으로 접는다(조용히 부분 적용하지 않는다). */
function accountOrderFromConfig(): readonly string[] | undefined {
  try {
    const raw = (configReader().llm as { codexAccountOrder?: unknown } | undefined)?.codexAccountOrder;
    if (!Array.isArray(raw)) return undefined;
    if (!raw.every((v) => typeof v === 'string' && v.length > 0)) return undefined;
    return raw as readonly string[];
  } catch { return undefined; }
}

/** 현재 저장된 가용 수를 판정의 삼상 계약으로 바꾼다. ⛔ 읽기 실패·손상·만료·음수·비정수는 「없음」이 아니다. */
function resetCreditAvailability(home: string | undefined, now: number): 'available' | 'unavailable' | 'unknown' {
  if (!home?.trim()) return 'unknown';
  const availableCount = readFreshAvailabilityState(now, home);
  if (typeof availableCount !== 'number' || !Number.isFinite(availableCount) || availableCount < 0 || !Number.isInteger(availableCount)) {
    return 'unknown';
  }
  return availableCount > 0 ? 'available' : 'unavailable';
}

/**
 * ⛔⭐⭐⭐⭐ **조회 전용 회전 판정**(dry-run) — 표면이 「지금 부르면 무엇이 나오나」를 묻는 자리.
 *
 * ⛔⭐⭐ **관측을 «안» 남기고 고정도 «안» 한다.** 그것이 이 함수가 따로 있는 이유다 —
 *   `resolveCodexAccountForRun` 은 부를 때마다 `rotation` 관측을 쓰므로, 조회 명령이 그것을 부르면
 *   ***사람이 상태를 «볼 때마다» 회전 통계가 늘어난다.*** 즉 ***판정층이 피판정층을 오염시킨다.***
 *   (운영자는 그 수로 「회전이 도나」를 읽는다 — `rotated 145 : not-reached 18` 같은 것.)
 * ⛔ 네트워크를 안 친다 — 디스크 신호만 읽는다(판정 경로와 같은 규율).
 * ⭐ 후보·임계·현재 상태는 실행 경로와 «같은 자»를 쓴다(`buildRotationCandidates`).
 */
/**
 * ⛔ «캐시만» 읽는다 — 네트워크를 치지 않고 갱신도 유도하지 않는다.
 *   budget 스토어가 이 프로세스에서 안 채워졌으면 스냅샷이 «없고» 그것은 「모른다」다.
 * ⛔ 어떤 실패도 「소진」으로 접지 않는다 — 못 읽으면 unknown 이고, unknown 은 «통과»다.
 */
export function readCachedGrokQuota(): 'usable' | 'exhausted' | 'unknown' {
  try {
    const mod = require('../budget/usage-store.js') as {
      getUsageStore?: () => { getSnapshot?: (p: string) => unknown };
    };
    return grokQuotaFromUsageSnapshot(mod.getUsageStore?.().getSnapshot?.('grok') as never);
  } catch {
    return 'unknown';
  }
}

export function inspectCodexRotation(
  env: NodeJS.ProcessEnv = process.env,
  deps: { readonly storePath?: string; readonly now?: number } = {},
): {
  readonly current: CodexAccountResolution;
  readonly currentHome: string | undefined;
  readonly currentReached: boolean | undefined;
  readonly currentUsedPercent: number | undefined;
  readonly explicit: boolean;
  readonly enabled: boolean;
  /** ⛔ «판정기가 실제로 쓴» 임계다 — raw config 가 아니다(리뷰 must-fix). */
  readonly thresholdPercent: number;
  /** ⭐ 신호 «관측 시각»(ms) — ⛔ «만료돼도» 낸다(나이를 보여야 하므로). */
  readonly currentObservedAt: number | undefined;
  /** ⭐ 그 신호가 «판정에 아직 유효한가». false = 있지만 늙었다(⇒ 판정은 「모른다」). */
  readonly currentSignalFresh: boolean;
  readonly candidates: readonly RotationCandidate[];
  /** ⛔⭐ 정본 스토어가 «아는» 계정 수 — `candidates` 는 «홈을 아는 것»만 남은 목록이라
   *  그것으로 계정 수를 세면 «거짓»이다(리뷰 must-fix: 홈 없는 계정이 안 세어진다). */
  readonly knownAccountCount: number;
  /** ⭐ 후보별 신호 관측 시각(홈으로 찾는다) — ⛔ «만료돼도» 들어 있다. */
  readonly observedAtByHome: Readonly<Record<string, number>>;
  /** ⭐ 후보별 «판정 유효성» — false = 있지만 늙었다. */
  readonly freshByHome: Readonly<Record<string, boolean>>;
  /** Pure rotation authority's account-availability evidence. */
  readonly reason: string;
  readonly candidateCount: number | undefined;
  readonly accountThresholds: ReturnType<typeof decideCodexRotation>['accountThresholds'];
  readonly to: string | undefined;
} {
  const path = deps.storePath ?? authStorePath();
  const now = deps.now ?? Date.now();
  // ⛔ 여기도 «같은 심»을 쓴다 — 한 자리만 고치면 표면과 런타임이 «다른 계정»을 말한다
  //   (2026-08-11 72차: 실제로 그랬다 — 런타임은 고쳤는데 status 가 계속 default 를 말했다).
  const current = resolveCodexAccount(env, { storedHome: (key) => loadTokens(key, path)?.codexHome });
  const explicit = Boolean(env.ELANOUS_CODEX_ACCOUNT?.trim());
  const rotationConfig = readCodexAccountRotationConfig(configReader);
  const enabled = rotationConfig.enabled;
  const currentHomeInfo = effectiveCodexHome(current, loadTokens(current.storeKey, path), env);
  const currentHome = currentHomeInfo.home;
  const candidates = buildRotationCandidates(path, now, env);
  const currentSignalAttributable = signalAttributableToAccount(currentHomeInfo);
  const currentReached = currentSignalAttributable && currentHome ? readQuotaSignal(now, currentHome) : undefined;
  const currentUsedPercent = currentSignalAttributable && currentHome ? readQuotaSignalUsedPercent(now, currentHome) : undefined;
  const rawThreshold = rotationThresholdFromConfig();
  const thresholdPercentByAccount = rotationThresholdsByAccountFromConfig();
  const decision = decideCodexRotation({
    current, explicit, enabled, disabledProvenance: rotationConfig.state, currentReached, currentUsedPercent, accountOrder: accountOrderFromConfig(), resetCreditAvailability: resetCreditAvailability(currentHome, now), thresholdPercent: rawThreshold, thresholdPercentByAccount, candidates,
  });
  // ⛔⭐ 나이는 «만료돼도» 낸다 — 「65분 전」과 「3일 전」은 다른 진단이다(리뷰 must-fix).
  const observedAtByHome: Record<string, number> = {};
  const freshByHome: Record<string, boolean> = {};
  for (const c of candidates) {
    const raw = readQuotaSignalObservedAtRaw(now, c.home);
    if (raw !== undefined) observedAtByHome[c.home] = raw;
    freshByHome[c.home] = readQuotaSignalObservedAt(now, c.home) !== undefined;
  }
  return {
    current, currentHome, currentReached, currentUsedPercent,
    currentObservedAt: currentHome ? readQuotaSignalObservedAtRaw(now, currentHome) : undefined,
    currentSignalFresh: currentHome ? readQuotaSignalObservedAt(now, currentHome) !== undefined : false,
    explicit, enabled,
    // ⛔ 계정에 적용한 «실효» 임계 — 판정기가 실제로 쓴 값이다
    thresholdPercent: codexAccountThresholdPercent(current.name, { thresholdPercent: rawThreshold, thresholdPercentByAccount }),
    candidates, observedAtByHome, freshByHome,
    knownAccountCount: listCodexAccountsInStore(path).length,
    reason: decision.reason, candidateCount: decision.candidateCount, accountThresholds: decision.accountThresholds, to: decision.to?.name,
  };
}

export function resolveCodexAccountForRun(
  env: NodeJS.ProcessEnv = process.env,
  /** ⛔ 「설정을 우회하는 노브」를 두지 않는다(리뷰 must-fix) — 종전 `rotationEnabled` 는
   *  아무도 안 주면서 «config 를 덮을 수 있는» 인자였다. 그런 인자는 수용 기준을 스스로 깬다.
   *  ⊕ `now` 도 아무도 안 주는 죽은 계약이라 지웠다. 남는 것은 «테스트 격리»뿐이다. */
  deps: { readonly storePath?: string } = {},
): CodexAccountResolution {
  // ⛔ 「이름만 주고 홈을 안 준」 경우를 정본 기록으로 메운다 — 안 그러면 조용히 default 로 떨어지고
  //   관측은 `explicit` 이라 말한다(2026-08-11 72차 실측).
  const storePathForHome = deps.storePath ?? authStorePath();
  const current = resolveCodexAccount(env, { storedHome: (key) => loadTokens(key, storePathForHome)?.codexHome });
  const explicit = Boolean(env.ELANOUS_CODEX_ACCOUNT?.trim());
  // ⛔⭐ 사람이 «명시»했으면 고정보다 «먼저» 이긴다(결정 ③) — 고정을 읽지도 쓰지도 않는다.
  //   고정이 앞서면, 앞선 호출이 만든 회전 결과가 「명시한 계정」을 덮는다.
  if (explicit) { observeRotation({ reason: 'explicit' }, current.name); return current; }
  // ⛔⭐⭐⭐ 설정 판정이 «핀보다 먼저»다(리뷰 must-fix).
  //   핀을 먼저 보면, 같은 런에서 이미 회전·핀된 뒤 설정이 false 로 바뀌어도
  //   ***계속 회전 계정을 돌려준다*** — 「config false 로만 꺼진다」가 핀 경유로 깨진다.
  const rotationConfig = readCodexAccountRotationConfig(configReader);
  const enabled = rotationConfig.enabled;
  if (!enabled) {
    observeRotation({ reason: 'disabled', disabledProvenance: rotationConfig.state }, current.name);
    return current;
  }
  // ⛔⭐⭐⭐ 고정은 «런 신원이 있을 때만» 한다.
  //   첫 판은 신원이 없으면 `pid:<pid>` 로 고정했는데, 그러면 ***장수 프로세스(데몬)가 영원히
  //   고정된다*** — 리밋이 풀려도 안 돌아오고, 한 번의 회전이 프로세스 수명 내내 남는다.
  //   ⇒ 신원이 없으면 매번 판정한다(그 편이 「지금 상태」에 정직하다).
  //   ⚠️ 그래서 디스크 I/O 절감은 «런 신원이 있는 경로»에만 적용된다.
  const path = storePathForHome;
  // ⛔ 핀 키에 «스토어 경계»를 넣는다 — 같은 런에서 다른 스토어를 조회하면 다른 답이어야 한다
  //   (리뷰 should-fix: 테스트용 storePath 로 만든 핀이 운영 조회에 재사용될 수 있었다).
  const runId = env.ELANOUS_RUN_ID?.trim();
  const runKey = runId ? `${runId}\u0000${path}` : undefined;
  if (runKey) {
    const pinned = pinnedByRun.get(runKey);
    if (pinned) {
      // ⛔⭐⭐⭐ 2026-09-23 인시던트 — ***핀이 만료되지 않아 소진된 계정에 갇혔다.***
      //   📏 실측: 런 셋이 default·team(둘 다 100% 소진)으로 수천 콜을 냈고, 같은 시각
      //     `third` 는 100% 남은 채 «0건»이었다. `inspectCodexRotation()` 은 그때도
      //     `reason:"rotated" · to:"third"` 라 답했다 — ***판정은 옳았고 핀이 그것을 안 읽었다.***
      //   ⚠️ 위 주석이 *"pid 로 고정하면 장수 «프로세스»가 영원히 고정된다"* 를 이미 적었는데,
      //     ***장수 «런»도 같은 병***이었다. 신원을 바꿔 고쳤지만 «수명» 축은 남아 있었다.
      //
      // ⛔ 그렇다고 핀을 «지우면» 안 된다 — 본래 목적은 「한 런 안에서 토큰이 섞이는 것」을 막는 것이다.
      //   ⇒ ***탈출구를 「그 계정이 임계를 넘었을 때」로만 연다.*** 안 넘었으면 종전 그대로(추가 I/O 는 신호 한 번).
      //   🔑 전환은 «소진당 한 번»으로 갇히고, 그 뒤 다시 핀이 박힌다.
      const pinnedHome = pinned.home;
      const exhausted = pinnedHome !== undefined && pinnedAccountExhausted(pinnedHome, pinned.resolution.name);
      if (!exhausted) return pinned.resolution;
      pinnedByRun.delete(runKey);
      debug.log('oauth.codex-account', 'pin-released',
        { account: pinned.resolution.name, why: 'threshold-reached' }, { level: 'warn' });
    }
  }
  const now = Date.now();
  const currentHomeInfo = effectiveCodexHome(current, loadTokens(current.storeKey, path), env);
  const currentHome = currentHomeInfo.home;
  const candidates = buildRotationCandidates(path, now, env);
  const currentSignalAttributable = signalAttributableToAccount(currentHomeInfo);

  const decision = decideCodexRotation({
    current,
    explicit,
    // ⭐ 기본 ON — «명시적 false 일 때만» 꺼진다.
    enabled,
    disabledProvenance: rotationConfig.state,
    currentReached: currentSignalAttributable && currentHome ? readQuotaSignal(now, currentHome) : undefined,
    currentUsedPercent: currentSignalAttributable && currentHome ? readQuotaSignalUsedPercent(now, currentHome) : undefined,
    resetCreditAvailability: resetCreditAvailability(currentHome, now),
    thresholdPercent: rotationThresholdFromConfig(),
    thresholdPercentByAccount: rotationThresholdsByAccountFromConfig(),
    candidates,
  });
  observeRotation(decision, current.name);
  const resolved = applyRotation(current, decision);
  if (resolved.source === 'rotated') {
    notifyCodexAccountEventWithUsage('rotation', path, now,
      (usageSnapshot) => ({
        from: current.name,
        to: resolved.name,
        reason: decision.reason,
        knownAccountCount: usageSnapshot.knownAccountCount,
        usage: usageSnapshot.accounts,
      }),
      (usageSnapshot) => `🔄 Codex account rotated\nfrom: ${current.name}\nto: ${resolved.name}\nreason: ${decision.reason}\naccountCount: ${usageSnapshot.knownAccountCount}\nusage: ${formatUsageSnapshot(usageSnapshot)}`);
  }
  if (runKey) {
    if (pinnedByRun.size >= PIN_MAX) {
      const oldest = pinnedByRun.keys().next().value;
      if (oldest !== undefined) pinnedByRun.delete(oldest);
    }
    pinnedByRun.set(runKey, { resolution: resolved, home: effectiveCodexHome(resolved, loadTokens(resolved.storeKey, path), env).home });
  }
  return resolved;
}

/**
 * ⛔⭐⭐⭐⭐⭐ **회전한 계정을 «자식 env»로만 내려보낸다** (2026-08-07 · 크레딧 유출 차단).
 *
 * 왜 이것이 있나 — 경로가 «둘»인데 회전이 «하나»에만 닿고 있었다(RFC §8 ⑴ 이 그 둘을 이미 갈라 놨다):
 * ```
 * 경로 A · API provider   loadTokens('openai-codex…') → Bearer   ⇒ 회전이 «닿는다»
 * 경로 B · codex 바이너리  $CODEX_HOME/auth.json 을 읽는다        ⇒ 회전이 «안 닿았다»
 * ```
 * ⇒ 🚨 그래서 리밋에 걸린 계정으로 ACP 자식이 «계속» 쐈고, 그 계정에 크레딧이 남아 있으면
 *   플랜이 아니라 ***유료 크레딧이 소모된다***(2026-08-07 실측: default 는 주간 100% ⊕ 잔액 4974).
 *
 * ⛔⭐⭐ **`process.env` 를 «안» 바꾼다**(RFC §8 ⑵ 불변식) — 바꾸면 같은 프로세스의 미러 쓰기와
 *   계정별 쿼터 측정이 «조용히» 끌려간다. 여기서 내는 것은 자식에게 얹을 «덧칠»뿐이다.
 * ⭐ 「회전했을 때만 낸다」는 «판정»은 순수 함수 `rotatedChildEnv` 가 한다 — 이 함수는
 *   그 함수가 볼 것을(출처 ⊕ 실효 홈) «모아» 줄 뿐이다. 이 파일이 이미 쓰는 갈래와 같다.
 * ⛔ 실패는 삼킨다 — 이 덧칠이 실패해서 ACP 가 «안 뜨는» 일은 없어야 한다.
 *   ⚠️ 다만 «조용히» 삼키지 않는다: 왜 못 냈는지를 관측에 남긴다(안 그러면 빈 덧칠과
 *   「회전 안 함」이 사후에 «안 갈린다» — 오늘 이 트랙이 두 번 만난 형태다).
 */
export function rotatedCodexChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  /** ⛔ 테스트 격리 심 — `resolveCodexAccountForRun` 과 «같은 형태»로 받는다(재발명 0). */
  deps: { readonly storePath?: string } = {},
): Record<string, string> {
  try {
    const account = resolveCodexAccountForRun(env, deps);
    const home = effectiveCodexHome(account, loadTokens(account.storeKey, deps.storePath ?? authStorePath()), env).home;
    return rotatedChildEnv(account.source, home);
  } catch (error) {
    debug.log('oauth.codex-account', 'child-env-failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
    }, { level: 'warn' });
    return {};
  }
}

export interface StoredCodexAccount { name: string; storeKey: string; authMode?: string }

/**
 * 정본 스토어가 «아는» codex 계정 전부.
 * ⛔⭐⭐ 3R must-fix: 종전엔 `['openai-codex']` 하나만 훑어 «이름 계정을 전부 누락»했다
 *   ⇒ `import` 로 들인 계정이 스토어에는 있는데 `account list` 에는 «없다»고 나왔다.
 *   실측(2026-08-05 18:0x): 스토어 키 `openai-codex | openai-codex:team` · 목록 산출은 `default` 하나.
 *   ***조회는 계정별로 안 되고 실행만 되던 것 — 이 PR 이 고치려던 것의 정확한 반대 방향이다.***
 * ⛔ 토큰은 «안» 돌려준다 — 이름과 모드만. ⛔ 비-codex provider 는 안 섞는다.
 * ⛔ 접미가 «부적격»인 키(`openai-codex:` · 구분자 섞인 이름)는 계정으로 «안» 센다(5R should-fix) —
 *   import 가 만들 수 없는 형태이므로, 손으로 편집된 스토어를 계정처럼 보여 주지 않는다.
 */
export function listCodexAccountsInStore(storePath?: string): StoredCodexAccount[] {
  const path = storePath ?? authStorePath();
  return listProviders(path)
    .filter((key) => isCodexStoreKey(key)
      && (key === 'openai-codex' || isValidAccountName(accountNameFromStoreKey(key))))
    .map((key) => {
      const s = loadTokens(key, path);
      return s
        ? { name: accountNameFromStoreKey(key), storeKey: key, ...(s.authMode ? { authMode: s.authMode } : {}) }
        : null;
    })
    .filter((r): r is StoredCodexAccount => r !== null);
}

/**
 * ⛔⭐⭐⭐ **codex 축이 끝난 뒤 «어디로» 가나** — 체인 판정의 «수집기».
 *
 * 판정 «자체»는 순수 함수(`decideFallback`)가 한다. 이 함수는 그 함수가 볼 것을 모은다:
 * 회전 판정 결과 ⊕ config 체인 ⊕ grok 자격. ⇒ 「무엇을 보고 정했나」가 인자로 남는다.
 * (이 파일이 `resolveCodexAccountForRun` 에서 이미 쓰는 갈래와 «같은 형태»다 — 재발명 0.)
 *
 * ⛔ 기본 체인은 `['codex-rotate']` 이라 **옵션을 안 켠 사용자에겐 항상 `stay`** 다(무변경).
 * ⛔ 실패는 삼키되 «조용히»는 아니다 — 못 정했으면 그 사실을 관측에 남기고 `stay` 로 답한다.
 *   (판정이 못 돌아서 백엔드가 안 뜨는 일은 없어야 한다.)
 */
export function resolveRunFallback(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readonly storePath?: string;
    readonly grokAvailable?: boolean;
    /** ⛔ grok «잔량» seam — 안 주면 재지 «않고» 'unknown' 이다(이 판정은 네트워크를 안 친다). */
    readonly grokQuota?: 'usable' | 'exhausted' | 'unknown';
  } & Pick<FallbackInput, 'currentStep' | 'currentCredentialRateLimited'> = {},
): FallbackDecision {
  try {
    const snapshot = inspectCodexRotation(env, deps.storePath ? { storePath: deps.storePath } : {});
    let rotation: RotationOutcome;
    if ((snapshot.reason === 'rotated' || snapshot.reason === 'reset-credit-unknown') && snapshot.to) {
      // ⛔ 스냅샷은 이름만 준다 — 후보 목록에서 «그 객체»를 되찾는다(홈까지 필요하다).
      const to = snapshot.candidates.find((c) => c.name === snapshot.to);
      rotation = to ? { reason: snapshot.reason, to } : { reason: 'no-candidate' };
    } else if (
      snapshot.reason === 'explicit'
      || snapshot.reason === 'disabled'
      || snapshot.reason === 'not-reached'
      || snapshot.reason === 'reset-credit-available'
      || snapshot.reason === 'no-candidate'
    ) {
      rotation = { reason: snapshot.reason };
    } else {
      rotation = { reason: 'no-candidate' };
    }

    const { chain, dropped, usedDefault } = normalizeFallbackChain(configReader().llm?.fallbackChain);
    // ⛔ grok 가용성은 «호출자가 확정»해서 줄 수 있다(테스트 격리). 안 주면 여기서 잰다.
    // ⛔ «가용성 판정»이라 갱신을 유도하지 않는다 — 「자격이 있나」만 묻지 「지금 쓸 수 있나」를 묻지 않는다.
    //   (쓸 수 있는지는 실제 요청 경로가 접힌 해석으로 확인한다.)
    const grokAvailable = deps.grokAvailable ?? resolveGrokCredential() !== null;
    // ⛔ 「지금 쓸 수 있나」는 «자격과 다른 축»이다. 안 주면 'unknown' — 그리고 unknown 은 «통과»다.
    //   ⇒ 「모르고 갔다」와 「알고 갔다」가 관측에서 갈린다(아래 grokQuota).
    const grokQuota = deps.grokQuota ?? readCachedGrokQuota();
    const fallbackBase = { rotation, chain, grokAvailable, grokQuota };
    const fallbackInput: FallbackInput = deps.currentCredentialRateLimited === true && deps.currentStep
      ? { ...fallbackBase, currentStep: deps.currentStep, currentCredentialRateLimited: true }
      : { ...fallbackBase, ...(deps.currentStep ? { currentStep: deps.currentStep } : {}) };
    const decision = decideFallback(fallbackInput);

    debug.log('oauth.fallback-chain', 'decide', {
      rotationReason: rotation.reason,
      chain, usedDefault,
      rotationResult: rotation.reason,
      // ⛔⭐ 「안 줬다」를 «false 로 접지 않는다»(무인 리뷰 must-fix · UNKNOWN-DEFAULT).
      //   호출자가 이 값을 생략하면 그것은 「한도가 아니었다」가 «아니라» ***「안 쟀다」***다.
      //   📌 오늘 같은 축에서 그 병을 이미 한 번 고쳤다(`OBS-T188` — 「못 쟀다」가 「0%」로 접힌 것).
      credentialRateLimited: fallbackInput.currentCredentialRateLimited === undefined
        ? 'unknown'
        : fallbackInput.currentCredentialRateLimited === true,
      selectedChainStep: decision.action === 'codex-rotate' ? 'codex-rotate' : decision.action === 'switch-backend' ? decision.backend : null,
      ...(dropped.length > 0 ? { droppedSteps: dropped } : {}),
      grokAvailable,
      grokQuota,
      action: decision.action,
      ...(decision.action === 'switch-backend' ? { backend: decision.backend } : {}),
      ...(decision.action === 'stay' ? { why: decision.why } : {}),
      ...(decision.action === 'codex-rotate' ? { to: decision.to.name } : {}),
    });
    return decision;
  } catch (err) {
    debug.log('oauth.fallback-chain', 'decide-failed', {
      message: (err as Error)?.message,
    }, { level: 'warn' });
    return { action: 'stay', why: 'not-reached' };
  }
}
