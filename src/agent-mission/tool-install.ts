import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectDistroFamily, toolInstallLine, type DistroFamily } from '../cli/doctor-distro.js';
import { debug } from '../debug/log.js';
import { emitDecision, type DecisionEvent } from '../live/detail-switch.js';

type RemedyTool = 'gh' | 'rg' | 'node' | 'codex' | 'jq' | 'ffmpeg';
export type SmokeTool = RemedyTool | 'git';

export const SMOKE_CHECKS: Record<SmokeTool, { cmd: string[]; stdin?: string; expect: RegExp }> = {
  jq: { cmd: ['jq', '.a'], stdin: '{"a":1}', expect: /^1$/ },
  rg: { cmd: ['rg', '-c', 'x'], stdin: 'x\n', expect: /^1$/ },
  node: { cmd: ['node', '-e', 'console.log(1+1)'], expect: /^2$/ },
  ffmpeg: { cmd: ['ffmpeg', '-hide_banner', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-f', 'null', '-'], expect: /^[\s\S]*$/ },
  gh: { cmd: ['gh', 'help'], expect: /^[\s\S]*$/ },
  codex: { cmd: ['codex', '--help'], expect: /^[\s\S]*$/ },
  git: { cmd: ['git', 'init', '-q'], expect: /^[\s\S]*$/ },
};

type ExecResult = { status: number | null; stdout?: string; stderr?: string };
type PtyProbe = { status: 'ok'; output: string; exitCode: number } | { status: 'unavailable'; detail: string };
export interface SmokeDeps {
  exec?: (cmd: string[], opts: { stdin?: string; timeoutMs: number }) => ExecResult;
}

function defaultExec(cmd: string[], opts: { stdin?: string; timeoutMs: number }): ExecResult {
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    input: opts.stdin, timeout: opts.timeoutMs, encoding: 'utf8',
  });
  return { status: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 127 : result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + (result.error ? String(result.error) : '') };
}

