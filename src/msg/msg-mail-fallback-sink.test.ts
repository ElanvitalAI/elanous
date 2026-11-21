// #122460 ③ — 재깨움의 증거 줄: fallback CLI 는 점검 sleep 전에 로그 싱크를 부착한다.
//
// CX-16 실측(2026-11-21): msg_mail_fallbacks claim(11:15:15.489 · post 뒤 60.898초)은 남았으나 두 번째 msg.wake 줄과
// msg.fallback 결과 로그가 eln logs 에 없었다 — 짧은 CLI 는 파일 트레일만 남긴다(msg post 만 :615 에서 싱크를 부착했다).
// 규격(#122460 ③): 미처리 N초 뒤 재시도 wake 1회(로그 줄) — 그 «로그 줄» 이 eln logs 에 도달해야 재깨움이 결속된다.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from './msg-store.js';
import { registerMsgCommands } from '../cli/msg-cli.js';

test('#122460 ③ eln msg mail-fallback 는 sleep 전에 싱크를 부착한다 — 재시도 wake 의 증거 줄이 eln logs 에 남는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-fallback-sink-'));
  const db = join(dir, 'messages.db');
  const store = new MsgStore(db);
  const posted = store.post({ from: 'OP', to: 'TC', body: 'knock me once', intent: 'request' });
  store.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'delivered', source: 'tui-queue', queueItemId: 'q1' });
  store.close();
  const order: string[] = [];
  const deps = {
    openStore: () => new MsgStore(db),
    out: { log: () => {}, error: () => {} },
    setExitCode: () => {},
    registerLogSink: async () => { order.push('sink'); },
    fallbackSleep: async () => { order.push('slept'); },
    wake: async () => { order.push('woken'); return { result: 'skipped', reason: 'mid-turn' }; },
  } as unknown as Parameters<typeof registerMsgCommands>[1];
  const program = new Command();
  registerMsgCommands(program, deps);
  try {
    await program.parseAsync(['msg', 'mail-fallback', '--msg', String(posted.id), '--to', 'TC', '--from', 'OP', '--wait-ms', '1'], { from: 'user' });
    expect(order[0]).toBe('sink'); // 실패 먼저: 현재 main 은 싱크 없이 sleep 부터 시작한다
    expect(order).toContain('slept');
    expect(order).toContain('woken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});