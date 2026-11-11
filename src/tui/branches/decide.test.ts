import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { createNextTuiDecideBranchRoute } from './decide.js';

function ledger(title: string): { instance: DecisionLedger; cleanup: () => void } {
  const stateDir = mkdtempSync(join(tmpdir(), 'next-tui-decide-'));
  const instance = new DecisionLedger({
    stateDir,
    now: () => new Date('2026-11-10T00:00:00.000Z'),
    resolveVersion: () => ({ released: '0.3.9', dev: '0.3.9-dev.0', codename: 'test' }),
  });
  instance.raise({
    title, category: 'irreversible', raisedAt: '2026-11-10T00:00:00.000Z',
    scqa: { s: '시뮬 입력', c: '격리 상태에서 답을 선택한다' },
    options: [{ key: 'a', label: '진행', consequence: '실행' }, { key: 'b', label: '보류', consequence: '대기' }],
    recommendation: { option: 'a', why: '검증' }, raisedBy: { agent: 'sim', track: 'OP' },
  });
  return { instance, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('separate Next TUI instances keep numbered snapshots and confirmation state isolated', () => {
  const first = ledger('SESSION-A-DECISION');
  const second = ledger('SESSION-B-DECISION');
  try {
    const firstRoute = createNextTuiDecideBranchRoute(first.instance);
    const secondRoute = createNextTuiDecideBranchRoute(second.instance);
    expect(firstRoute('/decide')).toContain('SESSION-A-DECISION');
    expect(secondRoute('/decide')).toContain('SESSION-B-DECISION');
    expect(firstRoute('/dec 1 a')).toContain('/decide 1 a 확인');
    expect(secondRoute('/dec 1 a 확인')).toContain('/decide 1 a 확인');
    expect(second.instance.list({ status: 'open' })).toHaveLength(1);
    expect(secondRoute('/dec 1 a')).toContain('/decide 1 a 확인');
    expect(secondRoute('/dec 1 a 확인')).toContain('SESSION-B-DECISION → 진행');
    expect(firstRoute('/dec 1 a 확인')).toContain('SESSION-A-DECISION → 진행');
    expect(first.instance.list({ status: 'decided' })).toMatchObject([{ title: 'SESSION-A-DECISION', choice: 'a' }]);
    expect(second.instance.list({ status: 'decided' })).toMatchObject([{ title: 'SESSION-B-DECISION', choice: 'a' }]);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});
