import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';

export const PUBLIC_HOOK_PATH = '/hooks/linear';
export const PUBLIC_GITHUB_HOOK_PATH = '/hooks/github';
export const PUBLIC_HOOK_PORT = 31481;
const HTTPS_PORT = 8443;
export const HOOK_EXPOSURE_REF = 'hooks.expose:/hooks/linear';
const ON_ARGS = ['funnel', '--bg', `--https=${HTTPS_PORT}`, String(PUBLIC_HOOK_PORT)];
const OFF_ARGS = ['funnel', '--bg', `--https=${HTTPS_PORT}`, 'off'];
const PROBE_PATH = '/.hooks-ingress-identity';
const identityFile = (stateDir?: string) => join(stateDir ?? elanousStateRoot(), 'hooks', 'ingress-identity.json');
interface IngressIdentity { port: number; secret: string }

/** A fresh, private challenge key belongs to the listener that actually bound the port. */
function readIngressIdentity(stateDir?: string): IngressIdentity {
  const identity = JSON.parse(readFileSync(identityFile(stateDir), 'utf8')) as IngressIdentity;
  if (!Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65535 ||
      typeof identity.secret !== 'string' || !/^[a-f0-9]{64}$/.test(identity.secret)) throw new Error('invalid ingress identity');
  return identity;
}

async function verifyIngress(stateDir?: string, port = PUBLIC_HOOK_PORT): Promise<boolean> {
  let identity: IngressIdentity;
  try { identity = readIngressIdentity(stateDir); } catch { return false; }
  if (identity.port !== port) return false;
  const nonce = randomBytes(32).toString('hex');
  try {
    const response = await fetch(`http://127.0.0.1:${port}${PROBE_PATH}`, {
      headers: { 'x-hooks-ingress-challenge': nonce,
        'x-hooks-ingress-proof': createHmac('sha256', identity.secret).update(`request:${nonce}`).digest('hex') },
      signal: AbortSignal.timeout(1500),
    });
    if (response.status !== 200) return false;
    const expected = createHmac('sha256', identity.secret).update(`response:${nonce}`).digest();
    const actual = await response.text();
    return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), expected);
  } catch { return false; }
}

export interface HookExposureState { path: typeof PUBLIC_HOOK_PATH; decisionId: string; openedAt: string }
export interface HookExposureDeps {
  stateDir?: string;
  decision?: (id: string) => DecisionEntry;
  execute?: (binary: string, args: readonly string[]) => void;
  now?: () => Date;
  ingressPort?: number;
  /** Local port the 8443 Funnel currently proxies to, or null (none / unreadable). Default reads `tailscale funnel status --json`. */
  funnelTarget?: () => number | null;
}

/** The loopback port a 8443 Funnel handler proxies to — the only evidence that an unrecorded Funnel is ours. */
export function parseFunnelTarget(statusJson: string): number | null {
  let status: unknown;
  try { status = JSON.parse(statusJson); } catch { return null; }
  const web = (status as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> } | null)?.Web;
  if (!web || typeof web !== 'object') return null;
  for (const [host, entry] of Object.entries(web)) {
    if (!host.endsWith(`:${HTTPS_PORT}`)) continue;
    for (const handler of Object.values(entry?.Handlers ?? {})) {
      const match = typeof handler?.Proxy === 'string' ? /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(handler.Proxy) : null;
      if (match) return Number(match[1]);
    }
  }
  return null;
}

