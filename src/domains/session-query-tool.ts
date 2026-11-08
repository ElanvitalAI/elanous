import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── session_search 공유 도구 (2026-07-09) — 전 표면 상속 + CLI + 외부 조회 ──
//
// 대표 지시: elanous가 관리하는 **대화 세션**(TUI/CLI·텔레그램·PWA)을 **내용 기반으로
// 검색**하고 **세션 하나의 전체 대화 내용을 열람**한다. 목적은 외부 코딩 에이전트
// (codex·claude code)가 대화를 일일이 옮기지 않고도 `elanous session search/show/list`
// 로 조회 → 내용 확인할 수 있게 하는 것. skill(elanous-session-search)이 이 CLI를 문서화.
//
// READ-ONLY — 세션을 생성/수정/삭제하지 않는다(그건 session-store/CRUD 소관). 여기는
// 조회 전용 창구. 데이터는 ~/.elanous/sessions/<id>.jsonl(대화 전사) + index.json(메타).
//
// 검색 엔진: ripgrep 로 후보 파일을 빠르게 좁힌 뒤(대량 세션 대비) 각 후보를 JS로
// 재스캔해 **message.content** 매칭만 깨끗한 스니펫으로 추린다(툴 JSON 노이즈 제외).
// rg 부재/실패 시 디렉토리 전체 JS 스캔으로 폴백(동일 결과·느릴 뿐).
//
// memory_recall 과 구분: memory_recall = 내가 발송/대화한 이벤트 원장(크로스서피스
// 기억). 여기 session_search = 실제 대화 세션 전사의 내용/ID/텔레그램 검색.

import { rgFilesWithMatchesAsync } from '../tool-runtime/ripgrep-core.js';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';

import { getRecentMessages, getMessagesAround, findRecentMatches } from '../session/recent-context.js';
import { rankByTrigramFts } from '../session/search-index.js';
import {
  listAcpBackendSessions,
  loadAcpBackendSession,
  searchAcpBackendSessions,
  isAcpBackendSessionId,
} from './acp-backend-sessions.js';
import {
  sessionRoot,
  listSessions,
  loadSession,
  resolveSessionId,
  findSessionByTelegramChat,
  deleteSession,
  deleteSessions,
  getActiveSessionId,
  subscribeSession,
  unsubscribeSession,
  listSubscribers,
  subscriberKey,
  attachTelegramBinding,
  attachDiscordBinding,
  detachTelegramBinding,
  detachDiscordBinding,
  isSessionSource,
  type SessionMeta,
  type SerializedMessage,
  type SessionSurface,
} from '../session/index.js';
import { buildSessionContext, formatSessionContext } from '../session/session-context.js';
import { formatSessionDeepLink, resolveSessionDeepLink } from '../session/session-deeplink.js';

// ── LLM tool spec (core-tools 를 통해 전 서피스 상속) ────────────────────
export const SESSION_MANAGE_SPEC: LLMToolSpec = {
  name: 'session_manage',
  description:
    "⭐ 대화 세션 관리 (코어) — elanous가 관리하는 **과거 대화 세션**(TUI·CLI·텔레그램·PWA)을 **내용 기반 검색**하고, **세션 전체 대화를 열람**하고, 목록을 보고, **삭제**하고, **동시 구독**(여러 서피스가 한 세션을 같이 보기)을 관리한다. **'전에 X 얘기한 세션 찾아줘' '그 대화 내용 보여줘' '이 세션 지워줘' '이 세션 지금 누가 보고 있어?' '이 세션 구독할래/나갈래'** 류에 사용. action: search(내용 키워드 검색·rank 관련도순·source/instance/origin 필터)·show(전체 열람)·list(최근 목록)·delete(**파괴적**)·subscribe(구독 합류)·unsubscribe(이탈=leave)·subscribers(누가 보고 있나·presence)·context(세션 자기인지 문맥·결정론 grounded). search/show/list/subscribers/context 는 READ-ONLY. memory_recall(발송/통지 이벤트 원장)과 구분 — 여긴 실제 대화 전사. 외부 codex/claude code 도 `elanous session ...` CLI 로 동일 조회.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'search(기본)|show|list|recent|delete(파괴적)|subscribe|unsubscribe(=leave)|subscribers|context|attach(채널 바인딩·라우팅)|detach|deeplink(@session:<id> 링크 열기).' },
      token: { type: 'string', description: 'deeplink 용 — @session:<id> 딥링크 토큰(다른 서피스가 공유한 링크).' },
      query: { type: 'string', description: 'search 용 — 대화 내용에서 찾을 키워드(대소문자 무시).' },
      sessionId: { type: 'string', description: 'show/delete/subscribe/unsubscribe/subscribers/context 용 — 세션 ID 또는 고유 prefix.' },
      surface: { type: 'string', description: 'subscribe/unsubscribe 용 — cli|telegram|discord|pwa|acp|voice.' },
      endpoint: { type: 'string', description: 'subscribe/unsubscribe 용 — 서피스 엔드포인트(tg chatId·dc channelId·pwa peerId·cli local).' },
      role: { type: 'string', description: 'subscribe 용 — rw(입력 가능·기본)|ro(관전).' },
      subscriberKey: { type: 'string', description: 'unsubscribe 용 — `<surface>:<endpoint>` 키(surface+endpoint 대신).' },
      source: { type: 'string', description: '필터(선택·search/list) — cli | telegram | discord | pwa | tui | voice | unknown.' },
      instance: { type: 'string', description: '필터(선택·search/list) — 생성 인스턴스(prod | test:<repo>). 멀티 엘라누스 출처 구분.' },
      origin: { type: 'string', description: '필터(선택·search/list) — 표면 origin(cli | pwa | tg | dc | native | acp=백엔드 위임 전사).' },
      all: { type: 'boolean', description: 'list 용 — 빈 미션 세션(autopilot spawn)까지 포함(기본 숨김).' },
      minMessages: { type: 'number', description: 'list 용 — 최소 메시지 수 미만 세션 제외(빈 세션 정돈).' },
      rank: { type: 'boolean', description: 'search 용 — true 면 trigram FTS BM25 관련도순 정렬(한국어 CJK·최소 3자). 기본 최신순.' },
      tgChatId: { type: 'number', description: '필터(선택) — 특정 텔레그램 chatId 의 세션만.' },
      tgThreadId: { type: 'number', description: '필터(선택) — 텔레그램 forum thread id(tgChatId 와 함께).' },
      includeTools: { type: 'boolean', description: 'show 용 — tool role 메시지 포함(기본 false·노이즈 제외).' },
      maxChars: { type: 'number', description: 'show 용 — 메시지당 본문 최대 글자수(기본 4000).' },
      limit: { type: 'number', description: 'search=반환 세션 수(기본 20)·list=목록 수(기본 30)·show=메시지 수(기본 전체).' },
    },
    required: [],
  },
};

