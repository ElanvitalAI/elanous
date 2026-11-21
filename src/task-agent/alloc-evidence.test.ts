import { expect, test } from 'bun:test';
import { activeCardAllocation, observeTargetOnAllocatedHost, readCardAllocation } from './alloc-evidence.js';

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

test('(r6 · JUD hold-39396-b626) 원격 프로브는 카드 대상 경로를 불활성 셸 리터럴로 넘긴다 — JSON 따옴표는 셸 이스케이프가 아니다', () => {
  const quote = String.fromCharCode(39); // '
  const backtick = String.fromCharCode(96); // `
  const hostile = `/tmp/x${quote}$(touch pwned)"z; rm -rf ~${backtick}y`;
  // POSIX 단일 인용 이스케이프: ' → '\'' — 안쪽의 $ · ; · ` 는 전부 불활성이어야 한다.
  const posixLiteral = `'${hostile.replaceAll(quote, `${quote}\\${quote}${quote}`)}'`;
  const allocation = activeCardAllocation(`${header}\n${row}\n`, 'ta-card-1', 1000);
  const seen: Array<{ host: string; command: string; timeout: number }> = [];
  const probe = observeTargetOnAllocatedHost({ project: { target: hostile } }, allocation, (host, command, timeout) => {
    seen.push({ host, command, timeout }); return { status: 0, stdout: '' };
  });
  expect(probe).toBe(true);
  expect(seen).toEqual([{ host: 'node-c', command: `test -e ${posixLiteral}`, timeout: 10_000 }]);
  // 현재(결함)의 JSON.stringify 형태가 명령에 그대로 남으면 안 된다.
  expect(seen[0]!.command).not.toContain(JSON.stringify(hostile));
  // 프로브 실패·예외는 여전히 null(UNMEASURED) — ⑥ 관측 법칙은 그대로.
  expect(observeTargetOnAllocatedHost({ project: { target: hostile } }, allocation, () => ({ status: null, stdout: '' }))).toBeNull();
  expect(observeTargetOnAllocatedHost({ project: { target: hostile } }, allocation, () => { throw new Error('ssh down'); })).toBeNull();
});
