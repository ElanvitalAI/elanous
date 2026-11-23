import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// SEAT-HUMAN-GOAL-PIN-2 ⑤b (OP #130443 합의 · 판정 T2·JUD-B) — 감시줄(캡슐 계열 idle-wake-door) 사건 턴 계약:
//   사람이 핀으로 세운 📌 목표가 캡슐-done 사건 턴 뒤에도 실 TUI PTY 에서 유지된다.
//   실 자식 bg 감시줄(o1 판본)은 main 회귀(#133183 회선)로 막혀 있어, OP #133163 상시규칙(2026-11-23 07:12 ·
//   msg #133163)에 따라 #39666 wrapper 판본 합성 주입으로 증명한다 — argv[0] 경로 ≠ …/bin/elanous.mjs 라
//   slow-path spawn 바뀐 wrapper 자체가 fake chat child 가 되고, 첫 사람 턴 답변 뒤 자기 REAL stderr 에
//   ELANOUS_TUI_CAPSULE 프레임(캡슐-done · 실 와이어) 1개를 쓴다. 생산 env 시심 없음 — 제품 트리 무수정.
//   수동 캡슐 통지는 실 PASSIVE_RESULT_IDLE_WAKE_MS(120 s — 압축 금지 · 실측)로 무르익고, idle 감시줄이
//   같은 문을 두드리면 실 엔트리 체인이 자동 턴(door 'queue-notice' · source 'capsule-done')을 정확히 1개 연다.
//   수리 전 RED 계약: #39578 이전 main(base) 에선 📌 가 전혀 관측되지 않는다(부모 저장소 비어 있음 — ⑤a 참조).
const REAL_BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const SEAT = 'GP5';
const GOAL = '크론 5개 처리 완료'; // 출처: ⑤a(entry-goalpin5-events-pty.test.ts) — 사람 줄 텍스트가 핀 목표가 되는 같은 문면
const HUMAN_REPLY = 'GP5-DOOR-HUMAN-OK';
const WATCH_REPLY = 'GP5-DOOR-WATCH-OK';
const CAPSULE_ID = `gp5-door-capsule-${Date.now().toString(36)}`;

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

