import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLASH_COMMANDS } from '../src/chat/index.js';
import { HELP_GROUP_BY_NAME } from '../src/dashboard/slash-runtime/help-groups.js';

// MISSION-FABRIC-REMOVAL(대표 11-05) — /mission 은 두 TUI 의 등록·카탈로그·help 어디에도 다시 들어오지 않는다.
test('/mission 은 슬래시 카탈로그·help 그룹·next TUI 진입에 없다', () => {
  expect(SLASH_COMMANDS.map((command) => command.name)).not.toContain('mission');
  expect(SLASH_COMMANDS.some((command) => command.aliases.includes('mission'))).toBe(false);
  expect(HELP_GROUP_BY_NAME.has('mission')).toBe(false);
  const entry = readFileSync(join(import.meta.dir, '..', 'src', 'tui', 'entry.ts'), 'utf8');
  expect(entry).not.toMatch(/slash\/mission|mission-tui-watch|submitted === '\/mission'/);
  // /signals 는 next TUI 에 남는다.
  expect(entry).toContain("slashHandlers.set('signals', handleSignalsSlash)");
});
