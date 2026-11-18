// Product stage C3, partial axis: real watcher + plan share one isolated mail ledger and queue.
// A queued notice is still unseen when the plan absorbs; it must not become a second turn.
// Scenario id renamed C3 → C1-MAIL (sim-owner adjudication · TC-H-CC-3 #90220 → #90474): the 정본 §3.6 C3 is the
// 10-min Bash/mail/person/Esc axis (measured by #38673); this scene is the C1 mail axis (원천 1a·1b) partial. The
// PRODUCT stage token 'C3' below (C3-b mail adapter seam) is a different namespace and keeps its name.
import { MsgStore, type Message } from '../../../msg/msg-store.js';
import { createNextTuiQueue } from '../../../tui/core/queue.js';
import { createSeatMailArrivalWatcher } from '../../../tui/seat-mail-arrival.js';
import { seatTaskQueueFromPromptQueue, wireSeatMailToPlan } from '../../../tui/seat-mail-boot.js';
import { seatMailMessageOf, type SeatMailMessageRead } from '../../../tui/seat-message-receipts.js';
import { createSeatMailAdapter } from '../../../tui/turn-events/mail-adapter.js';
import type { SimWorldScenario } from '../types.js';

const c1Mail: SimWorldScenario = {
  id: 'C1-MAIL', title: 'one mail is not queued twice by watcher and plan',
  async run(ctx) {
    const seat = 'SIMSEAT';
    const store = new MsgStore(':memory:');
    const queue = createNextTuiQueue({ log: () => {} });
    const adapter = createSeatMailAdapter({ now: () => 1_000_000 });
    const read = (_cwd: string, after: number): SeatMailMessageRead => ({
      seat, messages: store.listByRecipient(seat, after).map(seatMailMessageOf),
    });
    const watcherDeps = { messages: { read }, mailAdapter: adapter,
      log: () => {}, onReadError: () => {} } as Parameters<typeof createSeatMailArrivalWatcher>[2];
    const ledger = { list: (recipient: string, after = 0) => store.listByRecipient(recipient, after) as Message[],
      getCursor: () => 0, getMessage: () => null };
    const planOptions = { seat, ledger, mailAdapter: adapter } as Parameters<typeof wireSeatMailToPlan>[1];
    const watcher = createSeatMailArrivalWatcher(ctx.universeRoot, queue, watcherDeps);
    const plan = wireSeatMailToPlan(seatTaskQueueFromPromptQueue(queue), planOptions);
    try {
      watcher.poll();
      const msg = store.post({ from: 'OP', to: seat, body: '칸 CAPSULE-C3 구현 후 시험하고 보고' });
      watcher.poll();
      const before = queue.items.filter(item => item.kind === 'notice').map(item => item.msgId ?? null);
      plan.absorb();
      const after = queue.items.filter(item => item.kind === 'notice').map(item => item.msgId ?? null);
      ctx.recorder.event('c3-mail-race', { msgId: msg.id, before, after });
      if (JSON.stringify(before) !== JSON.stringify([msg.id]))
        return { ok: false, reason: 'C3 watcher did not queue the mail', diff: `before plan ${JSON.stringify(before)}` };
      if (JSON.stringify(after) !== JSON.stringify([msg.id]))
        return { ok: false, reason: 'mail queued twice by watcher and plan', diff: `after plan ${JSON.stringify(after)}` };
      return { ok: false, reason: 'C3 remaining mail routes unmeasured', diff: 'watcher/plan deduped; idle wake, herdr and real turn delivery remain unmeasured' };
    } finally { watcher.stop(); store.close(); }
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [c1Mail];
