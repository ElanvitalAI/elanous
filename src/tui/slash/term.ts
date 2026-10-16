// TUI-SLASH-SPLIT-TERM (D4b 2/2 · RFC-tui-essential-diet-and-legacy-removal A5/D4b)
// `/term`·`/terminal` 슬래시 — src/dashboard/slash-runtime/dashboard-handlers.ts 의
// buildDashboardSlashRegistry 안 한 구역을 «순수 이동»한 것이다(동작 변화 0).
// 하위 명령마다 함수 하나(각 ≤300줄). 등록은 옛 자리에서 registerTermSlash(registry) 한 줄로,
// 같은 별칭(['term', 'terminal'])·같은 순서로 한 번만 일어난다. 줄 문면은 늘 그랬듯
// src/dashboard/term-slash-runtime.ts(ctx.termSlash.slashRuntime)가 쥔다.
//
// ⛔ 순환 import 금지: 이 파일은 dashboard-handlers.ts 를 import 하지 않는다(타입도).
//    호스트 묶음 타입 TermSlashHost 는 여기서 정의하고 DashboardSlashContext.termSlash 가 이걸 쓴다.

import { renderHandleStatusChip, type HandleStatus } from '../../status/chip.js';
import { getShellRegistry } from '../../shell-runner/registry.js';
import { terminalModalRouter } from '../../dashboard/input/terminal-modal-router.js';
import { termSize } from '../../tui.js';
import type { DashboardTermSlashRuntime } from '../../dashboard/term-slash-runtime.js';
import { resolveTerminalMoveDestination } from '../../terminal-matrix/mobility.js';
import { loadPersistedSessions } from '../../terminal/session-persistence.js';
import { dispatchTerminalModalObserve } from '../../skills/tools/terminal-modal.js';
import type { SlashCommandRegistry } from '../../dashboard/slash-runtime/registry.js';

/** `/term` 호스트 묶음(옛 DashboardSlashContext.termSlash 의 인라인 타입 · 그대로 옮김). */
export interface TermSlashHost {
  /** Line formatters (existing factory output type re-used). */
  slashRuntime: DashboardTermSlashRuntime;
  openNewTerminal(command?: string): void;

  /** Terminal session registry (the modal-pty side). */
  sessionRegistry: {
    list(): readonly {
      id: string;
      title: string;
      state: HandleStatus;
      cwd: string;
      exitCode: number | null;
      agentBrand?: string | null;
      attentionLevel: number;
      modal?: unknown;
    }[];
    foreground(): { id: string; title: string } | null;
    detach(id: string): void;
    attach(id: string, opts: { termCols: number; termRows: number }):
      { id: string; title: string; modal?: unknown } | null;
    kill(id: string): void;
    get(id: string): { id: string; title: string; modal?: unknown } | null;
    spawn(
      spec: {
        title: string;
        cwd: string;
        command?: string | undefined;
        termName: string;
        kind: string;
        agentBrand?: string | undefined;
      },
      opts: { termCols: number; termRows: number },
    ): { id: string; title: string; modal?: unknown };
  };

  /** Terminal matrix — the multi-terminal coordination layer. */
  terminalMatrix: {
    get(needle: string): {
      id: string;
      legacySessionId?: string | null;
      title: string;
      readOnly: boolean;
      exitCode: number | null;
      broadcastGroups: Set<string>;
      character: { kind: string };
      transport: { kind: string };
      placement: { kind: string; windowId?: string | number; slotId?: string };
      pty: { write(data: string): void };
    } | null;
    list(opts?: { includeExited?: boolean }): readonly {
      id: string;
      legacySessionId?: string | null;
      title: string;
      readOnly: boolean;
      exitCode: number | null;
      broadcastGroups: Set<string>;
      character: { kind: string };
      transport: { kind: string };
      placement: { kind: string; windowId?: string | number; slotId?: string };
      pty: { write(data: string): void };
    }[];
    move(id: string, dest: ReturnType<typeof resolveTerminalMoveDestination>): void;
    joinGroup(id: string, group: string): void;
    leaveGroup(id: string, group: string): void;
    setReadOnly(id: string, value: boolean): void;
    recharacterAndReexec(
      id: string,
      character: { kind: 'shell' | 'claude-code' | 'codex' | 'custom'; name?: string },
    ): { reexeced: boolean };
    pipeToChannel(id: string, channel: string, opts: { lineMode: boolean }): { id: number };
    listPipes(): readonly {
      id: number;
      terminalId: string;
      channel: string;
      lineMode: boolean;
      unsubscribe(): void;
    }[];
  };

