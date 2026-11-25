// DAILY-REGRESSION pack (CEO 11-24 12:5x «features must always be tested enough in the simulation world and the test
// world»): today's behaviour fixes replayed end to end with synthetic events, one scenario per fix. Each scenario owns a
// fresh universe (temp dirs only — never a real HQ path, host name or seat ledger) and drives the real code path:
// the real next-TUI process in a PTY (DR01–DR03), the real CLI process (DR04), the real stores and loops (DR05–DR07),
// the real els server socket (DR08). Only the model and the clock are faked. Expectations are literals, independent of
// the product's own constants; fixtures are the landed PRs' test fixtures where they exist.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SerializedMessage } from '../../../session/index.js';
import { createNextTuiPublicHistoryView } from '../../../tui/entry.js';
import { renderNextTuiLogFrame } from '../../../tui/core/render.js';
import { logViewLines } from '../../../tui/chat/log-view.js';
import { chatRowsOnScreen, createTranscriptVanishDetector, type TranscriptVanishEvent } from '../../../tui/core/transcript-vanish.js';
import { anchorStickyScroll } from '../../../tui/core/sticky-scroll.js';
import { createNoticeGate } from '../../../tui/chat/notice-gate.js';
import { formatNextTuiStatusLine } from '../../../tui/chat/status-line.js';
import { CapsuleActivity } from '../../../tui/chat/capsule-activity.js';
import { withCapsuleDone, type TranscriptMarker } from '../../../tui/chat/capsule-transcript.js';
import { simCli } from '../../in-process-cli.js';
import { buildActiveDirectivesSystemMessages, buildSeatMemoryIndexSystemMessages, resetSeatBootCacheForTest, resolveSessionMemoryStore } from '../../../seat/seat-boot-preamble.js';
import { applySeatMemoryTools } from '../../../seat-memory/seat-memory-tools.js';
import type { LLMToolSpec } from '../../../llm/tool-spec.js';
import { DirectiveIndex } from '../../../directives/directive-index.js';
import { decideTurnEnd, emptyStore, readStore, requirementStorePath, seedRequirements, type WaitState } from '../../../op-requirements/requirement-loop.js';
import { runRequirementTurnEnd } from '../../../op-requirements/turn-end.js';
import type { ChecklistItem } from '../../../release-loop/checklist.js';
import { parseMergeLog, renderGreenTriage, triageGreen } from '../../../release-loop/green-triage.js';
import type { ElsPty } from '../../../els/core.js';
import { elsSocketPath, startElsServer } from '../../../els/server.js';
import { requestEls } from '../../../els/client.js';
import { wireElsGraphProducer } from '../../../els/graph-producer.js';
import { onGraphNodeLifecycle, onGraphNodeProgress, onGraphRunIdleWake, runGraph } from '../../../graph-runner/runner.js';
import { createConnection } from 'node:net';
import { runSeatTui, settledUntil } from './seat-tui.js';
import { dr15 } from './dr15-invest-demo.js';
import { dr14 } from './dr14-els-wheel.js';
import { dr16 } from './dr16-autopilot.js';
import { dr17 } from './dr17-bulk-triage.js';
import { dr18 } from './dr18-docsearch.js';

export interface DailyRegressionContext {
  /** Fresh directory owned by this scenario run. */
  readonly universeRoot: string;
  /** Observation line for the receipt (kind + small structured data). */
  note(kind: string, data?: Readonly<Record<string, unknown>>): void;
}
export type DailyRegressionOutcome = { readonly ok: true } | { readonly ok: false; readonly diff: string };
export interface DailyRegressionScenario {
  readonly id: string;
  readonly title: string;
  /** The landed PR(s) whose behaviour this scenario holds. */
  readonly prs: readonly number[];
  run(ctx: DailyRegressionContext): Promise<DailyRegressionOutcome>;
}
/** A behaviour whose PR has not landed yet: printed as SKIP with the reason, never counted as PASS or FAIL. */
export interface DailyRegressionPending {
  readonly id: string;
  readonly title: string;
  readonly waitingFor: string;
}

