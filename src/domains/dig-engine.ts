import { textOnly } from '../llm/stream-text.js';
// ── R2 · 적응 해상도 디깅 엔진 v1 (2026-07-06 · ROADMAP-organic-signal-engine) ──
//
// "필요한 순간에 해상도를 알아서 올려서" — 고영향 신호(breaking_signals의
// impact/market ≥ 8, finance_opportunity high)를 트리거로 자동 심층분석.
// v1 = 크론 폴링 러너(결정론·D3 확정) · v2 = Layer2 자율 goal 편입(R5·arming 대표결정).
//
// 파이프라인: 트리거 스캔 → 큐 적재 → (비용가드) → 레시피 실행(신호 유형별
// 컨텍스트 수집: finance 도구 + omni-crawl tavily) → LLM 구조화 종합
// (국면판단·영향경로·매매함의·확신도) → dig_reports 적재 + 알림.
// 거버넌스: 분석만(READ-ONLY) · 시간당 2회 · 동일 섹터 6h 쿨다운 · 매매는 verify+HITL.

import { Database } from 'bun:sqlite';
import { isTavilySearchEnabled } from '../user-config.js';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openSignalsDb } from './breaking-signals.js';
import { buildFinanceTools } from './finance-tools.js';
import { knowledgeDbPath, openKnowledgeDb, queryKnowledge, renderKnowledgeMatches } from './knowledge.js';
import { openKgDb, getNode as kgGetNode } from './kg-store.js';
import { recallHybrid, type HybridRecall } from './kg-recall.js';
import { US_PULSE_DB, openPulseDb, detectNotables, loadUniverse } from './us-pulse.js';
import { existsSync } from 'node:fs';
import { getUserConfig } from '../user-config.js';
import { getProviderForConfig, anyProviderAvailable, type LLMMessage } from '../llm.js';
import { conatusPath } from './conatus-data-dir.js';
import { hoursAgo, within } from '../time/db-window.js';

const OMNI_CRAWL = join(homedir(), '.claude/skills/omni-crawl/scripts/main.ts');
const OMNI_CWD = join(homedir(), '.claude/skills/omni-crawl');

export interface DigItem {
  id: string;            // signal:<id> | opp:<kind>:<subject>
  topic: string;         // 디깅 주제 (신호 원문/기회 headline)
  sector: string;        // 주영향 섹터 태그
  score: number;         // 트리거 점수 (impact/market max)
}

