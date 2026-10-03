// V1 — TUI regression checks that UX measured by hand on 10-02 (U1a · U1b · MAT1c · ONB1), as data.
// Each check says what to type and how to judge the rendered screen text. The verdicts are pure
// (screen string → ok/reason) so they are unit-tested without a PTY; scripts/tui-regress.ts drives the PTY.

export type Step =
  | { kind: 'type'; text: string }
  | { kind: 'key'; data: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'snap'; as: string }
  | { kind: 'erase'; count: number };

export interface Verdict { ok: boolean; reason: string }

export interface TuiCheck {
  id: string;
  title: string;
  /** `tui.role` to set in the temp config before launch (owner when omitted). */
  role?: 'owner' | 'contributor' | 'general';
  steps: Step[];
  judge: (snaps: Record<string, string>) => Verdict;
}

const CTRL_C = '\x03';
const BACKSPACE = '\x7f';
const HINT = /한 번 더 누르면 나갑니다/;

const ok = (reason: string): Verdict => ({ ok: true, reason });
const no = (reason: string): Verdict => ({ ok: false, reason });

/** The input row: the last screen line that starts with the prompt marker. */
export function inputRow(screen: string): string | undefined {
  return screen.split('\n').filter((line) => line.trimStart().startsWith('❯')).at(-1);
}

/** Palette entries visible after typing a slash prefix (lines other than the input row that show `/name`). */
export function paletteHas(screen: string, name: string): boolean {
  const row = inputRow(screen);
  return screen.split('\n').some((line) => line !== row && line.includes(`/${name}`));
}

export function judgeFirstScreen(screen: string): Verdict {
  if (/Step 1/.test(screen)) return no('«Step 1» 마법사가 떴다');
  if (!inputRow(screen)) return no('입력칸 «❯» 가 없다');
  return ok('입력칸이 보이고 «Step 1» 이 없다');
}

export function judgeHintAppearsThenClears(armed: string, later: string): Verdict {
  if (!HINT.test(armed)) return no('빈 입력 Ctrl+C 뒤 안내가 안 보인다');
  if (HINT.test(later)) return no('2.6초 뒤에도 안내가 남아 있다');
  return ok('안내가 떴다가 2초 뒤 사라졌다');
}

export function judgeCtrlCClearsText(typed: string, after: string, text: string): Verdict {
  if (!(inputRow(typed) ?? '').includes(text)) return no('친 글이 입력칸에 안 보인다(준비 실패)');
  if ((inputRow(after) ?? '').includes(text)) return no('Ctrl+C 뒤에도 글이 남아 있다');
  if (HINT.test(after)) return no('글을 지우는 Ctrl+C 에 나가기 안내가 떴다');
  return ok('글이 지워지고 안내는 없다');
}

export function judgePalette(screens: Record<string, string>, expectations: Record<string, boolean>): Verdict {
  for (const [name, want] of Object.entries(expectations)) {
    const screen = screens[name];
    if (screen === undefined) return no(`/${name} 화면이 없다`);
    if (paletteHas(screen, name) !== want) return no(`/${name} 가 팔레트에 ${want ? '없다' : '보인다'}`);
  }
  return ok(Object.entries(expectations).map(([n, w]) => `/${n} ${w ? '보임' : '숨김'}`).join(' · '));
}

/** U1b — the help is drawn (key section ⊕ a run of command rows) and the prompt survives below it.
 *  Not «the whole grid fits»: an owner sees 60+ commands, which exceed a 50-row screen and scroll (PgUp). */
export function judgeHelpShown(screen: string): Verdict {
  const lines = screen.split('\n');
  const commandRows = lines.filter((line) => /^\s+\/[a-z][a-z-]*/.test(line)).length;
  if (!lines.some((line) => /^\s*Keys\s*$/.test(line))) return no('/help 의 Keys 절이 안 보인다');
  if (commandRows < 10) return no(`명령 줄이 ${commandRows}개뿐이다`);
  if (!inputRow(screen)) return no('도움말을 연 뒤 입력칸이 화면 밖으로 밀렸다');
  return ok(`도움말이 그려졌다(명령 줄 ${commandRows} · Keys 절 · 입력칸 유지)`);
}