// ── 결과 타입 ────────────────────────────────────────────────────────
export interface SessionSearchSnippet { role: string; ts: string; text: string }
export interface SessionSearchHit {
  sessionId: string; title: string; source: string; origin?: string; originInstance?: string;
  updatedAt: string; tgChatId?: number; tgThreadId?: number;
  matchCount: number; snippets: SessionSearchSnippet[];
  /** 관련도 점수(rank 모드·trigram BM25·낮을수록 관련도 높음). 미랭크 시 부재. */
  score?: number;
}

/** Injectable seams for tests: alternate session root + rg spawner. */
export interface SessionQueryOpts {
  root?: string;
  /** Returns absolute paths of session files whose raw text matches the
   *  query. Override in tests to avoid depending on `rg` being installed. */
  filesWithMatches?: (query: string, root: string) => Promise<string[] | null>;
  /** fleet 연합(list --all-instances) 대상 인스턴스 — 테스트 주입용. 미지정 시
   *  readLogInstances() 실측(+prod). 각 인스턴스 세션 root = `<stateDir>/sessions`. */
  fleetInstances?: Array<{ name: string; stateDir: string }>;
}

// 운영(비대화) 실행이 만드는 세션의 sourceKind — 크론 매매/발굴 사이클 등. 사용자
// 대화 목록/검색에서 기본 제외(무한 누적으로 대화 스토어 관측을 오염시키지 않게).
// all:true 또는 명시 sourceKind 필터 시 포함. (2026-07-24 세션 등록 유형 검토.)
const OPERATIONAL_SOURCE_KINDS = ['scheduled'] as const;

/** 운영 sourceKind 를 이번 조회에 포함할지 — all:true 이거나 명시 sourceKind 요청 시 포함. */
function includesOperational(args: Record<string, unknown>): boolean {
  return args.all === true || (typeof args.sourceKind === 'string' && !!args.sourceKind);
}

function metaMatchesFilters(m: SessionMeta, args: Record<string, unknown>): boolean {
  if (!includesOperational(args) && m.sourceKind
      && (OPERATIONAL_SOURCE_KINDS as readonly string[]).includes(m.sourceKind)) return false;
  if (typeof args.source === 'string' && args.source && m.source !== args.source) return false;
  if (typeof args.instance === 'string' && args.instance && m.originInstance !== args.instance) return false;
  if (typeof args.origin === 'string' && args.origin && m.origin !== args.origin) return false;
  if (typeof args.tgChatId === 'number' && m.tgChatId !== args.tgChatId) return false;
  if (typeof args.tgThreadId === 'number' && (m.tgThreadId ?? 0) !== args.tgThreadId) return false;
  return true;
}

function snippetAround(content: string, query: string, max = 240): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, max).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - 60);
  const slice = content.slice(start, start + max).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + slice + (start + max < content.length ? '…' : '');
}

/** Default rg pre-filter: `rg -l --ignore-case` over *.jsonl. Returns
 *  matching absolute paths, or null when rg is unavailable (caller then
 *  falls back to a full JS scan). */
async function defaultFilesWithMatches(query: string, root: string): Promise<string[] | null> {
  // 공유 ripgrep-core(async) — rg -l -i --glob *.jsonl. rg 부재/에러 → null(JS 폴백).
  const r = await rgFilesWithMatchesAsync(query, { roots: [root], ignoreCase: true, globs: ['*.jsonl'] });
  return r.ok ? r.paths : null;
}

async function sessionIdsFromCandidates(query: string, root: string, opts: SessionQueryOpts): Promise<string[]> {
  const finder = opts.filesWithMatches ?? defaultFilesWithMatches;
  const paths = await finder(query, root);
  if (paths) return paths.map(p => basename(p, '.jsonl'));
  // Fallback — no rg: scan every *.jsonl in the root by id.
  try {
    return readdirSync(root).filter(f => f.endsWith('.jsonl')).map(f => basename(f, '.jsonl'));
  } catch { return []; }
}