export function ensureDigTables(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS dig_queue(
    id TEXT PRIMARY KEY, topic TEXT, sector TEXT, score INT,
    created_at TEXT, status TEXT DEFAULT 'queued',
    parent_id TEXT, depth INT DEFAULT 0
  )`);
  // 기존 DB 마이그레이션(M2.2 재귀 디깅 — 이미 있으면 무시)
  for (const col of ['parent_id TEXT', 'depth INT DEFAULT 0']) {
    try { db.run(`ALTER TABLE dig_queue ADD COLUMN ${col}`); } catch { /* 컬럼 이미 존재 */ }
  }
  db.run(`CREATE TABLE IF NOT EXISTS dig_reports(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
    queue_id TEXT, topic TEXT, sector TEXT, verdict TEXT, confidence TEXT
  )`);
}

/** 트리거 스캔 → 큐 적재. 신규 적재 건수 반환. */
export async function enqueueTriggers(db: Database, opts: StockTriggerOpts = {}): Promise<number> {
  let added = 0;
  // ① breaking_signals 고영향 (24h 내·미적재)
  const hot = db.prepare(`
    SELECT id, text, sector, MAX(COALESCE(impact,0), COALESCE(market,0)) AS score
    FROM signals
    WHERE ${within('ts')}
      AND (COALESCE(impact,0) >= 8 OR COALESCE(market,0) >= 8)
      AND ('signal:' || id) NOT IN (SELECT id FROM dig_queue)
  `).all(hoursAgo(24)) as any[];
  const ins = db.prepare(`INSERT OR IGNORE INTO dig_queue(id, topic, sector, score, created_at) VALUES (?,?,?,?,?)`);
  for (const s of hot) {
    ins.run(`signal:${s.id}`, String(s.text).slice(0, 300), s.sector ?? 'other', s.score, new Date().toISOString());
    added++;
  }
  // ② finance_opportunity high severity (P5a 보드 — suggestedFocus 재사용)
  try {
    const { dispatch } = buildFinanceTools();
    const r: any = await dispatch('finance_opportunity', {});
    for (const o of r?.opportunities ?? []) {
      if (!o.warrants_analysis) continue;
      const id = `opp:${o.kind}:${String(o.subject).slice(0, 40)}:${new Date().toISOString().slice(0, 10)}`;
      const res = ins.run(id, String(o.suggested_focus ?? o.headline).slice(0, 300), String(o.subject ?? 'other'), 8, new Date().toISOString());
      if (res.changes > 0) added++;
    }
  } catch { /* fail-soft */ }
  // ③④ 눈에 띄는 종목 → 종목 디깅 (US 펄스 + KR 스크리너 — 대표 지시 2026-07-06:
  // "연속 상승·눈에 띄는 종목은 별도로 뉴스를 찾아 알아서 디깅 — 해상도 자동 증가")
  added += enqueueStockTriggers(db, opts);
  return added;
}

export interface StockTriggerOpts { usPulseDbPath?: string; screenerDbPath?: string }
const SCREENER_DB = conatusPath('screener.db');

/** 기존 크론 산출물(us_pulse.db·screener.db) 위에 얹는 종목 트리거 — 재스캔이라 공짜.
 *  id `pulse:US:SYM:date` / `pulse:KR:종목:date` — 날짜 스코프 dedup(하루 1회).
 *  sector=티커 → 기존 6h 쿨다운이 종목 단위로 작동. */
export function enqueueStockTriggers(db: Database, opts: StockTriggerOpts = {}): number {
  let added = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO dig_queue(id, topic, sector, score, created_at) VALUES (?,?,?,?,?)`);
  // ③ US 펄스 강신호 — 스트릭 ≥5 또는 주간 ±12% (결산 기준보다 한 단계 높게 = 디깅 가치)
  try {
    const pPath = opts.usPulseDbPath ?? US_PULSE_DB;
    if (existsSync(pPath)) {
      const pdb = openPulseDb(pPath);
      try {
        const latest = (pdb.prepare(`SELECT MAX(date) d FROM bars`).get() as any)?.d;
        if (latest) {
          const u = loadUniverse();
          const strong = detectNotables(pdb, u.stocks, u.criteria)
            .filter(n => Math.abs(n.streak) >= 5 || Math.abs(n.weekPct ?? 0) >= 12)
            .slice(0, 2);
          for (const n of strong) {
            const why = [
              Math.abs(n.streak) >= 4 ? `${Math.abs(n.streak)}일 연속 ${n.streak > 0 ? '상승' : '하락'}` : '',
              n.weekPct != null ? `주간 ${n.weekPct > 0 ? '+' : ''}${n.weekPct.toFixed(1)}%` : '',
              `일간 ${n.dayPct > 0 ? '+' : ''}${n.dayPct.toFixed(1)}%`,
              n.high20 && n.dayPct > 0 ? '20일 신고가' : '',
            ].filter(Boolean).join(' · ');
            const res = ins.run(`pulse:US:${n.symbol}:${latest}`,
              `미국 ${n.symbol} — ${why}. 원인 뉴스/현상 태깅`, n.symbol,
              Math.min(9, 6 + Math.floor(Math.abs(n.streak) / 2)), new Date().toISOString());
            if (res.changes > 0) added++;
          }
        }
      } finally { pdb.close(); }
    }
  } catch { /* fail-soft */ }
  // ④ KR 스크리너/수급 — 기존 크론이 적재하는 screener.db 재사용 (screen: 당일
  // 🟢양호 급등 · investor: 외국인/기관 순매수 상위 + 가격 동반 — 신선분만)
  try {
    const sPath = opts.screenerDbPath ?? SCREENER_DB;
    if (existsSync(sPath)) {
      const sdb = new Database(sPath, { readonly: true });
      try {
        const today = new Date().toISOString().slice(0, 10);
        const screens = sdb.prepare(`
          SELECT date, code, name, chg_pct FROM screen
          WHERE date = (SELECT MAX(date) FROM screen) AND date >= date(?, '-3 days')
            AND flag LIKE '%양호%' AND chg_pct >= 15
          ORDER BY chg_pct DESC LIMIT 2
        `).all(today) as any[];
        for (const s of screens) {
          const res = ins.run(`pulse:KR:${s.code}:${s.date}`,
            `한국 ${s.name}(${s.code}) — 스크리너 급등 ${s.chg_pct.toFixed(1)}% (당일 양호 플래그). 원인 뉴스/현상 태깅`,
            String(s.name).slice(0, 20), 7, new Date().toISOString());
          if (res.changes > 0) added++;
        }
        const flows = sdb.prepare(`
          SELECT date, type, name, chg_pct, net_qty FROM investor
          WHERE date = (SELECT MAX(date) FROM investor) AND date >= date(?, '-3 days')
            AND rank <= 2 AND ABS(chg_pct) >= 5
          ORDER BY ABS(chg_pct) DESC LIMIT 2
        `).all(today) as any[];
        for (const f of flows) {
          const res = ins.run(`pulse:KR:flow:${f.name}:${f.date}`,
            `한국 ${f.name} — ${f.type} 순매수 상위 + 가격 ${f.chg_pct > 0 ? '+' : ''}${Number(f.chg_pct).toFixed(1)}% 동반. 수급 주도 원인 태깅`,
            String(f.name).slice(0, 20), 7, new Date().toISOString());
          if (res.changes > 0) added++;
        }
      } finally { sdb.close(); }
    }
  } catch { /* fail-soft */ }
  return added;
}