function readFunnelTarget(): number | null {
  const result = spawnSync('tailscale', ['funnel', 'status', '--json'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return parseFunnelTarget(result.stdout);
}

function run(binary: string, args: readonly string[]): void {
  const result = spawnSync(binary, [...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`tailscale command failed${result.error ? `: ${result.error.message}` : ''}`);
}

/** Funnel targets a dedicated loopback listener, never the multi-route hooks receiver or NEXUS. */
export function hookExposurePlan(): { path: string; local: string; decisionRef: string; on: string; off: string } {
  const plan = { path: PUBLIC_HOOK_PATH, local: `http://127.0.0.1:${PUBLIC_HOOK_PORT}`,
    decisionRef: HOOK_EXPOSURE_REF, on: `tailscale ${ON_ARGS.join(' ')}`, off: `tailscale ${OFF_ARGS.join(' ')}` };
  debug.log('hooks.expose', 'plan', { path: plan.path, port: PUBLIC_HOOK_PORT });
  return plan;
}

function stateFile(deps: HookExposureDeps): string { return join(deps.stateDir ?? elanousStateRoot(), 'hooks', 'exposure.json'); }

/** Portable cross-process lock (macOS has no `flock` binary): an atomic `mkdir` lock directory holding the owner pid.
 *  A lock whose owner pid is gone is stale and taken over; otherwise wait up to 30s. */
async function withExposureLock<T>(deps: HookExposureDeps, action: () => Promise<T> | T): Promise<T> {
  const dir = join(deps.stateDir ?? elanousStateRoot(), 'hooks');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'exposure.lock.d');
  const owner = join(lock, 'owner');
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(owner, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = Number.NaN;
      try { holder = Number(readFileSync(owner, 'utf8').trim()); } catch { /* owner not written yet */ }
      const alive = Number.isInteger(holder) && holder > 0 && (() => { try { process.kill(holder, 0); return true; } catch { return false; } })();
      if (Number.isInteger(holder) && holder > 0 && !alive) {
        // Detach atomically, then re-check: only the dead holder's lock is removed — a lock another process just
        // re-created after its own takeover is put back untouched.
        const detached = `${lock}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        try { renameSync(lock, detached); } catch { continue; }
        let detachedHolder = Number.NaN;
        try { detachedHolder = Number(readFileSync(join(detached, 'owner'), 'utf8').trim()); } catch { /* unreadable */ }
        if (detachedHolder === holder) rmSync(detached, { recursive: true, force: true });
        else { try { renameSync(detached, lock); } catch { rmSync(detached, { recursive: true, force: true }); } }
        continue;
      }
      if (Date.now() > deadline) throw new Error('hooks exposure lock unavailable (held for over 30s)');
      await Bun.sleep(25);
    }
  }
  try { return await action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Recorded exposure state; an out-of-band tailscale change is not represented by this file. */
export function hookExposureStatus(deps: HookExposureDeps = {}): HookExposureState | null {
  const file = stateFile(deps);
  if (!existsSync(file)) return null;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (raw === null) return null;
  if (typeof raw !== 'object' || (raw as HookExposureState).path !== PUBLIC_HOOK_PATH ||
      !/^D-\d{8}-\d+$/.test((raw as HookExposureState).decisionId) ||
      !Number.isFinite(Date.parse((raw as HookExposureState).openedAt))) throw new Error('invalid hooks exposure state');
  return raw as HookExposureState;
}

function save(deps: HookExposureDeps, state: HookExposureState | null): void {
  const file = stateFile(deps);
  mkdirSync(join(file, '..'), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

export async function turnHookExposureOn(decisionId: string | undefined, deps: HookExposureDeps = {}): Promise<HookExposureState> {
  const refuse = (reason: string): never => {
    debug.log('hooks.expose', 'refused', { reason });
    throw new Error(`hooks expose on refused: ${reason}`);
  };
  if (!decisionId || !/^D-\d{8}-\d+$/.test(decisionId)) return refuse('valid --decision <D-id> required');
  return withExposureLock(deps, async () => {
    if (hookExposureStatus(deps)) return refuse('already on; turn off first');
    let entry: DecisionEntry;
    try { entry = (deps.decision ?? (id => new DecisionLedger({ stateDir: deps.stateDir }).show(id)))(decisionId); }
    catch { return refuse('decision not found or unreadable'); }
    if (entry.id !== decisionId || entry.status !== 'decided') return refuse('decision is not decided');
    if (entry.category !== 'security' || !entry.refs?.includes(HOOK_EXPOSURE_REF)) return refuse('decision is not for hooks exposure');
    if (entry.decidedBy?.kind !== 'human') return refuse('owner decision required');
    if (!entry.choice || entry.options.find(option => option.key === entry.choice)?.label !== '켬') return refuse('selected option is not 켬');
    if (!await verifyIngress(deps.stateDir, deps.ingressPort)) return refuse('dedicated hooks ingress not running or identity mismatch');
    const state: HookExposureState = { path: PUBLIC_HOOK_PATH, decisionId, openedAt: (deps.now ?? (() => new Date()))().toISOString() };
    const execute = deps.execute ?? run;
    execute('tailscale', ON_ARGS);
    try { save(deps, state); }
    catch (saveError) {
      try { execute('tailscale', OFF_ARGS); }
      catch (rollbackError) {
        debug.log('hooks.expose', 'refused', { reason: 'state save and rollback failed', path: state.path, decisionId, openedAt: state.openedAt });
        throw new AggregateError([saveError, rollbackError],
          `hooks exposure state save and rollback failed; public exposure may still be open (decision ${decisionId}, path ${state.path}, opened ${state.openedAt}); run hooks expose off (or hooks expose off --force)`);
      }
      debug.log('hooks.expose', 'refused', { reason: 'state save failed; exposure rolled back', path: state.path, decisionId });
      throw saveError;
    }
    debug.log('hooks.expose', 'on', { path: state.path, decisionId, openedAt: state.openedAt });
    return state;
  });
}

export interface HookExposureOffResult { changed: boolean; reason: 'recorded' | 'funnel-targets-hook-ingress' | 'forced' | 'not-ours' }

/** Turn off only a Funnel this tool owns: a recorded exposure, or a 8443 Funnel proxying to the dedicated hook ingress
 *  (recovery after a failed state save). Anything else is left alone unless `force` — an unrelated Funnel is not ours. */
export async function turnHookExposureOff(deps: HookExposureDeps = {}, opts: { force?: boolean } = {}): Promise<HookExposureOffResult> {
  return withExposureLock(deps, () => offLocked(deps, opts));
}

function offLocked(deps: HookExposureDeps, opts: { force?: boolean }): HookExposureOffResult {
  const recorded = hookExposureStatus(deps);
  const reason: HookExposureOffResult['reason'] = recorded ? 'recorded'
    : (deps.funnelTarget ?? readFunnelTarget)() === PUBLIC_HOOK_PORT ? 'funnel-targets-hook-ingress'
      : opts.force ? 'forced' : 'not-ours';
  if (reason === 'not-ours') {
    debug.log('hooks.expose', 'off-skipped', { path: PUBLIC_HOOK_PATH, reason });
    return { changed: false, reason };
  }
  (deps.execute ?? run)('tailscale', OFF_ARGS);
  save(deps, null);
  debug.log('hooks.expose', 'off', { path: PUBLIC_HOOK_PATH, reason });
  return { changed: true, reason };
}

/** `hooks serve` shutdown: under the same lock as `on`, close a recorded exposure first, then the ingress — so a Funnel
 *  never outlives the listener it was verified against (another process could bind the port next). */
export async function closeIngressAndExposure(ingress: { stop: () => void } | undefined, deps: HookExposureDeps = {}): Promise<void> {
  await withExposureLock(deps, () => {
    try {
      if (hookExposureStatus(deps)) offLocked(deps, {});
    } catch (error) {
      debug.log('hooks.expose', 'shutdown-off-failed', { path: PUBLIC_HOOK_PATH, error: String(error).slice(0, 200) });
      console.error(`hooks: public exposure may still be open — run \`elanous hooks expose off\` (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      ingress?.stop();
    }
  });
}

/** Only the two exact public hook paths are forwarded; the receiver verifies signatures and queues. */
export function startPublicHookIngress(receiverUrl: string, port = PUBLIC_HOOK_PORT, stateDir?: string): { url: string; stop: () => void } {
  const receiver = new URL(receiverUrl);
  if (receiver.protocol !== 'http:' || (receiver.hostname !== '127.0.0.1' && receiver.hostname !== 'localhost' && receiver.hostname !== '[::1]'))
    throw new Error('public ingress requires loopback receiver');
  const secret = randomBytes(32).toString('hex');
  const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === PROBE_PATH && request.method === 'GET') {
      const nonce = request.headers.get('x-hooks-ingress-challenge');
      const proof = request.headers.get('x-hooks-ingress-proof');
      if (!nonce || !/^[a-f0-9]{64}$/.test(nonce) || !proof || !/^[a-f0-9]{64}$/.test(proof))
        return new Response('Not Found', { status: 404 });
      const expected = createHmac('sha256', secret).update(`request:${nonce}`).digest();
      if (!timingSafeEqual(Buffer.from(proof, 'hex'), expected)) return new Response('Not Found', { status: 404 });
      return new Response(createHmac('sha256', secret).update(`response:${nonce}`).digest('hex'));
    }
    if (path !== PUBLIC_HOOK_PATH && path !== PUBLIC_GITHUB_HOOK_PATH) return new Response('Not Found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return fetch(new URL(path, receiver), { method: 'POST', headers: request.headers, body: request.body });
  } });
  const file = identityFile(stateDir);
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ port: server.port, secret }), { mode: 0o600 });
  } catch (error) { server.stop(); throw error; }
  return { url: server.url.toString(), stop: () => {
    server.stop();
    try { if (readIngressIdentity(stateDir).secret === secret) unlinkSync(file); } catch { /* identity already removed */ }
  } };
}