  /** Virtual-windows registry · subset used by /term vw-bar / move. */
  vwRegistry: {
    current(): { id: number; isSyncInputBarActive(): boolean; setSyncInputBar(v: boolean): void } | null;
    get(id: number): { id: number; isSyncInputBarActive(): boolean; setSyncInputBar(v: boolean): void } | null;
  };

  /** Broadcast bus — used by /term group + /term vw-sync. */
  broadcastBus: {
    groups(): readonly string[];
    members(group: string): readonly { id: string; title: string; readOnly: boolean }[];
    broadcastBytes(group: string, text: string): {
      delivered: readonly unknown[];
      skippedExited: readonly unknown[];
      skippedReadOnly: readonly unknown[];
      errored: readonly unknown[];
    };
  };

  /** Channel bus — used by /term channel + /term pipe + /term unpipe. */
  channelBus: {
    channels(): readonly string[];
    statsFor(channel: string): {
      subscriberCount: number;
      publishedCount: number;
      lastPublishAt: number | null;
    };
    publish(channel: string, msg: { from: string; payload: string | Buffer }): number;
    snapshot(channel: string, limit: number): readonly { from: string; payload: string | Buffer }[];
    subscribe(
      channel: string,
      cb: (msg: { from: string; payload: string | Buffer }) => void,
      opts: { label: string; replay: boolean },
    ): { id: number };
  };

  /** Open the /term switch session-picker modal · wraps createSessionPickerModal +
   *  attachSurfaceToWorkspace + display.pushModal + agentSearchModal/Handle
   *  mutation. The handler's only responsibility is calling this once. */
  openSessionPicker(): void;

  /** Wraps the inline `openSession` closure (terminalModalRouter.set +
   *  detach-on-close + draw). Called after a successful session attach
   *  / spawn / resume. */
  openSession(session: { id: string; title: string; modal?: unknown }): void;

  /** Set working focus to 'preview' (for /term move <id> preview). */
  setWorkingFocusPreview(): void;

  /** Compute next vw-slot id for a terminal · used by resolveTerminalMoveDestination. */
  nextTerminalVwSlotId(terminalId: string): string;
}

/** `/term` 이 ctx 에서 쓰는 것만(DashboardSlashContext 의 부분집합 · 구조 타입). */
export interface TermSlashContext {
  chatLines: string[];
  setChatScrollOffset(value: number): void;
  accent(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  draw(): void;
  termSlash: TermSlashHost;
}

/** 핸들러 머리에서 ctx.termSlash 를 한 번 읽어 둔 것(옛 핸들러의 지역 상수 여섯 그대로). */
interface TermSlashLocals {
  slashRuntime: TermSlashHost['slashRuntime'];
  sessionRegistry: TermSlashHost['sessionRegistry'];
  terminalMatrix: TermSlashHost['terminalMatrix'];
  vwRegistry: TermSlashHost['vwRegistry'];
  broadcastBus: TermSlashHost['broadcastBus'];
  channelBus: TermSlashHost['channelBus'];
}

type TermSubHandler = (sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals) => Promise<void>;

async function termHelp(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime } = locals;
  for (const line of slashRuntime.helpLines()) ctx.chatLines.push(line);
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
    terminalModalRouter.set(null);
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
    if (terminalModalRouter.current()?.id === victim.id) terminalModalRouter.set(null);
    ctx.chatLines.push(slashRuntime.killedLine(victim.title));
    ctx.draw();
  }
  ctx.setChatScrollOffset(-1);
  return;
}

