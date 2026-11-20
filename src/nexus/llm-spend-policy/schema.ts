// NEXUS · LLM 지출 정책 — 스키마(검증기)·코드 기본값·출처 병합 (LLM-SPEND-POLICY-ONE-SHOT)
//
// 대표 07:2x: 읽을 때 스키마 검증 — 틀린 키·범위 밖 값(capPct>100 · spendCap<0 · 모르는 공급자)이면
//   거부 + 사유(fail-closed · 이전 정상 정책 유지). 없는 키 = 코드 기본값. 파일은 덮어씀만.
// ⛔ 비밀 0(#107857): 문서 어디에든 키 모양 값(sk-·ghp_·ems_·emt_·eyJ·긴 무작지)이 오면 거부한다.
// ⛔ 직렬화 허용 목록: serializeSpendPolicyDoc 는 알려진 필드만 복사해 디스크에 적는다
//   (vault meta serializer 와 같은 원리 — 몰래 실은 값은 쓰기 전에 떨어진다).
//
// 후속 칸 인터페이스: «패널» 칸은 POST 로 받은 문서를 이 검증기로 먼저 재고(사유를 화면에 그대로),
//   통과한 것만 store.writeStoredSpendPolicy 로 저장한다(owner 인증 · POST+Origin — 칸 문서 참조).

import { RUNTIME_LLM_PROVIDER_NAMES } from '../../user-config.js';
import type {
  AcpDeviceRowPolicy, AutoTopUpState, CreditBalanceState, CreditRowPolicy, LlmSpendPolicyDoc,
  LlmSpendPolicyRole, LlmSpendPolicySource, LlmSpendPolicyValidation, LlmSpendRolePolicy,
  LlmSpendRowKind, LlmSpendRowPolicy, SubscriptionRowPolicy, SubscriptionWindowColumn,
} from './types.js';
import { isLlmSpendPolicyRole, LLM_SPEND_DIFFICULTIES, LLM_SPEND_POLICY_ROLES } from './types.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const percent = (v: unknown): v is number => finite(v) && v >= 0 && v <= 100;

/** 모르는 공급자 거부용 알려진 공급자 — 런타임 공급자 이름(user-config 단일 원전) + ACP 장치 공급자. */
export const KNOWN_SPEND_PROVIDERS: readonly string[] = [
  ...RUNTIME_LLM_PROVIDER_NAMES.filter((name) => name !== 'auto'),
  'claude-acp',
];

/** 행 키(계정·공급자 행 id) 모양 — vault meta id 와 같은 부류의 짧은 식별자. */
const ROW_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 금고 항목 이름 모양 — vault meta `ITEM_ID`(oauth:<provider>:<account> · cred:<id>.<field>). */
const VAULT_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

// ── 비밀 모양 거부(JUD ① — 정책에는 금고 «이름» 만 있어야 한다) ───────────────────

const SECRET_PREFIX_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^sk-[A-Za-z0-9_-]{8,}$/, why: 'sk- (OpenAI 스타일 키)' },
  { pattern: /^ghp_[A-Za-z0-9]{16,}$/, why: 'ghp_ (GitHub 토큰)' },
  { pattern: /^ems_[A-Za-z0-9_-]{8,}$/, why: 'ems_ 토큰' },
  { pattern: /^emt_[A-Za-z0-9_-]{8,}$/, why: 'emt_ 토큰' },
  { pattern: /^eyJ[A-Za-z0-9_-]{8,}\./, why: 'eyJ… (JWT)' },
  { pattern: /^AKIA[A-Z0-9]{12,}$/, why: 'AKIA… (AWS 키)' },
  { pattern: /^AIza[A-Za-z0-9_-]{20,}$/, why: 'AIza… (Google 키)' },
  { pattern: /^gsk_[A-Za-z0-9]{16,}$/, why: 'gsk_ (Groq 토큰)' },
];

/**
 * «긴 무작위» 판정: 32자 이상 · [A-Za-z0-9_-] 만 · 숫자·글자 섞임.
 * 사람이 지은 하이픈 낱말 모델명(claude-3-7-sonnet-20250219-thinking 처럼 마디마다 ≤24자)은
 * 모델 목록에 실려 오므로 허용한다 — 실제 토큰은 마디 구분이 없다.
 */
