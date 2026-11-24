// DAILY-REGRESSION device: one real next-TUI seat process in a PTY, inside a scenario-owned temp universe.
// The TUI is the tree's own `bin/elanous.mjs` (the build under test); only the model is faked (network-free fake LLM).
// Seat identity comes from the universe layout only (<base>/seats/<SEAT> cwd + <base>~/seat-state/<SEAT>),
// the same synthetic layout the landed seat PTY tests use — never a real HQ path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MsgStore } from '../../../msg/msg-store.js';
import { mockSeatPtySequence, type SeatPtySequenceEvidence, type SeatPtyStep } from '../../mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_RESPONSE_RULES_ENV } from '../../fake-llm.js';

const BIN = resolve(import.meta.dir, '..', '..', '..', '..', 'bin', 'elanous.mjs');

export interface SeatTuiUniverse {
  readonly seat: string;
  readonly root: string;
  readonly home: string;
  /** Post one seat mail to this seat on the universe's own ledger (from a peer seat). */
  postMail(body: string): void;
  /** Raw provider requests the fake model received so far (one JSON line each). */
  requests(): string[];
}

export interface SeatTuiRun {
  readonly universe: SeatTuiUniverse;
  readonly evidence: SeatPtySequenceEvidence;
}

export function seatTuiUniverse(base: string, seat: string): SeatTuiUniverse {
  const root = join(base, 'seats', seat);
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
  mkdirSync(join(root, 'msg'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const capture = join(base, 'provider-requests.jsonl');
  return {
    seat, root, home,
    postMail(body) {
      const store = new MsgStore(join(root, 'msg', 'messages.db'));
      try { store.post({ from: 'JUD-SIM', to: seat, body }); } finally { store.close(); }
    },
    requests: () => existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean) : [],
  };
}

/** Boot the seat TUI, run `steps(universe)`, quit. A step that never matches throws with the last screen attached. */
export async function runSeatTui(options: {
  readonly base: string;
  readonly seat: string;
  readonly reply: string;
  readonly rules?: readonly { readonly when: string; readonly text: string }[];
  readonly rows?: number;
  readonly cols?: number;
  readonly env?: Record<string, string>;
  readonly steps: (universe: SeatTuiUniverse) => SeatPtyStep[];
}): Promise<SeatTuiRun> {
  const universe = seatTuiUniverse(options.base, options.seat);
  const evidence = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
    root: universe.root, rows: options.rows ?? 30, cols: options.cols ?? 110, exitTimeoutMs: 15_000,
    env: {
      HOME: universe.home, ELANOUS_SESSION_ROOT: join(universe.root, 'sessions'),
      ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TUI_GOAL_CONTINUE: '0',
      ELANOUS_TEST_FAKE_LLM_RESPONSE: options.reply,
      [TEST_FAKE_LLM_CAPTURE_ENV]: join(options.base, 'provider-requests.jsonl'),
      ...(options.rules ? { [TEST_FAKE_LLM_RESPONSE_RULES_ENV]: JSON.stringify(options.rules) } : {}),
      ...(options.env ?? {}),
    },
    ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) || screen.includes('○ idle'), timeoutMs: 60_000 },
    steps: options.steps(universe),
  });
  return { universe, evidence };
}

/** Wait until `ready()` holds, then a further `settleMs` (lets the turn-end repaint land before the screen is read). */
export function settledUntil(ready: (screen: string) => boolean, settleMs: number, keep?: (screen: string) => void): (screen: string) => boolean {
  let since: number | undefined;
  return (screen) => {
    keep?.(screen);
    if (!ready(screen)) { since = undefined; return false; }
    since ??= Date.now();
    return Date.now() - since >= settleMs;
  };
}
