// Classic dashboard `/term` adapter. Branch-sized command bodies live in `./term/handlers.ts`.
// The display owner injects modal routing through a structural host contract.

import { renderHandleStatusChip, type HandleStatus } from '../../status/chip.js';
import { getShellRegistry } from '../../shell-runner/registry.js';
import { termSize } from '../../tui.js';
import { loadPersistedSessions } from '../../terminal/session-persistence.js';
import type { TermSlashContext, TermSlashLocals, TermSubHandler } from './term/contracts.js';
import { termChannel, termGroup, termMatrix, termMove, termPipe, termPipes, termReadonly, termRecharacter, termSnapshot, termUnpipe, termVwBar, termVwSync } from './term/handlers.js';
export type { TermSlashContext, TermSlashHost } from './term/contracts.js';


async function termHelp(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime } = locals;
  const lines = (args[1] ?? '').toLowerCase() === 'experimental'
    ? slashRuntime.experimentalHelpLines()
    : slashRuntime.helpLines();
  for (const line of lines) ctx.chatLines.push(line);
  ctx.setChatScrollOffset(-1);
  return;
}

async function termNew(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  ctx.termSlash.openNewTerminal(args.slice(1).join(' ').trim() || undefined);
  return;
}

async function termList(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, sessionRegistry } = locals;
  const alive = sessionRegistry.list();
  if (alive.length === 0) {
    ctx.chatLines.push(slashRuntime.terminalSessionsEmptyLine());
  } else {
    for (const s of alive) {
      const chip = renderHandleStatusChip(s.state);
      ctx.chatLines.push(slashRuntime.terminalSessionLine({
        idSuffix: s.id.slice(-8),
        title: s.title,
        chip,
        agentBrand: s.agentBrand ?? null,
        attentionLevel: s.attentionLevel,
        attentionLabel: s.attentionLevel > 0 ? ctx.warning(` attn:${s.attentionLevel}`) : '',
      }));
    }
  }
  // SP-F · mirror shell-runner handles in the same list so users
  // don't have to remember that there are two distinct registries.
  try {
    const shellReg = getShellRegistry();
    const handles = shellReg.list();
    if (handles.length > 0) {
      ctx.chatLines.push(slashRuntime.shellRunnerSectionDividerLine());
      for (const h of handles) {
        const chip = renderHandleStatusChip(h.status);
        ctx.chatLines.push(slashRuntime.shellHandleLine({
          idSuffix: h.id.slice(-8),
          chip,
          mode: h.mode,
          label: shellReg.getVwLabel(h.id),
        }));
      }
      ctx.chatLines.push(slashRuntime.shellRunnerFooterLine());
    }
  } catch { /* shell-runner not booted */ }
  ctx.setChatScrollOffset(-1);
  return;
}

async function termDetach(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, sessionRegistry } = locals;
  const fg = sessionRegistry.foreground();
  if (!fg) {
    ctx.chatLines.push(slashRuntime.detachEmptyLine());
  } else {
    sessionRegistry.detach(fg.id);
    ctx.termSlash.modalRouter.set(null);
    ctx.chatLines.push(slashRuntime.detachedLine(fg.title));
    ctx.draw();
  }
  ctx.setChatScrollOffset(-1);
  return;
}

