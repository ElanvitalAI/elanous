import type { DashboardSlashContext, DashboardSlashReturn } from './dashboard-handlers.js';
import { getShellRegistry } from '../../shell-runner/registry.js';
import { renderHandleStatusChip } from '../../status/chip.js';
import { decideAttach } from '../../shell-runner/attach-routing.js';
import type { SlashCommandRegistry } from './registry.js';

export function registerShellSlash(registry: SlashCommandRegistry<DashboardSlashContext, DashboardSlashReturn>): void {
  registry.register(['shell', 'sh'], async (args, ctx) => {
    // SP-C — /shell list|kill|attach family. Talks to the
    // ShellRegistry singleton (set up in the boot block in
    // dashboard/index.ts). Kill uses prefix matching on id so users
    // don't have to type the full slug; attach routes a vw-mode handle
    // into the foreground via VW switch.
    //
    // getShellRegistry + renderHandleStatusChip + decideAttach hoisted
    // from dynamic to static imports here. Host-local helpers
    // (shellSlashRuntime + openShellRollupPopup + virtualWindows ops)
    // come via ctx.shellSlash.
    const sub = (args[0] ?? '').toLowerCase();
    const reg = getShellRegistry();
    if (!sub || sub === 'help') {
      for (const line of ctx.shellSlash.slashRuntime.helpLines()) ctx.chatLines.push(line);
      ctx.setChatScrollOffset(-1);
      return;
    }
    const resolveHandle = (needle: string) => {
      const want = needle.toLowerCase();
      if (!want) return null;
      const exact = reg.get(needle);
      if (exact) return exact;
      const all = reg.list();
      const matches = all.filter(h => h.id.toLowerCase().startsWith(want));
      if (matches.length === 1) return matches[0]!;
      return matches.length > 1 ? { ambiguous: matches } as const : null;
    };
    if (sub === 'rollup') {
      // N2 — same popup as the 🐚 pill click, openable from
      // keyboard-only sessions (SSH / nested tmux).
      await ctx.shellSlash.openRollupPopup();
      return;
    }
    if (sub === 'list') {
      // N3 — `/shell list all` bypasses the 30s settled TTL so users
      // can audit everything. Default stays live-only.
      const showSettled = (args[1] ?? '').toLowerCase() === 'all';
      const all = reg.list(showSettled ? { includeSettled: true } : undefined);
      ctx.chatLines.push('');
      if (all.length === 0) {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.emptyListLine(showSettled));
        ctx.setChatScrollOffset(-1);
        return;
      }
      ctx.chatLines.push(ctx.shellSlash.slashRuntime.listHeaderLine(all.length, showSettled));
      for (const h of all) {
        const chip = renderHandleStatusChip(h.status);
        const label = reg.getVwLabel(h.id);
        const idTail = h.id.length > 10 ? `…${h.id.slice(-8)}` : h.id;
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.listEntryLine({
          idTail,
          chip,
          mode: h.mode,
          label,
        }));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'kill') {
      const needle = args[1] ?? '';
      if (!needle) {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.killUsageLine());
        ctx.setChatScrollOffset(-1);
        return;
      }
      const res = resolveHandle(needle);
      if (!res) {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.noHandleMatchesLine(needle));
      } else if ('ambiguous' in res) {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.ambiguousHeaderLine(needle));
        for (const h of res.ambiguous) {
          ctx.chatLines.push(ctx.shellSlash.slashRuntime.ambiguousEntryLine({ id: h.id }));
        }
      } else {
        try {
          res.kill();
          ctx.chatLines.push(ctx.shellSlash.slashRuntime.killedLine(res.id));
        } catch (err) {
          ctx.chatLines.push(ctx.shellSlash.slashRuntime.killFailedLine(
            err instanceof Error ? err.message : String(err),
          ));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'attach') {
      const needle = args[1] ?? '';
      if (!needle) {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.attachUsageLine());
        ctx.setChatScrollOffset(-1);
        return;
      }
      const res = resolveHandle(needle);
      if (!res) {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.noHandleMatchesLine(needle));
        ctx.setChatScrollOffset(-1);
        return;
      }
      if ('ambiguous' in res) {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.ambiguousHeaderLine(needle));
        for (const h of res.ambiguous) {
          ctx.chatLines.push(ctx.shellSlash.slashRuntime.ambiguousEntryLine({ id: h.id }));
        }
        ctx.setChatScrollOffset(-1);
        return;
      }
      // SRF-2 — attach routing by mode, delegated to the pure
      // decision fn in shell-runner/attach-routing.ts.
      const outcome = decideAttach(res, {
        getVwLabel: (id) => reg.getVwLabel(id),
        resolveVwIdByLabel: (label) => ctx.shellSlash.resolveVwIdByLabel(label),
      });
      if (outcome.kind === 'switch-vw') {
        ctx.shellSlash.virtualWindowsSwitchTo(outcome.windowId);
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.attachedLine(
          outcome.windowId,
          outcome.label,
          outcome.mode,
        ));
      } else if (outcome.kind === 'bg') {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.bgAttachWarningLine(outcome.status));
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.bgAttachHintLine());
      } else if (outcome.kind === 'no-window') {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.noWindowAttachWarningLine(outcome.reason));
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.noWindowAttachHintLine());
      } else {
        ctx.chatLines.push(ctx.shellSlash.slashRuntime.genericAttachWarningLine(outcome.reason));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    ctx.chatLines.push(ctx.shellSlash.slashRuntime.unknownSubcommandLine(sub));
    ctx.setChatScrollOffset(-1);
  });
}