export function looksLikeLongRandom(value: string): boolean {
  if (value.length < 32 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (value.includes('-')) {
    const segments = value.split('-');
    if (segments.length >= 2 && segments.every((s) => s.length >= 1 && s.length <= 24)) return false;
  }
  return true;
}

/** 값이 비밀 키 모양이면 그 이유, 아니면 null. 문서의 «모든» 문자열 잎에 적용한다. */
export function secretShapeReason(value: string): string | null {
  for (const { pattern, why } of SECRET_PREFIX_PATTERNS) {
    if (pattern.test(value)) return why;
  }
  if (looksLikeLongRandom(value)) return '긴 무작지 문자열(32자 이상 · 마디 구분 없음)';
  return null;
}

/** 알려진 비밀 접두(길이 무관) — 짧아도 오류 문구에는 원문을 싣지 않는다. */
const SECRET_LIKE_PREFIX = /^(sk-|ghp_|ems_|emt_|eyJ|AKIA|AIza|gsk_)/;
/** 오류 문구에 싣는 사용자 입력 토큰의 최대 길이 — 그보다 길면 원문 대신 길이만. */
const SAFE_TOKEN_MAX_LEN = 48; // 출처: #39171 JUD 판정(우편 #109425) — 오류 문구에는 짧은 «이름» 만, 긴 값은 위치·길이만

/**
 * ⛔ 오류 문구에 사용자 입력(키·값 원문)을 넣는 «유일한» 길 — 비밀 모양이거나 너무 길면 `<redacted len=N>`(길이만).
 * 모든 오류 생성 지점은 이 함수를 거친다(검증기·저장·CLI 출력에 비밀 원문 0).
 */
export function safeToken(value: unknown): string {
  if (typeof value !== 'string') return `<${typeof value}>`;
  if (secretShapeReason(value) !== null || SECRET_LIKE_PREFIX.test(value) || value.length > SAFE_TOKEN_MAX_LEN) {
    return `<redacted len=${value.length}>`;
  }
  return value;
}

/** 문서 전체를 깊이 걸어 모든 문자열 잎에 비밀 모양 검사를 한다(몰래 싣는 경로 차단). */
function collectSecretShapeErrors(value: unknown, prefix: string, errors: string[]): void {
  if (typeof value === 'string') {
    const why = secretShapeReason(value);
    if (why) errors.push(`${prefix} 이(가) 비밀 키 모양이다(${why}) — 정책에는 금고 항목 «이름» 만`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectSecretShapeErrors(item, `${prefix}[${i}]`, errors));
    return;
  }
  if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      // 매핑 «키» 도 검사한다(공급자 행 키로 비밀을 몰래 싣는 경로 차단). 오류에는 키 값을 찍지 않는다.
      const keyWhy = secretShapeReason(key);
      if (keyWhy) errors.push(`${prefix} 의 매핑 키가 비밀 키 모양이다(${keyWhy}) — 키는 «이름» 만`);
      collectSecretShapeErrors(item, `${prefix}.${safeToken(key)}`, errors);
    }
  }
}

// ── 코드 기본값(대표 초안 · OP 제안 — YAML 이 없을 때의 적용 값) ───────────────────

/**
 * ⭐ 이 기본값은 «오늘의 코드 기본»이지 어느 한 기계의 스냅샷이 아니다(llm-policy.ts 와 같은 규약).
 *   - capPct: default 95 · team 60 · third 60(대표 11-18 제안 · TA 는 대표 이 상향)
 *   - claude 라인 상한 85: 기존 claude-acp 상한 관례(07:5x) — claude-code-sub 도 같은 축으로 둔다.
 *   - OR spendCap 일 $300: 대표 확정 전 기본값.
 *   - OR spendCap 월(monthlyUsd): 키만 허용 · 값 «대표 확정 대기» — 미설정 = 월 상한 없음(일 상한만 적용). 결정 함수는 설정된 상한만 본다.
 *   - 공급 순서: codex 구독 → Claude Code 구독(09:00 리셋) → 유료 크레딧(TC #108130).
 *   - onExhausted: codex 구독 → 다른 codex 구독 → Claude 구독 → OR 크레딧 → 멈춤(대표 초안).
 *   - creditOk: review·judgement = true(품질 우선) · ta-child = false(멈추고 기다림) — 빠짐 = false.
 *   - 금고 이름은 확립된 관례(oauth:codex:<account>)만 적는다 — claude·OR 행은 GUARD 칸이
 *     금고 등록을 마치면 저장 정책이 채운다(코드가 이름을 지어내지 않는다).
 */
