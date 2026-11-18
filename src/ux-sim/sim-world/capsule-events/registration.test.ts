import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSimWorldExpectTable } from '../expect.js';
import { isReservedSimWorldId } from '../kernel.js';
import { simWorldScenarios } from './scenarios.js';

test('capsule-events registers C1, C7, the C3 shell axis (green), the renamed C1-MAIL scene and C2 with literal reasons', () => {
  const world = join(import.meta.dir, '../../worlds');
  const pack = parseYaml(readFileSync(join(world, 'sim-world-capsule-events.yaml'), 'utf8'));
  const table = parseSimWorldExpectTable(readFileSync(join(world, 'sim-world-expect.json'), 'utf8'));
  expect(isReservedSimWorldId('capsule-events')).toBe(true);
  expect(pack.world).toBe('capsule-events');
  expect(pack.scenarios).toEqual([{ id: 'C1', module: 'src/ux-sim/sim-world/capsule-events/scenarios.ts' },
    { id: 'C7', module: 'src/ux-sim/sim-world/capsule-events/c7-mcp.ts' },
    { id: 'C3', module: 'src/ux-sim/sim-world/capsule-events/c3-shell.ts' },
    { id: 'C1-MAIL', module: 'src/ux-sim/sim-world/capsule-events/c3-mail.ts' },
    { id: 'C2', module: 'src/ux-sim/sim-world/capsule-events/c2-mail-tool.ts' }]);
  expect(simWorldScenarios.map(row => row.id)).toEqual(['C1']);
  expect(table.entries['capsule-events/C1']).toEqual({ expect: 'red',
    reason: 'C1 background Agent axis: real Next TUI idle wake, PR #38565',
    redReason: 'background agent end never wakes the turn' });
  expect(table.entries['capsule-events/C7']).toEqual({ expect: 'red',
    reason: 'C7 partial MCP axis; provider, harness, and deadline event remain unmeasured',
    redReason: 'silent MCP holds the main turn' });
  expect(table.entries['capsule-events/C3']).toEqual({ expect: 'green',
    reason: 'C3 shell axis: a real Next TUI Bash past the 10s cap detaches and its capsule-done opens exactly one next turn; Esc, mail/person and three-at-once axes unmeasured',
    greenSince: '#38673 (main with R1 #38713 no switch · B1 wiring #38676)' });
  expect(table.entries['capsule-events/C1-MAIL']).toEqual({ expect: 'red',
    reason: 'C1 mail axis (원천 1a·1b) partial: watcher and plan compete for one unseen mail — scenario id renamed from C3 (sim-owner adjudication · TC-H-CC-3 #90220 → #90474): 정본 §3.6 C3 는 10분 Bash·우편·사람·Esc 축(#38673 이 측정) · 생산 단계 토큰 C3(C3-b 우편 어댑터)는 그대로',
    redReason: 'C3 remaining mail routes unmeasured' });
});
