/**
 * Obsidian Vault REST surface (OP1 · 2026-07-09).
 * iPad Obsidian 기능을 PWA에 이식. 백엔드 /v1/vault/* (기존 obsidian 헬퍼 wrap) +
 * /v1/vault/file(write). 읽기 API 는 fetchJson, 저장 API 는 409 본문을 살리기 위해 fetchResponse.
 */

import type { DaemonClient } from './daemon-client';

export interface VaultInfo { available: boolean; root?: string; source: string }
export interface VaultEntry { name: string; isDir: boolean; relPath: string }
export interface VaultListResult { cwd: string; base: string; entries: VaultEntry[]; error?: string }
export interface VaultReadResult { path: string; mime: string; size: number; truncated: boolean; mtimeMs: number; content?: string; bytes?: string; error?: string }
export interface SearchMatch { path: string; snippet: string; lineNumber: number }
export interface VaultNote { name: string; relPath: string }
export interface Backlink { path: string; lineNumber: number; snippet: string; headingAnchor?: string }
export interface VaultTag { tag: string; count: number; samplePaths?: string[] }
export interface VaultTemplate { name: string; relPath: string }
export interface GraphNode { id: string; label?: string; path?: string; inDegree?: number; outDegree?: number }
export interface GraphEdge { from: string; to: string }
export interface GraphResult { nodes: GraphNode[]; edges: GraphEdge[]; truncated?: boolean }
export interface OrphanNote { path: string; age?: number; size?: number }
export interface PollChanges { count: number; samplePaths?: string[]; latestMtimeMs?: number }

export class VaultApi {
  constructor(private client: DaemonClient) {}

  private get<T>(path: string): Promise<T> { return this.client.fetchJson<T>(path); }

  info(): Promise<VaultInfo> { return this.get('/v1/vault/info'); }
  list(cwd?: string): Promise<VaultListResult> {
    return this.get(`/v1/vault/list${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
  }
  read(path: string, maxBytes?: number): Promise<VaultReadResult> {
    const q = new URLSearchParams({ path, ...(maxBytes ? { maxBytes: String(maxBytes) } : {}) });
    return this.get(`/v1/vault/read?${q.toString()}`);
  }
  search(q: string, limit = 50): Promise<{ matches: SearchMatch[]; error?: string }> {
    return this.get(`/v1/vault/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }
  notes(query?: string, limit = 500): Promise<{ notes: VaultNote[]; truncated: boolean; error?: string }> {
    return this.get(`/v1/vault/notes?${query ? `query=${encodeURIComponent(query)}&` : ''}limit=${limit}`);
  }
  backlinks(target: string, limit = 100): Promise<{ matches: Backlink[]; error?: string }> {
    return this.get(`/v1/vault/backlinks?target=${encodeURIComponent(target)}&limit=${limit}`);
  }
  tags(): Promise<{ tags: VaultTag[]; error?: string }> { return this.get('/v1/vault/tags'); }
  templates(): Promise<{ templates: VaultTemplate[]; error?: string }> { return this.get('/v1/vault/templates'); }
  graph(focus?: string, hops = 1, limit = 500): Promise<GraphResult> {
    const q = new URLSearchParams({ limit: String(limit), ...(focus ? { focus, hops: String(hops) } : {}) });
    return this.get(`/v1/vault/graph?${q.toString()}`);
  }
  pollChanges(sinceMs: number): Promise<PollChanges> { return this.get(`/v1/vault/poll-changes?sinceMs=${sinceMs}`); }
  orphans(): Promise<{ orphans: OrphanNote[]; scanned?: number; truncated?: boolean; error?: string }> { return this.get('/v1/vault/orphans'); }

  templateExpand(templatePath: string, title?: string): Promise<{ content: string; tokensExpanded: string[]; error?: string }> {
    return this.client.fetchJson('/v1/vault/template-expand', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templatePath, ...(title ? { title } : {}) }),
    });
  }

  /** Vault editor write; 409 retains the conflict body for the editor. */
  async writeNote(payload: { path: string; content: string; lastKnownMtime?: number; createOnly?: boolean }): Promise<{ path?: string; mtimeMs?: number; currentMtime?: number; lastKnownMtime?: number; error?: string }> {
    const res = await this.client.fetchResponse('/v1/vault/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ctype = res.headers.get('content-type') ?? '';
    const body = ctype.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok && res.status !== 409) {
      // 서버가 사람용 문장(`message` · 예: 격리 우주 쓰기 가드 403)을 주면 그것을 보인다 — 코드만 보이면 이유를 모른다.
      const msg = typeof body === 'string' ? body : (body?.message ?? body?.reason ?? body?.error ?? `${res.status}`);
      throw new Error(String(msg));
    }
    return body as { path?: string; mtimeMs?: number; currentMtime?: number; lastKnownMtime?: number; error?: string };
  }

  /** Camera-intake save; keep its established endpoint and conflict contract. */
  async saveNote(payload: { path?: string; markdown: string; title?: string; lastKnownMtime?: number }): Promise<{ path?: string; mtimeMs?: number; currentMtime?: number; error?: string }> {
    const res = await this.client.fetchResponse('/v1/notes/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ctype = res.headers.get('content-type') ?? '';
    const body = ctype.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok && res.status !== 409) {
      const msg = typeof body === 'string' ? body : (body?.reason ?? body?.error ?? `${res.status}`);
      throw new Error(String(msg));
    }
    return body as { path?: string; mtimeMs?: number; currentMtime?: number; error?: string };
  }
}

/** markdown 본문 앞부분에서 frontmatter 분리(경량·gray-matter 유사). */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { frontmatter: null, body: raw };
  return { frontmatter: m[1]!, body: raw.slice(m[0].length) };
}

/** 파일명 확장자 → 종류. */
export function fileKind(name: string): 'markdown' | 'image' | 'pdf' | 'text' | 'other' {
  const n = name.toLowerCase();
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown';
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(n)) return 'image';
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(txt|json|ya?ml|csv|log)$/.test(n)) return 'text';
  return 'other';
}
