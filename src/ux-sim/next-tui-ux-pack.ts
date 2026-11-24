// NEXT-TUI-UX-SIM-PACK (대표 11-17): one command runs scripted fake-LLM turns through the real Next TUI in a
// real PTY + headless terminal (mock-seat-pty-sequence) and judges the rendered frames. Real model calls: 0.
// Devices reused from the Nexus device ledger: fake-llm (scripted tool calls/answers), mock seat PTY
// sequence (real PTY + xterm screen per step). This module only adds scenarios and judges.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockSeatPtySequence, type SeatPtyStep } from './mock-seat-pty-sequence.js';
import { NEXT_TUI_ROUTE_REGISTRY } from '../tui/core/registry.js';
import { projectGraphLoopViews, type GraphViewEvent } from '../graph-view/model.js';
import { PASTE_FOLD_MIN_LINES } from '../chat/paste-fold.js';
import { USER_TURN_BAND_SGR } from '../tui/chat/log-view.js';
import { GRAPH_VIEW_COLORS, GRAPH_VIEW_COMPACT_ROWS, GRAPH_VIEW_FULL_MIN_COLUMNS, GRAPH_VIEW_INLINE_LANES_MAX, graphViewColorViolations, renderGraphViewCompact, renderGraphViewFull, renderGraphViewInline, renderGraphViewLine } from '../graph-view/render.js';
import { APP_BUILD_SIM_DONE_EVENTS, APP_BUILD_SIM_EVENTS, GRAPH_VIEW_SIM_DONE_NOW, GRAPH_VIEW_SIM_NOW, HARNESS_SIM_CHILD_PTY, HARNESS_SIM_DONE_EVENTS, HARNESS_SIM_EVENTS, RELEASE_SIM_EVENTS } from '../graph-view/sim-scripts.js';
import { graphViewDetailIndex, graphViewDetailNodes, graphViewDetailWidth, renderGraphViewDetail } from '../graph-view/detail.js';

export interface UxPackJudge {
  readonly id: string;
  /** What a pass means, shown in the summary table. */
  readonly expect: string;
  readonly check: (screen: string, context: { readonly cols: number; readonly frames: readonly string[]; readonly ansiFrames?: readonly string[];
    /** PTY scenarios: every byte the TUI wrote, so a judge can read colors the screen text drops. */
    readonly raw?: string }) => boolean;
}

export interface UxPackScenario {
  readonly id: string;
  readonly description: string;
  /** Files written into the isolated root before boot (relative path → content). */
  readonly files?: Readonly<Record<string, string>>;
  readonly env?: (root: string) => Record<string, string>;
  readonly steps: (root: string) => PackStep[];
  /** Render-only scenario: frames come from a renderer fed with scripted events, not from a PTY. */
  readonly render?: (cols: number, rows: number) => { readonly label: string; readonly plain: string; readonly ansi: string }[];
  readonly judges: readonly UxPackJudge[];
}

const lines = (screen: string) => screen.split('\n');
/** Last row index matching `test` (Array#findLastIndex is outside this repo's TS lib target). */
const lastIndex = (rows: readonly string[], test: (row: string) => boolean): number => {
  for (let index = rows.length - 1; index >= 0; index -= 1) if (test(rows[index]!)) return index;
  return -1;
};
// The status line shortens «Queue 1» to «Q1» on narrow terminals. A waiting steer shows as «Steer 1 · Queue 0» / «S1·Q0»,
// or, where the footer has room only for the turn status, «1 steer pending · joins at next tool boundary».
const QUEUED = /\bQ(?:ueue )?[1-9]\b|대기 [1-9]|\bSteer [1-9]\b|\bS[1-9]·Q\d+\b|\b[1-9] steers? pending\b/;
/** The progress row: braille spinner, verb, elapsed and the interrupt hint (a narrow width may cut after the hint). */
const WORKING_ROW = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (?:Thinking|Responding|Working|Running [^\n(]+(?:\([^)\n]*\))?) \(\d+s • esc to interrupt\)/u;
const idle = (screen: string) => /Turn idle|턴 대기|응답 완료|Turn done/.test(screen);
const settledWith = (marker: string) => (screen: string) => screen.includes(marker) && /Worked for|Stopped after/.test(screen);
/** A tool activity row starts (after an optional fixed label or status glyph) with the tool name. */
const TOOL_ROW = /^\s*(?:활동 · |[✓✔✗•·▸⏺●○]\s*)?(?:Read|Bash)\b/;

// Scripted tool burst: the requirement names ten Reads with a Bash mixed in.
const BURST_READS = Array.from({ length: 10 }, (_, index) => `burst-${String(index).padStart(2, '0')}.txt`);
const BURST_CALLS = [
  ...BURST_READS.slice(0, 5).map((file) => ({ name: 'Read', args: { file_path: `{root}/${file}` } })),
  { name: 'Bash', args: { command: "printf '%s\\n' UXPACK-BASH-OUT" } },
  ...BURST_READS.slice(5).map((file) => ({ name: 'Read', args: { file_path: `{root}/${file}` } })),
];
// IMPL-TASK-QUEUE-1117 «burst-revise»: five sends, the third corrects the first target (ELN-FOO → ELN-BAR).
const BURST_REVISE_SENDS = ['UXPACK-B1 ELN-FOO 칸에 시험도 추가', 'UXPACK-B2 PR 본문 정리', 'UXPACK-B3 아까 ELN-FOO 대신 ELN-BAR 로 해줘',
  'UXPACK-B4 끝나면 알려 줘', 'UXPACK-B5 마지막 확인'];