export function defaultSpendPolicyDoc(): LlmSpendPolicyDoc {
  return {
    version: 1,
    providers: {
      'codex-default': {
        kind: 'subscription', provider: 'openai-codex', vault: 'oauth:codex:default',
        window: { hours: 5 }, capPct: 95,
        onExhausted: ['codex-team', 'codex-third', 'claude-code-sub', 'claude-acp', 'openrouter', 'stop'],
      },
      'codex-team': {
        kind: 'subscription', provider: 'openai-codex', vault: 'oauth:codex:team',
        window: { hours: 5 }, capPct: 60,
        onExhausted: ['codex-third', 'claude-code-sub', 'claude-acp', 'openrouter', 'stop'],
      },
      'codex-third': {
        kind: 'subscription', provider: 'openai-codex', vault: 'oauth:codex:third',
        window: { hours: 168 }, capPct: 60,
        onExhausted: ['claude-code-sub', 'claude-acp', 'openrouter', 'stop'],
      },
      'claude-code-sub': {
        kind: 'subscription', provider: 'anthropic',
        window: { resetAt: '09:00' }, capPct: 85,
        onExhausted: ['claude-acp', 'openrouter', 'stop'],
      },
      'claude-acp': {
        kind: 'acp-device', provider: 'claude-acp', hostOnly: true, maxSessions: 4, capPct: 85,
        onExhausted: ['openrouter', 'stop'],
      },
      openrouter: {
        kind: 'credit', provider: 'openrouter',
        models: ['openrouter/z-ai/glm-5.3'], spendCap: { dailyUsd: 300 },
        autoTopUp: { status: 'unmeasured', reason: 'not-provided' },
      },
    },
    fallbackOrder: ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-acp', 'openrouter'],
    returnOnReset: true,
    shiftOrder: ['ta-child', 'hand-seat', 'authoring'],
    roles: {
      review: { prefer: [], creditOk: true, deny: [] },
      judgement: { prefer: [], creditOk: true, deny: [] },
      'ta-child': { prefer: [], creditOk: false, deny: [] },
    },
  };
}

// ── 검증기 ─────────────────────────────────────────────────────────────────────

export interface ValidateSpendPolicyOptions {
  /**
   * 교차 참조(fallbackOrder·onExhausted)가 가리켜도 되는 «알려진 행» 전체.
   * 저장 문서는 기본 행(codex-default 등)을 덮어쓰지 않고 참조만 할 수 있으므로,
   * 저장소는 기본 행 키를 합쳐 넘긴다. 판정·직렬화 전에는 반드시 통과해야 한다.
   */
  readonly knownRows?: readonly string[];
  /**
   * 기본 문서의 행(kind 포함) — «없는 키 = 코드 기본값» 을 지킨다:
   * 같은 키·같은 kind 의 기본 행을 덮어쓰는 행은 잎을 생략해도 좋다(병합이 채운다).
   * 새 행(기본 문서에 없는 행)은 kind 에 필수인 칼럼(capPct)을 스스로 가져야 한다.
   */
  readonly baseRows?: Readonly<Record<string, LlmSpendRowKind>>;
}

const isRowKind = (v: unknown): v is LlmSpendRowKind => v === 'subscription' || v === 'credit' || v === 'acp-device';
const isKnownProvider = (v: unknown): v is string => typeof v === 'string' && (KNOWN_SPEND_PROVIDERS as readonly string[]).includes(v);
const isVaultItemName = (v: unknown): v is string => typeof v === 'string' && VAULT_ITEM_ID.test(v);
const isRowKey = (v: unknown): v is string => typeof v === 'string' && ROW_KEY.test(v);
const isResetAt = (v: unknown): v is string => typeof v === 'string' && (HHMM.test(v) || ISO_DATETIME.test(v));

function validateWindow(v: unknown, path: string, errors: string[]): SubscriptionWindowColumn | undefined {
  if (v === undefined) return undefined;
  if (!object(v)) { errors.push(`${path}.window must be a mapping`); return undefined; }
  const keys = Object.keys(v);
  for (const key of keys) {
    if (key !== 'hours' && key !== 'resetAt') errors.push(`unknown field ${path}.window.${safeToken(key)}`);
  }
  let hours: number | undefined;
  if (v.hours !== undefined) {
    if (!finite(v.hours) || v.hours <= 0 || v.hours > 24 * 31) errors.push(`${path}.window.hours is out of range (0 < hours ≤ ${24 * 31})`);
    else hours = v.hours;
  }
  let resetAt: string | undefined;
  if (v.resetAt !== undefined) {
    if (!isResetAt(v.resetAt)) errors.push(`${path}.window.resetAt must be 'HH:MM' or an ISO datetime`);
    else resetAt = v.resetAt;
  }
  return { ...(hours !== undefined ? { hours } : {}), ...(resetAt !== undefined ? { resetAt } : {}) };
}

