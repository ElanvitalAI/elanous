import { dispatchTerminalModalObserve } from '../../../skills/tools/terminal-modal.js';
import { resolveTerminalMoveDestination } from '../../../terminal-matrix/mobility.js';
import type { TermSlashContext, TermSlashLocals } from './contracts.js';

export async function termMatrix(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termSnapshot(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termMove(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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
        && ctx.termSlash.modalRouter.current()?.id === inst.legacySessionId) {
      ctx.termSlash.modalRouter.set(null);
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

export async function termUnpipe(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termChannel(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termPipe(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termGroup(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termPipes(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termVwSync(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termRecharacter(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termVwBar(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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

export async function termReadonly(sub: string, args: string[], ctx: TermSlashContext, locals: TermSlashLocals): Promise<void> {
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