/** Verify a small real operation, not just the executable's version string. */
export function smokeCheck(tool: SmokeTool, deps: SmokeDeps = {}): { ok: boolean; detail: string; unavailable?: boolean } {
  const check = SMOKE_CHECKS[tool];
  let directory: string | undefined;
  try {
    const cmd = [...check.cmd];
    if (tool === 'git') {
      directory = mkdtempSync(join(tmpdir(), 'elanous-git-smoke-'));
      cmd.push(join(directory, 'repo'));
    }
    const result = (deps.exec ?? defaultExec)(cmd, { ...(check.stdin === undefined ? {} : { stdin: check.stdin }), timeoutMs: 20_000 });
    const output = (result.stdout ?? '').trim();
    if (result.status === null) return { ok: false, unavailable: true, detail: `${tool} smoke unavailable: ${(result.stderr ?? 'no exit status').slice(-400)}` };
    const ok = result.status === 0 && check.expect.test(output);
    return { ok, detail: ok ? `${tool} smoke passed` : `${tool} smoke failed (exit ${result.status}): ${((result.stderr ?? '').trim() || output || 'no output').slice(-400)}` };
  } catch (error) {
    return { ok: false, unavailable: true, detail: `${tool} smoke unavailable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

export interface ToolInstallDeps extends SmokeDeps {
  typeLine?: (ptyRef: string, line: string) => void | Promise<void>;
  waitIdle?: (ptyRef: string, opts: { timeoutMs: number; completionMarker?: string }) => string | Promise<string>;
  /** Override only the decision side effect; default publishes to the live decision stream. */
  decision?: (event: DecisionEvent) => void;
  /** Override only the observation side effect. */
  log?: (event: 'checked' | 'typed' | 'installed' | 'escalated' | 'failed', data: Record<string, unknown>) => void;
}

export type ToolInstallResult = {
  outcome: 'already' | 'installed' | 'escalate' | 'failed';
  line?: string;
  reason: string;
  needsLogin?: boolean;
};

const cliPath = resolve(import.meta.dir, '../../bin/elanous.mjs');
function runPtyCli(args: string[]): string {
  const scope = process.env.NODE_ENV === 'test' || process.env.ELANOUS_HARNESS_SPACE_ID ? ['--test'] : [];
  const result = spawnSync(process.execPath, [cliPath, ...scope, ...args], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error((result.stderr ?? '').trim() || `pty ${args[0]} exited ${result.status}`);
  return result.stdout ?? '';
}

function defaultTypeLine(ptyRef: string, line: string): void {
  runPtyCli(['pty', 'text', ptyRef, line, '--enter', '--actor', 'agent']);
}

export async function waitForPtyCompletion(
  ptyRef: string,
  opts: { timeoutMs: number; completionMarker?: string },
  snapshot: (ref: string) => string | Promise<string>,
): Promise<string> {
  if (!opts.completionMarker) throw new Error('PTY completion marker required');
  const deadline = Date.now() + opts.timeoutMs;
  const completed = new RegExp(`(?:^|\\n)${opts.completionMarker}[0-9]+(?:\\r?\\n|$)`);
  let last = '';
  while (Date.now() < deadline) {
    last = await snapshot(ptyRef);
    if (completed.test(last.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))) return last;
    await new Promise<void>((done) => setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`PTY completion timeout: ${screenTail(last)}`);
}

function defaultWaitIdle(ptyRef: string, opts: { timeoutMs: number; completionMarker?: string }): Promise<string> {
  return waitForPtyCompletion(ptyRef, opts, (ref) => runPtyCli(['pty', 'snapshot', ref]).replace(/^PtyShellSnapshot[^\n]*\n/, ''));
}

function screenTail(snapshot: string): string {
  return snapshot.trim().split(/\r?\n/).slice(-5).join(' | ').slice(-400) || 'empty PTY snapshot';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function probeInPty(ptyRef: string, invocation: string, deps: Pick<ToolInstallDeps, 'typeLine' | 'waitIdle'> = {}): Promise<PtyProbe> {
  const marker = `ELANOUS_SMOKE_${randomUUID().replace(/-/g, '')}`;
  const line = `smoke_output=$(${invocation} 2>&1); smoke_rc=$?; printf '%s\\n' ${shellQuote(`${marker}_START`)}; printf '%s\\n' "$smoke_output" | tail -c 400; printf '\\n%s%s\\n' ${shellQuote(`${marker}_END_`)} "$smoke_rc"`;
  try {
    await (deps.typeLine ?? defaultTypeLine)(ptyRef, line);
    const snapshot = (await (deps.waitIdle ?? defaultWaitIdle)(ptyRef, { timeoutMs: 20_000, completionMarker: `${marker}_END_` })).replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const startToken = `${marker}_START\n`;
    const startAt = snapshot.indexOf(`\n${startToken}`);
    const start = startAt < 0 ? (snapshot.startsWith(startToken) ? 0 : -1) : startAt + 1;
    const endToken = `\n${marker}_END_`;
    const end = start < 0 ? -1 : snapshot.indexOf(endToken, start + startToken.length);
    const status = end < 0 ? undefined : /^([0-9]+)(?:\n|$)/.exec(snapshot.slice(end + endToken.length))?.[1];
    if (status === undefined) return { status: 'unavailable', detail: `PTY probe missing exit marker: ${screenTail(snapshot)}` };
    return { status: 'ok', exitCode: Number(status), output: snapshot.slice(start + startToken.length, end).trim() };
  } catch (error) {
    return { status: 'unavailable', detail: `PTY probe unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Execute an install line in the existing PTY and read its completion marker, not the shell prompt. */
export async function executeInstallInPty(
  ptyRef: string, line: string, deps: Pick<ToolInstallDeps, 'typeLine' | 'waitIdle'> = {},
  onTyped?: () => void,
): Promise<{ exitCode: number; snapshot: string }> {
  const marker = `ELANOUS_INSTALL_${randomUUID().replace(/-/g, '')}_END_`;
  await (deps.typeLine ?? defaultTypeLine)(ptyRef, `${line}; install_rc=$?; printf '\\n%s%s\\n' ${shellQuote(marker)} "$install_rc"`);
  onTyped?.();
  const snapshot = await (deps.waitIdle ?? defaultWaitIdle)(ptyRef, { timeoutMs: 300_000, completionMarker: marker });
  const exitCode = new RegExp(`(?:^|\\n)${marker}([0-9]+)(?:\\r?\\n|$)`).exec(snapshot.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))?.[1];
  if (exitCode === undefined) throw new Error(`PTY install missing exit marker: ${screenTail(snapshot)}`);
  return { exitCode: Number(exitCode), snapshot };
}

/** Both probes run in the installation shell: the agent process may have a different PATH. */
// git is checked on the host only (doctor --fix); installMissingTool never takes it.
async function smokeInPty(tool: RemedyTool, ptyRef: string, deps: ToolInstallDeps): Promise<{ ok: boolean; detail: string; unavailable?: boolean }> {
  const check = SMOKE_CHECKS[tool];
  const command = check.cmd.map(shellQuote).join(' ');
  const invocation = check.stdin === undefined ? command : `printf %s ${shellQuote(check.stdin)} | ${command}`;
  const result = await probeInPty(ptyRef, invocation, deps);
  if (result.status === 'unavailable') return { ok: false, unavailable: true, detail: `${tool} ${result.detail}` };
  const ok = result.exitCode === 0 && check.expect.test(result.output);
  return { ok, detail: ok ? `${tool} smoke passed` : `${tool} smoke failed (exit ${result.exitCode}): ${result.output.slice(-400) || 'no output'}` };
}

/** A known, unprivileged prescription is typed in the existing shell; sudo and unknown remedies remain human decisions. */
export async function installMissingTool(
  { tool, family: suppliedFamily, ptyRef }: { tool: RemedyTool; family?: DistroFamily; ptyRef: string },
  deps: ToolInstallDeps = {},
): Promise<ToolInstallResult> {
  let family: DistroFamily = suppliedFamily ?? 'unknown';
  const log = (event: 'checked' | 'typed' | 'installed' | 'escalated' | 'failed', outcome: ToolInstallResult['outcome'] | 'missing' | 'pending', reason: string) =>
    (deps.log ?? ((name, data) => debug.log('agent-mission.install', name, data)))(event, { tool, family, outcome, reason });
  const decide = deps.decision ?? emitDecision;
  const probe = () => deps.exec ? Promise.resolve(smokeCheck(tool, deps)) : smokeInPty(tool, ptyRef, deps);
  const codexLogin = async (outcome: 'already' | 'installed', reason: string, line?: string): Promise<ToolInstallResult> => {
    if (tool !== 'codex') return { outcome, reason, ...(line ? { line } : {}) };
    let auth: PtyProbe;
    if (deps.exec) {
      try {
        const result = deps.exec(['codex', 'login', 'status'], { timeoutMs: 20_000 });
        auth = result.status === null
          ? { status: 'unavailable', detail: result.stderr ?? 'codex login status unavailable' }
          : { status: 'ok', exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
      } catch (error) {
        auth = { status: 'unavailable', detail: String(error) };
      }
    } else auth = await probeInPty(ptyRef, "'codex' 'login' 'status'", deps);
    if (auth.status === 'ok' && auth.exitCode === 0 && /logged in/i.test(auth.output) && !/not logged in/i.test(auth.output)) {
      return { outcome, reason, ...(line ? { line } : {}) };
    }
    const loginReason = `codex authentication not verified; run codex login before authenticated work${auth.status === 'unavailable' ? ` (${auth.detail})` : ''}`;
    decide({ kind: 'ESCALATE', what: 'codex 로그인 필요', reason: loginReason, purpose: '인증 상태를 사람이 확인한다', target: 'human' });
    log('escalated', 'escalate', loginReason);
    return { outcome: 'escalate', reason: loginReason, ...(line ? { line } : {}), needsLogin: true };
  };
  const checked = await probe();
  log('checked', checked.ok ? 'already' : checked.unavailable ? 'failed' : 'missing', checked.detail);
  if (checked.unavailable) {
    log('failed', 'failed', checked.detail);
    return { outcome: 'failed', reason: checked.detail };
  }
  if (checked.ok) {
    decide({ kind: 'VERIFY', what: `${tool} 설치 확인`, reason: checked.detail, purpose: '이미 동작하므로 설치를 생략한다', target: 'shell' });
    return codexLogin('already', checked.detail);
  }
  if (suppliedFamily === undefined) {
    // No `case … )` here: the probe runs inside `$( … )`, and bash 3.2 (macOS /bin/sh) reads that `)` as the end of it.
    const distro = await probeInPty(ptyRef, `uname -s; if [ -r /etc/os-release ]; then grep -E '^(ID|ID_LIKE|VERSION_ID)=' /etc/os-release; fi; true`, deps);
    if (distro.status === 'unavailable') {
      log('failed', 'failed', distro.detail);
      return { outcome: 'failed', reason: distro.detail };
    }
    if (distro.exitCode === 0) {
      const [platform, ...release] = distro.output.split('\n');
      family = detectDistroFamily(platform === 'Darwin' ? 'darwin' : platform === 'Linux' ? 'linux' : undefined, release.join('\n'));
    }
  }
  const line = toolInstallLine(tool, family);
  if (!line || /\bsudo\b/.test(line)) {
    const reason = line ? 'sudo-is-human' : 'no-remedy';
    decide({ kind: 'ESCALATE', what: `${tool} 설치는 사람이 필요`, reason: line ?? reason, purpose: '사람의 설치 판단을 받는다', target: 'human' });
    log('escalated', 'escalate', reason);
    return { outcome: 'escalate', ...(line ? { line } : {}), reason, ...(tool === 'codex' ? { needsLogin: true } : {}) };
  }
  decide({ kind: 'ROUTE', what: `${tool} 없음 → 설치`, reason: line, purpose: '가장 낮은 칸으로 끝낸다', target: 'shell' });
  let snapshot = '';
  try {
    const result = await executeInstallInPty(ptyRef, line, deps, () => log('typed', 'pending', line));
    snapshot = result.snapshot;
    const exitCode = String(result.exitCode);
    const verified = await probe();
    decide({ kind: 'VERIFY', what: `${tool} 설치 확인`, reason: verified.detail, purpose: '가장 작은 진짜 일을 확인한다', target: 'shell' });
    if (verified.unavailable) {
      log('failed', 'failed', verified.detail);
      return { outcome: 'failed', line, reason: verified.detail };
    }
    if (exitCode !== '0') {
      const reason = `install exited ${exitCode}: ${screenTail(snapshot)}`;
      log('failed', 'failed', reason);
      return { outcome: 'failed', line, reason, ...(tool === 'codex' ? { needsLogin: true } : {}) };
    }
    if (verified.ok) {
      log('installed', 'installed', verified.detail);
      return codexLogin('installed', verified.detail, line);
    }
    const reason = screenTail(snapshot);
    log('failed', 'failed', `${verified.detail} · ${reason}`);
    return { outcome: 'failed', line, reason, ...(tool === 'codex' ? { needsLogin: true } : {}) };
  } catch (error) {
    const reason = `${error instanceof Error ? error.message : String(error)}${snapshot ? ` · ${screenTail(snapshot)}` : ''}`;
    log('failed', 'failed', reason);
    return { outcome: 'failed', line, reason, ...(tool === 'codex' ? { needsLogin: true } : {}) };
  }
}
