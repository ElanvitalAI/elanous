// ── `eln msg wait-for` · `msg wait-tick` · `msg wait-list` (ELN-SELF-TIMER-WATCH · I3) ──────────────────────
// 자리가 스스로 거는 깨우개의 CLI 문. 본체는 src/msg/self-timer-watch.ts — 여기는 인자 해석과 출력뿐이다.
//   wait-for <조건> --notify <자리> --commitment <원장 id> [--within <dur>] [--arm-only]
//     = 원장 항목에 깨우개를 묶고(중복이면 합침), 기본은 상한 있는 until-loop 로 발화·만료까지 지켜본 뒤 끝난다.
//       --arm-only 면 걸기만 하고 바로 끝난다(틱이 잰다).
//   wait-tick [--seat <자리>] = armed 깨우개를 한 번씩 잰다(일정 틱용 · 루프 없음).
//   wait-list --seat <자리>   = 깨우개 목록.
// 종료 코드: 발화·걸기 0 · 만료 3(«expired» 는 시끄럽게) · 묶임/지평 위반 2.
import type { Command } from 'commander';
import type { SelfTimerDeps } from '../msg/self-timer-watch.js';

// 본체는 액션 안에서만 불러온다 — `msg post`·`msg ack` 같은 뜨거운 길이 깨우개 모듈을 싣지 않게.
const loadTimer = () => import('../msg/self-timer-watch.js');
/** 묶임·지평 위반 — 오류 이름으로 가른다(본체를 지연 적재하므로 instanceof 대신). */
const REJECTION_ERRORS: ReadonlySet<string> = new Set(['WakerBindingError', 'WakerHorizonError']);

export const WAIT_FOR_EXIT_EXPIRED = 3;
export const WAIT_FOR_EXIT_REJECTED = 2;
export const WAIT_FOR_EXIT_ERROR = 1;

export interface MsgWaitForCliDeps {
  timer?: SelfTimerDeps;
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
  cwd?: () => string;
}

/** The production preempt probe: the first ✋ mail to `seat` after the wait started (null when the ledger cannot be read). */
export async function handPreemptProbe(seat: string): Promise<(() => string | null) | null> {
  try {
    const { defaultMsgStorePath, openMsgStoreReadOnly } = await import('../msg/msg-store.js');
    const { handArrivedAfter, handPreemptLine } = await import('../msg/hand-raise-ladder.js');
    const first = openMsgStoreReadOnly(defaultMsgStorePath());
    let afterId: number;
    try { afterId = first.latestId(); } finally { first.close(); }
    return () => {
      const store = openMsgStoreReadOnly(defaultMsgStorePath());
      try { const hand = handArrivedAfter(store, seat, afterId); return hand ? handPreemptLine(hand) : null; } finally { store.close(); }
    };
  } catch { return null; }
}