async function doSearch(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'query required for search' };
  const root = opts.root ?? sessionRoot();
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
  const candidateIds = await sessionIdsFromCandidates(query, root, opts);
  const q = query.toLowerCase();
  const rank = args.rank === true || args.sort === 'relevance';
  const hits: SessionSearchHit[] = [];
  // rank 모드용 세션 본문(비-tool 메시지 합침) — trigram FTS 랭킹 입력.
  const docs: { sessionId: string; content: string }[] = [];
  for (const id of candidateIds) {
    const loaded = loadSession(id, root);
    if (!loaded || !metaMatchesFilters(loaded.meta, args)) continue;
    // Conversation content only — skip tool-role rows (their content is
    // command output / JSON noise, not dialog). This also means an rg
    // pre-filter hit inside a tool row won't produce a false session hit.
    const dialog = loaded.messages.filter(
      (msg) => msg.role !== 'tool' && typeof msg.content === 'string',
    );
    const matches = dialog.filter((msg) => msg.content.toLowerCase().includes(q));
    if (matches.length === 0) continue;
    const m = loaded.meta;
    hits.push({
      sessionId: m.id,
      title: m.title,
      source: m.source,
      ...(m.origin ? { origin: m.origin } : {}),
      ...(m.originInstance ? { originInstance: m.originInstance } : {}),
      updatedAt: m.updatedAt,
      ...(m.tgChatId != null ? { tgChatId: m.tgChatId } : {}),
      ...(m.tgThreadId != null ? { tgThreadId: m.tgThreadId } : {}),
      matchCount: matches.length,
      snippets: matches.slice(0, 3).map(msg => ({ role: msg.role, ts: msg.ts, text: snippetAround(msg.content, query) })),
    });
    if (rank) docs.push({ sessionId: m.id, content: dialog.map((d) => d.content).join('\n') });
  }

  // G3 (2026-07-18) — S2 백엔드 위임 전사도 내용검색 합류. A declared
  // SessionSource filters only persisted store rows, so every valid source
  // excludes ACP read-through; only an unfiltered search includes it.
  const searchIncludeAcp = !isSessionSource(args.source)
    && !(typeof args.instance === 'string' && args.instance)
    && (typeof args.origin !== 'string' || !args.origin || args.origin === 'acp');
  if (searchIncludeAcp) {
    for (const r of searchAcpBackendSessions(query)) {
      hits.push({
        sessionId: r.meta.id,
        title: r.meta.title,
        source: r.meta.source,
        origin: r.meta.origin,
        updatedAt: new Date(r.meta.updatedAt).toISOString(),
        matchCount: r.matchCount,
        snippets: r.snippets.map((s) => ({ role: s.role, ts: '', text: s.text })),
      });
    }
  }

  let ranked = false;
  if (rank) {
    // trigram FTS5 BM25 관련도 랭킹(CJK 필수·최소 3자). null=폴백(<3자·FTS 오류) → 최신순.
    const scored = rankByTrigramFts(query, docs);
    if (scored) {
      const scoreMap = new Map(scored.map((s) => [s.sessionId, s.score]));
      for (const h of hits) { const sc = scoreMap.get(h.sessionId); if (sc != null) h.score = sc; }
      // score 있는 것 먼저(오름차순=관련도 높음), 없는 것은 뒤에 최신순.
      hits.sort((a, b) => {
        if (a.score != null && b.score != null) return a.score - b.score;
        if (a.score != null) return -1;
        if (b.score != null) return 1;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
      ranked = true;
    }
  }
  if (!ranked) hits.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)); // newest first (기본·폴백)

  const capped = hits.slice(0, limit);
  return {
    action: 'search', query, hits: capped, count: capped.length,
    ranked,
    note: capped.length === 0
      ? `대화 내용에 "${query}" 포함 세션 없음.`
      : `대화 내용 검색 결과 ${capped.length}건(${ranked ? 'trigram 관련도순' : '최신순'}·READ-ONLY). show 로 전체 열람.`,
  };
}

function formatMessages(messages: SerializedMessage[], includeTools: boolean, maxChars: number, limit?: number): { rows: Array<Record<string, unknown>>; truncated: boolean } {
  let rows = messages.filter(m => includeTools || m.role !== 'tool');
  let truncated = false;
  if (limit && rows.length > limit) { rows = rows.slice(-limit); truncated = true; }
  return {
    rows: rows.map(m => ({
      role: m.role, ts: m.ts,
      content: m.content.length > maxChars ? m.content.slice(0, maxChars) + `… (${m.content.length - maxChars} more)` : m.content,
      ...(m.toolName ? { toolName: m.toolName } : {}),
    })),
    truncated,
  };
}

async function doShow(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const raw = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!raw) return { error: 'sessionId required for show' };
  // G3 (2026-07-18) — 백엔드 위임 세션(acp-cli:...)은 S1 에 없고 S2 에 있음 → read-through 열람.
  if (isAcpBackendSessionId(raw)) {
    const b = loadAcpBackendSession(raw);
    if (!b) return { error: `no backend session matching "${raw}"` };
    const maxChars = typeof args.maxChars === 'number' && args.maxChars > 0 ? Math.floor(args.maxChars) : 4000;
    const rows = b.messages.map((m) => ({ role: m.role, text: m.content.length > maxChars ? m.content.slice(0, maxChars) : m.content }));
    return {
      action: 'show',
      session: {
        id: b.meta.id, title: b.meta.title, source: b.meta.source, origin: b.meta.origin,
        backendId: b.meta.backendId, createdAt: b.meta.createdAt, updatedAt: b.meta.updatedAt, messageCount: b.meta.messageCount,
      },
      messages: rows,
      note: `백엔드 위임 세션 ${b.meta.id}(${b.meta.backendId}) 전체 대화(${rows.length} 메시지·role 교대추론·READ-ONLY).`,
    };
  }
  const root = opts.root ?? sessionRoot();
  let id: string | null;
  try { id = resolveSessionId(raw, root); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  if (!id) return { error: `no session matching "${raw}"` };
  const loaded = loadSession(id, root);
  if (!loaded) return { error: `session ${id} not found` };
  const includeTools = args.includeTools === true;
  const maxChars = typeof args.maxChars === 'number' && args.maxChars > 0 ? Math.floor(args.maxChars) : 4000;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
  const { rows, truncated } = formatMessages(loaded.messages, includeTools, maxChars, limit);
  const m = loaded.meta;
  return {
    action: 'show',
    session: {
      id: m.id, title: m.title, source: m.source, ...(m.origin ? { origin: m.origin } : {}),
      ...(m.originInstance ? { originInstance: m.originInstance } : {}),
      provider: m.provider, model: m.model, createdAt: m.createdAt, updatedAt: m.updatedAt,
      messageCount: m.messageCount, ...(m.tgChatId != null ? { tgChatId: m.tgChatId } : {}),
      ...(m.tgThreadId != null ? { tgThreadId: m.tgThreadId } : {}),
    },
    messages: rows,
    truncated,
    note: `세션 ${m.id} 전체 대화(${rows.length}${truncated ? `/${loaded.messages.length} 최근` : ''} 메시지·READ-ONLY).`,
  };
}

