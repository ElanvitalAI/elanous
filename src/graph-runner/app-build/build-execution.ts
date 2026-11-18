import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { inspectTuiMemberSessionFile, readTuiMemberSession, tuiMemberSessionPath, type TuiMemberSessionFileState } from '../../tui/member-session-contract.js';
import { assertMemberSessionCovers } from '../../tui/member-session-budget.js';
import { nexusRootDir, nexusRuntimePath } from '../../nexus/paths.js';
import { OFFICIAL_MEMBER_ORIGIN, readLocalAppBuildIssuer } from '../../nexus/apps/app-build-local-bridge.js';
import { readSourceHeadMismatch } from '../../nexus/apps/app-build-head-mismatch.js';
import { installedCurrentHead } from '../../version/stale-install.js';
import { publicAppAddress } from '../../nexus/apps/console-address.js';
import { codeRevision } from '../../version/code-revision.js';
import { createPluginRouteAdapter } from '../../plugins/core/route-adapter.js';
import { writeFileArtifact } from '../../tool-runtime/file-artifact.js';
import { runShell } from '../../shell-primitive/index.js';
import { DEFAULT_TIMEOUT_MS, SHELL_MAX_OUTPUT } from '../../shell-primitive/types.js';
import { macAppSandboxProfile } from '../../nexus/apps/app-service-runtime.js';
import { redactSecretText } from '../../debug/log.js';
import { APP_BUILD_MAX_FILES, parseTestStrategy, type TestStrategyItem } from './contracts.js';

type SourceFile = { path: string; content: string };
type Grant = { ownerId: string; userSlug: string; runId: string; appSlug: string; sourceRoot: string; issuerExpiresAt: string; sourceHead: string };
type Options = {
  getSession?: () => ReturnType<typeof readTuiMemberSession>; fetcher?: typeof fetch;
  /** Token-free expiry view of the same session; defaults to the private file only with the default reader. */
  inspectSession?: () => TuiMemberSessionFileState;
  sourceRoot?: string; scratchRoot?: string; sourceHead?: string; now?: () => number;
  shell?: typeof runShell; platform?: NodeJS.Platform;
  sandboxProfile?: typeof macAppSandboxProfile;
  /** Trusted host configuration only; never a graph/model argument. */
  issuerBridge?: { configDir: string; runtimePath: string };
  authorityRoot?: string;
  /** Installed `current` commit (default: this install's current/install.json) — names which side must restart. */
  installedHead?: () => string | undefined;
};
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const bundleHash = (files: SourceFile[]): string => hash(JSON.stringify(files.map(file => [file.path, hash(file.content)])));
function refuse(): never { throw new Error('BUILD_AUTHORITY_REFUSED'); }
// The C dynamic-deployment control route accepts at most 8KiB; no source bytes travel in it.
const MAX_CONTROL_BYTES = 8 * 1024;
// Same source transport cap as the generic writer; JSON can escape each code unit sixfold.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path
    || process.getuid && stat.uid !== process.getuid()) refuse();
}

/** The default graph host: private member SDK transport, enforced local test sandbox,
 * and same-host issuer attestation. No graph argument supplies credentials or roots. */
