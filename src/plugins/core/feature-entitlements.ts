/** Data-only plugin feature grants. Membership identity is supplied by a trusted host seam, never graph input. */
export interface FeatureEntitlementTable {
  schemaVersion: 1;
  policy: 'deny-unlisted-and-unresolved';
  tiers: string[];
  features: Array<{ key: string; grant: Record<string, boolean> }>;
}

export type FeatureGrant = { allowed: boolean; reason: 'granted' | 'missing-tier' | 'unknown-tier' | 'unknown-feature' | 'invalid-table' | 'denied' };

export function checkPluginFeature(table: unknown, feature: string, membershipTier: string | null | undefined): FeatureGrant {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { allowed: false, reason: 'invalid-table' };
  const value = table as Partial<FeatureEntitlementTable>;
  if (value.schemaVersion !== 1 || value.policy !== 'deny-unlisted-and-unresolved' || !Array.isArray(value.tiers)
    || !value.tiers.every(tier => typeof tier === 'string') || !Array.isArray(value.features)
    || !value.features.every(row => row && typeof row.key === 'string' && row.grant && typeof row.grant === 'object'
      && !Array.isArray(row.grant) && value.tiers!.every(tier => typeof row.grant[tier] === 'boolean'))
    || new Set(value.features.map(row => row.key)).size !== value.features.length) return { allowed: false, reason: 'invalid-table' };
  if (!membershipTier) return { allowed: false, reason: 'missing-tier' };
  if (!value.tiers.includes(membershipTier)) return { allowed: false, reason: 'unknown-tier' };
  const row = value.features.find(item => item.key === feature);
  if (!row) return { allowed: false, reason: 'unknown-feature' };
  return row.grant[membershipTier] === true ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'denied' };
}