/** fleet 세션 연합 (§10 · list --all-instances) — 등록 인스턴스들의 세션 스토어를
 *  read-only union. "쓰기는 물리 격리·읽기는 연합" 불변식(logs --all 선례). 각 세션에
 *  instance 라벨. 프레임 축(P1~P2)과 독립 — 기존 session store + instance-registry 위. */
async function doListFleet(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 30;
  const hideEmpty = args.all !== true;
  // 인스턴스 목록(stateDir=물리 identity 로 dedup). 실측 모드에선 레지스트리 + prod(~/.elanous)
  // 항상 포함. 테스트 주입(fleetInstances) 시엔 주어진 목록만(실 prod 스캔 안 함 — 결정론).
  const byDir = new Map<string, string>();
  let list = opts.fleetInstances;
  if (!list) {
    byDir.set(join(homedir(), '.elanous'), 'prod'); // prod 는 레지스트리 미등록이어도 항상
    const { readLogInstances } = await import('../mss/logging/instance-registry.js');
    // 격리 test 인스턴스는 기본 제외(세션 오염 방지 · Phase A) — includeTest 로 opt-in.
    const includeTest = args.includeTest === true;
    list = readLogInstances()
      .filter((v) => includeTest || v.kind !== 'test')
      .map((v) => ({ name: v.name, stateDir: v.stateDir }));
  }
  for (const i of list) if (!byDir.has(i.stateDir)) byDir.set(i.stateDir, i.name);
  const merged: Array<Record<string, unknown>> = [];
  const scanned: string[] = [];
  for (const [stateDir, name] of byDir) {
    const root = join(stateDir, 'sessions');
    let rows: SessionMeta[];
    try {
      rows = listSessions({
        ...(isSessionSource(args.source) ? { source: args.source } : {}),
        ...(typeof args.minMessages === 'number' ? { minMessages: args.minMessages } : {}),
        ...(hideEmpty ? { hideEmpty } : {}),
        ...(includesOperational(args) ? {} : { excludeSourceKinds: [...OPERATIONAL_SOURCE_KINDS] }),
      }, root);
    } catch { continue; }
    scanned.push(name);
    for (const m of rows) merged.push({ ...compactMeta(m), instance: name });
  }
  merged.sort((a, b) => ((a.updatedAt as string) < (b.updatedAt as string) ? 1 : -1));
  const capped = merged.slice(0, limit);
  return {
    action: 'list', fleet: true, sessions: capped, count: capped.length,
    instances: scanned,
    note: capped.length === 0
      ? `${scanned.length}개 인스턴스 연합 — 세션 없음.`
      : `${scanned.length}개 인스턴스 세션 연합 ${capped.length}건(read-only union·newest-first·${hideEmpty ? '빈 세션 숨김·' : ''}쓰기 격리·읽기 연합). instance 라벨 포함.`,
  };
}

