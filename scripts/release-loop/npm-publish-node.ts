#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { sendOutbound } from '../../src/domains/outbound-alert.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { emitNodeResult, readGraphContext, type GraphContext } from './node-verdict.js';
import { prereleaseKind } from './release-version.js';

type Result = { outcome: 'ok' | 'fail'; verdict: 'pass' | 'fail'; summary: string; npm?: 'published' | 'already-published' | 'staged-not-visible'; humanAction?: 'npm-support' };
type ExecResult = { status: number | null; stdout: string; stderr: string; durationMs?: number; signal?: NodeJS.Signals | null };
type Exec = (command: string, args: string[], env?: NodeJS.ProcessEnv) => ExecResult;
type Registry = (url: string) => Promise<{ status: number; body: unknown }>;
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
type PublishSpawn = { version: string; durationMs: number; status: number | null; signal: NodeJS.Signals | null };
export interface NpmPublishDeps {
  exec?: Exec;
  registry?: Registry;
  sleep?: (ms: number) => Promise<void>;
  stateDir?: string;
  /** Test seam — the production root whose secrets/npm-token is the last fallback. */
  productionRoot?: string;
  alert?: (text: string, kind: string) => boolean;
  log?: (version: string, waitedMinutes: number) => void;
  publishSpawn?: (event: PublishSpawn) => void;
}

const exec: Exec = (command, args, env) => {
  const startedAt = performance.now();
  const result = spawnSync(command, args, { encoding: 'utf8', env: env ?? process.env, maxBuffer: 1024 * 1024, timeout: 300_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? ''), durationMs: Math.ceil(performance.now() - startedAt), signal: result.signal };
};
export async function fetchNpmRegistry(url: string, timeoutMs = REGISTRY_FETCH_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: timeout });
    return { status: response.status, body: response.ok ? await response.json() : null };
  }
  catch (error) {
    if (timeout.aborted) throw Object.assign(new Error(`registry request exceeded ${timeoutMs}ms`), { name: 'NpmRegistryFetchTimeoutError', timeoutMs });
    throw error;
  }
}
const registry: Registry = fetchNpmRegistry;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const PACKAGE_URL = 'https://registry.npmjs.org/elanous';

function redact(text: string, token: string): string {
  return token ? text.replaceAll(token, '[REDACTED]') : text;
}
function reason(error: unknown, token: string): string {
  return redact(error instanceof Error ? error.message : String(error), token).replace(/[\r\n]+/g, ' ').slice(0, 500);
}
function metadata(value: unknown): { name?: string; version?: string } {
  if (!value || typeof value !== 'object') return {};
  return value as { name?: string; version?: string };
}
function registryFailure(error: unknown, url: string): Error {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const endpoint = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  if (name === 'NpmRegistryFetchTimeoutError') {
    const timeoutMs = error && typeof error === 'object' && 'timeoutMs' in error && typeof error.timeoutMs === 'number' ? error.timeoutMs : REGISTRY_FETCH_TIMEOUT_MS;
    return new Error(`npm registry fetch timeout after ${timeoutMs}ms (${endpoint || '/'})`);
  }
  return new Error(`npm registry fetch failed (${endpoint || '/'}): ${message}`);
}
function publishLogDirectory(context: GraphContext, stateDir: string): string {
  const contextLocation = process.env.ELANOUS_GRAPH_CONTEXT;
  if (contextLocation && !contextLocation.trimStart().startsWith('{')) {
    const contextPath = resolve(contextLocation);
    const runDirectory = dirname(contextPath);
    const runDirectoryName = basename(runDirectory);
    if (basename(contextPath).endsWith('.json') && runDirectoryName.endsWith('.json.contexts')) {
      const pathRunId = runDirectoryName.slice(0, -'.json.contexts'.length);
      if (context.runId && pathRunId !== context.runId) throw new Error('npm publish graph context runId/path mismatch');
      return join(runDirectory, 'npm-publish');
    }
  }
  if (context.runId && /^[a-zA-Z0-9._-]+$/.test(context.runId))
    return join(stateDir, 'graph-runs', 'release-loop', `${context.runId}.json.contexts`, 'npm-publish');
  // Direct non-graph calls have no run folder; retain compatibility in their version output directory.
  return join(stateDir, 'release', context.input.version, 'npm-publish');
}

