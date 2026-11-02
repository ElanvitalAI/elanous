import { describe, expect, test } from 'bun:test';
import { groupDispatcherCycles, parseDispatcherEvents, runEntranceDispatchShadow } from './entrance-dispatch-shadow.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('entrance dispatch shadow log windows', () => {
  test('parses only dispatcher launch and skip decisions', () => {
    const events = parseDispatcherEvents([
      '23:58:50 [OP] 발사 CELL-A(OP · 0.2.43) ta-1 launched model · Pod 3',
      '23:58:55 [OP] 겹침 발사 CELL-D — 열린 PR · overlapBlock=false',
      '23:59:00 [OP] 발사 실패 CELL-E — 카드 없음',
      '23:59:10 [OP] 건너뜀 CELL-B — hold gate',
      '23:59:20 [OP] 발사 CELL-C(OP · 0.2.43) ta-2 not launched · Pod 3',
      '23:59:20 [OP] unrelated output',
    ].join('\n'), new Date('2026-10-30T15:00:00.000Z'));
    expect(events.map(event => [event.kind, event.cellId])).toEqual([
      ['launch', 'CELL-A'], ['skip', 'CELL-D'], ['skip', 'CELL-E'], ['skip', 'CELL-B'], ['skip', 'CELL-C'],
    ]);
    expect(events[0]?.at).toBe('2026-10-30T14:58:50.000Z');
  });

  test('starts a new cycle when timestamp gap reaches configured sleep, including midnight rollover', () => {
    const events = parseDispatcherEvents([
      '23:58:50 [OP] 발사 CELL-A(OP · 0.2.43) ta-1 launched',
      '23:59:10 [OP] 건너뜀 CELL-B — hold gate',
      '00:04:10 [OP] 발사 CELL-C(OP · 0.2.43) ta-2 launched',
    ].join('\n'), new Date('2026-10-30T15:00:00.000Z'));
    const cycles = groupDispatcherCycles(events, 300);
    expect(cycles).toHaveLength(2);
    expect(cycles.map(cycle => cycle.events.map(event => event.cellId))).toEqual([['CELL-A', 'CELL-B'], ['CELL-C']]);
    expect(Date.parse(cycles[1]!.startedAt)).toBeGreaterThan(Date.parse(cycles[0]!.endedAt));
  });

  test('keeps sub-threshold events in a cycle', () => {
    const anchor = new Date('2026-10-30T15:00:00.000Z');
    const events = parseDispatcherEvents([
      '16:00:00 [OP] 발사 CELL-A(OP · 0.2.43) ta-1 launched',
      '16:04:59 [OP] 건너뜀 CELL-B — unavailable',
    ].join('\n'), anchor);
    expect(groupDispatcherCycles(events, 300)).toHaveLength(1);
  });

  test('keeps live parity unmeasured without an isolated picker fixture and does not persist state', () => {
    const root = mkdtempSync(join(tmpdir(), 'entrance-shadow-contract-test-'));
    const hqRoot = join(root, 'elanous-hq');
    const home = join(root, 'home');
    const feeder = join(hqRoot, 'seat-state', 'OP', 'feeder');
    const boardDir = join(feeder, 'board-OP');
    mkdirSync(boardDir, { recursive: true });
    mkdirSync(join(home, '.elanous'), { recursive: true });
    writeFileSync(join(hqRoot, 'seat-state', 'OP', 'traffic.json'), JSON.stringify({ versions: ['0.2.45'], cycleSec: 300 }));
    writeFileSync(join(boardDir, 'board.tsv'), 'version\tcell\n');
    writeFileSync(join(boardDir, 'board-0.2.45.json'), JSON.stringify({ items: [] }));
    writeFileSync(join(home, '.elanous', 'task-agent-actions.json'), JSON.stringify({ tasks: [] }));
    writeFileSync(join(feeder, 'dispatcher-OP.out'), '23:58:50 [OP] 발사 CELL-A(OP · 0.2.45) ta-1 launched\n');
    const privateState = join(home, '.elanous', 'entrance-dispatch-shadow');
    try {
      const summary = runEntranceDispatchShadow({ hqRoot, home, now: new Date('2026-10-30T15:00:00.000Z'), log: () => undefined });
      expect(summary).toMatchObject({
        graphPicks: [],
        graphPickError: 'contract-only: production snapshot producer and isolated picker fixture are not implemented',
        comparedCycles: 0,
        exactPickAgreement: null,
        decisionRecord: { decision: 'would-skip', reason: 'input-unknown', launched: false },
      });
      expect(summary.agreementReason).toContain('unmeasured');
      expect(existsSync(privateState)).toBe(false);

      const dispatcherLog = join(feeder, 'dispatcher-OP.out');
      rmSync(dispatcherLog);
      const missingLog = runEntranceDispatchShadow({ hqRoot, home, now: new Date('2026-10-30T15:00:00.000Z'), log: () => undefined });
      expect(missingLog.stableInputs).toBe(false);
      expect(missingLog.missingInputs).toContain('dispatcher-OP');

      writeFileSync(dispatcherLog, '23:58:50 [OP] 발사 CELL-A(OP · 0.2.45) ta-1 launched\n');
      const invalidTraffic = join(hqRoot, 'seat-state', 'OP', 'traffic.json');
      writeFileSync(invalidTraffic, JSON.stringify({ versions: ['0.2.45'], cycleSec: 'five minutes' }));
      const malformedConfig = runEntranceDispatchShadow({ hqRoot, home, now: new Date('2026-10-30T15:00:00.000Z'), log: () => undefined });
      expect(malformedConfig.stableInputs).toBe(false);
      expect(malformedConfig.invalidInputs).toContain('traffic');
      expect(malformedConfig.trafficConfigError).toBe('invalid-cycleSec');

      writeFileSync(invalidTraffic, '{not-json');
      const invalidJson = runEntranceDispatchShadow({ hqRoot, home, now: new Date('2026-10-30T15:00:00.000Z'), log: () => undefined });
      expect(invalidJson.stableInputs).toBe(false);
      expect(invalidJson.invalidInputs).toContain('traffic');
      expect(invalidJson.trafficConfigError).toBe('invalid-json');

      writeFileSync(invalidTraffic, JSON.stringify({ versions: ['0.2.45'], cycleSec: 300 }));
      const racedRead = runEntranceDispatchShadow({
        hqRoot, home, now: new Date('2026-10-30T15:00:00.000Z'), log: () => undefined,
        readText: path => {
          if (path === dispatcherLog) {
            rmSync(dispatcherLog);
            throw new Error('mock file disappeared after initial digest');
          }
          return readFileSync(path, 'utf8');
        },
      });
      expect(racedRead.stableInputs).toBe(false);
      expect(racedRead.unstableInputs).toContain('dispatcher-OP');
      expect(racedRead.readErrors).toContainEqual({ input: 'dispatcher-OP', reason: 'unreadable-after-digest' });

      const racedTraffic = runEntranceDispatchShadow({
        hqRoot, home, now: new Date('2026-10-30T15:00:00.000Z'), log: () => undefined,
        readText: path => {
          if (path === invalidTraffic) {
            rmSync(invalidTraffic);
            throw new Error('mock traffic disappeared after initial digest');
          }
          return readFileSync(path, 'utf8');
        },
      });
      expect(racedTraffic.stableInputs).toBe(false);
      expect(racedTraffic.unstableInputs).toContain('traffic');
      expect(racedTraffic.readErrors).toContainEqual({ input: 'traffic', reason: 'unreadable-after-digest' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
