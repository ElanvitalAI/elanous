// C0 (2026-07-16) — cutover parity 하니스. 옛 배달 대상(바인딩) vs 새 fan-out 대상(구독자)
// 대조 + 내용 유실 감지. green(수신자 일치+내용 정상)=flip 안전 신호.

import { setDefaultTimeout, describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, listSessions, type SessionMeta } from '../src/session/index.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function meta(bindings: SessionMeta['bindings']): SessionMeta {
  return { id: 's1', createdAt: '', updatedAt: '', title: '', provider: '', model: '', messageCount: 0, source: 'cli', bindings } as SessionMeta;
}

describe('session source provenance legacy compatibility', () => {
  test('reads a legacy index record without provenance and does not rewrite it', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-legacy-'));
    const index = join(root, 'index.json');
    const legacy: SessionMeta[] = [{ id: 'legacy', createdAt: '', updatedAt: '', title: '', provider: '', model: '', messageCount: 0, source: 'cli' }];
    try {
      writeFileSync(index, JSON.stringify(legacy, null, 2) + '\n');
      expect(listSessions({}, root)).toEqual([legacy[0]]);
      expect(readFileSync(index, 'utf8')).toBe(JSON.stringify(legacy, null, 2) + '\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('contrasts an omitted source with an explicitly declared CLI source', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-provenance-'));
    try {
      const defaulted = createSession({}, root);
      const declared = createSession({ source: 'cli' }, root);
      const persisted = listSessions({}, root);
      expect(persisted.find(meta => meta.id === defaulted.id)).toMatchObject({
        source: 'cli', sourceSource: 'default',
      });
      expect(persisted.find(meta => meta.id === declared.id)).toMatchObject({
        source: 'cli', sourceSource: 'declared',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persists and reads back every widened session source without changing declared provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-widened-source-'));
    const sources = ['discord', 'pwa', 'native', 'tui', 'voice', 'unknown'] as const;
    try {
      const created = sources.map(source => createSession({ source }, root));
      const byId = new Map(listSessions({}, root).map(session => [session.id, session]));
      for (const session of created) {
        expect(byId.get(session.id)).toMatchObject({
          source: session.source,
          sourceSource: 'declared',
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an invalid CLI --source instead of treating it as an unfiltered list', () => {
    const result = spawnSync(process.execPath, ['src/index.ts', 'session', 'list', '--source', 'invalid-source', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid session source "invalid-source"');
    expect(result.stdout).toBe('');
  });
});

describe('oldPathRecipientKeys — 옛 경로 대상(완전스코프 키·C2)', () => {
  test('telegram/discord/cli 바인딩 → 완전스코프 키(autoSubscribe 와 동일 builder)', async () => {
    const { oldPathRecipientKeys } = await import('../src/session/session-fanout-parity.js');
    const { telegramEndpointKey } = await import('../src/session/session-endpoint-key.js');
    const tgK = `telegram:${telegramEndpointKey({ chatId: 42 })}`;
    expect(oldPathRecipientKeys(meta({ telegram: { chatId: 42 } })).sort()).toEqual([tgK]);
    expect(oldPathRecipientKeys(meta({ telegram: { chatId: 42 }, cli: true })).sort()).toEqual(['cli:local', tgK].sort());
    expect(oldPathRecipientKeys(meta(undefined))).toEqual([]);
  });

  test('botId·threadId 편입 — 멀티봇/스레드가 키에 반영', async () => {
    const { oldPathRecipientKeys } = await import('../src/session/session-fanout-parity.js');
    const { telegramEndpointKey } = await import('../src/session/session-endpoint-key.js');
    const k = oldPathRecipientKeys(meta({ telegram: { chatId: 42, botId: 'botA', threadId: 7 } }));
    expect(k).toEqual([`telegram:${telegramEndpointKey({ chatId: 42, botId: 'botA', threadId: 7 })}`]);
  });

  test('auto-created 텔레그램(bindings 없이 tgChatId+tgBotId) → origin chat 완전스코프', async () => {
    const { oldPathRecipientKeys } = await import('../src/session/session-fanout-parity.js');
    const { telegramEndpointKey } = await import('../src/session/session-endpoint-key.js');
    const m = { id: 's', source: 'telegram', tgChatId: 77, tgBotId: 'botB' } as SessionMeta;
    expect(oldPathRecipientKeys(m)).toEqual([`telegram:${telegramEndpointKey({ chatId: 77, botId: 'botB' })}`]);
  });
});

describe('recordFanoutParity — green=유실없음', () => {
  test('green — 유실 없음 + 내용 정상(event green)', async () => {
    const { recordFanoutParity } = await import('../src/session/session-fanout-parity.js');
    const logs: Array<[string, string]> = [];
    const r = recordFanoutParity(
      { sessionId: 's', newRecipients: ['telegram:42'], oldRecipients: ['telegram:42'], contentLen: 10 },
      { logSink: (c, e) => logs.push([c, e]) },
    );
    expect(r.green).toBe(true);
    expect(r.recipientMatch).toBe(true);
    expect(logs[0]).toEqual(['session.parity', 'green']);
  });

  test('loss — 옛엔 있는데 새가 놓침(유실 후보·C1 전 상태·event loss)', async () => {
    const { recordFanoutParity } = await import('../src/session/session-fanout-parity.js');
    const logs: Array<[string, string]> = [];
    const r = recordFanoutParity(
      { sessionId: 's', newRecipients: [], oldRecipients: ['telegram:42'], contentLen: 10 },
      { logSink: (c, e) => logs.push([c, e]) },
    );
    expect(r.green).toBe(false);
    expect(r.missingInNew).toEqual(['telegram:42']);   // 유실 후보
    expect(logs[0]).toEqual(['session.parity', 'loss']);
  });

  test('내용 유실(len 0·degraded) → contentOk false·green false', async () => {
    const { recordFanoutParity } = await import('../src/session/session-fanout-parity.js');
    const r = recordFanoutParity({ sessionId: 's', newRecipients: ['telegram:42'], oldRecipients: ['telegram:42'], contentLen: 0, degraded: true });
    expect(r.contentOk).toBe(false);
    expect(r.green).toBe(false);
  });

  test('extraInNew — 추가 구독자는 유실 아님 → green(no missing)', async () => {
    const { recordFanoutParity } = await import('../src/session/session-fanout-parity.js');
    const r = recordFanoutParity({ sessionId: 's', newRecipients: ['telegram:42', 'pwa:p'], oldRecipients: ['telegram:42'], contentLen: 5 });
    expect(r.extraInNew).toEqual(['pwa:p']);
    expect(r.missingInNew).toEqual([]);
    expect(r.green).toBe(true);              // 유실 없음 → flip 안전(extra 는 새 능력)
    expect(r.recipientMatch).toBe(false);    // 정확 일치는 아님(정보용)
  });

  test('sink 없이도 fail-soft(관측 실패가 판정 안 막음)', async () => {
    const { recordFanoutParity } = await import('../src/session/session-fanout-parity.js');
    expect(() => recordFanoutParity(
      { sessionId: 's', newRecipients: [], oldRecipients: [], contentLen: 1 },
      { logSink: () => { throw new Error('boom'); } },
    )).not.toThrow();
  });
});