export async function runNpmPublish(context: GraphContext = readGraphContext(), deps: NpmPublishDeps = {}): Promise<Result> {
  const version = context.input.version;
  let token = '';
  // RELEASE-REHEARSAL-RC: a prerelease goes to `next` so `npm i elanous` never resolves to a rehearsal build.
  let distTag = 'latest';
  try {
    if (context.outputs.publish?.outcome !== 'ok') throw new Error('publish must succeed before npm publish');
    distTag = prereleaseKind(version) === null ? 'latest' : 'next';
    const stateDir = deps.stateDir ?? effectiveInstanceRoot();
    // REL3 — the archive prepare actually built (its output) wins over this process's universe: a resumed run can
    // resolve another universe (10-01 0.2.7: prepared in the pilot test universe, resumed in production).
    const prepared = context.outputs.prepare?.candidate;
    const candidate = typeof prepared === 'string' && prepared.endsWith('.tgz') ? prepared : join(stateDir, 'release', version, 'prepared', 'dist', 'elanous.tgz');
    const run = deps.exec ?? exec;
    const readRegistry = deps.registry ?? registry;
    const wait = deps.sleep ?? sleep;
    const waitMinutes = context.input.npmWaitMinutes ?? 40;
    if (typeof waitMinutes !== 'number' || !Number.isFinite(waitMinutes) || waitMinutes < 0 || waitMinutes > 40) throw new Error('input.npmWaitMinutes must be between 0 and 40');
    const archive = run('tar', ['-xOzf', candidate, 'package/package.json']);
    if (archive.status !== 0) throw new Error(`npm archive invalid: ${archive.stderr}`);
    const pkg = metadata(JSON.parse(archive.stdout));
    if (pkg.name !== 'elanous' || pkg.version !== version) throw new Error('npm archive package name/version mismatch');
    const inspect = async (): Promise<{ visible: boolean; tagged: boolean }> => {
      const versionUrl = `${PACKAGE_URL}/${version}`;
      const tagsUrl = PACKAGE_URL;
      let manifest: { status: number; body: unknown };
      let tags: { status: number; body: unknown };
      const read = (url: string) => readRegistry(url).catch((error: unknown) => { throw registryFailure(error, url); });
      [manifest, tags] = await Promise.all([read(versionUrl), read(tagsUrl)]);
      if (manifest.status !== 200 && manifest.status !== 404)
        throw new Error(`npm registry version lookup failed (${manifest.status}; ${new URL(versionUrl).pathname})`);
      if (tags.status !== 200)
        throw new Error(`npm registry tags lookup failed (${tags.status}; ${new URL(tagsUrl).pathname})`);
      const tagged = tags.body && typeof tags.body === 'object' && 'dist-tags' in tags.body
        ? (tags.body as { 'dist-tags'?: Record<string, unknown> })['dist-tags']?.[distTag] : undefined;
      if (manifest.status === 200 && (metadata(manifest.body).name !== 'elanous' || metadata(manifest.body).version !== version))
        throw new Error('npm registry version metadata mismatch');
      return { visible: manifest.status === 200, tagged: manifest.status === 200 && tagged === version };
    };
    const before = await inspect();
    if (before.tagged) return { outcome: 'ok', verdict: 'pass', npm: 'already-published', summary: `npm ${version} already published with ${distTag} tag` };
    if (!before.visible) {
      // The npm token is a machine secret (like the GitHub App key): input → this universe → the production root.
      const tokenFile = context.input.npmTokenFile ?? [join(stateDir, 'secrets', 'npm-token'), join(deps.productionRoot ?? prodInstanceRoot(), 'secrets', 'npm-token')].find((p) => existsSync(p)) ?? join(stateDir, 'secrets', 'npm-token');
      if (typeof tokenFile !== 'string' || !tokenFile.trim()) throw new Error('input.npmTokenFile must be a path');
      token = readFileSync(tokenFile, 'utf8').trim();
      if (!token) throw new Error('npm token file empty');
      const dir = mkdtempSync(join(tmpdir(), 'release-npmrc-'));
      let published;
      try {
        const npmrc = join(dir, 'npmrc');
        writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600, flag: 'wx' });
        const logDir = publishLogDirectory(context, stateDir);
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
        chmodSync(logDir, 0o700);
        const publishStartedAt = performance.now();
        published = run('npm', ['publish', candidate, '--ignore-scripts', '--tag', distTag, '--access', 'public', '--logs-dir', logDir], { ...process.env, NPM_CONFIG_USERCONFIG: npmrc });
        const durationMs = published.durationMs ?? Math.ceil(performance.now() - publishStartedAt);
        try { (deps.publishSpawn ?? ((event) => debug.log('release-loop.npm', 'publish-spawn', event)))({ version, durationMs, status: published.status, signal: published.signal ?? null }); } catch { /* telemetry must not mask publish result */ }
      } finally { rmSync(dir, { recursive: true, force: true }); }
      const output = `${published.stdout}\n${published.stderr}`;
      const staged = published.status !== 0 && /\bE409\b/i.test(output) && /previously staged/i.test(output);
      if (published.status !== 0 && !staged) throw new Error(`npm publish failed (rc=${published.status}): ${redact(output, token)}`);
    }
    const polls = Math.ceil(waitMinutes * 60 / 30);
    let last = before;
    for (let i = 0; i <= polls; i++) {
      last = await inspect();
      if (last.tagged) return { outcome: 'ok', verdict: 'pass', npm: before.visible ? 'already-published' : 'published', summary: `npm ${version} visible with ${distTag} tag` };
      if (i < polls) await wait(Math.min(30_000, waitMinutes * 60_000 - i * 30_000));
    }
    if (last.visible) throw new Error(`npm ${version} visible but dist-tags.${distTag} did not reach ${version} within ${waitMinutes} minutes`);
    try { (deps.log ?? ((v, minutes) => debug.log('release-loop.npm', 'staged-not-visible', { version: v, waitedMinutes: minutes })))(version, waitMinutes); } catch { /* observation must not mask npm's staged state */ }
    try { (deps.alert ?? sendOutbound)(`npm ${version} 가 스테이징에 멈춤 — 계정 소유자 확인 필요`, 'alert'); } catch { /* alert failure must not block docs */ }
    return { outcome: 'ok', verdict: 'pass', npm: 'staged-not-visible', humanAction: 'npm-support', summary: 'npm 스테이징 — 레지스트리에 아직 없음' };
  } catch (error) {
    return { outcome: 'fail', verdict: 'fail', summary: `npm ${version} failed: ${reason(error, token)}` };
  }
}

if (import.meta.main) {
  let version = '';
  try {
    const context = readGraphContext();
    version = context.input.version;
    const result = await runNpmPublish(context);
    debug.log('release-loop.npm', 'result', { version, outcome: result.outcome, npm: result.npm });
    emitNodeResult(result);
    process.exitCode = result.outcome === 'ok' ? 0 : 1;
  } catch {
    emitNodeResult({ outcome: 'fail', verdict: 'fail', summary: 'npm publish context unavailable' });
    process.exitCode = 1;
  }
}
