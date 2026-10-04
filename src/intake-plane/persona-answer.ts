import { debug } from '../debug/log.js';
import { resolveMention, type PersonaSource } from '../persona/mention-parser.js';
import type { PersonaProfile } from '../persona/types.js';
import { resolveSeat, type SeatEntry } from '../seat-address/seat-address.js';

export interface PersonaAnswerDeps {
  complete?: (prompt: string) => Promise<string>;
}

export function seatOfPersona(persona: PersonaProfile, resolve = resolveSeat): SeatEntry | null {
  return persona.seat ? resolve(persona.seat) ?? null : null;
}

/** Resolve the registry mention first, then an exact display name. */
export function resolvePersonaAddress(name: string, source: PersonaSource): PersonaProfile | null {
  const mention = resolveMention(name, source);
  if (mention) return mention;
  const needle = name.replace(/^@/, '').toLocaleLowerCase();
  return source.list().find((persona) => persona.displayName.toLocaleLowerCase() === needle) ?? null;
}

async function defaultComplete(prompt: string): Promise<string> {
  const { streamLLM } = await import('../llm.js');
  const { tierModel } = await import('../llm/model-defaults.js');
  return streamLLM([{ role: 'user', content: prompt }], () => {}, { model: tierModel('better') });
}

export async function answerAsPersona(persona: PersonaProfile, question: string, deps: PersonaAnswerDeps = {}): Promise<string> {
  const prompt = `${persona.systemPrompt ?? `너는 ${persona.displayName} 이다`}\n\n## 질문\n${question}`;
  const raw = await (deps.complete ?? defaultComplete)(prompt);
  const answer = `@${persona.displayName}\n${raw.trim()}`;
  const text = Array.from(answer).slice(0, 3_500).join('');
  debug.log('persona.address', 'answered', { personaId: persona.personaId, chars: Array.from(text).length });
  return text;
}