test('감시줄(캡슐 계열 idle-wake-door) 사건 턴 뒤에도 실 TUI 📌 목표가 유지된다', async () => {
  const base = mkdtempSync(join(SOCKET_SAFE_TMP, 'goalpin5-door-'));
  const root = join(base, 'seats', SEAT);
  const home = join(base, 'home');
  const screens: Record<string, string> = {};
  const pinned = (screen: string) => screen.includes('📌');
  // JUD-B HOLD 필수 1(#133635 — r5 수리): 📌 존재만이 아니라 같은 GOAL 원문을 핀 절(부모 핀 상태 렌더링 —
  // status-line.ts 431-437 · human-goal-pin.ts ④)에서 직접 대조한다. 변이(아이콘만 남은 목표 교체/삭제)엔 실패해야 한다.
  const pinnedClause = (screen: string) => screen.split('\n').find((line) => line.includes('📌')) ?? '';
  const pinnedGoalKept = (screen: string, goal: string) => pinnedClause(screen).includes(goal);
  const mutatePinnedGoal = (screen: string, mutate: (clause: string) => string) =>
    screen.split('\n').map((line) => (line.includes('📌') ? mutate(line) : line)).join('\n');
  let passed = false;
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true }); // ⑤a 스캐폴딩 — 부모(TUI) 핀 저장소 자리
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const runId = `gp5-door-${Date.now().toString(36)}`;
    // The test-owned wrapper (#39666 판본): argv[0] path ≠ …/bin/elanous.mjs ⇒ slow-path spawn — the wrapper
    // ITSELF becomes the fake chat child (`repl --session … --json --stdin-jsonl --next-tui`). 사람 첫 턴
    // (GOAL 문면)에 HUMAN_REPLY 로 답한 뒤, 자기 REAL stderr 에 캡슐-done 프레임 1개(실 와이어)를 쓴다.
    const wrapper = join(root, 'tui-wrapper.mjs');
    writeFileSync(wrapper, [
      `const REAL_BIN = ${JSON.stringify(REAL_BIN)};`,
      `const CAPSULE_ID = ${JSON.stringify(CAPSULE_ID)};`,
      `const GOAL = ${JSON.stringify(GOAL)};`,
      `const HUMAN_REPLY = ${JSON.stringify(HUMAN_REPLY)};`,
      `const WATCH_REPLY = ${JSON.stringify(WATCH_REPLY)};`,
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
      `  // 캡슐 문면(#39666 KNOCK_ASK 판본 매칭: 'capsule:')에는 WATCH_REPLY 로 답한다.`,
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
      `      const answer = prompt.includes(GOAL) ? HUMAN_REPLY : prompt.includes('capsule:') ? WATCH_REPLY : 'GP5-DOOR-OTHER';`,
      `      process.stdout.write(JSON.stringify({ event: 'delta', turnId: id, text: answer, source: 'assistant-text' }) + '\\n');`,
      `      try { if (SESS && ROOT) require('node:fs').appendFileSync(ROOT + '/' + SESS + '.jsonl', JSON.stringify({ role: 'assistant', content: answer, ts: new Date().toISOString(), replyFinal: true }) + '\\n'); } catch { /* session file best-effort */ }`,
      `      process.stdout.write(JSON.stringify({ event: 'result', turnId: id, text: answer }) + '\\n');`,
      `      if (prompt.includes(GOAL)) {`,
      `        // 사람 첫 턴 답변 뒤 — 캡슐-done 프레임 1개를 REAL stderr(프레임 와이어)에 쓴다.`,
      `        const startedAt = Date.now() - 60_000;`,
      `        const endedAt = Date.now() - 15_000;`,
      `        process.stderr.write('ELANOUS_TUI_CAPSULE\\t' + JSON.stringify({`,
      `          type: 'capsule-done', capsuleId: CAPSULE_ID, kind: 'agent', sessionId: SESS,`,
      `          startedAt, endedAt, status: 'ok', summary: 'gp5 door · ok · 60s',`,
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
        HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_RUN_ID: runId,
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen), timeoutMs: 120_000 },
      steps: [
        // 사람 줄: 목표 핀 생성(④ 부모 저장소) — 턴 종료 화면에 GP5-DOOR-HUMAN-OK + 📌 관측(③).
        { label: 'person pins goal', text: GOAL, timeoutMs: 240_000,
          until: (screen) => { screens.human = screen; return screen.includes(HUMAN_REPLY) && pinned(screen); } },
        // 감시줄 사건 턴: 실 PASSIVE_RESULT_IDLE_WAKE_MS(120 s — 압축 금지)가 무르익으면 자동 캡슐 턴이
        // 열리고 그 화면에 GP5-DOOR-WATCH-OK + 여전히 📌.
        { label: 'capsule door automatic turn (real 120 s ripen)', text: '', enter: false, timeoutMs: 300_000,
          until: (screen) => { screens.watch = screen; return screen.includes(WATCH_REPLY) && pinned(screen); } },
      ],
    });
    expect(run.exitCode).toBe(0);
    // (a) 첫 턴 settles 뒤 화면에 📌 관측.
    expect(screens.human).toContain('📌');
    // (b) 120초 실숙성 뒤 자동 캡슐 턴 — 화면에 GP5-DOOR-WATCH-OK + 여전히 📌 (측정값, 가정 아님).
    expect(screens.watch).toContain(WATCH_REPLY);
    expect(screens.watch).toContain('📌');
    // (b2) r5(JUD-B #133635 mustFix ①): 사건 전(사람 턴)·후(캡슐 자동 턴) 화면의 핀 절이 같은 GOAL 원문을 그대로 담는다(부모 핀 상태 직접 대조).
    expect(pinnedGoalKept(screens.human, GOAL)).toBe(true);
    expect(pinnedGoalKept(screens.watch, GOAL)).toBe(true);
    // (b3) r5(JUD-B #133635 mustFix ②): 아이콘만 남고 목표가 다른 값으로 바뀐/지워진 변이(실채취 파생)는 위 단언이 실패(RED)해야 한다.
    expect(pinnedGoalKept(mutatePinnedGoal(screens.watch, (clause) => clause.replace(GOAL, '전혀 다른 목표')), GOAL)).toBe(false);
    expect(pinnedGoalKept(mutatePinnedGoal(screens.watch, (clause) => clause.replace(GOAL, '')), GOAL)).toBe(false);
    // (c) LogStore 영수(#39666 runRows 판본): 프레임 실 수신(listeners ≥ 1)과 실 엔트리 체인 자동 턴 정확히 1개.
    const rows = runRows(root, runId);
    const received = rows.filter((row) => row.event === 'turn-life:capsule-done-received' && row.data.capsuleId === CAPSULE_ID);
    expect(received).toHaveLength(1);
    expect(Number(received[0]!.data.listeners)).toBeGreaterThan(0);
    const starts = rows.filter((row) => row.event === 'turn-life:turn-start');
    const human = starts.filter((row) => row.data.door === 'human');
    const automatic = starts.filter((row) => row.data.door !== 'human');
    expect(human).toHaveLength(1);
    expect(automatic).toHaveLength(1);
    expect(automatic[0]!.data.door).toBe('queue-notice');
    expect(automatic[0]!.data.source).toBe('capsule-done');
    // ...and it started AFTER the frame was received (causality, not coincidence).
    expect(automatic[0]!.at).toBeGreaterThan(received[0]!.at);
    // 세 번째 턴 없음 — 프레임 1개가 턴도 정확히 1개만 열었다(중복 제거 유지).
    expect(starts).toHaveLength(2);
    passed = true;
  } finally {
    // 성공 때만 정리 — 실패 시 상태(wrapper·로그)를 남겨 진단한다(⑤a finally 판본).
    if (passed) rmSync(base, { recursive: true, force: true });
    else console.error(`[goalpin5-door] 상태 보존(진단): ${base} · root=${root}`);
  }
}, 600_000);
