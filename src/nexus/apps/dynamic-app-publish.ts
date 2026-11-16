import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NexusAppHost } from './app-host.js';
import { reopenSealedAppSource, sealAppSource } from './app-source-seal.js';
import { startAppService, type AppServiceBinding } from './app-service-runtime.js';
import { publicAppAddress } from './console-address.js';
import type { DynamicAppDeployHook } from '../../agent/app-deploy-plugin.js';
import type { MemberStore } from '../members/member-store.js';
import type { DeploymentApprovalProvider, PendingDeploymentApproval } from './app-deployment-approval-intent.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
function refuse(): never { throw new Error('dynamic app publish refused'); }
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path) refuse();
}
export interface DynamicOwner { readonly memberId: string; readonly userSlug: string }
/** Server-backed authority. The provider keeps the dpg_ credential in private state. */
export interface DeploymentGrantBinding {
  readonly grantId: string; readonly grantVersion: number; readonly deploymentId: string; readonly ownerId: string;
  readonly appSlug: string; readonly runId: string; readonly sourceHead: string;
  readonly artifactDigest: string; readonly relayKeyId: string; readonly expiresAt: string;
  readonly approvalId?: string;
}
export interface DeploymentGrantProvider {
  issue(input: Omit<DeploymentGrantBinding, 'grantId' | 'grantVersion'>): Promise<DeploymentGrantBinding>;
  introspect(grantId: string): Promise<DeploymentGrantBinding | null>;
  revoke(grantId: string, owner: DynamicOwner): Promise<void>;
  /** Revoke a grant returned by a new 201 before its binding can be trusted or stored. */
  revokeIssued(grantId: string, owner: DynamicOwner, appSlug: string): Promise<void>;
}
/** Preserve an authenticated denial when an offline local retirement is possible. */
export class DeploymentGrantAuthorizationError extends Error {
  constructor() { super('DEPLOYMENT_GRANT_AUTH_REFUSED'); }
}
/** The owner endpoint attests memberId; the current public handle comes from the member store. */
export function verifiedDynamicOwner(
  receipt: unknown,
  store: Pick<MemberStore, 'activeForAuth' | 'memberPlanForMember' | 'publicUserSlugForMember' | 'memberForPublicUserSlug'>,
): DynamicOwner | null {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const memberId = (receipt as { memberId?: unknown }).memberId;
  if (typeof memberId !== 'string' || !memberId || !store.activeForAuth(memberId)
    || !store.memberPlanForMember(memberId)) return null;
  const userSlug = store.publicUserSlugForMember(memberId);
  if (!userSlug || store.memberForPublicUserSlug(userSlug) !== memberId) return null;
  return { memberId, userSlug };
}
export interface DynamicPublisherOptions {
  readonly sourceRoot: string;
  readonly sealRoot: string;
  readonly runtimeRoot: string;
  readonly appHost: NexusAppHost;
  /** Exact OP-approved test member and handle. Missing values disable publication. */
  readonly testMemberId?: string;
  readonly testHandle?: string;
  readonly testApprovalExpiresAt?: string;
  /** Server-pinned producer revision; never accepted from an agent or request body. */
  readonly issuerSourceHead?: string;
  /** Trusted exact-artifact approval; model metadata and HTTP bodies never provide this value. */
  readonly approveArtifact: (owner: DynamicOwner, runId: string, appSlug: string, artifactDigest: string) => boolean | Promise<boolean>;
  /** No provider means publication fails closed until the server ledger is wired. */
  readonly deploymentGrants?: DeploymentGrantProvider;
  /** The server-owned browser confirmation is separate from this native start/poll client. */
  readonly deploymentApprovals?: DeploymentApprovalProvider;
  /** Read the current private key identity at publish and on every serving check. */
  readonly relayKeyId?: string | (() => string | undefined);
  /** Short interval only for deterministic revocation tests; production checks once per second. */
  readonly authorizationPollMsForTesting?: number;
  readonly verifyPublic?: (url: string, request: Request) => Promise<{ status: number; marker: string | null }>;
}
interface LiveDeployment { id: string; ownerId: string; runId: string; appSlug: string; userSlug: string;
  artifactDigest: string; grantId: string; service: AppServiceBinding; retiring?: boolean;
  timer?: ReturnType<typeof setInterval> }