/** Collects literal checks; the first failing check is the scenario's diff line. */
function checks() {
  const failures: string[] = [];
  const show = (value: unknown) => { const text = JSON.stringify(value); return text.length > 300 ? `${text.slice(0, 300)}…` : text; };
  return {
    eq(label: string, actual: unknown, expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${show(expected)} · observed ${show(actual)}`);
    },
    ok(label: string, condition: boolean, observed?: unknown) {
      if (!condition) failures.push(`${label}${observed === undefined ? '' : ` · observed ${show(observed)}`}`);
    },
    outcome(): DailyRegressionOutcome { return failures.length === 0 ? { ok: true } : { ok: false, diff: failures.join('\n') }; },
  };
}
const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const lastScreen = (frames: readonly { label: string; screen: string }[], label: string) => frames.find((frame) => frame.label === label)?.screen ?? '';
const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};
// Long mail: drawn in full it is taller than the 30-row screen and would push the answer above the viewport.
const longMail = (mark: string) => [`${mark} review request for PR #39911`,
  ...Array.from({ length: 40 }, (_, i) => `Please re-run the focused tests on the lane and post the receipt path, item ${i + 1}.`),
  `${mark}-TAIL last line of the mail`].join('\n');

// ── DR01 · #39934 answer stays visible when a seat-mail notice turn starts ─────────────────────────────────────
const DR01_ANSWER = 'DR01-ANSWER-MARK the handoff is done but the tab is not closed yet.';
const dr01: DailyRegressionScenario = {
  id: 'DR01', prs: [39934],
  title: 'answer stays visible when a seat-mail notice turn starts (real TUI + 7-mail digest frame)',
  async run(ctx) {
    const c = checks();
    // (a) frame level — the 7-mail digest of the 11-24 11:44 incident through the real view + render + vanish detector.
    const mail = (n: number) => `[from JUD-${n} · action]\nmsg:14098${n} · review request for PR #3991${n}\n`
      + `${'Please re-run the focused tests on the remote host and post the receipt path with the head sha. '.repeat(4)}`;
    const digest = `[seat-mail digest] 7 mails — 7 need action · 0 info (every mail below needs a reply)\n\n${[1, 2, 3, 4, 5, 6, 7].map(mail).join('\n\n')}`;
    const answered: SerializedMessage[] = [
      { role: 'user', content: 'Please check the JUD tabs and close the idle ones.', ts: '2026-11-24T02:42:42.543Z' },
      { role: 'assistant', content: DR01_ANSWER, ts: '2026-11-24T02:44:02.199Z', replyFinal: true },
    ];
    const frameOf = (displayed: readonly SerializedMessage[]) => renderNextTuiLogFrame({ messages: displayed, columns: 100, rows: 30,
      header: ['elanous'], footer: ['─'], promptLine: '› ', notices: [], activity: ['⠋ thinking'], scroll: 0, expandedToolIndexes: new Set<number>() });
    const events: TranscriptVanishEvent[] = [];
    const observe = createTranscriptVanishDetector((event) => events.push(event));
    const view = createNextTuiPublicHistoryView();
    const detector = (saved: readonly SerializedMessage[], displayed: readonly SerializedMessage[], body: readonly string[], busy: boolean) => {
      const { onScreen, evaluated } = chatRowsOnScreen({ saved, displayed, screenLines: body, tail: 8, renderRow: (row) => logViewLines([row], 100) });
      return { sessionId: 'dr01', saved, displayed, onScreen, evaluated, scroll: 0, userScrolled: false, busy, turnDoor: 'queue-notice', turnSource: 'seat-mail' };
    };
    const idle = view(answered, false);
    observe(detector(answered, idle, frameOf(idle).body, false));
    const saved = [...answered, { role: 'user', content: `[notice · seat-mail]\n\n${digest}`, ts: '2026-11-24T02:44:26.116Z' } as SerializedMessage];
    const busy = view(saved, true, Date.parse('2026-11-24T02:44:26.000Z'));
    const busyBody = frameOf(busy).body.map(plain);
    observe(detector(saved, busy, frameOf(busy).body, true));
    c.ok('frame: answer on screen after the digest notice row arrived', busyBody.some((line) => line.includes('DR01-ANSWER-MARK')));
    c.ok('frame: digest folded to its head (last mail not drawn)', !busyBody.some((line) => line.includes('msg:140987')));
    c.eq('frame: vanish detector events', events.map((event) => `${event.role}:${event.cause}`), []);
    // (b) real seat TUI — person turn → answer → a long seat mail lands at idle → notice turn runs → answer still on screen.
    let mailed = false;
    const run = await runSeatTui({
      base: ctx.universeRoot, seat: 'DRA', reply: DR01_ANSWER, rules: [{ when: 'DR01-MAIL', text: 'DR01-NOTICE-OK' }],
      steps: (u) => [
        { label: 'person turn', text: 'DR01-ASK please report', timeoutMs: 60_000,
          until: settledUntil((s) => s.includes('DR01-ANSWER-MARK') && u.requests().length >= 1, 1_500, () => {}) },
        { label: 'mail at idle', text: '', enter: false, timeoutMs: 5_000, until: () => { if (!mailed) { u.postMail(longMail('DR01-MAIL')); mailed = true; } return true; } },
        // 출처: seat-mail watcher poll 15s + notice turn + fake model round trip; 75s = 2 polls + margin on a loaded lane.
        { label: 'notice turn done', text: '', enter: false, timeoutMs: 75_000,
          until: settledUntil((s) => s.includes('DR01-NOTICE-OK'), 2_000) },
      ],
    });
    const screen = lastScreen(run.evidence.frames, 'notice turn done');
    ctx.note('dr01-notice-screen', { requests: run.universe.requests().length, answerOnScreen: screen.includes('DR01-ANSWER-MARK') });
    c.ok('tui: notice turn opened from the seat mail', run.universe.requests().some((row) => row.includes('DR01-MAIL')));
    c.ok('tui: previous answer still on screen after the notice turn', screen.includes('DR01-ANSWER-MARK'), screen.split('\n').slice(-12));
    c.ok('tui: mail tail not drawn in the chat', !screen.includes('DR01-MAIL-TAIL'));
    c.eq('tui: exit code', run.evidence.exitCode, 0);
    return c.outcome();
  },
};

// ── DR02 · #39933 sticky scroll survives a notice turn ─────────────────────────────────────────────────────────
const dr02: DailyRegressionScenario = {
  id: 'DR02', prs: [39933],
  title: 'scrolled-up position survives a seat-mail notice turn (real TUI PageUp → mail → same rows + «N new» hint → End)',
  async run(ctx) {
    const c = checks();
    // Frame rule (landed fixture): scrolled 20 up, a notice turn appends 5 rows → scroll 25, same top row.
    c.eq('frame: anchor after +5 rows', anchorStickyScroll(20, { historyRows: 100, layout: 'k', unseenRows: 0 }, 105, 'k'), { scroll: 25, unseenRows: 5, delta: 5 });
    const reply = Array.from({ length: 45 }, (_, i) => `SCROLL-LINE-${String(i).padStart(2, '0')}`).join('\n');
    let mailed = false;
    let parked = '';
    const run = await runSeatTui({
      base: ctx.universeRoot, seat: 'DRB', reply, rows: 24, cols: 110,
      rules: [{ when: 'DR02-MAIL', text: 'DR02-NOTICE-OK' }], env: { ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20' },
      steps: (u) => [
        { label: 'person turn', text: 'DR02-ASK scroll probe', timeoutMs: 60_000,
          until: settledUntil((s) => s.includes('SCROLL-LINE-44') && u.requests().length >= 1, 1_500) },
        { label: 'PageUp', keys: '\x1b[5~', timeoutMs: 10_000, until: (s) => s.includes('SCROLL-LINE-35') && !s.includes('SCROLL-LINE-44') },
        { label: 'mail while scrolled', text: '', enter: false, timeoutMs: 5_000, until: () => { if (!mailed) { u.postMail(longMail('DR02-MAIL')); mailed = true; } return true; } },
        // The notice turn ran (its request reached the model) and its turn end painted; the view must not have moved.
        { label: 'notice turn done', text: '', enter: false, timeoutMs: 75_000,
          until: settledUntil(() => u.requests().some((row) => row.includes('DR02-MAIL')), 4_000, (s) => { parked = s; }) },
        { label: 'End', keys: '\x1b[F', timeoutMs: 10_000, until: (s) => s.includes('DR02-NOTICE-OK') },
      ],
    });
    ctx.note('dr02-parked', { hint: parked.includes('End to jump'), line35: parked.includes('SCROLL-LINE-35') });
    c.ok('tui: scrolled rows kept through the notice turn (SCROLL-LINE-35 on screen)', parked.includes('SCROLL-LINE-35'), parked.split('\n').slice(-8));
    c.ok('tui: view not snapped to the bottom (no SCROLL-LINE-44 · no notice reply)', !parked.includes('SCROLL-LINE-44') && !parked.includes('DR02-NOTICE-OK'));
    c.ok('tui: «↓ N new · End to jump» hint shown', /↓ \d+ new · End to jump/u.test(parked), parked.split('\n').slice(-3));
    c.eq('tui: exit code', run.evidence.exitCode, 0);
    return c.outcome();
  },
};

// ── DR03 · #39936 #39935 quiet footer ──────────────────────────────────────────────────────────────────────────
const QUIET_FORBIDDEN = ['📌', 'auto-submitted', 'Resuming', 'Steer applied', 'Results ready'];
const dr03: DailyRegressionScenario = {
  id: 'DR03', prs: [39936, 39935],
  title: 'footer: no 📌 and no auto-submitted/Resuming/Steer applied/Results ready rows; 🤖 sub-agents grouped',
  async run(ctx) {
    const c = checks();
    // Notice gate on the CEO's 11-24 stack, three turns in a row (landed fixture).
    const stack = ['[notice · seat-mail] auto-submitted', '↻ Resuming (scheduled check)', 'Steer applied', '⟳ 재기동 필요 (새 판 ad567382bc41)',
      '🤖 연방 공보 근거 작성 발송 · ok · 80s', '✓ Results ready 22', '⏰ 예약 깨움 12:15: 착지 점검'];
    const gate = createNoticeGate(() => {});
    let shown: string[] = [];
    for (let turn = 0; turn < 3; turn += 1) for (const line of stack) { const admitted = gate.admit(line, shown); if (admitted !== null) shown = [...shown, admitted].slice(-3); }
    c.eq('gate: rows drawn after 3 turns', shown, ['⟳ 재기동 필요 (새 판 ad567382bc41)', '🤖 연방 공보 근거 작성 발송 · ok · 80s']);
    c.eq('gate: footer background row', gate.backgroundRow('⧗ Background 1 · ✓ Results ready 1'), '⧗ Background 1');
    // Status line with a pinned goal in the input: no pin, no goal text.
    const status = formatNextTuiStatusLine({ turnState: '응답 중', model: 'glm-5', queued: 2, steering: 0, backgroundTasks: 1, width: 80, pinnedGoal: '배포 가동까지 수습' } as Parameters<typeof formatNextTuiStatusLine>[0]);
    c.ok('status line: no 📌 and no goal text', !status.includes('📌') && !status.includes('배포 가동까지 수습'), status);
    // 🤖 grouping (#39935 → CAPSULE-FOOTER-ONCE #39950): the footer shows only running capsules in one live row; finished-ok
    // ones leave it and fold into one transcript row, a failure gets its own warning row.
    const activity = new CapsuleActivity('s1');
    let markers: TranscriptMarker[] = [];
    activity.accept({ type: 'capsule-progress', capsuleId: 'r1', sessionId: 's1', kind: 'agent', at: 1, line: 'Build · started' });
    activity.accept({ type: 'capsule-progress', capsuleId: 'r2', sessionId: 's1', kind: 'agent', at: 2, line: 'Ship · started' });
    c.eq('🤖 footer while two run', activity.runningLines(), ['🤖 2 running · Ship · started']);
    const done = (id: string, label: string, seconds: number, status: 'ok' | 'failed' = 'ok') => {
      const finished = activity.accept({ type: 'capsule-done', capsuleId: id, sessionId: 's1', kind: 'agent', startedAt: 0, endedAt: seconds * 1000, status, summary: `${label} · ${status} · ${seconds}s` });
      if (finished) markers = withCapsuleDone(markers, 3, finished);
    };
    done('a', '노랑 칸 병합 분류', 222); done('b', '착지 사슬 점검', 300); done('c', '리뷰 요약', 148); done('d', '발행 노트', 30, 'failed');
    done('r1', 'Build', 5); done('r2', 'Ship', 7);
    c.eq('🤖 transcript rows', markers.map((marker) => marker.text), ['🤖 3 done · 노랑 칸 병합 분류 +2 · 670s', '⚠ 🤖 발행 노트 · failed · 30s', '🤖 2 done · Build +1 · 12s']);
    c.eq('🤖 footer after all finished', activity.runningLines(), []);
    // Real seat TUI: person turn, then a seat-mail notice turn at idle; the screen carries none of the bookkeeping rows.
    let mailed = false;
    const run = await runSeatTui({
      base: ctx.universeRoot, seat: 'DRC', reply: 'DR03-HUMAN-OK', rules: [{ when: 'DR03-MAIL', text: 'DR03-NOTICE-OK' }],
      steps: (u) => [
        { label: 'person turn', text: '크론 5개 처리 완료', timeoutMs: 60_000, until: settledUntil((s) => s.includes('DR03-HUMAN-OK'), 1_500) },
        { label: 'mail at idle', text: '', enter: false, timeoutMs: 5_000, until: () => { if (!mailed) { u.postMail('DR03-MAIL please ack the lane receipt'); mailed = true; } return true; } },
        { label: 'notice turn done', text: '', enter: false, timeoutMs: 75_000, until: settledUntil((s) => s.includes('DR03-NOTICE-OK'), 2_000) },
      ],
    });
    for (const label of ['person turn', 'notice turn done']) {
      const screen = lastScreen(run.evidence.frames, label);
      const seen = QUIET_FORBIDDEN.filter((word) => screen.includes(word));
      c.eq(`tui ${label}: forbidden rows on screen`, seen, []);
    }
    c.eq('tui: exit code', run.evidence.exitCode, 0);
    return c.outcome();
  },
};

// ── DR04 · #39923 memory resolver ─────────────────────────────────────────────────────────────────────────────
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
const MEMORY_PATHS = [['memory', 'add'], ['memory', 'seat-index'], ['memory', 'list']] as const;
const dr04: DailyRegressionScenario = {
  id: 'DR04', prs: [39923],
  title: 'memory: ELANOUS_TRACK=OP add → seat session index; general git repo + 2 worktrees share one project store',
  async run(ctx) {
    const c = checks();
    const root = realpathSync(ctx.universeRoot);
    const cli = (args: string[], cwd: string, state: string, env: Record<string, string>) =>
      simCli(['memory', ...args], { mode: 'spawn', stateRoot: state, cwd, env, allowPaths: MEMORY_PATHS, timeoutMs: 60_000 });
    return withEnv({ ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR, ELANOUS_TRACK: undefined }, async () => {
      resetSeatBootCacheForTest();
      try {
        // ① seat: the real CLI process writes the seat store; the seat session-start index shows it.
        const state = join(root, 'seat-state-dir');
        const home = join(root, 'seat-home');
        const elsewhere = join(root, 'plain-dir');
        mkdirSync(elsewhere, { recursive: true });
        mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
        const seatCwd = join(home, 'elanous-hq', 'seats', 'OP');
        mkdirSync(seatCwd, { recursive: true });
        const add = await cli(['add', 'feedback', 'dr04-seat-proof', 'quickpass publish order stands'], elsewhere, state, { HOME: home, ELANOUS_TRACK: 'OP' });
        c.eq('seat: memory add rc', add.exitCode, 0);
        c.ok('seat: store file written', existsSync(join(state, 'elanous', 'memory', 'seats', 'OP', 'dr04-seat-proof.md')));
        const index = await cli(['seat-index', 'OP'], elsewhere, state, { HOME: home });
        c.ok('seat: seat-index lists it', index.stdout.includes('- [dr04-seat-proof](dr04-seat-proof.md) — quickpass publish order stands'), index.stdout + index.stderr);
        process.env.ELANOUS_STATE_DIR = state;
        const block = buildSeatMemoryIndexSystemMessages({ cwd: seatCwd }, { home, env: {} as NodeJS.ProcessEnv, msgPath: join(home, 'msg.db'), seatMemoryRoot: join(state, 'elanous', 'memory') });
        c.ok('seat: session-start index carries it', block.length === 1 && String(block[0]!.content).includes('- [dr04-seat-proof](dr04-seat-proof.md) — quickpass publish order stands'));
        // ② general user: clone + 2 worktrees, memory_save in A shows in B's session start; an unrelated repo does not.
        resetSeatBootCacheForTest();
        const gstate = join(root, 'general-state');
        const ghome = join(root, 'general-home');
        mkdirSync(ghome, { recursive: true });
        const origin = join(root, 'origin');
        mkdirSync(origin);
        git(origin, 'init', '-q');
        writeFileSync(join(origin, 'README.md'), 'x\n');
        git(origin, 'add', '.');
        git(origin, 'commit', '-q', '-m', 'init');
        const clone = join(root, 'app');
        git(root, 'clone', '-q', origin, clone);
        const wtA = join(root, 'app-wt-a');
        const wtB = join(root, 'app-wt-b');
        git(clone, 'worktree', 'add', '-q', '-b', 'a', wtA);
        git(clone, 'worktree', 'add', '-q', '-b', 'b', wtB);
        const other = join(root, 'other');
        mkdirSync(other);
        git(other, 'init', '-q');
        process.env.ELANOUS_STATE_DIR = gstate;
        // The in-process resolver reads the same root the CLI child wrote under (`--test` makes the parent's own root differ).
        const deps = { home: ghome, env: {} as NodeJS.ProcessEnv, msgPath: join(ghome, 'msg.db'), seatMemoryRoot: join(gstate, 'elanous', 'memory') };
        const target = resolveSessionMemoryStore(wtA, deps);
        c.eq('general: worktree A store kind', target?.store.kind, 'project');
        if (!target) return c.outcome();
        const specs: LLMToolSpec[] = [{ name: 'memory_save', description: 'global', parameters: { type: 'object', properties: {} } }];
        const dispatch = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
        applySeatMemoryTools(specs, dispatch, { seat: target.seat, dir: target.dir });
        const saved = await dispatch.get('memory_save')!({ name: 'deploy-uses-port-8080', description: 'deploy on port 8080', type: 'project', body: 'The app deploys on port 8080.' }) as Record<string, unknown>;
        c.eq('general: memory_save in A', { saved: saved.saved, action: saved.action }, { saved: true, action: 'created' });
        const inB = buildSeatMemoryIndexSystemMessages({ cwd: wtB }, deps).map((m) => String(m.content)).join('');
        c.ok('general: worktree B session start shows it', inB.includes('- [deploy-uses-port-8080](deploy-uses-port-8080.md) — deploy on port 8080'));
        resetSeatBootCacheForTest();
        c.ok('general: unrelated repo does not', !buildSeatMemoryIndexSystemMessages({ cwd: other }, deps).map((m) => String(m.content)).join('').includes('deploy-uses-port-8080'));
        const list = await cli(['list'], wtB, gstate, { HOME: ghome });
        c.ok('general: CLI in worktree B lists it', list.stdout.includes('deploy-uses-port-8080'), list.stdout + list.stderr);
        return c.outcome();
      } finally { resetSeatBootCacheForTest(); }
    });
  },
};

// ── DR05 · #39923 CEO directives block at session start ───────────────────────────────────────────────────────
const dr05: DailyRegressionScenario = {
  id: 'DR05', prs: [39923],
  title: 'Active CEO directives block present at OP session start, with the directive-reversal contract line',
  async run(ctx) {
    const c = checks();
    const root = ctx.universeRoot;
    const claudeRoot = join(root, 'claude', '-Users-me-elanous-hq-seats-OP');
    mkdirSync(claudeRoot, { recursive: true });
    const base = { cwd: '/Users/me/elanous-hq/seats/OP', sessionId: 's1', isSidechain: false };
    const rows = [
      { ...base, type: 'user', timestamp: '2026-11-24T01:00:00Z', message: { role: 'user', content: 'Ship 0.3.34 by quickpass now' } },
      { ...base, type: 'user', timestamp: '2026-11-24T01:05:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Keep the security relaxation, do not add barriers' }] } },
      { ...base, type: 'user', timestamp: '2026-11-24T01:11:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'tool output' }] } },
    ];
    writeFileSync(join(claudeRoot, 's1.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const dbPath = join(root, 'state', 'directives', 'directives.db');
    const index = new DirectiveIndex({ claudeRoot: join(root, 'claude'), codexRoot: join(root, 'codex'), grokRoot: join(root, 'grok'),
      surfaceDb: join(root, 'surface.db'), stateDir: join(root, 'state'), repoRoot: join(root, 'missing') });
    try { c.eq('index: synced user turns', index.sync().added, 2); } finally { index.close(); }
    const home = join(root, 'home');
    const seatCwd = join(home, 'elanous-hq', 'seats', 'OP');
    mkdirSync(seatCwd, { recursive: true });
    resetSeatBootCacheForTest();
    try {
      const block = buildActiveDirectivesSystemMessages({ cwd: seatCwd }, { home, env: {} as NodeJS.ProcessEnv, msgPath: join(home, 'msg.db'), seatMemoryRoot: join(root, 'memory'), directivesDbPath: dbPath });
      const lines = block.map((m) => String(m.content)).join('\n').split('\n');
      c.eq('session start: one directives message', block.length, 1);
      c.ok('session start: block header', lines.some((line) => line.startsWith('## Active CEO directives — OP')), lines.slice(0, 2));
      c.ok('session start: directive-reversal contract line', lines.includes('Before reversing or overriding a change that a CEO directive asked for, search directives (`eln directives search <words>`) and the ledger; if a directive covers it, do not reverse it — raise a decision card instead.'), lines.slice(0, 3));
      c.ok('session start: newest directive first', lines.indexOf('- [11-24 01:05Z] Keep the security relaxation, do not add barriers') >= 0
        && lines.indexOf('- [11-24 01:05Z] Keep the security relaxation, do not add barriers') < lines.indexOf('- [11-24 01:00Z] Ship 0.3.34 by quickpass now'));
      const other = join(home, 'elanous-hq', 'seats', 'TC');
      mkdirSync(other, { recursive: true });
      resetSeatBootCacheForTest();
      c.eq('session start: another seat gets no OP block', buildActiveDirectivesSystemMessages({ cwd: other }, { home, env: {} as NodeJS.ProcessEnv, msgPath: join(home, 'msg.db'), seatMemoryRoot: join(root, 'memory'), directivesDbPath: dbPath }).length, 0);
    } finally { resetSeatBootCacheForTest(); }
    return c.outcome();
  },
};

// ── DR06 · #39940 requirement ledger ──────────────────────────────────────────────────────────────────────────
const T0 = new Date('2026-11-24T00:00:00.000Z');
const plus = (min: number) => new Date(T0.getTime() + min * 60_000);
const overdueMail = (n: number) => ({ commitmentId: `c-${n}`, msgId: String(n), text: `Follow up on message #${n} to JUD-B`, status: 'open', peer: 'JUD-B',
  wait: { commitmentId: `c-${n}`, condition: `mail-reply:${n}`, deadlineAt: '2026-11-23T21:33:26.227Z' } });
const dr06: DailyRegressionScenario = {
  id: 'DR06', prs: [39940],
  title: 'requirement ledger: overdue wait escalates once then expires; re-injection ≤3 items with the CEO item first',
  async run(ctx) {
    const c = checks();
    const store = emptyStore();
    seedRequirements(store, { delegated: [overdueMail(101), overdueMail(102), overdueMail(103)] }, '2026-11-23T21:03:26.000Z');
    seedRequirements(store, { directives: [{ turnId: 'ceo-new', text: 'Make 0.3.35 green today' }] }, T0.toISOString());
    const decision = decideTurnEnd(store, { now: T0, waitState: () => 'expired' });
    c.eq('re-injection items (CEO first, ≤3)', decision.continuation?.items.map((item) => item.requirementId), ['ceo:ceo-new', 'req:msg:103', 'req:msg:102']);
    c.eq('re-injection head line', decision.continuation?.text.split('\n')[0], '[requirement-loop] 3 of 4 open requirements, newest CEO items first:');
    // Live loop over the real store file in this universe: escalate at T0, not again at +10, expired at +30.
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const seed = { p0Cells: [] as never[], delegated: [overdueMail(200)] };
    const turnEnd = (now: Date) => runRequirementTurnEnd({ seat: 'OP', humanTurn: null, now: () => now, stateRoot: () => ctx.universeRoot,
      startTurnIfIdle: () => ({ opened: true, turnId: 't' }), gather: async () => ({ seed, waitState: () => 'expired' as WaitState }),
      log: (_category, event, data) => logs.push({ event, data }) });
    const path = requirementStorePath(ctx.universeRoot, 'OP');
    await turnEnd(T0);
    c.eq('T0: escalated once', logs.filter((l) => l.event === 'escalated').map((l) => l.data.requirementIds), [['req:msg:200']]);
    c.eq('T0: still open', readStore(path).requirements[0]?.status, 'open');
    await turnEnd(plus(10));
    c.eq('+10m: not escalated again', logs.filter((l) => l.event === 'escalated').length, 1);
    await turnEnd(plus(30));
    c.eq('+30m: expired', readStore(path).requirements[0]?.status, 'expired');
    c.eq('+30m: expired log line', logs.filter((l) => l.event === 'expired').map((l) => l.data.line),
      ['⌛ EXPIRED req:msg:200 · wait mail-reply:200 overdue since 2026-11-23T21:33:26.227Z, escalated 2026-11-24T00:00:00.000Z, no close']);
    ctx.note('dr06-events', { events: logs.map((l) => l.event) });
    return c.outcome();
  },
};

// ── DR07 · #39939 green-triage ────────────────────────────────────────────────────────────────────────────────
const dr07: DailyRegressionScenario = {
  id: 'DR07', prs: [39939],
  title: 'green-triage buckets on a fixture checklist + fake merge log (judge / evidence / supply)',
  async run() {
    const c = checks();
    const [a, b, d] = ['a', 'b', 'c'].map((ch) => ch.repeat(40));
    const log = [`${a}\ttui: sticky scrollback (TUI-STICKY) (#39933)`, `${b}\tfeat: ledger fix (#39905)`, `${d}\tdocs: mentions (#11111) in the middle only`, 'not-a-sha\tbroken (#39000)'].join('\n');
    const cell = (id: string, evidence: string, status: ChecklistItem['status'] = 'yellow'): ChecklistItem =>
      ({ id, title: id, status, evidence, owner: 'TC', updatedAt: '2026-11-24T00:00:00Z', updatedBy: 'OP' });
    const items = [
      cell('JUDGE-BY-EVIDENCE', '#39933 f6feaa55f3b7 착지(merged) · receipt evidence/PREGATE-GREEN/39933-0123456789ab-lane1/receipt.json'),
      cell('JUDGE-BY-LANE', 'PR #39905 merged · 실측 영수증 따로'),
      cell('EVIDENCE-ONLY', '#39933 착지(merged) · 실측 영수증 따로'),
      cell('SUPPLY-OPEN-PR', '진행: PR #39999 · head 53e9139fc002'),
      cell('SUPPLY-NO-PR', ''),
      cell('ALREADY-GREEN', '#39933 receipt.json', 'green'),
    ];
    const result = triageGreen('0.3.35', items, { merged: parseMergeLog(log), greenLanes: ['39905-fedcba987654-lane1'] });
    c.eq('counts', result.counts, { judge: 2, evidence: 1, supply: 2 });
    c.eq('judge rows', result.rows.judge.map((row) => row.id), ['JUDGE-BY-EVIDENCE', 'JUDGE-BY-LANE']);
    c.eq('evidence rows', result.rows.evidence.map((row) => [row.id, row.mergedPrs]), [['EVIDENCE-ONLY', [39933]]]);
    c.eq('supply rows', result.rows.supply.map((row) => [row.id, row.reason]), [['SUPPLY-OPEN-PR', 'no merged PR (cited #39999)'], ['SUPPLY-NO-PR', 'no PR in evidence']]);
    c.eq('rendered head', renderGreenTriage(result).split('\n')[0], '0.3.35 green-triage · judge 2 · evidence 1 · supply 2');
    return c.outcome();
  },
};

// ── DR08 · #39938 OP closes a seat tab without a person; the OP tab is refused ────────────────────────────────
const dr08: DailyRegressionScenario = {
  id: 'DR08', prs: [39938],
  title: 'els server: OP closes a non-OP tab unconfirmed (els.close logged); the OP tab itself is refused',
  async run(ctx) {
    const c = checks();
    // Unix socket paths are length-limited: the server root is a short temp dir, removed after the run.
    const root = mkdtempSync(join(tmpdir(), 'dr08-els-'));
    const killed: string[] = [];
    let n = 0;
    const started = await startElsServer({ stateRoot: root, spawn: (_command, _cwd, title): ElsPty => {
      const id = `pty_${n++}`;
      return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => { killed.push(String(title)); } };
    } });
    if ('exitCode' in started) { rmSync(root, { recursive: true, force: true }); return { ok: false, diff: `els server did not start: ${started.message}` }; }
    const ask = (request: object, authLine?: object): Promise<{ exitCode: number; message: string }> => new Promise((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root));
      let data = '';
      socket.on('connect', () => { if (authLine) socket.write(`${JSON.stringify(authLine)}\n`); socket.write(`${JSON.stringify(request)}\n`); });
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('end', () => resolve(JSON.parse(data.split('\n').filter(Boolean).pop()!) as { exitCode: number; message: string }));
      socket.on('error', reject);
    });
    try {
      const owner = { op: 'auth', token: readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim() };
      const seatTab = JSON.parse((await ask({ op: 'new', ws: 'W', cwd: '/w', command: ['sh'], title: 'JUD-A' })).message) as { pane: string };
      c.eq('seat-set OP', (await ask({ op: 'seat-set', seat: 'OP' }, owner)).exitCode, 0);
      const opTab = JSON.parse((await ask({ op: 'new', ws: 'W', cwd: '/w', command: ['sh'], title: 'OP' }, owner)).message) as { pane: string };
      const listed = JSON.parse((await ask({ op: 'ls' })).message) as { panes: Array<{ pane: string; tab: string }> };
      const tabOf = (pane: string) => listed.panes.find((row) => row.pane === pane)!.tab;
      const closed = await ask({ op: 'close-tab', tab: tabOf(seatTab.pane) }, owner);
      c.eq('close JUD-A tab without confirm: exit', [closed.exitCode, killed], [0, ['JUD-A']]);
      const audit = readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row) as Record<string, unknown>);
      const line = audit.find((row) => row.event === 'els.close');
      c.eq('els.close audit line', line && { principal: line.principal, label: line.label, panes: line.panes, confirmed: line.confirmed },
        { principal: 'els-pane:server-owner(OP)', label: 'JUD-A', panes: 1, confirmed: false });
      const refused = await ask({ op: 'close-tab', tab: tabOf(opTab.pane) }, owner);
      c.eq('close OP tab without confirm: refused', [refused.exitCode, refused.message], [1, "els: close-tab denied — the OP tab itself is closed only with a person's confirmation"]);
      c.eq('OP tab still alive', killed, ['JUD-A']);
    } finally {
      await started.close();
      rmSync(root, { recursive: true, force: true });
    }
    return c.outcome();
  },
};

