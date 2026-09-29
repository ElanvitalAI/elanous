import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlDecision } from '../autopilot/pty-control-loop.js';
import { emitDecision } from '../live/detail-switch.js';

type MissionHandoff = Extract<ControlDecision, { action: 'handoff' }>;
type MissionAskHuman = Extract<ControlDecision, { action: 'ask-human' }>;

export interface HandoffOperations {
  start: (to: 'codex' | 'claude', mission: string, worktree: string) => Promise<void>;
  gateAndPr: (worktree: string) => Promise<void>;
  claudeLoggedIn: () => boolean;
  notify: (card: { text: string; url?: string; code?: string }) => Promise<void> | void;
  screen: () => Promise<string>;
  alive: () => boolean;
  sleep: (ms: number) => Promise<void>;
  diff?: (worktree: string) => string;
  /** Launch the official Claude login CLI in a PTY before asking a human to authenticate. */
  login?: (worktree: string) => Promise<{ screen: () => Promise<string>; alive: () => boolean; close: () => void }>;
}

export const MAX_HANDOFF_DIFF_BYTES = 256 * 1024 * 1024;

export function missionDiff(worktree: string): string {
  // Large patches are normal for big missions; the default 1 MiB buffer would abort the handoff before review.
  const tracked = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: worktree, encoding: 'utf8', maxBuffer: MAX_HANDOFF_DIFF_BYTES });
  const names = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree }).toString('utf8').split('\0').filter(Boolean);
  const patches = names.filter((name) => !name.startsWith('.mission-') && lstatSync(join(worktree, name)).isFile()).map((name) => {
    const result = spawnSync('git', ['diff', '--no-index', '--binary', '--', '/dev/null', name], { cwd: worktree, encoding: 'utf8', maxBuffer: MAX_HANDOFF_DIFF_BYTES });
    if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error(`cannot diff untracked file ${name}: ${result.stderr || result.error?.message || result.status}`);
    if (result.stdout) return result.stdout;
    // Git emits no patch at all for an empty new file; its mode and empty-blob id are sufficient to restore it.
    const quote = (path: string): string => /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
    return `diff --git ${quote(`a/${name}`)} ${quote(`b/${name}`)}\nnew file mode 100644\nindex 0000000..e69de29\n`;
  });
  return [tracked, ...patches].join('');
}

/** Only a visible login URL/device code leaves the screen; never inspect credential stores. */
export function loginCard(_decision: MissionAskHuman, screen: string): { text: string; url?: string; code?: string } {
  const visibleUrl = screen.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  // Keep visible HTTPS login links, but never forward credential-bearing callback parameters or fragments.
  let url: string | undefined;
  if (visibleUrl) {
    try {
      const parsed = new URL(visibleUrl);
      const sensitive = /(?:^|[_-])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|secret|credential|password|ticket|session|auth[_-]?code|code)(?:$|[_-])/i;
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password
        && [...parsed.searchParams.keys()].every((key) => !sensitive.test(key))
        && (!parsed.hash || /^#[\w/-]+$/.test(parsed.hash))) url = visibleUrl;
    } catch { /* not a URL */ }
  }
  const code = screen.match(/(?:device\s*code|enter\s*code)\s*[:：]\s*([A-Z0-9-]{4,})/i)?.[1];
  return { text: '로그인해 주세요', ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

export function isLoginScreen(screen: string): boolean {
  return /login|log in|sign in|authenticate|device code|인증|로그인/i.test(screen);
}

export async function waitForHumanLogin(decision: MissionAskHuman, ops: HandoffOperations): Promise<void> {
  const first = await ops.screen();
  if (!isLoginScreen(first)) throw new Error('ask-human requested without a visible login screen');
  const card = loginCard(decision, first);
  if ((decision.url && card.url !== decision.url) || (decision.code && card.code !== decision.code)) {
    throw new Error('ask-human URL or device code is not verified on the login screen');
  }
  emitDecision({ kind: 'ESCALATE', what: '로그인 필요 → 사람', reason: 'login screen requires human authentication', purpose: 'mission login', target: 'human', phase: 'implement' });
  await ops.notify(card);
  while (ops.alive()) {
    await ops.sleep(1000);
    if (!isLoginScreen(await ops.screen())) return;
  }
  throw new Error('login PTY exited before authentication completed');
}

/** Coordinator shared by brain decisions and the explicit CLI chain. No new worktree is created. */
export async function handoffMission(
  decision: MissionHandoff,
  worktree: string,
  ops: HandoffOperations,
  summary = '',
): Promise<'started' | 'gated'> {
  if (decision.to === 'elanous') {
    emitDecision({ kind: 'ROUTE', what: 'handoff → elanous', reason: 'mission evidence gate and PR', purpose: 'mission gate', target: 'elanous', phase: 'gate' });
    const carryFile = join(worktree, '.mission-handoff.diff');
    if (existsSync(carryFile)) unlinkSync(carryFile);
    await ops.gateAndPr(worktree);
    return 'gated';
  }
  if (decision.to === 'claude' && !ops.claudeLoggedIn()) {
    if (!ops.login) throw new Error('Claude login PTY unavailable');
    const login = await ops.login(worktree);
    try {
      let screen = await login.screen();
      while (login.alive() && !ops.claudeLoggedIn() && !isLoginScreen(screen)) {
        await ops.sleep(1000);
        screen = await login.screen();
      }
      if (!ops.claudeLoggedIn()) {
        if (!login.alive()) throw new Error('Claude login PTY exited before authentication completed');
        const card = loginCard({ action: 'ask-human', reason: 'Claude subscription login required' }, screen);
        if (!card.url && !card.code) throw new Error('Claude login PTY did not show a safe URL or device code');
        emitDecision({ kind: 'ESCALATE', what: '로그인 필요 → 사람', reason: 'Claude subscription login required', purpose: 'mission login', target: 'human', phase: 'implement' });
        await ops.notify(card);
        while (login.alive() && (!ops.claudeLoggedIn() || isLoginScreen(await login.screen()))) await ops.sleep(1000);
      }
      if (!ops.claudeLoggedIn()) throw new Error('Claude subscription still unavailable after login');
    } finally { login.close(); }
  }
  const carryFile = join(worktree, '.mission-handoff.diff');
  // lstat, not exists: a dangling or planted symlink must be removed, never followed.
  const carryPresent = (() => { try { lstatSync(carryFile); return true; } catch { return false; } })();
  if (carryPresent) unlinkSync(carryFile);
  let note = decision.mission;
  if (decision.carry === 'diff') {
    const diff = (ops.diff ?? missionDiff)(worktree);
    // Exclusive create: if something reappears at this path, fail instead of writing through it.
    writeFileSync(carryFile, diff, { mode: 0o600, flag: 'wx' });
    note += '\nRead .mission-handoff.diff and review the changes before responding.';
  } else if (decision.carry === 'summary') {
    note += `\nPrevious controller summary: ${summary || 'No summary available.'}`;
  }
  emitDecision({ kind: 'ROUTE', what: `handoff → ${decision.to}`, reason: decision.to === 'claude' ? '리뷰 = claude · 왜: 다른 눈' : 'continue mission with review findings', purpose: 'mission continuation', target: decision.to, phase: 'implement' });
  await ops.start(decision.to, note, worktree);
  return 'started';
}
