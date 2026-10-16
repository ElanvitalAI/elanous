// TUI-SLASH-SPLIT-TERM(D4b) — /term·/terminal 을 src/tui/slash/term.ts 로 «순수 이동»한 뒤의 등록 계약.
// 행위(하위 명령별 출력·부작용)는 test/dashboard-term-slash-runtime.test.ts 가 문다 — 여기는 자리·별칭·shim 만.
import { describe, expect, test } from 'bun:test';
import { buildDashboardSlashRegistry } from '../src/dashboard/slash-runtime/dashboard-handlers.js';
import * as oldEntry from '../src/dashboard/slash-runtime/index.js';
import { SlashCommandRegistry } from '../src/dashboard/slash-runtime/registry.js';
import { handleTermSlash, registerTermSlash, type TermSlashContext } from '../src/tui/slash/term.js';

describe('/term 등록 (src/tui/slash/term.ts)', () => {
  test('대시보드 레지스트리에 옛 자리(ad 다음 · local 앞)에 별칭 둘로 한 번만 등록된다', () => {
    const names = buildDashboardSlashRegistry().names();
    expect(names.filter((n) => n === 'term')).toHaveLength(1);
    expect(names.filter((n) => n === 'terminal')).toHaveLength(1);
    const at = names.indexOf('term');
    expect(names.slice(at - 1, at + 3)).toEqual(['ad', 'term', 'terminal', 'local']);
  });

  test('옛 입구(slash-runtime/index.ts)가 새 집의 공개 심볼을 그대로 낸다', () => {
    expect(oldEntry.registerTermSlash).toBe(registerTermSlash);
    expect(oldEntry.handleTermSlash).toBe(handleTermSlash);
  });

  test('registerTermSlash 는 빈 레지스트리에 term·terminal 만 단다', () => {
    const reg = new SlashCommandRegistry<TermSlashContext, never>();
    registerTermSlash(reg);
    expect(reg.names()).toEqual(['term', 'terminal']);
  });
});
