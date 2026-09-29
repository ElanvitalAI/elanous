/**
 * BACKLOG #11 — TerminalChatDock cross-surface history hydrate.
 *
 * dock 의 `messages` state 는 자체 useState 라 새로고침/멀티-디바이스 시
 * daemon-side 가 들고 있는 turn history 를 다시 못 본다. 이 helper 가
 * `GET /v1/sessions/store/:id` (on-disk 단일 진실원) 의 응답을
 * dock-friendly `ChatMessage[]` 로 매핑한다.
 *
 * PWA 파리티 P4(2026-07-12): 구 in-memory `GET /v1/sessions/:id` → 신
 * store 엔드포인트 이관 — 채팅/세션 목록과 같은 진실원. store 는 R3
 * write-through 미러가 콘텐츠 블록을 `[image]` 식 문자열로 정규화해
 * 기록하므로 기존 placeholder 축약과 동급 충실도. 블록 배열 매핑은
 * legacy 데이터 방어용으로 유지.
 *
 * Forward-compatible policy:
 * - **404** (not_found) → null. fresh sessionId 인 경우 — 첫 턴 기록 전.
 * - **network/parse error** → null + debug.log. UI 가 noise 안 받게.
 */

import {
  newMetaMessage,
  newUserMessage,
  type ChatMessage,
} from './chat-runtime';
import type { DaemonClient } from './daemon-client';
import { debugLog } from './debug';

const HISTORY_TAIL_LIMIT = 200;

interface ServerLLMMessage {
  role?: string;
  content?: unknown;
  /** store transcript 의 tool 행 라벨 (P4). */
  toolName?: string;
}

interface SessionHistoryResponse {
  ok?: boolean;
  messages?: ServerLLMMessage[];
}

interface ContentBlockText { type: 'text'; text: string }
interface ContentBlockImage { type: 'image' }
interface ContentBlockAudio { type: 'audio' }
interface ContentBlockToolUse { type: 'tool_use'; name?: string }
interface ContentBlockToolResult { type: 'tool_result' }

type AnyContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockAudio
  | ContentBlockToolUse
  | ContentBlockToolResult
  | { type?: string };

/** Extract a single human-readable string from an LLMMessage.content
 *  union. Plain strings pass through; ContentBlock[] flattens text
 *  segments and replaces media/tool blocks with single-glyph hints. */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as AnyContentBlock[]) {
    if (block && typeof block === 'object') {
      const t = (block as { type?: string }).type;
      if (t === 'text' && typeof (block as ContentBlockText).text === 'string') {
        parts.push((block as ContentBlockText).text);
      } else if (t === 'image') {
        parts.push('📎 image');
      } else if (t === 'audio') {
        parts.push('📎 audio');
      } else if (t === 'tool_use') {
        const name = (block as ContentBlockToolUse).name ?? 'tool';
        parts.push(`🛠️ ${name}`);
      } else if (t === 'tool_result') {
        parts.push('🛠️ result');
      }
    }
  }
  return parts.join('\n').trim();
}

export function mapServerMessageToChat(msg: ServerLLMMessage, idx: number): ChatMessage | null {
  const role = msg.role;
  // store 의 tool 행은 장문(브레드크럼)일 수 있어 구 tool_use 블록 축약과
  // 동급인 `🛠️ <name>` 한 줄 meta 로 접는다 (P4).
  if (role === 'tool') {
    return { ...newMetaMessage(`🛠️ ${msg.toolName || 'tool'}`), id: `hydrate-t-${idx}` };
  }
  const text = extractMessageText(msg.content);
  if (text.length === 0) return null;
  if (role === 'user') {
    return { ...newUserMessage(text), id: `hydrate-u-${idx}` };
  }
  if (role === 'assistant') {
    return {
      id: `hydrate-a-${idx}`,
      role: 'assistant',
      text,
      timestamp: Date.now(),
      meta: { provider: 'history' },
    };
  }
  // system / tool / unknown — surface as meta line so the user sees the
  // fact something happened without polluting the chat bubble flow.
  if (role === 'system') return null;
  return { ...newMetaMessage(text), id: `hydrate-m-${idx}` };
}

export function mapServerHistoryToChat(messages: readonly ServerLLMMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  messages.forEach((msg, idx) => {
    const mapped = mapServerMessageToChat(msg, idx);
    if (mapped) out.push(mapped);
  });
  return out.slice(-HISTORY_TAIL_LIMIT);
}

/** Fetch + map a session's daemon-side history. Resolves to `null` on
 *  any non-200 (404 unknown / 503 not-wired / network) — dock falls
 *  back to its empty in-memory history without surfacing an error. */
export async function fetchDockHistory(
  client: DaemonClient,
  sessionId: string,
): Promise<ChatMessage[] | null> {
  if (!sessionId || sessionId.length === 0) return null;
  try {
    const data = await client.fetchJson<SessionHistoryResponse>(
      `/v1/sessions/store/${encodeURIComponent(sessionId)}?ifExists=1`,
    );
    if (!data || !Array.isArray(data.messages)) return null;
    const mapped = mapServerHistoryToChat(data.messages);
    debugLog('webterm.terminal-chat.hydrate.ok', {
      sessionId,
      serverCount: data.messages.length,
      mappedCount: mapped.length,
    });
    return mapped;
  } catch (e) {
    debugLog('webterm.terminal-chat.hydrate.skip', {
      sessionId,
      reason: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Test seam — exposed so unit tests can assert the cap. */
export const __INTERNAL_HISTORY_TAIL_LIMIT = HISTORY_TAIL_LIMIT;
