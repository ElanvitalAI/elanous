// N03 장치 — TUI-RESUME-PICKER (0.2.36 · 10-23 00:44 대표 보고).
// 관측: `/resume` 에 Enter → «usage: /session load <id-prefix>» 한 줄뿐, 고를 목록이 없다 ⊕ `/session list` 의 id 가 잘린다.
// 이 장치는 격리 우주에 «앞 8자가 같은» 세션 셋을 진짜 세션 저장소로 심고, 진짜 TUI(classic · next)에서
//   classic: `/session list` → 고유 앞자리 셋 · `/resume` → 픽커 · ↓ Enter → 그 줄의 세션이 «✓ loaded session»
//   next:    `/resume` → 번호 붙은 목록(고유 앞자리) · `/resume 2` → 둘째 줄의 세션으로 전환 ⊕ 그 대화가 화면에
// 를 화면과 같은 바이너리의 `logs --json` 으로 판정한다. ⛔ 생산 로직 재구현 0 — 기대 앞자리만 손으로 적는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence, type SeatPtySequenceEvidence, type SeatPtyStep } from './mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV } from './fake-llm.js';
import { parseData, readLogs } from './next-tui-seat-scenarios.js';
import { seedLongSession, seedSessionWithId } from './session-id-seed.js';

export interface ResumePickerSpec {
  tui: 'classic' | 'next';
  /** `picker` (default): the list → pick flow. `boot-resume`: start with `--resume <id>` on a synthetic 379-row session. */
  mode?: 'picker' | 'boot-resume';
  root: string;
  executable: string;
  entry: string;
}

export interface ResumePickerResult {
  spec: ResumePickerSpec;
  run: SeatPtySequenceEvidence;
  store: { seeded: Record<string, string>; chosen: string | null };
  logs: ReturnType<typeof readLogs>;
  checks: Record<string, boolean>;
}

/** Three sessions whose first 8 characters are the same — the case the fixed 8-char cut made look identical. */
export const RESUME_PICKER_SEEDS = [
  { id: 'c0ffee00-0001-4000-8000-000000000001', title: 'n8n 특강 단계별 영상', prefix: 'c0ffee00-0001' },
  { id: 'c0ffee00-0002-4000-8000-000000000002', title: 'RSS Limit 5 재촬영', prefix: 'c0ffee00-0002-40' },
  { id: 'c0ffee00-0002-4fff-8000-000000000003', title: '세 번째 대화', prefix: 'c0ffee00-0002-4f' },
] as const;

const allPrefixes = (s: string) => RESUME_PICKER_SEEDS.every((x) => s.includes(x.prefix));

export async function runResumePickerDevice(spec: ResumePickerSpec): Promise<ResumePickerResult> {
  if (spec.mode === 'boot-resume') return runBootResume(spec);
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  for (const s of RESUME_PICKER_SEEDS) seedSessionWithId(s.id, s.title, 2, sessions);
  const seeded = Object.fromEntries(RESUME_PICKER_SEEDS.map((s) => [s.id, s.prefix]));
  const next = spec.tui === 'next';
  const steps: SeatPtyStep[] = next
    ? [
        { label: 'after /resume (list)', text: '/resume', until: (s) => s.includes('최근 대화') && allPrefixes(s) },
        { label: 'after /resume 2', text: '/resume 2', until: (s) => s.includes('대화 이어 가기 ·') || s.includes('맞는 대화 없음') },
      ]
    : [
        { label: 'after /session list', text: '/session list', until: (s) => s.includes('/session list') && allPrefixes(s) },
        { label: 'after /resume (picker)', text: '/resume', until: (s) => s.includes('Resume session') && allPrefixes(s.slice(s.lastIndexOf('Resume session'))) },
        { label: 'after ↓', keys: '\x1b[B', until: () => true },
        { label: 'after Enter (resumed)', keys: '\r', until: (s) => s.includes('✓ loaded session') || s.includes('Failed to load') || s.includes('ambiguous') },
      ];
  const run = await mockSeatPtySequence({
    executable: spec.executable,
    args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}', ...(next ? ['--tui', 'next'] : [])],
    root,
    rows: 30,
    cols: 110,
    env: {
      ELANOUS_SESSION_ROOT: sessions,
      [TEST_FAKE_LLM_ENV]: '1',
      ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
      [TEST_FAKE_LLM_RESPONSE_ENV]: '[fake-llm] 답했습니다',
    },
    ready: {
      label: 'boot',
      until: next ? (s) => s.includes('elanous next ·') && s.includes('Ctrl+Q 종료') : (s) => s.includes('elanous | daemon') && s.includes('❯'),
      timeoutMs: 90_000,
    },
    quitKeys: next ? '\x11' : '/exit\r',
    exitTimeoutMs: 20_000,
    steps,
  });
  const frame = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
  const logs = readLogs({ root, executable: spec.executable, entry: spec.entry }, next ? 'tui.next' : 'dashboard.session,slash.session,tui.session');
  const rows = logs.lines.map((l) => { try { return JSON.parse(l) as { category?: string; event?: string; data?: string }; } catch { return {}; } });

  if (next) {
    const list = frame('after /resume (list)');
    // Row «2. » of the list the user saw — the session `/resume 2` must open.
    const row2 = list.split('\n').find((l) => /^\s*2\. /.test(l)) ?? '';
    const expected = RESUME_PICKER_SEEDS.find((s) => row2.includes(` ${s.prefix} `)) ?? null;
    const resumed = rows.filter((r) => r.category === 'tui.next' && r.event === 'session-resume').map((r) => parseData<{ to: string; by: string }>(r.data));
    const after = frame('after /resume 2');
    return {
      spec, run, logs, store: { seeded, chosen: resumed[0]?.to ?? null },
      checks: {
        listShownNotUsage: list.includes('최근 대화') && !list.includes('usage: /session load'),
        uniquePrefixesShown: allPrefixes(list),
        rowsNumbered: /^\s*1\. /m.test(list) && row2 !== '',
        resumedRow2ByNumber: expected !== null && resumed.length === 1 && resumed[0]?.to === expected.id && resumed[0]?.by === 'number',
        chosenConversationOnScreen: expected !== null && after.includes(`${expected.title} 1`),
        exitedClean: run.exitCode === 0,
      },
    };
  }

  const list = frame('after /session list');
  const pickerFull = frame('after /resume (picker)');
  const picker = pickerFull.slice(pickerFull.lastIndexOf('Resume session'));
  // Picker rows top to bottom; ↓ once from the first row selects the second.
  const order = picker.split('\n')
    .map((l) => RESUME_PICKER_SEEDS.find((s) => l.includes(s.prefix)) ?? null)
    .filter((s): s is (typeof RESUME_PICKER_SEEDS)[number] => s !== null);
  const expected = order[1] ?? null;
  const after = frame('after Enter (resumed)');
  return {
    spec, run, logs, store: { seeded, chosen: expected?.id ?? null },
    checks: {
      sessionListUniquePrefixes: allPrefixes(list),
      pickerOpenedNotUsage: picker.includes('Resume session') && !pickerFull.includes('usage: /session load'),
      pickerUniquePrefixes: allPrefixes(picker),
      // The loaded line names the second row's session (8-char echo + its title).
      resumedSecondRow: expected !== null && after.includes('✓ loaded session') && after.includes(`(${expected.title})`),
      noAmbiguous: !after.includes('ambiguous'),
      exitedClean: run.exitCode === 0,
    },
  };
}