/** 비용가드: 시간당 최대 2회 · 동일 섹터 6h 쿨다운. 실행 가능한 다음 아이템 반환. */
export function nextDiggable(db: Database): DigItem | null {
  const lastHour = (db.prepare(`SELECT COUNT(*) AS n FROM dig_reports WHERE ${within('ts')}`).get(hoursAgo(1)) as any)?.n ?? 0;
  if (lastHour >= 2) return null;
  const rows = db.prepare(`SELECT * FROM dig_queue WHERE status='queued' ORDER BY score DESC, created_at ASC LIMIT 10`).all() as any[];
  for (const r of rows) {
    const cooled = (db.prepare(`SELECT COUNT(*) AS n FROM dig_reports WHERE sector = ? AND ${within('ts')}`).get(r.sector, hoursAgo(6)) as any)?.n ?? 0;
    if (cooled > 0) {
      db.prepare(`UPDATE dig_queue SET status='skipped' WHERE id=?`).run(r.id); // 쿨다운 — 같은 섹터 최근 디깅됨
      continue;
    }
    return { id: r.id, topic: r.topic, sector: r.sector, score: r.score };
  }
  return null;
}

// ── 레시피: 신호 유형별 컨텍스트 수집 ──

/** M2.4 · hybrid 회상을 dig 컨텍스트 텍스트로. 진입 엔티티·클러스터·인과 파장 요약(순수). */
export function renderHybridForDig(db: Database, r: HybridRecall): string {
  if (!r.seeds.length && !r.causal.length) return '';
  const nm = (id: string): string => kgGetNode(db, id)?.name ?? id;
  const lines: string[] = [];
  if (r.seeds.length) lines.push(`진입 엔티티: ${r.seeds.map(nm).slice(0, 8).join(', ')}`);
  for (const c of r.clusters.slice(0, 3)) lines.push(`클러스터 ${c.name}: 종목 ${c.members.length}·서브 ${c.subclusters.length}`);
  if (r.causal.length) {
    const top = r.causal.slice(0, 8).map(h => `${h.weight > 0 ? '▲' : '▼'}${nm(h.node)}(${h.weight.toFixed(2)}${h.lag ? `·${h.lag}일` : ''})`);
    lines.push(`영향 파장: ${top.join(', ')}`);
  }
  return lines.join('\n');
}

