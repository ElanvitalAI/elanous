import { expect, test } from 'bun:test';
import { activeCardAllocation, readCardAllocation } from './alloc-evidence.js';

const header = '시각\t카드\t풀\t모델\t예약id\t공급자\t만료epoch(30분)';
const row = '11-19 12:28:53\tta-card-1\tminih\tterra\talloc-canary-123\tcodex\t2000';
test('only a single unexpired allocation for the actual card yields its host', () => {
  expect(activeCardAllocation(`${header}\n${row}\n`, 'ta-card-1', 1000)).toEqual({ host: 'node-c', allocationId: 'alloc-canary-123', expiresAt: 2000 });
  expect(activeCardAllocation(`${header}\n${row}\n`, 'ta-card-2', 1000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row}\n`, 'ta-card-1', 2000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row}\n${row}\n`, 'ta-card-1', 1000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row}\n${row.replace('2000', '0')}\n`, 'ta-card-1', 1000)).toBeNull();
});
test('malformed ledger, card or matching row is unmeasured', () => {
  expect(activeCardAllocation(`bad\n${row}`, 'ta-card-1', 1000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row}`, 'PENDING-CARD', 1000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row.replace('node-c', 'bad;host')}`, 'ta-card-1', 1000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row.replace('2000', 'Infinity')}`, 'ta-card-1', 1000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row.replace('codex', 'codex [취소]')}`, 'ta-card-1', 1000)).toBeNull();
  expect(activeCardAllocation(`${header}\n${row.replace('codex', 'released OP')}`, 'ta-card-1', 1000)).toBeNull();
});

test('HQ ledger read uses the fixed authority and fails closed on transport errors', () => {
  let call: unknown[] = [];
  const result = readCardAllocation('ta-card-1', 1000, (host, command, timeout) => {
    call = [host, command, timeout]; return { status: 0, stdout: `${header}\n${row}` };
  });
  expect(call).toEqual(['mshq', 'cat ~/elanous-hq/seat-state/RES-INFRA/ALLOC-OK.tsv', 10_000]);
  expect(result?.host).toBe('node-c');
  expect(readCardAllocation('ta-card-1', 1000, () => ({ status: 1, stdout: `${header}\n${row}` }))).toBeNull();
  expect(readCardAllocation('ta-card-1', 1000, () => { throw new Error('unavailable'); })).toBeNull();
});
