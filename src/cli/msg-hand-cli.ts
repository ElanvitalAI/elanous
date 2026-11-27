// ── `eln msg hand` (HAND-RAISE-LADDER) ─────────────────────────────────────────────────────────
//   hand <msgId> resolve|reject|escalate "<text>" [--from <seat>]  = give a ✋ NEED HUMAN mail its one outcome
//   hand sweep [--seat <seat>]                                      = auto-escalate open ✋ older than 10 min one level
//   hand board                                                      = open ✋ per level with age (Federation Board line)
//   hand list [--seat <seat>]                                       = the open ✋ mails
//   hand advise [--space TC] [--advisor TC-ADV] [--shadow]          = SPACE-ADVISOR tick (learn · steward · precedent · card · digest)
//   hand advisor [--space TC] [--advisor TC-ADV]                    = advisor board line (30m metrics ⊕ coordinator ✋ load)
// The ladder module is loaded inside the actions only — `msg post` / `msg ack` stay light.
import type { Command } from 'commander';
import type { MsgStore } from '../msg/msg-store.js';
import type { FederationLadder } from '../msg/hand-raise-ladder.js';

export interface MsgHandCliDeps {
  openStore: () => MsgStore;
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
  now?: () => Date;
  ladder?: () => FederationLadder;
  /** SPACE-LEAD-HUMAN — the human-lead channel; absent with an injected ladder (tests) = none, else the live config. */
  humanLead?: () => import('../msg/hand-raise-ladder.js').HumanLeadPort | undefined;
  raiseDecision?: (card: import('../msg/hand-raise-ladder.js').CeoCard) => void;
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

export function registerMsgHandCommands(msg: Command, deps: MsgHandCliDeps): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const now = (): number => (deps.now ? deps.now().getTime() : Date.now());
  msg.command('hand <target> [action] [text...]')
    .description('✋ NEED HUMAN outcomes: hand <msgId> resolve|reject|escalate "<text>" · hand sweep · hand beacon · hand board · hand list')
    .option('--from <seat>', 'acting seat (default: the ✋ receiver)')
    .option('--seat <seat>', 'sweep / list: only the hands this seat sent or holds')
    .option('--owner <seat>', 'resolve that keeps the hand waiting: who owns unblocking it (with --deadline)')
    .option('--deadline <iso>', 'resolve that keeps the hand waiting: by when (with --owner)')
    .option('--space <seat>', 'advise / advisor: the coordinator the advisor serves (default TC)')
    .option('--advisor <seat>', 'advise / advisor: the advisor seat (default <space>-ADV)')
    .option('--shadow', 'advise: decide and print, write nothing')
    .option('--json')
    .action(async (target: string, action: string | undefined, textParts: string[] | undefined, opts: { from?: string; seat?: string; json?: boolean; owner?: string; deadline?: string; space?: string; advisor?: string; shadow?: boolean }) => {
      const ladderModule = await import('../msg/hand-raise-ladder.js');
      const { debug } = await import('../debug/log.js');
      const ladder = deps.ladder?.() ?? ladderModule.loadFederationLadder();
      const humanLead = deps.humanLead ? deps.humanLead() : deps.ladder ? undefined : (await import('../seat/space-lead-live.js')).liveHumanLeadPort();
      const ladderDeps = {
        ladder, now, raiseDecision: deps.raiseDecision ?? ladderModule.spawnHandDecision, ...(humanLead ? { humanLead } : {}),
        log: (event: string, data: Record<string, unknown>) => { try { debug.log('needhuman', event, data); } catch { /* fail-open */ } },
      };
      const store = deps.openStore();
      try {
        if (target === 'advise' || target === 'advisor') {
          // SPACE-ADVISOR — src/steward/space/advisor.ts (✋ → steward resolver → advisor → card → coordinator)
          const adv = await import('../steward/space/advisor.js');
          const coordinator = (opts.space ?? 'TC').toUpperCase();
          const advisor = (opts.advisor ?? `${coordinator}-ADV`).toUpperCase();
          const paths = adv.advisorPaths(advisor);
          const advDeps = { ...ladderDeps, advisor, coordinator, ...paths, live: !opts.shadow && target === 'advise' };
          if (target === 'advise') {
            const live = await import('../steward/space/advisor-live.js');
            const ports = advDeps.live && !deps.ladder ? live.liveAdvisorPorts() : undefined;
            const run = live.runAdvise(store, { ...ladderDeps, coordinator, advisor, live: advDeps.live, ...(ports ? { ports } : {}) });
            if (opts.json) out.log(JSON.stringify(run));
            else { for (const s of run.steps) out.log(`${s.kind} ✋ #${s.handId} (${s.cause})`); out.log(run.digest.body); }
            return;
          }
          const open = ladderModule.openHands(store, { now: now(), ladder, involving: coordinator }).filter((h) => h.receiver === coordinator).length;
          const m = adv.advisorMetrics(adv.readAdvisorEvents(paths.eventsPath), now() - adv.ADVISOR_DIGEST_EVERY_MS, open);
          out.log(opts.json ? JSON.stringify(m) : adv.advisorBoardLine(advisor, coordinator, m));
          return;
        }
        if (target === 'sweep') {
          const done = ladderModule.sweepHandRaises(store, { ...ladderDeps, ...(opts.seat ? { involving: opts.seat } : {}) });
          if (opts.json) out.log(JSON.stringify(done));
          else if (done.length === 0) out.log('No ✋ waiting past 10 minutes.');
          else for (const d of done) out.log(`✋ #${d.msgId} ${d.from} → ${d.to} (waited ${d.waitedMin}m)`);
          return;
        }
        if (target === 'beacon') {
          // BEACON-LADDER — the OP steward watcher's rule, one shot (the steward HQ tick runs the same call).
          const { liveDormantSeats } = await import('../steward/space/tick.js');
          const { sweepDormantUnanswered, sweepLoopHandSla } = await import('../kit/mail-route/dormant-watch.js');
          // GUARDIAN-HAND-SLA — first, as the steward HQ tick does: loop-agent ✋ past their SLA back to the domain owner.
          const loopSla = sweepLoopHandSla(store, { hq: ladder.hq, log: (event, data) => { try { debug.log('msg', event, data); } catch { /* fail-open */ } } });
          const report = ladderModule.beaconHands(store, { ...ladderDeps, dormantSeats: liveDormantSeats() });
          // DORMANT-SEAT-ROUTE — the same one shot: rerouted dormant-seat mail unanswered for 10 min → one OP card.
          const dormant = sweepDormantUnanswered(store, { log: (event, data) => { try { debug.log('msg', event, data); } catch { /* fail-open */ } } });
          if (opts.json) out.log(JSON.stringify({ ...report, dormant, loopSla }));
          else { out.log(loopSla.line); out.log(ladderModule.beaconLine(report)); for (const f of report.fired) out.log(`beacon ✋ #${f.leadId} ${f.seat}@${f.leader} → #${f.cardId}: ${f.why}`); out.log(dormant.line); }
          return;
        }
        if (target === 'board') {
          const levels = ladderModule.handBoardLevels(store, { now: now(), ladder });
          out.log(opts.json ? JSON.stringify(levels) : ladderModule.handBoardLine(levels));
          return;
        }
        if (target === 'list') {
          const opens = ladderModule.openHands(store, { now: now(), ladder, ...(opts.seat ? { involving: opts.seat } : {}) });
          if (opts.json) { out.log(JSON.stringify(opens)); return; }
          if (opens.length === 0) { out.log('No open ✋.'); return; }
          for (const h of opens) out.log(`#${h.id} ${h.sender} → ${h.receiver} · ${minutes(h.waitedMs)}m · ${h.reason} · ${h.body.replace(/\s+/g, ' ').slice(0, 120)}`);
          return;
        }
        const msgId = Number(target);
        if (!Number.isSafeInteger(msgId) || msgId < 1) throw new Error(`hand: <target> must be a message ID, sweep, board or list (got ${target})`);
        const verb = (action ?? '').trim().toLowerCase();
        if (!ladderModule.HAND_ACTIONS.includes(verb as never)) throw new Error('hand: action must be resolve, reject or escalate');
        const result = ladderModule.applyHandOutcome(store, { msgId, action: verb as import('../msg/hand-raise-ladder.js').HandAction, text: (textParts ?? []).join(' '), via: 'cli',
          ...(opts.from ? { actor: opts.from } : {}), ...(opts.owner ? { owner: opts.owner } : {}), ...(opts.deadline ? { deadline: opts.deadline } : {}) }, ladderDeps);
        // FED-FACT-OP-ACTIONS — a ✋ outcome is a decision by the seat that gave it. Fail-open.
        if (result.by) (await import('../fed-state/actions.js')).recordAction({ kind: 'decision', verb: verb, by: result.by, to: result.to, ref: `msg:${result.msgId}`, source: 'msg-hand' });
        out.log(opts.json ? JSON.stringify(result) : result.output);
      } catch (error) {
        out.error(`msg hand: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(1);
      } finally { store.close(); }
    });
}