export function createDynamicAppPublisher(options: DynamicPublisherOptions) {
  const sources = resolve(options.sourceRoot);
  const seals = resolve(options.sealRoot);
  const runtime = resolve(options.runtimeRoot);
  for (const path of [sources, seals, runtime]) privateDirectory(path);
  const stateRoot = join(seals, '.deployment-state');
  const ensureState = () => {
    try { mkdirSync(stateRoot, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privateDirectory(stateRoot);
  };
  const privateRecord = (path: string): Record<string, unknown> => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
      || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()
      || realpathSync(path) !== path) refuse();
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
    return value as Record<string, unknown>;
  };
  const writePrivateRecord = (path: string, value: object) => {
    let created = false;
    let file: number | undefined;
    try {
      file = openSync(path, 'wx', 0o600); created = true;
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (writeSync(file, bytes) !== bytes.length) refuse();
      fsyncSync(file); closeSync(file); file = undefined;
      const parent = openSync(stateRoot, 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch (error) {
      if (file !== undefined) { try { closeSync(file); } catch { /* preserve original write failure */ } }
      if (created) { try { unlinkSync(path); } catch { /* activation remains unavailable */ } }
      throw error;
    }
  };
  const intentPath = (ownerId: string, runId: string, appSlug: string) => join(stateRoot,
    'intent-' + createHash('sha256').update(ownerId + '\0' + runId + '\0' + appSlug).digest('hex') + '.json');
  const approvedPath = (path: string) => path + '.approved';
  const activePath = (deploymentId: string) => join(stateRoot, 'active-' + deploymentId + '.json');
  const pollMs = options.authorizationPollMsForTesting ?? 1_000;
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) refuse();
  const live = new Map<string, LiveDeployment>();
  // A failed remote revoke and failed local tombstone must remain addressable
  // for the same authenticated owner after serving has already stopped.
  const pendingRetirement = new Map<string, LiveDeployment>();
  const shutdownState = new Map<string, { unregistered: boolean; stopped: boolean }>();
  const retireRecord = (path: string, retiredPath: string, expected?: LiveDeployment): boolean => {
    let removed = false;
    try { renameSync(path, retiredPath); removed = true; }
    catch { try { unlinkSync(path); removed = true; } catch { /* no durable recovery proof */ } }
    if (!removed) {
      try {
        const row = privateRecord(retiredPath);
        removed = !expected || row.deploymentId === expected.id && row.ownerId === expected.ownerId
          && row.runId === expected.runId && row.appSlug === expected.appSlug;
      }
      catch { return false; }
      if (!removed) return false;
    }
    try {
      const parent = openSync(stateRoot, 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
      return true;
    } catch { return false; }
  };
  const retireLocal = (deployment: LiveDeployment): boolean => {
    const active = activePath(deployment.id);
    const activeDurable = retireRecord(active, active + '.retired', deployment);
    const intent = intentPath(deployment.ownerId, deployment.runId, deployment.appSlug);
    const intentDurable = retireRecord(intent, intent + '.retired-' + deployment.id, deployment);
    if (options.deploymentApprovals && existsSync(approvedPath(intent)))
      retireRecord(approvedPath(intent), approvedPath(intent) + '.retired-' + deployment.id);
    return activeDurable && intentDurable;
  };
  const ensureInactive = async (deployment: LiveDeployment): Promise<void> => {
    const state = shutdownState.get(deployment.id) ?? { unregistered: false, stopped: false };
    shutdownState.set(deployment.id, state);
    const failures: unknown[] = [];
    if (!state.unregistered) {
      try {
        options.appHost.unregisterDynamicService?.(deployment.appSlug, deployment.ownerId,
          deployment.runId, deployment.artifactDigest);
        state.unregistered = true;
      } catch (error) { failures.push(error); }
    }
    if (!state.stopped) {
      try { await deployment.service.stop(); state.stopped = true; }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'dynamic app shutdown incomplete');
  };
  /** Cleanup never re-enters the approval gate: expiry or revocation is a reason to stop. */
  const stopDeployment = async (deployment: LiveDeployment, retiring: boolean): Promise<boolean> => {
    if (live.get(deployment.appSlug) !== deployment) return false;
    deployment.retiring = true;
    if (retiring) pendingRetirement.set(deployment.appSlug, deployment);
    live.delete(deployment.appSlug);
    if (deployment.timer) clearInterval(deployment.timer);
    let shutdownError: unknown;
    try { await ensureInactive(deployment); } catch (error) { shutdownError = error; }
    const localRetirementDurable = retiring ? retireLocal(deployment) : true;
    if (shutdownError) throw shutdownError;
    if (retiring && localRetirementDurable) {
      pendingRetirement.delete(deployment.appSlug);
      shutdownState.delete(deployment.id);
    }
    return localRetirementDurable;
  };
  const retire = (deployment: LiveDeployment) => stopDeployment(deployment, true);
  const approved = (owner: DynamicOwner) => !!options.testMemberId && !!options.testHandle
    && !!options.testApprovalExpiresAt && Number.isFinite(Date.parse(options.testApprovalExpiresAt))
    && Date.now() < Date.parse(options.testApprovalExpiresAt)
    && owner.memberId === options.testMemberId && owner.userSlug === options.testHandle;
  const slot = (owner: DynamicOwner, runId: string, appSlug: string) => {
    if (!approved(owner) || !RUN.test(runId) || !SLUG.test(appSlug)
      || !/^[0-9a-f]{40}$/.test(options.issuerSourceHead ?? '')) refuse();
    const hash = createHash('sha256').update(owner.memberId).digest('hex');
    const parent = join(sources, hash, runId);
    return { parent, claim: join(parent, appSlug + '.claim.json') };
  };
  const verify = options.verifyPublic ?? (async (url: string, request: Request) => {
    const relayToken = request.headers.get('x-elanous-test-relay-token');
    if (!relayToken || !/^emt_[A-Za-z0-9_-]{16,4096}$/.test(relayToken)) refuse();
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${relayToken}` } });
    await response.body?.cancel();
    return { status: response.status, marker: response.headers.get('x-elanous-dynamic-route') };
  });
  const reserve = (owner: DynamicOwner, runId: string, appSlug: string) => {
    const item = slot(owner, runId, appSlug);
    mkdirSync(item.parent, { recursive: true, mode: 0o700 });
    privateDirectory(item.parent);
    const sourceRoot = join(item.parent, appSlug + '-' + randomBytes(16).toString('hex'));
    if (existsSync(sourceRoot) || existsSync(item.claim)) refuse();
    writeFileSync(item.claim, JSON.stringify({ ownerId: owner.memberId, userSlug: owner.userSlug, runId, appSlug,
      root: sourceRoot, issuerExpiresAt: options.testApprovalExpiresAt, sourceHead: options.issuerSourceHead }),
      { flag: 'wx', mode: 0o600 });
    return { sourceRoot, ownerId: owner.memberId, userSlug: owner.userSlug, runId, appSlug,
      issuerExpiresAt: options.testApprovalExpiresAt, sourceHead: options.issuerSourceHead };
  };
  const sourceFor = (owner: DynamicOwner, runId: string, appSlug: string): string => {
    const item = slot(owner, runId, appSlug);
    const stat = lstatSync(item.claim);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048 || (stat.mode & 0o077) !== 0) refuse();
    const claim = JSON.parse(readFileSync(item.claim, 'utf8')) as Record<string, unknown>;
    const sourceRoot = claim.root;
    if (claim.ownerId !== owner.memberId || claim.userSlug !== owner.userSlug || claim.runId !== runId
      || claim.issuerExpiresAt !== options.testApprovalExpiresAt || claim.sourceHead !== options.issuerSourceHead
      || claim.appSlug !== appSlug || typeof sourceRoot !== 'string'
      || !new RegExp('^' + appSlug + '-[0-9a-f]{32}$').test(sourceRoot.slice(item.parent.length + 1))
      || !sourceRoot.startsWith(item.parent + '/')) refuse();
    return sourceRoot;
  };
  /** Reopen the server-held claim before a trusted materializer writes any source bytes. */
  const attest = (owner: DynamicOwner, runId: string, appSlug: string) => ({
    sourceRoot: sourceFor(owner, runId, appSlug), ownerId: owner.memberId, userSlug: owner.userSlug,
    runId, appSlug, issuerExpiresAt: options.testApprovalExpiresAt, sourceHead: options.issuerSourceHead,
  });
  const sealFor = async (owner: DynamicOwner, runId: string, appSlug: string,
    stillAuthorized: () => boolean | Promise<boolean>) =>
    await sealAppSource({ sourceRoot: sourceFor(owner, runId, appSlug), sealRoot: seals,
      ownerId: owner.memberId, runId, stillAuthorized });
  const inspect = async (owner: DynamicOwner, runId: string, appSlug: string,
    stillAuthorized: () => boolean | Promise<boolean>) => {
    if (!await stillAuthorized()) refuse();
    const sealed = await sealFor(owner, runId, appSlug, stillAuthorized);
    return { status: 'inspected' as const, artifactDigest: sealed.artifactDigest,
      declaredPort: sealed.runtime.port ?? null, files: sealed.files };
  };
  const currentRelayKeyId = () => typeof options.relayKeyId === 'function'
    ? options.relayKeyId() : options.relayKeyId;
  const approvalBinding = async (owner: DynamicOwner, runId: string, appSlug: string,
    stillAuthorized: () => boolean | Promise<boolean>) => {
    if (!options.deploymentApprovals || !await stillAuthorized() || !approved(owner)) refuse();
    const relayKeyId = currentRelayKeyId();
    if (!relayKeyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(relayKeyId)) refuse();
    const sealed = await sealFor(owner, runId, appSlug, stillAuthorized);
    if (!await stillAuthorized() || !await options.approveArtifact(owner, runId, appSlug, sealed.artifactDigest)) refuse();
    return { ownerId: owner.memberId, memberId: owner.memberId, appSlug, runId,
      sourceHead: options.issuerSourceHead!, artifactDigest: sealed.artifactDigest,
      relayKeyId, expiresAt: options.testApprovalExpiresAt! };
  };
  const pinnedApproval = (path: string, identity: { ownerId: string; runId: string; appSlug: string }) => {
    const row = privateRecord(path);
    if (Object.keys(row).sort().join() !==
      'appSlug,approvalId,approvalUrl,artifactDigest,deploymentId,expiresAt,ownerId,pendingExpiresAt,relayKeyId,runId,sourceHead'
      || row.ownerId !== identity.ownerId || row.runId !== identity.runId || row.appSlug !== identity.appSlug
      || typeof row.sourceHead !== 'string' || !/^[a-f0-9]{40}$/u.test(row.sourceHead)
      || typeof row.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.artifactDigest)
      || typeof row.relayKeyId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.relayKeyId)
      || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))
      || typeof row.deploymentId !== 'string'
      || !/^dyn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.deploymentId)
      || typeof row.approvalId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.approvalId)
      || row.approvalUrl !== 'https://api.elanous.ai/v1/members/deployment-approvals/' + row.approvalId
      || typeof row.pendingExpiresAt !== 'string' || !Number.isFinite(Date.parse(row.pendingExpiresAt))) refuse();
    return row as Record<string, unknown> & { deploymentId: string; approvalId: string;
      approvalUrl: string; pendingExpiresAt: string };
  };
  const startApproval = async (owner: DynamicOwner, runId: string, appSlug: string,
    stillAuthorized: () => boolean | Promise<boolean>, signal?: AbortSignal) => {
    const binding = await approvalBinding(owner, runId, appSlug, stillAuthorized);
    const { memberId: _memberId, ...immutable } = binding;
    ensureState();
    const path = intentPath(owner.memberId, runId, appSlug);
    if (existsSync(path)) {
      const previous = pinnedApproval(path, immutable);
      const sameBinding = Object.entries(immutable).every(([key, value]) => previous[key] === value);
      if (Date.now() < Date.parse(previous.pendingExpiresAt) && !existsSync(approvedPath(path)) && sameBinding)
        return { status: 'approval-pending' as const, approvalUrl: previous.approvalUrl,
          pendingExpiresAt: previous.pendingExpiresAt };
      if (Date.now() < Date.parse(previous.pendingExpiresAt)) refuse();
      if (existsSync(approvedPath(path)) || !retireRecord(path, path + '.retired-' + previous.deploymentId)) refuse();
    }
    const deploymentId = 'dyn-' + randomUUID();
    const pending = await options.deploymentApprovals!.start({ ...binding, deploymentId }, signal);
    if (!await stillAuthorized() || !approved(owner) || currentRelayKeyId() !== binding.relayKeyId) refuse();
    writePrivateRecord(path, { ...immutable, deploymentId, ...pending });
    return { status: 'approval-pending' as const, approvalUrl: pending.approvalUrl,
      pendingExpiresAt: pending.pendingExpiresAt };
  };
  const pollApproval = async (owner: DynamicOwner, runId: string, appSlug: string,
    stillAuthorized: () => boolean | Promise<boolean>, signal?: AbortSignal) => {
    const binding = await approvalBinding(owner, runId, appSlug, stillAuthorized);
    const { memberId: _memberId, ...immutable } = binding;
    ensureState();
    const path = intentPath(owner.memberId, runId, appSlug);
    const pinned = pinnedApproval(path, immutable);
    if (Object.entries(immutable).some(([key, value]) => pinned[key] !== value)) refuse();
    if (Date.now() >= Date.parse(pinned.pendingExpiresAt)) refuse();
    const pending: PendingDeploymentApproval = { approvalId: pinned.approvalId,
      approvalUrl: pinned.approvalUrl, pendingExpiresAt: pinned.pendingExpiresAt };
    const result = await options.deploymentApprovals!.poll({ ...binding, deploymentId: pinned.deploymentId }, pending, signal);
    if (!await stillAuthorized() || !approved(owner) || currentRelayKeyId() !== binding.relayKeyId) refuse();
    if (result.status === 'pending') return { status: 'approval-pending' as const,
      approvalUrl: pinned.approvalUrl, pendingExpiresAt: pinned.pendingExpiresAt };
    if (existsSync(approvedPath(path))) {
      const previous = privateRecord(approvedPath(path));
      if (previous.approvalId !== pinned.approvalId || previous.expiresAt !== result.expiresAt) refuse();
    } else writePrivateRecord(approvedPath(path), { approvalId: pinned.approvalId, expiresAt: result.expiresAt });
    return { status: 'approval-approved' as const };
  };
  const publish = async (owner: DynamicOwner, runId: string, appSlug: string, request: Request,
    stillAuthorized: () => boolean | Promise<boolean>, transactionActive: () => boolean = () => true) => {
    if (pendingRetirement.has(appSlug)) refuse();
    const provider = options.deploymentGrants;
    const relayKeyId = currentRelayKeyId();
    if (!provider || !relayKeyId || !/^[A-Za-z0-9_-]{1,128}$/.test(relayKeyId)) refuse();
    const authorized = async () => approved(owner) && await stillAuthorized() && approved(owner);
    const during = async () => transactionActive() && await authorized() && transactionActive();
    if (!await during() || live.has(appSlug) || !options.appHost.registerDynamicService) refuse();
    const sealed = await sealFor(owner, runId, appSlug, during);
    const approvedArtifact = async () => await authorized()
      && await options.approveArtifact(owner, runId, appSlug, sealed.artifactDigest);
    if (!await approvedArtifact() || !transactionActive()) refuse();
    const approvalExpiresAt = Date.parse(options.testApprovalExpiresAt ?? '');
    const issuedAt = Date.now();
    if (!Number.isFinite(approvalExpiresAt) || approvalExpiresAt <= issuedAt) refuse();
    ensureState();
    const path = intentPath(owner.memberId, runId, appSlug);
    const immutable = { ownerId: owner.memberId, appSlug, runId,
      sourceHead: options.issuerSourceHead!, artifactDigest: sealed.artifactDigest,
      relayKeyId, expiresAt: options.testApprovalExpiresAt! };
    let deploymentId: string;
    let approvalId: string | undefined;
    let grantExpiry = approvalExpiresAt;
    if (options.deploymentApprovals) {
      const pinned = pinnedApproval(path, immutable);
      if (Object.entries(immutable).some(([key, value]) => pinned[key] !== value)) refuse();
      const proof = privateRecord(approvedPath(path));
      if (Object.keys(proof).sort().join() !== 'approvalId,expiresAt'
        || proof.approvalId !== pinned.approvalId || typeof proof.expiresAt !== 'string'
        || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= issuedAt
        || Date.parse(proof.expiresAt) > approvalExpiresAt) refuse();
      deploymentId = pinned.deploymentId;
      approvalId = pinned.approvalId;
      grantExpiry = Date.parse(proof.expiresAt);
    } else if (existsSync(path)) {
      const previous = privateRecord(path);
      if (Object.keys(previous).sort().join() !== 'appSlug,artifactDigest,deploymentId,expiresAt,ownerId,relayKeyId,runId,sourceHead'
        || Object.entries(immutable).some(([key, value]) => previous[key] !== value)
        || typeof previous.deploymentId !== 'string'
        || !/^dyn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(previous.deploymentId)) refuse();
      deploymentId = previous.deploymentId;
    } else {
      deploymentId = 'dyn-' + randomUUID();
      writePrivateRecord(path, { ...immutable, deploymentId });
    }
    // H2 compares the original requested expiry byte-for-byte with the pending
    // server record, then caps the issued grant to its confirmed approval expiry.
    const expected = { ...immutable, deploymentId,
      ...(approvalId ? { approvalId } : {}) };
    const grant = await provider.issue(expected);
    const issuedId = grant && typeof grant.grantId === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/.test(grant.grantId) ? grant.grantId : null;
    if (!grant || typeof grant.grantId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(grant.grantId)
      || !Number.isSafeInteger(grant.grantVersion) || grant.grantVersion < 1
      || grant.deploymentId !== expected.deploymentId || grant.ownerId !== expected.ownerId
      || grant.appSlug !== expected.appSlug
      || grant.runId !== expected.runId || grant.sourceHead !== expected.sourceHead
      || grant.artifactDigest !== expected.artifactDigest || grant.relayKeyId !== expected.relayKeyId
      || grant.approvalId !== expected.approvalId
      || !Number.isFinite(Date.parse(grant.expiresAt))
      || Date.parse(grant.expiresAt) <= issuedAt
      || Date.parse(grant.expiresAt) > Math.min(grantExpiry, issuedAt + 24 * 60 * 60 * 1_000)) {
      if (issuedId) {
        try { await provider.revokeIssued(issuedId, owner, appSlug); }
        catch (cleanupError) { throw new AggregateError([new Error('DEPLOYMENT_GRANT_BINDING_REFUSED'), cleanupError],
          'deployment grant binding and cleanup refused'); }
        retireRecord(path, path + '.retired-' + deploymentId);
      }
      refuse();
    }
    let deploymentRef: LiveDeployment | undefined;
    const grantAuthorized = async () => {
      let valid = false;
      try {
        if (currentRelayKeyId() !== expected.relayKeyId) {
          if (deploymentRef) await retire(deploymentRef);
          return false;
        }
        const current = await provider.introspect(grant.grantId);
        valid = !!current && current.grantId === grant.grantId && current.grantVersion === grant.grantVersion
          && current.deploymentId === expected.deploymentId
          && current.ownerId === expected.ownerId && current.appSlug === expected.appSlug
          && current.runId === expected.runId && current.sourceHead === expected.sourceHead
          && current.artifactDigest === expected.artifactDigest && current.relayKeyId === expected.relayKeyId
          && current.approvalId === expected.approvalId
          && current.expiresAt === grant.expiresAt && Date.now() < Date.parse(current.expiresAt);
      } catch { /* an unverifiable grant cannot serve */ }
      if (!valid && deploymentRef) await retire(deploymentRef);
      return valid;
    };
    if (!await grantAuthorized()) {
      try {
        await provider.revoke(grant.grantId, owner);
        retireRecord(path, path + '.retired-' + deploymentId);
      } catch { /* no local service was activated */ }
      refuse();
    }
    let activated = false;
    let publicationFailed = false;
    const servingAuthorized = async () => !publicationFailed && !deploymentRef?.retiring && await grantAuthorized()
      && (activated || await approvedArtifact()) && !publicationFailed && !deploymentRef?.retiring;
    let service: AppServiceBinding | undefined;
    let registered = false;
    try {
      service = await startAppService({ sealed, runtimeRoot: runtime, ownerId: owner.memberId, runId,
        stillAuthorized: servingAuthorized });
      if (!await during() || !await approvedArtifact() || !await grantAuthorized()) refuse();
      const routeNonce = randomBytes(24).toString('hex');
      options.appHost.registerDynamicService({ appSlug, userSlug: owner.userSlug, ownerId: owner.memberId,
        runId, artifactDigest: sealed.artifactDigest, routeNonce, service, stillAuthorized: servingAuthorized });
      registered = true;
      const url = publicAppAddress({ appSlug, userSlug: owner.userSlug });
      const verified = await verify(url, request);
      if (verified.status !== 200 || verified.marker !== routeNonce || !await during()
        || !await approvedArtifact() || !await grantAuthorized()) refuse();
      const sourceRoot = sourceFor(owner, runId, appSlug);
      reopenSealedAppSource({ sealRoot: seals, sealPath: sealed.sealPath, sourceRoot,
        ownerId: owner.memberId, runId, artifactDigest: sealed.artifactDigest });
      writePrivateRecord(activePath(deploymentId), { ...grant, userSlug: owner.userSlug,
        sourceRoot, sealPath: sealed.sealPath });
      activated = true;
      const deployment: LiveDeployment = { id: deploymentId, grantId: grant.grantId,
        ownerId: owner.memberId, runId, appSlug, userSlug: owner.userSlug,
        artifactDigest: sealed.artifactDigest, service };
      live.set(appSlug, deployment);
      deploymentRef = deployment;
      deployment.timer = setInterval(() => {
        void grantAuthorized().then(ok => { if (!ok) return retire(deployment); })
          .catch(() => retire(deployment)).catch(() => {});
      }, pollMs);
      deployment.timer.unref?.();
      return { status: 'published' as const, deploymentId: deployment.id, publicUrl: url, port: service.port };
    } catch (error) {
      publicationFailed = true;
      const failures: unknown[] = [error];
      if (registered) {
        try { options.appHost.unregisterDynamicService?.(appSlug, owner.memberId, runId, sealed.artifactDigest); }
        catch (unregisterError) { failures.push(unregisterError); }
      }
      try { await service?.stop(); } catch (stopError) { failures.push(stopError); }
      // A grant issued for a publication that never activated must not be
      // treated as a live deployment after a later process restart.
      try {
        await provider.revoke(grant.grantId, owner);
        retireRecord(path, path + '.retired-' + deploymentId);
      } catch (revokeError) { failures.push(revokeError); }
      if (failures.length > 1) throw new AggregateError(failures, 'dynamic app activation cleanup incomplete');
      throw error;
    }
  };
  const undo = async (owner: DynamicOwner, runId: string, appSlug: string, deploymentId: string) => {
    const activeDeployment = live.get(appSlug);
    const deployment = activeDeployment ?? pendingRetirement.get(appSlug);
    if (!deployment || deployment.id !== deploymentId || deployment.ownerId !== owner.memberId
      || deployment.runId !== runId || deployment.userSlug !== owner.userSlug) refuse();
    if (activeDeployment) pendingRetirement.set(appSlug, deployment);
    let serverRevoked = false;
    let authorizationDenied = false;
    let localRetirementDurable = false;
    let shutdownError: unknown;
    try {
      if (activeDeployment) localRetirementDurable = await retire(deployment);
      else {
        await ensureInactive(deployment);
        localRetirementDurable = retireLocal(deployment);
      }
    } catch (error) { shutdownError = error; }
    try { await options.deploymentGrants!.revoke(deployment.grantId, owner); serverRevoked = true; }
    catch (error) { authorizationDenied = error instanceof DeploymentGrantAuthorizationError; }
    if (shutdownError) throw shutdownError;
    if (authorizationDenied) refuse();
    if (serverRevoked || localRetirementDurable) {
      pendingRetirement.delete(appSlug);
      shutdownState.delete(deployment.id);
      return { status: 'undone' as const, deploymentId,
        stopped: true as const, durableRetirement: true as const,
        proof: serverRevoked ? 'server' as const : 'local-tombstone' as const };
    }
    return { status: 'retirement-incomplete' as const, deploymentId,
      stopped: true as const, durableRetirement: false as const };
  };
  return { reserve, attest, inspect, startApproval, pollApproval, publish, undo,
    isApproved: approved, isPublicSlug: (slug: string) => live.has(slug),
    close: async () => { for (const deployment of [...live.values()]) await stopDeployment(deployment, false).catch(() => {}); } };
}
export type DynamicAppPublisher = ReturnType<typeof createDynamicAppPublisher>;

/** Bridge an authenticated prompt request to the same owner-checked product route. */
export function createDynamicAppDeployHook(
  promptRequest: Request,
  route: (request: Request) => Promise<Response | undefined>,
  relayToken?: string,
): DynamicAppDeployHook {
  const call = async (action: 'inspect' | 'publish', appId: string, runId: string) => {
    const headers = new Headers();
    for (const name of ['authorization', 'cookie', 'origin', 'sec-fetch-site']) {
      const value = promptRequest.headers.get(name); if (value) headers.set(name, value);
    }
    if (relayToken) headers.set('x-elanous-test-relay-token', relayToken);
    headers.set('content-type', 'application/json');
    const request = new Request(new URL(`/v1/apps/${appId}/dynamic-deployment`, promptRequest.url), {
      method: 'POST', headers, body: JSON.stringify({ action, runId }), signal: promptRequest.signal,
    });
    const response = await route(request);
    if (!response?.ok) throw new Error('generated app publish refused');
    return await response.json() as Record<string, unknown>;
  };
  return {
    inspect: async ({ appId, runId }) => {
      const result = await call('inspect', appId, runId);
      if (result.status !== 'inspected' || typeof result.artifactDigest !== 'string') throw new Error('generated app inspect refused');
      return { artifactDigest: result.artifactDigest };
    },
    publish: async ({ appId, runId }) => {
      const result = await call('publish', appId, runId);
      if (result.status !== 'published' || typeof result.publicUrl !== 'string') throw new Error('generated app publish refused');
      return { publicUrl: result.publicUrl };
    },
  };
}

/** Authenticated product route; source root is derived from the reservation, never from a request body. */
export function createDynamicAppPublishRoute(publisher: DynamicAppPublisher,
  resolveOwner: (request: Request) => Promise<DynamicOwner | null>, webOrigin?: string) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = /^\/v1\/apps\/([a-z0-9][a-z0-9-]*)\/dynamic-deployment$/.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    if (request.method !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    if (!request.headers.has('authorization') && !request.headers.has('cookie')) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const origin = request.headers.get('origin');
    const native = /^Bearer [A-Za-z0-9_-]+$/.test(request.headers.get('authorization') ?? '') && !request.headers.has('cookie');
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin ? origin !== webOrigin : !native))
      return Response.json({ error: 'origin-not-allowed' }, { status: 403 });
    const gate = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const expired = new Promise<never>((_, reject) => {
      gate.addEventListener('abort', () => reject(new Error('dynamic publish request expired')), { once: true });
    });
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);
    try {
      const owner = await bounded(resolveOwner(request));
      if (!owner) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) refuse();
      const reader = request.body?.getReader(); if (!reader) refuse();
      const parts: Uint8Array[] = []; let size = 0;
      try { for (;;) {
        const part = await bounded(reader.read()); if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) { await reader.cancel(); refuse(); }
        parts.push(part.value);
      } } catch { await reader.cancel().catch(() => {}); refuse(); }
      finally { reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(parts.map(part => Buffer.from(part))).toString('utf8')) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['action', 'runId', 'deploymentId'].includes(key))
        || typeof body.runId !== 'string') refuse();
      const slug = match[1]!;
      const credentialHeaders = new Headers();
      for (const name of ['authorization', 'cookie']) {
        const value = request.headers.get(name); if (value) credentialHeaders.set(name, value);
      }
      const stillOwner = async () => {
        const current = await resolveOwner(new Request(request.url, { headers: credentialHeaders }));
        return current?.memberId === owner.memberId && current?.userSlug === owner.userSlug;
      };
      if (gate.aborted || !await bounded(stillOwner())) refuse();
      const result = body.action === 'reserve' ? publisher.reserve(owner, body.runId, slug)
        : body.action === 'attest' ? publisher.attest(owner, body.runId, slug)
        : body.action === 'inspect' ? await bounded(publisher.inspect(owner, body.runId, slug, stillOwner))
        : body.action === 'approval-start' ? await bounded(publisher.startApproval(owner, body.runId, slug,
          stillOwner, gate))
        : body.action === 'approval-poll' ? await bounded(publisher.pollApproval(owner, body.runId, slug,
          stillOwner, gate))
          : body.action === 'publish' ? await bounded(publisher.publish(owner, body.runId, slug, request, stillOwner, () => !gate.aborted))
          : body.action === 'undo' && typeof body.deploymentId === 'string'
            ? await publisher.undo(owner, body.runId, slug, body.deploymentId) : refuse();
      return Response.json(result, { status: 'status' in result && result.status === 'retirement-incomplete' ? 409 : 200,
        headers: { 'cache-control': 'no-store' } });
    } catch { return Response.json({ error: 'dynamic-app-operation-refused' }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
  };
}
