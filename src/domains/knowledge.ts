// ── R3 · P4 지식레이어 v1 (2026-07-06 · ROADMAP-organic-signal-engine) ──
//
// "지금 신호"에 "과거 유사국면"을 붙여 해상도를 올린다. 주간/월간 증류 후
// raw(breaking_signals)는 90일 휘발하되, 유의 신호·디깅·알파 리포트는
// 벡터로 영속 (~/.elanous/conatus/knowledge.db — 13F용 ~/.elanous/knowledge.db와 별개).
//
// 임베딩(D2): 로컬 LM Studio nomic(768d) 1순위 → OpenAI text-embedding-3-small
// (dimensions:768) 폴백. 문서에 embed_model 태깅 — 질의와 같은 모델 공간끼리만 매칭.
//
// 검색: docs.embedding BLOB 전수 JS cosine (수천 건 규모 ~ms — 스파이크 실측 9ms).
// ⚠️ D1(sqlite-vec) 조정: bun은 setCustomSQLite를 "첫 DB open 전 1회"만 허용 →
// 데몬(기동 즉시 여러 DB open)에서 extension 로딩 원천 불가를 스파이크로 실측.
// 단일파일·무데몬이라는 D1 의도는 유지, 코퍼스 1만+ 시 vec0 인덱스 도입(스파이크 검증됨).
//
// ingest 멱등(id PK·기존 skip) — 소스: ① breaking_signals(스코어 6+, 휘발 전 영속)
// ② dig_reports ③ alpha_reports/*.md(섹션 청킹). READ-ONLY 지식 — 매매는 verify+HITL.

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { scanDocs } from '../autopilot/discovery/doc-inventory.js';
import { KNOWN_PREFIXES } from '../autopilot/discovery/doc-lint.js';
import { getOpenAIApiKey } from '../config.js';
import { debug } from '../debug/log.js';
import { SIGNALS_DB_PATH } from './breaking-signals.js';
import { surfaceEventsDbPath } from './surface-events.js';
import { memoryDbPath, migrateLegacyMemoryDb } from './memory-db-path.js';
import { conatusPath } from './conatus-data-dir.js';

// managed memory 네임스페이스(2026-07-19 일반화) — 시맨틱 self-memory. ★scoped(Phase E · 2026-07-24):
// 종전 global(인스턴스 무관 단일 공유)은 격리 test 가 prod 회상 코퍼스(self-recall docs·taste)를 오염시켰다
// (대표 결정: 격리 우선·재구축 비용 감수). memoryDbPath scoped → prod=`~/.elanous/memory/knowledge.db`(불변)·
// 격리 test=`<ELANOUS_STATE_DIR>/knowledge.db`(빈 시작). 종전 `~/.elanous/conatus/` legacy 는 prod open 시 자가치유 이전.
export function knowledgeDbPath(): string { return memoryDbPath('knowledge.db'); }
const ALPHA_REPORTS_DIR = conatusPath('alpha_reports');

const LMSTUDIO_URL = 'http://localhost:1234/v1/embeddings';
const LMSTUDIO_MODEL = 'text-embedding-nomic-embed-text-v1.5';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 768; // nomic 고정 · OpenAI 폴백도 dimensions:768로 맞춤

export interface KnowledgeDoc {
  id: string; ts: string;
  // xreport/morning = Conatus 소급 인제스트(2026-07-07 — openclaw 시절
  // X 데일리·아침 종합 리포트 md 아카이브 · 1회 backfill · 신규 생성 없음).
  // outbound = 크로스서피스 기억 편입(Block 2 · 2026-07-07): elanous가 발송한
  //   유의(importance>=floor) 알림/신호를 의미(벡터) 회상 대상으로 영속. FTS
  //   키워드 회상(memory_recall)의 크로스링구얼 한계("수급"↔"순매수")를 임베딩이 보완.
  //   docs = self-awareness(2026-07-08): 외부 도구(Claude Code/Codex)가 구현 후 남긴
  //     HANDOFF/REPORT/PLAN 문서를 벡터 회상 대상으로 영속. elanous 가 "내가 뭘 구현했나"를
  //     의미검색으로 회상(domain='elanous'). [[self-awareness]].
  //   memory = M3 consolidation(2026-07-08): 흐린 에피소드 다수를 의미 umbrella 1건으로
  //     압축·영속(에피소드→의미·수면 공고화). 원본은 consolidated 마킹.
  kind: 'signal' | 'dig' | 'alpha' | 'xreport' | 'morning' | 'outbound' | 'docs' | 'memory' | 'taste' | 'reference';
  sector_tags: string | null;
  text: string;
  source_ref: string | null;
  embed_model: string;
  /** GEN 소급 — 도메인(finance | <future>). 미지정 시 finance. surface_events와 공유 축. */
  domain?: string | null;
}

export interface KnowledgeMatch extends KnowledgeDoc { similarity: number }

export type EmbedFn = (text: string) => Promise<{ vector: Float32Array; model: string }>;

