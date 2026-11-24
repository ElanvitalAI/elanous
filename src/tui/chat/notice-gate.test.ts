import { expect, test } from 'bun:test';
import { createNoticeGate, nextNoticeRows } from './notice-gate.js';

// TUI-NOTICE-QUIET (대표 11-24 11:5x · 12:1x 정정): the stack the CEO saw after one turn. Literals, not product constants.
const CEO_STACK = [
  '[notice · seat-mail] auto-submitted',
  '↻ Resuming (scheduled check)',
  'Steer applied',
  '⟳ 재기동 필요 (새 판 ad567382bc41)',
  '🤖 연방 공보 근거 작성 발송 · ok · 80s',
  '✓ Results ready 22',
  '⏰ 예약 깨움 12:15: 착지 점검',
];

function gateWithLog() {
  const logged: Array<[string, string]> = [];
  const gate = createNoticeGate((kind, line) => { logged.push([kind, line]); });
  return { gate, logged };
}

test('the stack keeps the restart line once and the sub-agent row; the bookkeeping rows are logged, not drawn', () => {
  const { gate, logged } = gateWithLog();
  let shown: string[] = [];
  for (let turn = 0; turn < 3; turn += 1) {
    for (const line of CEO_STACK) {
      const admitted = gate.admit(line, shown);
      if (admitted !== null) shown = [...shown, admitted].slice(-3);
    }
  }
  expect(shown).toEqual(['⟳ 재기동 필요 (새 판 ad567382bc41)', '🤖 연방 공보 근거 작성 발송 · ok · 80s']);
  // Everything dropped is still observable, each text once.
  expect(logged).toEqual([
    ['auto-submitted', '[notice · seat-mail] auto-submitted'],
    ['resume-banner', '↻ Resuming (scheduled check)'],
    ['steer-applied', 'Steer applied'],
    ['results-ready', '✓ Results ready 22'],
    ['wake-echo', '⏰ 예약 깨움 12:15: 착지 점검'],
    ['restart-repeat', '⟳ 재기동 필요 (새 판 ad567382bc41)'],
    ['duplicate', '🤖 연방 공보 근거 작성 발송 · ok · 80s'],
  ]);
});

test('a restart notice for the build the footer already shows is not repeated; a newer build is', () => {
  const { gate } = gateWithLog();
  gate.noteSticky('⟳ 재기동 필요 (새 판 ad567382bc41)');
  expect(gate.admit('⟳ 재기동 필요 (새 판 ad567382bc41)', [])).toBeNull();
  expect(gate.admit('⟳ 재기동 필요 (새 판 0123456789ab)', [])).toBe('⟳ 재기동 필요 (새 판 0123456789ab)');
});

test('failure notices stay — a failed wake and a failed sub-agent included', () => {
  const { gate, logged } = gateWithLog();
  expect(gate.admit('🤖 연방 공보 근거 작성 발송 · failed · 80s', [])).toBe('🤖 연방 공보 근거 작성 발송 · failed · 80s');
  expect(gate.admit('⏰ 예약 깨움 처리 실패(w1): 착지 점검', [])).toBe('⏰ 예약 깨움 처리 실패(w1): 착지 점검');
  expect(gate.admit('Turn failed: provider timeout', [])).toBe('Turn failed: provider timeout');
  expect(logged).toEqual([]);
});

test('footer background row: «Results ready N» drops, running work and warnings stay', () => {
  const { gate, logged } = gateWithLog();
  expect(gate.backgroundRow('⧗ Background 1 · ✓ Results ready 1')).toBe('⧗ Background 1');
  expect(gate.backgroundRow('✓ Results ready 22')).toBeNull();
  expect(gate.backgroundRow('⚠ Promised background work missing')).toBe('⚠ Promised background work missing');
  gate.backgroundRow('✓ Results ready 22'); // repainting the same footer does not log again
  expect(logged).toEqual([['results-ready', '✓ Results ready 1'], ['results-ready', '✓ Results ready 22']]);
});

// TUI-WAKE-NOTICE-HIDDEN (대표 11-24 22:5x): the lines the CEO saw pinned under the transcript. Literals.
test('wake deferral and time-wait lines are logged, not drawn', () => {
  const { gate, logged } = gateWithLog();
  let rows: string[] = [];
  rows = nextNoticeRows(rows, { kind: 'notice', line: '⏰ 예약 깨움 대기(w48): #145133 CC-2 착지 점검 — NotIdle · 턴이 끝나면 즉시 깨운다' }, gate);
  rows = nextNoticeRows(rows, { kind: 'notice', line: '⏳ Waiting for time 23:02 KST' }, gate);
  expect(rows).toEqual([]);
  expect(logged).toEqual([
    ['wake-defer', '⏰ 예약 깨움 대기(w48): #145133 CC-2 착지 점검 — NotIdle · 턴이 끝나면 즉시 깨운다'],
    ['time-wait', '⏳ Waiting for time 23:02 KST'],
  ]);
  // Other waits and failures still show.
  expect(gate.admit('⏳ Waiting for pr #40001', [])).toBe('⏳ Waiting for pr #40001');
  expect(gate.admit('⏰ 예약 파일이 손상돼 예약·취소를 거부한다', [])).toBe('⏰ 예약 파일이 손상돼 예약·취소를 거부한다');
});

test('a person utterance after a notice leaves no notice row below it', () => {
  const { gate } = gateWithLog();
  let rows: string[] = [];
  rows = nextNoticeRows(rows, { kind: 'notice', line: '⏰ 예약 깨움 대기(w48): #145133 CC-2 — NotIdle · 턴이 끝나면 즉시 깨운다' }, gate);
  rows = nextNoticeRows(rows, { kind: 'notice', line: 'mail relay failed: timeout' }, gate);
  expect(rows).toEqual(['mail relay failed: timeout']);
  rows = nextNoticeRows(rows, { kind: 'person' }, gate);
  expect(rows).toEqual([]);
});
