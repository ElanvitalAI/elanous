// 운영자 기기는 역할을 묻지 않고 오너 화면 (대표 2026-10-02 11:3x «사이드 메뉴에 Obsidian 이 안 보인다»)
//
// MAT2 는 역할을 고르지 않은 기기를 general(안정 화면만)로 본다. 우리 운영 데몬(op.elanous.ai ·
// 우리 tailnet)은 `GET /v1/me` 가 `{ operator: true }` 를 답한다(TC #22687 · 공개 경로 · 인증 불요).
// 그때만, 그리고 이 기기가 역할을 «아직 안 골랐을» 때만 오너로 정한다 — 사람이 고른 역할은 덮지 않는다.
// 외부 설치본은 `operator.enabled` 가 없어 늘 false 이므로 general 그대로다.

import { PWA_ROLE_KEY, writePwaRole } from './pwa-role';

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** `/v1/me` 의 operator 가 정확히 true 일 때만 참 — 404·실패·필드 없음은 거짓. */
export async function readOperator(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/me`, { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json() as { operator?: unknown } | null;
    return body?.operator === true;
  } catch { return false; }
}

export function shouldDefaultToOwner(storedRole: string | null, operator: boolean): boolean {
  return operator && storedRole === null;
}

/** 한 번 부른다 — 오너로 정했으면 true. */
export async function applyOperatorDefaultRole(opts: {
  baseUrl: string;
  fetchImpl?: FetchLike;
  storage?: Pick<Storage, 'getItem'> | null;
  write?: (role: 'owner') => void;
}): Promise<boolean> {
  let stored: string | null = null;
  try { stored = opts.storage?.getItem(PWA_ROLE_KEY) ?? null; } catch { return false; }
  if (stored !== null) return false;
  const operator = await readOperator(opts.baseUrl, opts.fetchImpl);
  if (!shouldDefaultToOwner(stored, operator)) return false;
  (opts.write ?? writePwaRole)('owner');
  return true;
}
