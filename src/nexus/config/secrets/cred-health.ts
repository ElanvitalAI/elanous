/** Observed grant metadata only. The credential value is never accepted or returned here. */
export type CredentialHealthInspection =
  | { readonly present: false }
  | { readonly present: true; readonly expiresAt: number; readonly permissions: readonly string[] };

export type CredentialHealthStatus = 'missing' | 'valid' | 'expiring' | 'expired' | 'insufficient-permission' | 'unmeasured';

export function credentialHealthLabel(status: CredentialHealthStatus): string {
  return {
    missing: '없음', valid: '유효', expiring: '만료 임박', expired: '만료',
    'insufficient-permission': '권한 부족', unmeasured: '있음 · 만료 정보 없음(측정 안 됨)',
  }[status];
}

/** Classify an explicit observation; mere secret-store presence cannot establish validity. */
export function assessCredentialHealth(
  inspection: CredentialHealthInspection,
  requiredPermission: string,
  now: number,
  warningWindowMs: number,
): CredentialHealthStatus {
  if (!Number.isFinite(now) || !Number.isFinite(warningWindowMs) || warningWindowMs < 0
    || !requiredPermission.trim()) throw new Error('invalid credential health policy');
  if (!inspection.present) return 'missing';
  if (!Number.isFinite(inspection.expiresAt)) throw new Error('invalid credential health observation');
  if (now >= inspection.expiresAt) return 'expired';
  if (!inspection.permissions.includes(requiredPermission)) return 'insufficient-permission';
  return inspection.expiresAt - now <= warningWindowMs ? 'expiring' : 'valid';
}

/** OAuth store metadata is enough to classify expiry and known required scopes; token bytes stay in memory. */
export function assessOAuthCredentialHealth(
  observation: { readonly present: false } | { readonly present: true; readonly expiresAt: number | null; readonly scope?: string } | null,
  requiredScopes: readonly string[] | null,
  now: number,
  warningWindowMs: number,
): CredentialHealthStatus {
  if (!observation?.present) return 'missing';
  if (!Number.isFinite(now) || !Number.isFinite(warningWindowMs) || warningWindowMs < 0)
    throw new Error('invalid credential health policy');
  if (observation.expiresAt !== null && (!Number.isFinite(observation.expiresAt) || observation.expiresAt <= now))
    return 'expired';
  if (requiredScopes === null) return 'unmeasured';
  if (requiredScopes.length > 0) {
    if (!observation.scope?.trim()) return 'unmeasured';
    const granted = new Set(observation.scope.split(/\s+/).filter(Boolean));
    if (requiredScopes.some((scope) => !granted.has(scope))) return 'insufficient-permission';
  }
  if (observation.expiresAt === null) return 'unmeasured';
  return observation.expiresAt - now <= warningWindowMs ? 'expiring' : 'valid';
}

export interface CredentialHealthObserver {
  readonly inspect: (slot: string) => CredentialHealthInspection;
  readonly permissionFor: (slot: string) => string;
  readonly now: () => number;
  readonly warningWindowMs: number;
}