/** U1c2 — lines typed while a reply streams show up as «my» lines, in order, each above its own answer. */
export function judgeQueuedEcho(screen: string): Verdict {
  const lines = screen.split('\n');
  const at = (re: RegExp, after = -1) => lines.findIndex((line, i) => i > after && re.test(line));
  const u2 = at(/Q2MARK 라고만/);
  if (u2 < 0) return no('줄 서 있던 «Q2MARK 라고만» 이 내 말로 안 보인다');
  const a2 = lines.findIndex((line, i) => i > u2 && /Q2MARK/.test(line) && !/라고만/.test(line));
  const u3 = at(/Q3MARK 라고만/, u2);
  if (u3 < 0) return no('«Q3MARK 라고만» 이 내 말로 안 보인다(또는 순서가 뒤집혔다)');
  const a3 = lines.findIndex((line, i) => i > u3 && /Q3MARK/.test(line) && !/라고만/.test(line));
  if (!(a2 > u2 && u3 > a2 && a3 > u3)) return no(`순서가 내 말2(${u2}) → 답2(${a2}) → 내 말3(${u3}) → 답3(${a3}) 가 아니다`);
  return ok('내 말2 → 답2 → 내 말3 → 답3');
}

const PALETTE_STEPS = (names: string[]): Step[] => names.flatMap((name) => [
  { kind: 'type', text: `/${name.slice(0, 3)}` } as Step,
  { kind: 'wait', ms: 800 } as Step,
  { kind: 'snap', as: name } as Step,
  { kind: 'erase', count: 4 } as Step,
  { kind: 'wait', ms: 300 } as Step,
]);

export const TUI_REGRESS_CHECKS: TuiCheck[] = [
  {
    id: 'R1', title: '첫 화면 — 입력칸 · «Step 1» 0 (ONB1)',
    steps: [{ kind: 'snap', as: 'boot' }],
    judge: (s) => judgeFirstScreen(s.boot ?? ''),
  },
  {
    id: 'R2', title: '빈 입력 Ctrl+C → 안내 → 2초 뒤 사라짐 (U1a · #22868)',
    steps: [{ kind: 'key', data: CTRL_C }, { kind: 'wait', ms: 300 }, { kind: 'snap', as: 'armed' }, { kind: 'wait', ms: 2600 }, { kind: 'snap', as: 'later' }],
    judge: (s) => judgeHintAppearsThenClears(s.armed ?? '', s.later ?? ''),
  },
  {
    id: 'R3', title: '글 친 뒤 Ctrl+C → 입력 지움 · 안내 없음 (U1a)',
    steps: [{ kind: 'type', text: 'regress-abc' }, { kind: 'wait', ms: 400 }, { kind: 'snap', as: 'typed' }, { kind: 'key', data: CTRL_C }, { kind: 'wait', ms: 400 }, { kind: 'snap', as: 'after' }],
    judge: (s) => judgeCtrlCClearsText(s.typed ?? '', s.after ?? '', 'regress-abc'),
  },
  {
    id: 'R4', title: 'owner 팔레트 — /directive · /help 보임 (MAT1c)',
    steps: PALETTE_STEPS(['directive', 'help']),
    judge: (s) => judgePalette(s, { directive: true, help: true }),
  },
  {
    id: 'R5', title: 'general 팔레트 — /directive 숨김 · /help 보임 (MAT1c)',
    role: 'general',
    steps: PALETTE_STEPS(['directive', 'help']),
    judge: (s) => judgePalette(s, { directive: false, help: true }),
  },
  {
    id: 'R6', title: '/help 가 그려지고 입력칸이 남는다 (U1b · #22802)',
    steps: [{ kind: 'type', text: '/help' }, { kind: 'key', data: '\r' }, { kind: 'wait', ms: 1500 }, { kind: 'snap', as: 'help' }],
    judge: (s) => judgeHelpShown(s.help ?? ''),
  },
  {
    id: 'R7', title: '답 오는 중 쳐 둔 두 줄이 내 말로 차례로 (U1c2 · #23026 · 실제 LLM 턴)',
    steps: [
      { kind: 'type', text: '1부터 25까지 숫자를 한 줄에 하나씩 써 줘. 도구는 쓰지 마.' }, { kind: 'key', data: '\r' }, { kind: 'wait', ms: 2500 },
      { kind: 'type', text: 'Q2MARK 라고만 답해' }, { kind: 'key', data: '\r' }, { kind: 'wait', ms: 500 },
      { kind: 'type', text: 'Q3MARK 라고만 답해' }, { kind: 'key', data: '\r' }, { kind: 'wait', ms: 60_000 },
      { kind: 'snap', as: 'after' },
    ],
    judge: (s) => judgeQueuedEcho(s.after ?? ''),
  },
];

export const ERASE = BACKSPACE;