// 출처: src/ux-sim/mock-seat-pty-sequence.ts chunks — a short human-like gap between sends.
const BURST_GAP_MS = 150;
// graph-live snapshots: the app_build loop mid-ARG (inside «arch») and at its last event, and the release run.
const cutAt = (events: readonly GraphViewEvent[], until: number) => events.filter((event) => event.at <= until);
const ARCH_ROUND_TWO_RUNNING = Date.parse('2026-11-17T00:00:32Z');
const GRAPH_LIVE_SNAPSHOTS = [
  { label: 'app_build arch', events: cutAt(APP_BUILD_SIM_EVENTS, ARCH_ROUND_TWO_RUNNING), loopId: 'ab1', nowMs: ARCH_ROUND_TWO_RUNNING },
  { label: 'app_build final', events: APP_BUILD_SIM_EVENTS, loopId: 'ab1', nowMs: GRAPH_VIEW_SIM_NOW },
  { label: 'release final', events: RELEASE_SIM_EVENTS, loopId: 'rel1', nowMs: GRAPH_VIEW_SIM_NOW },
  { label: 'app_build done', events: APP_BUILD_SIM_DONE_EVENTS, loopId: 'ab1', nowMs: GRAPH_VIEW_SIM_DONE_NOW },
  { label: 'harness running', events: HARNESS_SIM_EVENTS, loopId: 'h1', nowMs: GRAPH_VIEW_SIM_NOW },
  { label: 'harness done', events: HARNESS_SIM_DONE_EVENTS, loopId: 'h1', nowMs: GRAPH_VIEW_SIM_DONE_NOW },
] as const;
const GRAPH_LIVE_FINAL = ['app_build final', 'release final'] as const;
/** Frames per snapshot (개정 4: the inline block is the default and comes first): inline, full, compact, line. */
const GRAPH_LIVE_KINDS = ['inline', 'full', 'compact', 'line'] as const;
const GRAPH_LIVE_FRAMES = GRAPH_LIVE_KINDS.length;
/** 개정 5 detail frames after the snapshot frames: a selected graph node, a selected harness child, that child's PTY. */
const GRAPH_LIVE_DETAIL = ['graph-node', 'harness-child', 'child-pty'] as const;
const detailIndex = (name: typeof GRAPH_LIVE_DETAIL[number]) => GRAPH_LIVE_SNAPSHOTS.length * GRAPH_LIVE_FRAMES + GRAPH_LIVE_DETAIL.indexOf(name);
function graphLiveDetailFrames(cols: number, rows: number): { label: string; plain: string; ansi: string }[] {
  // The detail opens beside the chat when it fits, else it covers the screen (graphViewDetailWidth = 0).
  const width = graphViewDetailWidth(cols) || cols;
  const app = projectGraphLoopViews(APP_BUILD_SIM_EVENTS);
  const appViews = [...app.values()];
  const harness = projectGraphLoopViews(HARNESS_SIM_EVENTS);
  const harnessViews = [...harness.values()];
  const parent = harness.get('h1')!;
  const notice = graphViewDetailIndex(parent, harnessViews, 'child-notice')!;
  const child = harness.get(graphViewDetailNodes(parent, harnessViews)[notice]!.childLoopId!)!;
  const frames: Record<typeof GRAPH_LIVE_DETAIL[number], string[]> = {
    'graph-node': renderGraphViewDetail(app.get('ab1')!, width, rows, { nowMs: GRAPH_VIEW_SIM_NOW, views: appViews,
      selected: graphViewDetailIndex(app.get('ab1')!, appViews, 'arch')! }),
    'harness-child': renderGraphViewDetail(parent, width, rows, { nowMs: GRAPH_VIEW_SIM_NOW, views: harnessViews, selected: notice }),
    'child-pty': renderGraphViewDetail(child, width, rows, { nowMs: GRAPH_VIEW_SIM_NOW, views: harnessViews, ptyScreen: HARNESS_SIM_CHILD_PTY }),
  };
  return GRAPH_LIVE_DETAIL.map((name) => ({ label: `detail ${name}-${width}`, plain: frames[name].join('\n'), ansi: frames[name].join('\n') }));
}
const frameIndex = (label: string, kind: typeof GRAPH_LIVE_KINDS[number]) =>
  GRAPH_LIVE_SNAPSHOTS.findIndex((snapshot) => snapshot.label === label) * GRAPH_LIVE_FRAMES + GRAPH_LIVE_KINDS.indexOf(kind);
const LONG_BULLET = 'UXPACK-LONG-BULLET-START ' + '긴 불릿 문장이 화면 폭을 넘어 다음 줄로 감깁니다 '.repeat(4) + 'UXPACK-LONG-BULLET-END';
const MARKDOWN_ANSWER = [
  '## UXPACK-HEADING', '', `- ${LONG_BULLET}`, '- 짧은 불릿', '', '1. 첫째 항목', '2. 둘째 항목', '',
  '```ts', 'const uxpack = 1;', '```', '', 'UXPACK-MD-DONE',
].join('\n');
// Read-only slash commands from the product registry; destructive or session-changing ones are excluded.
const SLASH_EXCLUDED = new Set(['/quit', '/exit', '/new', '/clear', '/side', '/sidetab', '/harness', '/loop', '/mission', '/app', '/now']);
export const UX_PACK_SLASH_COMMANDS: readonly string[] = [...new Set(NEXT_TUI_ROUTE_REGISTRY.flatMap((route) => route.slash))]
  .filter((slash) => !slash.includes(' ') && !SLASH_EXCLUDED.has(slash));

/** Classic has no «Worked for» line; its turn ends when the scripted answer marker shows. */
type PackStep = SeatPtyStep & { readonly classicUntil?: (screen: string) => boolean };
const turn = (label: string, text: string, marker: string): PackStep => ({ label, text, until: settledWith(marker),
  classicUntil: (screen) => screen.includes(marker) });
// Typed text then a separate Enter (an Esc right before Enter would read as Alt+Enter); the picker runs the typed command.
const slashStep = (command: string): SeatPtyStep => ({ label: command, text: command,
  // Done when the live prompt (the last «❯» row; transcript echoes may also start with «❯») no longer holds it.
  until: (screen) => { const rows = lines(screen); return !(rows[lastIndex(rows, (row) => row.trimStart().startsWith('❯'))] ?? '').includes(command); } });