export function createBuildExecution(options: Options = {}) {
  const sources = resolve(options.sourceRoot ?? join(nexusRootDir(), 'dynamic-app-sources'));
  // APP-BUILD-SANDBOX-TMPDIR-CANONICAL: canonicalize once when the scratch is
  // created. verify and checkpoint then share one real path, so the symlink
  // refusal (realpath !== path) stays intact on every consumer.
  const scratchInput = resolve(options.scratchRoot ?? join(nexusRootDir(), 'app-build-scratch'));
  mkdirSync(scratchInput, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(scratchInput);
  const sourceHead = options.sourceHead ?? codeRevision(); // Pin once, as C does at Nexus startup.
  const authorityRoot = options.authorityRoot ?? join(getElanousConfigDir(), 'app-build', 'authority');
  const now = options.now ?? Date.now;
  const verified = new Set<string>();
  const getSession = options.getSession ?? (() => readTuiMemberSession(tuiMemberSessionPath(getElanousConfigDir(), process.env.ELANOUS_MEMBER_SESSION_FILE)));
  const inspectSession = options.inspectSession ?? (options.getSession ? undefined
    : () => inspectTuiMemberSessionFile(tuiMemberSessionPath(getElanousConfigDir(), process.env.ELANOUS_MEMBER_SESSION_FILE), now()));
  const fetcher = options.fetcher ?? fetch;
  const call = async (path: string, body: Record<string, unknown> | undefined, signal?: AbortSignal,
    local?: { origin: string; token: string; ownerId: string }): Promise<Record<string, unknown>> => {
    const session = local ? undefined : getSession(); if (!local && !session) refuse();
    const response = await fetcher(new URL(path, local?.origin ?? session!.nexusUrl), {
      method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'manual',
      headers: { authorization: 'Bearer ' + (local?.token ?? session!.sessionToken), ...(body ? { 'content-type': 'application/json' } : {}),
        ...(local ? { 'x-elanous-app-build-owner': local.ownerId, 'x-elanous-app-build-head': sourceHead! } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]) : AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      // RAIL-STALE-TUI-HEAD: only the local bridge carries our pinned head; its 409 names a stale process.
      const stale = local ? await readSourceHeadMismatch(response, sourceHead!, { installedHead: options.installedHead ?? (() => installedCurrentHead()) }) : undefined;
      if (stale) throw stale;
      await response.body?.cancel().catch(() => {}); refuse();
    }
    const reader = response.body?.getReader(); if (!reader) refuse();
    const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > MAX_CONTROL_BYTES) { await reader.cancel(); refuse(); }
      parts.push(part.value);
    } } finally { reader.releaseLock(); }
    return row(JSON.parse(Buffer.concat(parts).toString('utf8')));
  };
  const identity = async (ownerId: string, appSlug: string, signal?: AbortSignal) => {
    if (!ownerId || !/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u.test(appSlug)
      || !/^[0-9a-f]{40}$/u.test(sourceHead ?? '')) refuse();
    const session = getSession();
    if (session?.nexusUrl === OFFICIAL_MEMBER_ORIGIN && session.appSlug !== appSlug
      || session?.appSlug && session.appSlug !== appSlug) refuse();
    const owner = await call('/v1/members/owner' + (session?.appSlug ? '?' + new URLSearchParams({ appSlug }) : ''), undefined, signal);
    if (owner.memberId !== ownerId || typeof owner.userSlug !== 'string') refuse();
    publicAppAddress({ appSlug, userSlug: owner.userSlug });
    return { ownerId, userSlug: owner.userSlug };
  };
  const operation = (slug: string, action: string, runId: string, ownerId: string, signal?: AbortSignal) => {
    const session = getSession();
    if (session?.nexusUrl === OFFICIAL_MEMBER_ORIGIN && session.appSlug !== slug) refuse();
    const sealed = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(runId)
      && existsSync(join(authorityRoot, runId + '.json'));
    const bridge = options.issuerBridge ?? (session?.nexusUrl === OFFICIAL_MEMBER_ORIGIN || sealed
      ? { configDir: getElanousConfigDir(), runtimePath: nexusRuntimePath() } : undefined);
    const local = bridge ? { ...readLocalAppBuildIssuer(bridge.configDir, bridge.runtimePath), ownerId } : undefined;
    return call('/v1/apps/' + encodeURIComponent(slug) + (local ? '/dynamic-deployment-local' : '/dynamic-deployment'),
      { action, runId }, signal, local);
  };
  const validate = (value: unknown, ownerId: string, runId: string, appSlug: string, enforceExpiry: boolean): Grant => {
    const grant = row(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(runId) || grant.ownerId !== ownerId
      || typeof grant.userSlug !== 'string' || !grant.userSlug
      || grant.runId !== runId || grant.appSlug !== appSlug || grant.sourceHead !== sourceHead
      || typeof grant.issuerExpiresAt !== 'string' || !Number.isFinite(Date.parse(grant.issuerExpiresAt))
      || enforceExpiry && Date.parse(grant.issuerExpiresAt) <= now() || typeof grant.sourceRoot !== 'string') refuse();
    const parent = join(sources, hash(ownerId), runId);
    if (dirname(grant.sourceRoot) !== parent || !new RegExp('^' + appSlug + '-[0-9a-f]{32}$').test(basename(grant.sourceRoot))) refuse();
    privateDirectory(sources); privateDirectory(dirname(parent)); privateDirectory(parent);
    // A remote absolute path is not local authority: the independent local private
    // issuer claim must exist beneath our configured source root and match every field.
    const path = join(parent, appSlug + '.claim.json'); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_CONTROL_BYTES
      || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path || process.getuid && stat.uid !== process.getuid()) refuse();
    const claim = row(JSON.parse(readFileSync(path, 'utf8')));
    for (const key of ['ownerId', 'userSlug', 'runId', 'appSlug', 'issuerExpiresAt', 'sourceHead']) if (claim[key] !== grant[key]) refuse();
    if (claim.root !== grant.sourceRoot) refuse();
    return grant as Grant;
  };
  const attest = async (grant: Grant, signal?: AbortSignal) => {
    const current = validate(await operation(grant.appSlug, 'attest', grant.runId, grant.ownerId, signal), grant.ownerId, grant.runId, grant.appSlug, true);
    if (Object.keys(current).some(key => current[key as keyof Grant] !== grant[key as keyof Grant])) refuse();
    return current;
  };
  const verifiedKey = (grant: Grant, files: SourceFile[]) => JSON.stringify([grant.ownerId, grant.runId, grant.appSlug, grant.sourceHead, bundleHash(files)]);
  const checkpointPath = (grant: Grant) => {
    mkdirSync(scratch, { recursive: true, mode: 0o700 }); privateDirectory(scratch);
    let directory = scratch;
    for (const segment of ['checkpoints', hash(grant.ownerId), grant.runId, grant.appSlug]) {
      directory = join(directory, segment);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      privateDirectory(directory);
    }
    return join(directory, 'latest.json');
  };
  const verify = async (grant: Grant, input: SourceFile[], signal?: AbortSignal, strategy?: readonly TestStrategyItem[]) => {
    validate(grant, grant.ownerId, grant.runId, grant.appSlug, false);
    const files = input.map(file => ({ path: file.path, content: file.content }));
    const selected = strategy === undefined ? [] : parseTestStrategy(strategy, files);
    if ((options.platform ?? process.platform) !== 'darwin' || !options.shell && !existsSync('/usr/bin/sandbox-exec')) throw new Error('BUILD_SANDBOX_UNAVAILABLE');
    privateDirectory(scratch);
    const attempt = mkdtempSync(join(scratch, 'verify-')); const app = join(attempt, 'app');
    try {
      writeFileArtifact({ root: app, files, metadata: {} });
      const runtime = realpathSync(process.execPath);
      // APP-BUILD-SANDBOX-TMPDIR-CANONICAL: the profile allows the real path only.
      // macOS mkdtemp returns the /var alias; os.tmpdir() then EPERMs inside the sandbox.
      const home = realpathSync(app);
      const profile = (options.sandboxProfile ?? macAppSandboxProfile)({ readRoot: app, writeRoot: app,
        wrapper: join(app, 'source-artifact.json'), bunBinary: runtime });
      const execute = async (testArgs: string[]) => {
        const result = await (options.shell ?? runShell)({
          command: ['/usr/bin/env', '-i', 'HOME=' + home, 'TMPDIR=' + home, 'PATH=/usr/bin:/bin',
          '/usr/bin/sandbox-exec', '-p', profile, runtime, ...testArgs],
        // The argv already invokes sandbox-exec with the private policy. A second
        // runShell wrapper makes sandbox_apply fail on macOS; never run bare Bun.
        cwd: app, sandbox: 'off', network: 'off', approval: 'none', signal,
        timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputChars: SHELL_MAX_OUTPUT,
      });
        if (signal?.aborted) throw new Error('BUILD_CANCELLED');
        if (result.outcome !== 'exit' || /sandbox-exec: (?:sandbox_apply|unbound variable|.*error)/u.test(result.stderr)) throw new Error('BUILD_SANDBOX_UNAVAILABLE');
        return result;
      };
      // Preserve the existing full-suite gate, then measure each selected strategy
      // independently. A suite exit is not evidence that every named check passed.
      const suite = await execute(['test']);
      const testReceipts = [];
      const results = [suite];
      for (const item of selected) {
        // A prior test may write fixtures or even rewrite source. Each receipt
        // measures the same supplied bytes, never those mutations.
        rmSync(app, { recursive: true, force: true });
        // Bun accepts substring path filters. Keep only this test entry, plus
        // non-test dependencies; omit only other discoverable test entries.
        // A fixture may contain the full test filename and must remain available.
        const isolated = files.filter(file => file.path === item.testFile
          || !/(?:^|[._])(?:test|spec)\.[cm]?[jt]sx?$/u.test(file.path));
        writeFileArtifact({ root: app, files: isolated, metadata: {} });
        const result = await execute(item.command.slice(1));
        results.push(result);
        testReceipts.push({ strategyId: item.id, device: item.device, testFile: item.testFile,
          command: [runtime, ...item.command.slice(1)], selection: 'isolated-test-entry' as const, passed: result.exitCode === 0,
          exitCode: result.exitCode, fileSha256: hash(files.find(file => file.path === item.testFile)!.content) });
      }
      const passed = results.every(result => result.exitCode === 0);
      const fileDigest = bundleHash(files);
      if (passed) verified.add(verifiedKey(grant, files));
      return { passed, fileDigest, diagnostic: redactSecretText(results.map(result => result.stdout + '\n' + result.stderr).join('\n')),
        sandbox: 'darwin-private-netoff-envempty' as const, truncated: results.some(result => result.truncated),
        ...(strategy === undefined ? {} : { testStrategySha256: hash(JSON.stringify(selected)), testReceipts }) };
    } finally { rmSync(attempt, { recursive: true, force: true }); }
  };
  return {
    async reserve(ownerId: string, runId: string, appSlug: string, signal?: AbortSignal): Promise<Grant> {
      // APP-BUILD-SESSION-REFRESH: no renewal exists, so a session that cannot reach approval is refused before reserve.
      if (inspectSession) assertMemberSessionCovers('reserve', inspectSession());
      await identity(ownerId, appSlug, signal);
      return validate(await operation(appSlug, 'reserve', runId, ownerId, signal), ownerId, runId, appSlug, true);
    },
    verify,
    async save(grant: Grant, planDigest: string, files: Array<SourceFile & { sha256: string }>, signal?: AbortSignal) {
      validate(grant, grant.ownerId, grant.runId, grant.appSlug, false);
      if (!/^[0-9a-f]{64}$/u.test(planDigest) || files.length > APP_BUILD_MAX_FILES
        || files.some(file => typeof file.path !== 'string' || typeof file.content !== 'string' || file.sha256 !== hash(file.content))
        || files.reduce((size, file) => size + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0) > MAX_SOURCE_BYTES) refuse();
      const path = checkpointPath(grant);
      const value = { ownerId: grant.ownerId, runId: grant.runId, appSlug: grant.appSlug, sourceHead, planDigest, files, fileDigest: bundleHash(files) };
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > MAX_SOURCE_BYTES * 6 + MAX_CONTROL_BYTES) refuse();
      const temporary = path + '.' + randomUUID() + '.pending';
      try { writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
      return { planDigest, fileDigest: value.fileDigest, files: files.length };
    },
    async load(grant: Grant, signal?: AbortSignal) {
      validate(grant, grant.ownerId, grant.runId, grant.appSlug, false);
      const path = checkpointPath(grant);
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || stat.size > MAX_SOURCE_BYTES * 6 + MAX_CONTROL_BYTES || process.getuid && stat.uid !== process.getuid()) refuse();
      const value = row(JSON.parse(readFileSync(path, 'utf8')));
      if (value.ownerId !== grant.ownerId || value.runId !== grant.runId || value.appSlug !== grant.appSlug || value.sourceHead !== sourceHead
        || typeof value.planDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.planDigest) || !Array.isArray(value.files)
        || value.files.length > APP_BUILD_MAX_FILES || value.files.some(file => !file || typeof file.path !== 'string'
          || typeof file.content !== 'string' || file.sha256 !== hash(file.content))) refuse();
      const files = value.files as Array<SourceFile & { sha256: string }>;
      if (files.reduce((size, file) => size + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0) > MAX_SOURCE_BYTES
        || value.fileDigest !== bundleHash(files)) refuse();
      return { planDigest: value.planDigest, files };
    },
    async materialize(grant: Grant, input: SourceFile[], metadata: Record<string, unknown>, signal?: AbortSignal) {
      const files = input.map(file => ({ path: file.path, content: file.content }));
      await attest(grant, signal);
      // A resumed graph's ledger is not a trusted sandbox receipt. Reverify if this
      // host instance did not observe a passing execution of these exact bytes.
      if (!verified.has(verifiedKey(grant, files)) && !(await verify(grant, files, signal)).passed) throw new Error('BUILD_TESTS_REQUIRED');
      await attest(grant, signal);
      const adapter = createPluginRouteAdapter({ pluginRoot: resolve(import.meta.dir, '../../../plugins'), dispatchCore: async () => null,
        getDispatchContext: () => ({ verifiedOwner: { id: grant.ownerId }, requireApproval: true,
          fileArtifactAuthority: { ownerId: grant.ownerId, runId: grant.runId, approved: true as const } }) });
      const result = row(await adapter.dispatch('app_create', { root: grant.sourceRoot, files, metadata }, true));
      if (!result.ok) refuse();
      return { sourceRoot: grant.sourceRoot, fileDigest: bundleHash(files), artifact: result };
    },
    async publish(grant: Grant, signal?: AbortSignal) {
      await attest(grant, signal);
      const inspected = await operation(grant.appSlug, 'inspect', grant.runId, grant.ownerId, signal);
      if (inspected.status !== 'inspected' || typeof inspected.artifactDigest !== 'string') refuse();
      // The issuer owns the private approval ID. Recheck its exact run/app/owner
      // binding here; the graph and model never carry the ID into publish.
      const approval = await operation(grant.appSlug, 'approval-poll', grant.runId, grant.ownerId, signal);
      if (approval.status !== 'approval-approved') refuse();
      const result = await operation(grant.appSlug, 'publish', grant.runId, grant.ownerId, signal);
      if (result.status !== 'published' || typeof result.publicUrl !== 'string' || result.publicUrl !== publicAppAddress({ appSlug: grant.appSlug, userSlug: grant.userSlug })
        || typeof result.deploymentId !== 'string') refuse();
      return { status: 'published' as const, publicUrl: result.publicUrl, deploymentId: result.deploymentId,
        artifactDigest: inspected.artifactDigest, ...(typeof result.port === 'number' ? { port: result.port } : {}) };
    },
  };
}
