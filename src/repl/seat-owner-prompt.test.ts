import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../user-config/types.js';
import { buildReplSystemPrompt } from './index.js';

const home = mkdtempSync(join(tmpdir(), 'seat-owner-prompt-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, 'elanous-hq', 'seat-state', 'TC-1'), { recursive: true });
const cfg = { llm: {} } as UserConfig;
const seatBootDeps = { home, env: {} };

test('일반 자리 턴마다 조사 전 구조화 참조·주인 확인과 unknown 지침을 싣는다', () => {
  const context = { cfg, enabledToolNames: undefined, cwd: '/workspace/seats/TC-1', seatBootDeps };
  for (const sessionId of ['turn-session-a', 'turn-session-b']) {
    const prompt = buildReplSystemPrompt({ ...context, sessionId });
    expect(prompt).toContain('## 조사 전 주인 확인');
    expect(prompt).toContain('구조화된 칸·PR·우편 참조와 최신 주인 정본');
    expect(prompt).toContain('추측하지 말고 unknown');
    expect(prompt).toContain('중복 조사를 시작하지 마라');
  }
});

test('자리로 확인되지 않은 대화에는 자리 전용 지침을 싣지 않는다', () => {
  const prompt = buildReplSystemPrompt({ cfg, enabledToolNames: undefined, cwd: '/workspace/user', seatBootDeps });
  expect(prompt ?? '').not.toContain('## 조사 전 주인 확인');
});

test('실제 턴 프롬프트에 구조화 참조의 현재 조회 결과를 싣고 매 턴 다시 읽는다', () => {
  let owner = 'TC-1';
  let reads = 0;
  const ownerReaders = {
    checklistVersion: () => '0.3.30',
    readChecklist: (version: string) => { reads++; return { version, items: [{ id: 'CELL-X', owner, title: 'x', status: 'yellow' as const, updatedAt: '', updatedBy: 'OP' }] }; },
    readPullRequest: () => null, resolveAssignee: () => null, readMail: () => null,
  };
  const context = { cfg, enabledToolNames: undefined, cwd: '/workspace/seats/TC-1', seatBootDeps, ownerReaders,
    workReferences: [{ kind: 'cell', id: 'CELL-X', version: '0.3.30' }] };
  expect(buildReplSystemPrompt(context)).toContain('"status":"owned"');
  owner = 'TC-2';
  expect(buildReplSystemPrompt(context)).toContain('"status":"foreign"');
  expect(reads).toBe(2);
  expect(buildReplSystemPrompt({ ...context, workReferences: undefined })).toContain('[주인 조회 결과] unknown');
  expect(buildReplSystemPrompt({ ...context, workReferences: [{ kind: 'cell', id: 'CELL-X' }] })).toContain('[주인 조회 결과] unknown');
  expect(buildReplSystemPrompt({ ...context, workReferences: [{ kind: 'cell', id: 'CELL-X', version: '0.3.30' }, { kind: 'cell', id: 'CELL-X', version: '0.3.31' }] })).toContain('[주인 조회 결과] unknown');
});
