// `eln loop agent room` — the supervisors' room (SUPERVISOR-REVIVE 3/3): give every v2 agent that has a body a channel voice
// (`els channel voice <id> -- eln loop agent <id> voice` · addressed as `@loop:<id>`) and let each one introduce itself in
// `ws:supervisors` with its KPI and L0 — the room is the list. Re-running is idempotent (declarations are rewritten; the
// intro lines are deduped by the channel's own duplicate rule).
import { dirname, join } from 'node:path';
import { kpiLine, listCards, type AgentCard } from './card.js';
import { fileAgentMemory } from './memory.js';
import { hasBody } from './registry.js';
import { SUPERVISORS_CHANNEL, type ElsAsk } from './speak.js';

export interface RoomDeps {
  readonly cards: () => AgentCard[];
  readonly hasBody: (id: string) => boolean;
  readonly writeDecl: (id: string, command: readonly string[]) => void;
  readonly ask: ElsAsk;
  readonly selfCommand: () => string[];
  readonly kpiOf: (card: AgentCard) => string;
}

export function introLine(card: AgentCard, kpi: string): string {
  return `👋 @loop:${card.id} — ${card.name} · ${card.role || card.subject} · ${kpi} · L0 ${card.supervisor} · 물어보기: «@loop:${card.id} 왜 KPI 가 떨어졌어? / 지금 뭐 해? / 뭐가 막혀?»`;
}

export async function openRoom(deps: RoomDeps): Promise<{ registered: string[]; skipped: string[]; spoken: string[]; refused: string[] }> {
  const registered: string[] = []; const skipped: string[] = []; const spoken: string[] = []; const refused: string[] = [];
  for (const card of deps.cards()) {
    if (!deps.hasBody(card.id)) { skipped.push(card.id); continue; }
    deps.writeDecl(card.id, [...deps.selfCommand(), 'loop', 'agent', card.id, 'voice']);
    registered.push(card.id);
    const r = await deps.ask({ op: 'channel', action: 'loop-say', channel: SUPERVISORS_CHANNEL, loop: card.id, body: introLine(card, deps.kpiOf(card)), refs: [`loop:${card.id}`] }).catch(e => ({ exitCode: 1, message: String(e) }));
    (r.exitCode === 0 ? spoken : refused).push(card.id);
  }
  return { registered, skipped, spoken, refused };
}

export function liveRoomDeps(): RoomDeps {
  const { writeLoopVoiceDecl } = require('../els/loop-voice.js') as typeof import('../els/loop-voice.js');
  const { elsSocketPath } = require('../els/server.js') as typeof import('../els/server.js');
  const { requestEls } = require('../els/client.js') as typeof import('../els/client.js');
  const { selfCommand } = require('../els/channel-cli.js') as typeof import('../els/channel-cli.js');
  const stateRoot = (require('../instance/resolve.js') as typeof import('../instance/resolve.js')).effectiveInstanceRoot();
  return {
    cards: () => listCards().cards,
    hasBody,
    writeDecl: (id, command) => writeLoopVoiceDecl(join(dirname(elsSocketPath()), 'loops'), id, command),
    ask: (request) => requestEls(elsSocketPath(), request as unknown as Parameters<typeof requestEls>[1], 5_000),
    selfCommand: () => selfCommand(),
    kpiOf: (card) => kpiLine(card.kpi, fileAgentMemory(stateRoot, card.id, card.supervisor).readState().lastKpi),
  };
}
