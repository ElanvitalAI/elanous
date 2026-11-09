import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { publicAppAddress } from './console-address.js';
import { resolveAppDeploymentOwner, type AppMemberOwnerReceipt } from './app-deployment-owner.js';
import { parseAppManifest } from './app-contract.js';
import { parsePublicAppHost } from '../../relay/relay-server.js';

const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TEMPLATE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_BODY_BYTES = 4_096;
const LECTURE_TEMPLATE_ID = 'next-app-lecture-scrap';
const LECTURE_APP_SLUG = 'lecture-scrap';
const LECTURE_VERIFY_TEXT = '분산 시스템 특강';
const APP_SESSION_COOKIE = '__Host-app-session';
const APP_SESSION_TOKEN = /^aps_[A-Za-z0-9_-]{32,4092}$/;

export interface AppSiteDeploymentSource {
  readonly appRoot: string;
  readonly appSlug?: string;
}

export interface AppSiteDeploymentBuild {
  readonly appRoot: string;
  /** Non-empty text that must be visible in the published document. */
  readonly verifyText: string;
}

export interface AppSiteDeploymentOwner extends AppMemberOwnerReceipt {}

export interface AppSiteDeploymentRuntime {
  /** Resolves the authenticated member through GET /v1/members/owner; simulations inject that response. */
  readonly resolveOwner: (request: Request, appSlug: string) => Promise<AppSiteDeploymentOwner | null>;
  readonly configuredPublicUserId?: string;
  readonly createFromTemplate: (input: { appSlug: string; templateId: string; userSlug: string; owner: AppSiteDeploymentOwner }) => Promise<AppSiteDeploymentSource>;
  /** Removes only a source directory created by this deployment attempt. */
  readonly discard?: (source: AppSiteDeploymentSource) => Promise<void>;
  readonly build: (input: { appSlug: string; source: AppSiteDeploymentSource }) => Promise<AppSiteDeploymentBuild>;
  readonly publish: (input: { appSlug: string; userSlug: string; publicUrl: string; build: AppSiteDeploymentBuild; owner: AppSiteDeploymentOwner }) => Promise<void>;
  readonly verify: (input: { publicUrl: string; verifyText: string }) => Promise<{ status: number; body: string }>;
}

export type AppSiteDeploymentOperations = Pick<AppSiteDeploymentRuntime,
  'createFromTemplate' | 'build' | 'publish' | 'verify'> & Partial<Pick<AppSiteDeploymentRuntime, 'discard'>>;

/** Calls the NM-1 endpoint and forwards only the app-session credentials supplied by the caller. */
export async function fetchAppMemberOwner(
  request: Request,
  appSlug: string,
  endpointOrigin: string,
  fetcher: typeof fetch = fetch,
): Promise<AppSiteDeploymentOwner | null> {
  const rawCookie = request.headers.get('cookie') ?? '';
  const appCookieParts = rawCookie.split(';').map(part => part.trim())
    .filter(part => part.slice(0, part.indexOf('=')).trim() === APP_SESSION_COOKIE);
  if (appCookieParts.length > 1) return null;
  const cookieToken = appCookieParts.length === 1
    ? appCookieParts[0]!.slice(appCookieParts[0]!.indexOf('=') + 1).trim()
    : undefined;
  const rawAuthorization = request.headers.get('authorization') ?? '';
  const bearer = /^Bearer (aps_[A-Za-z0-9_-]{32,4092})$/i.exec(rawAuthorization)?.[1];
  if (cookieToken !== undefined && !APP_SESSION_TOKEN.test(cookieToken)) return null;
  if (cookieToken === undefined && !bearer) return null;
  let endpoint: URL;
  try {
    const base = new URL(endpointOrigin);
    if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return null;
    endpoint = new URL('/v1/members/owner', base);
    endpoint.searchParams.set('appSlug', appSlug);
  } catch { return null; }
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5_000),
      headers: {
        ...(cookieToken !== undefined ? { cookie: `${APP_SESSION_COOKIE}=${cookieToken}` } : { authorization: `Bearer ${bearer}` }),
        accept: 'application/json',
      },
    });
  } catch { return null; }
  if (response.status !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) return null;
  let value: unknown;
  try { value = await response.json(); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['memberId', 'userSlug', 'plan', 'entitlements'].includes(key))
    || typeof record.memberId !== 'string' || !record.memberId.trim()
    || typeof record.userSlug !== 'string' || typeof record.plan !== 'string'
    || !record.entitlements || typeof record.entitlements !== 'object' || Array.isArray(record.entitlements)) return null;
  return {
    memberId: record.memberId,
    userSlug: record.userSlug,
    plan: record.plan,
    entitlements: record.entitlements as Readonly<Record<string, unknown>>,
  };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function runBuildCommand(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, args, {
      cwd, env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
      stdio: 'ignore', detached: process.platform !== 'win32',
    });
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      } else child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.pid !== undefined && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      }, 5_000);
      forceTimer.unref();
    }, 300_000);
    timer.unref();
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      rejectBuild(new Error('app build process failed to start'));
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (code === 0) resolveBuild();
      else rejectBuild(new Error('app build failed'));
    });
  });
}