// M2.1 · 신호유형별 검색 전략(순수). 고영향 신호는 다각도 딥리서치, 종목은
// 뉴스+원인 풀본문(firecrawl 병행), 그 외는 무료 ddg.
// ⛔⭐ 2026-08-06 (대표) — **웹 검색 엔진을 config 로 뺐다.** 이 경로는 «크론 디깅 러너»라
//   상시 유료 검색이 그대로 고정비가 됐다. 엔진 이름은 omni-crawl 로 그대로 전달되므로
//   ***여기 적힌 문자열이 곧 과금***이다. ⇒ `pickSearchPlan` 은 **순수 함수로 유지**하고
//   엔진 이름을 «인자»로 받는다(호출부가 config 를 해석). 기본은 무료 ddg.
// 비용가드: deep은 firecrawl 크레딧이 크므로 고score(>=9) 신호만 · 상위 가드는
// dig 시간당 2회 제한(nextDiggable). --mode deep은 --engine 없어야 오케스트레이션.
export interface SearchPlan { engine?: string; mode?: 'deep'; depth?: string; label: string }

export function pickSearchPlan(item: DigItem, webEngine: string = 'ddg'): SearchPlan {
  const isStock = item.id.startsWith('pulse:');
  // 고영향 breaking(score>=9) — 다각도 ddg + firecrawl 풀스크랩 + 커뮤니티 합성
  if (!isStock && item.score >= 9) return { mode: 'deep', label: 'deep(다각도+풀스크랩+커뮤니티)' };
  // 종목 디깅 — 뉴스(ddg 무료) + 원인 풀본문(firecrawl) 병행
  if (isStock) return { engine: `${webEngine},firecrawl`, depth: 'advanced', label: `${webEngine}+firecrawl` };
  // 기본 — 무료
  return { engine: webEngine, depth: 'advanced', label: webEngine };
}

function omniSearch(query: string, plan: SearchPlan = { engine: 'ddg', depth: 'advanced', label: 'ddg' }): string {
  try {
    const cliArgs = ['tsx', OMNI_CRAWL, query];
    if (plan.mode) cliArgs.push('--mode', plan.mode);      // deep은 engine 미지정(오케스트레이션)
    else if (plan.engine) cliArgs.push('--engine', plan.engine);
    cliArgs.push('--depth', plan.depth ?? 'advanced', '--limit', '5', '--json');
    const r = spawnSync('npx', cliArgs,
      { encoding: 'utf-8', cwd: OMNI_CWD, env: process.env, timeout: plan.mode === 'deep' ? 150_000 : 90_000 });
    const m = (r.stdout || '').match(/---BEGIN_OMNI_CRAWL_JSON---\n([\s\S]*?)\n---END_OMNI_CRAWL_JSON---/);
    if (!m) return '(웹 검색 실패)';
    const p = JSON.parse(m[1]);
    const parts: string[] = [];
    for (const res of p.results ?? []) for (const it of res.items ?? []) {
      parts.push(`- ${it.title ?? ''}: ${String(it.text ?? '').slice(0, 350)} (${it.url ?? ''})`);
    }
    return parts.slice(0, 8).join('\n') || '(결과 없음)';
  } catch (e) {
    return `(웹 검색 실패: ${e instanceof Error ? e.message.slice(0, 60) : String(e)})`;
  }
}

