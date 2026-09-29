// 공급자별 공개/비공개 판정. 명령 실패·모르는 문면은 unreadable — private 으로 통과시키지 않는다.

import { judgeArchiveBucket, type BucketState } from '../webclone/archive-bucket-verdict.js';
import { isFullyBlockedFromPublic, isPublicReadPolicy } from '../webclone/webclone-store.js';
import type { RunFn, StorageProvider } from './object-store.js';

export type Visibility = 'private' | 'public' | 'partially-public' | 'missing' | 'unreadable';

export interface VisibilityVerdict {
  visibility: Visibility;
  reason: string;
}

export interface VisibilityDeps {
  run: RunFn;
  which?: (name: string) => string;
}

function whichOf(deps: VisibilityDeps, name: string): string {
  return deps.which?.(name) ?? name;
}

function mapS3State(state: BucketState): Visibility {
  if (state === 'blocked') return 'private';
  if (state === 'public-policy') return 'public';
  if (state === 'partially-blocked' || state === 'no-block-config') return 'partially-public';
  if (state === 'missing') return 'missing';
  return 'unreadable';
}

function probeS3Family(provider: 's3' | 'r2', bucket: string, deps: VisibilityDeps, endpoint?: string[]): VisibilityVerdict {
  const bin = whichOf(deps, 'aws');
  const extra = endpoint ?? [];
  let policy: { ok: boolean; text: string };
  let block: { ok: boolean; text: string };
  try {
    const out = deps.run(bin, ['s3api', 'get-bucket-policy', '--bucket', bucket, '--output', 'text', ...extra], { timeoutMs: 30_000 });
    policy = { ok: true, text: out.stdout };
  } catch (e) {
    policy = { ok: false, text: (e as Error).message ?? '' };
  }
  try {
    const out = deps.run(bin, ['s3api', 'get-public-access-block', '--bucket', bucket, ...extra], { timeoutMs: 30_000 });
    block = { ok: true, text: out.stdout };
  } catch (e) {
    block = { ok: false, text: (e as Error).message ?? '' };
  }
  if (!policy.ok && !block.ok && !/NoSuch|PublicAccess|policy/i.test(`${policy.text}\n${block.text}`)) {
    return { visibility: 'unreadable', reason: `${provider} 명령을 읽지 못했다` };
  }
  const judged = judgeArchiveBucket(bucket, { policy, block }, isPublicReadPolicy, isFullyBlockedFromPublic);
  return { visibility: mapS3State(judged.state), reason: judged.why };
}

function probeGcs(bucket: string, deps: VisibilityDeps): VisibilityVerdict {
  const bin = whichOf(deps, 'gcloud');
  let described: string;
  try {
    described = deps.run(bin, ['storage', 'buckets', 'describe', `gs://${bucket}`, '--format=json'], { timeoutMs: 30_000 }).stdout;
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/not found|404/i.test(msg)) return { visibility: 'missing', reason: `버킷 «${bucket}» 이 없다` };
    return { visibility: 'unreadable', reason: 'gcs 버킷 설명을 읽지 못했다' };
  }
  let pap: unknown;
  try {
    const j = JSON.parse(described) as { public_access_prevention?: unknown; iamConfiguration?: { publicAccessPrevention?: unknown } };
    pap = j.public_access_prevention ?? j.iamConfiguration?.publicAccessPrevention;
  } catch {
    return { visibility: 'unreadable', reason: 'gcs 버킷 설명을 해석하지 못했다' };
  }
  let policyText: string;
  try {
    policyText = deps.run(bin, ['storage', 'buckets', 'get-iam-policy', `gs://${bucket}`, '--format=json'], { timeoutMs: 30_000 }).stdout;
  } catch {
    return { visibility: 'unreadable', reason: 'gcs IAM 정책을 읽지 못했다' };
  }
  let world = false;
  try {
    const policy = JSON.parse(policyText) as { bindings?: Array<{ members?: string[] }> };
    const members = (policy.bindings ?? []).flatMap((b) => b.members ?? []);
    world = members.some((m) => m === 'allUsers' || m === 'allAuthenticatedUsers');
  } catch {
    return { visibility: 'unreadable', reason: 'gcs IAM 정책을 해석하지 못했다' };
  }
  if (world) return { visibility: 'public', reason: 'allUsers 또는 allAuthenticatedUsers 가 IAM 에 있다' };
  if (pap === 'enforced') return { visibility: 'private', reason: 'public_access_prevention=enforced' };
  if (pap === 'inherited') return { visibility: 'partially-public', reason: 'public_access_prevention=inherited — 비공개로 단정하지 않는다' };
  return { visibility: 'unreadable', reason: 'public_access_prevention 문면을 모른다' };
}

