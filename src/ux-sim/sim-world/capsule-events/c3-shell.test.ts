import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';

// No switch since R1 #38713 (JUD #38673 must ⓐ): the capsule path is the only path. A2 #38578 detaches the 30s Bash past the
// 10s cap and B1 wiring #38676 opens the next turn on its capsule-done — exactly one <task id="shell-…"> request.
test('C3 shell axis passes against the green table row (no env switch)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c3-shell-'));
  try {
    const result = await runSimWorlds({ worldId: 'capsule-events', seed: 1, engine: 'legacy', only: 'C3',
      expectBaseFile: null, stateRoot: root, runId: 'c3-shell', isolate: 'inline' });
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]).toMatchObject({ scenario: 'C3', actual: 'pass', verdict: 'pass' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000); // 출처: 부팅 ≤60s ⊕ 정착 20s ⊕ 완료 50s ⊕ 중복 창 5s ⊕ 정리 — 부하 호스트(node-b 120s 초과 실측)