async function gatherContext(item: DigItem): Promise<string> {
  const { dispatch } = buildFinanceTools();
  // 종목 트리거(pulse: — US 펄스/KR 스크리너·수급)는 종목 레시피: 원인 뉴스 검색을
  // 종목명 중심 쿼리로 (해상도 자동 증가 — 대표 지시 2026-07-06).
  const isStock = item.id.startsWith('pulse:');
  const searchQ = isStock
    ? (item.id.startsWith('pulse:US:')
      ? `${item.sector} stock why ${/하락/.test(item.topic) ? 'falling' : 'rising'} news`
      : `${item.sector} 주가 ${/하락/.test(item.topic) ? '급락' : '급등'} 이유 뉴스`)
    : item.topic.slice(0, 120);
  // ⭐ config 해석은 **호출부에서** 한다 — `pickSearchPlan` 은 순수하게 남긴다(테스트 가능).
  //   기본 OFF 이므로 무료 ddg 가 기본이고, 켜면 종전 tavily 동작으로 정확히 되돌아간다.
  const plan = pickSearchPlan(item, isTavilySearchEnabled() ? 'tavily' : 'ddg');
  const parts: string[] = [`## 웹 심층 검색 (${plan.label})\n${omniSearch(searchQ, plan)}`];
  if (isStock && item.id.startsWith('pulse:US:')) {
    // US 종목: 실시간 시세 스냅샷 (finance_quote — 토스 우선 전세션)
    try {
      const q: any = await dispatch('finance_quote', { symbol: item.sector });
      if (q && !q.error) parts.push(`## 실시간 시세\n${String(q.quote ?? JSON.stringify(q)).split('\n').slice(0, 8).join('\n')}`);
    } catch { /* fail-soft */ }
  }
  const sec = item.sector.toLowerCase();
  const grab = async (label: string, name: string, args: Record<string, unknown>, pick: (r: any) => string) => {
    try {
      const r: any = await dispatch(name, args);
      if (r && !r.error) parts.push(`## ${label}\n${pick(r).split('\n').slice(0, 14).join('\n')}`);
    } catch { /* fail-soft */ }
  };
  // 섹터 신호 → 융합·로테이션 / KR → 수급 / 그 외 → backbone. 항상 캡스톤 국면.
  if (/semis|sw|power|energy|financials|healthcare|consumer|defense/.test(sec)) {
    await grab('섹터 융합 (가격×기관)', 'finance_sector', {}, r => r.table ?? '');
  }
  if (/kr|semis/.test(sec) || /삼성|하이닉스|한국|코스피/i.test(item.topic)) {
    await grab('KR 수급', 'finance_kr_flow', { command: 'market-flow', target: 'KSP' }, r => r.report ?? '');
  }
  if (/crypto|commodity|bonds|fx|other|macro/.test(sec)) {
    await grab('시장 backbone', 'finance_market_backbone', {}, r => (typeof r.backbone === 'string' ? r.backbone : JSON.stringify(r).slice(0, 600)));
  }
  // 캡스톤 국면 — regime 캡처(KG 인과그래프 회상의 국면 매칭에 재사용)
  let regime: string | undefined;
  try {
    const cap: any = await dispatch('finance_capstone', {});
    if (cap && !cap.error) {
      regime = cap.regime;
      parts.push(`## 캡스톤 국면\n국면 ${cap.regime} · ${cap.leverage?.label} · 목표노출 ${cap.leverage?.target_exposure}`);
    }
  } catch { /* fail-soft */ }
  // R3 지식레이어 — 과거 유사국면 주입 (fail-soft: DB/임베더 부재 시 섹션 생략)
  if (existsSync(knowledgeDbPath())) {
    try {
      const kdb = openKnowledgeDb();
      try {
        const matches = await queryKnowledge(kdb, item.topic.slice(0, 300), { k: 4 });
        if (matches.length > 0) parts.push(`## 과거 유사국면 (지식레이어)\n${renderKnowledgeMatches(matches)}`);
      } finally { kdb.close(); }
    } catch { /* fail-soft */ }
  }
  // M2.4 · 온톨로지 인과그래프 회상 — 벡터 회상 위에 그래프 확장(체인·인과 파장).
  // dig 주제의 엔티티를 kg_nodes에 링킹 → 클러스터/blastRadius로 영향경로 사전주입.
  // 국면(regime) 매칭으로 시변 상관 반영. READ-ONLY(bump 안 함) · fail-soft.
  if (existsSync(knowledgeDbPath())) {
    try {
      const gdb = openKgDb();
      try {
        const kg = recallHybrid(gdb, { query: item.topic.slice(0, 300), regime, bump: false });
        const kgText = renderHybridForDig(gdb, kg);
        if (kgText) parts.push(`## 인과그래프 회상 (온톨로지)\n${kgText}`);
      } finally { gdb.close(); }
    } catch { /* fail-soft */ }
  }
  return parts.join('\n\n');
}

