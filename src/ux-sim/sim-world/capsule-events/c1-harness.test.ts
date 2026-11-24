import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';

// CAPSULE-B4-HARNESS-DONE-FRAME (B5 queue-bridge wiring, repl/index.ts watchQueueCapsuleDone): the harness child
// (RunShell mode:'bg') ends while the seat is idle, its `shell:<handle>:<n>` completion crosses as one capsule-done
// frame, and the idle door opens exactly one next turn — after the 120s passive ripen (#39609, measured — #39666),
// duplicates 0 — judged on the green table row.
test('C1 harness child end axis passes against the green table row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c1-harness-'));
  try {
    const result = await runSimWorlds({ worldId: 'capsule-events', seed: 1, engine: 'legacy', only: 'C1-HARNESS',
      expectBaseFile: null, stateRoot: root, runId: 'c1-harness', isolate: 'inline' });
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]).toMatchObject({ scenario: 'C1-HARNESS', actual: 'pass', verdict: 'pass' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000); // 출처: 부팅 ⊕ 자식 15s ⊕ passive ripen 120s(#39609, 실측·압축 금지 #39666) ⊕ 중복 창 5s ⊕ 정리
