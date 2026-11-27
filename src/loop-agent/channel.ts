// LOOP-AGENT v2 generic shell — els channel voice adapter (#40331 contract), any v2 agent:
//   input  {loop, from, channel, text, refs, messageId}  →  reply {text, evidence[], actions[]}
// Register: `els channel voice <id> -- eln loop agent <id> voice` · addressed as `@loop:<id>`. The channel name is the thread
// key, so a conversation in one channel keeps its own multi-turn memory (threads/<channel>.jsonl).
import type { VoiceMessage, VoiceResult } from './runtime.js';

export interface LoopVoiceInput { readonly loop: string; readonly from: { readonly role: string; readonly pane?: string; readonly seat?: string }; readonly channel: string; readonly text: string; readonly refs: readonly string[]; readonly messageId: string }
export interface LoopVoiceReply { readonly text: string; readonly evidence: readonly string[]; readonly actions: readonly string[] }

const REF_RE = /^[A-Za-z0-9._:/#@+-]{1,200}$/u;
const ACTION_RE = /^[A-Za-z0-9._:=-]{1,120}$/u;

export function parseLoopVoiceInput(line: string, expectId: string): LoopVoiceInput {
  const j = JSON.parse(line) as Partial<LoopVoiceInput>;
  if (typeof j.text !== 'string' || typeof j.messageId !== 'string' || !j.from || typeof j.from !== 'object') throw new Error('loop voice input needs {loop, from, channel, text, refs, messageId}');
  if (j.loop && j.loop !== expectId) throw new Error(`this adapter is loop:${expectId}, not loop:${j.loop}`);
  return { loop: expectId, from: j.from, channel: typeof j.channel === 'string' && j.channel ? j.channel : 'channel', text: j.text, refs: Array.isArray(j.refs) ? j.refs.filter((r): r is string => typeof r === 'string') : [], messageId: j.messageId };
}

export const speakerOf = (from: LoopVoiceInput['from']): string => (from.seat?.replace(/^loop:/u, '') || from.pane || from.role || 'UNKNOWN').toUpperCase();

export function toVoiceMessage(input: LoopVoiceInput, now: Date): VoiceMessage {
  const refs = input.refs.length ? `\n[refs] ${input.refs.slice(0, 8).join(' ')}` : '';
  return { id: input.messageId, from: speakerOf(input.from), body: `${input.text}${refs}`, at: now.toISOString(), channel: `els:${input.channel}`, thread: `els:${input.channel}` };
}

export function toLoopVoiceReply(res: VoiceResult): LoopVoiceReply {
  const evidence = [...new Set(res.refs.map(r => r.replace(/\s+/gu, '')).filter(r => REF_RE.test(r)))].slice(0, 12);
  return { text: res.reply, evidence, actions: res.actions.filter(a => ACTION_RE.test(a)).slice(0, 8) };
}
