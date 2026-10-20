import type { DashboardSlashContext, DashboardSlashReturn } from './dashboard-handlers.js';
import type { SlashCommandRegistry } from './registry.js';
import { defaultControlSignalObserver } from '../../input/control-signal-observer.js';

/** Register the slash handlers that delegate to showDashboard-local runtimes. */
export function registerDashboardDelegatedSlashes(
  registry: SlashCommandRegistry<DashboardSlashContext, DashboardSlashReturn>,
): void {
  registry.register(['signals', 'signal'], (args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    const rt = ctx.controlSignalSlashRuntime;
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent(`❯ /signals ${args.join(' ').trim() || 'status'}`));
    if (sub === 'help') {
      for (const line of rt.usageLines()) ctx.chatLines.push(line);
    } else if (sub === 'status') {
      for (const line of rt.statusLines()) ctx.chatLines.push(line);
    } else if (sub === 'clear') {
      defaultControlSignalObserver().clear();
      ctx.chatLines.push(rt.clearLine());
    } else if (sub === 'latest') {
      const parsed = rt.parseFilterTokens(args.slice(1));
      for (const line of rt.latestLines(parsed.filter)) ctx.chatLines.push(line);
    } else if (sub === 'list' || sub === 'ls') {
      const parsed = rt.parseFilterTokens(args.slice(1));
      for (const line of rt.listLines(parsed.limit, parsed.filter)) ctx.chatLines.push(line);
    } else if (sub === 'emit') {
      for (const line of rt.emitLines(args.slice(1))) ctx.chatLines.push(line);
    } else {
      for (const line of rt.usageLines()) ctx.chatLines.push(line);
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['widget', 'widgets', 'w'], async (args, ctx) => {
    const sub = (args[0] || 'list').toLowerCase();
    const host = ctx.widgetHost;
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent(`❯ /widget ${sub}${args.slice(1).length ? ' ' + args.slice(1).join(' ') : ''}`));
    try {
      if (sub === 'list' || sub === 'ls') {
        const items = host.available();
        if (items.length === 0) {
          ctx.chatLines.push(ctx.muted('  (no widgets found — drop one in ~/.claude/widgets/<name>/widget.ts)'));
        } else {
          for (const it of items) {
            const src = it.source === 'builtin' ? ctx.muted('[built-in]') : ctx.info('[user]');
            // The original used `C.bold` but ctx doesn't expose `bold`;
            // we substitute `accent` (visually similar) since handlers
            // module's color contract is the published ctx subset.
            ctx.chatLines.push(`  ▢ ${ctx.accent(it.def.type)} ${src}  ${ctx.muted(it.def.description)}`);
          }
        }
      } else if (sub === 'reload' || sub === 'r') {
        await host.discover();
        ctx.chatLines.push(ctx.success(`  reloaded — ${host.available().length} widget type(s) discovered`));
      } else if (sub === 'instances' || sub === 'i') {
        const count = host.instanceCount();
        ctx.chatLines.push(`  ${count} widget instance(s) alive`);
      } else {
        ctx.chatLines.push(ctx.warning(`  unknown subcommand: ${sub} (try list|reload|instances)`));
      }
    } catch (err: unknown) {
      ctx.chatLines.push(ctx.error(`  error: ${err instanceof Error ? err.message : String(err)}`));
    }
    ctx.setChatScrollOffset(-1);
  });
}
