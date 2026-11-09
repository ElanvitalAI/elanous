import { resolvePublicAppUserId } from '../../relay/relay-server.js';

export type AppDeploymentSession = 'nexus-owner' | 'member' | 'anonymous';

export interface AppMemberOwnerReceipt {
  readonly memberId: string;
  readonly userSlug: string;
  readonly plan: string;
  readonly entitlements: Readonly<Record<string, unknown>>;
}

/** Resolve the deploy owner from the authenticated Nexus session, never from tool/LLM arguments. */
export function resolveAppDeploymentOwner(
  session: AppDeploymentSession,
  configuredPublicUserId = process.env.ELANOUS_PUBLIC_APP_USER_ID,
  memberOwner?: AppMemberOwnerReceipt,
): string {
  if (session === 'anonymous') throw new Error('app deployment requires an authenticated owner session');
  const ownerId = session === 'member'
    ? memberOwner && typeof memberOwner.memberId === 'string' && memberOwner.memberId.trim()
      && typeof memberOwner.plan === 'string' && memberOwner.entitlements && typeof memberOwner.entitlements === 'object'
      ? resolvePublicAppUserId(memberOwner.userSlug, configuredPublicUserId)
      : undefined
    : resolvePublicAppUserId(undefined, configuredPublicUserId);
  if (session === 'member' && !ownerId) throw new Error('app deployment requires a verified member owner response');
  if (!ownerId) throw new Error('ELANOUS_PUBLIC_APP_USER_ID is required for app deployment');
  return ownerId;
}