/** Default first-publication adapter for the approved KAIST lecture template. */
export function createLectureScrapDeploymentOperations(input: {
  readonly appsRoot: string;
  readonly templatesRoot: string;
  readonly fetch?: typeof fetch;
  /** Test seam for the build process; production uses the real bounded subprocess runner. */
  readonly runBuild?: (args: readonly string[], cwd: string) => Promise<void>;
}): AppSiteDeploymentOperations {
  const appsRoot = resolve(input.appsRoot);
  const templatesRoot = resolve(input.templatesRoot);
  const fetchPublic = input.fetch ?? fetch;
  const runBuild = input.runBuild ?? runBuildCommand;
  const ownedDirectories = new Map<string, { dev: string; ino: string }>();
  return {
    async createFromTemplate({ appSlug, templateId }) {
      if (appSlug !== LECTURE_APP_SLUG || templateId !== LECTURE_TEMPLATE_ID) {
        throw new Error('template is not in the app deployment allowlist');
      }
      const canonicalTemplatesRoot = realpathSync(templatesRoot);
      const templatePath = join(templatesRoot, templateId);
      const templateRoot = realpathSync(templatePath);
      if (!inside(canonicalTemplatesRoot, templateRoot) || !existsSync(join(templateRoot, 'app.yaml'))) {
        throw new Error('approved app template is unavailable');
      }
      const manifest = parseAppManifest(readFileSync(join(templateRoot, 'app.yaml'), 'utf8'));
      if (!manifest.ok || manifest.manifest.slug !== appSlug) throw new Error('template app contract is invalid');
      const appRoot = join(appsRoot, appSlug);
      mkdirSync(appsRoot, { recursive: true });
      // The exclusive mkdir proves this request owns the directory before cleanup can remove it.
      mkdirSync(appRoot);
      try { cpSync(templateRoot, appRoot, { recursive: true, force: false }); }
      catch (error) { rmSync(appRoot, { recursive: true, force: true }); throw error; }
      const identity = lstatSync(appRoot, { bigint: true });
      ownedDirectories.set(appRoot, { dev: identity.dev.toString(), ino: identity.ino.toString() });
      return { appRoot, appSlug };
    },
    async discard(source) {
      const appRoot = resolve(source.appRoot);
      const owned = ownedDirectories.get(appRoot);
      if (!owned || source.appSlug !== LECTURE_APP_SLUG || !inside(appsRoot, appRoot)) return;
      try {
        const current = lstatSync(appRoot, { bigint: true });
        if (current.isDirectory() && !current.isSymbolicLink()
          && current.dev.toString() === owned.dev && current.ino.toString() === owned.ino) {
          rmSync(appRoot, { recursive: true, force: true });
        }
      } catch { /* absent source is already discarded */ }
      ownedDirectories.delete(appRoot);
    },
    async build({ appSlug, source }) {
      if (appSlug !== LECTURE_APP_SLUG || !inside(appsRoot, resolve(source.appRoot))) throw new Error('app source is outside the app root');
      await runBuild(['install', '--no-progress'], source.appRoot);
      await runBuild(['run', 'build'], source.appRoot);
      const outputRoot = resolve(source.appRoot, 'out');
      if (!inside(source.appRoot, outputRoot)) throw new Error('app build output escapes its root');
      const indexPath = join(outputRoot, 'index.html');
      const html = readFileSync(indexPath, 'utf8');
      if (!html.includes(LECTURE_VERIFY_TEXT)) throw new Error('app build output does not contain the approved template content');
      const verifyText = `elanous-deploy-${randomUUID()}`;
      if (!/<body\b[^>]*>/i.test(html)) throw new Error('app build output has no document body');
      writeFileSync(indexPath, html.replace(/<body\b[^>]*>/i, match => `${match}<span hidden data-elanous-deploy-verification="${verifyText}"></span>`));
      return { appRoot: outputRoot, verifyText };
    },
    async publish({ appSlug, userSlug, publicUrl, build }) {
      const expectedUrl = publicAppAddress({ appSlug, userSlug });
      if (publicUrl !== expectedUrl || !inside(appsRoot, resolve(build.appRoot))) throw new Error('app publish target is invalid');
      // The Nexus wire mounts the validated app root immediately after this stage.
    },
    async verify({ publicUrl, verifyText }) {
      const parsed = new URL(publicUrl);
      const host = parsePublicAppHost(parsed.host);
      if (parsed.protocol !== 'https:' || !host || parsed.pathname !== '/') throw new Error('app verify URL is invalid');
      const response = await fetchPublic(publicUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, body: '' };
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel().catch(() => undefined); break; }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return { status: response.status, body: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8') };
    },
  };
}

