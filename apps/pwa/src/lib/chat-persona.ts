import type { DaemonClient } from './daemon-client';

export interface ChatPersona { personaId: string; displayName: string }

const key = (sessionId: string): string => `elanous:chat:persona:${sessionId}`;

export function selectedChatPersona(sessionId: string, storage: Pick<Storage, 'getItem'>): string | undefined {
  return storage.getItem(key(sessionId)) || undefined;
}

export async function handleChatPersona(
  args: readonly string[], sessionId: string, client: Pick<DaemonClient, 'fetchJson'>,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): Promise<string> {
  if (args.length === 1 && args[0] === '-') {
    storage.removeItem(key(sessionId));
    return '이 대화의 페르소나를 뺐습니다';
  }
  if (args.length > 1 && args[0] === '-') return '쓰는 법: /persona [이름|-]';
  try {
    if (args.length === 0) {
      const response = await client.fetchJson<{ personas: ChatPersona[] }>('/v1/personas');
      if (!Array.isArray(response.personas)) return '페르소나 목록을 읽지 못했습니다';
      const selected = selectedChatPersona(sessionId, storage);
      return `페르소나: ${response.personas.map((p) => `${p.displayName} (${p.personaId})${p.personaId === selected ? ' (지금)' : ''}`).join(' · ') || '없음'}\n고르기: /persona <이름> · 빼기: /persona -`;
    }
    const name = args.join(' ');
    const resolved = await client.fetchJson<{ persona: ChatPersona }>(`/v1/personas/${encodeURIComponent(name)}`);
    if (!resolved.persona?.personaId) return `그런 페르소나가 없습니다: ${name}`;
    storage.setItem(key(sessionId), resolved.persona.personaId);
    return `${resolved.persona.displayName} 페르소나를 이 대화에 골랐습니다`;
  } catch (error) {
    if (args.length > 0 && error instanceof Error && error.message.includes('404')) {
      return `그런 페르소나가 없습니다: ${args.join(' ')}`;
    }
    return '페르소나 목록을 읽지 못했습니다';
  }
}
