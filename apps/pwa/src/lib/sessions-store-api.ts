// ── 라이브 세션 관리 API 클라이언트 (S2 · 2026-07-09) ──────────────────────
// on-disk 세션 표면(/v1/sessions/store) 소비. 목록·transcript·fork.
// 백엔드: src/nexus/api/sessions-store.ts.

import type { DaemonClient } from './daemon-client';

export interface SessionStoreCard {
  id: string;
  title: string;
  source: string;          // 'cli' | 'telegram'
  origin?: string;         // 'cli' | 'pwa' | 'tg' | 'dc' — 세밀 라벨(PWA 챗 구분)
  sourceKind?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  forkedFromId?: string;
  preview: string;
  active: boolean;         // updatedAt < 10m
}

export interface SessionTranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts: string;
  toolName?: string;
}

export interface SessionTranscript {
  ok: boolean;
  meta: SessionStoreCard & Record<string, unknown>;
  messages: SessionTranscriptMessage[];
}

export class SessionsStoreApi {
  constructor(private client: DaemonClient) {}

  /** on-disk 세션 목록(newest-first). includeEmpty=빈 세션 포함. */
  async list(includeEmpty = false): Promise<{ ok: boolean; sessions: SessionStoreCard[]; total: number; ts: string }> {
    const q = includeEmpty ? '?includeEmpty=1' : '';
    return this.client.fetchJson(`/v1/sessions/store${q}`);
  }

  /** 세션 transcript(내용 보기). */
  async transcript(id: string): Promise<SessionTranscript> {
    return this.client.fetchJson(`/v1/sessions/store/${encodeURIComponent(id)}`);
  }

  /** 히스토리 복사 새 세션(fork) → 새 세션 id.
   *  S3 타임트래블(P2): `beforeUser=N` 이면 N번째(1-based) 사용자 발화 직전으로
   *  절단해 분기 — CLI `--before-user` 와 의미론 동일. 생략 시 풀카피. */
  async fork(
    id: string,
    opts: { beforeUser?: number } = {},
  ): Promise<{ ok: boolean; id?: string; meta?: SessionStoreCard; error?: string }> {
    return this.client.fetchJson(`/v1/sessions/store/${encodeURIComponent(id)}/fork`, {
      method: 'POST',
      ...(opts.beforeUser !== undefined
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ beforeUser: opts.beforeUser }),
          }
        : {}),
    });
  }

  /** on-disk 세션 삭제(파괴적·복구불가·index+jsonl 제거). */
  async delete(id: string): Promise<{ ok: boolean; deleted?: boolean; error?: string }> {
    return this.client.fetchJson(`/v1/sessions/store/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

/** id prefix resolve (P3 · 2026-07-12) — 디스코드 `!attach <prefix>` 동형.
 *  유일 일치만 attach 허용 · 대소문자 무시 · 모호하면 개수 반환(더 긴 입력 유도). */
export function resolveSessionPrefix(
  sessions: readonly Pick<SessionStoreCard, 'id'>[],
  prefix: string,
): { kind: 'one'; id: string } | { kind: 'none' } | { kind: 'ambiguous'; count: number } {
  const q = prefix.trim().toLowerCase();
  if (!q) return { kind: 'none' };
  const matches = sessions.filter((s) => s.id.toLowerCase().startsWith(q));
  if (matches.length === 1) return { kind: 'one', id: matches[0]!.id };
  if (matches.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', count: matches.length };
}

/** ISO 시각 → 상대 표기(방금·N분 전·N시간 전·N일 전). */
export function relativeTime(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 30) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
