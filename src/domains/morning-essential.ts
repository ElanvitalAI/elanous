// ── 종합 아침 브리핑 · 에센셜(텔레그램) 조립 (2026-07-10) ─────────────────────
//
// 대표 지시: 텔레그램엔 "섹터별 간략 에센셜 + 커뮤니티 버즈 정리 + 반도체 밸류체인/미국장
// + 전반 시장 이해 서사"만, 디테일은 S3 링크. 이 모듈은 (1) LLM 시장서사 종합 +
// (2) 결정론 앵커 섹션(정확한 수치/티커) + (3) 상세 링크를 합쳐 에센셜 메시지를 만든다.
// LLM 실패 시 서사만 빠지고 결정론 섹션은 그대로(fail-soft).

import { getUserConfig } from '../user-config.js';
import { getProviderForConfig, anyProviderAvailable, textOnly, type LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { marketClock } from './finance.js';
import { renderSemisEssential } from './kg-semis.js';
import { feedBySource } from './morning-synthesis.js';
import type { MorningSources } from './morning-synthesis.js';
import type { UploadedReport } from './morning-detail.js';
import type { dashboardHeatmap, dashboardSummary } from './dashboard-data.js';

// 결론-우선 재배치(2026-07-17 대표 지시: "한눈에·결론이 안 보인다") — PWA 시그널
// 대시보드가 이미 산출하는 매력도 Δ(자산×국가×섹터)·US/KR 섹터순환을 브리핑 상단에
// 컴팩트 텍스트로 얹는다. 새 수집 크론 없음(dashboard-data 재사용).
type Heatmap = ReturnType<typeof dashboardHeatmap>;
type Capstone = ReturnType<typeof dashboardSummary>['capstone'];
type AttractItem = { label: string; score: number; signal: string | null; dir: 'up' | 'down' | 'flat' | null };
type SectorMove = { name: string; dayPct: number; streak: number };

/** 브리핑 상단 구조화 블록에 쓰는 대시보드 스냅샷(라이브 fetch 는 composeMorningReport 가 주입). */
export interface EssentialExtras {
  heatmap?: Heatmap | null;
  capstone?: Capstone | null;
}

const arrow = (dir: string | null) => (dir === 'up' ? '▲' : dir === 'down' ? '▼' : '');
const sigMark = (s: string | null) => (s === 'BUY' ? '✅' : s === 'SELL' ? '⛔' : '');
const fmtAttract = (it: AttractItem) => `${it.label}${it.score}${arrow(it.dir)}${sigMark(it.signal)}`;
const fmtSector = (s: SectorMove) => {
  const d = Math.round(s.dayPct * 10) / 10; // sectorWrap 은 raw float — 여기서 1자리 반올림.
  return `${s.name}${d >= 0 ? '+' : ''}${d}${s.streak >= 4 ? `↑${s.streak}` : s.streak <= -4 ? `↓${-s.streak}` : ''}`;
};

/** 🎯 결론 — 국면 스탠스 + 캡스톤 포지션(결정론·최상단). */
function renderConclusion(src: MorningSources, capstone: Capstone | null | undefined): string {
  const lines: string[] = [];
  if (src.regimeSummary) lines.push(src.regimeSummary.trim());
  if (capstone?.target) {
    const label = String(capstone.label ?? '').replace(/^[🛡️🟢🔴⚔️⚠️\s]+/u, '').trim();
    lines.push(`🛡️ 캡스톤 *${capstone.target}*${label ? ` — ${label}` : ''}`);
    const { samsung, r3Level } = capstone as any;
    if (samsung && r3Level && samsung < r3Level)
      lines.push(`삼성 ₩${Number(samsung).toLocaleString('en-US')} → R3 ₩${Number(r3Level).toLocaleString('en-US')} 회복 시 LONG`);
  }
  if (!lines.length) return '';
  return `🎯 *결론*\n${lines.map(l => `  ${l}`).join('\n')}`;
}

/** 매력도 그룹 한 줄 — 상위(🟢) │ 하위(🔴). */
function attractLine(label: string, items: AttractItem[] | undefined): string {
  if (!items?.length) return '';
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const green = sorted.slice(0, 3).map(fmtAttract).join(' ');
  const red = sorted.length > 5 ? sorted.slice(-2).map(fmtAttract).join(' ') : '';
  return `  ${label} 🟢${green}${red ? ` │ 🔴${red}` : ''}`;
}

/** 📊 매력도 Δ — 자산군×국가×섹터 + 매수/매도 신호(대시보드 재사용). */
function renderAttractiveness(h: Heatmap | null | undefined): string {
  const a = h?.attractiveness as (undefined | null | { asOf: string; asset?: AttractItem[]; country?: AttractItem[]; sector?: AttractItem[] });
  if (!a) return '';
  const lines = [attractLine('자산군', a.asset), attractLine('국가  ', a.country), attractLine('섹터  ', a.sector)].filter(Boolean);
  if (!lines.length) return '';
  const all = [...(a.asset ?? []), ...(a.country ?? []), ...(a.sector ?? [])] as AttractItem[];
  const buys = all.filter(i => i.signal === 'BUY').map(i => i.label);
  const sells = all.filter(i => i.signal === 'SELL').map(i => i.label);
  const sig: string[] = [];
  if (buys.length) sig.push(`매수 ${buys.slice(0, 5).join('·')}`);
  if (sells.length) sig.push(`매도 ${sells.slice(0, 5).join('·')}`);
  const sigLine = sig.length ? `\n  → ${sig.join(' / ')}` : '';
  return `📊 *매력도 Δ* (전일 대비 · ${a.asOf})\n${lines.join('\n')}${sigLine}`;
}

/** 🗺 섹터순환 — US(상승 우위)·KR(하락 우위) + 급등/급락 무버. */
function renderSectorRotation(h: Heatmap | null | undefined): string {
  const us = h?.usSectors, kr = h?.krSectors;
  if (!us && !kr) return '';
  const lines: string[] = [];
  if (us?.sectors?.length) {
    const s = ([...us.sectors] as SectorMove[]).sort((a, b) => b.dayPct - a.dayPct);
    const up = s.filter(x => x.dayPct > 0).slice(0, 3).map(fmtSector).join(' ');
    const dn = s.filter(x => x.dayPct < 0).slice(-2).map(fmtSector).join(' ');
    if (up || dn) lines.push(`  US ${up ? `🟢${up}` : ''}${up && dn ? ' │ ' : ''}${dn ? `🔴${dn}` : ''}`);
  }
  if (kr?.sectors?.length) {
    const s = ([...kr.sectors] as SectorMove[]).sort((a, b) => b.dayPct - a.dayPct);
    const up = s.filter(x => x.dayPct > 0).slice(0, 2).map(fmtSector).join(' ');
    const dn = s.filter(x => x.dayPct < 0).slice(-3).map(fmtSector).join(' ');
    if (up || dn) lines.push(`  KR ${dn ? `🔴${dn}` : ''}${up && dn ? ' │ ' : ''}${up ? `🟢${up}` : ''}`);
  }
  if (!lines.length) return '';
  const nb = (us?.notables ?? []) as Array<{ symbol: string; dayPct: number }>;
  const gain = nb.filter(n => n.dayPct > 0).slice(0, 3).map(n => `${n.symbol}+${n.dayPct}`).join(' ');
  const lose = nb.filter(n => n.dayPct < 0).slice(0, 3).map(n => `${n.symbol}${n.dayPct}`).join(' ');
  const nbLine = gain || lose ? `\n  급등 ${gain || '—'} · 급락 ${lose || '—'}` : '';
  const date = us?.date ?? kr?.date ?? '';
  return `🗺 *섹터순환* (${date} EOD)\n${lines.join('\n')}${nbLine}`;
}

const ESSENTIAL_SYSTEM = `너는 Conatus 투자 아침 브리핑의 편집자다. 아래 밤사이 종합 데이터(국면, 반도체 밸류체인, 미국장 결산, 섹터 로테이션, 커뮤니티 버즈, 디깅, 회고)를 읽고 대표가 오늘 시장을 이해하도록 한국어 서사로 종합하라.

최우선: 한국 반도체(삼성/하이닉스 밸류체인)와 미국장(엔비디아 등 반도체) 연결을 가장 먼저 짚어라.

형식(각 1-3문장, 머리기호 없이 문단, 아래 태그를 문단 앞에 그대로 붙여라):
[관전] 오늘 시장의 핵심 한 문단.
[반도체] 미국 반도체 흐름이 한국 반도체로 어떻게 전파되는지, 밸류체인 관점.
[버즈] 커뮤니티에서 뜨는 종목/테마와 시장 데이터의 일치 또는 괴리.

규칙:
- 데이터에 실제로 있는 근거만 사용. 없는 수치/종목/이벤트를 지어내지 마라.
- 매매 지시(사라/팔라/비중 조절) 금지. 관찰과 유의점만. 최종 판단은 verify+HITL.
- 담백하고 신중한 톤. 이모지 최소.`;

/** synthesizeEssentialBrief 모델 자리(A/B 첫 조각) — 미지정이면 지금과 같은 기본 경로. */
export interface EssentialSynthOpts {
  /** 지정하면 getProviderForConfig(cfg, model) 로 부른다. */
  model?: string;
  /** provider 주입(시험용). 미지정이면 getProviderForConfig. */
  providerFor?: (cfg: ReturnType<typeof getUserConfig>, model?: string) => ReturnType<typeof getProviderForConfig>;
  /** 가용성 주입(시험용). 미지정이면 anyProviderAvailable. */
  available?: () => boolean;
}

/** 상세 markdown 을 입력으로 LLM 시장서사 종합. provider 없거나 실패 시 ''(에센셜은 결정론만). */
export async function synthesizeEssentialBrief(detailMarkdown: string, opts: EssentialSynthOpts = {}): Promise<string> {
  const { model, providerFor, available } = opts;
  if (!(available ?? anyProviderAvailable)()) return '';
  try {
    const cfg = getUserConfig();
    if (model) debug.log('domains.llm', 'cron-model', { domain: 'morning-essential', model: model ?? null });
    const resolve = providerFor ?? getProviderForConfig;
    const provider = model ? resolve(cfg, model) : resolve(cfg);
    if (!provider.streamChat) return '';
    // 토큰 절약: 상세를 앞부분 위주로 트림(핵심 섹션이 상단).
    const digest = detailMarkdown.slice(0, 6000);
    const messages: LLMMessage[] = [
      { role: 'system', content: ESSENTIAL_SYSTEM },
      { role: 'user', content: digest },
    ];
    let text = '';
    for await (const d of textOnly(provider.streamChat(messages, { temperature: 0.3, maxTokens: 640 }))) text += d;
    return text.trim();
  } catch { return ''; }
}

/** us-pulse 결산 리포트에서 대표적 라인 몇 개 추출(에센셜 앵커). */
function usPulseHeadline(report: string, max = 3): string[] {
  return report.split('\n').map(l => l.trim())
    .filter(l => l && !/^[#_]/.test(l) && !/^\(/.test(l))
    .slice(0, max);
}

/** 밤사이 소스 + LLM 서사 + 상세 링크 → 텔레그램 에센셜 메시지(markdown).
 *  구조(결론-우선 2026-07-17): 결론 → 매력도 Δ → 섹터순환 → 반도체 → 미국장 → 버즈·밤샘 → 서사(하단) → 상세. */
export function buildEssentialMessage(
  src: MorningSources,
  narrative: string,
  uploaded: UploadedReport | null,
  extras: EssentialExtras = {},
): string {
  const { buzz, dig, signal, reflection } = feedBySource(src.board);
  const parts: string[] = [`🌅 *Conatus 아침 브리핑* — ${src.dateKr}`, `_${marketClock()}_`];

  // 1) 🎯 결론 — 국면 스탠스 + 캡스톤(최상단·결정론).
  const conclusion = renderConclusion(src, extras.capstone);
  if (conclusion) parts.push(`\n${conclusion}`);
  else if (src.regimeSummary) parts.push(`\n${src.regimeSummary.trim()}`); // fail-soft: 캡스톤 없어도 국면은.

  // 2) 📊 매력도 Δ + 🗺 섹터순환 — 대시보드 구조화 뷰(한눈에).
  const attract = renderAttractiveness(extras.heatmap);
  if (attract) parts.push(`\n${attract}`);
  const sectors = renderSectorRotation(extras.heatmap);
  if (sectors) parts.push(`\n${sectors}`);

  // 3) 반도체 밸류체인 + 미국장 결산(정확한 수치/티커).
  const semis = renderSemisEssential(src.semis);
  if (semis) parts.push(`\n${semis}`);

  if (src.usPulse) {
    const lines = usPulseHeadline(src.usPulse.report);
    if (lines.length) parts.push(`\n🇺🇸 *미국장* (${src.usPulse.date})\n${lines.map(l => `  ${l}`).join('\n')}`);
  }

  if (buzz.length) {
    const top = buzz.slice(0, 4).map(d => `  ${d.title}`).join('\n');
    parts.push(`\n💬 *커뮤니티 버즈*\n${top}`);
  }

  // 4) 밤샘 종합 한 줄 + 대표 항목.
  const counts: string[] = [];
  if (dig.length) counts.push(`디깅 ${dig.length}`);
  if (signal.length) counts.push(`신호 ${signal.length}`);
  if (reflection.length) counts.push(`회고 ${reflection.length}`);
  if (counts.length) {
    const head = reflection[0]?.title || dig[0]?.title || '';
    parts.push(`\n🌙 *밤샘 종합* (${counts.join(' · ')})${head ? `\n  ${head}` : ''}`);
  }

  // 5) LLM 시장서사(관전/반도체/버즈) — 근거 뒤 하단으로(결론이 먼저 보이게).
  if (narrative) parts.push(`\n🧭 *서사*\n${narrative}`);

  // 6) 상세 리포트 링크(대표 지시: 디테일은 S3 주소).
  if (uploaded) {
    parts.push(`\n📄 *상세 리포트*  ·  [HTML](${uploaded.htmlUrl})  ·  [MD](${uploaded.mdUrl})`);
  }

  parts.push('\n_출처: elanous finance 종합 (밤사이 자율 루프 종합). 매매는 verify+HITL._');
  return parts.join('\n');
}