// /term spawn was removed (NT-C3) and /term snapshot is wired
// separately via dispatchTerminalModalObserve below.
async function termSnapshot(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, sessionRegistry } = locals;
  // Wires to dispatchTerminalModalObserve (the same capture path
  // used by the LLM-side TerminalModalObserve tool).
  // Usage: /term snapshot <id> [tail [bytes]]
  const target = (args[1] ?? '').trim();
  if (!target) {
    ctx.chatLines.push(slashRuntime.snapshotUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const list = sessionRegistry.list();
  const match = list.find(s => s.id === target) ?? list.find(s => s.id.endsWith(target));
  if (!match) {
    ctx.chatLines.push(slashRuntime.snapshotUnknownIdLine(target));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const tailMode = (args[2] ?? '').toLowerCase() === 'tail';
  const maxBytes = tailMode && args[3]
    ? Math.max(256, Math.min(64_000, Number(args[3]) || 8_000))
    : 8_000;
  try {
    // dispatchTerminalModalObserve's typed signature expects
    // TerminalSessionRegistry · we cast the structural ctx shape
    // since the registry surface is identical (the dispatcher
    // only calls .get() + reads .preview/.id/.state/.title).
    const r = await dispatchTerminalModalObserve(
      {
        id: match.id,
        mode: tailMode ? 'tail' : 'snapshot',
        ...(tailMode ? { max_bytes: maxBytes } : {}),
      },
      { registry: sessionRegistry as unknown as Parameters<typeof dispatchTerminalModalObserve>[1] extends { registry?: infer R } | undefined ? R : never },
    );
    ctx.chatLines.push(slashRuntime.snapshotHeaderLine(
      match.id,
      match.state,
      match.title,
      tailMode ? 'tail' : 'snapshot',
    ));
    for (const line of r.output.split('\n')) ctx.chatLines.push('  ' + line);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.chatLines.push(ctx.error(`  snapshot failed: ${msg}`));
  }
  ctx.setChatScrollOffset(-1);
  return;
}

async function termMove(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, sessionRegistry, terminalMatrix, vwRegistry } = locals;
  const target = (args[1] ?? '').trim();
  const destRaw = (args[2] ?? '').trim().toLowerCase();
  if (!target || !destRaw) {
    ctx.chatLines.push(slashRuntime.moveUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const inst = target.startsWith('term:')
    ? terminalMatrix.get(target)
    : terminalMatrix.list({ includeExited: true })
        .find(i => i.id.endsWith(`:${target}`)
          || i.legacySessionId === target
          || (i.legacySessionId ?? '').endsWith(target));
  if (!inst) {
    ctx.chatLines.push(slashRuntime.moveMissingLine(target));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const currentVw = vwRegistry.current();
  const dest = resolveTerminalMoveDestination(destRaw, {
    currentVwWindowId: currentVw ? String(currentVw.id) : null,
    vwSlotId: ctx.termSlash.nextTerminalVwSlotId(inst.id),
    modalId: inst.id,
  });
  if (!dest) {
    if (destRaw === 'vw' || destRaw === 'window') {
      ctx.chatLines.push(slashRuntime.moveMissingWindowTargetLine());
    } else {
      ctx.chatLines.push(slashRuntime.moveUnknownPlacementLine(destRaw));
    }
    ctx.setChatScrollOffset(-1);
    return;
  }
  try {
    terminalMatrix.move(inst.id, dest);
    // Keep modal router + openSession plumbing in sync with
    // whichever way we moved.
    if ((dest.kind === 'background' || dest.kind === 'preview' || dest.kind === 'vw')
        && terminalModalRouter.current()?.id === inst.legacySessionId) {
      terminalModalRouter.set(null);
    }
    if (dest.kind === 'modal' && inst.legacySessionId) {
      const session = sessionRegistry.get(inst.legacySessionId);
      if (session) ctx.termSlash.openSession(session);
    }
    if (dest.kind === 'preview') {
      ctx.termSlash.setWorkingFocusPreview();
    }
    const destLabel = dest.kind === 'vw'
      ? `vw:${(dest as { kind: 'vw'; windowId: string | number }).windowId}`
      : dest.kind;
    ctx.chatLines.push(slashRuntime.movedLine(inst.id, destLabel));
    ctx.draw();
  } catch (err) {
    ctx.chatLines.push(slashRuntime.moveFailedLine(
      err instanceof Error ? err.message : String(err),
    ));
  }
  ctx.setChatScrollOffset(-1);
  return;
}

async function termGroup(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix, broadcastBus } = locals;
  const op = (args[1] ?? '').toLowerCase();
  const resolveInst = (needle: string) =>
    terminalMatrix.get(needle)
    ?? terminalMatrix.list({ includeExited: true })
      .find(i => i.id.endsWith(`:${needle}`)
        || i.legacySessionId === needle
        || (i.legacySessionId ?? '').endsWith(needle));
  if (!op || op === 'list') {
    const groups = broadcastBus.groups();
    if (groups.length === 0) {
      ctx.chatLines.push(slashRuntime.groupsEmptyLine());
    } else {
      for (const g of groups) {
        const members = broadcastBus.members(g);
        ctx.chatLines.push(slashRuntime.groupHeaderLine(g, members.length));
        for (const m of members) {
          ctx.chatLines.push(slashRuntime.groupMemberLine(m.id, m.title, m.readOnly));
        }
      }
    }
    ctx.setChatScrollOffset(-1);
    return;
  }
  if (op === 'join' || op === 'leave') {
    const targetRaw = (args[2] ?? '').trim();
    const group = (args[3] ?? '').trim();
    if (!targetRaw || !group) {
      ctx.chatLines.push(slashRuntime.groupUsageLine(op));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const inst = resolveInst(targetRaw);
    if (!inst) {
      ctx.chatLines.push(ctx.warning(`  No terminal matched "${targetRaw}".`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (op === 'join') terminalMatrix.joinGroup(inst.id, group);
    else terminalMatrix.leaveGroup(inst.id, group);
    ctx.chatLines.push(slashRuntime.groupResultLine(inst.id, op, group));
    ctx.setChatScrollOffset(-1);
    return;
  }
  if (op === 'send') {
    const group = (args[2] ?? '').trim();
    const text = args.slice(3).join(' ');
    if (!group || !text) {
      ctx.chatLines.push(slashRuntime.groupSendUsageLine());
      ctx.setChatScrollOffset(-1);
      return;
    }
    const r = broadcastBus.broadcastBytes(group, text);
    ctx.chatLines.push(slashRuntime.groupSendResultLine(
      group,
      r.delivered.length,
      r.skippedExited.length + r.skippedReadOnly.length,
      r.errored.length,
    ));
    ctx.setChatScrollOffset(-1);
    return;
  }
  ctx.chatLines.push(slashRuntime.unknownGroupOpLine(op));
  ctx.setChatScrollOffset(-1);
  return;
}

async function termChannel(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix, channelBus } = locals;
  const op = (args[1] ?? '').toLowerCase();
  if (!op || op === 'list') {
    const chans = channelBus.channels();
    if (chans.length === 0) {
      ctx.chatLines.push(slashRuntime.channelEmptyLine());
    } else {
      ctx.chatLines.push(slashRuntime.channelHeaderLine());
      for (const c of chans) {
        const s = channelBus.statsFor(c);
        const last = s.lastPublishAt
          ? new Date(s.lastPublishAt).toISOString().slice(11, 19)
          : '-';
        ctx.chatLines.push(
          slashRuntime.channelListLine(c, s.subscriberCount, s.publishedCount, last),
        );
      }
    }
    ctx.setChatScrollOffset(-1);
    return;
  }
  if (op === 'pub') {
    const channel = (args[2] ?? '').trim();
    const text = args.slice(3).join(' ');
    if (!channel || !text) {
      ctx.chatLines.push(slashRuntime.channelPubUsageLine());
      ctx.setChatScrollOffset(-1);
      return;
    }
    const n = channelBus.publish(channel, { from: 'slash', payload: text });
    ctx.chatLines.push(slashRuntime.channelPubResultLine(channel, n));
    ctx.setChatScrollOffset(-1);
    return;
  }
  if (op === 'snapshot' || op === 'snap') {
    const ch = (args[2] ?? '').trim();
    const limitArg = Number(args[3] ?? 10);
    if (!ch) {
      ctx.chatLines.push(slashRuntime.channelSnapshotUsageLine());
      ctx.setChatScrollOffset(-1);
      return;
    }
    const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 10;
    const snap = channelBus.snapshot(ch, limit);
    if (snap.length === 0) {
      ctx.chatLines.push(slashRuntime.channelSnapshotEmptyLine(ch));
    } else {
      ctx.chatLines.push(slashRuntime.channelSnapshotHeaderLine(ch, snap.length));
      for (const m of snap) {
        const p = typeof m.payload === 'string' ? m.payload : m.payload.toString('utf8');
        const preview = p.length > 80 ? p.slice(0, 77) + '…' : p;
        ctx.chatLines.push(
          slashRuntime.channelSnapshotEntryLine(m.from, preview.replace(/\n/g, '⏎')),
        );
      }
    }
    ctx.setChatScrollOffset(-1);
    return;
  }
  if (op === 'tail') {
    const targetRaw = (args[2] ?? '').trim();
    const channel = (args[3] ?? '').trim();
    if (!targetRaw || !channel) {
      ctx.chatLines.push(slashRuntime.channelTailUsageLine());
      ctx.setChatScrollOffset(-1);
      return;
    }
    const inst = terminalMatrix.get(targetRaw)
      ?? terminalMatrix.list({ includeExited: true })
        .find(i => i.id.endsWith(`:${targetRaw}`));
    if (!inst) {
      ctx.chatLines.push(ctx.warning(`  No terminal matched "${targetRaw}".`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    // Subscribe inst's PTY stdin to the channel. Simple injection:
    // each message's payload is written as-is + newline. Future
    // T5b adds a formatter hook. U3 — pass --replay to also inject
    // backlog messages.
    const replay = args.includes('--replay');
    const subscription = channelBus.subscribe(channel, (msg) => {
      if (inst.exitCode !== null) return;
      const payload = typeof msg.payload === 'string'
        ? msg.payload
        : msg.payload.toString('utf8');
      try { inst.pty.write(payload + (payload.endsWith('\n') ? '' : '\n')); }
      catch { /* ignore — surface issues end the tail */ }
    }, { label: `tail→${inst.id}`, replay });
    ctx.chatLines.push(
      slashRuntime.channelTailResultLine(subscription.id, channel, inst.id, replay),
    );
    ctx.setChatScrollOffset(-1);
    return;
  }
  ctx.chatLines.push(slashRuntime.unknownChannelOpLine(op));
  ctx.setChatScrollOffset(-1);
  return;
}

async function termPipe(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix } = locals;
  const targetRaw = (args[1] ?? '').trim();
  const channel = (args[2] ?? '').trim();
  const lineMode = args.includes('--line');
  if (!targetRaw || !channel) {
    ctx.chatLines.push(slashRuntime.pipeUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const inst = terminalMatrix.get(targetRaw)
    ?? terminalMatrix.list({ includeExited: true })
      .find(i => i.id.endsWith(`:${targetRaw}`));
  if (!inst) {
    ctx.chatLines.push(ctx.warning(`  No terminal matched "${targetRaw}".`));
    ctx.setChatScrollOffset(-1);
    return;
  }
  try {
    const h = terminalMatrix.pipeToChannel(inst.id, channel, { lineMode });
    ctx.chatLines.push(slashRuntime.pipeResultLine(h.id, inst.id, channel, lineMode));
  } catch (err) {
    ctx.chatLines.push(slashRuntime.pipeFailedLine(
      err instanceof Error ? err.message : String(err),
    ));
  }
  ctx.setChatScrollOffset(-1);
  return;
}

async function termUnpipe(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix } = locals;
  const idArg = (args[1] ?? '').trim();
  const pipeNum = Number(idArg);
  if (!Number.isFinite(pipeNum)) {
    ctx.chatLines.push(slashRuntime.unpipeUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const p = terminalMatrix.listPipes().find(x => x.id === pipeNum);
  if (!p) {
    ctx.chatLines.push(slashRuntime.activePipeMissingLine(pipeNum));
    ctx.setChatScrollOffset(-1);
    return;
  }
  p.unsubscribe();
  ctx.chatLines.push(slashRuntime.unpipeResultLine(pipeNum, p.terminalId, p.channel));
  ctx.setChatScrollOffset(-1);
  return;
}

async function termPipes(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix } = locals;
  const all = terminalMatrix.listPipes();
  if (all.length === 0) {
    ctx.chatLines.push(slashRuntime.pipesEmptyLine());
  } else {
    ctx.chatLines.push(slashRuntime.pipesHeaderLine());
    for (const p of all) {
      ctx.chatLines.push(slashRuntime.pipesEntryLine(p.id, p.terminalId, p.channel, p.lineMode));
    }
  }
  ctx.setChatScrollOffset(-1);
  return;
}

async function termReadonly(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix } = locals;
  const targetRaw = (args[1] ?? '').trim();
  const stateArg = (args[2] ?? '').trim().toLowerCase();
  if (!targetRaw) {
    ctx.chatLines.push(slashRuntime.readonlyUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const inst = terminalMatrix.get(targetRaw)
    ?? terminalMatrix.list({ includeExited: true })
      .find(i => i.id.endsWith(`:${targetRaw}`));
  if (!inst) {
    ctx.chatLines.push(slashRuntime.terminalMissingLine(targetRaw));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const next = stateArg === 'on' ? true
    : stateArg === 'off' ? false
    : !inst.readOnly;
  terminalMatrix.setReadOnly(inst.id, next);
  ctx.chatLines.push(slashRuntime.readonlyResultLine(inst.id, next));
  ctx.setChatScrollOffset(-1);
  return;
}

async function termVwBar(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, vwRegistry } = locals;
  const winArg = (args[1] ?? '').trim();
  const stateArg = (args[2] ?? '').trim().toLowerCase();
  const w = winArg
    ? vwRegistry.get(Number(winArg))
    : vwRegistry.current();
  if (!w) {
    ctx.chatLines.push(slashRuntime.vwBarMissingLine(winArg || '(current)'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const next = stateArg === 'on' ? true
    : stateArg === 'off' ? false
    : !w.isSyncInputBarActive();
  w.setSyncInputBar(next);
  ctx.chatLines.push(slashRuntime.vwBarResultLine(w.id, next));
  ctx.setChatScrollOffset(-1);
  ctx.draw();
  return;
}

async function termVwSync(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, broadcastBus } = locals;
  const winArg = (args[1] ?? '').trim();
  const text = args.slice(2).join(' ');
  if (!winArg || !text) {
    ctx.chatLines.push(slashRuntime.vwSyncUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const group = `_vw:${winArg}`;
  const r = broadcastBus.broadcastBytes(group, text);
  ctx.chatLines.push(slashRuntime.vwSyncResultLine(
    group,
    r.delivered.length,
    r.skippedExited.length + r.skippedReadOnly.length,
    r.errored.length,
  ));
  ctx.setChatScrollOffset(-1);
  return;
}

async function termRecharacter(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix } = locals;
  const targetRaw = (args[1] ?? '').trim();
  const charRaw = (args[2] ?? '').trim();
  if (!targetRaw || !charRaw) {
    ctx.chatLines.push(slashRuntime.recharacterUsageLine());
    ctx.setChatScrollOffset(-1);
    return;
  }
  const inst = terminalMatrix.get(targetRaw)
    ?? terminalMatrix.list({ includeExited: true })
      .find(i => i.id.endsWith(`:${targetRaw}`));
  if (!inst) {
    ctx.chatLines.push(slashRuntime.terminalMissingLine(targetRaw));
    ctx.setChatScrollOffset(-1);
    return;
  }
  let character: { kind: 'shell' | 'claude-code' | 'codex' | 'custom'; name?: string };
  if (charRaw === 'shell') character = { kind: 'shell' };
  else if (charRaw === 'claude' || charRaw === 'claude-code') character = { kind: 'claude-code' };
  else if (charRaw === 'codex') character = { kind: 'codex' };
  else if (charRaw.startsWith('custom:')) character = { kind: 'custom', name: charRaw.slice(7) };
  else {
    ctx.chatLines.push(slashRuntime.unknownCharacterLine(charRaw));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const r = terminalMatrix.recharacterAndReexec(inst.id, character);
  ctx.chatLines.push(slashRuntime.recharacterResultLine(inst.id, character.kind, r.reexeced));
  ctx.setChatScrollOffset(-1);
  return;
}

async function termMatrix(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
  const { slashRuntime, terminalMatrix } = locals;
  const all = terminalMatrix.list({ includeExited: true });
  if (all.length === 0) {
    ctx.chatLines.push(slashRuntime.matrixEmptyLine());
  } else {
    ctx.chatLines.push(ctx.accent('  term:ID    character    transport   placement         groups     title'));
    for (const i of all) {
      const char = i.character.kind.padEnd(12);
      const tp = i.transport.kind.padEnd(10);
      const place = (i.placement.kind === 'vw'
        ? `vw:${i.placement.windowId}/${i.placement.slotId}`
        : i.placement.kind).padEnd(18);
      const groups = i.broadcastGroups.size
        ? `[${[...i.broadcastGroups].join(',')}]`
        : '-';
      const dead = i.exitCode !== null ? ctx.error(' exited') : '';
      ctx.chatLines.push(`  ${i.id.padEnd(10)} ${char} ${tp} ${place} ${groups.padEnd(10)} ${i.title}${dead}`);
    }
  }
  ctx.setChatScrollOffset(-1);
  return;
}

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
export async function handleTermSlash(args: string[], ctx: TermSlashContext): Promise<void> {
  // The biggest /term — 23 subcommands across 6 host-local subsystems
  // (sessionRegistry · terminalMatrix · vwRegistry · broadcastBus ·
  // channelBus + session-picker modal lifecycle). Static-imported in
  // this module: getShellRegistry · renderHandleStatusChip ·
  // resolveTerminalMoveDestination · loadPersistedSessions ·
  // dispatchTerminalModalObserve. Behavior preserved verbatim from
  // the inline case.
  const sub = (args[0] ?? '').toLowerCase();
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
export function registerTermSlash<C extends TermSlashContext, R>(registry: SlashCommandRegistry<C, R>): void {
  registry.register(['term', 'terminal'], async (args, ctx) => {
    await handleTermSlash(args, ctx);
  });
}
