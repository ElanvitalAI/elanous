// ⛔ 이 테스트가 왜 있나 — 배선 검사기가 «죽었는데 아무도 몰랐다»(2026-08-04).
//    package.json 에 등록돼 있지만 어떤 게이트도 부르지 않아, 카탈로그 필드 개명
//    (#6928 surface → host)으로 던지기 시작한 뒤 산출이 한 번도 안 나왔다.
//    ⇒ ⭐ 그래서 「내용이 옳은가」가 아니라 «도는가»를 묶는다. 그 둘은 다른 축이다.
import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('check-native-tool-wiring 스크립트', () => {
  test('⭐ 던지지 않고 «산출»을 낸다 — 내용이 아니라 생사를 잰다', () => {
    const r = spawnSync('bun', ['run', 'scripts/check-native-tool-wiring.ts'], {
      cwd: REPO, encoding: 'utf8', timeout: 120_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    // ⛔ 던지면 여기서 걸린다 — 이 한 줄이 없어서 개명 잔재가 살아남았다.
    expect(out).not.toContain('TypeError');
    expect(r.status).toBe(0);                       // informational 모드는 0 을 낸다
    // ⭐ 「0바이트·exit 0」을 통과로 읽지 않는다 — 산출이 «있어야» 한다(R-SRCH3 ③).
    expect(out).toContain('[check-native-tool-wiring]');
  });

  // ⛔ 이 스크립트가 «게이트에 물려 있지 않다»는 사실 자체를 기록해 둔다.
  //    붙이는 판단은 245 issue 를 분류한 «뒤»다 — 분류 없이 붙이면 오탐을 근거로 코드를 고치게 된다.
  test('⚠️ 아직 게이트에 안 붙어 있다 — 붙이는 판단은 issue 분류 뒤다', () => {
    const pkg = JSON.parse(
      require('node:fs').readFileSync(join(REPO, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:tool-wiring']).toContain('check-native-tool-wiring');
    // test:deterministic 이 이 스크립트를 «부르지 않는다»는 현재 사실을 고정한다.
    expect(pkg.scripts['test:deterministic']).not.toContain('check-native-tool-wiring');
  });
});
