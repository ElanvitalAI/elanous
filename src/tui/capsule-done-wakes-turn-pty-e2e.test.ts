import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// CAPSULE-DONE-KNOCK-PTY-E2E-FU (OP 11-22 · JUD-B #129076 «기존 e2e 시험은 실모듈+fake startChatTurn — 실 PTY 아님» ·
// OP #132589: 제품에는 env 시험 심을 두지 않는다 — 프레임은 시험 소유 fake chat child 가 실 와이어에 직접 쓴다).
//
// ONE real PTY (N03 seat device: bun-native PTY, scrubbed env, isolated root) runs the REAL Next TUI through a
// wrapper script whose path does NOT end in /bin/elanous.mjs, so the TUI spawns its chat child on the slow path
// (bin: cli) — the wrapper ITSELF as the chat child (`repl --session … --json --stdin-jsonl --next-tui`).
// That fake chat child answers the first HUMAN turn on stdout (real stdin-JSONL protocol: {prompt,id} in,
// TurnResult JSON out), then writes ONE capsule-done frame on its REAL stderr
// (ELANOUS_TUI_CAPSULE\t{json} — the exact wire a finished background Agent takes; the TUI reads child stderr
// for the whole session, idle included). NO production env seam anywhere: the product tree stays untouched.
// The passive capsule notice then ripens in the REAL PASSIVE_RESULT_IDLE_WAKE_MS (120 s, measured — not
// compressed), the idle watchdog knocks the SAME door, and the REAL entry chain must start a real second turn
// (turn-life:turn-start, door 'queue-notice', source 'capsule-done') whose reply lands on the real screen.
//
// Boundary note (.rules testing-gates «실물 계약» row): this test measures real process time on purpose —
// a real 120 s ripen in a real TUI process; the device contract (N03 `until` polling) is the repository's own
// real-PTY harness.
const REAL_BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const SYNTH_ID = 'synth-pty-probe-1';
const FIRST_ASK = 'PTY-E2E first human turn';
const KNOCK_ASK = 'capsule: PTY-E2E automatic knock turn';

interface Row { at: number; id: number; category: string; event: string; data: Record<string, unknown> }

function runRows(root: string, runId: string): Row[] {
  const store = LogStore.openReadOnly(join(root, 'logs', 'logs.db'));
  try {
    return store.query({ limit: 20_000 }) // 출처: #39666 — runRows 영수 확인용 전행 스캔 상한
      .map((row) => ({ at: row.ts_ms, id: row.id, category: row.category, event: row.event, data: row.data ? JSON.parse(row.data) as Record<string, unknown> : {} }))
      .filter((row) => row.data.runId === runId)
      .sort((a, b) => a.at - b.at || a.id - b.id);
  } finally { store.close(); }
}

