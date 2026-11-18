// SEAT-IDLE-STALL-SENTINEL — 실측 사건 모양마다 하나(E·D 무변화 running · 63분 셸 정체 · RES 미ack 배정 우편 2통 ·
// D «다음 스텝» 선언 뒤 턴 끝) ⊕ 정상 ⊕ 출처 모름. 가짜 스냅샷 · 가짜 시계 · 실제 herdr/tmux/우편 호출 0.
// 단언은 정책 상수와 입력에서 유도한다(숫자 리터럴·벽시계 단언 0).
import { describe, expect, test } from 'bun:test';
import { projectGraphLoopViews } from '../graph-view/model.js';
import type { HerdrCliRunner } from '../pty-shell/herdr-prompt.js';
import type { SeatRegistryRead } from '../loops/seat-registry.js';
import {
  appendSeatSample, classifySeatHealth, DEFAULT_SEAT_SENTINEL_POLICY as POLICY,
  type SeatActivitySample, type SeatHealthSnapshot, type SeatUnackedMail,
} from './seat-sentinel.js';
import { collectSeatObservations, lastCompletionAt, screenFingerprint, screenStatus, type SeatObservation } from './seat-sentinel-collect.js';
import { runSeatSentinelTick, type SeatSentinelState } from './seat-sentinel-tick.js';

const NOW = new Date('2026-11-17T06:30:00Z');
const MS_PER_MINUTE = 60_000;
const ago = (minutes: number): number => NOW.getTime() - minutes * MS_PER_MINUTE;

/** One sample per minute from `minutes` ago until now, with a fingerprint per sample from `print`. */
function series(minutes: number, status: SeatActivitySample['status'], print: (index: number) => string | undefined): SeatActivitySample[] {
  return Array.from({ length: minutes + 1 }, (_, index) => {
    const fingerprint = print(index);
    return { at: ago(minutes - index), status, ...(fingerprint ? { fingerprint } : {}) };
  });
}

function snapshot(seat: string, patch: Partial<SeatHealthSnapshot> = {}): SeatHealthSnapshot {
  return {
    seat, host: 'mshq', route: 'herdr', statusSource: 'herdr:working',
    samples: [], openWork: { known: true, value: [] }, mail: { known: true, value: [] },
    ...patch,
  };
}

const opMail = (id: number, ageMinutes: number): SeatUnackedMail => ({ id, from: 'OP', createdAt: ago(ageMinutes) });

