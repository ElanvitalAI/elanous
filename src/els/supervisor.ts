// els supervisor — the ONE process that keeps `els serve` alive: a launchd user agent (macOS). `els` with no arguments
// makes sure it exists and that the server answers, so nobody has to start anything by hand.
//   - first run: install the agent automatically and say so in one line; later runs print nothing,
//   - `els supervisor off` stops it and remembers (no automatic reinstall until `els supervisor on`),
//   - install fails (no launchctl, not macOS, write error) → the server is started directly instead, and an event is recorded,
//   - a state dir other than the default (tests, isolated worlds) NEVER touches launchd: the server is started directly.
// "Only one server" still holds: the socket decides (src/els/server.ts); the supervisor is just the one who restarts it.

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SUPERVISOR_LABEL = 'dev.elanous.els';

export interface SupervisorPaths {
  readonly plist: string;
  readonly offMarker: string;
  readonly events: string;
  readonly log: string;
}

export function supervisorPaths(stateRoot: string, home: string = homedir()): SupervisorPaths {
  return {
    plist: join(home, 'Library', 'LaunchAgents', `${SUPERVISOR_LABEL}.plist`),
    offMarker: join(stateRoot, 'els', 'supervisor-off'),
    events: join(stateRoot, 'els', 'events.jsonl'),
    log: join(stateRoot, 'els', 'serve.log'),
  };
}

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd job: run `<command…>` (…`side serve`) at load, restart it when it dies. */
export function renderPlist(command: readonly string[], logPath: string, pathEnv: string): string {
  const args = command.map((part) => `    <string>${xml(part)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SUPERVISOR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(pathEnv)}</string><key>COLORTERM</key><string>truecolor</string></dict>
</dict>
</plist>
`;
}

export interface SupervisorDeps {
  readonly stateRoot: string;
  /** true when the state dir is the default one (the real user world). */
  readonly isDefaultState: boolean;
  readonly platform: NodeJS.Platform;
  readonly paths: SupervisorPaths;
  /** `<elanous> side serve` as an argv. */
  readonly serveCommand: readonly string[];
  readonly pathEnv: string;
  /** Run launchctl with these args; resolves to its exit code and output. */
  readonly launchctl: (args: readonly string[]) => Promise<{ code: number; output: string }>;
  readonly uid: number;
  /** Start `serveCommand` detached (no supervisor). Throws when it cannot even be started. */
  readonly spawnDetached: (command: readonly string[], logPath: string) => void;
  readonly serverState: () => Promise<'live' | 'dead' | 'none'>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly notify: (line: string) => void;
}

export type EnsureResult = { ok: true; how: 'already' | 'supervisor' | 'direct' } | { ok: false; message: string };

const recordEvent = (deps: SupervisorDeps, event: Record<string, unknown>): void => {
  try {
    mkdirSync(dirname(deps.paths.events), { recursive: true, mode: 0o700 });
    appendFileSync(deps.paths.events, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  } catch { /* an event that cannot be written must not stop `els` */ }
};

// 출처: launchd starts the job at once; the server binds its socket within a few seconds on the gate hosts (same limit as
// the els-cli serve-ready wait).
const SERVER_WAIT_MS = 8_000;
const POLL_MS = 100;

async function waitForServer(deps: SupervisorDeps): Promise<boolean> {
  const deadline = deps.now() + SERVER_WAIT_MS;
  while (deps.now() < deadline) {
    if (await deps.serverState() === 'live') return true;
    await deps.sleep(POLL_MS);
  }
  return false;
}

export async function installAgent(deps: SupervisorDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (deps.platform !== 'darwin') return { ok: false, reason: `no launchd on ${deps.platform}` };
  try {
    mkdirSync(dirname(deps.paths.plist), { recursive: true });
    mkdirSync(dirname(deps.paths.log), { recursive: true, mode: 0o700 });
    writeFileSync(deps.paths.plist, renderPlist(deps.serveCommand, deps.paths.log, deps.pathEnv), { mode: 0o644 });
  } catch (error) { return { ok: false, reason: `cannot write ${deps.paths.plist}: ${error instanceof Error ? error.message : String(error)}` }; }
  const domain = `gui/${deps.uid}`;
  // bootout first so a changed plist is picked up; "not loaded" is fine.
  await deps.launchctl(['bootout', `${domain}/${SUPERVISOR_LABEL}`]).catch(() => undefined);
  const started = await deps.launchctl(['bootstrap', domain, deps.paths.plist]).catch((error: unknown) => ({ code: 127, output: String(error) }));
  return started.code === 0 ? { ok: true } : { ok: false, reason: `launchctl bootstrap failed (${started.code}): ${started.output.trim().slice(0, 200)}` };
}

/** `els` with no arguments: make sure a server answers. Prints one line only when it installs the agent. */
export async function ensureServer(deps: SupervisorDeps): Promise<EnsureResult> {
  if (await deps.serverState() === 'live') return { ok: true, how: 'already' };
  if (existsSync(deps.paths.offMarker)) {
    return { ok: false, message: 'els: no server is running and the supervisor is off — start it with `els supervisor on` (or `els serve`)' };
  }
  let why = deps.isDefaultState ? '' : 'isolated state dir (no launchd agent)';
  if (deps.isDefaultState) {
    const installed = existsSync(deps.paths.plist);
    const result = installed
      ? await deps.launchctl(['kickstart', `gui/${deps.uid}/${SUPERVISOR_LABEL}`]).then((r) => r.code === 0 ? { ok: true as const } : installAgent(deps))
      : await installAgent(deps);
    if (result.ok) {
      if (!installed) deps.notify('els: 감독자 설치함 · 끄기 = els supervisor off');
      if (await waitForServer(deps)) return { ok: true, how: 'supervisor' };
      why = 'the supervisor started but no server answered in time';
    } else why = result.reason;
    recordEvent(deps, { event: 'supervisor-failed', reason: why });
  }
  // No supervisor: start the server directly (the socket still keeps it to one).
  try { deps.spawnDetached(deps.serveCommand, deps.paths.log); }
  catch (error) {
    recordEvent(deps, { event: 'serve-spawn-failed', reason: error instanceof Error ? error.message : String(error) });
    return { ok: false, message: `els: cannot start the server (${why}): ${error instanceof Error ? error.message : String(error)}` };
  }
  recordEvent(deps, { event: 'serve-direct', reason: why });
  return await waitForServer(deps)
    ? { ok: true, how: 'direct' }
    : { ok: false, message: `els: the server did not answer within ${SERVER_WAIT_MS / 1000} s — see ${deps.paths.log}` };
}

/**
 * `els supervisor off`: stop the agent and keep it from coming back by itself. In an isolated state dir (tests,
 * isolated worlds) it only writes that dir's marker: the launchd agent and its plist belong to the real user world and
 * are never touched from there.
 */
export async function supervisorOff(deps: SupervisorDeps): Promise<string> {
  mkdirSync(dirname(deps.paths.offMarker), { recursive: true, mode: 0o700 });
  writeFileSync(deps.paths.offMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  if (!deps.isDefaultState) return 'els: supervisor off for this isolated state dir (the launchd agent was not touched)';
  if (deps.platform === 'darwin' && existsSync(deps.paths.plist)) {
    await deps.launchctl(['bootout', `gui/${deps.uid}/${SUPERVISOR_LABEL}`]).catch(() => undefined);
    try { rmSync(deps.paths.plist); } catch { /* already gone */ }
  }
  return 'els: supervisor off (a running server keeps running until it exits; turn back on with `els supervisor on`)';
}

export async function supervisorOn(deps: SupervisorDeps): Promise<string> {
  try { rmSync(deps.paths.offMarker, { force: true }); } catch { /* none */ }
  const result = await ensureServer(deps);
  return result.ok ? `els: supervisor on (server ${result.how})` : result.message;
}

export function supervisorStatus(deps: SupervisorDeps, server: 'live' | 'dead' | 'none'): string {
  const agent = existsSync(deps.paths.plist) ? 'installed' : 'not installed';
  const off = existsSync(deps.paths.offMarker) ? ' · OFF (marker present)' : '';
  return `els supervisor: ${agent}${off} · server ${server === 'live' ? 'answering' : 'not answering'} · ${deps.isDefaultState ? 'default state' : 'isolated state (never uses launchd)'}`;
}

type InstallInput = { readonly prefixEnv?: string; readonly home: string; readonly exists: (path: string) => boolean; readonly execPath: string; readonly entry?: string };

/** THIS install's `elanous` (what `eln` is): the prefix the running `els` belongs to (ELANOUS_INSTALL_PREFIX, else the
 *  default one) — so an isolated install never runs another version. When that wrapper is missing the running entry itself. */
export function elanousCommandFor(input: InstallInput): string[] {
  // `trim()` only decides «is anything there»; a real path keeps its own spaces (`/tmp/iso ` is not `/tmp/iso`).
  const prefix = input.prefixEnv && input.prefixEnv.trim() !== '' ? input.prefixEnv : `${input.home}/.local/share/elanous`;
  const wrapper = `${prefix}/bin/elanous`;
  return input.exists(wrapper) ? [wrapper] : [input.execPath, input.entry ?? 'elanous'];
}

/** The command that starts the owner: this install's `elanous side serve`. */
export function serveCommandFor(input: InstallInput): string[] {
  return [...elanousCommandFor(input), 'side', 'serve'];
}