test('capsule-done on a real PTY: idle seat rips the passive notice and the real entry chain opens one automatic turn', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'capsule-pty-'));
  const runId = `capsule-pty-${Date.now().toString(36)}`;
  let knockScreen = '';
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    // The test-owned wrapper: argv[0] path ≠ …/bin/elanous.mjs ⇒ the TUI's chat-child spawn takes the slow
    // path and re-invokes THIS script with the `repl` subcommand (the fake chat child protocol below).
    // No TUI env is set anywhere: the wrapper derives everything from its own argv.
    const wrapper = join(root, 'tui-wrapper.mjs');
    writeFileSync(wrapper, [
      `const REAL_BIN = ${JSON.stringify(REAL_BIN)};`,
      `const SYNTH_ID = ${JSON.stringify(SYNTH_ID)};`,
      `const FIRST_ASK = ${JSON.stringify(FIRST_ASK)};`,
      `const KNOCK_ASK = ${JSON.stringify(KNOCK_ASK)};`,
      `if (!process.argv.slice(2).includes('repl')) {`,
      `  // TUI invocation — run the real entrypoint; process.argv[1] (this wrapper) stays the TUI's cli.`,
      `  await import(REAL_BIN);`,
      `} else {`,
      `  // The chat-child half below needs the session id (the TUI passes --session <id>) and the`,
      `  // sessions root env to append the answer on the post-turn reload lane too.`,
      `  const _sessArg = process.argv.indexOf('--session');`,
      `  const SESS = _sessArg >= 0 ? process.argv[_sessArg + 1] : '';`,
      `  const ROOT = process.env.ELANOUS_SESSION_ROOT ?? '';`,
      `  // Fake chat child — the REAL stdin-JSONL protocol: one {prompt,id} line in, one TurnResult JSON line out.`,
      `  // After the FIRST turn settles it writes ONE capsule-done frame on its real stderr (the frame wire).`,
      `  process.stdin.setEncoding('utf8');`,
      `  let buf = '';`,
      `  process.stdin.on('data', (chunk) => { buf += chunk; });`,
      `  process.stdin.on('data', () => {`,
      `    const lines = buf.split('\\n');`,
      `    buf = lines.pop() ?? '';`,
      `    for (const line of lines) {`,
      `      const trimmed = line.trim();`,
      `      if (!trimmed) continue;`,
      `      let prompt = ''; let id = '';`,
      `      try { const t = JSON.parse(trimmed); prompt = String(t.prompt ?? ''); id = String(t.id ?? ''); } catch { prompt = trimmed; }`,
      `      const answer = prompt.includes(FIRST_ASK) ? 'REPLY-FIRST-PTY' : prompt.includes(KNOCK_ASK) || prompt.includes('capsule:') ? 'REPLY-KNOCK-PTY' : 'REPLY-OTHER';`,
      `      process.stdout.write(JSON.stringify({ event: 'delta', turnId: id, text: answer, source: 'assistant-text' }) + '\\n');`,
      `      try { if (SESS && ROOT) require('node:fs').appendFileSync(ROOT + '/' + SESS + '.jsonl', JSON.stringify({ role: 'assistant', content: answer, ts: new Date().toISOString(), replyFinal: true }) + '\\n'); } catch { /* session file best-effort */ }`,
      `      process.stdout.write(JSON.stringify({ event: 'result', turnId: id, text: answer }) + '\\n');`,
      `      if (prompt.includes(FIRST_ASK)) {`,
      `        const startedAt = Date.now() - 60_000;`,
      `        const endedAt = Date.now() - 15_000;`,
      `        process.stderr.write('ELANOUS_TUI_CAPSULE\\t' + JSON.stringify({`,
      `          type: 'capsule-done', capsuleId: SYNTH_ID, kind: 'agent', sessionId: SESS,`,
      `          startedAt, endedAt, status: 'ok', summary: 'synthetic pty probe · ok · 60s',`,
      `        }) + '\\n');`,
      `      }`,
      `    }`,
      `  });`,
      `  process.stdin.on('end', () => { process.exit(0); });`,
      `}`,
      '',
    ].join('\n'));
    chmodSync(wrapper, 0o755);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      // argv[1] = the wrapper (NOT bin/elanous.mjs): the chat child becomes this same wrapper on the slow path.
      args: ['{root}/tui-wrapper.mjs', '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, runId: `ux-${runId}`, rows: 40, cols: 130,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_RUN_ID: runId,
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen), timeoutMs: 120_000 },
      steps: [
        { label: 'first human turn answers (seat then idle)', text: FIRST_ASK, timeoutMs: 240_000,
          until: (screen) => screen.includes('REPLY-FIRST-PTY') },
        { label: 'the automatic capsule turn answers (real 120 s ripen)', text: '', enter: false, timeoutMs: 300_000,
          until: (screen) => { knockScreen = screen; return screen.includes('REPLY-KNOCK-PTY'); } },
      ],
    });
    expect(run.exitCode).toBe(0);

    const rows = runRows(root, runId);
    // (1) the TUI really received the ONE frame through the real stderr reader (listener count at arrival ≥ 1).
    const received = rows.filter((row) => row.event === 'turn-life:capsule-done-received' && row.data.capsuleId === SYNTH_ID);
    expect(received).toHaveLength(1);
    expect(Number(received[0]!.data.listeners)).toBeGreaterThan(0);
    // (2) the knock wired the notice (queued: true).
    const knocks = rows.filter((row) => row.event === 'turn-life:capsule-done-knock' && row.data.capsuleId === SYNTH_ID);
    expect(knocks).toHaveLength(1);
    expect(knocks[0]!.data.queued).toBe(true);
    // (3) the REAL entry chain started a second turn: exactly ONE human + ONE automatic notice turn.
    const starts = rows.filter((row) => row.event === 'turn-life:turn-start');
    const human = starts.filter((row) => row.data.door === 'human');
    const automatic = starts.filter((row) => row.data.door !== 'human');
    expect(human).toHaveLength(1);
    expect(automatic).toHaveLength(1);
    expect(automatic[0]!.data.door).toBe('queue-notice');
    expect(automatic[0]!.data.source).toBe('capsule-done');
    // ...and it started AFTER the frame was received (causality, not coincidence).
    expect(automatic[0]!.at).toBeGreaterThan(received[0]!.at);
    // (4) the screen carried the automatic turn's reply — measured, not assumed.
    expect(knockScreen).toContain('REPLY-KNOCK-PTY');
    // (5) no third turn: the one frame opened exactly one turn (dedupe held).
    expect(starts).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);