export function openKnowledgeDb(path: string = knowledgeDbPath()): Database {
  // 기본 경로일 때만 legacy conatus/ → memory/ 자가치유 이전(명시경로 side-effect 방지). scoped 라
  // 격리 test(ELANOUS_STATE_DIR)는 migrateLegacyMemoryDb 가 early-return → prod legacy 무접촉.
  if (path === knowledgeDbPath()) migrateLegacyMemoryDb('knowledge.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS docs(
    id TEXT PRIMARY KEY, ts TEXT NOT NULL,
    kind TEXT NOT NULL, sector_tags TEXT, text TEXT NOT NULL,
    source_ref TEXT, embed_model TEXT NOT NULL, embedding BLOB NOT NULL,
    domain TEXT
  )`);
  // GEN 소급 — 기존 docs에 domain 없으면 추가(비-Conatus 도메인 대비·surface_events와 공유 축).
  const cols = (db.prepare(`PRAGMA table_info(docs)`).all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('domain')) db.run(`ALTER TABLE docs ADD COLUMN domain TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_docs_kind_ts ON docs(kind, ts)`);
  // DocOps P2(2026-07-13) — 키워드(BM25) 검색면. surface-events events_fts
  // 선례 동형(독립 fts5 테이블·porter). 벡터(cosine)와 하이브리드 RRF 융합.
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    id UNINDEXED, search_text, tokenize = 'porter'
  )`);
  try {
    migrateDocPathKeys(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** FTS 백필 — docs 에 있는데 docs_fts 에 없는 행 합류(초회 1번 비용·이후 no-op).
 *  knowledge-ingest 크론이 매 주기 호출(멱등). 반환 = 신규 색인 수. */
export function backfillDocsFts(db: Database): number {
  const missing = db.prepare(
    `SELECT id, text FROM docs WHERE id NOT IN (SELECT id FROM docs_fts)`,
  ).all() as Array<{ id: string; text: string }>;
  if (missing.length === 0) return 0;
  const ins = db.prepare(`INSERT INTO docs_fts (id, search_text) VALUES (?, ?)`);
  const tx = db.transaction((rows: typeof missing) => { for (const r of rows) ins.run(r.id, r.text); });
  tx(missing);
  return missing.length;
}

// ── 임베딩 (D2: 로컬 우선 + OpenAI 폴백 · 실패 시 throw — 호출측 fail-soft) ──

async function embedLmStudio(text: string): Promise<Float32Array> {
  const res = await fetch(LMSTUDIO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LMSTUDIO_MODEL, input: text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`LM Studio embeddings HTTP ${res.status}`);
  const json = (await res.json()) as any;
  const e = json?.data?.[0]?.embedding;
  if (!Array.isArray(e)) throw new Error('LM Studio embeddings: malformed response');
  return new Float32Array(e);
}

async function embedOpenAI(text: string): Promise<Float32Array> {
  const key = getOpenAIApiKey();
  if (!key) throw new Error('OpenAI fallback unavailable: no API key');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    // dimensions:768 — nomic과 차원만 맞춤(공간은 다름 → embed_model 태그로 격리)
    body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: text, dimensions: EMBED_DIM }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}`);
  const json = (await res.json()) as any;
  const e = json?.data?.[0]?.embedding;
  if (!Array.isArray(e)) throw new Error('OpenAI embeddings: malformed response');
  return new Float32Array(e);
}

/** 기본 임베더 — LM Studio → OpenAI 폴백. 모델명 태깅해 반환. */
export const defaultEmbed: EmbedFn = async (text) => {
  try {
    return { vector: await embedLmStudio(text), model: LMSTUDIO_MODEL };
  } catch {
    return { vector: await embedOpenAI(text), model: `${OPENAI_EMBED_MODEL}@${EMBED_DIM}` };
  }
};

// ── ingest (멱등 — id 존재 시 skip) ──

function existingIds(db: Database): Set<string> {
  return new Set((db.prepare(`SELECT id FROM docs`).all() as Array<{ id: string }>).map(r => r.id));
}

async function insertDoc(db: Database, doc: Omit<KnowledgeDoc, 'embed_model'>, embed: EmbedFn): Promise<void> {
  const { vector, model } = await embed(doc.text);
  const r = db.prepare(`INSERT OR IGNORE INTO docs(id, ts, kind, sector_tags, text, source_ref, embed_model, embedding, domain)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(doc.id, doc.ts, doc.kind, doc.sector_tags, doc.text, doc.source_ref, model,
      new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), doc.domain ?? 'finance');
  // P2 — FTS 동기 색인(신규 행만 · IGNORE 중복은 스킵).
  if (Number(r.changes ?? 0) > 0) {
    db.prepare(`INSERT INTO docs_fts (id, search_text) VALUES (?, ?)`).run(doc.id, doc.text);
  }
}