/** The id the boot-resume mode seeds — daemon-shaped, like the n8n session. */
export const BOOT_RESUME_ID = 'elanous-session-l0ng79';

// ②③④ — `elanous [--tui next] --resume <id>` on a 379-row session (user · seven tool rows · reply per turn):
// the restored conversation must be on the first screen, and classic's ctx must not read 0.
async function runBootResume(spec: ResumePickerSpec): Promise<ResumePickerResult> {
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const seed = seedLongSession(BOOT_RESUME_ID, 379, sessions);
  const next = spec.tui === 'next';
  const run = await mockSeatPtySequence({
    executable: spec.executable,
    args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}', '--resume', BOOT_RESUME_ID, ...(next ? ['--tui', 'next'] : [])],
    root,
    rows: 30,
    cols: 110,
    env: { ELANOUS_SESSION_ROOT: sessions, [TEST_FAKE_LLM_ENV]: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', [TEST_FAKE_LLM_RESPONSE_ENV]: '[fake-llm] 답했습니다' },
    // The restored transcript scrolls the boot banner away — wait for the input line and the last reply instead.
    ready: { label: 'boot (resumed)', until: (s) => s.includes('❯') && s.includes(seed.lastAssistant) && (next || /│ ctx /.test(s)), timeoutMs: 90_000 },
    quitKeys: next ? '\x11' : '/exit\r',
    exitTimeoutMs: 20_000,
    // Scroll back (PageUp · next also lists seven tool rows per turn, ~380 lines) until the first question is on screen — the whole conversation was restored,
    // not just the tail (r1 review: «the last reply alone passes even if only recent messages render»).
    steps: [{ label: 'scrolled to the first question', chunks: Array.from({ length: 150 }, () => '\x1b[5~'), gapMs: 60, until: (s) => s.includes(seed.firstUser), timeoutMs: 30_000 }],
  });
  const first = run.frames[0]?.screen ?? '';
  const logs = readLogs({ root, executable: spec.executable, entry: spec.entry }, 'chat.session.resume,tui.next');
  const ctxMatch = /│ ctx ([^│]+)│/.exec(first);
  const top = run.frames.find((f) => f.label === 'scrolled to the first question')?.screen ?? '';
  const checks: Record<string, boolean> = {
    lastReplyOnFirstScreen: first.includes(seed.lastAssistant),
    // The first question and the first reply are reachable by scrolling back in the same chat log.
    firstTurnReachable: top.includes(seed.firstUser) && top.includes('턴 1 답 · 끝'),
    exitedClean: run.exitCode === 0,
  };
  if (!next) {
    checks.resumedLine = first.includes('Next turn continues this conversation.');
    // ④ — the status bar's ctx is the restored size right away (was «ctx 0» until the first turn).
    checks.ctxNotZero = ctxMatch !== null && ctxMatch[1]!.trim() !== '0';
  }
  return { spec, run, logs, store: { seeded: { [seed.id]: seed.id }, chosen: seed.id }, checks };
}