async function doList(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  // fleet 연합(--all-instances) — 단일 root 조회가 아니라 등록 인스턴스 전체 union.
  if (args.allInstances === true) return doListFleet(args, opts);
  const root = opts.root ?? sessionRoot();
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 30;
  // Telegram-scoped list — a bindings-aware single-session lookup when a
  // chat is given without a broader query.
  if (typeof args.tgChatId === 'number' && (args.source === undefined || args.source === 'telegram')) {
    const bound = findSessionByTelegramChat(args.tgChatId, typeof args.tgThreadId === 'number' ? args.tgThreadId : undefined, undefined, root);
    if (bound) {
      return {
        action: 'list',
        sessions: [compactMeta(bound)],
        count: 1,
        note: `텔레그램 chat ${args.tgChatId} 바인딩 세션(bindings-aware).`,
      };
    }
  }
  // 빈(0msg) 세션(autopilot spawn·"(new session)"·미사용 스크래치)은 기본 숨김 — 사람이 보는
  // 목록 정돈(실데이터 검증). all:true 로 복원.
  const hideEmpty = args.all !== true;
  const excludeSources = Array.isArray(args.excludeSources)
    ? args.excludeSources.filter(isSessionSource)
    : undefined;
  const rows = listSessions({
    ...(isSessionSource(args.source) ? { source: args.source } : {}),
    ...(excludeSources && excludeSources.length ? { excludeSources } : {}),
    ...(includesOperational(args) ? {} : { excludeSourceKinds: [...OPERATIONAL_SOURCE_KINDS] }),
    ...(typeof args.sourceKind === 'string' && args.sourceKind ? { sourceKind: args.sourceKind as SessionMeta['sourceKind'] } : {}),
    ...(typeof args.minMessages === 'number' ? { minMessages: args.minMessages } : {}),
    ...(hideEmpty ? { hideEmpty } : {}),
    ...(typeof args.instance === 'string' && args.instance ? { originInstance: args.instance } : {}),
    ...(typeof args.origin === 'string' && args.origin ? { origin: args.origin } : {}),
    ...(typeof args.tgChatId === 'number' ? { tgChatId: args.tgChatId } : {}),
    ...(typeof args.tgThreadId === 'number' ? { tgThreadId: args.tgThreadId } : {}),
  }, root)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) // newest-first (listSessions keeps index order)
    .slice(0, limit);
  // G3 (2026-07-18) — S2 백엔드 위임 전사(codex/claude ACP · ~/.elanous/acp-sessions)를
  // read-through 로 합류. source=cli/telegram·instance 필터 시 제외(S1 전용), origin 필터는
  // 'acp' 만 통과. A persisted SessionSource always means only that
  // source's store rows; ACP read-through is unfiltered-only. read-only(쓰기경로 무접촉).
  const includeAcp = !isSessionSource(args.source)
    && !(typeof args.instance === 'string' && args.instance)
    && (typeof args.origin !== 'string' || !args.origin || args.origin === 'acp');
  const acpCompact = includeAcp
    ? listAcpBackendSessions()
        .filter((a) => !(hideEmpty && a.messageCount === 0))
        .filter((a) => typeof args.minMessages !== 'number' || a.messageCount >= (args.minMessages as number))
        .map((a) => ({
          id: a.id, title: a.title, source: a.source, origin: a.origin,
          updatedAt: new Date(a.updatedAt).toISOString(), messageCount: a.messageCount, backendId: a.backendId,
        }))
    : [];
  const merged = [...rows.map(compactMeta), ...acpCompact]
    .sort((x, y) => ((x.updatedAt as string) < (y.updatedAt as string) ? 1 : -1))
    .slice(0, limit);
  return {
    action: 'list', sessions: merged, count: merged.length,
    note: `최근 세션 ${merged.length}건(newest-first·${hideEmpty ? '빈 세션 숨김·' : ''}메타만·READ-ONLY${acpCompact.length ? `·백엔드위임 ${acpCompact.length}건 합류` : ''}). search 로 내용검색·show 로 열람.`,
  };
}

async function doDelete(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const raw = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!raw) return { error: 'sessionId required for delete' };
  const root = opts.root ?? sessionRoot();
  let id: string | null;
  try { id = resolveSessionId(raw, root); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  if (!id) return { error: `no session matching "${raw}"` };
  // Capture the title BEFORE deleting so the confirmation names what went.
  const meta = loadSession(id, root)?.meta;
  const deleted = deleteSession(id, root);
  return {
    action: 'delete', deleted, id,
    ...(meta ? { title: meta.title } : {}),
    note: deleted
      ? `세션 ${id.slice(0, 8)} 삭제됨(파괴적·복구불가).`
      : `세션 ${id.slice(0, 8)} 삭제 대상 없음.`,
  };
}

/** 오염/크루프트 세션 벌크 삭제 (파괴적·복구불가). **dry-run 기본** — apply:true 여야 실제
 *  삭제. 안전장치: ①최소 한 개 좁힘 조건(titles·titleContains·empty·before·maxMessages) 필수
 *  (전체 삭제 방지) ②활성 세션 제외 ③삭제 전 title 분포 리포트. 배경 = OH1(2026-07-09 세션
 *  테스트 격리 무력화로 운영 스토어에 픽스처 ~1500건 누출 → session search 가 가짜 기억 반환). */