/** 알파 리포트 청킹 — `## ` 섹션 단위, 짧은 섹션은 앞뒤로 합쳐 ~2400자 이내. */
export function chunkReport(md: string, maxChars = 2400): string[] {
  const sections = md.split(/\n(?=## )/);
  const chunks: string[] = [];
  let buf = '';
  for (const s of sections) {
    if (buf && buf.length + s.length > maxChars) { chunks.push(buf.trim()); buf = ''; }
    buf = buf ? `${buf}\n${s}` : s;
    while (buf.length > maxChars) { // 단일 초대형 섹션 하드 분할
      chunks.push(buf.slice(0, maxChars).trim());
      buf = buf.slice(maxChars);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/** 문서의 절대 경로를 트리 식별자를 포함한 안정 키로 쓴다. 상대 source_ref는 현재 트리 기준으로 절대화한다. */
function docPathKey(path: string): string {
  return isPortableAbsolutePath(path) ? path : resolve(path);
}

function isPortableAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function sourceBasename(path: string): string {
  return isPortableAbsolutePath(path) && !isAbsolute(path) ? win32.basename(path) : basename(path);
}

function docChunkId(path: string, chunk: number, kind: KnowledgeDoc['kind'] = 'docs'): string {
  return `${kind}:${docPathKey(path)}#${chunk}`;
}

/** ★ self-awareness(2026-07-08) — 단일 문서 파일(md)을 벡터 회상 대상으로 인제스트.
 *  청킹(chunkReport 재사용) + 임베딩(defaultEmbed) + 멱등(id=docs:<절대경로>#<i>·기존 skip).
 *  기본 domain='elanous'·kind='docs' — finance 신호와 격리 검색. 외부 도구 구현 문서 주입용.
 *  임베딩/삽입 실패 청크는 skip(fail-soft — 다음 재시도). */
export async function ingestDocFile(
  db: Database,
  opts: { path: string; domain?: string; kind?: KnowledgeDoc['kind']; embed?: EmbedFn; ts?: string },
): Promise<{ chunks: number; skipped: number }> {
  const embed = opts.embed ?? defaultEmbed;
  const path = docPathKey(opts.path);
  const md = readFileSync(path, 'utf-8');
  const ts = opts.ts ?? new Date().toISOString();
  const seen = existingIds(db);
  const chunks = chunkReport(md);
  const kind = opts.kind ?? 'docs';
  let ok = 0, skipped = 0;
  for (let i = 0; i < chunks.length; i++) {
    const id = docChunkId(path, i, kind);
    if (seen.has(id)) continue; // 멱등 — 이미 인제스트됨
    try {
      await insertDoc(db, {
        id, ts, kind, sector_tags: null,
        text: chunks[i]!, source_ref: path, domain: opts.domain ?? 'elanous',
      }, embed);
      ok++;
    } catch { skipped++; }
  }
  return { chunks: ok, skipped };
}

/** ★ M5 knowledge retention — 오래된 저가치 벡터 doc 정리(코퍼스 무한증식·전수 cosine
 *  스캔 O(n) 완화). 기본: signal/outbound 중 maxAgeDays(180) 초과 삭제. docs(self-awareness)
 *  ·memory(M3 umbrella)·alpha 는 보존(장기 가치). 삭제 건수 반환. 지식은 memory umbrella
 *  (M3)로 이미 압축·영속됐으므로 원본 raw signal 정리는 안전. */
export function pruneKnowledge(db: Database, opts: { maxAgeDays?: number; kinds?: Array<KnowledgeDoc['kind']>; nowExpr?: string } = {}): number {
  const maxAgeDays = opts.maxAgeDays ?? 180;
  const kinds = opts.kinds ?? ['signal', 'outbound'];
  const ph = kinds.map(() => '?').join(',');
  const ids = (db.prepare(
    `SELECT id FROM docs WHERE kind IN (${ph}) AND ts < datetime(?, ?)`,
  ).all(...kinds, opts.nowExpr ?? 'now', `-${maxAgeDays} days`) as Array<{ id: string }>).map(r => r.id);
  if (!ids.length) return 0;
  db.prepare(`DELETE FROM docs_fts WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids); // P2 — FTS 동기
  db.prepare(`DELETE FROM docs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  return ids.length;
}

/** ★ M3 — 단일 텍스트(에피소드 umbrella 등)를 벡터 회상 대상으로 영속(멱등·id 존재 시 skip).
 *  insertDoc 공개 래퍼. consolidateEpisodes 가 kind='memory' 로 사용. 임베딩 실패=throw(호출측 catch). */
export async function ingestText(
  db: Database,
  doc: { id: string; ts: string; kind: KnowledgeDoc['kind']; text: string; domain?: string; sector_tags?: string | null; source_ref?: string | null },
  embed: EmbedFn = defaultEmbed,
): Promise<boolean> {
  const seen = existingIds(db);
  if (seen.has(doc.id)) return false; // 멱등
  await insertDoc(db, { id: doc.id, ts: doc.ts, kind: doc.kind, sector_tags: doc.sector_tags ?? null, text: doc.text, source_ref: doc.source_ref ?? null, domain: doc.domain ?? 'general' }, embed);
  return true;
}

/** self-awareness 문서 코퍼스 파일명 패턴 — 구현/설계 기록만(index·vision 등 제외). */
export const SELF_DOC_PATTERN = /^(HANDOFF|REPORT|PLAN|RESEARCH|ROADMAP|RFC|RECAP|FEATURE)-.*\.md$/i;

// ── 증분 인덱싱 상태 (DocOps P0 · 2026-07-13) ─────────────────────────
//
// 종전엔 매 사이클 전 파일을 read+chunk 하고(낭비) 청크 id 존재 시 skip —
// **수정된 문서(living doc)는 영원히 stale 청크**로 남았다. mtime 상태
// 테이블로 ① 무변경 파일은 stat 만으로 통과 ② 수정 파일은 구청크 교체.

function ensureDocsIngestState(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS docs_ingest_state(
    file TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    ingested_at TEXT NOT NULL
  )`);
}

const DOC_PATH_KEY_MIGRATION = 'doc-path-keys-v1';

/** ingestDocFile이 만든 basename id를 검증 가능한 절대 source_ref 기반 경로 id로 in-place 이전한다.
 * 상대 source_ref는 원래 인제스트 트리를 복원할 provenance가 없으므로 보존한다. 표식 판독부터
 * docs·FTS·상태 갱신까지 BEGIN IMMEDIATE 한 트랜잭션에 두며, 성공한 DB는 다시 스캔하지 않는다. */
function migrateDocPathKeys(db: Database): void {
  type DocRow = { id: string; ts: string; kind: KnowledgeDoc['kind']; sector_tags: string | null; text: string; source_ref: string | null; embed_model: string; embedding: Uint8Array; domain: string | null };
  type StateRow = { file: string; mtime_ms: number; chunk_count: number; ingested_at: string };
  const stats = {
    migrated: 0, skippedNoSource: 0, skippedCollision: 0, mergedDuplicate: 0,
    migratedState: 0, skippedState: 0,
  };

  db.run('BEGIN IMMEDIATE');
  try {
    ensureDocsIngestState(db);
    db.run(`CREATE TABLE IF NOT EXISTS knowledge_schema_migrations(
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const applied = db.prepare(`SELECT 1 FROM knowledge_schema_migrations WHERE name = ?`).get(DOC_PATH_KEY_MIGRATION);
    if (applied) {
      db.run('COMMIT');
      return;
    }

    const rows = db.prepare(
      `SELECT id, ts, kind, sector_tags, text, source_ref, embed_model, embedding, domain FROM docs`,
    ).all() as DocRow[];
    const legacyState = (db.prepare(
      `SELECT file, mtime_ms, chunk_count, ingested_at FROM docs_ingest_state`,
    ).all() as StateRow[]).filter(state => !isPortableAbsolutePath(state.file));
    const getDoc = db.prepare(`SELECT id, ts, kind, sector_tags, text, source_ref, embed_model, embedding, domain FROM docs WHERE id = ?`);
    const getState = db.prepare(`SELECT file, mtime_ms, chunk_count, ingested_at FROM docs_ingest_state WHERE file = ?`);
    const updateDoc = db.prepare(`UPDATE docs SET id = ? WHERE id = ?`);
    const deleteDoc = db.prepare(`DELETE FROM docs WHERE id = ?`);
    const updateFts = db.prepare(`UPDATE docs_fts SET id = ? WHERE id = ?`);
    const deleteFts = db.prepare(`DELETE FROM docs_fts WHERE id = ?`);
    const ftsExists = db.prepare(`SELECT 1 FROM docs_fts WHERE id = ?`);
    const updateState = db.prepare(`UPDATE docs_ingest_state SET file = ? WHERE file = ?`);
    const deleteState = db.prepare(`DELETE FROM docs_ingest_state WHERE file = ?`);
    const sourcePathsByLegacyState = new Map<string, Set<string>>();
    const docsEqual = (left: DocRow, right: DocRow): boolean =>
      left.ts === right.ts && left.kind === right.kind && left.sector_tags === right.sector_tags &&
      left.text === right.text && left.source_ref === right.source_ref && left.embed_model === right.embed_model &&
      left.domain === right.domain && Buffer.from(left.embedding).equals(Buffer.from(right.embedding));
    const statesEqual = (left: StateRow, right: StateRow): boolean =>
      left.mtime_ms === right.mtime_ms && left.chunk_count === right.chunk_count && left.ingested_at === right.ingested_at;

    for (const row of rows) {
      if (!row.source_ref || !isPortableAbsolutePath(row.source_ref)) { stats.skippedNoSource++; continue; }
      const sourcePath = row.source_ref;
      const match = /^([^:]+):(.+)#(\d+)$/.exec(row.id);
      // 레거시 ingestDocFile 은 kind 와 무관하게 `docs:` 접두를 하드코딩했다 — 이 결함의 행은
      // `docs:<basename>#N` 뿐이다. 다른 파이프라인이 의도적으로 쓰는 `<kind>:` 접두
      // (alpha:<file>#N 등)는 이 결함이 아니므로 근거 없이 재작성하지 않는다.
      if (!match || match[1] !== 'docs' || match[2] !== sourceBasename(sourcePath)) continue;
      const nextId = docChunkId(sourcePath, Number(match[3]), row.kind);
      if (row.kind === 'docs') {
        const legacyStateKey = sourceBasename(sourcePath);
        const statePaths = sourcePathsByLegacyState.get(legacyStateKey) ?? new Set<string>();
        statePaths.add(sourcePath);
        sourcePathsByLegacyState.set(legacyStateKey, statePaths);
      }
      const existing = getDoc.get(nextId) as DocRow | null;
      if (existing) {
        if (docsEqual(row, existing)) {
          // 대상 docs 행은 있으나 FTS 행이 없는 부분 마이그레이션: 레거시 FTS 를 새 id 로
          // 이전해 검색 색인을 보존한다. 대상 FTS 가 이미 있을 때만 레거시를 중복으로 삭제.
          if (ftsExists.get(nextId)) deleteFts.run(row.id);
          else updateFts.run(nextId, row.id);
          deleteDoc.run(row.id);
          stats.mergedDuplicate++;
        } else {
          stats.skippedCollision++;
        }
        continue;
      }
      updateDoc.run(nextId, row.id);
      updateFts.run(nextId, row.id);
      stats.migrated++;
    }
    for (const state of legacyState) {
      const paths = sourcePathsByLegacyState.get(state.file);
      if (paths?.size !== 1) { stats.skippedState++; continue; }
      const target = [...paths][0]!;
      const existing = getState.get(target) as StateRow | null;
      if (!existing) {
        updateState.run(target, state.file);
        stats.migratedState++;
      } else if (statesEqual(state, existing)) {
        deleteState.run(state.file);
        stats.migratedState++;
      } else {
        stats.skippedState++;
      }
    }
    db.prepare(`INSERT INTO knowledge_schema_migrations(name, applied_at) VALUES (?, ?)`)
      .run(DOC_PATH_KEY_MIGRATION, new Date().toISOString());
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  debug.log('knowledge.docs', 'path-key-migration', stats);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 파일의 기존 청크(`docs:<절대경로>#i`) 일괄 삭제 — 재인제스트 전 교체용. */
function deleteDocChunks(db: Database, path: string): number {
  const like = `docs:${escapeLike(docPathKey(path))}#%`;
  db.prepare(`DELETE FROM docs_fts WHERE id LIKE ? ESCAPE '\\'`).run(like); // P2 — FTS 동기
  const r = db.prepare(`DELETE FROM docs WHERE id LIKE ? ESCAPE '\\'`).run(like);
  return Number(r.changes ?? 0);
}

/** ★ self-awareness(P3) — 문서 디렉터리(docs/)의 구현/설계 md 를 벡터 회상 코퍼스로
 *  자동 인제스트. DocOps P0(2026-07-13)부터 **mtime 증분**: 무변경 파일은 stat 만으로
 *  통과(read/chunk/embed 0), 수정 파일은 구청크 삭제 후 재인제스트(living doc 갱신 반영).
 *  상태 없는 기존 파일(마이그레이션)은 마지막 청크 ts 와 mtime 비교 — 그 후 수정된
 *  경우만 재인제스트(무변경이면 재임베딩 없이 상태만 기록·대량 재처리 회피). */
export async function ingestDocsDir(
  db: Database,
  opts: { dir: string; domain?: string; embed?: EmbedFn; pattern?: RegExp },
): Promise<{ files: number; chunks: number; skipped: number; unchanged: number; refreshed: number }> {
  if (!existsSync(opts.dir)) return { files: 0, chunks: 0, skipped: 0, unchanged: 0, refreshed: 0 };
  ensureDocsIngestState(db);
  // 명시 pattern 호출은 기존의 단일 디렉터리·파일명 정규식 계약을 유지한다. 기본 호출만
  // DocOps 정본 두 자산(scanDocs 재귀/아카이브 제외 + KNOWN_PREFIXES taxonomy)으로 선정한다.
  const files = opts.pattern
    ? readdirSync(opts.dir).filter(name => opts.pattern!.test(name)).map(name => join(opts.dir, name)).sort()
    : scanDocs(opts.dir)
      .filter(entry => KNOWN_PREFIXES.has(entry.prefix))
      .map(entry => resolve(dirname(opts.dir), entry.path))
      .sort();
  debug.log('knowledge.ingest', 'docs-targets', {
    dir: opts.dir,
    selection: opts.pattern ? 'explicit-pattern' : 'doc-lint-taxonomy',
    candidates: files.length,
  });
  const stateStmt = db.prepare('SELECT mtime_ms FROM docs_ingest_state WHERE file = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO docs_ingest_state (file, mtime_ms, chunk_count, ingested_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET mtime_ms=excluded.mtime_ms, chunk_count=excluded.chunk_count, ingested_at=excluded.ingested_at`,
  );
  let fileCount = 0, chunks = 0, skipped = 0, unchanged = 0, refreshed = 0;
  for (const file of files) {
    const full = docPathKey(file);
    let mtimeMs: number;
    try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
    const state = stateStmt.get(full) as { mtime_ms: number } | null;
    if (state && state.mtime_ms === mtimeMs) { unchanged++; continue; } // 무변경 — stat 만
    if (!state) {
      // 마이그레이션 — 이미 인제스트된 파일인데 상태만 없음: 마지막 인제스트 이후
      // 수정 안 됐으면 재임베딩 없이 상태만 채운다(초회 대량 재처리 회피).
      const prev = db.prepare(`SELECT MAX(ts) AS ts, COUNT(*) AS n FROM docs WHERE id LIKE ? ESCAPE '\\'`)
        .get(`docs:${escapeLike(full)}#%`) as { ts: string | null; n: number };
      if (prev.n > 0 && prev.ts && mtimeMs <= Date.parse(prev.ts)) {
        upsertStmt.run(full, mtimeMs, prev.n, new Date().toISOString());
        unchanged++;
        continue;
      }
    }
    // 재인제스트 전 구청크 교체 — ingestDocFile 은 기존 id 를 skip 하므로 필수.
    const deleted = deleteDocChunks(db, full);
    const wasStale = state !== null || deleted > 0;
    const r = await ingestDocFile(db, {
      path: full, domain: opts.domain ?? 'elanous',
      ...(opts.embed ? { embed: opts.embed } : {}),
    });
    // 임베딩 전체 실패 시 상태를 기록하지 않는다 — 다음 주기 재시도(fail-soft 유지).
    if (r.chunks > 0 || r.skipped === 0) {
      upsertStmt.run(full, mtimeMs, r.chunks, new Date().toISOString());
      if (r.chunks > 0) { fileCount++; if (wasStale) refreshed++; }
    }
    chunks += r.chunks; skipped += r.skipped;
  }
  return { files: fileCount, chunks, skipped, unchanged, refreshed };
}

export interface IngestCounts { signals: number; digs: number; alpha: number; outbound: number; skipped: number }

export interface IngestOptions {
  embed?: EmbedFn;
  signalsDbPath?: string;
  alphaReportsDir?: string;
  /** 발송 원장 경로 (Block 2 — 기본 surfaceEventsDbPath()). */
  surfaceEventsDbPath?: string;
  /** 신호 영속 스코어 하한 (기본 6 — digestFloor와 동일 철학). */
  signalFloor?: number;
}

/** 3소스 멱등 인제스트. 임베딩 실패 문서는 skip(다음 크론 재시도). */
export async function ingestKnowledge(db: Database, opts: IngestOptions = {}): Promise<IngestCounts> {
  const embed = opts.embed ?? defaultEmbed;
  const floor = opts.signalFloor ?? 6;
  const seen = existingIds(db);
  const counts: IngestCounts = { signals: 0, digs: 0, alpha: 0, outbound: 0, skipped: 0 };
  const tryInsert = async (doc: Omit<KnowledgeDoc, 'embed_model'>, bump: keyof IngestCounts) => {
    if (seen.has(doc.id)) return;
    try {
      await insertDoc(db, doc, embed);
      counts[bump] = (counts[bump] as number) + 1;
    } catch { counts.skipped++; } // 임베딩/삽입 실패 — 멱등이라 다음 주기 재시도
  };

  // ① breaking_signals (유의 6+ · 90일 휘발 전 영속) + ② dig_reports (같은 DB)
  const sigPath = opts.signalsDbPath ?? SIGNALS_DB_PATH;
  if (existsSync(sigPath)) {
    const sdb = new Database(sigPath, { readonly: true });
    try {
      const sigs = sdb.prepare(`
        SELECT id, ts, source, author, text, url, sector, reason
        FROM signals
        WHERE MAX(COALESCE(urgency,0), COALESCE(market,0), COALESCE(impact,0)) >= ?
      `).all(floor) as any[];
      for (const s of sigs) {
        await tryInsert({
          id: `signal:${s.id}`, ts: s.ts, kind: 'signal', sector_tags: s.sector ?? null,
          text: `[${s.author ?? s.source ?? '?'}] ${s.text ?? ''}${s.reason ? `\n판정: ${s.reason}` : ''}`,
          source_ref: s.url ?? null,
        }, 'signals');
      }
      const hasDigs = (sdb.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='dig_reports'`).get() as any)?.n > 0;
      if (hasDigs) {
        const digs = sdb.prepare(`SELECT id, ts, topic, sector, verdict, confidence FROM dig_reports`).all() as any[];
        for (const d of digs) {
          await tryInsert({
            id: `dig:${d.id}`, ts: d.ts, kind: 'dig', sector_tags: d.sector ?? null,
            text: `[디깅·확신도 ${d.confidence ?? '?'}] ${d.topic ?? ''}\n${d.verdict ?? ''}`,
            source_ref: `dig_reports#${d.id}`,
          }, 'digs');
        }
      }
    } finally { sdb.close(); }
  }

  // ③ alpha_reports/*.md (주간 알파 — 섹션 청킹)
  const alphaDir = opts.alphaReportsDir ?? ALPHA_REPORTS_DIR;
  if (existsSync(alphaDir)) {
    for (const f of readdirSync(alphaDir).filter(f => f.endsWith('.md')).sort()) {
      const md = readFileSync(join(alphaDir, f), 'utf-8');
      const ts = `${f.slice(0, 10)}T00:00:00.000Z`; // 파일명 YYYY-MM-DD- 관례
      const chunks = chunkReport(md);
      for (let i = 0; i < chunks.length; i++) {
        await tryInsert({
          id: `alpha:${f}#${i}`, ts, kind: 'alpha', sector_tags: null,
          text: chunks[i]!, source_ref: join(alphaDir, f),
        }, 'alpha');
      }
    }
  }

  // ④ surface_events (Block 2 — 발송 원장 → 의미 회상 편입). 유의 발송만
  //    (importance>=floor: alert/watch-zone/breaking=7 통과, digest/qna 제외).
  //    outbound만(수신 QnA 제외). breaking 속보는 kind='signal'과 near-dup 될 수
  //    있으나 발송 framing 보존이 "내가 보낸 것" 회상엔 유의미 — 허용.
  const sePath = opts.surfaceEventsDbPath ?? surfaceEventsDbPath();
  if (existsSync(sePath)) {
    const edb = new Database(sePath, { readonly: true });
    try {
      // domain 컬럼은 GEN 마이그레이션 후 존재 — 없는 구 DB 대비 존재 확인.
      const seCols = (edb.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>).map(c => c.name);
      const domSel = seCols.includes('domain') ? 'domain' : `'finance' AS domain`;
      const evs = edb.prepare(`
        SELECT id, ts, surface, kind, text, summary, tags, ${domSel}
        FROM events
        WHERE direction = 'outbound' AND COALESCE(importance, 0) >= ?
      `).all(floor) as any[];
      for (const e of evs) {
        const body = (e.summary && String(e.summary).trim()) ? e.summary : e.text;
        await tryInsert({
          id: `outbound:${e.id}`, ts: e.ts, kind: 'outbound', sector_tags: e.tags ?? null,
          text: `[발송·${e.kind ?? e.surface ?? '?'}] ${body ?? ''}`,
          source_ref: `surface_events#${e.surface ?? '?'}/${e.kind ?? '?'}`,
          domain: e.domain && e.domain !== 'general' ? e.domain : 'finance', // GEN — 발송 도메인 상속(surface_events → knowledge), 미지정 중립값은 finance fallback
        }, 'outbound');
      }
    } finally { edb.close(); }
  }
  return counts;
}

// ── Conatus 소급 인제스트 (R3 후속 · 2026-07-07 · 1회 backfill) ──
//
// openclaw 시절 산출물 아카이브를 지식레이어로 영속: x_asset.db의
// raw_artifact가 가리키는 Obsidian md — report_md(X 데일리 리포트 ~92건)
// + morning_combined_md(아침 종합 ~91건). 코퍼스가 신규 신호 축적을
// 기다리지 않고 과거 국면 서사를 즉시 획득. 멱등(id PK) — 재실행 안전.
// screener.db의 screen/investor는 수치 행이라 임베딩 부적합 = 제외
// (구조화 질의는 finance_signals/finance_kr_flow가 이미 커버).

export const X_ASSET_DB_PATH = join(
  homedir(), '.claude/skills/apify-x-asset-sentiment/data/x_asset.db');

export interface BackfillCounts { xreport: number; morning: number; skipped: number; missingFiles: number }

export interface BackfillOptions {
  xAssetDbPath?: string;
  embed?: EmbedFn;
  /** 파일당 최대 청크 (초대형 md 폭주 방지 · 기본 12 — 앞부분=요약/헤드라인 우선). */
  maxChunksPerFile?: number;
}

export async function backfillConatusReports(db: Database, opts: BackfillOptions = {}): Promise<BackfillCounts> {
  const embed = opts.embed ?? defaultEmbed;
  const maxChunks = opts.maxChunksPerFile ?? 12;
  const counts: BackfillCounts = { xreport: 0, morning: 0, skipped: 0, missingFiles: 0 };
  const xPath = opts.xAssetDbPath ?? X_ASSET_DB_PATH;
  if (!existsSync(xPath)) return counts;

  const seen = existingIds(db);
  const xdb = new Database(xPath, { readonly: true });
  try {
    const rows = xdb.prepare(`
      SELECT date, kind, path FROM raw_artifact
      WHERE kind IN ('report_md','morning_combined_md') ORDER BY date ASC
    `).all() as Array<{ date: string; kind: string; path: string }>;
    for (const r of rows) {
      const kind: KnowledgeDoc['kind'] = r.kind === 'report_md' ? 'xreport' : 'morning';
      if (!existsSync(r.path)) { counts.missingFiles++; continue; }
      let md = '';
      try { md = readFileSync(r.path, 'utf-8'); } catch { counts.missingFiles++; continue; }
      const chunks = chunkReport(md).slice(0, maxChunks);
      for (let i = 0; i < chunks.length; i++) {
        const id = `${kind}:${r.date}#${i}`;
        if (seen.has(id)) continue;
        try {
          await insertDoc(db, {
            id, ts: `${r.date}T00:00:00.000Z`, kind, sector_tags: null,
            text: chunks[i]!, source_ref: r.path,
          }, embed);
          counts[kind]++;
        } catch { counts.skipped++; } // 임베딩 실패 — 멱등이라 재실행으로 회복
      }
    }
  } finally { xdb.close(); }
  return counts;
}

// ── query (JS cosine 전수 스캔 — 스파이크 실측 수천 건 ~ms) ──

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export interface QueryOptions {
  k?: number;
  kind?: string;
  sector?: string;
  domain?: string; // GEN
  embed?: EmbedFn;
}

/** 유사국면 질의 — 질의 임베딩과 같은 embed_model 공간의 문서만 대상. */
export async function queryKnowledge(db: Database, query: string, opts: QueryOptions = {}): Promise<KnowledgeMatch[]> {
  const embed = opts.embed ?? defaultEmbed;
  const k = Math.min(Math.max(opts.k ?? 5, 1), 20);
  const { vector: qv, model } = await embed(query);

  const conds: string[] = ['embed_model = ?'];
  const params: unknown[] = [model];
  if (opts.kind) { conds.push('kind = ?'); params.push(opts.kind); }
  if (opts.sector) { conds.push("COALESCE(sector_tags,'') LIKE ?"); params.push(`%${opts.sector}%`); }
  if (opts.domain) { conds.push("COALESCE(domain,'finance') = ?"); params.push(opts.domain); }

  const rows = db.prepare(
    `SELECT id, ts, kind, sector_tags, text, source_ref, embed_model, embedding, domain FROM docs WHERE ${conds.join(' AND ')}`
  ).all(...(params as any[])) as any[];

  const scored: KnowledgeMatch[] = rows.map(r => {
    const buf: Uint8Array = r.embedding;
    // byteOffset이 4의 배수가 아닐 수 있어(드라이버 버퍼 재사용) 복사 후 뷰 생성
    const v = buf.byteOffset % 4 === 0
      ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      : new Float32Array(buf.slice().buffer);
    return {
      id: r.id, ts: r.ts, kind: r.kind, sector_tags: r.sector_tags,
      text: r.text, source_ref: r.source_ref, embed_model: r.embed_model,
      domain: r.domain ?? 'finance',
      similarity: cosine(qv, v),
    };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

/** kind(+domain) 의 전 doc 을 벡터와 함께 로드(BLOB 디코드 재사용). taste 모델(centroid)
 *  처럼 질의가 아니라 **집계**가 필요한 소비자용. embed_model 필터 없음(호출측이 공간 정합 판단). */
export interface DocVector { id: string; ts: string; text: string; source_ref: string | null; sector_tags: string | null; embed_model: string; vector: Float32Array }
export function loadKindVectors(db: Database, kind: KnowledgeDoc['kind'], domain?: string): DocVector[] {
  const conds = ['kind = ?'];
  const params: unknown[] = [kind];
  if (domain) { conds.push("COALESCE(domain,'finance') = ?"); params.push(domain); }
  const rows = db.prepare(
    `SELECT id, ts, text, source_ref, sector_tags, embed_model, embedding FROM docs WHERE ${conds.join(' AND ')} ORDER BY ts`
  ).all(...(params as any[])) as any[];
  return rows.map(r => {
    const buf: Uint8Array = r.embedding;
    const vector = buf.byteOffset % 4 === 0
      ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      : new Float32Array(buf.slice().buffer);
    return { id: r.id, ts: r.ts, text: r.text, source_ref: r.source_ref, sector_tags: r.sector_tags, embed_model: r.embed_model, vector };
  });
}

// ── 하이브리드 검색 (DocOps P2 · 2026-07-13) ──────────────────────────
//
// 벡터(cosine·의미) + BM25(키워드·고유명사/코드심볼) 를 RRF(Reciprocal
// Rank Fusion·k=60)로 융합 — 가중치 튜닝 없이 두 랭킹의 강점을 합친다.
// 한국어 질의는 surface-events ftsQuery 선례(토큰 prefix `"삼성"*`) 재사용.

export interface HybridMatch extends KnowledgeMatch {
  /** 어느 랭킹에 잡혔나 — 디버그/신뢰 표시용. */
  matchedBy: 'vector' | 'keyword' | 'both';
  rrf: number;
}

const RRF_K = 60;

export async function hybridQueryKnowledge(
  db: Database,
  query: string,
  opts: QueryOptions = {},
): Promise<HybridMatch[]> {
  const k = Math.min(Math.max(opts.k ?? 5, 1), 20);
  const pool = Math.max(k * 4, 20);

  // ① 벡터 랭킹 (임베딩 불가 시 fail-soft — 키워드 단독으로 강등)
  let vector: KnowledgeMatch[] = [];
  try { vector = await queryKnowledge(db, query, { ...opts, k: pool }); }
  catch { /* embed 다운 — BM25 만으로 동작 */ }

  // ② BM25 랭킹 — fts MATCH 후 docs 조인(필터는 docs 측 컬럼으로)
  const { ftsQuery } = await import('./surface-events.js');
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) { conds.push('d.kind = ?'); params.push(opts.kind); }
  if (opts.sector) { conds.push("COALESCE(d.sector_tags,'') LIKE ?"); params.push(`%${opts.sector}%`); }
  if (opts.domain) { conds.push("COALESCE(d.domain,'finance') = ?"); params.push(opts.domain); }
  let keyword: Array<{ id: string }> = [];
  try {
    keyword = db.prepare(
      `SELECT d.id FROM docs_fts f JOIN docs d ON d.id = f.id
       WHERE docs_fts MATCH ? ${conds.length ? `AND ${conds.join(' AND ')}` : ''}
       ORDER BY bm25(docs_fts) LIMIT ?`,
    ).all(ftsQuery(query), ...(params as never[]), pool) as Array<{ id: string }>;
  } catch { /* MATCH 파싱 실패 등 — 벡터 단독 */ }

  // ③ RRF 융합
  const rrf = new Map<string, { score: number; by: Set<'vector' | 'keyword'> }>();
  const bump = (id: string, rank: number, by: 'vector' | 'keyword') => {
    const cur = rrf.get(id) ?? { score: 0, by: new Set<'vector' | 'keyword'>() };
    cur.score += 1 / (RRF_K + rank + 1);
    cur.by.add(by);
    rrf.set(id, cur);
  };
  vector.forEach((m, i) => bump(m.id, i, 'vector'));
  keyword.forEach((m, i) => bump(m.id, i, 'keyword'));

  const byId = new Map(vector.map((m) => [m.id, m]));
  const top = [...rrf.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k);
  const out: HybridMatch[] = [];
  for (const [id, { score, by }] of top) {
    let base = byId.get(id);
    if (!base) {
      // 키워드 단독 매치 — 본문 로드(유사도는 0 표기)
      const r = db.prepare(`SELECT id, ts, kind, sector_tags, text, source_ref, embed_model, domain FROM docs WHERE id = ?`).get(id) as
        | (Omit<KnowledgeMatch, 'similarity'> & { domain: string | null }) | null;
      if (!r) continue;
      base = { ...r, domain: r.domain ?? 'finance', similarity: 0 } as KnowledgeMatch;
    }
    out.push({ ...base, rrf: score, matchedBy: by.size === 2 ? 'both' : (by.has('vector') ? 'vector' : 'keyword') });
  }
  return out;
}

/** 매치 렌더 — 도구/디깅 컨텍스트 공용. */
export function renderKnowledgeMatches(matches: KnowledgeMatch[]): string {
  if (matches.length === 0) return '(유사국면 없음)';
  return matches.map(m => {
    const date = m.ts.slice(0, 10);
    const tag = m.sector_tags ? `·${m.sector_tags}` : '';
    return `- [${date}·${m.kind}${tag}·유사도 ${m.similarity.toFixed(2)}] ${m.text.replace(/\n+/g, ' / ').slice(0, 220)}`;
  }).join('\n');
}

/** DB 통계 — 도구 헤더/헬스용. */
export function knowledgeStats(db: Database): { total: number; byKind: Array<{ kind: string; n: number }> } {
  const total = (db.prepare(`SELECT COUNT(*) n FROM docs`).get() as any)?.n ?? 0;
  const byKind = db.prepare(`SELECT kind, COUNT(*) n FROM docs GROUP BY kind ORDER BY n DESC`).all() as Array<{ kind: string; n: number }>;
  return { total, byKind };
}
