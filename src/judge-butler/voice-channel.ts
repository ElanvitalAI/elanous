// 판정 집사 — els channel voice adapter (PR #40331 loop-voice contract · stacked on #40282 channel P0).
//   input  {loop, from, channel, text, refs, messageId}  →  reply {text, evidence[], actions[]}
// The channel only RECORDS evidence/actions as refs; every action listed here was already executed by the butler's own L1
// commands (sign = done-when gate + verify node · propose · expire · escalate · demote) inside voiceOnce — same core as mail.
// Two registrations, nothing resident: in-process `registerLoopVoice('judge-butler', judgeButlerVoiceAdapter(...))` once the hub
// is on main, or the command form `els channel voice judge-butler -- eln loop butler voice` (one JSON line in on stdin, the last
// JSON line on stdout is the reply · one call at a time · 120 s deadline).
import type { VoiceMessage, VoiceResult } from './voice.js';

export const LOOP_VOICE_ID = 'judge-butler';
/** Mirrors #40331 `LoopVoiceInput` / `LoopVoiceReply` (kept local until the channel lands). */
export interface LoopVoiceInput { readonly loop: string; readonly from: { readonly role: string; readonly pane?: string; readonly seat?: string }; readonly channel: string; readonly text: string; readonly refs: readonly string[]; readonly messageId: string }
export interface LoopVoiceReply { readonly text: string; readonly evidence: readonly string[]; readonly actions: readonly string[] }

const REF_RE = /^[A-Za-z0-9._:/#@+-]{1,200}$/u;
const ACTION_RE = /^[A-Za-z0-9._:=-]{1,120}$/u;

export function parseLoopVoiceInput(line: string): LoopVoiceInput {
  const j = JSON.parse(line) as Partial<LoopVoiceInput>;
  if (typeof j.text !== 'string' || typeof j.messageId !== 'string' || !j.from || typeof j.from !== 'object') throw new Error('loop voice input needs {loop, from, channel, text, refs, messageId}');
  if (j.loop && j.loop !== LOOP_VOICE_ID) throw new Error(`this adapter is loop:${LOOP_VOICE_ID}, not loop:${j.loop}`);
  return { loop: LOOP_VOICE_ID, from: j.from, channel: typeof j.channel === 'string' ? j.channel : 'channel', text: j.text, refs: Array.isArray(j.refs) ? j.refs.filter((r): r is string => typeof r === 'string') : [], messageId: j.messageId };
}

/** Who spoke: the seat (pane seat / loop seat) when the hub knows it, else the pane, else the role. */
export const speakerOf = (from: LoopVoiceInput['from']): string => (from.seat?.replace(/^loop:/u, '') || from.pane || from.role || 'UNKNOWN').toUpperCase();

export function toVoiceMessage(input: LoopVoiceInput, now: Date): VoiceMessage {
  const refs = input.refs.length ? `\n[refs] ${input.refs.slice(0, 8).join(' ')}` : '';
  return { id: input.messageId, from: speakerOf(input.from), body: `${input.text}${refs}`, at: now.toISOString(), channel: `els:${input.channel}` };
}

export function toLoopVoiceReply(res: VoiceResult): LoopVoiceReply {
  const evidence = [...new Set(res.refs.map(r => r.replace(/\s+/gu, '')).filter(r => REF_RE.test(r)))].slice(0, 12);
  return { text: res.reply, evidence, actions: res.actions.filter(a => ACTION_RE.test(a)).slice(0, 8) };
}

/** In-process adapter shape (#40331 `LoopVoiceAdapter`): the core is `voiceOnce` bound to a fresh view. */
export function judgeButlerVoiceAdapter(core: (msg: VoiceMessage) => Promise<VoiceResult>, now: () => Date = () => new Date()) {
  return async (input: LoopVoiceInput, signal?: AbortSignal): Promise<LoopVoiceReply> => {
    if (signal?.aborted) throw new Error('aborted');
    return toLoopVoiceReply(await core(toVoiceMessage(input, now())));
  };
}