function probeAzure(bucket: string, deps: VisibilityDeps, account: string): VisibilityVerdict {
  if (!account) return { visibility: 'unreadable', reason: 'azure.account 가 없다' };
  const bin = whichOf(deps, 'az');
  let accountJson: string;
  try {
    accountJson = deps.run(bin, ['storage', 'account', 'show', '--name', account], { timeoutMs: 30_000 }).stdout;
  } catch {
    return { visibility: 'unreadable', reason: 'azure 계정 설명을 읽지 못했다' };
  }
  let allow: unknown;
  try {
    const j = JSON.parse(accountJson) as { allowBlobPublicAccess?: unknown };
    allow = j.allowBlobPublicAccess;
  } catch {
    return { visibility: 'unreadable', reason: 'azure 계정 설명을 해석하지 못했다' };
  }
  if (allow === false) return { visibility: 'private', reason: 'allowBlobPublicAccess=false' };
  let perm: string;
  try {
    perm = deps.run(bin, [
      'storage', 'container', 'show-permission',
      '--account-name', account,
      '--name', bucket,
      '--auth-mode', 'login',
    ], { timeoutMs: 30_000 }).stdout;
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/ContainerNotFound|not found|404/i.test(msg)) return { visibility: 'missing', reason: `컨테이너 «${bucket}» 이 없다` };
    return { visibility: 'unreadable', reason: 'azure 컨테이너 권한을 읽지 못했다' };
  }
  let publicAccess: unknown;
  try {
    const j = JSON.parse(perm) as { publicAccess?: unknown };
    publicAccess = j.publicAccess;
  } catch {
    return { visibility: 'unreadable', reason: 'azure 컨테이너 권한을 해석하지 못했다' };
  }
  if (publicAccess === 'off' || publicAccess === 'none' || publicAccess === null || publicAccess === undefined || publicAccess === '') {
    return { visibility: 'private', reason: 'publicAccess 가 꺼져 있다' };
  }
  if (publicAccess === 'blob' || publicAccess === 'container') {
    return { visibility: 'public', reason: `publicAccess=${String(publicAccess)}` };
  }
  return { visibility: 'unreadable', reason: 'azure publicAccess 문면을 모른다' };
}

export interface ProbeVisibilityOpts {
  /** r2 엔드포인트에 필요한 계정. s3 에는 쓰지 않는다. */
  accountId?: string;
  /** azure --account-name. */
  account?: string;
  /** r2/s3 --profile. */
  profile?: string;
}

/** 공급자별 가시성. local 은 항상 private. 실패·모르는 문면은 unreadable. */
export function probeVisibility(
  provider: StorageProvider,
  bucket: string,
  deps: VisibilityDeps,
  opts: ProbeVisibilityOpts = {},
): VisibilityVerdict {
  if (provider === 'local') return { visibility: 'private', reason: '로컬 파일은 공개 URL 이 없다' };
  if (!bucket) return { visibility: 'missing', reason: '버킷 이름이 없다' };
  if (provider === 's3') {
    const extra = opts.profile ? ['--profile', opts.profile] : [];
    return probeS3Family('s3', bucket, deps, extra);
  }
  if (provider === 'r2') {
    if (!opts.accountId) return { visibility: 'unreadable', reason: 'r2.accountId 가 없다' };
    const extra = ['--endpoint-url', `https://${opts.accountId}.r2.cloudflarestorage.com`];
    if (opts.profile) extra.push('--profile', opts.profile);
    return probeS3Family('r2', bucket, deps, extra);
  }
  if (provider === 'gcs') return probeGcs(bucket, deps);
  if (provider === 'azure') return probeAzure(bucket, deps, opts.account ?? '');
  return { visibility: 'unreadable', reason: '모르는 공급자다' };
}