// ── DR11 · graph run → els tab with the graph-view widget (release-shaped graph, side effects mocked) ───────────
/** cut → gate → publish: every node is an in-process mock that sleeps and succeeds or fails as scripted. */
function dr11Graph(graphId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dr11-g-'));
  writeFileSync(join(root, 'recipes.yaml'), 'noop:\n  command: "exit 0"\n');
  writeFileSync(join(root, 'graph.yaml'), `graph_id: ${graphId}\nversion: 1\nentry_node: cut\nterminal_nodes: [done, failed]\nnodes:
  - { node_id: cut, kind: agent, recipe: handler:cut, max_visits: 1 }
  - { node_id: gate, kind: agent, recipe: handler:gate, max_visits: 1 }
  - { node_id: publish, kind: agent, recipe: handler:publish, max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: cut, on: outcome, map: { ok: gate, fail: failed } }
  - { from: gate, on: outcome, map: { ok: publish, fail: failed } }
  - { from: publish, on: outcome, map: { ok: done, fail: failed } }
`);
  return root;
}
const dr11: DailyRegressionScenario = {
  id: 'DR11', prs: [],
  title: 'graph run → els tab shows the graph-view widget (spinner moves, ✓ marks), good run closes, failed run stays ✗',
  async run(ctx) {
    const c = checks();
    const root = mkdtempSync(join(tmpdir(), 'dr11-els-'));
    const started = await startElsServer({ stateRoot: root, spawn: (): ElsPty => { throw new Error('no pty'); },
      childTabs: { tabAfterMs: 1_200, closeDelayMs: 1_500, tickMs: 250 } });
    if ('exitCode' in started) { rmSync(root, { recursive: true, force: true }); return { ok: false, diff: `els server did not start: ${started.message}` }; }
    const socket = elsSocketPath(root);
    const producer = wireElsGraphProducer({ ws: 'OP', socketPath: socket, request: requestEls,
      sources: { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake } });
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const step = (ok: boolean) => async () => { await sleep(1_100); return ok ? { ok: true, outcome: 'ok' } : { ok: false, outcome: 'fail' }; };
    const run = (graphId: string, publishOk: boolean) => runGraph(join(dr11Graph(graphId), 'graph.yaml'), { runId: `${graphId}-0001`, deps: { root: ctx.universeRoot,
      inProcessHandlers: { cut: step(true), gate: step(true), publish: step(publishOk) } } } as never);
    const panes = async () => (JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: Array<{ pane: string; title: string }> }).panes;
    const frameOf = async (match: string): Promise<{ title: string; text: string } | undefined> => {
      const pane = (await panes()).find((row) => row.title.includes(match));
      return pane ? { title: pane.title, text: (await requestEls(socket, { op: 'read', pane: pane.pane })).message } : undefined;
    };
    try {
      const good = run('rel-good', true);
      const bad = run('rel-bad', false);
      const frames: string[] = [];
      const shortLived = await frameOf('rel-good');
      c.ok('no tab before the run is long-lived', shortLived === undefined, shortLived);
      const deadline = Date.now() + 8_000;
      const spinners = new Set<string>();
      let sawRunning = false;
      while (Date.now() < deadline && spinners.size < 2) {
        await sleep(200);
        const f = await frameOf('rel-good');
        if (!f) continue;
        const head = f.text.split('\n').find((line) => line.includes('Running graph')) ?? '';
        if (head) { sawRunning = true; spinners.add(head[0]!); if (frames.length < 2) frames.push(f.text); }
      }
      c.ok('tab opened with the widget head «<spinner> Running graph(...)»', sawRunning, frames[0]);
      c.ok('spinner glyph changes between frames', spinners.size >= 2, [...spinners]);
      c.ok('mid frame carries a running node «◐»', frames.some((f) => f.includes('◐')), frames[0]);
      await Promise.all([good, bad]);
      await producer.idle();
      await sleep(400);
      const goodEnd = await frameOf('rel-good');
      c.ok('end frame (good): «✓ Finished graph» and ✓ marks for cut/gate/publish', !!goodEnd && goodEnd.text.includes('Finished graph') && ['cut', 'gate', 'publish'].every((n) => new RegExp(`✓ ${n}`).test(goodEnd.text)), goodEnd?.text);
      const badEnd = await frameOf('rel-bad');
      c.ok('end frame (bad): «✗ Failed graph» and ✗ publish', !!badEnd && badEnd.text.includes('Failed graph') && badEnd.text.includes('✗ publish'), badEnd?.text);
      ctx.note('dr11-frames', { mid: frames[0] ?? '', end: goodEnd?.text ?? '', failed: badEnd?.text ?? '' });
      await sleep(2_200);
      c.ok('good run tab closed 1.5 s after success', (await frameOf('rel-good')) === undefined);
      c.ok('failed run tab stays', (await frameOf('rel-bad')) !== undefined);
    } finally {
      producer.dispose();
      await started.close();
      rmSync(root, { recursive: true, force: true });
    }
    return c.outcome();
  },
};