function validateOnExhausted(v: unknown, path: string, knownRows: readonly string[], errors: string[]): readonly (string | 'stop')[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) { errors.push(`${path}.onExhausted must be a list of row keys ending in 'stop'`); return undefined; }
  const seen = new Set<string>();
  for (const entry of v) {
    if (entry === 'stop') continue;
    if (!nonempty(entry)) { errors.push(`${path}.onExhausted has an empty entry`); continue; }
    if (!knownRows.includes(entry)) errors.push(`${path}.onExhausted references unknown row '${safeToken(entry)}'`);
    if (seen.has(entry)) errors.push(`${path}.onExhausted repeats '${safeToken(entry)}'`);
    seen.add(entry);
  }
  return v as readonly (string | 'stop')[];
}

function validateAutoTopUp(v: unknown, path: string, errors: string[]): AutoTopUpState | undefined {
  if (v === undefined) return undefined;
  if (!object(v)) { errors.push(`${path}.autoTopUp must be a mapping`); return undefined; }
  if (v.status === 'measured') {
    const keys = Object.keys(v);
    for (const key of keys) {
      if (!['status', 'enabled', 'amountUsd', 'source', 'observedAt'].includes(key)) errors.push(`unknown field ${path}.autoTopUp.${safeToken(key)}`);
    }
    if (typeof v.enabled !== 'boolean') errors.push(`${path}.autoTopUp.enabled must be a boolean`);
    if (v.amountUsd !== undefined && (!finite(v.amountUsd) || v.amountUsd < 0)) errors.push(`${path}.autoTopUp.amountUsd is out of range`);
    if (typeof v.observedAt !== 'string' || !Number.isFinite(Date.parse(v.observedAt))) errors.push(`${path}.autoTopUp.observedAt must be an ISO datetime`);
    return v as AutoTopUpState;
  }
  if (v.status === 'unmeasured') {
    if (typeof v.reason !== 'string' || !v.reason.trim()) errors.push(`${path}.autoTopUp.reason must be a non-empty string`);
    return v as AutoTopUpState;
  }
  errors.push(`${path}.autoTopUp.status must be 'measured' or 'unmeasured'`);
  return undefined;
}

/**
 * 지출 정책 문서 하나를 검증한다. «틀린 키·범위 밖 값·모르는 공급자·비밀 모양» 전부 여기서 걸린다.
 * 반환은 검증 결과만 — 실패해도 예외를 던지지 않는다(호출자가 사유를 원장·화면에 쓴다).
 */