// ── self-proactive (내부 문서 `ELN-SELF-PROACTIVE` · seat-state/OP/RETHINK-TURN-OUTCOME-STRUCTURED-1117.md) ──
// Four turn ends, scripted, in one isolated session: does the harness open the next action by itself?
//   ① more-work: a plan item is left (a declared next step)   → an automatic next turn
//   ② waiting:   the model sets a waker (ScheduleWakeup)       → it fires and the work resumes
//   ③ blocked:   a person is needed (approval)                 → the person is told why
//   ④ done:      nothing is left                               → the seat picks its next work
// Today the verdict runs on the sentence paths (#38049 · #38067); after DECISION-GATE v2 the same scenario re-judges
// the structured state. Korean and English instructions must give the same table.
const SELF_PROACTIVE_COPY = {
  ko: {
    plan: 'SP1 계획 세 단계를 진행해줘', pledge: '1단계를 마쳤습니다. 다음 스텝은 2단계 구현입니다.', continued: '이어서 2단계를 진행했습니다.',
    wait: 'SP2 리뷰 결과를 기다렸다가 반영해줘', waiting: '리뷰 결과를 기다립니다. 깨우개를 걸어 두었습니다.', resumed: '리뷰 결과를 확인하고 반영했습니다.',
    block: 'SP3 운영에 배포해줘', blocked: '운영 배포는 사람의 승인이 필요합니다.',
    finish: 'SP4 마무리해줘', done: '모든 항목을 완료했습니다. 남은 일은 없습니다.',
  },
  en: {
    plan: 'SP1 work through the three-step plan', pledge: 'Step 1 is done. The next step is implementing step 2.', continued: 'Carried on with step 2.',
    wait: 'SP2 wait for the review result and apply it', waiting: 'Waiting for the review result. A waker is set.', resumed: 'Checked the review result and applied it.',
    block: 'SP3 deploy to production', blocked: 'Deploying to production needs a human approval.',
    finish: 'SP4 wrap it up', done: 'All items are done. No remaining work.',
  },
} as const;
// 출처: the fast wakeup clock fires a 60-second waker after about 2 s (schedule-wakeup.ts); the other cases get the same
// window to show whether the harness acts on its own.
const SELF_PROACTIVE_OBSERVE_MS = 15_000;
/** Wrapped rows break a sentence across lines: compare with whitespace removed. */
const squeeze = (text: string) => text.replace(/\s+/gu, '');
const seen = (screen: string, text: string) => squeeze(screen).includes(squeeze(text));
/** The text after the last place `text` shows (whitespace removed), or '' when it never showed. */
const afterSeen = (screen: string, text: string) => {
  const flat = squeeze(screen);
  const at = flat.lastIndexOf(squeeze(text));
  return at < 0 ? '' : flat.slice(at + squeeze(text).length);
};
const turnSeen = (label: string, text: string, marker: string): PackStep => ({ label, text,
  until: (screen) => seen(screen, marker) && /Worked for|Stopped after/.test(screen) });
/** Hold until `done` shows, or the observation window passes (then the judge records what did not happen). */
const observe = (label: string, done: (screen: string) => boolean): PackStep => {
  let started = 0;
  return { label, keys: '', until: (screen) => {
    started ||= Date.now();
    return done(screen) || Date.now() - started > SELF_PROACTIVE_OBSERVE_MS;
  }, timeoutMs: SELF_PROACTIVE_OBSERVE_MS * 2 };
};
/** Frames: 0 plan · 1 after-plan · 2 wait · 3 after-wait · 4 block · 5 after-block · 6 finish · 7 after-finish. */
const SELF_PROACTIVE_FRAME = { afterPlan: 1, afterWait: 3, afterBlock: 5, afterFinish: 7 } as const;
// Matched on whitespace-free text (see squeeze).
const HUMAN_NOTICE_FLAT = /사람확인필요|사람승인필요|needs(?:a|your)?(?:person|human|you)|HITL|blocked:/iu;
// The TUI's own continue/resume lines (src/tui/chat/continue-banner.ts), matched on whitespace-free text.
const CONTINUED_FLAT = /↻Continuing/u;
const SCHEDULED_RESUME_FLAT = /↻Resuming\(scheduledcheck\)/u;
const SELF_PULL_FLAT = /집음:|자동재개\((?:self-pull|seat-pull)\)|pickedup:|유휴·다음확인|idle·nextcheck/iu;

function selfProactiveScenario(lang: keyof typeof SELF_PROACTIVE_COPY): UxPackScenario {
  const copy = SELF_PROACTIVE_COPY[lang];
  return {
    id: `self-proactive-${lang}`,
    description: `Self-proactive turn ends (${lang}): more-work → continue · waiting → waker resumes · blocked → person told · done → self-pull.`,
    env: () => ({
      ELANOUS_TEST_FAST_WAKEUP_CLOCK: '1',
      ELANOUS_TEST_FAKE_LLM_RESPONSE: copy.done,
      ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: JSON.stringify([
        { when: '[골 이어가기]', text: copy.continued },
        { when: '[예약 깨움', text: copy.resumed },
        { when: 'SP1', text: copy.pledge },
        { when: 'SP2', text: copy.waiting },
        { when: 'SP3', text: copy.blocked },
        { when: 'SP4', text: copy.done },
      ]),
      ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'SP2', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: 'SPWAKE review' } }),
    }),
    steps: () => [
      turnSeen('plan', copy.plan, copy.pledge),
      observe('after plan', (screen) => seen(screen, copy.continued)),
      turnSeen('wait', copy.wait, copy.waiting),
      observe('after wait', (screen) => seen(screen, copy.resumed)),
      turnSeen('block', copy.block, copy.blocked),
      observe('after block', (screen) => HUMAN_NOTICE_FLAT.test(afterSeen(screen, copy.blocked))),
      turnSeen('finish', copy.finish, copy.done),
      observe('after finish', (screen) => SELF_PULL_FLAT.test(afterSeen(screen, copy.done))),
    ],
    judges: [
      { id: 'more-work-continues', expect: '① a declared next step opens an automatic next turn («↻ Continuing (next step)») that runs it',
        check: (_screen, { frames }) => CONTINUED_FLAT.test(afterSeen(frames[SELF_PROACTIVE_FRAME.afterPlan] ?? '', copy.pledge))
          && seen(frames[SELF_PROACTIVE_FRAME.afterPlan] ?? '', copy.continued) },
      // TUI-NOTICE-QUIET (대표 11-24): the resume banner is bookkeeping (logged, not drawn) — the resumed answer is the surface.
      { id: 'waiting-waker-resumes', expect: '② the waker the model set fires and the work resumes (its answer shows; no «↻ Resuming» row)',
        check: (_screen, { frames }) => !SCHEDULED_RESUME_FLAT.test(squeeze(frames[SELF_PROACTIVE_FRAME.afterWait] ?? ''))
          && seen(frames[SELF_PROACTIVE_FRAME.afterWait] ?? '', copy.resumed) },
      { id: 'waiting-not-taken-as-more-work', expect: '② waiting is not mistaken for more-work: no goal-continue turn between the wait and its waker',
        check: (_screen, { frames }) => {
          const frame = frames[SELF_PROACTIVE_FRAME.afterWait] ?? '';
          return seen(frame, copy.waiting) && !CONTINUED_FLAT.test(afterSeen(frame, copy.waiting));
        } },
      { id: 'blocked-tells-person', expect: '③ a blocked turn surfaces why a person is needed (notice or mail), without an automatic turn',
        check: (_screen, { frames }) => {
          // Look only after the model's own sentence: the notice must come from the harness, not the reply text.
          const rest = afterSeen(frames[SELF_PROACTIVE_FRAME.afterBlock] ?? '', copy.blocked);
          return HUMAN_NOTICE_FLAT.test(rest) && !CONTINUED_FLAT.test(rest);
        } },
      { id: 'done-self-pulls', expect: '④ with nothing left the seat picks its next work (or sets an idle waker), not a silent stop',
        check: (_screen, { frames }) => {
          return SELF_PULL_FLAT.test(afterSeen(frames[SELF_PROACTIVE_FRAME.afterFinish] ?? '', copy.done));
        } },
    ],
  };
}

