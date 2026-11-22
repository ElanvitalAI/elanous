import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';

// CAPSULE-B4-HARNESS-DONE-FRAME (B5 queue-bridge wiring, repl/index.ts watchQueueCapsuleDone): the harness child
// (RunShell mode:'bg') ends while the seat is idle, its `shell:<handle>:<n>` completion crosses as one capsule-done
// frame, and the idle door opens exactly one next turn — within 20s, duplicates 0 — judged on the green table row.
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
}, 150_000); // 출처: 부팅 ⊕ 자식 15s ⊕ 깨어남 ≤20s ⊕ 중복 창 5s ⊕ 정리 — RED-A 실측 wallMs 21725 (seed-7)