export function validateSpendPolicyDoc(input: unknown, opts: ValidateSpendPolicyOptions = {}): LlmSpendPolicyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!object(input)) return { valid: false, errors: ['spend policy must be a mapping'], warnings };

  // 비밀 모양 검사를 «먼저» — 문서 전체의 문자열 잎·매핑 키(몰래 실은 값도 잡는다). 이후 모든 오류 문구는 safeToken 을 거친다.
  collectSecretShapeErrors(input, 'spend policy', errors);

  for (const key of Object.keys(input)) {
    if (!['version', 'providers', 'fallbackOrder', 'returnOnReset', 'roles', 'shiftOrder'].includes(key)) {
      errors.push(`unknown field ${safeToken(key)}`);
    }
  }
  if (input.version !== undefined && input.version !== 1) errors.push('version must be 1');
  if (input.version === undefined) warnings.push('version missing; assumed 1');

  // 행(계정·공급자마다 한 행)
  const providers: Record<string, LlmSpendRowPolicy> = {};
  if (input.providers !== undefined) {
    if (!object(input.providers)) errors.push('providers must be a mapping of row key → one row');
    else {
      for (const [rowKey, rowRaw] of Object.entries(input.providers)) {
        const path = `providers.${safeToken(rowKey)}`;
        if (!isRowKey(rowKey)) { errors.push(`bad row key '${safeToken(rowKey)}' (영숫자 시작 · [A-Za-z0-9._-] · 64자 이내)`); continue; }
        if (!object(rowRaw)) { errors.push(`${path} must be a mapping`); continue; }
        for (const key of Object.keys(rowRaw)) {
          if (!['kind', 'provider', 'vault', 'window', 'capPct', 'onExhausted', 'models', 'spendCap', 'autoTopUp', 'hostOnly', 'maxSessions'].includes(key)) {
            errors.push(`unknown field ${path}.${safeToken(key)}`);
          }
        }
        // kind 해석: 적었으면 그대로, 생략했으면 «기본 행을 덮어쓰는 부분 행» 으로 기본 kind 로 검증한다.
        if (rowRaw.kind !== undefined && !isRowKind(rowRaw.kind)) { errors.push(`${path}.kind must be subscription|credit|acp-device`); continue; } // 명시된 무효 kind 는 «생략» 이 아니다(fail-closed)
        const declaredKind = isRowKind(rowRaw.kind) ? rowRaw.kind : undefined;
        const baseKind = opts.baseRows?.[rowKey];
        if (!declaredKind && !baseKind) { errors.push(`${path}.kind must be subscription|credit|acp-device`); continue; }
        if (declaredKind && baseKind !== undefined && declaredKind !== baseKind) {
          errors.push(`${path}.kind mismatch with default row (${baseKind} → ${declaredKind}) — 전체 행을 같은 kind 로 쓰라`);
          continue;
        }
        const kind: LlmSpendRowKind = declaredKind ?? baseKind!;
        if (rowRaw.provider === undefined) {
          if (baseKind === undefined) errors.push(`${path}.provider is required for new rows`);
        } else if (!isKnownProvider(rowRaw.provider)) { errors.push(`${path}.provider '${safeToken(rowRaw.provider)}' is not a known provider (${KNOWN_SPEND_PROVIDERS.join(', ')})`); }
        if (rowRaw.vault !== undefined && !isVaultItemName(rowRaw.vault)) {
          errors.push(`${path}.vault must be a vault item «name» (예: oauth:codex:default) — 값이 아니다`);
        }
        if (kind === 'subscription' || kind === 'acp-device') {
          const window = validateWindow(rowRaw.window, path, errors);
          const overlaysBaseRow = baseKind === kind;
          if (rowRaw.capPct === undefined) {
            if (!overlaysBaseRow) errors.push(`${path}.capPct is required for new ${kind} rows`);
          }
          else if (!percent(rowRaw.capPct)) errors.push(`${path}.capPct is out of range (0..100)`);
          if (kind === 'acp-device') {
            if (rowRaw.hostOnly !== undefined && typeof rowRaw.hostOnly !== 'boolean') errors.push(`${path}.hostOnly must be a boolean`);
            if (rowRaw.maxSessions !== undefined && (!finite(rowRaw.maxSessions) || !Number.isInteger(rowRaw.maxSessions) || rowRaw.maxSessions < 1 || rowRaw.maxSessions > 1000)) {
              errors.push(`${path}.maxSessions is out of range (정수 1..1000)`);
            }
          } else if (rowRaw.hostOnly !== undefined || rowRaw.maxSessions !== undefined) {
            errors.push(`unknown field ${path}.${rowRaw.hostOnly !== undefined ? 'hostOnly' : 'maxSessions'} (subscription rows do not take acp-device columns)`);
          }
          const onExhausted = validateOnExhausted(rowRaw.onExhausted, path, [...(opts.knownRows ?? []), ...Object.keys(input.providers)], errors);
          providers[rowKey] = kind === 'subscription'
            ? { kind: 'subscription', provider: rowRaw.provider as string, ...(rowRaw.vault ? { vault: rowRaw.vault as string } : {}), ...(window ? { window } : {}), capPct: rowRaw.capPct as number, onExhausted: onExhausted ?? [] }
            : { kind: 'acp-device', provider: rowRaw.provider as string, ...(rowRaw.vault ? { vault: rowRaw.vault as string } : {}), ...(window ? { window } : {}), hostOnly: rowRaw.hostOnly === undefined ? true : rowRaw.hostOnly as boolean, ...(finite(rowRaw.maxSessions) ? { maxSessions: rowRaw.maxSessions } : {}), capPct: rowRaw.capPct as number, onExhausted: onExhausted ?? [] };
        } else {
          if (rowRaw.capPct !== undefined || rowRaw.onExhausted !== undefined || rowRaw.window !== undefined || rowRaw.hostOnly !== undefined || rowRaw.maxSessions !== undefined) {
            errors.push(`unknown fields on credit row ${path} (capPct·onExhausted·window·hostOnly·maxSessions are subscription/acp-device columns)`);
          }
          if (rowRaw.models !== undefined) {
            if (!Array.isArray(rowRaw.models) || rowRaw.models.length === 0 || !rowRaw.models.every(nonempty)) {
              errors.push(`${path}.models must be a non-empty list of model ids`);
            }
          }
          if (rowRaw.spendCap !== undefined) {
            if (!object(rowRaw.spendCap)) errors.push(`${path}.spendCap must be a mapping (dailyUsd|monthlyUsd)`);
            else {
              for (const key of Object.keys(rowRaw.spendCap)) {
                if (key !== 'dailyUsd' && key !== 'monthlyUsd') errors.push(`unknown field ${path}.spendCap.${safeToken(key)}`);
              }
              for (const [key, value] of Object.entries(rowRaw.spendCap)) {
                if (!finite(value) || value < 0) errors.push(`${path}.spendCap.${safeToken(key)} is out of range (0 이상)`);
              }
            }
          }
          const autoTopUp = validateAutoTopUp(rowRaw.autoTopUp, path, errors);
          providers[rowKey] = {
            kind: 'credit', provider: rowRaw.provider as string, ...(rowRaw.vault ? { vault: rowRaw.vault as string } : {}),
            models: Array.isArray(rowRaw.models) ? rowRaw.models as string[] : [],
            spendCap: object(rowRaw.spendCap) ? {
              ...(finite(rowRaw.spendCap.dailyUsd) ? { dailyUsd: rowRaw.spendCap.dailyUsd } : {}),
              ...(finite(rowRaw.spendCap.monthlyUsd) ? { monthlyUsd: rowRaw.spendCap.monthlyUsd } : {}),
            } : {},
            ...(autoTopUp ? { autoTopUp } : {}),
          };
        }
      }
    }
  }

  // 전역 순서
  if (input.fallbackOrder !== undefined) {
    if (!Array.isArray(input.fallbackOrder) || input.fallbackOrder.length === 0) {
      errors.push('fallbackOrder must be a non-empty list of row keys');
    } else {
      const known = [...(opts.knownRows ?? []), ...Object.keys(input.providers ?? {})];
      const seen = new Set<string>();
      for (const entry of input.fallbackOrder) {
        if (!nonempty(entry)) { errors.push('fallbackOrder has an empty entry'); continue; }
        if (!known.includes(entry)) errors.push(`fallbackOrder references unknown row '${safeToken(entry)}'`);
        if (seen.has(entry)) errors.push(`fallbackOrder repeats '${safeToken(entry)}'`);
        seen.add(entry);
      }
    }
  }

  if (input.returnOnReset !== undefined && typeof input.returnOnReset !== 'boolean') {
    errors.push('returnOnReset must be a boolean');
  }

  if (input.shiftOrder !== undefined) {
    if (!Array.isArray(input.shiftOrder)) errors.push('shiftOrder must be a list of roles');
    else {
      const seenRoles = new Set<string>();
      for (const entry of input.shiftOrder) {
        if (!isLlmSpendPolicyRole(entry)) errors.push(`shiftOrder has unknown role '${safeToken(entry)}'`);
        else if (seenRoles.has(entry)) errors.push(`shiftOrder repeats '${safeToken(entry)}'`);
        else seenRoles.add(entry);
      }
    }
  }

  // 역할 절
  if (input.roles !== undefined) {
    if (!object(input.roles)) errors.push('roles must be a mapping of role → {prefer, creditOk, deny}');
    else {
      for (const [role, roleRaw] of Object.entries(input.roles)) {
        const path = `roles.${safeToken(role)}`;
        if (!isLlmSpendPolicyRole(role)) { errors.push(`unknown role '${safeToken(role)}' (${LLM_SPEND_POLICY_ROLES.join(', ')})`); continue; }
        if (!object(roleRaw)) { errors.push(`${path} must be a mapping`); continue; }
        for (const key of Object.keys(roleRaw)) {
          if (!['prefer', 'creditOk', 'deny', 'difficulty', 'creditSpendCap'].includes(key)) errors.push(`unknown field ${path}.${safeToken(key)}`);
        }
        if (roleRaw.difficulty !== undefined) {
          if (!object(roleRaw.difficulty)) errors.push(`${path}.difficulty must be a mapping (high|mid|low → model list)`);
          else {
            for (const [level, list] of Object.entries(roleRaw.difficulty)) {
              if (!(LLM_SPEND_DIFFICULTIES as readonly string[]).includes(level)) errors.push(`unknown field ${path}.difficulty.${safeToken(level)} (high|mid|low)`);
              else if (!Array.isArray(list) || !list.every(nonempty)) errors.push(`${path}.difficulty.${safeToken(level)} must be a list of non-empty strings`);
            }
          }
        }
        if (roleRaw.creditSpendCap !== undefined) {
          if (!object(roleRaw.creditSpendCap)) errors.push(`${path}.creditSpendCap must be a mapping (dailyUsd|monthlyUsd)`);
          else {
            for (const [key, value] of Object.entries(roleRaw.creditSpendCap)) {
              if (key !== 'dailyUsd' && key !== 'monthlyUsd') errors.push(`unknown field ${path}.creditSpendCap.${safeToken(key)}`);
              else if (!finite(value) || value < 0) errors.push(`${path}.creditSpendCap.${safeToken(key)} is out of range (0 이상)`);
            }
          }
        }
        for (const listKey of ['prefer', 'deny']) {
          const list = roleRaw[listKey];
          if (list !== undefined && (!Array.isArray(list) || !list.every(nonempty))) {
            errors.push(`${path}.${listKey} must be a list of non-empty strings`);
          }
        }
        if (roleRaw.creditOk !== undefined && typeof roleRaw.creditOk !== 'boolean') {
          errors.push(`${path}.creditOk must be a boolean`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── 출처 병합(없는 키 = 코드 기본값 · 각 값 출처 default/stored 표기) ───────────────

function setOwn(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!object(value) || Object.keys(value).length === 0) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, item]) => leafPaths(item, prefix ? `${prefix}.${key}` : key));
}

function mergeOverlay(base: Obj, overlay: Obj, sources: Record<string, LlmSpendPolicySource>, source: LlmSpendPolicySource, prefix = ''): void {
  for (const [key, value] of Object.entries(overlay)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (object(value) && Object.hasOwn(base, key) && object(base[key])) {
      mergeOverlay(base[key] as Obj, value, sources, source, path);
    } else {
      setOwn(base, key, value !== null && typeof value === 'object' ? structuredClone(value) : value);
      for (const leaf of leafPaths(value, path)) setOwn(sources, leaf, source);
    }
  }
}

/** 기본 문서의 잎 전부에 'default' 출처를 심는다(llm-policy.ts sources 관행과 같은 모양). */
export function defaultSpendPolicySources(): Record<string, LlmSpendPolicySource> {
  return Object.fromEntries(leafPaths(defaultSpendPolicyDoc()).map((p) => [p, 'default' as const]));
}

export interface AppliedSpendPolicy {
  readonly policy: LlmSpendPolicyDoc;
  readonly sources: Record<string, LlmSpendPolicySource>;
}

/**
 * 저장 문서(«검증 통과한» 것만 넘겨라)를 기본 문서 위에 덮어쓴다.
 * ⛔ 행 단위 규칙: 같은 키의 행은 «잎별» 로 병합된다(없는 키 = 코드 기본값). 같은 키에
 *   kind 가 다르면 fail-closed — 병합을 거부하고 오류로 돌려준다(반쪽 행이 실행에 섞이지 않게).
 *   삭제는 오버레이로 불가능하다(덮어씀만 — 제거는 «패널» 칸의 저장소 직접 쓰기).
 */
export function applySpendPolicyOverlay(stored: unknown): AppliedSpendPolicy | { error: string } {
  if (!object(stored)) return { error: 'stored spend policy must be a mapping' };
  const policy = defaultSpendPolicyDoc() as unknown as Obj;
  const sources = defaultSpendPolicySources();
  if (object(stored.providers)) {
    const defaultRows = policy.providers as Obj;
    for (const [rowKey, rowRaw] of Object.entries(stored.providers)) {
      // kind 를 «적은» 경우에만 같은지 본다 — 부분 행(kind 생략 = 잎별 덮어씀)은 통과.
      if (object(rowRaw) && rowRaw.kind !== undefined && Object.hasOwn(defaultRows, rowKey)
        && (defaultRows[rowKey] as { kind?: unknown }).kind !== rowRaw.kind) {
        return { error: `providers.${safeToken(rowKey)} kind mismatch with default row (${safeToken((defaultRows[rowKey] as { kind?: unknown }).kind)} → ${safeToken(rowRaw.kind)}) — 전체 행을 같은 kind 로 쓰라` };
      }
    }
  }
  mergeOverlay(policy, stored as Obj, sources, 'stored');
  // 병합 뒤 정규화 — 새 행이 선택 칼럼(models/spendCap/onExhausted/hostOnly)을 생략하면
  // fail-closed 규약값(빈 목록 · 기본 true)으로 완성한다(판정·렌더가 빈 컨테이너를 가정한다).
  const providers = policy.providers as Obj;
  for (const row of Object.values(providers)) {
    const typed = row as { kind?: unknown; models?: unknown; spendCap?: unknown; onExhausted?: unknown; hostOnly?: unknown };
    if (typed.kind === 'credit') {
      if (!Array.isArray(typed.models)) setOwn(row as Obj, 'models', []);
      if (!object(typed.spendCap)) setOwn(row as Obj, 'spendCap', {});
    } else if (typed.kind === 'subscription' || typed.kind === 'acp-device') {
      if (!Array.isArray(typed.onExhausted)) setOwn(row as Obj, 'onExhausted', []);
      if (typed.kind === 'acp-device' && typeof typed.hostOnly !== 'boolean') setOwn(row as Obj, 'hostOnly', true);
    }
  }
  return { policy: policy as unknown as LlmSpendPolicyDoc, sources };
}

// ── 직렬화 허용 목록(디스크에 적는 필드만 — 알려지지 않은 키는 쓰기 전에 떨어진다) ──

export function serializeSpendPolicyRow(row: LlmSpendRowPolicy): Obj {
  const out: Obj = { kind: row.kind };
  if (row.provider !== undefined) out.provider = row.provider; // 부분 행(저장 덮어씀)은 provider 생략 가능
  if (row.vault !== undefined) out.vault = row.vault;
  if (row.kind === 'credit') {
    if (row.models !== undefined) out.models = [...row.models];
    if (row.spendCap !== undefined) out.spendCap = { ...row.spendCap };
    if (row.autoTopUp !== undefined) out.autoTopUp = structuredClone(row.autoTopUp);
  } else {
    if (row.window !== undefined) out.window = { ...row.window };
    if (row.capPct !== undefined) out.capPct = row.capPct; // 부분 행(오버레이)은 생략 가능 — undefined 를 null 로 적지 않는다.
    if (row.onExhausted !== undefined) out.onExhausted = [...row.onExhausted];
    if (row.kind === 'acp-device' && row.hostOnly !== undefined) out.hostOnly = row.hostOnly;
    if (row.kind === 'acp-device' && row.maxSessions !== undefined) out.maxSessions = row.maxSessions;
  }
  return out;
}

export function serializeSpendPolicyDoc(doc: LlmSpendPolicyDoc): Obj {
  const roles: Obj = {};
  for (const [role, rolePolicy] of Object.entries(doc.roles ?? {})) {
    if (!rolePolicy) continue;
    if (!isLlmSpendPolicyRole(role)) continue;
    const out: Obj = {};
    if (rolePolicy.prefer !== undefined && rolePolicy.prefer.length > 0) out.prefer = [...rolePolicy.prefer];
    if (rolePolicy.deny !== undefined && rolePolicy.deny.length > 0) out.deny = [...rolePolicy.deny];
    if (rolePolicy.creditOk !== undefined) out.creditOk = rolePolicy.creditOk;
    if (rolePolicy.difficulty !== undefined) out.difficulty = Object.fromEntries(Object.entries(rolePolicy.difficulty).map(([k, v]) => [k, [...(v ?? [])]]));
    if (rolePolicy.creditSpendCap !== undefined) out.creditSpendCap = { ...rolePolicy.creditSpendCap };
    setOwn(roles, role, out);
  }
  const providers: Obj = {};
  for (const [rowKey, row] of Object.entries(doc.providers ?? {})) setOwn(providers, rowKey, serializeSpendPolicyRow(row as LlmSpendRowPolicy));
  const out: Obj = { version: 1, providers };
  if (doc.fallbackOrder !== undefined) out.fallbackOrder = [...doc.fallbackOrder];
  if (doc.returnOnReset !== undefined) out.returnOnReset = doc.returnOnReset;
  if (doc.shiftOrder !== undefined) out.shiftOrder = [...doc.shiftOrder];
  if (Object.keys(roles).length > 0) out.roles = roles;
  return out;
}

// ── 역할 해석(creditOk 빠짐 = false — fail-closed) ─────────────────────────────

export function resolveSpendRolePolicy(doc: LlmSpendPolicyDoc, role: LlmSpendPolicyRole | undefined): LlmSpendRolePolicy {
  const stored = role === undefined ? undefined : doc.roles[role];
  return {
    prefer: stored?.prefer ?? [],
    creditOk: stored?.creditOk ?? false,
    deny: [...(stored?.deny ?? [])],
    ...(stored?.difficulty !== undefined ? { difficulty: stored.difficulty } : {}),
    ...(stored?.creditSpendCap !== undefined ? { creditSpendCap: stored.creditSpendCap } : {}),
  };
}