async function doPurge(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  // ── 좁힘 조건 파싱 ──
  const titles = Array.isArray(args.titles)
    ? args.titles.map(String)
    : typeof args.titles === 'string'
      ? args.titles.split(',').map(s => s.trim()).filter(Boolean)
      : [];
  const titleContains = typeof args.titleContains === 'string' ? args.titleContains.toLowerCase() : '';
  const onlyEmpty = args.empty === true;
  const before = typeof args.before === 'string' && args.before.trim() ? args.before.trim() : '';
  const maxMessages = typeof args.maxMessages === 'number' ? args.maxMessages : undefined;
  const hasPredicate = titles.length > 0 || !!titleContains || onlyEmpty || !!before || maxMessages != null;
  if (!hasPredicate) {
    return { error: 'purge 는 최소 한 개 좁힘 조건 필요(titles·titleContains·empty·before·maxMessages) — 전체 삭제 방지.' };
  }
  // ── base 스코핑(source/instance/origin 은 listSessions 로) ──
  const base = listSessions({
    ...(isSessionSource(args.source) ? { source: args.source } : {}),
    ...(typeof args.instance === 'string' && args.instance ? { originInstance: args.instance } : {}),
    ...(typeof args.origin === 'string' && args.origin ? { origin: args.origin } : {}),
  }, root);
  const activeId = getActiveSessionId();
  const matched = base.filter(m => {
    if (m.id === activeId) return false; // 활성 세션 절대 제외
    if (titles.length && !titles.includes(m.title)) return false;
    if (titleContains && !m.title.toLowerCase().includes(titleContains)) return false;
    if (onlyEmpty && m.messageCount !== 0) return false;
    if (maxMessages != null && m.messageCount > maxMessages) return false;
    if (before && !(m.updatedAt < before)) return false;
    return true;
  });
  // ⭐ 2026-08-19 — 이 산출로 「빈 세션 79건은 «누가» 언제 만들었나」를 물었는데 답할 수 없었다.
  //    `byTitle` 은 제목만 세고, 나머지 축(source·instance)은 ***표본 10행***에만 있었다.
  //    ⇒ 「표본 10/10 이 cli/prod」까지만 말할 수 있고 79건 «전수»는 못 갈랐다.
  //    그래서 전수 계수 축을 하나 더 두고, ⛔ 상한에 닿으면 «닿았다고 말한다»
  //    (수를 잘라 놓고 말 안 하면 그 산출을 읽는 사람은 그것을 전수로 읽는다).
  const BREAKDOWN_CAP = 40;
  // ⛔ 리뷰 must-fix ①② (2026-08-19): 종전 초안은 `${source}/${instance}` 문자열을 키로 만들고
  //    다시 `split('/')` 로 복원했다. 두 가지가 깨진다 —
  //      ⓐ 값에 `/` 가 있으면 복원이 «틀리고» 서로 다른 조합이 «충돌»한다
  //      ⓑ `?? 'unknown-instance'` 가 ***실제 값 "unknown-instance" 와 누락을 같은 칸에 넣는다***
  //         (이 저장소가 하루 종일 쫓던 바로 그 형태다 — 「없음」과 값을 한 칸에 덮기)
  //    ⇒ 그래서 키를 복원하지 않는다. 원 필드를 «그대로 들고» 다니고, 누락은 «칸을 비운다».
  const tally = <T, K>(
    items: readonly T[],
    identity: (item: T) => K,
    keyOf: (key: K) => string,
  ): { rows: Array<{ key: K; count: number }>; distinct: number } => {
    const counts = new Map<string, { key: K; count: number }>();
    for (const item of items) {
      const key = identity(item);
      const slot = counts.get(keyOf(key));
      if (slot) slot.count += 1;
      else counts.set(keyOf(key), { key, count: 1 });
    }
    return {
      rows: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, BREAKDOWN_CAP),
      distinct: counts.size,
    };
  };
  const titles_ = tally(matched, (m) => m.title, (title) => title);
  const byTitle = titles_.rows.map(({ key, count }) => ({ title: key, count }));
  const origins = tally(
    matched,
    // ⛔ 리뷰 2차 must-fix ①: `m.originInstance ?` 는 실제 빈 문자열("")을 «누락»으로 읽어
    //    누락 행과 합친다. 존재 여부는 `!== undefined` 로만 가른다 — 「빈 값」과 「없음」도 다른 값이다.
    (m): { source: string; originInstance?: string } =>
      (m.originInstance !== undefined ? { source: m.source, originInstance: m.originInstance } : { source: m.source }),
    // 누락과 실제 값이 절대 같은 키가 되지 않도록 «있음/없음»을 키에 표지로 싣는다.
    (key) => JSON.stringify([key.source, key.originInstance === undefined ? null : ['v', key.originInstance]]),
  );
  const bySource = origins.rows.map(({ key, count }) => ({ ...key, count }));
  // ⛔ 리뷰 should-fix: 문자열 정렬은 canonical UTC(`…Z`)만 가정한다. `+09:00` 같은 오프셋이
  //    섞이면 「2026-07-09T00:00:00+09:00」이 「2026-07-08T20:00:00Z」보다 «뒤»로 잘못 정렬된다.
  //    ⇒ 시각으로 «파싱해» 비교하고, 못 읽는 값은 «버린다»(0 으로 채우지 않는다).
  const updatedAts = matched
    .map((m) => m.updatedAt)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => ({ value, at: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.value);
  const breakdown = {
    // ⛔ 리뷰 must-fix ③(3라운드까지 지적됨): 「상한에 «닿았나»」와 「실제로 «잘렸나»」는 다른 물음이고
    //    distinct === cap 에서 갈린다 — 정확히 40이면 «다» 실렸으므로 안 잘렸지만 상한에는 닿았다.
    //    ⇒ 한 필드로 둘을 답하려 하면 어느 쪽이든 거짓말이 된다. ***두 물음을 둘 다 낸다.***
    //    ⭐ AtCap 이 참인데 Truncated 가 거짓이면 「지금은 다 보이지만 하나만 늘어도 잘린다」는 뜻이다 —
    //      그것이 이 산출을 자동화에 물리는 쪽이 알아야 하는 값이다.
    breakdownCap: BREAKDOWN_CAP,
    byTitleDistinct: titles_.distinct,
    byTitleAtCap: titles_.distinct >= BREAKDOWN_CAP,
    byTitleTruncated: titles_.distinct > BREAKDOWN_CAP,
    bySourceDistinct: origins.distinct,
    bySourceAtCap: origins.distinct >= BREAKDOWN_CAP,
    bySourceTruncated: origins.distinct > BREAKDOWN_CAP,
    // 「언제부터 쌓였나」 — 하루치 폭주와 몇 주에 걸친 정상 누적을 이 두 값이 가른다.
    ...(updatedAts.length > 0 ? { oldestUpdatedAt: updatedAts[0], newestUpdatedAt: updatedAts.at(-1) } : {}),
  };
  const apply = args.apply === true || args.yes === true;
  if (!apply) {
    return {
      action: 'purge', dryRun: true, matched: matched.length, byTitle, bySource, breakdown,
      sample: matched.slice(0, 10).map(compactMeta),
      note: matched.length === 0
        ? '삭제 대상 없음(조건 매칭 0).'
        : `DRY-RUN — ${matched.length}건 삭제 예정(파괴적·복구불가·활성세션 제외). 확정하려면 apply:true.`,
    };
  }
  const purged = deleteSessions(matched.map(m => m.id), root);
  return {
    action: 'purge', purged, matched: matched.length, byTitle, bySource, breakdown,
    note: `${purged}건 삭제됨(파괴적·복구불가).`,
  };
}