export interface AppSiteDeployRawOutput {
  readonly kind: 'site-deploy';
  readonly status: 'success' | 'failed';
  readonly publicUrl?: string;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

async function readTemplateId(request: Request): Promise<string | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(part.value);
    }
  } catch { return undefined; }
  finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== 'templateId')) return undefined;
    if (typeof record.templateId !== 'string' || !TEMPLATE_ID.test(record.templateId)) return undefined;
    return record.templateId;
  } catch { return undefined; }
}

/** Owner-only Nexus hook. Every stage is injected so simulation can exercise the same API without a real publish. */
export function createAppSiteDeployRoute(runtime?: AppSiteDeploymentRuntime) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const match = /^\/v1\/apps\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/deploy$/.exec(url.pathname);
    if (!match) return undefined;
    if (request.method.toUpperCase() !== 'POST') return jsonError('method-not-allowed', 405);
    const appSlug = match[1]!;
    if (!APP_SLUG.test(appSlug) || appSlug.length > 24) return jsonError('invalid-app-slug', 400);
    if (!runtime) return jsonError('app-site-deploy-not-wired', 503);
    let owner: AppSiteDeploymentOwner | null = null;
    try { owner = await runtime.resolveOwner(request, appSlug); } catch { /* fail closed */ }
    if (!owner) return jsonError('unauthorized', 401);
    let userSlug: string;
    try { userSlug = resolveAppDeploymentOwner('member', runtime.configuredPublicUserId, owner); }
    catch { return jsonError('unauthorized', 401); }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) return jsonError('json-required', 415);
    const templateId = await readTemplateId(request);
    if (!templateId) return jsonError('invalid-deploy-request', 400);
    let publicUrl: string | undefined;
    let source: AppSiteDeploymentSource | undefined;
    try {
      publicUrl = publicAppAddress({ appSlug, userSlug });
      source = await runtime.createFromTemplate({ appSlug, templateId, userSlug, owner });
      const build = await runtime.build({ appSlug, source });
      if (!build.verifyText.trim()) throw new Error('build verification text is required');
      await runtime.publish({ appSlug, userSlug, publicUrl, build, owner });
      const verified = await runtime.verify({ publicUrl, verifyText: build.verifyText });
      if (verified.status !== 200 || !verified.body.includes(build.verifyText)) throw new Error('published app verification failed');
      const rawOutput: AppSiteDeployRawOutput = { kind: 'site-deploy', status: 'success', publicUrl };
      return Response.json({ rawOutput }, { status: 200, headers: { 'cache-control': 'no-store' } });
    } catch {
      if (source) {
        try { await runtime.discard?.(source); } catch { /* preserve the deployment failure response */ }
      }
      const rawOutput: AppSiteDeployRawOutput = { kind: 'site-deploy', status: 'failed' };
      return Response.json({ rawOutput }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  };
}
