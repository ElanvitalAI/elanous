// ── SEC EDGAR 13F direct (A2.2, 2026-07-05) — hedge-fund/pension money moves ──
//
// Free, reliable institutional-holdings source (omni-market's 13F endpoint
// is broken — FDS 404). Pipeline (all verified 2026-07-05):
//   fund name → CIK (EDGAR company search) → latest N 13F-HR (submissions
//   API) → INFORMATION TABLE xml → holdings → quarter-over-quarter delta.
// SEC requires a descriptive User-Agent; ~6 sequential GETs per query
// (well under the 10 req/s limit). Values in 13F filings post-2023 are in
// DOLLARS. Read-only; live-fetch (persistence to knowledge_13f.db = A2.2b).

import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { getUserConfig } from '../user-config/reader.js';

/** 13F 기관보유 지식 DB (fact_13f_holdings · dim_security). ★ M0.1(2026-07-07):
 *  R3 벡터 지식(~/.elanous/conatus/knowledge.db·docs 테이블)과 동명 충돌하던
 *  ~/.elanous/knowledge.db 를 knowledge_13f.db 로 분리 — 두 DB는 테이블도 완전 별개.
 *  경로는 state-dir 존중(lazy · Phase B). prod=`~/.elanous/knowledge_13f.db`(무변경). */
export function knowledge13fDbPath(): string {
  return join(elanousStateRoot(), 'knowledge_13f.db');
}

/** SEC 가 요구하는 `User-Agent` — 연락처는 config `finance.secContactEmail` 에서 읽는다(코드에 박지 않는다). */
export function secUserAgent(email = getUserConfig().finance?.secContactEmail): string {
  if (!email) {
    throw new Error('SEC EDGAR 는 연락처 이메일이 있는 요청만 받는다 — `elanous config set finance.secContactEmail <이메일>` 로 설정한다');
  }
  return `monad-agent research (${email})`;
}

async function secGet(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': secUserAgent() } });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url.slice(0, 80)}`);
  return res.text();
}
const secJson = async (url: string): Promise<any> => JSON.parse(await secGet(url));

export interface Fund { cik: string; name: string; }
export interface Holding { issuer: string; cusip: string; value: number; shares: number; }
export interface Filing13F { period: string; filed: string; holdings: Holding[]; }

/** Resolve a fund name (or raw CIK) to {cik,name} via EDGAR company search,
 *  restricted to 13F-HR filers. Throws when nothing matches. */
export async function resolveFundCik(query: string): Promise<Fund> {
  const q = query.trim();
  if (/^\d{1,10}$/.test(q)) return { cik: q.padStart(10, '0'), name: `CIK ${q}` };
  const atom = await secGet(
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(q)}&type=13F-HR&output=atom&count=3`);
  const cik = /<cik>(\d+)<\/cik>/i.exec(atom)?.[1];
  if (!cik) throw new Error(`no 13F-HR filer found for "${q}"`);
  const name = /<conformed-name>([^<]+)<\/conformed-name>/i.exec(atom)?.[1] ?? q;
  return { cik: cik.padStart(10, '0'), name };
}

/** Parse a 13F INFORMATION TABLE xml (namespace-agnostic) into holdings. */
export function parseInfoTable(xml: string): Holding[] {
  const clean = xml.replace(/<(\/?)[A-Za-z0-9]+:/g, '<$1'); // strip ns prefixes
  const out: Holding[] = [];
  for (const b of clean.match(/<infoTable>[\s\S]*?<\/infoTable>/g) ?? []) {
    const issuer = /<nameOfIssuer>([^<]*)<\/nameOfIssuer>/.exec(b)?.[1]?.trim() ?? '';
    const value = Number(/<value>([\d.]+)<\/value>/.exec(b)?.[1] ?? 0);
    const shares = Number(/<sshPrnamt>([\d.]+)<\/sshPrnamt>/.exec(b)?.[1] ?? 0);
    const cusip = /<cusip>([^<]*)<\/cusip>/.exec(b)?.[1]?.trim() ?? '';
    if (issuer) out.push({ issuer, cusip, value, shares });
  }
  return out;
}

/** Fetch the latest `count` 13F-HR filings' holdings for a CIK. */
export async function fetch13F(cik: string, count = 2): Promise<Filing13F[]> {
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = sub.filings?.recent;
  if (!r?.form) return [];
  const picks: { acc: string; date: string; period: string }[] = [];
  for (let i = 0; i < r.form.length && picks.length < count; i++) {
    if (r.form[i] === '13F-HR') {
      picks.push({ acc: String(r.accessionNumber[i]).replace(/-/g, ''), date: r.filingDate[i], period: r.reportDate?.[i] ?? r.filingDate[i] });
    }
  }
  const out: Filing13F[] = [];
  for (const p of picks) {
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${p.acc}`;
    const idx = await secJson(`${base}/index.json`);
    const xmlName: string | undefined = idx.directory?.item?.find(
      (it: any) => typeof it.name === 'string' && it.name.toLowerCase().endsWith('.xml') && it.name !== 'primary_doc.xml',
    )?.name;
    if (!xmlName) continue;
    out.push({ period: p.period, filed: p.date, holdings: parseInfoTable(await secGet(`${base}/${xmlName}`)) });
  }
  return out;
}

const byIssuer = (f: Filing13F): Map<string, number> => {
  const m = new Map<string, number>();
  for (const h of f.holdings) m.set(h.issuer, (m.get(h.issuer) ?? 0) + h.value);
  return m;
};
const usd = (v: number): string => (Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`);

/** Top holdings of the latest filing + quarter-over-quarter moves (new /
 *  exited / notable size changes) when a prior filing is available. */
export function summarize13F(filings: Filing13F[], fund: Fund): Record<string, unknown> {
  const latest = filings[0];
  const lv = byIssuer(latest);
  const total = [...lv.values()].reduce((a, b) => a + b, 0);
  const top = [...lv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, v]) => `${k}: ${usd(v)} (${(v / total * 100).toFixed(1)}%)`);
  let moves: string[];
  const prev = filings[1];
  if (prev) {
    const pv = byIssuer(prev);
    const news = [...lv.keys()].filter(k => !pv.has(k));
    const exits = [...pv.keys()].filter(k => !lv.has(k));
    const changed = [...lv.entries()]
      .map(([k, v]) => ({ k, d: v - (pv.get(k) ?? 0) }))
      .filter(c => pv.has(c.k) && Math.abs(c.d) > total * 0.01)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
    moves = [
      news.length ? `🆕 신규: ${news.slice(0, 8).join(', ')}` : '',
      exits.length ? `❌ 전량매도: ${exits.slice(0, 8).join(', ')}` : '',
      ...changed.map(c => `${c.d > 0 ? '▲' : '▼'} ${c.k} ${c.d > 0 ? '+' : '-'}${usd(c.d)}`),
    ].filter(Boolean);
  } else {
    moves = ['(직전 분기 filing 없음 — QoQ 델타 불가)'];
  }
  return {
    fund: fund.name, cik: fund.cik, period: latest.period, filed: latest.filed,
    portfolio_value: usd(total), positions: lv.size, top_holdings: top, qoq_moves: moves,
    note: 'SEC EDGAR 13F-HR (45일 지연). 값=USD. QoQ moves = 헤지펀드/기관 자금이동.',
  };
}