export function registerMsgWaitForCommands(msg: Command, deps: MsgWaitForCliDeps = {}): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const timer = deps.timer ?? {};
  const emit = (value: unknown, json: boolean | undefined, human: () => void) => { if (json) out.log(JSON.stringify(value)); else human(); };
  /** msg-cli `run` 과 같은 결 — 오류는 한 줄 ⊕ 종료 코드(묶임·지평 위반 = 2 · 그 밖 = 1). 던지지 않는다. */
  const run = <A extends unknown[]>(name: string, action: (...args: A) => void | Promise<void>) => async (...args: A) => {
    try { await action(...args); }
    catch (error) {
      if (error instanceof Error && REJECTION_ERRORS.has(error.name)) {
        out.error(`msg ${name} 거부: ${error.message}`);
        setExitCode(WAIT_FOR_EXIT_REJECTED);
        return;
      }
      out.error(`msg ${name}: ${error instanceof Error ? error.message : String(error)}`);
      setExitCode(WAIT_FOR_EXIT_ERROR);
    }
  };

  msg.command('wait-for <condition>')
    .description('Arm a self wake bound to a commitment ledger entry: time:<dur> · pr-merged:<N> · review:<N> · mail-reply:<M> · file:<path> · pregate-receipt:<PR>[@head] · cell-status:<id>=green|owner=<seat> · seat-idle:<seat> · file-exists:<path> · mail-from:<seat>')
    .requiredOption('--notify <seat>', 'seat whose mailbox receives the fired/expired notice')
    .requiredOption('--commitment <id>', 'commitment ledger entry this waker is bound to (required)')
    .option('--within <dur>', 'horizon (30s · 10m · 2h); default 10m for mail-reply (then one reminder to the counterpart, 5 more min, then cancelled with a result) · other conditions default to the max horizon · ceiling = max horizon')
    .option('--arm-only', 'register and exit; a later wait-tick evaluates it')
    .option('--auto-close', 'COND-WATCH: when the condition holds, close the commitment done with the evidence line (one wake)')
    .option('--json')
    .action(run('wait-for', async (condition: string, opts: { notify: string; commitment: string; within?: string; armOnly?: boolean; autoClose?: boolean; json?: boolean }) => {
      const { armWaker, parentAliveProbe, parseDuration, watchWaker } = await loadTimer();
      const armed = armWaker({
        seat: opts.notify, commitmentId: opts.commitment, condition,
        ...(opts.within === undefined ? {} : { withinMs: parseDuration(opts.within) }),
        cwd: (deps.cwd ?? (() => process.cwd()))(),
        ...(opts.autoClose ? { autoClose: true } : {}),
      }, timer);
      if (opts.armOnly) {
        emit({ ...armed, outcome: armed.merged ? 'merged' : 'armed' }, opts.json, () =>
          out.log(`${armed.merged ? '합침' : '걸림'} ${armed.waker.id} · ${armed.waker.condition} · 약속 ${armed.waker.commitmentId} · 지평 ${armed.waker.deadlineAt}`));
        return;
      }
      // HAND-RAISE-LADDER — a ✋ to the waiting seat ends the wait early («✋ arrived: …»); the waker stays armed.
      // Injected timer deps (tests) bring their own probe; production reads the mail ledger.
      const preempt = timer.preempt ?? (deps.timer ? null : await handPreemptProbe(armed.waker.seat));
      // RAIL30 ⑥ — a blocking watch follows its parent (the seat TUI's shell): parent gone → end, waker stays armed.
      const parentAlive = timer.parentAlive ?? (deps.timer ? undefined : parentAliveProbe());
      const result = await watchWaker(armed.waker.seat, armed.waker.id, { ...timer, ...(preempt ? { preempt } : {}), ...(parentAlive ? { parentAlive } : {}) });
      if (result.outcome === 'orphaned') {
        emit({ outcome: 'orphaned', merged: armed.merged, waker: result.waker }, opts.json, () =>
          out.log(`orphaned ${result.waker.id} · parent process gone — the waker stays armed (wait-tick evaluates it) · 약속 ${result.waker.commitmentId}`));
        return;
      }
      if (result.outcome === 'preempted') {
        emit({ outcome: 'preempted', merged: armed.merged, waker: result.waker, line: result.line }, opts.json, () => out.log(result.line));
        return;
      }
      emit({ outcome: result.outcome, merged: armed.merged, waker: result.waker }, opts.json, () =>
        out.log(`${result.outcome} ${result.waker.id} · ${result.waker.condition} · 약속 ${result.waker.commitmentId}`
          + (result.outcome === 'cancelled' && result.waker.cancelReason ? ` · ${result.waker.cancelReason}` : '')));
      if (result.outcome === 'expired') setExitCode(WAIT_FOR_EXIT_EXPIRED);
    }));

  msg.command('wait-tick')
    .description('Evaluate armed self wakes once (for a schedule tick); never loops')
    .option('--seat <seat>').option('--json')
    .action(run('wait-tick', async (opts: { seat?: string; json?: boolean }) => {
      const { tickWakers } = await loadTimer();
      const ticks = await tickWakers(opts.seat, timer);
      // MSG-WAIT-CONTRACT — the same tick advances the ledger reply waits (msg ask · MsgAsk): reminder, then cancel.
      if (!deps.timer) {
        try {
          const { defaultMsgStorePath, openMsgStore } = await import('../msg/msg-store.js');
          const { sweepWaitContracts } = await import('../msg/msg-wait-contract.js');
          const { loadFederationLadder } = await import('../msg/hand-raise-ladder.js');
          const ladder = loadFederationLadder();
          const store = openMsgStore(defaultMsgStorePath());
          try {
            for (const a of sweepWaitContracts(store, { now: Date.now(), ...(opts.seat ? { involving: opts.seat } : {}), parentOf: ladder.parentOf }))
              if (!opts.json) out.log(`${a.state} msg-wait #${a.messageId} · ${a.asker} → ${a.counterpart}`);
          } finally { store.close(); }
        } catch (error) { out.error(`msg wait-tick: reply-wait sweep failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      emit(ticks, opts.json, () => {
        if (!ticks.length) out.log('No armed wakers.');
        for (const t of ticks) out.log(`${t.outcome} ${t.waker.seat}/${t.waker.id} · ${t.waker.condition}`);
      });
      if (ticks.some(t => t.outcome === 'expired')) setExitCode(WAIT_FOR_EXIT_EXPIRED);
    }));

  msg.command('wait-list')
    .description('List self wakes for a seat')
    .requiredOption('--seat <seat>').option('--json')
    .action(run('wait-list', async (opts: { seat: string; json?: boolean }) => {
      const { listWakers } = await loadTimer();
      const wakers = listWakers(opts.seat, timer);
      emit(wakers, opts.json, () => {
        if (!wakers.length) out.log('No wakers.');
        for (const w of wakers) out.log(`${w.status} ${w.id} · ${w.condition} · 약속 ${w.commitmentId} · 지평 ${w.deadlineAt}`);
      });
    }));
}