describe('classifySeatHealth — incident shapes', () => {
  test('ok: a running seat whose screen keeps changing is healthy', () => {
    const result = classifySeatHealth(snapshot('TC', {
      samples: series(POLICY.restartProposalMinutes, 'running', (index) => `screen-${index}`),
    }), NOW);
    expect(result.verdict).toBe('ok');
    expect(result.prescription).toBe('none');
    expect(result.findings).toEqual([]);
  });

  test('E·D: running with no token/screen change past the stall line → stalled · continue', () => {
    const minutes = POLICY.stallMinutes + Math.floor((POLICY.restartProposalMinutes - POLICY.stallMinutes) / 2);
    const result = classifySeatHealth(snapshot('HAND-TUI-E', {
      samples: series(minutes, 'running', () => 'frozen'),
    }), NOW);
    expect(result.verdict).toBe('stalled');
    expect(result.reason).toBe('no-progress');
    expect(result.prescription).toBe('continue');
    expect(result.evidence.unchangedMinutes).toBe(minutes);
  });

  test('E·D: an unchanged token counter counts even when the screen redraws', () => {
    const minutes = POLICY.stallMinutes;
    const samples = series(minutes, 'running', (index) => `redraw-${index}`).map((sample) => ({ ...sample, tokens: 7 }));
    const result = classifySeatHealth(snapshot('HAND-TUI-D', { samples }), NOW);
    expect(result.verdict).toBe('stalled');
    expect(result.prescription).toBe('continue');
  });

  test('MOB-1 shell: stalled past the restart line → restart-proposal (OP decides)', () => {
    const minutes = POLICY.restartProposalMinutes + POLICY.stallMinutes;
    const result = classifySeatHealth(snapshot('MOB-1', {
      samples: series(minutes, 'running', () => 'shell-hung'),
    }), NOW);
    expect(result.verdict).toBe('stalled');
    expect(result.prescription).toBe('restart-proposal');
    expect(result.evidence.unchangedMinutes).toBeGreaterThanOrEqual(POLICY.restartProposalMinutes);
  });

  test('below the stall line a frozen screen is not yet a finding', () => {
    const result = classifySeatHealth(snapshot('HAND-TUI-E', {
      samples: series(POLICY.stallMinutes - 1, 'running', () => 'frozen'),
    }), NOW);
    expect(result.verdict).toBe('ok');
  });

  test('RES: two unacked OP assignments past the SLA, no wake route → mail-missed · notify-op', () => {
    const mails = [opMail(101, POLICY.mailUnackedMinutes), opMail(102, POLICY.mailUnackedMinutes * 3)];
    const result = classifySeatHealth(snapshot('RES', {
      host: 'unknown', route: 'none', statusSource: 'no-route',
      samples: [{ at: NOW.getTime(), status: 'unknown' }],
      mail: { known: true, value: [...mails, { id: 103, from: 'TC', createdAt: ago(POLICY.mailUnackedMinutes * 3) }] },
    }), NOW);
    expect(result.verdict).toBe('mail-missed');
    expect(result.prescription).toBe('notify-op');
    expect(result.evidence.unackedAssignments?.map((row) => row.id)).toEqual(mails.map((mail) => mail.id));
  });

  test('a fresh assignment inside the SLA is not missed; an idle seat past it gets a wake', () => {
    const fresh = classifySeatHealth(snapshot('RES', { mail: { known: true, value: [opMail(201, POLICY.mailUnackedMinutes - 1)] },
      samples: [{ at: NOW.getTime(), status: 'idle' }] }), NOW);
    expect(fresh.verdict).toBe('ok');
    const late = classifySeatHealth(snapshot('JUD', { mail: { known: true, value: [opMail(202, POLICY.mailUnackedMinutes)] },
      samples: [{ at: NOW.getTime(), status: 'idle' }] }), NOW);
    expect(late.verdict).toBe('mail-missed');
    expect(late.prescription).toBe('wake');
  });

  test('D: declared «next step», ended the turn, idle with open work past the line → idling · wake', () => {
    const result = classifySeatHealth(snapshot('HAND-TUI-D', {
      samples: series(POLICY.idleWithWorkMinutes, 'idle', () => 'prompt'),
      openWork: { known: true, value: ['ELN-CONTINUE-AFTER-DECLARED-NEXT-STEP'] },
    }), NOW);
    expect(result.verdict).toBe('idling');
    expect(result.prescription).toBe('wake');
    expect(result.evidence.openWorkIds).toEqual(['ELN-CONTINUE-AFTER-DECLARED-NEXT-STEP']);
  });

  test('D on the first tick: the screen completion marker dates the idle streak', () => {
    const result = classifySeatHealth(snapshot('HAND-TUI-D', {
      samples: [{ at: NOW.getTime(), status: 'idle' }], lastOutputAt: ago(POLICY.idleWithWorkMinutes),
      openWork: { known: true, value: ['C1'] },
    }), NOW);
    expect(result.verdict).toBe('idling');
    expect(result.evidence.idleMinutes).toBe(POLICY.idleWithWorkMinutes);
  });

  test('ok: idle with nothing to do is rest, not a finding', () => {
    const result = classifySeatHealth(snapshot('UX', { samples: series(POLICY.restartProposalMinutes, 'idle', () => 'prompt') }), NOW);
    expect(result.verdict).toBe('ok');
  });

  test('stalled outranks mail-missed; both findings are kept', () => {
    const result = classifySeatHealth(snapshot('HAND-TUI-E', {
      samples: series(POLICY.stallMinutes, 'running', () => 'frozen'),
      mail: { known: true, value: [opMail(301, POLICY.mailUnackedMinutes)] },
    }), NOW);
    expect(result.verdict).toBe('stalled');
    expect(result.findings.map((row) => row.verdict)).toEqual(['stalled', 'mail-missed']);
    expect(result.findings[1]!.prescription).toBe('notify-op');
  });

  test('unknown sources stay typed unknown — never «ok» and never a fabricated finding', () => {
    const result = classifySeatHealth(snapshot('R-TICKET', {
      statusSource: 'herdr:pane-list-unavailable', samples: [{ at: NOW.getTime(), status: 'unknown' }],
      openWork: { known: false, reason: 'checklist-unavailable' }, mail: { known: false, reason: 'msg-ledger-absent' },
    }), NOW);
    expect(result.verdict).toBe('unknown');
    expect(result.prescription).toBe('none');
    expect(result.evidence.openWork).toBe('unknown');
    expect(result.evidence.unknown).toEqual(['openWork:checklist-unavailable', 'mail:msg-ledger-absent', 'status:herdr:pane-list-unavailable']);
  });

  test('a sample with no fingerprint is no evidence of «no change»', () => {
    const result = classifySeatHealth(snapshot('TC', { samples: series(POLICY.restartProposalMinutes, 'running', () => undefined) }), NOW);
    expect(result.verdict).toBe('ok');
  });

  test('appendSeatSample keeps only the retention window', () => {
    const old = { at: ago(POLICY.sampleRetentionMinutes + 1), status: 'idle' as const };
    const kept = { at: ago(POLICY.sampleRetentionMinutes), status: 'idle' as const };
    const next = appendSeatSample([old, kept], { at: NOW.getTime(), status: 'idle' });
    expect(next.map((row) => row.at)).toEqual([kept.at, NOW.getTime()]);
  });
});

