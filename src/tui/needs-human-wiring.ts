// NEED-HUMAN-PUSH — the production deps of createNeedsHumanPush (ledger post · els coordinator lookup · decisions raise · logs).
import { spawn } from 'node:child_process';
import { ENV_EVENT_PANE, ENV_EVENT_SOCKET, ENV_EVENT_WS } from '../agent-events/protocol.js';
import { requestEls } from '../els/client.js';
import { defaultMsgStorePath, openMsgStore } from '../msg/msg-store.js';
import { resolveSeatRetroSeat } from '../seat/seat-retro-seat.js';
import { debug } from '../debug/log.js';
import type { NeedsHumanDeps } from './needs-human-push.js';

export function createNeedsHumanDeps(input: { cwd: string; resumeWith: (text: string) => void; env?: NodeJS.ProcessEnv }): NeedsHumanDeps {
  const env = input.env ?? process.env;
  let coordinator: string | null = null;
  // The coordinator comes from the els workspace setting; read once now (async) and kept — it rarely changes.
  const refresh = async (): Promise<void> => {
    const socket = env[ENV_EVENT_SOCKET]?.trim(); const ws = env[ENV_EVENT_WS]?.trim();
    if (!socket || !ws) return;
    try {
      const answer = await requestEls(socket, { op: 'ls' });
      const listed = JSON.parse(answer.message) as { workspaces?: { id?: string; name?: string; coordinatorSeat?: string }[] };
      coordinator = listed.workspaces?.find((row) => row.id === ws || row.name === ws)?.coordinatorSeat ?? null;
    } catch { coordinator = null; }
  };
  void refresh();
  return {
    seat: () => { try { return resolveSeatRetroSeat(input.cwd, env); } catch { return null; } },
    paneId: () => env[ENV_EVENT_PANE]?.trim() ?? '',
    coordinatorOf: () => coordinator,
    postMail: (envelope) => {
      const store = openMsgStore(defaultMsgStorePath());
      try { return store.post(envelope, { dedupe: true }).id; } finally { store.close(); }
    },
    raiseDecision: (card) => {
      const args = ['decisions', 'raise', '--title', card.title, '--category', 'scope', '--s', card.summary, '--c', `blockId ${card.blockId}`,
        '--pending-question', `근거: ${card.seat} 가 사람을 기다리며 멈췄다 (${card.reason})\n무엇이 바뀌나: 재개하면 ${card.seat} 가 일을 이어 간다\n기본값 시 결과: 멈춘 채 대기`,
        '--option', 'resume=재개:자리가 이어 간다', '--option', 'stop=중단:자리 일을 멈춘다', '--option', 'other=다른 방법:대표가 지시한다',
        '--skip-recommend', 'needs a person', '--no-xcheck', 'seat self-report', '--agent', card.seat];
      const child = spawn('elanous', args, { stdio: 'ignore', detached: true });
      child.on('error', () => { /* the log line below is the record */ });
      child.unref();
    },
    resumeWith: input.resumeWith,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (event, data) => { debug.log('tui', event, data); },
  };
}
