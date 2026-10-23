// ── CFG-STORE2-HISTORY-REVERT · 장치 신뢰성 시험 ──
//
// 이 시험이 먼저 통과해야, 아래 roundtrip 시험(config-audit.test.ts)의 실패가
// «장치가 못 재서» 가 아니라 «생산 코드에 history/revert 가 없어서» 임이 구별된다.

import { afterAll, describe, expect, test } from 'bun:test';
import { MASK } from '../cli/config-audit.js';
import { createCliConfigAuditDevice } from './cli-config-audit-device.js';

const device = createCliConfigAuditDevice();
afterAll(() => device.dispose());

describe('ux-sim · config 감사 장치', () => {
  test('실 CLI set 이 값을 저장하고 감사 행으로 남긴다', async () => {
    const turn = await device.set('llm.model', 'model-a');
    expect(turn.exitCode).toBe(0);
    expect(device.value('llm.model')).toBe('model-a');

    const rows = device.ledger('llm.model');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'llm.model', prev: null, next: '"model-a"' });
  }, 20_000);

  test('장치는 여러 턴에 걸쳐 같은 원장을 관측한다', async () => {
    await device.set('llm.model', 'model-b');
    const rows = device.ledger('llm.model');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ prev: '"model-a"', next: '"model-b"' });
  }, 20_000);

  test('비밀 원문은 원장·history 출력에 남지 않고 MASK 로만 남는다', async () => {
    const secret = 'sk-device-secret-0123456789';
    const turn = await device.set('llm.apiKey', secret);
    expect(turn.exitCode).toBe(0);

    const rows = device.ledger('llm.apiKey');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prev: null, next: MASK });
    expect(device.ledgerText()).not.toContain(secret);
    expect(device.ledgerText()).toContain(MASK);

    const history = await device.history('llm.apiKey');
    expect(history.stdout).not.toContain(secret);
    expect(history.stdout).toContain(MASK);
  }, 20_000);

  test('허용 목록 밖 명령은 장치가 거부한다', async () => {
    const turn = await device.run('config', 'path');
    expect(turn.exitCode).not.toBe(0);
    expect(device.value('llm.model')).toBe('model-b');
  }, 20_000);
});