describe('screen reading', () => {
  test('the fingerprint ignores spinner and elapsed-time churn but sees new output', () => {
    const body = 'line a\nline b';
    const first = screenFingerprint(`${body}\n• Working (3m 12s • esc to interrupt)`);
    const later = screenFingerprint(`${body}\n• Working (19m 40s • esc to interrupt)`);
    const moved = screenFingerprint(`${body}\nline c\n• Working (19m 40s • esc to interrupt)`);
    expect(later).toBe(first);
    expect(moved).not.toBe(first);
  });

  test('screen status: active markers → running, empty prompt → idle, else unknown', () => {
    expect(screenStatus('out\n• Working (1m 2s • esc to interrupt)')).toBe('running');
    expect(screenStatus('out\n› Ask Codex to do anything')).toBe('idle');
    expect(screenStatus('something else')).toBe('unknown');
  });

  test('completion marker → epoch, rolled back a day when it would be in the future', () => {
    const now = new Date(2026, 10, 17, 9, 30);
    expect(lastCompletionAt('─ Worked for 3m • 9:10 AM', now)).toBe(new Date(2026, 10, 17, 9, 10).getTime());
    expect(lastCompletionAt('─ Worked for 3m • 11:50 PM', now)).toBe(new Date(2026, 10, 16, 23, 50).getTime());
    expect(lastCompletionAt('no marker', now)).toBeUndefined();
  });
});

