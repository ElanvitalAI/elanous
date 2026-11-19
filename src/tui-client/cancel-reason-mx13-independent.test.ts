import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, loadSession } from '../session/index.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { closeLocalChatSession, runLocalChatTurn } from './local-chat-turn.js';
import { createTurnCancelRouter, TURN_CANCEL_TYPE } from '../turn-capsule/turn-cancel.js';
import { nextTuiPublicHistory } from '../tui/core/public-history.js';
import { TURN_STALLED_MARKER } from '../chat/interjection.js';

for (const [reason, marker] of [['esc', '[사용자가 이 턴을 중단했습니다]'], ['stall', '[응답 정체로 이 턴이 자동 중단됐습니다]']] as const) {
  test(`real host IPC and REPL persist ${reason} into next fake provider request`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mx13-wire-'));
    const envs = ['ELANOUS_SESSION_ROOT','ELANOUS_STATE_DIR','ELANOUS_TEST_FAKE_LLM','ELANOUS_TEST_FAKE_LLM_SCRIPT','ELANOUS_TEST_FAKE_LLM_CAPTURE','ELANOUS_SKIP_LOGIN_ENV'];
    const saved = Object.fromEntries(envs.map(k => [k, process.env[k]]));
    process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions'); process.env.ELANOUS_STATE_DIR = dir;
    process.env.ELANOUS_TEST_FAKE_LLM = '1'; process.env.ELANOUS_TEST_FAKE_LLM_SCRIPT = 'stall:partial,ok';
    process.env.ELANOUS_TEST_FAKE_LLM_CAPTURE = join(dir, 'capture.jsonl'); process.env.ELANOUS_SKIP_LOGIN_ENV = '1';
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    setElanousConfigDir(dir);
    const id = createSession({ source: 'tui' }).id;
    const cli = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
    const abort = new AbortController();
    try {
      const timer = setTimeout(() => abort.abort(reason === 'esc' ? undefined : reason), 3000);
      const first = runLocalChatTurn(id, 'first prompt', abort.signal, cli);
      await expect(first).rejects.toThrow('응답을 취소했습니다');
      clearTimeout(timer);
      await runLocalChatTurn(id, 'next prompt', new AbortController().signal, cli);
      const messages = loadSession(id)?.messages ?? [];
      const capture = readFileSync(join(dir, 'capture.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
      const input = JSON.stringify(capture.at(-1).messages);
      console.log(`WIRE ${reason} store=${JSON.stringify(messages.map(m => m.content))} next-provider=${JSON.stringify(capture.at(-1).messages.filter((m: {role: string}) => m.role !== 'system'))}`);
      expect(messages.filter(m => m.content === marker)).toHaveLength(1);
      expect(input).toContain(marker);
    } finally {
      await closeLocalChatSession(id); resetElanousConfigDir();
      for (const k of envs) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }, 30000);
}

test('held cold-boot reason and duplicate first-wins; legacy cancel is undefined', () => {
  const router = createTurnCancelRouter(); const seen: unknown[] = [];
  const msg = {type: TURN_CANCEL_TYPE, sessionId:'s', turnId:'one'} as const;
  router.receive({...msg, reason:'stall'}); router.receive(msg);
  router.listen('one', reason => seen.push(reason));
  router.receive({...msg, turnId:'two'}); router.listen('two', reason => seen.push(reason));
  expect(seen).toEqual(['stall', undefined]);
});

test('active router forwards stall reason immediately', () => {
  const router = createTurnCancelRouter(); const seen: unknown[] = [];
  router.listen('active', reason => seen.push(reason));
  expect(router.receive({type: TURN_CANCEL_TYPE, sessionId: 's', turnId: 'active', reason: 'stall'})).toBe(true);
  expect(seen).toEqual(['stall']);
});

test('stall marker hides legacy partial in public history', () => {
  const projected = nextTuiPublicHistory([
    {role: 'user', content: 'question', ts: '1'},
    {role: 'assistant', content: 'private partial', ts: '2'},
    {role: 'user', content: TURN_STALLED_MARKER, ts: '3'},
    {role: 'user', content: 'next', ts: '4'},
    {role: 'assistant', content: 'done', ts: '5', replyFinal: true},
  ]);
  expect(projected[1]?.role).toBe('system');
  expect(JSON.stringify(projected)).not.toContain('private partial');
  expect(projected[4]?.content).toBe('done');
});
