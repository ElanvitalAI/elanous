import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// Source: #37786 — allocate its 30s real-PTY regression budget to boot/tool and detail-frame waits.
const TURN_WAIT_MS = 10_000;
// Source: #37786 — short per-frame waits report the failed mouse transition before the outer budget.
const DETAIL_WAIT_MS = 5_000;

test('mouse clicks reach tool summary, steps and raw output then fold without another turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-mouse-fold-'));
  let row = 0;
  let before = '';
  const transcript = () => readdirSync(join(root, 'sessions')).filter((name) => name.endsWith('.jsonl')).sort()
    .map((name) => readFileSync(join(root, 'sessions', name), 'utf8')).join('\n');
  const atHeader = (condition: (screen: string) => boolean) => (screen: string): boolean => {
    if (!condition(screen)) return false;
    row = screen.split('\n').findIndex((line) => /[▸▾] 도구 · Bash 결과/u.test(line)) + 1;
    return row > 0;
  };
  const click = () => `\x1b[<0;5;${row}M\x1b[<0;5;${row}m`;
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'mouse turn complete',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'mouse tool details', name: 'Bash', args: {
          command: "for n in $(seq 0 7); do printf 'mouse-line-%02d\\n' $n; done; printf 'mouse-stderr-marker\\n' >&2; exit 7",
        } }),
      },
      ready: { label: 'boot', timeoutMs: TURN_WAIT_MS, until: (s) => s.includes('Enter 전송') && s.includes('❯ ') },
      steps: [
        { label: 'one real tool turn', timeoutMs: TURN_WAIT_MS, text: 'mouse tool details', until: (s) => {
          if (!s.includes('턴 완료')) return false;
          before = transcript(); return true;
        } },
        { label: 'explicit log view', timeoutMs: DETAIL_WAIT_MS, keys: '\x1b[5~\x1b[6~', until: atHeader((s) => s.includes('▸ 도구 · Bash 결과')) },
        { label: 'click summary', timeoutMs: DETAIL_WAIT_MS, text: click, enter: false, until: atHeader((s) => s.includes('▾ 도구 · Bash 결과')) },
        { label: 'click steps', text: click, enter: false, timeoutMs: DETAIL_WAIT_MS,
          until: atHeader((s) => s.includes('호출 인자 전달') && s.includes('도구 결과 수신')) },
        { label: 'click raw reference', text: click, enter: false, timeoutMs: DETAIL_WAIT_MS,
          until: (s) => s.includes('mouse-line-07') && s.includes('mouse-stderr-marker') && s.includes('종료 상태') },
        { label: 'scroll expanded header into view', keys: '\x1b[5~\x1b[5~', timeoutMs: DETAIL_WAIT_MS,
          until: atHeader((s) => s.includes('▾ 도구 · Bash 결과')) },
        { label: 'click folded again', text: click, enter: false, timeoutMs: DETAIL_WAIT_MS,
          until: atHeader((s) => s.includes('▸ 도구 · Bash 결과') && !s.includes('mouse-stderr-marker')) },
      ],
    });
    const screen = (label: string) => run.frames.find((frame) => frame.label === label)?.screen ?? '';
    expect(screen('click steps')).toContain('호출 인자 전달');
    expect(screen('click raw reference')).toContain('mouse-line-07');
    expect(screen('click raw reference')).toContain('mouse-stderr-marker');
    expect(screen('click folded again')).not.toContain('mouse-stderr-marker');
    expect(before).not.toBe('');
    expect(transcript()).toBe(before);
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000); // Source: #37786 real PTY first-response regression budget.
