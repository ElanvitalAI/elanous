/**
 * #17 LLM-POLICY-OR-MANAGEMENT-LEASE — «관리 임대» production 조달기.
 * 금고(HQ-VAULT V3) static lease 사본에서 openrouter 관리 키를 값으로만 꺼내 관측기(credit 어댑터)에 건넨다.
 * ⛔ 값은 반환 문자열로만 나간다 — 로그·원장·조회 출력에 실리지 않는다(출력측은 leaseId·상태만).
 * 임대가 없으면 빈 위임(관측기는 missing-management-lease 로 unmeasured · 네트워크 0) — 기존 배선 그대로.
 */
import { resolve as resolvePath } from 'node:path';
import { resolveStaticLeaseCopy } from '../secret/static-lease-consumer.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';

export interface ManagementLeases {
  readonly [provider: string]: string | undefined;
}

function keyCacheDir(): string {
  return process.env.ELANOUS_KEY_CACHE_DIR?.trim() || resolvePath(homedirMaybe(), '.cache');
}

function homedirMaybe(): string {
  try {
    const { homedir } = require('node:os') as typeof import('node:os');
    return homedir();
  } catch { return '/root'; }
}

/**
 * 임대 루트 후보. 우주 주입 경계(시험·격리): 명시된 우주(ELANOUS_INSTANCE_ROOT)뿐 아니라
 * ELANOUS_STATE_DIR 스탬프·config override 가 고른 실효 격리 루트도 «명시된 우주»다 —
 * 그 우주에 임대가 없으면 조달을 종료한다(운영 루트 폴백 금지 · JUD #39513 mustFix 1·r2).
 * 실효 우주 해석이 안 되면(부팅 초기 등) 운영 폴백 없이 빈 결과로 종료한다(fail-closed · OP #131601).
 */
export function leaseRoots(): string[] {
  const explicit = process.env.ELANOUS_INSTANCE_ROOT?.trim();
  if (explicit) return [explicit];
  let effective: string | undefined;
  let prod: string | undefined;
  try { effective = effectiveInstanceRoot(); } catch { /* 부팅 초기 */ }
  try { prod = prodInstanceRoot(); } catch { /* HOME 없음 */ }
  return leaseRootsFromResolution(effective, prod);
}

/** 순수(OP #131601 · JUD #39513 홀드 필수 1): 실효 우주 → 임대 루트 후보. 실효 미확정은 빈 결과(fail-closed). */
export function leaseRootsFromResolution(effective: string | undefined, prod: string | undefined): string[] {
  if (!effective) return [];                                  // 실효 우주 미확정 = 운영 폴백 없이 조달 종료
  if (prod !== undefined && effective === prod) return [prod]; // 운영 우주
  return [effective];                                         // 격리 실효 우주 = 그 우주만(폴백 없음)
}

/** 현재 우주의 관리 임대 위임(값만). 임대 없으면 빈 객체 — 이 조회 자체는 네트워크 0·출력 0. */
export function managementLeasesForSpend(): ManagementLeases {
  const out: Record<string, string | undefined> = {};
  for (const [provider, cacheName] of [['openrouter', 'openrouter_api_key']] as const) {
    try {
      const leased = resolveStaticLeaseCopy(cacheName, {
        roots: leaseRoots(),
        cacheFilePath: resolvePath(keyCacheDir(), cacheName),
      });
      if (leased) out[provider] = leased.value;
    } catch {
      // 만료/회수 임대는 «없음»으로 취급 — 관측기가 unmeasured 로 표기(값 유출 경로 아님).
    }
  }
  return out;
}