function compactMeta(m: SessionMeta): Record<string, unknown> {
  return {
    id: m.id, title: m.title, source: m.source, ...(m.origin ? { origin: m.origin } : {}),
    ...(m.originInstance ? { originInstance: m.originInstance } : {}),
    updatedAt: m.updatedAt, messageCount: m.messageCount,
    ...(m.tgChatId != null ? { tgChatId: m.tgChatId } : {}),
  };
}

/** session_search 실행 — 전 표면 공용(core-tools) + CLI(elanous session) 공유 디스패처. */
export async function dispatchSessionQuery(
  args: Record<string, unknown> = {},
  opts: SessionQueryOpts = {},
): Promise<unknown> {
  // The tool schema accepts strings, but a supplied source must be part of the
  // persisted source contract. Reject it before dispatch so filters never widen
  // into an unfiltered read or destructive purge.
  if (args.source !== undefined && !isSessionSource(args.source)) {
    return { error: `invalid session source ${JSON.stringify(args.source)}` };
  }
  const action = String(args.action ?? 'search');
  switch (action) {
    case 'search': return doSearch(args, opts);
    case 'show': return doShow(args, opts);
    case 'list': return doList(args, opts);
    case 'delete': return doDelete(args, opts);
    case 'purge': return doPurge(args, opts);
    case 'recent': return doRecent(args, opts);
    case 'subscribe': return doSubscribe(args, opts);
    case 'unsubscribe': return doUnsubscribe(args, opts);
    case 'subscribers': return doSubscribers(args, opts);
    case 'context': return doContext(args, opts);
    case 'attach': return doAttach(args, opts);
    case 'detach': return doDetach(args, opts);
    case 'deeplink': return doDeeplink(args, opts);
    default: return { error: `unknown action "${action}" — use search|show|list|delete|recent|subscribe|unsubscribe|subscribers|context|attach|detach|deeplink` };
  }
}

/** 최신-스코프 빠른 회수(hermes get_messages_around 패턴) — 활성/특정 세션의 최근 대화를
 *  전 코퍼스 스캔 없이 배열 끝에서 즉시. query 주면 최신-우선 검색+주변 윈도, 없으면 최근 N개.
 *  타임스탬프(ts) 노출. READ-ONLY. */
async function doRecent(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const raw = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!raw) return { error: 'sessionId required for recent' };
  const root = opts.root ?? sessionRoot();
  let id: string | null;
  try { id = resolveSessionId(raw, root); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  if (!id) return { error: `no session matching "${raw}"` };
  const loaded = loadSession(id, root);
  if (!loaded) return { error: `session ${id} not found` };

  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
  const includeTool = args.includeTools === true;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const radius = typeof args.radius === 'number' && args.radius >= 0 ? Math.floor(args.radius) : 5;

  if (query) {
    // 최신-우선 검색 → 각 매치 주변 ±radius 윈도.
    const matches = findRecentMatches(loaded.messages, query, { limit, includeTool });
    return {
      action: 'recent', sessionId: id, query, matched: matches.length,
      matches: matches.map(m => ({
        index: m.index, role: m.role, ts: m.ts,
        content: m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content,
        around: getMessagesAround(loaded.messages, m.index, radius).map(w => ({ index: w.index, role: w.role, ts: w.ts, content: w.content.slice(0, 200) })),
      })),
      note: `세션 ${id} 최신-우선 "${query}" 매치 ${matches.length}건(±${radius} 윈도·READ-ONLY).`,
    };
  }
  // query 없음 → 최근 N개 대화(타임스탬프 포함).
  const recent = getRecentMessages(loaded.messages, { limit, includeTool });
  return {
    action: 'recent', sessionId: id, count: recent.length,
    messages: recent.map(m => ({ index: m.index, role: m.role, ts: m.ts, content: m.content.length > 600 ? m.content.slice(0, 600) + '…' : m.content })),
    note: `세션 ${id} 최근 ${recent.length} 대화(끝에서·타임스탬프·READ-ONLY).`,
  };
}

// ── P2 (2026-07-16) — 동시 구독 + presence (구독자 관리·자기인지 노출) ────────
const VALID_SURFACES: SessionSurface[] = ['cli', 'telegram', 'discord', 'pwa', 'acp', 'voice'];

export function resolveSubscriberKeyInput(surfaceRaw: unknown, endpointRaw: unknown): { key: string } | { error: string } {
  const surface = typeof surfaceRaw === 'string' ? surfaceRaw.trim() as SessionSurface : 'cli';
  if (!VALID_SURFACES.includes(surface)) return { error: `surface must be one of ${VALID_SURFACES.join('|')}` };
  const endpoint = typeof endpointRaw === 'string' && endpointRaw.trim() ? endpointRaw.trim() : 'local';
  return { key: subscriberKey(surface, endpoint) };
}

function resolveIdOrErr(raw: string, root: string): { id: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'sessionId required' };
  let id: string | null;
  try { id = resolveSessionId(trimmed, root); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  if (!id) return { error: `no session matching "${trimmed}"` };
  return { id };
}

/** 세션에 서피스 구독 합류(P0 subscribeSession 노출). 전 서피스가 "이 세션 나도 볼래". */
async function doSubscribe(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  const r = resolveIdOrErr(typeof args.sessionId === 'string' ? args.sessionId : '', root);
  if ('error' in r) return r;
  const surface = String(args.surface ?? '') as SessionSurface;
  if (!VALID_SURFACES.includes(surface)) return { error: `surface must be one of ${VALID_SURFACES.join('|')}` };
  const endpoint = typeof args.endpoint === 'string' && args.endpoint.trim() ? args.endpoint.trim() : 'local';
  const role = args.role === 'ro' ? 'ro' : 'rw';
  const meta = subscribeSession(r.id, { surface, endpoint }, { role }, root);
  return {
    action: 'subscribe', sessionId: r.id, subscriber: subscriberKey(surface, endpoint), role,
    subscribers: (meta.bindings?.subscribers ?? []).map(s => subscriberKey(s.surface, s.endpoint)),
    note: `${surface}:${endpoint} 구독 합류(role=${role}). 이 세션 출력이 fan-out 됨.`,
  };
}