const DIG_SYSTEM = `너는 Conatus의 심층분석가다. 아래 트리거 신호와 수집 컨텍스트(웹 검색·섹터 융합·수급·캡스톤 국면·과거 유사국면)를 종합해 구조화 분석을 작성하라. 과거 유사국면이 있으면 당시와의 공통점/차이를 판단에 반영하라.

형식(각 1~3문장·한국어·600자 이내):
**국면판단**: 이 신호가 가리키는 시장/섹터 국면.
**영향경로**: 어떤 자산/종목/국가로 어떻게 전파되는가 (구체 티커 가능한 것만).
**매매함의**: 현 캡스톤 국면 하에서의 함의 — 매매 지시가 아닌 관찰 포인트·조건.
**확신도**: high|med|low + 근거 데이터의 신선도/두께 1문장.
**추가조사**: (선택) 확신도를 높이려면 더 파야 할 파생 질문 0~2개. 각 질문 한 줄 "- " 로. 없으면 이 항목 생략.

규칙: 수집 컨텍스트에 있는 데이터에서만 근거. 지어내지 마라. 매매 지시 금지(verify+HITL).`;

/** 종목 트리거 전용 — "이유/현상 태그"가 목적 (대표 지시 2026-07-06). */
const STOCK_DIG_SYSTEM = `너는 Conatus의 종목 데스크다. 아래 트리거(연속상승/급등락/수급 신호)와 수집 컨텍스트(원인 뉴스 검색·시세·섹터·캡스톤)를 종합해 "왜 움직이는가"를 태깅하라.

형식(한국어·500자 이내):
**원인태그**: [실적|가이던스|계약수주|정책|M&A|애널리스트|섹터동조|수급|테마|불명] 중 1~2개 + 한 줄 근거
**현상**: 무슨 일이 일어나고 있나 (뉴스 근거 1~2문장 · 출처 표기)
**지속성**: 일회성 이벤트인지 구조적 흐름인지 + 과열 여부
**확신도**: high|med|low + 뉴스 근거의 신선도/두께 1문장

규칙: 수집 컨텍스트에 있는 데이터에서만. 뉴스가 빈약하면 원인태그=[불명]으로 정직하게. 매매 지시 금지(verify+HITL).`;

export interface DigResult { verdict: string; confidence: string }

// ── M2.2 · 재귀 디깅: 파생 질문 → dig_queue 재적재 ──
const MAX_DIG_DEPTH = 2;      // 루프가드: 파생의 파생까지만(depth 0→1→2)
const DERIVE_DECAY = 0.7;     // score 감쇠(파생은 부모보다 후순위)

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

/** verdict의 "추가조사" 항목에서 파생 질문 추출(순수). "- " 불릿 라인만. */
export function parseDerivedQuestions(verdict: string): string[] {
  const m = verdict.match(/\*\*추가조사\*\*[:：]?\s*([\s\S]*?)(?:\n\s*\n|$)/);
  if (!m) return [];
  const out: string[] = [];
  for (const line of m[1].split('\n')) {
    const q = line.replace(/^\s*[-•*]\s*/, '').trim();
    if (q.length >= 8 && !/^\(?선택\)?/.test(q) && !/없[음다]/.test(q)) out.push(q.slice(0, 200));
  }
  return out.slice(0, 2);
}

/** 파생 질문을 dig_queue에 재적재. parent 추적·score 감쇠·depth 제한·dedup.
 *  실행은 상위 가드(시간당 2회·6h 섹터 쿨다운)가 제어 — 큐 적재만. 신규 건수 반환. */
