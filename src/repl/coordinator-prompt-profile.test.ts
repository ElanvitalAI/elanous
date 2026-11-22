// SEAT-COORDINATOR-PROMPT-PROFILE — 시험 우주(임시 홈·임시 자리) 프롬프트 조립 수준 확인:
// OP 자리의 조립된 시스템 프롬프트에는 코딩 lifecycle·앱 빌더 힌트·트리·GPT-6 «persist» 덧말이 없고 조율자 프로필이 있다.
// 손 자리(TC)는 종전 조립 그대로. 기대값은 독립 리터럴(제품 상수 재사용 금지).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReplSystemPrompt } from './index.js';
import { resetSeatBootCacheForTest } from '../seat/seat-boot-preamble.js';
import { resetUniversalPreambleCache, setGlobalAnchorPathForTest } from '../prompt-library/universal-preamble.js';
import { MsgStore } from '../msg/msg-store.js';
import type { UserConfig } from '../user-config/types.js';

const cfg = {
  llm: { model: 'gpt-6.1-terra' },
  chat: { conciseness: 'balanced', toolDeny: [] },
} as unknown as UserConfig;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalAnchorPathForTest(undefined);
  resetUniversalPreambleCache();
  resetSeatBootCacheForTest();
});

function assemble(seat: string): string {
  const home = mkdtempSync(join(tmpdir(), `coord-profile-${seat}-`));
  const cwd = join(home, 'elanous-hq', 'seats', seat);
  mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
  mkdirSync(join(cwd, 'notes'), { recursive: true });
  writeFileSync(join(cwd, 'AGENTS.local.md'), `역할 = ${seat} 자리\n`);
  writeFileSync(join(cwd, 'notes', 'a.md'), 'x\n');
  const msgPath = join(home, 'state', 'msg', 'messages.db');
  const store = new MsgStore(msgPath);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  setGlobalAnchorPathForTest(null);
  resetUniversalPreambleCache();
  resetSeatBootCacheForTest();
  return buildReplSystemPrompt({
    cfg,
    enabledToolNames: ['Read', 'Bash'],
    cwd,
    sessionId: `coord-profile-${seat}`,
    seatBootDeps: { home, msgPath, env: {} },
  }) ?? '';
}

describe('OP seat assembled system prompt = coordinator profile', () => {
  test('OP: no coding lifecycle / app-builder hint / tree / GPT-6 persist — coordinator profile instead', () => {
    const prompt = assemble('OP');
    expect(prompt).not.toContain('# Coding Agent Pipelines');
    expect(prompt).not.toContain('tailscale serve');
    expect(prompt).not.toContain('## Project Layout');
    expect(prompt).not.toContain('Autonomy and persistence');
    expect(prompt).toContain('## 조율자 프로필');
    expect(prompt).toContain('역할 = OP 자리');
  });

  test('TC (hand seat): current prompt unchanged — lifecycle, app hint, tree, GPT-6 addendum', () => {
    const prompt = assemble('TC');
    expect(prompt).toContain('# Coding Agent Pipelines');
    expect(prompt).toContain('tailscale serve status --json');
    expect(prompt).toContain('## Project Layout');
    expect(prompt).toContain('Autonomy and persistence');
    expect(prompt).not.toContain('## 조율자 프로필');
    expect(prompt).toContain('역할 = TC 자리');
  });
});
