import { awaitGlobalPersonaLoad, getGlobalPersonaRegistry } from '../../persona/global-registry.js';
import { resolvePersonaAddress } from '../../intake-plane/persona-answer.js';
import { loadSession, updateSessionMeta } from '../../session/index.js';
import { assemblePersonaPrompt } from '../../persona/prompt-assembler.js';
import type { PromptSource } from '../../persona/prompt-assembler.js';
import type { LLMMessage } from '../../llm.js';

/** Unattached conversations use a dashboard-local id; attached sessions use persisted metadata. */
export class TuiChatPersonaSelection {
  private readonly selected = new Map<string, string>();
  /** 적용 시점 캡처 스냅샷 — registry와 별개 저장소, 조회는 이 값을 반환한다. */
  private readonly applied = new Map<string, TuiChatPersonaAppliedSource>();

  get(sessionId: string): string | undefined {
    return loadSession(sessionId)?.meta.chatPersonaId ?? this.selected.get(sessionId);
  }

  /** Application-time source snapshot; survives later registry replacement. */
  appliedSource(sessionId: string): TuiChatPersonaAppliedSource | undefined {
    return this.applied.get(sessionId);
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
    if (!personaId) {
      this.applied.delete(sessionId);
      return;
    }
    const persona = getGlobalPersonaRegistry().get(personaId);
    if (!persona) {
      this.applied.delete(sessionId);
      return;
    }
    const { systemPrompt, sources } = assemblePersonaPrompt(persona, '');
    this.applied.set(sessionId, {
      personaId: persona.personaId,
      displayName: persona.displayName,
      sources,
      systemPrompt,
    });
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
      // 조각 7/9 출처 보존 — 지금 적용된 출처는 적용 시점 스냅샷으로 보여준다.
      // registry 가 이후 교체·오염돼도 이 대화에 적용된 출처는 그대로다.
      const applied = tuiChatPersonaSources(sessionId, selection);
      return `이 대화의 페르소나: ${applied ? `${applied.displayName} (${applied.personaId})` : '없음'}\n고를 수 있는 페르소나: ${personas.map(p => `${p.displayName} (${p.personaId})${p.personaId === selected ? ' (지금)' : ''}`).join(' · ') || '없음'}\n고르기: /persona <이름> · 빼기: /persona -`;
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

/** Applied persona source captured at application time (조각 7/9 출처 보존).
 *  The snapshot lives in a store separate from the registry — the session
 *  meta `chatPersonaId` holds the applied id durably, and this
 *  application-time snapshot holds displayName, sources and systemPrompt —
 *  so replacing or contaminating the registry after the apply cannot
 *  rewrite what this conversation applied. */
export interface TuiChatPersonaAppliedSource {
  /** Source identifier — string-identical to the loader personaId. */
  readonly personaId: string;
  /** Display name as loaded when the persona was applied. */
  readonly displayName: string;
  /** Source breakdown from prompt assembly, captured at apply time. */
  readonly sources: readonly PromptSource[];
  /** System prompt assembled when the persona was applied. */
  readonly systemPrompt: string;
}

/** Resolve the applied persona source (조각 7/9 출처 보존). Serves the
 *  application-time snapshot captured in the selection — per-call registry
 *  re-derivation is not preservation. Falls back to the persisted session
 *  meta `chatPersonaId` plus a registry lookup only when no snapshot exists
 *  yet, e.g. a fresh process restoring a persisted session. */
export function tuiChatPersonaSources(
  sessionId: string, selection: TuiChatPersonaSelection,
): TuiChatPersonaAppliedSource | undefined {
  const captured = selection.appliedSource(sessionId);
  if (captured) return captured;
  const id = selection.get(sessionId);
  if (!id) return undefined;
  const persona = getGlobalPersonaRegistry().get(id);
  if (!persona) return undefined;
  const { systemPrompt, sources } = assemblePersonaPrompt(persona, '');
  return { personaId: id, displayName: persona.displayName, sources, systemPrompt };
}

export function tuiChatPersonaMessages(
  sessionId: string, selection: TuiChatPersonaSelection,
): LLMMessage[] {
  const applied = tuiChatPersonaSources(sessionId, selection);
  return applied?.systemPrompt ? [{ role: 'system', content: applied.systemPrompt }] : [];
}
