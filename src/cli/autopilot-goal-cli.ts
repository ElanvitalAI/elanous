// CROWN-GOAL-APPLY — `autopilot goal set --seat <SEAT> "<goal>" --from <seat>`: set another seat's autopilot goal chip.
// The CLI posts ONE mail carrying the structured `goal` field; the receiving seat's TUI applies it to its autopilot state
// (the same store autopilot_set writes) — logged `autopilot goal-applied {source, msgId}` and one transcript line.
// OP / CLAUDE-OP may set any seat's goal; a space coordinator its own hands' (federation ladder); any seat with --crown-directive <id>.
import type { Command } from 'commander';
import { defaultMsgStorePath, openMsgStore } from '../msg/msg-store.js';
import { goalSetEnvelope, type GoalLadder } from '../session-autopilot/crown-goal-apply.js';

export interface AutopilotGoalCliDeps {
  msgPath?: () => string;
  /** The seat running the CLI when --from is omitted (default ELANOUS_TRACK). */
  callerSeat?: () => string | null;
  out?: { log: (line: string) => void; error: (line: string) => void };
  /** The federation ladder (default: els journal ⊕ federation.yaml) — read only when the sender is not OP / CLAUDE-OP. */
  ladder?: () => GoalLadder | null;
}

export function registerAutopilotGoalCommands(program: Command, deps: AutopilotGoalCliDeps = {}): void {
  const out = deps.out ?? { log: (line: string) => console.log(line), error: (line: string) => console.error(line) };
  const autopilot = program.commands.find((c) => c.name() === 'autopilot') ?? program.command('autopilot').description('Session autopilot (seat goal)');
  const goal = autopilot.command('goal').description('Seat autopilot goal');
  goal.command('set <goal>').description('Set a seat\'s autopilot goal chip (posts one structured goal mail; the seat\'s TUI applies it)')
    .requiredOption('--seat <seat>', 'seat whose goal is set (e.g. OP)')
    .option('--from <seat>', 'sending seat: OP / CLAUDE-OP, or a space coordinator for its own hands (default: ELANOUS_TRACK)')
    .option('--crown-directive <id>', 'crown directive ID this goal executes (lets any sender set it)')
    .option('--done <condition>', 'one line: when the goal is done')
    .option('--task', 'a TASK goal (concrete done-when: cell · PR · receipt) — the seat continues it on its own; without it the goal is standing (checked on the cadence only)')
    .option('--json')
    .action((text: string, opts: { seat: string; from?: string; crownDirective?: string; done?: string; task?: boolean; json?: boolean }) => {
      try {
        const from = opts.from ?? (deps.callerSeat ?? (() => process.env.ELANOUS_TRACK?.trim() || null))() ?? '';
        if (!from.trim()) throw new Error('--from is required (OP / CLAUDE-OP or a space coordinator)');
        const ladder = deps.ladder ?? (() => (require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js')).loadFederationLadder());
        const envelope = { ...goalSetEnvelope({ from, seat: opts.seat, goal: text, ladder, ...(opts.crownDirective ? { crownDirective: opts.crownDirective } : {}) }),
          ...(opts.done?.trim() ? { doneWhen: opts.done.trim() } : {}), ...(opts.task ? { refs: ['goal:task'] } : {}) };
        const store = openMsgStore((deps.msgPath ?? defaultMsgStorePath)());
        let id: number;
        try { id = store.post(envelope, { dedupe: false }).id; } finally { store.close(); }
        if (opts.json) out.log(JSON.stringify({ ok: true, msgId: id, seat: envelope.to, from: envelope.from, goal: envelope.goal }));
        else out.log(`goal mail #${id} → ${envelope.to}: ${envelope.goal} (applied by the seat's TUI on arrival)`);
      } catch (error) {
        out.error(`autopilot goal set: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