describe('collectSeatObservations — read-only sources, typed unknown', () => {
  const registry: SeatRegistryRead = { status: 'ready', registry: { version: 1, seats: [
    { address: 'TC', host: 'mshq', target: 'w8:p1', wake: 'herdr', replyBody: 'agent', optIn: true },
    { address: 'JUD-C', host: 'node-b', target: 'w5:p2Z', wake: 'herdr', replyBody: 'agent', optIn: true },
    { address: 'OP', host: 'local', target: 'w1:p2', wake: 'none', replyBody: 'agent', optIn: false },
  ] } };
  const calls: string[][] = [];
  const runner = (host: string): HerdrCliRunner => async (argv) => {
    calls.push([host, ...argv]);
    if (host === 'node-b') return { code: 255, stdout: '', stderr: 'ssh down' };
    if (argv[1] === 'list') return { code: 0, stderr: '', stdout: JSON.stringify({ result: { panes: [
      { pane_id: 'w8:p1', agent_status: 'working' }, { pane_id: 'w1:p2', agent_status: 'unknown' },
    ] } }) };
    return { code: 0, stderr: '', stdout: argv[2] === 'w1:p2' ? 'done\n› Ask Codex to do anything' : 'output\n• Working (2m 1s • esc to interrupt)' };
  };

  test('statuses, unknown hosts, mail-only seats; only list/read are ever called', async () => {
    calls.length = 0;
    const observations = await collectSeatObservations(NOW, {
      readRegistry: () => registry, herdrRunFor: runner,
      unreadAddresses: () => ['RES', 'TC', 'group:x'],
      unackedMail: (seat) => seat === 'RES' ? [opMail(11, POLICY.mailUnackedMinutes)] : [],
      openWork: (seat) => seat === 'OP' ? null : [],
    });
    const by = new Map(observations.map((row) => [row.seat, row]));
    expect([...by.keys()]).toEqual(['JUD-C', 'OP', 'RES', 'TC']);
    expect(by.get('TC')!.sample.status).toBe('running');
    expect(by.get('TC')!.sample.fingerprint).toBeDefined();
    expect(by.get('JUD-C')!.sample.status).toBe('unknown');
    expect(by.get('JUD-C')!.statusSource).toBe('herdr:pane-list-unavailable');
    expect(by.get('OP')!.sample.status).toBe('idle');
    expect(by.get('OP')!.optIn).toBe(false);
    expect(by.get('OP')!.openWork).toEqual({ known: false, reason: 'checklist-unavailable' });
    expect(by.get('RES')!.route).toBe('none');
    expect(by.get('RES')!.mail).toEqual({ known: true, value: [opMail(11, POLICY.mailUnackedMinutes)] });
    expect(calls.every((call) => call[2] === 'list' || call[2] === 'read')).toBe(true);
  });

  test('tmux seats: dead pane and capture are read-only', async () => {
    const tmuxCalls: string[][] = [];
    const observations = await collectSeatObservations(NOW, {
      readRegistry: () => ({ status: 'absent' }), unreadAddresses: () => null, unackedMail: () => null, openWork: () => [],
      tmuxSessions: { REL: 'seat-REL' },
      tmuxRun: (argv) => { tmuxCalls.push([...argv]); return { status: 0, stdout: argv[0] === 'display-message' ? '0' : 'x\n❯ ' }; },
    });
    expect(observations.map((row) => [row.seat, row.route, row.sample.status])).toEqual([['REL', 'tmux', 'idle']]);
    expect(observations[0]!.mail).toEqual({ known: false, reason: 'msg-ledger-absent' });
    expect(tmuxCalls.map((call) => call[0])).toEqual(['display-message', 'capture-pane']);
  });
});