// ── DR12 · 12-way fan-out graph in a maximized els tab = the dashboard ───────────────────────────────────────────
const dr12: DailyRegressionScenario = {
  id: 'DR12', prs: [],
  title: 'els server: a 12-panelist fan-out graph in a large tab draws 12 cards, a consensus gauge, a moving spinner; a small pane keeps the compact widget',
  async run(ctx) {
    const c = checks();
    const root = mkdtempSync(join(tmpdir(), 'dr12-els-'));
    let size = { cols: 130, rows: 40 };
    const started = await startElsServer({ stateRoot: root, spawn: (): ElsPty => { throw new Error('no pty'); },
      childTabs: { tabAfterMs: 100, closeDelayMs: 60_000, tickMs: 120, paneSize: () => size, colorMode: 'none' } });
    if ('exitCode' in started) { rmSync(root, { recursive: true, force: true }); return { ok: false, diff: `els server did not start: ${started.message}` }; }
    const socket = elsSocketPath(root);
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const child = (body: object) => requestEls(socket, { op: 'child', ws: 'OP', ...body } as never);
    const read = async (): Promise<string> => {
      const panes = (JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: Array<{ pane: string; title: string }> }).panes;
      const pane = panes.find((row) => row.title.includes('stock-panel'));
      return pane ? (await requestEls(socket, { op: 'read', pane: pane.pane })).message : '';
    };
    try {
      await child({ action: 'start', id: 'g', source: 'graph', label: 'stock-panel' });
      await child({ action: 'start', id: 'n0', source: 'graph-node', parent: 'g', label: 'ground' });
      await child({ action: 'end', id: 'n0', ok: true, summary: 'ok' });
      for (let i = 1; i <= 12; i++) {
        await child({ action: 'start', id: `n${i}`, source: 'graph-node', parent: 'g', label: `panel-${i}` });
        await child({ action: 'progress', id: `n${i}`, line: `model=${i % 2 ? 'glm-5' : 'gpt-6-sol'} · drafting` });
      }
      await sleep(300);
      const first = await read();
      c.ok('12 cards: panel-1 … panel-12 on screen', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((i) => first.includes(`panel-${i}`)), first.split('\n').slice(0, 4));
      c.ok('header: ✓1 ●12 ✕0 and the model mix', first.includes('✓1 ●12 ✕0') && first.includes('glm-5×6 gpt-6-sol×6'), first.split('\n')[0]);
      c.ok('side strip: EVENTS + NODES DONE / TIME', first.includes('EVENTS') && first.includes('NODES DONE / TIME'));
      await sleep(350);
      c.ok('spinner moved between reads', (await read()) !== first);
      for (let i = 1; i <= 6; i++) await child({ action: 'end', id: `n${i}`, ok: i !== 2, summary: i === 2 ? 'timeout 30s' : 'ok' });
      await child({ action: 'start', id: 'nj', source: 'graph-node', parent: 'g', label: 'consensus' });
      await sleep(300);
      const mid = await read();
      c.ok('failed card shows ✕ + reason, header ✕1', mid.includes('✕ timeout 30s') && mid.includes('✕1'));
      c.ok('consensus gauge 5/12 with ✕1', /█+░* 5\/12 ✕1/u.test(mid), mid.split('\n').slice(-6));
      ctx.note('dr12-frame', { mid });
      size = { cols: 100, rows: 30 };
      await sleep(300);
      const small = await read();
      c.ok('100x30 pane: compact widget («Running graph»), no EVENTS strip', small.includes('Running graph') && !small.includes('EVENTS'), small.split('\n').slice(0, 3));
    } finally {
      await started.close();
      rmSync(root, { recursive: true, force: true });
    }
    return c.outcome();
  },
};

export const dailyRegressionScenarios: readonly DailyRegressionScenario[] = [dr01, dr02, dr03, dr04, dr05, dr06, dr07, dr08, dr11, dr12, dr14, dr15, dr16, dr17, dr18];

/** Behaviours whose PR is not on main yet. When one lands, its scenario replaces the row here (same id). */
export const dailyRegressionPending: readonly DailyRegressionPending[] = [
  { id: 'DR01b', title: 'per-mail ✉ one-line rows in the notice turn', waitingFor: '#39941 not merged' },
  { id: 'DR09', title: 'baton auto on restart: TC first, never both down, 3 mails during the gap not lost', waitingFor: '#39942 not merged' },
  { id: 'DR10', title: 'mail held while work is in progress + peek + person input joins after the tool batch', waitingFor: 'queue PR #39946 (QUEUE-FINISH-FIRST) still draft' },
];