export function enqueueDerivedQuestions(db: Database, parent: DigItem, questions: string[], parentDepth = 0): number {
  if (parentDepth >= MAX_DIG_DEPTH) return 0;   // 루프가드: 최대 깊이 도달
  let added = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO dig_queue(id, topic, sector, score, created_at, parent_id, depth) VALUES (?,?,?,?,?,?,?)`);
  const derivedScore = Math.max(1, Math.floor(parent.score * DERIVE_DECAY));
  for (const q of questions.slice(0, 2)) {
    const clean = q.trim().slice(0, 200);
    if (clean.length < 8) continue;
    const id = `derive:${parent.id}:${simpleHash(clean)}`;   // parent+질문 해시로 dedup
    const res = ins.run(id, clean, parent.sector, derivedScore, new Date().toISOString(), parent.id, parentDepth + 1);
    if (res.changes > 0) added++;
  }
  return added;
}

/** 디깅 1건 실행 — 컨텍스트 수집 → LLM 종합 → dig_reports 적재. */
export async function runDig(db: Database, item: DigItem): Promise<DigResult | null> {
  db.prepare(`UPDATE dig_queue SET status='running' WHERE id=?`).run(item.id);
  const context = await gatherContext(item);

  let verdict = '';
  if (anyProviderAvailable()) {
    try {
      const provider = getProviderForConfig(getUserConfig());
      if (provider.streamChat) {
        const messages: LLMMessage[] = [
          { role: 'system', content: item.id.startsWith('pulse:') ? STOCK_DIG_SYSTEM : DIG_SYSTEM },
          { role: 'user', content: `트리거: [${item.sector}·${item.score}] ${item.topic}\n\n${context}`.slice(0, 12_000) },
        ];
        for await (const d of textOnly(provider.streamChat(messages, { temperature: 0.3, maxTokens: 700 }))) verdict += d;
        verdict = verdict.trim();
      }
    } catch { verdict = ''; }
  }
  if (!verdict) {
    db.prepare(`UPDATE dig_queue SET status='queued' WHERE id=?`).run(item.id); // LLM 불가 — 다음 주기 재시도
    return null;
  }
  const confidence = (verdict.match(/확신도[^:：]*[:：]?\s*\**\s*(high|med|low)/i)?.[1] ?? 'med').toLowerCase();
  db.prepare(`INSERT INTO dig_reports(ts, queue_id, topic, sector, verdict, confidence) VALUES (?,?,?,?,?,?)`)
    .run(new Date().toISOString(), item.id, item.topic, item.sector, verdict, confidence);
  db.prepare(`UPDATE dig_queue SET status='done' WHERE id=?`).run(item.id);
  // M2.2 · 재귀 디깅 — 분석이 파생 질문을 낳으면 재적재(depth 가드·score 감쇠).
  // pulse(종목)는 원인태깅이라 제외 · 실행은 상위 가드가 rate-limit.
  if (!item.id.startsWith('pulse:')) {
    const derived = parseDerivedQuestions(verdict);
    if (derived.length) {
      const parentDepth = Number((db.prepare(`SELECT depth FROM dig_queue WHERE id=?`).get(item.id) as any)?.depth ?? 0);
      const n = enqueueDerivedQuestions(db, item, derived, parentDepth);
      if (n > 0) console.log(`  재귀 디깅: 파생 질문 ${n}건 적재(depth ${parentDepth + 1})`);
    }
  }
  return { verdict, confidence };
}

/** 러너 엔트리 — 큐 적재 + 1건 실행. 결과 메시지(발송용) 또는 null. */
export async function digOnce(): Promise<string | null> {
  const db = openSignalsDb();
  ensureDigTables(db);
  const added = await enqueueTriggers(db);
  const item = nextDiggable(db);
  if (!item) {
    db.close();
    console.log(`디깅 대상 없음 (신규 큐 ${added}건 · 가드/쿨다운 적용)`);
    return null;
  }
  console.log(`디깅 시작: [${item.sector}·${item.score}] ${item.topic.slice(0, 80)}`);
  const res = await runDig(db, item);
  db.close();
  if (!res) return null;
  const head = item.id.startsWith('pulse:')
    ? `🔎 종목 디깅 [${item.sector} · 확신도 ${res.confidence}]`
    : `⚙️ 심층 디깅 리포트 [${item.sector} · 트리거 ${item.score} · 확신도 ${res.confidence}]`;
  return [
    head,
    `주제: ${item.topic.slice(0, 140)}`,
    '',
    res.verdict,
    '',
    '(적응 해상도 v1 · 분석만 — 매매는 verify+HITL)',
  ].join('\n');
}
