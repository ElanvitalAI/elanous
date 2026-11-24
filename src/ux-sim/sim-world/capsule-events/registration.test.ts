import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSimWorldExpectTable } from '../expect.js';
import { isReservedSimWorldId } from '../kernel.js';
import { simWorldScenarios } from './scenarios.js';

test('capsule-events registers one default C1 and the other scenes with literal reasons', () => {
  const world = join(import.meta.dir, '../../worlds');
  const pack = parseYaml(readFileSync(join(world, 'sim-world-capsule-events.yaml'), 'utf8'));
  const table = parseSimWorldExpectTable(readFileSync(join(world, 'expect', 'capsule-events.json'), 'utf8'));
  expect(isReservedSimWorldId('capsule-events')).toBe(true);
  expect(pack.world).toBe('capsule-events');
  expect(pack.scenarios).toEqual([{ id: 'SEAT-STEER-PREEMPT-137', module: 'src/ux-sim/sim-world/capsule-events/steer-preempt.ts' },
    { id: 'SEAT-CAPSULE-NO-REPEAT-REPORT', module: 'src/ux-sim/sim-world/capsule-events/c8-no-repeat.ts' },
    { id: 'C1', module: 'src/ux-sim/sim-world/capsule-events/scenarios.ts' },
    { id: 'S3-AGENT', module: 'src/ux-sim/sim-world/capsule-events/s3-agent.ts' },
    { id: 'S3-TURN', module: 'src/ux-sim/sim-world/capsule-events/s3-parent-turn.ts' },
    { id: 'C7', module: 'src/ux-sim/sim-world/capsule-events/c7-mcp.ts' },
    { id: 'C3', module: 'src/ux-sim/sim-world/capsule-events/c3-shell.ts' },
    { id: 'C3-TRIO', module: 'src/ux-sim/sim-world/capsule-events/c3-trio.ts' },
    { id: 'C1-MAIL', module: 'src/ux-sim/sim-world/capsule-events/c3-mail.ts' },
    { id: 'C2', module: 'src/ux-sim/sim-world/capsule-events/c2-mail-tool.ts' },
    { id: 'C5', module: 'src/ux-sim/sim-world/capsule-events/c5-wakeup.ts' },
    { id: 'C6', module: 'src/ux-sim/sim-world/capsule-events/c6-boot-backlog.ts' },
    { id: 'C4', module: 'src/ux-sim/sim-world/capsule-events/c4-agent-background.ts' },
    { id: 'C3-ESC', module: 'src/ux-sim/sim-world/capsule-events/c3-esc-cancel.ts' },
    { id: 'C1-HARNESS', module: 'src/ux-sim/sim-world/capsule-events/c1-harness.ts' },
    { id: 'C9-SESSION-SCOPED', module: 'src/ux-sim/sim-world/capsule-events/c9-session-scoped.ts' }]);
  expect(simWorldScenarios.map(row => row.id)).toEqual(['C1', 'C5', 'C6']);
  expect(table.entries['capsule-events/S3-AGENT']).toMatchObject({
    expect: 'red', redReason: 'S3 production Agent boundary unmeasured',
  });
  expect(table.entries['capsule-events/S3-TURN']).toMatchObject({
    expect: 'green', greenSince: '#38901 isolated mbp seed 1',
  });
  expect(table.entries['capsule-events/C1']).toEqual({ expect: 'green',
    reason: "C1 done-event wake axes (flag removed — capsule behavior always on, CAPSULE-FLAGS-REMOVE-DEFAULT): the background Agent end delivery passes here (exactly one wake turn after the 120s passive ripen — #39609, measured, not compressed #39666 — duplicates 0) and the harness child end frame is green in capsule-events/C1-HARNESS (B4/B5 queue-bridge); the mail axis keeps its own red row capsule-events/C1-MAIL",
    greenSince: '2026-11-21 pool4-capsule-c1-harness' });
  expect(table.entries['capsule-events/C1-HARNESS']).toEqual({ expect: 'green',
    reason: "C1 harness child end axis (CAPSULE-B4-HARNESS-DONE-FRAME · B5 queue-bridge): a RunShell mode:'bg' harness child finishes while the seat is idle, its task-notification crosses as one capsule-done frame and opens exactly one next turn after the 120s passive ripen (#39609 — measured, not compressed, #39666) with duplicates 0 — self-implement-stop ('harness' kind) and graph frames remain unmeasured: sim probes at a 20s window (probe-c1-harness-selfimpl-221754) and a 60s window (probe-b-c1-harness-60s-223600) both record stopCount 0, so the axis stays unmeasured (JUD-B #122985)",
    greenSince: '2026-11-21 pool4-capsule-c1-harness' });
  expect(table.entries['capsule-events/C7']).toEqual({ expect: 'red',
    reason: 'C7 partial MCP axis; provider, harness, and deadline event remain unmeasured',
    redReason: 'silent MCP holds the main turn' });
  expect(table.entries['capsule-events/C3']).toEqual({ expect: 'green',
    reason: 'C3 shell axis: a real Next TUI Bash past the 10s cap detaches and its capsule-done opens exactly one next turn; Esc, mail/person and three-at-once axes unmeasured',
    greenSince: '#38673 (main with R1 #38713 no switch · B1 wiring #38676)' });
  // C3-TRIO(A2 완료선) — parsed green row normalizes away redReason(expect.ts) — the literal locks the parsed shape.
  expect(table.entries['capsule-events/C3-TRIO']).toEqual({ expect: 'green',
    reason: 'A2 완료선(정본 §3.6 C3:805) — 한 assistant 배치의 10분(시뮬 25s) Bash 3개가 분리 배경 캡슐로 모두 살아남고: 메인 턴 idle 복귀 ≤20s · 그 틈 우편·사람 입력이 각각 자기 턴을 즉시 열며 · Bash 완료 3건이 고유 셸 id 로 정확히 한 번씩 사건 턴을 연다(중복 송달 없음 · Esc 생존 축은 정본 C3 에 그대로)',
    greenSince: '2026-11-21 (A2 완료선 PR — 이 PR로 신규 착지)' });
  expect(table.entries['capsule-events/C1-MAIL']).toEqual({ expect: 'red',
    reason: 'C1 mail axis (원천 1a·1b) partial: watcher and plan compete for one unseen mail — scenario id renamed from C3 (sim-owner adjudication · TC-H-CC-3 #90220 → #90474): 정본 §3.6 C3 는 10분 Bash·우편·사람·Esc 축(#38673 이 측정) · 생산 단계 토큰 C3(C3-b 우편 어댑터)는 그대로',
    redReason: 'C3 remaining mail routes unmeasured' });
  // JUD must ⓐ (20261119-1913 · OP #103685): the C5 scene is ok:false by design — c5-wakeup.ts:106
  // 'C5 gate-declined and pty axes unmeasured' and its own test expects false — so the table declares red, not green.
  expect(table.entries['capsule-events/C5']).toEqual({ expect: 'red',
    reason: 'C5 wakeup partial: busy-turn defer and restart axes held (#38725); the takePending gate-decline (D6) and pty axes remain unmeasured',
    redReason: 'C5 gate-declined and pty axes unmeasured' });
  // C6 stays green — its own test observes ok:true (JUD 20261119-1913: «C6 은 자기 시험이 ok:true 라 green 맞음»).
  // The parsed green row normalizes away redReason (expect.ts), so the literal locks the parsed shape.
  expect(table.entries['capsule-events/C6']).toEqual({ expect: 'green',
    reason: 'C6 boot backlog: unread turn-life rows at boot re-open as one backlog window judged on the real turn timeline',
    greenSince: '#38725' });
  expect(table.entries['capsule-events/C4']).toEqual({ expect: 'green',
    reason: 'C4 urgent mail opens within 20s while a background Agent is active; the Agent completion opens one later turn and a progress line is visible. The fake provider compresses the 20-minute hold to 40s.',
    greenSince: '#39444 seed-7 Next TUI scenario' });
  expect(table.entries['capsule-events/C3-ESC']).toEqual({ expect: 'green',
    reason: 'C3 Esc axis: a Bash with a 10-minute timeout remains alive after Esc cancels another turn, then writes its completion marker. The wall-clock hold is bounded to 32s.',
    greenSince: '#39444 seed-7 Next TUI scenario' });
  expect(table.entries['capsule-events/C9-SESSION-SCOPED']).toEqual({ expect: 'green',
    reason: "C9 session scope: two seat sessions built from the tree REPL tools run background RunShell capsules at once and each drain takes only its own completion; an idle seat's supplement Agent completion becomes one queued notice and opens no turn. The shared persisted queue file across REPL processes stays unmeasured (FU).",
    greenSince: 'ELN-CAPSULE-COMPLETION-SCOPED' });
});
