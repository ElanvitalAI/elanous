import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPluginFeature, type FeatureGrant } from '../../plugins/core/feature-entitlements.js';

/** Host-owned membership resolver. Graph input cannot grant itself a tier. */
export interface MembershipResolver { currentTier(): string | null | undefined }

export function authorizeGcpFeature(feature: string, member: MembershipResolver, tablePath = join(import.meta.dir, '../../../plugins/gcp-architect-expand/entitlements.json')): FeatureGrant {
  try { return checkPluginFeature(JSON.parse(readFileSync(tablePath, 'utf8')), feature, member.currentTier()); }
  catch { return { allowed: false, reason: 'invalid-table' }; }
}

/** Public single-GCP entry consumes the same table as future paid routes. */
export function authorizeSingleGcp(member: MembershipResolver, tablePath?: string): FeatureGrant {
  const expansion = authorizeGcpFeature('gcp.single_cloud_expand', member, tablePath);
  if (!expansion.allowed) return expansion;
  return authorizeGcpFeature('gcp.basic_security_grade_design', member, tablePath);
}
