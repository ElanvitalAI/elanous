// N03 장치 — PTY-KEY-MODIFIERS (0.2.36 · 2026-10-22 · #27585 Shift+Enter 줄바꿈).
// `elanous pty key <ref> shift+enter` 가 PTY 에 쓰는 바로 그 바이트(생산 `resolvePtySpecialKey`)를 진짜 TUI(classic ·
// next)에 넣는다 — «한 줄» 입력 → shift+enter → «둘째 줄» → Enter 가 Ctrl+J 대체 없이 두 줄짜리 한 번의 제출이 되나.
// 판정은 fake LLM 이 받은 마지막 사용자 글(요청 캡처)에 «한 줄\n둘째 줄» 이 그대로 있는가 ⊕ 화면.
// ⛔ 생산 로직 재구현 0 — 바이트는 resolvePtySpecialKey, 받는 쪽은 진짜 TUI 파서·입력창.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePtySpecialKey, type PtyKeyEncoding } from '../pty-shell/pty-special-keys.js';
import { mockSeatPtySequence, type SeatPtySequenceEvidence, type SeatPtyStep } from './mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV } from './fake-llm.js';

export interface PtyKeyModifiersSpec {
  tui: 'classic' | 'next';
  encoding: PtyKeyEncoding;
  root: string;
  executable: string;
  entry: string;
}

export interface PtyKeyModifiersResult {
  spec: PtyKeyModifiersSpec;
  bytes: string;
  run: SeatPtySequenceEvidence;
  lastUser: string;
  checks: Record<string, boolean>;
}

const REPLY = '[fake-llm] 두 줄 받았습니다';
export const PTY_KEY_FIRST = 'modkey-line-one';
export const PTY_KEY_SECOND = 'modkey-line-two';

export async function runPtyKeyModifiersDevice(spec: PtyKeyModifiersSpec): Promise<PtyKeyModifiersResult> {
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const capturePath = join(root, 'fake-llm-requests.jsonl');
  const bytes = resolvePtySpecialKey('shift+enter', { encoding: spec.encoding });
  const ready = spec.tui === 'next'
    ? (s: string) => s.includes('elanous next ·') && s.includes('Ctrl+Q 종료')
    : (s: string) => s.includes('elanous | daemon') && s.includes('❯');
  const answered = (s: string) => s.includes(REPLY) && (spec.tui === 'next' ? s.includes('응답 완료') : /✔ 완료/.test(s));
  const steps: SeatPtyStep[] = [
    { label: 'first line', keys: PTY_KEY_FIRST, until: (s) => s.includes(PTY_KEY_FIRST) },
    { label: 'shift+enter', keys: bytes, until: () => true },
    { label: 'second line', keys: PTY_KEY_SECOND, until: (s) => s.includes(PTY_KEY_SECOND) },
    { label: 'submitted', keys: '\r', until: answered, timeoutMs: 30_000 },
  ];
  const run = await mockSeatPtySequence({
    executable: spec.executable,
    args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}', ...(spec.tui === 'next' ? ['--tui', 'next'] : [])],
    root,
    rows: 30,
    cols: 100,
    env: {
      ELANOUS_SESSION_ROOT: join(root, 'sessions'),
      [TEST_FAKE_LLM_ENV]: '1',
      ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
      [TEST_FAKE_LLM_RESPONSE_ENV]: REPLY,
      [TEST_FAKE_LLM_CAPTURE_ENV]: capturePath,
    },
    ready: { label: 'boot', until: ready, timeoutMs: 90_000 },
    quitKeys: spec.tui === 'next' ? '\x11' : '/exit\r',
    exitTimeoutMs: 20_000,
    steps,
  });
  const requests = existsSync(capturePath)
    ? readFileSync(capturePath, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as { messages: Array<{ role: string; content: unknown }> }]; } catch { return []; } })
    : [];
  const content = requests.at(-1)?.messages.filter((m) => m.role === 'user').at(-1)?.content;
  const lastUser = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const beforeSubmit = run.frames.find((f) => f.label === 'second line')?.screen ?? '';
  return {
    spec,
    bytes,
    run,
    lastUser,
    checks: {
      // One submission with a real newline between the two lines (not two turns, not a literal «^M»/escape residue).
      oneTurnTwoLines: requests.length === 1 && lastUser.includes(`${PTY_KEY_FIRST}\n${PTY_KEY_SECOND}`),
      noEscapeResidue: !beforeSubmit.includes('[27;') && !beforeSubmit.includes('[13;') && !beforeSubmit.includes('^M'),
      answered: answered(run.frames.at(-1)?.screen ?? ''),
      exitedClean: run.exitCode === 0,
    },
  };
}
