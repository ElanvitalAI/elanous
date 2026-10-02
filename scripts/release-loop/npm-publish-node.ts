#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { sendOutbound } from '../../src/domains/outbound-alert.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { emitNodeResult, readGraphContext, type GraphContext } from './node-verdict.js';

type Result = { outcome: 'ok' | 'fail'; verdict: 'pass' | 'fail'; summary: string; npm?: 'published' | 'already-published' | 'staged-not-visible'; humanAction?: 'npm-support' };
type Exec = (command: string, args: string[], env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
type Registry = (url: string) => Promise<{ status: number; body: unknown }>;
export interface NpmPublishDeps {
  exec?: Exec;
  registry?: Registry;
  sleep?: (ms: number) => Promise<void>;
  stateDir?: string;
  /** Test seam — the production root whose secrets/npm-token is the last fallback. */
  productionRoot?: string;
  alert?: (text: string, kind: string) => boolean;
  log?: (version: string, waitedMinutes: number) => void;
}

const exec: Exec = (command, args, env) => {
  const result = spawnSync(command, args, { encoding: 'utf8', env: env ?? process.env, maxBuffer: 1024 * 1024, timeout: 300_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
};
const registry: Registry = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: response.ok ? await response.json() : null };
};
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

export async function runNpmPublish(context: GraphContext = readGraphContext(), deps: NpmPublishDeps = {}): Promise<Result> {
  const version = context.input.version;
  let token = '';
  try {
    if (context.outputs.publish?.outcome !== 'ok') throw new Error('publish must succeed before npm publish');
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
      const [manifest, tags] = await Promise.all([readRegistry(`${PACKAGE_URL}/${version}`), readRegistry(PACKAGE_URL)]);
      if (manifest.status !== 200 && manifest.status !== 404) throw new Error(`npm registry version lookup failed (${manifest.status})`);
      if (tags.status !== 200) throw new Error(`npm registry tags lookup failed (${tags.status})`);
      const latest = tags.body && typeof tags.body === 'object' && 'dist-tags' in tags.body
        ? (tags.body as { 'dist-tags'?: { latest?: unknown } })['dist-tags']?.latest : undefined;
      if (manifest.status === 200 && (metadata(manifest.body).name !== 'elanous' || metadata(manifest.body).version !== version))
        throw new Error('npm registry version metadata mismatch');
      return { visible: manifest.status === 200, tagged: manifest.status === 200 && latest === version };
    };
    const before = await inspect();
    if (before.tagged) return { outcome: 'ok', verdict: 'pass', npm: 'already-published', summary: `npm ${version} already published with latest tag` };
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
        published = run('npm', ['publish', candidate, '--ignore-scripts', '--tag', 'latest', '--access', 'public'], { ...process.env, NPM_CONFIG_USERCONFIG: npmrc });
      } finally { rmSync(dir, { recursive: true, force: true }); }
      const output = `${published.stdout}\n${published.stderr}`;
      const staged = published.status !== 0 && /\bE409\b/i.test(output) && /previously staged/i.test(output);
      if (published.status !== 0 && !staged) throw new Error(`npm publish failed (rc=${published.status}): ${redact(output, token)}`);
    }
    const polls = Math.ceil(waitMinutes * 60 / 30);
    let last = before;
    for (let i = 0; i <= polls; i++) {
      last = await inspect();
      if (last.tagged) return { outcome: 'ok', verdict: 'pass', npm: before.visible ? 'already-published' : 'published', summary: `npm ${version} visible with latest tag` };
      if (i < polls) await wait(Math.min(30_000, waitMinutes * 60_000 - i * 30_000));
    }
    if (last.visible) throw new Error(`npm ${version} visible but dist-tags.latest did not reach ${version} within ${waitMinutes} minutes`);
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