describe('runSeatSentinelTick — shadow by default, graph-view supervision loop', () => {
  function harness(observe: (now: Date) => SeatObservation[], actuate?: boolean) {
    let clock = NOW;
    let state: SeatSentinelState | null = null;
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const prompts: Array<{ target: string; text: string }> = [];
    const tick = () => runSeatSentinelTick({
      now: () => clock, collect: async (now) => observe(now), ...(actuate === undefined ? {} : { actuate }),
      loadState: () => state, saveState: (next) => { state = next; },
      log: (category, event, data) => { logs.push({ category, event, data }); },
      herdrRunFor: () => async () => ({ code: 0, stdout: '', stderr: '' }),
      prompt: async (target, text) => { prompts.push({ target, text }); return { ok: true, accepted: true, reason: 'submitted' }; },
    });
    return { tick, logs, prompts, advance: (minutes: number) => { clock = new Date(clock.getTime() + minutes * MS_PER_MINUTE); } };
  }
  const observation = (seat: string, status: SeatActivitySample['status'], at: Date, patch: Partial<SeatObservation> = {}): SeatObservation => ({
    seat, host: 'mshq', route: 'herdr', target: `w:${seat}`, optIn: true, statusSource: 'test',
    sample: { at: at.getTime(), status, fingerprint: 'same' }, openWork: { known: true, value: [] }, mail: { known: true, value: [] }, ...patch,
  });

  test('the sample history across ticks turns a frozen running seat into a finding; shadow never types', async () => {
    const h = harness((now) => [
      observation('HAND-TUI-E', 'running', now),
      observation('HAND-TUI-D', 'idle', now, { openWork: { known: true, value: ['PLAN-1'] } }),
      observation('UX', 'idle', now),
    ]);
    const first = await h.tick();
    expect(first.actuate).toBe(false);
    expect(first.results.find((row) => row.seat === 'HAND-TUI-E')!.verdict).toBe('ok');
    h.advance(POLICY.stallMinutes);
    const later = await h.tick();
    const by = new Map(later.results.map((row) => [row.seat, row]));
    expect(by.get('HAND-TUI-E')!.verdict).toBe('stalled');
    expect(by.get('HAND-TUI-D')!.verdict).toBe('idling');
    expect(by.get('UX')!.verdict).toBe('ok');
    expect(h.prompts).toEqual([]);
    expect(later.actuations.every((row) => row.result === 'proposed' && row.reason === 'shadow')).toBe(true);

    const verdicts = h.logs.filter((row) => row.category === 'seat.sentinel' && row.event === 'verdict');
    expect(verdicts.length).toBe(first.results.length + later.results.length);
    expect(verdicts.at(-1)!.data).toMatchObject({ seat: later.results.at(-1)!.seat, mode: 'shadow' });

    const view = projectGraphLoopViews(later.graphEvents).get(`seat-sentinel:${later.at}`)!;
    expect(view.kind).toBe('seat_sentinel');
    expect(view.status).toBe('done');
    expect(view.stages.map((stage) => stage.id)).toEqual(['observe', 'judge', 'prescribe']);
    expect(view.workers.map((worker) => worker.id)).toEqual(later.results.map((row) => row.seat));
    expect(view.decisions.length).toBe(later.results.filter((row) => row.verdict !== 'ok').length);
    expect(view.decisions.every((decision) => decision.route === 'code' && decision.choice.endsWith('· shadow'))).toBe(true);
    expect(h.logs.filter((row) => row.category === 'graph.view').length).toBe(later.graphEvents.length + first.graphEvents.length);
  });

  test('actuate on: wake/continue go through the prompt gate once per cooldown; restart and notify stay with OP', async () => {
    const h = harness((now) => [
      observation('HAND-TUI-D', 'idle', now, { openWork: { known: true, value: ['PLAN-1'] }, lastOutputAt: now.getTime() - POLICY.idleWithWorkMinutes * MS_PER_MINUTE }),
      observation('RES', 'unknown', now, { route: 'none', host: 'unknown', optIn: false,
        mail: { known: true, value: [{ id: 9, from: 'OP', createdAt: now.getTime() - POLICY.mailUnackedMinutes * MS_PER_MINUTE }] } }),
      observation('MOB-1', 'running', now),
    ], true);
    await h.tick();
    h.advance(POLICY.restartProposalMinutes);
    const tick = await h.tick();
    const by = new Map(tick.actuations.map((row) => [row.seat, row]));
    expect(by.get('HAND-TUI-D')).toMatchObject({ prescription: 'wake', result: 'submitted' });
    expect(by.get('RES')).toMatchObject({ prescription: 'notify-op', result: 'proposed', reason: 'op-decides' });
    expect(by.get('MOB-1')).toMatchObject({ prescription: 'restart-proposal', result: 'proposed' });
    expect(h.prompts.map((row) => row.target)).toEqual(['w:HAND-TUI-D', 'w:HAND-TUI-D']);
    const view = projectGraphLoopViews(tick.graphEvents).get(`seat-sentinel:${tick.at}`)!;
    expect(view.checkpoints).toEqual([{ id: 'prescribe:op', status: 'waiting', actor: 'OP', summary: 'RES notify-op · MOB-1 restart-proposal' }]);

    h.advance(POLICY.actuateCooldownMinutes - 1);
    const cooled = await h.tick();
    expect(cooled.actuations.find((row) => row.seat === 'HAND-TUI-D')).toMatchObject({ result: 'skipped', reason: 'cooldown' });
    expect(h.prompts.length).toBe(2);
  });
});
