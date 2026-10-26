import { loadSidetabRows, type SidetabRow } from '../tui/sidetab/list.js';
import { stripAnsi, termSize } from '../tui.js';
import { requestRemotePtyControl } from '../pty-shell/pty-control-ipc.js';
import type { SlashCommandRegistry } from './slash-runtime/registry.js';
import type { DashboardSlashContext, DashboardSlashReturn } from './slash-runtime/dashboard-handlers.js';

/** Classic /side: the Next TUI manifest is the sole source of list ordering. */
export function registerClassicSideSlash(
  registry: SlashCommandRegistry<DashboardSlashContext, DashboardSlashReturn>,
  loadRows: (sessionId?: string) => SidetabRow[] = (sessionId) => loadSidetabRows(false, sessionId),
  snapshot: typeof requestRemotePtyControl = requestRemotePtyControl,
): void {
  registry.register(['side'], async (args, ctx) => {
    const sub = (args[0] ?? 'list').toLowerCase();
    if (sub === 'new') {
      if (args.length > 1) ctx.chatLines.push(ctx.warning('  사용법: /side new'));
      else ctx.termSlash.openNewTerminal();
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub !== 'list' && sub !== 'attach') {
      ctx.chatLines.push(ctx.muted('  사용법: /side [list] | new | attach <번호>'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    // Use the same filtered manifest rows for display and numeric resolution;
    // never let an exited row shift the number shown to the user.
    const rows = loadRows(ctx.chatPersona?.sessionId()).filter(row => row.badge !== 'exited');
    if (sub === 'list') {
      if (rows.length === 0) ctx.chatLines.push(ctx.muted('  사이드탭 없음'));
      rows.forEach((row, i) => ctx.chatLines.push(ctx.muted(`  ${i + 1}. ${row.badge} ${row.label}`)));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const raw = args[1] ?? '';
    const index = /^\d+$/.test(raw) ? Number(raw) - 1 : -1;
    const row = rows[index];
    if (args.length !== 2 || !row) {
      ctx.chatLines.push(ctx.warning('  사용법: /side attach <목록 번호>'));
    } else if (row.currentProcess) {
      ctx.chatLines.push(ctx.muted('  현재 세션입니다'));
    } else if (row.sessionId && ctx.termSlash.sessionRegistry.get(row.sessionId)) {
      const { cols, rows: height } = termSize();
      const session = ctx.termSlash.sessionRegistry.attach(row.sessionId, { termCols: cols, termRows: height });
      if (session?.modal) ctx.termSlash.openSession(session);
      else ctx.chatLines.push(ctx.warning('  PTY attach 실패'));
    } else if (row.ptyId) {
      try {
        // A foreign child belongs to another PTY owner: snapshot only, no takeover.
        const result = await snapshot(row.ptyId, 'snapshot', { ansi: false }, { timeoutMs: 450 });
        if (result.status === 'success' && result.screen?.trim()) {
          ctx.chatLines.push(ctx.muted(`  ${row.label} · 읽기 전용 snapshot (입력은 전달되지 않습니다)`));
          ctx.chatLines.push(...stripAnsi(result.screen).split('\n'));
        } else ctx.chatLines.push(ctx.warning(`  PTY 화면 읽기 실패 · ${result.status}`));
      } catch (error) {
        ctx.chatLines.push(ctx.warning(`  PTY 화면 읽기 오류 · ${error instanceof Error ? error.message : String(error)}`));
      }
    } else ctx.chatLines.push(ctx.warning('  attach할 PTY가 없습니다'));
    ctx.setChatScrollOffset(-1);
  });
}