async function termAttach(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, sessionRegistry } = locals;
  const target = (args[1] ?? '').trim();
  if (!target) {
    ctx.chatLines.push(slashRuntime.attachUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const candidates = sessionRegistry.list().filter(s => s.id.endsWith(target) || s.id === target);
  if (candidates.length === 0) {
    ctx.chatLines.push(slashRuntime.attachMissingLine(target));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const match = candidates[0]!;
  const { cols: tc, rows: tr } = termSize();
  const session = sessionRegistry.attach(match.id, { termCols: tc, termRows: tr });
  if (session?.modal) ctx.termSlash.openSession(session);
  return;
}

async function termSwitch(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  ctx.termSlash.openSessionPicker();
  return;
}

async function termKill(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, sessionRegistry } = locals;
  const target = (args[1] ?? '').trim();
  const fg = sessionRegistry.foreground();
  const victim = target
    ? sessionRegistry.list().find(s => s.id.endsWith(target) || s.id === target)
    : fg;
  if (!victim) {
    ctx.chatLines.push(slashRuntime.killEmptyLine());
  } else {
    sessionRegistry.kill(victim.id);
    if (ctx.termSlash.modalRouter.current()?.id === victim.id) ctx.termSlash.modalRouter.set(null);
    ctx.chatLines.push(slashRuntime.killedLine(victim.title));
    ctx.draw();
  }
  ctx.setChatScrollOffset(-1);
  return;
}

// /term spawn was removed (NT-C3) and /term snapshot is wired
// separately via dispatchTerminalModalObserve below.
async function termResume(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, sessionRegistry } = locals;
  // P16 — list persisted sessions from prior runs and re-spawn on
  // selection. Metadata-only: we can't revive the original PTY
  // buffer, but the command is stored so "my claude-code from
  // yesterday" can come back in one slash.
  const persisted = loadPersistedSessions();
  if (persisted.length === 0) {
    ctx.chatLines.push(slashRuntime.noPersistedSessionsLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const target = (args[1] ?? '').trim();
  if (!target) {
    for (const line of slashRuntime.resumeHelpLines(
      persisted.map((entry) => ({
        id: entry.id,
        title: entry.title,
        command: entry.command,
        kind: entry.kind,
      })),
    )) ctx.chatLines.push(line);
    ctx.setChatScrollOffset(-1);
    return;
  }
  const match = persisted.find(p => p.id.endsWith(target) || p.id === target);
  if (!match) {
    ctx.chatLines.push(slashRuntime.persistedSessionMissingLine(target));
    ctx.setChatScrollOffset(-1);
    return;
  }
  try {
    const { cols: tc, rows: tr } = termSize();
    const session = sessionRegistry.spawn(
      {
        title: match.title,
        cwd: match.cwd,
        command: match.command,
        termName: match.termName ?? 'xterm-ghostty',
        kind: match.kind,
        agentBrand: match.agentBrand,
      },
      { termCols: tc, termRows: tr },
    );
    ctx.termSlash.openSession(session);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.chatLines.push(ctx.error(`  Resume failed: ${msg}`));
    ctx.setChatScrollOffset(-1);
  }
  return;
}

/** 하위 명령 → 처리 함수. 옛 if 사슬과 같은 순서(이름이 겹치지 않아 순서는 결과를 바꾸지 않는다). */
const TERM_SUBCOMMANDS: ReadonlyArray<readonly [readonly string[], TermSubHandler]> = [
  [['', 'help'], termHelp],
  [['new'], termNew],
  [['list'], termList],
  [['detach'], termDetach],
  [['attach'], termAttach],
  [['switch'], termSwitch],
  [['kill'], termKill],
  [['snapshot'], termSnapshot],
  [['move'], termMove],
  [['group'], termGroup],
  [['channel'], termChannel],
  [['pipe'], termPipe],
  [['unpipe'], termUnpipe],
  [['pipes'], termPipes],
  [['readonly'], termReadonly],
  [['vw-bar', 'vwbar'], termVwBar],
  [['vw-sync', 'vwsync'], termVwSync],
  [['recharacter'], termRecharacter],
  [['matrix'], termMatrix],
  [['resume'], termResume],
];

/** `/term`·`/terminal` 본체 — 옛 registry.register(['term', 'terminal'], …) 핸들러 그대로. */
interface TermSlashRegistry<C, R> {
  register(
    names: string | string[],
    handler: (args: string[], ctx: C) => void | { return: R } | Promise<void | { return: R }>,
  ): unknown;
}

export async function handleTermSlash(args: string[], ctx: TermSlashContext): Promise<void> {
  // The biggest /term — 23 subcommands across 6 host-local subsystems
  // (sessionRegistry · terminalMatrix · vwRegistry · broadcastBus ·
  // channelBus + session-picker modal lifecycle). Static-imported in
  // this module: getShellRegistry · renderHandleStatusChip ·
  // resolveTerminalMoveDestination · loadPersistedSessions ·
  // dispatchTerminalModalObserve. Behavior preserved verbatim from
  // the inline case.
  const sub = (args[0] ?? '').toLowerCase();
  const destination = (args[2] ?? '').trim().toLowerCase();
  if (sub === 'vw-bar' || sub === 'vwbar' || sub === 'vw-sync' || sub === 'vwsync'
      || (sub === 'move' && (destination === 'vw' || destination === 'window'))) {
    const command = sub === 'move' ? 'move <id> vw' : sub === 'vwbar' ? 'vw-bar' : sub === 'vwsync' ? 'vw-sync' : sub;
    ctx.chatLines.push(ctx.warning(`  /term ${command} is retired; it no longer changes terminal state.`));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const slashRuntime = ctx.termSlash.slashRuntime;
  const sessionRegistry = ctx.termSlash.sessionRegistry;
  const terminalMatrix = ctx.termSlash.terminalMatrix;
  const vwRegistry = ctx.termSlash.vwRegistry;
  const broadcastBus = ctx.termSlash.broadcastBus;
  const channelBus = ctx.termSlash.channelBus;
  const locals: TermSlashLocals = { slashRuntime, sessionRegistry, terminalMatrix, vwRegistry, broadcastBus, channelBus };

  for (const [names, handler] of TERM_SUBCOMMANDS) {
    if (names.includes(sub)) {
      await handler(sub, args, ctx, locals);
      return;
    }
  }

  ctx.chatLines.push(slashRuntime.unknownSubcommandLine(sub));
  ctx.setChatScrollOffset(-1);
}

/** buildDashboardSlashRegistry 가 옛 자리(같은 순서)에서 한 번 부른다. */
export function registerTermSlash<C extends TermSlashContext, R>(registry: TermSlashRegistry<C, R>): void {
  registry.register(['term', 'terminal'], async (args, ctx) => {
    await handleTermSlash(args, ctx);
  });
}