export const UX_PACK_SCENARIOS: readonly UxPackScenario[] = [
  {
    id: 'tool-burst',
    description: 'Ten scripted Reads with a Bash in the middle, then a short answer.',
    files: Object.fromEntries(BURST_READS.map((file) => [file, `${file} body\n`])),
    env: (root) => ({
      ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify([{ when: 'UXPACK-BURST',
        calls: BURST_CALLS.map((call) => ({ ...call, args: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, String(value).replace('{root}', root)])) })) }]),
      ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-BURST-DONE',
    }),
    steps: () => [turn('burst settled', 'UXPACK-BURST', 'UXPACK-BURST-DONE')],
    judges: [
      { id: 'tool-rows-folded', expect: `fewer visible tool rows than the ${BURST_CALLS.length} scripted calls (a fold summarizes the rest)`,
        check: (screen) => {
          // Visible but fewer than the calls: rows exist (not hidden) and runs are folded.
          const rows = lines(screen).filter((line) => TOOL_ROW.test(line)).length;
          return rows > 0 && rows < BURST_CALLS.length;
        } },
      { id: 'no-korean-activity-label', expect: 'no «활동 ·» fixed label', check: (screen) => !screen.includes('활동 ·') },
    ],
  },
  {
    id: 'markdown-blocks',
    description: 'Heading, a bullet longer than the width, a short bullet, a numbered list and a code block.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: MARKDOWN_ANSWER }),
    steps: () => [turn('markdown settled', 'UXPACK-MD', 'UXPACK-MD-DONE')],
    judges: [
      { id: 'bullet-hanging-indent', expect: 'a wrapped bullet continues indented, without a new bullet marker',
        check: (screen) => {
          const rows = lines(screen);
          const start = rows.findIndex((row) => row.includes('UXPACK-LONG-BULLET-START'));
          const next = rows[start + 1] ?? '';
          return start >= 0 && !next.includes('UXPACK-LONG-BULLET-START') && /^\s+\S/.test(next) && !/^\s*[-•*]\s/.test(next)
            && next.search(/\S/) > rows[start]!.search(/\S/);
        } },
      { id: 'heading-without-hashes', expect: 'heading text shown without «##»', check: (screen) => screen.includes('UXPACK-HEADING') && !screen.includes('## UXPACK-HEADING') },
      { id: 'code-fence-hidden', expect: 'no raw ``` fence lines', check: (screen) => !lines(screen).some((row) => row.trim().startsWith('```')) },
      { id: 'numbered-list-kept', expect: 'numbered items keep their numbers', check: (screen) => screen.includes('1. 첫째 항목') && screen.includes('2. 둘째 항목') },
    ],
  },
  {
    id: 'speaker-labels',
    description: 'One plain question and answer.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-SPEAKER-DONE' }),
    steps: () => [turn('speaker settled', 'UXPACK-SPEAKER', 'UXPACK-SPEAKER-DONE')],
    judges: [
      { id: 'no-korean-speaker-labels', expect: 'no «나:» / «엘라누스:» line prefixes',
        check: (screen) => !lines(screen).some((row) => /^\s*(나|엘라누스):/.test(row)) },
    ],
  },
  {
    id: 'input-history',
    description: 'Two prompts (one a slash command), then ↑/↓ in the composer: older prompts, the draft restored, line moves first in a multi-line draft.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-HIST-DONE' }),
    steps: () => {
      const prompt = (screen: string) => { const rows = lines(screen); return rows[lastIndex(rows, (row) => row.trimStart().startsWith('❯'))] ?? ''; };
      return [
        turn('first prompt', 'UXPACK-HIST first', 'UXPACK-HIST-DONE'),
        slashStep('/tasks'),
        { label: 'draft typed', text: 'my draft', enter: false, until: (screen) => prompt(screen).includes('my draft') },
        { label: 'up 1 = slash command', keys: '\x1b[A', until: (screen) => prompt(screen).includes('/tasks') },
        { label: 'up 2 = first prompt', keys: '\x1b[A', until: (screen) => prompt(screen).includes('UXPACK-HIST first') },
        { label: 'down 1', keys: '\x1b[B', until: (screen) => prompt(screen).includes('/tasks') },
        { label: 'down 2 = draft back', keys: '\x1b[B', until: (screen) => prompt(screen).includes('my draft') },
        // Alt+Enter inserts a newline; ↑ on the second line moves to the first line instead of recalling history.
        { label: 'two-line draft', keys: '\x1b\rsecond', until: (screen) => screen.includes('second') },
        { label: 'up inside draft', keys: '\x1b[A', until: (screen) => screen.includes('second') && screen.includes('my draft') },
      ];
    },
    judges: [
      { id: 'history-walks-back', expect: '↑ shows the slash command, then the earlier prompt', check: (_screen, { frames }) => {
        const promptRow = (frame: string) => { const rows = lines(frame); return rows[lastIndex(rows, (row) => row.trimStart().startsWith('❯'))] ?? ''; };
        return promptRow(frames[3] ?? '').includes('/tasks') && promptRow(frames[4] ?? '').includes('UXPACK-HIST first');
      } },
      { id: 'draft-restored', expect: '↓ past the newest prompt brings the typed draft back', check: (_screen, { frames }) => {
        const rows = lines(frames[6] ?? '');
        return (rows[lastIndex(rows, (row) => row.trimStart().startsWith('❯'))] ?? '').includes('my draft');
      } },
      { id: 'multi-line-moves-first', expect: '↑ inside a two-line draft keeps the draft (a line move, not history)',
        check: (screen) => screen.includes('second') && screen.includes('my draft') && !lines(screen).slice(-4).some((row) => row.includes('UXPACK-HIST first')) },
    ],
  },
  {
    id: 'user-turn-color',
    description: 'One question and answer: the person\'s turn is a steel-blue band with a bold «>», the answer is not.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-BAND-DONE' }),
    steps: () => [turn('band settled', 'UXPACK-BAND question', 'UXPACK-BAND-DONE')],
    judges: [
      { id: 'user-row-banded', expect: 'the user row is painted «48;5;24;97» with a bold «>» and padded to the row end',
        check: (_screen, { raw }) => new RegExp(`\\x1b\\[${USER_TURN_BAND_SGR}m\\x1b\\[1m>\\x1b\\[22m UXPACK-BAND question +\\x1b\\[0m`).test(raw ?? '') },
      { id: 'answer-not-banded', expect: 'the answer row carries no band',
        check: (_screen, { raw }) => !new RegExp(`\\x1b\\[${USER_TURN_BAND_SGR}m[^\\x1b]*UXPACK-BAND-DONE`).test(raw ?? '') && (raw ?? '').includes('UXPACK-BAND-DONE') },
      { id: 'band-color-not-graph-meaning', expect: 'the band is outside the graph view color meanings',
        check: () => !Object.values(GRAPH_VIEW_COLORS).some((code) => USER_TURN_BAND_SGR.split(';').includes(code)) },
    ],
  },
  {
    id: 'user-turn-no-color',
    description: 'The same turn under NO_COLOR: «> » and the indent only, no band.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-NOBAND-DONE', NO_COLOR: '1' }),
    steps: () => [turn('no-color settled', 'UXPACK-NOBAND question', 'UXPACK-NOBAND-DONE')],
    judges: [
      { id: 'prompt-mark-only', expect: 'the user row reads «> UXPACK-NOBAND question» with no band escape',
        check: (screen, { raw }) => lines(screen).some((row) => row.startsWith('> UXPACK-NOBAND question')) && !(raw ?? '').includes(`\x1b[${USER_TURN_BAND_SGR}m`) },
    ],
  },
  {
    id: 'paste-atomic',
    description: 'A folded multi-line paste in the composer: one Backspace removes the whole token; ← steps over it.',
    steps: () => {
      const prompt = (screen: string) => { const rows = lines(screen); return rows[lastIndex(rows, (row) => row.trimStart().startsWith('❯'))] ?? ''; };
      // Bracketed paste of PASTE_FOLD_MIN_LINES lines, so the composer folds it into one token.
      const pasted = `\x1b[200~${Array.from({ length: PASTE_FOLD_MIN_LINES }, (_, index) => `pasted ${index + 1}`).join('\n')}\x1b[201~`;
      return [
        { label: 'prefix', text: 'see ', enter: false, until: (screen) => prompt(screen).includes('see') },
        { label: 'pasted', keys: pasted, until: (screen) => /\[Paste #\d+ · /.test(prompt(screen)) },
        { label: 'one backspace', keys: '\x7f', until: (screen) => !/\[Paste #/.test(prompt(screen)) },
        { label: 'pasted again', keys: pasted, until: (screen) => /\[Paste #\d+ · /.test(prompt(screen)) },
        { label: 'left over token', keys: '\x1b[D', until: () => true },
        { label: 'typed before token', text: 'X', enter: false, until: (screen) => prompt(screen).replace(/\s+/g, '').includes('seeX[Paste#') },
      ];
    },
    judges: [
      { id: 'backspace-removes-whole-token', expect: 'one Backspace after the token leaves «see» with no part of the token',
        check: (_screen, { frames }) => { const rows = lines(frames[2] ?? ''); const row = rows[lastIndex(rows, (line) => line.trimStart().startsWith('❯'))] ?? '';
          return row.includes('see') && !row.includes('Paste') && !row.includes('full text'); } },
      { id: 'left-steps-over-token', expect: '← after the token puts the cursor before it, so typed text lands in front',
        check: (screen) => lines(screen).some((row) => row.replace(/\s+/g, '').includes('seeX[Paste#')) },
    ],
  },
  selfProactiveScenario('ko'),
  selfProactiveScenario('en'),
  {
    id: 'worked-for',
    description: 'A finished turn, then a delayed turn stopped with Esc.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-WORKED-DONE', ELANOUS_TEST_FAKE_LLM_DELAY_MS: '6000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'UXPACK-SLOW' }),
    steps: () => [
      turn('finished', 'UXPACK-WORKED', 'UXPACK-WORKED-DONE'),
      { label: 'slow started', text: 'UXPACK-SLOW stop me', until: (screen) => /Turn running|응답 중/.test(screen) },
      { label: 'stopped', keys: '\x1b', until: (screen) => /Stopped after|취소/.test(screen) },
    ],
    judges: [
      { id: 'worked-for-once', expect: 'the finished turn shows its «Worked for» line once (not again in the status line)',
        check: (_screen, { frames }) => lines(frames[0] ?? '').filter((row) => row.includes('Worked for')).length === 1 },
      { id: 'stopped-marker', expect: 'a stopped turn ends with a «Stopped after» line', check: (screen) => screen.includes('Stopped after') },
    ],
  },
  {
    id: 'provider-picker',
    description: '/provider opens the picker above the composer.',
    steps: () => [{ ...slashStep('/provider'), label: 'picker', until: (screen) => /Provider ·/.test(screen) }],
    judges: [
      { id: 'picker-above-prompt', expect: 'the Provider panel sits above the prompt row',
        check: (screen) => {
          const rows = lines(screen);
          const panel = rows.findIndex((row) => /Provider ·/.test(row));
          const prompt = lastIndex(rows, (row) => row.trimStart().startsWith('❯'));
          return panel >= 0 && prompt > panel;
        } },
      { id: 'list-not-in-transcript', expect: 'no «현재:» provider list printed into the chat', check: (screen) => !lines(screen).some((row) => row.trimStart().startsWith('현재:')) },
    ],
  },
  {
    id: 'slash-sweep',
    description: 'Every read-only registry slash command once.',
    steps: () => UX_PACK_SLASH_COMMANDS.map(slashStep),
    judges: [
      { id: 'no-slash-guide-residue', expect: 'no «Slash commands» guide left in the status line after a command',
        check: (_screen, { frames }) => frames.every((frame) => !frame.includes('Slash commands')) },
    ],
  },
  {
    id: 'long-turn-steer',
    description: 'Type and send while a delayed turn runs.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-STEER-DONE', ELANOUS_TEST_FAKE_LLM_DELAY_MS: '6000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'UXPACK-SLOW' }),
    steps: () => [
      { label: 'slow started', text: 'UXPACK-SLOW steer', until: (screen) => !idle(screen) },
      { label: 'queued', text: 'UXPACK-STEER-FOLLOWUP', until: (screen) => QUEUED.test(screen) },
    ],
    judges: [
      { id: 'queued-input-visible', expect: 'a message sent during a turn shows as queued', check: (screen) => QUEUED.test(screen) },
    ],
  },
  {
    id: 'burst-revise',
    description: 'IMPL-TASK-QUEUE-1117 completion scenario: five sends during a slow turn (one corrects an earlier one), then Esc.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-REVISE-DONE', ELANOUS_TEST_FAKE_LLM_DELAY_MS: '6000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'UXPACK-SLOW' }),
    steps: () => [
      { label: 'slow started', text: 'UXPACK-SLOW ELN-FOO 칸 진행해 줘', until: (screen) => /Turn running|응답 중/.test(screen) },
      { label: 'burst queued', chunks: BURST_REVISE_SENDS.flatMap((send) => [send, '\r']), gapMs: BURST_GAP_MS,
        until: (screen) => QUEUED.test(screen) },
      // Esc settles either way: today the drafts return to the composer; the contract submits them as next turns.
      { label: 'esc', keys: '\x1b', until: (screen) => /Stopped after/.test(screen) && !/Turn running|응답 중/.test(screen)
        && (!QUEUED.test(screen) || /drafts restored|입력칸으로/.test(screen)) },
      { label: 'after esc', keys: '', until: (screen) => !/Turn running|응답 중/.test(screen) && !QUEUED.test(screen) },
    ],
    judges: [
      { id: 'supersede-hint-shown', expect: 'the correcting send marks the earlier item «대체 후보» while it waits',
        check: (_screen, { frames }) => frames.some((frame) => frame.includes('대체 후보')) },
      { id: 'notice-after-user', expect: 'a child-completion notice waits behind the user sends (needs ELN-CHILD-NOTICE-INTO-QUEUE)',
        check: (_screen, { frames }) => frames.some((frame) => {
          const rows = lines(frame);
          const notice = rows.findIndex((row) => row.includes('알림'));
          const lastUser = lastIndex(rows, (row) => BURST_REVISE_SENDS.some((send) => row.includes(send.split(' ')[0]!)));
          return notice >= 0 && notice > lastUser;
        }) },
      { id: 'esc-resubmits-queued', expect: 'after Esc every queued send leaves as its own next turn and the queue empties',
        check: (screen) => {
          // Restored drafts sit in the composer (from the last «❯» row down); submitted turns are above it.
          const rows = lines(screen);
          const composer = lastIndex(rows, (row) => row.trimStart().startsWith('❯'));
          const above = rows.slice(0, Math.max(0, composer)).join('\n');
          const below = rows.slice(Math.max(0, composer)).join('\n');
          return BURST_REVISE_SENDS.every((send) => above.includes(send.split(' ')[0]!) && !below.includes(send.split(' ')[0]!))
            && !QUEUED.test(screen);
        } },
    ],
  },
  {
    id: 'working-row',
    description: 'NEXT-TUI-WORKING-ROW: a delayed turn (waiting for the model), then a turn with a tool call; the progress row shows while it runs and is gone once it settled.',
    files: { 'working-row.txt': 'working-row body\n' },
    env: (root) => ({
      ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-WROW-DONE', ELANOUS_TEST_FAKE_LLM_DELAY_MS: '6000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'UXPACK-WROW-SLOW',
      ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify([{ when: 'UXPACK-WROW-TOOL', calls: [{ name: 'Read', args: { file_path: `${root}/working-row.txt` } }] }]),
    }),
    steps: () => [
      { label: 'thinking', text: 'UXPACK-WROW-SLOW', until: (screen) => WORKING_ROW.test(screen) },
      { label: 'thinking settled', keys: '', until: settledWith('UXPACK-WROW-DONE') },
      { label: 'tool turn', text: 'UXPACK-WROW-TOOL', until: (screen) => (screen.match(/Worked for/g) ?? []).length >= 2 },
    ],
    judges: [
      { id: 'row-while-running', expect: 'a «<spinner> Thinking|Responding|Running|Working (Ns • esc to interrupt)» row shows while the turn runs',
        check: (_screen, { frames }) => frames.some((frame) => WORKING_ROW.test(frame)) },
      { id: 'row-above-prompt', expect: 'the row sits below the user line and above the prompt',
        check: (_screen, { frames }) => frames.some((frame) => {
          const rows = lines(frame);
          const row = rows.findIndex((candidate) => WORKING_ROW.test(candidate));
          const user = rows.findIndex((candidate) => candidate.includes('UXPACK-WROW-SLOW'));
          const prompt = lastIndex(rows, (candidate) => candidate.trimStart().startsWith('❯'));
          return row >= 0 && user >= 0 && user < row && row < prompt;
        }) },
      { id: 'row-gone-after-turn', expect: 'once settled there is no progress row and «Worked for» remains',
        check: (screen) => !screen.includes('esc to interrupt') && screen.includes('Worked for') },
      { id: 'row-fits-width', expect: 'no frame row wider than the terminal',
        check: (_screen, { cols, frames }) => frames.every((frame) => lines(frame).every((row) => Bun.stringWidth(row) <= cols)) },
    ],
  },
  {
    id: 'graph-live',
    description: 'GRAPH-LOOP-VIEW renderer on fake app_build and release event scripts: 3 lanes with a retried failure, a 2-round ARG inside a node, a waiting checkpoint.',
    steps: () => [],
    render: (cols, rows) => [...GRAPH_LIVE_SNAPSHOTS.flatMap(({ label, events, loopId, nowMs }) => {
      const views = projectGraphLoopViews(events);
      const view = views.get(loopId)!;
      // The sidetab has its own width; below the full minimum the compact rows are what a person sees.
      const fullCols = Math.max(cols, GRAPH_VIEW_FULL_MIN_COLUMNS);
      const options = { nowMs, views: [...views.values()] };
      const frame = (name: string, lines: (color: boolean) => string[]) =>
        ({ label: `${label} ${name}`, plain: lines(false).join('\n'), ansi: lines(true).join('\n') });
      return [
        frame(`inline-${cols}`, (color) => renderGraphViewInline(view, cols, { ...options, color })),
        frame(`full-${fullCols}`, (color) => renderGraphViewFull(view, fullCols, rows, { ...options, color })),
        frame(`compact-${cols}`, (color) => renderGraphViewCompact(view, cols, { ...options, color })),
        frame('line', () => [renderGraphViewLine(view, options)]),
      ];
    }), ...graphLiveDetailFrames(cols, rows)],
    judges: [
      { id: 'edge-marks', expect: 'the edge line carries ⫴3 (lanes), ↻2 (ARG rounds) and ◆ (waiting checkpoint)',
        check: (_screen, { frames }) => GRAPH_LIVE_FINAL.every((label) => {
          const full = frames[frameIndex(label, 'full')] ?? '';
          return full.includes('⫴3') && full.includes('◆');
        }) && (frames[frameIndex('app_build final', 'full')] ?? '').includes('↻2') },
      { id: 'lanes-branch-join', expect: 'the current node shows its lanes as ┌─ ├─ └─ and «↓ join → next»',
        check: (_screen, { frames }) => GRAPH_LIVE_FINAL.every((label) => /┌─ /.test(frames[frameIndex(label, 'full')] ?? '')
          && /└─ /.test(frames[frameIndex(label, 'full')] ?? '') && (frames[frameIndex(label, 'full')] ?? '').includes('↓ join →')) },
      { id: 'failed-lane-retry', expect: 'a failed-then-retried lane shows «(retry 1)»',
        check: (_screen, { frames }) => GRAPH_LIVE_FINAL.every((label) => (frames[frameIndex(label, 'full')] ?? '').includes('(retry 1)')) },
      { id: 'inner-loop-last-round', expect: 'while the ARG runs, the node shows only its last round as an indented mini edge (depth 1)',
        check: (_screen, { frames }) => {
          const mid = (frames[frameIndex('app_build arch', 'full')] ?? '').split('\n');
          return mid.some((row) => /↻2 {2}✓ draft/.test(row)) && !mid.some((row) => /↻1 {2}/.test(row));
        } },
      { id: 'compact-rows', expect: 'compact view is the working line plus the edge line',
        check: (_screen, { frames }) => frames.slice(0, GRAPH_LIVE_SNAPSHOTS.length * GRAPH_LIVE_FRAMES).filter((_, index) => index % GRAPH_LIVE_FRAMES === GRAPH_LIVE_KINDS.indexOf('compact')).every((frame) => frame.split('\n').length === GRAPH_VIEW_COMPACT_ROWS) },
      { id: 'no-overflow', expect: 'no rendered row wider than its view',
        check: (_screen, { frames, cols }) => frames.every((frame, index) => frame.split('\n').every((row) =>
          Bun.stringWidth(row) <= (index % GRAPH_LIVE_FRAMES === GRAPH_LIVE_KINDS.indexOf('full') ? Math.max(cols, GRAPH_VIEW_FULL_MIN_COLUMNS) : cols))) },
      { id: 'inline-block-default', expect: '개정 4: a running loop is an inline block — head «⎇ kind · name», the edge line, at most three lane rows',
        check: (_screen, { frames }) => {
          const rows = (frames[frameIndex('app_build final', 'inline')] ?? '').split('\n');
          const lanes = rows.filter((row) => /^[├└]─ /.test(row));
          return rows[0]!.startsWith('⎇ app_build') && (rows[1] ?? '').includes('◐ code') && lanes.length > 0 && lanes.length <= GRAPH_VIEW_INLINE_LANES_MAX + 1;
        } },
      { id: 'inline-folds-when-done', expect: 'a finished loop folds to one line «✓ kind · name · n/n stages · time · approval»',
        check: (_screen, { frames }) => {
          const app = (frames[frameIndex('app_build done', 'inline')] ?? '').split('\n');
          const harness = (frames[frameIndex('harness done', 'inline')] ?? '').split('\n');
          return app.length === 1 && /^✓ app_build · (?:.* · )?(\d+)\/\1 stages · .* · deploy approved$/.test(app[0]!)
            && harness.length === 1 && /^✓ harness · .* · (\d+)\/\1 children/.test(harness[0]!);
        } },
      { id: 'harness-children-lanes', expect: 'harness children are lanes (name · model · mini edge), a retry is one lane with «(retry n)», finished children fold',
        check: (_screen, { frames }) => {
          const rows = (frames[frameIndex('harness running', 'inline')] ?? '').split('\n');
          return rows[0]!.startsWith('⎇ harness') && rows.filter((row) => row.includes('child-notice')).length === 1
            && rows.some((row) => /child-notice \(retry 1\) · glm-5 · ✓ plan/.test(row))
            && rows.some((row) => /✓ queue-state · gpt-6-sol · (\d+)\/\1$/.test(row));
        } },
      { id: 'detail-node-log-follows', expect: '개정 5 graph detail: every node expanded (both ARG rounds), the selected node ▸, the log follows it',
        check: (_screen, { frames }) => {
          const rows = (frames[detailIndex('graph-node')] ?? '').split('\n');
          const log = rows.slice(rows.indexOf('── log · arch ──') + 1);
          return rows.includes('▸ ✓ arch ↻2') && rows.some((row) => row.trim().startsWith('↻1  ')) && rows.some((row) => row.trim().startsWith('↻2  '))
            && log.some((row) => row.startsWith('↻2 ')) && !log.some((row) => row.includes('code-api'));
        } },
      { id: 'detail-harness-child', expect: 'harness detail: one row per child, the selected retried child ▸ and its log across both rounds',
        check: (_screen, { frames }) => {
          const rows = (frames[detailIndex('harness-child')] ?? '').split('\n');
          return rows.some((row) => row.startsWith('▸ ◐ child-notice (retry 1) · glm-5'))
            && rows.some((row) => row.startsWith('↻1 ')) && rows.some((row) => row.startsWith('↻2 '));
        } },
      { id: 'detail-child-pty-readonly', expect: 'child detail: head «name · model · n/m · time», the PTY screen read-only above, its activity log below',
        check: (_screen, { frames }) => {
          const rows = (frames[detailIndex('child-pty')] ?? '').split('\n');
          const top = rows.findIndex((row) => row.startsWith('── PTY · read-only'));
          const bottom = rows.indexOf('── activity ──');
          return /^◐ child-notice \(retry 1\) · glm-5 · /.test(rows[0] ?? '') && top > 0 && bottom > top
            && HARNESS_SIM_CHILD_PTY.every((line) => rows.slice(top + 1, bottom).includes(line)) && rows.length > bottom + 1;
        } },
      { id: 'color-meanings', expect: '개정 3: every colored span matches its meaning and ≤2 emphasis colors per line',
        check: (_screen, { ansiFrames }) => (ansiFrames ?? []).every((frame) => frame.split('\n').every((row) => graphViewColorViolations(row).length === 0)) },
      { id: 'no-color-readable', expect: 'without color the states still read from glyphs (✓ ◐ ○ ✗ ◆) and no escape codes appear',
        check: (_screen, { frames }) => frames.every((frame) => !frame.includes('\x1b['))
          && ['✓', '◐', '○', '◆'].every((glyph) => frames.some((frame) => frame.includes(glyph))) },
    ],
  },
  {
    id: 'narrow-panel',
    description: 'A turn, then the session sidetab beside the chat.',
    env: () => ({ ELANOUS_TEST_FAKE_LLM_RESPONSE: 'UXPACK-PANEL-DONE' }),
    steps: () => [
      turn('panel turn', 'UXPACK-PANEL', 'UXPACK-PANEL-DONE'),
      { ...slashStep('/side'), until: (screen: string) => /Sessions ·/.test(screen) },
    ],
    judges: [
      { id: 'no-overflow', expect: 'no row wider than the terminal', check: (screen, { cols }) => lines(screen).every((row) => Bun.stringWidth(row) <= cols) },
      { id: 'no-blank-peek-rows', expect: 'no empty «↳ …» peek rows', check: (screen) => !lines(screen).some((row) => /↳\s*…/.test(row)) },
    ],
  },
];

export interface UxPackResult {
  readonly scenario: string;
  readonly cols: number;
  readonly tui: 'next' | 'classic';
  readonly error?: string;
  readonly judges: readonly { id: string; expect: string; pass: boolean }[];
  readonly textPath: string;
  readonly ansiPath: string;
}

// 출처: src/tui/entry-tool-flow-pty.test.ts — one PTY lap with boot, a turn and exit fits 90 s.
const PTY_STEP_TIMEOUT_MS = 30_000;

/** Run one scenario at one width and write `<scenario>-<tui>-<cols>.txt/.ansi` into `outDir`. */
export async function runUxPackScenario(input: {
  readonly scenario: UxPackScenario; readonly cols: number; readonly rows: number; readonly outDir: string;
  readonly repoRoot: string; readonly tui?: 'next' | 'classic';
}): Promise<UxPackResult> {
  const { scenario, cols, rows, outDir } = input;
  const tui = input.tui ?? 'next';
  const base = join(outDir, `${scenario.id}-${tui}-${cols}`);
  const raw: string[] = [];
  if (scenario.render) {
    const frames = scenario.render(cols, rows);
    writeFileSync(`${base}.txt`, frames.map((frame) => `=== ${frame.label}\n${frame.plain}`).join('\n\n'));
    writeFileSync(`${base}.ansi`, frames.map((frame) => `=== ${frame.label}\n${frame.ansi}`).join('\n\n'));
    const plain = frames.map((frame) => frame.plain);
    return { scenario: scenario.id, cols, tui, textPath: `${base}.txt`, ansiPath: `${base}.ansi`,
      judges: scenario.judges.map((judge) => ({ id: judge.id, expect: judge.expect,
        pass: judge.check(plain.at(-1) ?? '', { cols, frames: plain, ansiFrames: frames.map((frame) => frame.ansi) }) })) };
  }
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), `uxpack-${scenario.id}-`));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    for (const [file, content] of Object.entries(scenario.files ?? {})) writeFileSync(join(root, file), content);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(input.repoRoot, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', tui],
      root, rows, cols,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ...scenario.env?.(root) },
      // 출처: src/dashboard/plugin-wizard-classic-pty.test.ts — classic is ready once ChatLog and the prompt show.
      ready: { label: 'boot', until: (screen) => tui === 'classic' ? screen.includes('ChatLog') && screen.includes('❯') : /Ctrl\+Q (종료|quit)/.test(screen), timeoutMs: PTY_STEP_TIMEOUT_MS },
      steps: scenario.steps(root).map(({ classicUntil, ...step }) => ({ timeoutMs: PTY_STEP_TIMEOUT_MS, ...step,
        ...(tui === 'classic' && classicUntil ? { until: classicUntil } : {}) })),
      onOutput: (chunk) => { raw.push(chunk); },
    });
    const frames = run.frames.filter((frame) => frame.label !== 'boot').map((frame) => frame.screen);
    const last = frames.at(-1) ?? '';
    writeFileSync(`${base}.txt`, run.frames.map((frame) => `=== ${frame.label}\n${frame.screen}`).join('\n\n'));
    writeFileSync(`${base}.ansi`, raw.join(''));
    return { scenario: scenario.id, cols, tui, textPath: `${base}.txt`, ansiPath: `${base}.ansi`,
      judges: scenario.judges.map((judge) => ({ id: judge.id, expect: judge.expect, pass: judge.check(last, { cols, frames, raw: raw.join('') }) })) };
  } catch (error) {
    writeFileSync(`${base}.ansi`, raw.join(''));
    const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
    // Keep the whole message: the PTY sequence error carries the last rendered screen.
    writeFileSync(`${base}.txt`, `ERROR ${error instanceof Error ? error.message : String(error)}\n`);
    return { scenario: scenario.id, cols, tui, error: message, textPath: `${base}.txt`, ansiPath: `${base}.ansi`,
      judges: scenario.judges.map((judge) => ({ id: judge.id, expect: judge.expect, pass: false })) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Markdown summary: one row per scenario × width × surface, ✓/✗ per judge with the failing reason. */
export function uxPackSummary(results: readonly UxPackResult[], header: string): string {
  const rows = results.map((result) => {
    const verdict = result.error ? '✗' : result.judges.every((judge) => judge.pass) ? '✓' : '✗';
    const reasons = result.error ? `error: ${result.error}`
      : result.judges.map((judge) => `${judge.pass ? '✓' : '✗'} ${judge.id}${judge.pass ? '' : ` (${judge.expect})`}`).join('<br>');
    return `| ${result.scenario} | ${result.tui} | ${result.cols} | ${verdict} | ${reasons} |`;
  });
  return [header, '', '| scenario | tui | cols | verdict | judges |', '|---|---|---|---|---|', ...rows, ''].join('\n');
}

export function ensureDir(path: string): void { mkdirSync(path, { recursive: true }); }
