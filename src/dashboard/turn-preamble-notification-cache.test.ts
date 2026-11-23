import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboardTurnPreamble } from './turn-preamble.js';
import { messagesToResponsesInput } from '../llm.js';
import { globalTaskNotificationQueue } from '../agent/task-notification.js';
import type { getUserConfig } from '../user-config.js';

test('notification-only wake does not rewrite cached Codex instructions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'notification-cache-'));
  const config = { chat: { conciseness: 'balanced' } } as unknown as ReturnType<typeof getUserConfig>;
  const build = (userText: string) => buildDashboardTurnPreamble({ userText, cwd, userConfig: config, memory: false, controlEnv: {} });
  try {
    globalTaskNotificationQueue.clear();
    const normal = build('continue');
    const wake = build('[자동 재개] 위임 끝: agent (done) — <task-notification> 의 결과를 읽고 이어서 처리');
    const directive = wake.find(m => String(m.content).includes('[알림 전용 턴]'));
    expect(directive).toMatchObject({ role: 'system', cacheVolatile: true });
    const normalWire = messagesToResponsesInput([...normal, { role: 'user', content: 'continue' }], { stablePrefix: true });
    const wakeWire = messagesToResponsesInput([...wake, { role: 'user', content: 'continue' }], { stablePrefix: true });
    expect(wakeWire.instructions).toBe(normalWire.instructions);
    expect(JSON.stringify(wakeWire.input)).toContain('[알림 전용 턴]');
  } finally {
    globalTaskNotificationQueue.clear();
    rmSync(cwd, { recursive: true, force: true });
  }
});
