// 서피스 게이팅 정리(2026-07-22) — finance 팩이 텔레그램 전용이던 파편화 해소 가드.
// toolSurface('chat'/'webterm', cfg) 가 financeEnabled 시 finance_* 를 노출하는지 배선 고정.
import { test, expect, describe } from 'bun:test';
import { toolSurface } from './index.js';
import type { UserConfig } from '../../user-config/types.js';

// financeEnabled(cfg) = cfg.finance?.enabled === true 만 본다 → 최소 스텁으로 충분.
const cfgWith = (enabled: boolean): UserConfig => ({ finance: { enabled } } as unknown as UserConfig);

describe('toolSurface — finance 팩 서피스 게이팅(텔레그램 파리티)', () => {
  test('chat + financeEnabled → finance_* 노출(finance_quote·finance_kr_flow)', () => {
    const s = toolSurface('chat', cfgWith(true));
    const names = s.specs.map((t) => t.name);
    expect(names).toContain('finance_quote');
    expect(names).toContain('finance_kr_flow');
    expect(names).toContain('finance_attractiveness');
  });

  test('chat + finance 비활성 → finance_* 미노출(무회귀)', () => {
    const s = toolSurface('chat', cfgWith(false));
    expect(s.specs.map((t) => t.name)).not.toContain('finance_quote');
  });

  test('webterm 도 chat 과 동일하게 finance 노출(공용 dispatchChatTool)', () => {
    const s = toolSurface('webterm', cfgWith(true));
    expect(s.specs.map((t) => t.name)).toContain('finance_quote');
  });

  test('readonly/none 은 finance 무관(코어만)', () => {
    expect(toolSurface('readonly', cfgWith(true)).specs.map((t) => t.name)).not.toContain('finance_quote');
    expect(toolSurface('none', cfgWith(true)).specs).toEqual([]);
  });

  test('chat 은 finance 켜져도 코어 tool 유지(Read/Bash + core)', () => {
    const names = toolSurface('chat', cfgWith(true)).specs.map((t) => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Bash');
  });
});