/** 세션 구독 취소 = leave(나만 이탈·남은 구독자 유지). */
async function doUnsubscribe(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  const r = resolveIdOrErr(typeof args.sessionId === 'string' ? args.sessionId : '', root);
  if ('error' in r) return r;
  const key = typeof args.subscriberKey === 'string' && args.subscriberKey
    ? args.subscriberKey
    : (typeof args.surface === 'string' && typeof args.endpoint === 'string'
      ? subscriberKey(args.surface as SessionSurface, args.endpoint) : '');
  if (!key) return { error: 'subscriberKey (or surface+endpoint) required' };
  const meta = unsubscribeSession(r.id, key, root);
  if (!meta) return { action: 'unsubscribe', sessionId: r.id, left: false, note: `${key} 구독 아님(no-op).` };
  return {
    action: 'unsubscribe', sessionId: r.id, left: true, subscriber: key,
    remaining: (meta.bindings?.subscribers ?? []).length,
    note: `${key} 이탈(leave·남은 구독자 ${(meta.bindings?.subscribers ?? []).length}).`,
  };
}

/** 세션 구독자 목록 + presence(누가 보고 있나). */
async function doSubscribers(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  const r = resolveIdOrErr(typeof args.sessionId === 'string' ? args.sessionId : '', root);
  if ('error' in r) return r;
  const subs = listSubscribers(r.id, {}, root);
  return {
    action: 'subscribers', sessionId: r.id, count: subs.length,
    subscribers: subs.map(s => ({ key: subscriberKey(s.surface, s.endpoint), surface: s.surface, role: s.role, presence: s.presence, lastSeenAt: s.lastSeenAt })),
    note: subs.length ? `구독자 ${subs.length}(활성 ${subs.filter(s => s.presence === 'active').length}).` : '구독자 없음.',
  };
}

/** 세션 자기인지 문맥(buildSessionContext) — "지금 누가·어디로 도달 가능한가" 결정론. */
async function doContext(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  const r = resolveIdOrErr(typeof args.sessionId === 'string' ? args.sessionId : '', root);
  if ('error' in r) return r;
  const ctx = buildSessionContext(r.id, { load: (id) => loadSession(id, root) });
  return { action: 'context', ...ctx, formatted: formatSessionContext(ctx), deeplink: formatSessionDeepLink(r.id) };
}

// ── P6 (2026-07-16) — attach/detach 바인딩 노출 + @session 딥링크 ─────────────
/** 세션에 채널 바인딩 붙이기(라우팅 키·채널당 1개). subscribe(뷰어 집합)와 구분. */
async function doAttach(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  const r = resolveIdOrErr(typeof args.sessionId === 'string' ? args.sessionId : '', root);
  if ('error' in r) return r;
  const surface = String(args.surface ?? '');
  try {
    if (surface === 'telegram') {
      const chatId = Number(args.endpoint ?? args.tgChatId);
      if (!Number.isFinite(chatId)) return { error: 'telegram attach needs numeric endpoint (chatId)' };
      attachTelegramBinding(r.id, chatId, typeof args.tgThreadId === 'number' ? args.tgThreadId : undefined, root);
    } else if (surface === 'discord') {
      const channelId = String(args.endpoint ?? '');
      if (!channelId) return { error: 'discord attach needs endpoint (channelId)' };
      attachDiscordBinding(r.id, channelId, undefined, root);
    } else {
      return { error: 'attach surface must be telegram | discord' };
    }
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  return { action: 'attach', sessionId: r.id, surface, note: `${surface} 바인딩 attach(라우팅). detach 로 해제.` };
}

/** 세션에서 채널 바인딩 떼기. */
async function doDetach(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  const r = resolveIdOrErr(typeof args.sessionId === 'string' ? args.sessionId : '', root);
  if ('error' in r) return r;
  const surface = String(args.surface ?? '');
  let meta: SessionMeta | null;
  if (surface === 'telegram') meta = detachTelegramBinding(r.id, root);
  else if (surface === 'discord') meta = detachDiscordBinding(r.id, root);
  else return { error: 'detach surface must be telegram | discord' };
  return { action: 'detach', sessionId: r.id, surface, detached: meta != null, note: meta ? `${surface} 바인딩 해제.` : `${surface} 바인딩 없음(no-op).` };
}

/** @session:<id> 딥링크 열기 — 토큰 해소 → 세션 자기인지 문맥(다른 서피스가 열기). */
async function doDeeplink(args: Record<string, unknown>, opts: SessionQueryOpts): Promise<unknown> {
  const root = opts.root ?? sessionRoot();
  const token = typeof args.token === 'string' ? args.token : (typeof args.sessionId === 'string' ? args.sessionId : '');
  const id = resolveSessionDeepLink(token, root);
  if (!id) return { action: 'deeplink', found: false, token, note: `딥링크 "${token}" 해소 실패(없거나 모호 — 더 긴 prefix 필요).` };
  const ctx = buildSessionContext(id, { load: (sid) => loadSession(sid, root) });
  return { action: 'deeplink', found: true, sessionId: id, deeplink: formatSessionDeepLink(id), context: ctx, formatted: formatSessionContext(ctx) };
}
