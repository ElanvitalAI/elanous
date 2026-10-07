import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discordDecisionOwner } from '../src/decisions/discord-decision-cards.js';
import { handleDiscordSeatWork, type DiscordSeatWorkDeps } from '../src/intake-plane/discord-seat-work.js';
import { submitIntakeWork } from '../src/intake-plane/submit-intake-work.js';
import type { MsgStore } from '../src/msg/msg-store.js';
import { dispatchCeoTask } from '../src/seat-dispatch/ceo-commands.js';
import { resolveSeat } from '../src/seat-address/seat-address.js';
import { getUserConfig, type UserConfig } from '../src/user-config.js';

export type ProbeResult = {
  text: string;
  ms: number;
  route: 'dispatch' | 'ask' | 'submit' | 'none';
  seat: string | null;
  body: string | null;
  reply: string | null;
};

type ProbeOptions = { config?: UserConfig; dm?: boolean; live?: boolean; liveDeps?: DiscordSeatWorkDeps; messageId?: string };

/** Execute the real Discord seat router; dry dependencies never open a live store or delivery channel. */
export async function probeDiscordSeatWork(text: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const config = options.config ?? getUserConfig();
  const ownerId = discordDecisionOwner(config);
  if (options.dm && !ownerId) throw new Error('Discord 소유자 ID가 없어 DM을 재현할 수 없습니다.');
  const messageId = options.messageId ?? 'probe-1';
  const msg = { channelId: options.dm ? `probe-dm-${ownerId}` : 'probe-channel', messageId,
    ...(ownerId ? { userId: ownerId } : {}), isDm: options.dm ?? false };
  let route: ProbeResult['route'] = 'none';
  let seat: string | null = null;
  let body: string | null = null;
  const capture = (path: ProbeResult['route'], seatId: string | null, forwarded: string) => {
    route = path;
    seat = seatId;
    body = Array.from(forwarded).slice(0, 80).join('');
  };
  const dry: DiscordSeatWorkDeps = {
    config,
    // An unknown address must not cause registry I/O or a persona/LLM answer in a dry run.
    personaSource: { list: () => [], get: () => undefined },
    personaAnswer: async () => { throw new Error('dry persona answer unavailable'); },
    answer: async () => null,
    commandDeps: { ownerId, replyTarget: null, runGh: async () => { throw new Error('dry channel delivery unavailable'); },
      append: () => { throw new Error('dry seat delivery unavailable'); } },
    dispatch: async (seatId, forwarded) => {
      capture('dispatch', seatId, forwarded);
      return { channel: 'unknown', reply: `마른 실행 — ${seatId}에 맡길 예정 (실제 맡김 없음).` };
    },
    submit: async (input) => {
      capture('submit', resolveSeat(input.text.split(/\s+/)[0] ?? '')?.id ?? null, input.text);
      return { ok: true, track: 'graph', acceptanceId: 'DRY-RUN (모의 · 실제 접수 없음)' };
    },
    askDeps: {
      open: () => { const db = new Database(':memory:'); return { db, close: () => db.close() } as unknown as MsgStore; },
      dispatch: async (seatId, forwarded) => {
        capture('ask', seatId, forwarded);
        // Since #24523 a seat *task* also travels this ask path (so the answer can come back) — the wording covers both.
        return { channel: 'unknown', reply: `마른 실행 — ${seatId}에 맡길 예정 (실제 맡김 없음).` };
      },
      send: async () => { throw new Error('dry Discord delivery unavailable'); },
    },
  };
  const live: DiscordSeatWorkDeps = {
    ...options.liveDeps,
    config,
    dispatch: async (seatId, forwarded, deps, extra) => {
      capture('dispatch', seatId, forwarded);
      return (options.liveDeps?.dispatch ?? dispatchCeoTask)(seatId, forwarded, deps, extra);
    },
    submit: async (input, deps) => {
      capture('submit', resolveSeat(input.text.split(/\s+/)[0] ?? '')?.id ?? null, input.text);
      return (options.liveDeps?.submit ?? submitIntakeWork)(input, deps);
    },
    askDeps: {
      ...options.liveDeps?.askDeps,
      dispatch: async (seatId, forwarded, deps, extra) => {
        capture('ask', seatId, forwarded);
        return (options.liveDeps?.askDeps?.dispatch ?? options.liveDeps?.dispatch ?? dispatchCeoTask)(seatId, forwarded, deps, extra);
      },
      // This CLI has no Discord transport: even live mode must not post to Discord.
      send: async () => { throw new Error('probe does not send Discord messages'); },
    },
  };
  const start = performance.now();
  const reply = await handleDiscordSeatWork(text, msg, options.live ? live : dry);
  return { text: Array.from(text).slice(0, 80).join(''), ms: Math.round((performance.now() - start) * 100) / 100,
    route, seat, body, reply: reply === null ? null : Array.from(reply).slice(0, 120).join('') };
}

/** Extract only the '치는 문장' column of a Markdown runbook table, in row order. */
export function runbookTexts(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\|.*\|\s*치는 문장(?:\s*\([^|]*\))?\s*\|/.test(line));
  if (header < 0) throw new Error('대본의 «치는 문장» 표를 찾지 못했습니다.');
  const columns = lines[header]!.split('|').slice(1, -1).map((cell) => cell.trim());
  const index = columns.findIndex((cell) => cell.startsWith('치는 문장'));
  const texts: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1);
    if (cells.length !== columns.length) throw new Error('대본 표의 열 수가 맞지 않습니다.');
    const cell = cells[index]?.trim() ?? '';
    if (!cell.startsWith('`') || !cell.endsWith('`')) throw new Error('치는 문장 칸이 백틱으로 둘러싸여 있지 않습니다.');
    texts.push(cell.slice(1, -1));
  }
  if (!texts.length) throw new Error('대본에 치는 문장이 없습니다.');
  return texts;
}

export async function runProbeCli(argv: string[], config: UserConfig = getUserConfig()): Promise<ProbeResult[]> {
  let text: string | undefined;
  let runbook: string | undefined;
  let dm = false;
  let live = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--text' || flag === '--runbook') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} 값이 필요합니다.`);
      if (flag === '--text') text = value;
      else runbook = value;
    } else if (flag === '--dm') dm = true;
    else if (flag === '--live') live = true;
    else if (flag === '--json') json = true;
    else throw new Error(`알 수 없는 옵션: ${flag}`);
  }
  if (Boolean(text) === Boolean(runbook)) throw new Error('--text 또는 --runbook 중 하나만 지정하세요.');
  const texts = runbook ? runbookTexts(readFileSync(resolve(runbook), 'utf8')) : [text!];
  const results: ProbeResult[] = [];
  for (const [index, line] of texts.entries()) {
    const result = await probeDiscordSeatWork(line, { config, dm, live, messageId: `probe-${index + 1}` });
    results.push(result);
    if (!json) console.log(`글: ${result.text} | ${result.ms}ms | 길: ${result.route} | 자리: ${result.seat ?? '-'} | 본문: ${result.body ?? '-'} | 봇 답: ${result.reply ?? '-'}`);
  }
  if (json) console.log(JSON.stringify(results));
  return results;
}

if (import.meta.main) {
  try { await runProbeCli(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
