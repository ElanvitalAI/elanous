import { awaitGlobalPersonaLoad, getGlobalPersonaRegistry } from '../../persona/global-registry.js';
import { resolvePersonaAddress } from '../../intake-plane/persona-answer.js';
import { loadSession, updateSessionMeta } from '../../session/index.js';
import { assemblePersonaPrompt } from '../../persona/prompt-assembler.js';
import type { LLMMessage } from '../../llm.js';

/** Unattached conversations use a dashboard-local id; attached sessions use persisted metadata. */
export class TuiChatPersonaSelection {
  private readonly selected = new Map<string, string>();

  get(sessionId: string): string | undefined {
    return loadSession(sessionId)?.meta.chatPersonaId ?? this.selected.get(sessionId);
  }

  set(sessionId: string, personaId: string | undefined): void {
    const meta = updateSessionMeta(sessionId, (m) => {
      if (personaId) m.chatPersonaId = personaId;
      else delete m.chatPersonaId;
    });
    if (!meta) {
      if (personaId) this.selected.set(sessionId, personaId);
      else this.selected.delete(sessionId);
    } else {
      this.selected.delete(sessionId);
    }
  }
}

export async function handleTuiChatPersona(
  args: readonly string[], sessionId: string,
  selection: TuiChatPersonaSelection,
): Promise<string> {
  if (args[0] === '-') {
    if (args.length !== 1) return '쓰는 법: /persona [이름|-]';
    selection.set(sessionId, undefined);
    return '이 대화의 페르소나를 뺐습니다';
  }
  try {
    await awaitGlobalPersonaLoad();
    const registry = getGlobalPersonaRegistry();
    if (!args.length) {
      const selected = selection.get(sessionId);
      const personas = registry.list().sort((a, b) => a.displayName.localeCompare(b.displayName));
      const current = personas.find(p => p.personaId === selected);
      return `이 대화의 페르소나: ${current ? `${current.displayName} (${current.personaId})` : '없음'}\n고를 수 있는 페르소나: ${personas.map(p => `${p.displayName} (${p.personaId})${p.personaId === selected ? ' (지금)' : ''}`).join(' · ') || '없음'}\n고르기: /persona <이름> · 빼기: /persona -`;
    }
    const name = args.join(' ');
    const persona = resolvePersonaAddress(name, registry);
    if (!persona) return `그런 페르소나가 없습니다: ${name}`;
    selection.set(sessionId, persona.personaId);
    return `${persona.displayName} 페르소나를 이 대화에 골랐습니다`;
  } catch {
    return '페르소나 목록을 읽지 못했습니다';
  }
}

export function tuiChatPersonaMessages(
  sessionId: string, selection: TuiChatPersonaSelection,
): LLMMessage[] {
  const id = selection.get(sessionId);
  if (!id) return [];
  const persona = getGlobalPersonaRegistry().get(id);
  if (!persona) return [];
  const prompt = assemblePersonaPrompt(persona, '').systemPrompt;
  return prompt ? [{ role: 'system', content: prompt }] : [];
}
