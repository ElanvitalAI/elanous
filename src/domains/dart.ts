import { textOnly } from '../llm/stream-text.js';
// ── DART 공시 다운로더 (2026-07-07 · 대표 지시 — OpenDART 직결) ────────
//
// 배경: firecrawl DART 모니터는 "변경 감지 1건"만 알리고 공시 내용이 없음
// (대표 피드백 07-07 아침). OpenDART 공식 API로 교체: 공시 목록(list.json)
// → 신규 건 원문 다운로드(document.xml ZIP) → 텍스트 추출 → LLM 요약 →
// 제목+요약+뷰어 링크 알림. 크롤링 대비 안정적·법적 리스크 없음.
//
// 키: config.json raw `dart.apiKey` 우선 → asset-attractiveness/.env의
// DART_API_KEY 폴백 (기존 발급 키 재사용 — env 신설 아님·legacy 위치 재사용).
// 인코딩 gotcha: 원문 HTML의 meta는 euc-kr을 주장하지만 실 바이트는 UTF-8
// (2026-07-07 실측 — iconv euc-kr 디코드 시 한글 전멸). UTF-8로 읽는다.
// READ-ONLY 정보 알림 — 매매는 verify+HITL.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getUserConfig } from '../user-config.js';
import { getProviderForConfig, anyProviderAvailable, type LLMMessage } from '../llm.js';
import { conatusPath } from './conatus-data-dir.js';

const BASE = 'https://opendart.fss.or.kr/api';
const ATTR_ENV = join(homedir(), '.claude/skills/asset-attractiveness/.env');
export const DART_SEEN_PATH = conatusPath('dart_seen.json');

/** 감시 대상 기본값 — config raw `dart.corps` [{name, corpCode}]로 오버라이드. */
export const DEFAULT_CORPS = [
  { name: '삼성전자', corpCode: '00126380' },
  { name: 'SK하이닉스', corpCode: '00164779' },
];

export interface DartDisclosure {
  corp_name: string;
  stock_code: string;
  report_nm: string;
  rcept_no: string;
  flr_nm: string;
  rcept_dt: string; // YYYYMMDD
}

export function resolveDartApiKey(): string | null {
  try {
    const raw = getUserConfig().raw as Record<string, unknown> | undefined;
    const dart = raw?.dart as Record<string, unknown> | undefined;
    if (typeof dart?.apiKey === 'string' && dart.apiKey.trim()) return dart.apiKey.trim();
  } catch { /* config 없음 — 폴백 */ }
  try {
    const m = readFileSync(ATTR_ENV, 'utf-8').match(/^DART_API_KEY=([A-Za-z0-9]+)\s*$/m);
    if (m) return m[1]!;
  } catch { /* .env 없음 */ }
  return null;
}

export function resolveDartCorps(): Array<{ name: string; corpCode: string }> {
  try {
    const raw = getUserConfig().raw as Record<string, unknown> | undefined;
    const corps = (raw?.dart as Record<string, unknown> | undefined)?.corps;
    if (Array.isArray(corps)) {
      const parsed = corps
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map(c => ({ name: String(c.name ?? '?'), corpCode: String(c.corpCode ?? '') }))
        .filter(c => /^\d{8}$/.test(c.corpCode));
      if (parsed.length > 0) return parsed;
    }
  } catch { /* 폴백 */ }
  return DEFAULT_CORPS;
}

/** 공시 목록 조회 (기간 내 · 최신순). API 오류/네트워크 실패 = throw — 호출측 fail-soft. */
export async function fetchDisclosures(
  apiKey: string,
  corpCode: string,
  bgnDe: string,
  endDe: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DartDisclosure[]> {
  const url = `${BASE}/list.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bgn_de=${bgnDe}&end_de=${endDe}&page_count=100`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`DART list HTTP ${res.status}`);
  const json = (await res.json()) as { status: string; message?: string; list?: DartDisclosure[] };
  if (json.status === '013') return []; // 013 = 조회 결과 없음 (정상)
  if (json.status !== '000') throw new Error(`DART API ${json.status}: ${json.message ?? ''}`);
  return json.list ?? [];
}

/** HTML/XML → 본문 텍스트 (style/script 제거·태그 스트립·공백 정규화). */
export function stripDisclosureMarkup(s: string, maxChars = 6000): string {
  let t = s.replace(/(?:<style[^>]*>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>)/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#\d+;/g, ' ');
  return t.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** 공시 원문 다운로드 → 텍스트. document.xml(ZIP) → unzip -p(macOS 내장) →
 *  UTF-8 디코드(meta의 euc-kr 주장은 거짓 — 실측) → 태그 스트립. 실패 null. */
export async function downloadDisclosureText(
  apiKey: string,
  rceptNo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const tmp = join(tmpdir(), `dart-${rceptNo}-${process.pid}.zip`);
  try {
    const res = await fetchImpl(`${BASE}/document.xml?crtfc_key=${apiKey}&rcept_no=${rceptNo}`,
      { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    // ZIP 시그니처 확인 — API 오류 시 XML 에러 바디가 올 수 있음
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return null;
    writeFileSync(tmp, buf);
    const xml = execFileSync('/usr/bin/unzip', ['-p', tmp], { encoding: 'utf-8', maxBuffer: 32_000_000, timeout: 20_000 });
    const text = stripDisclosureMarkup(xml);
    return text.length > 40 ? text : null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch { /* */ }
  }
}

// ── 중요도 필터 (2026-07-07 대표 피드백: "무조건 공시 말고 중요한 것만") ──
// 2단: ① 룰 프리필터 — 명백한 루틴 공시는 LLM 호출 전에 접음(비용 0)
//       ② LLM 판정 — 요약과 함께 중요도 0-10 산출, floor(기본 6) 미만 억제.
// 판정불가(LLM 전멸)면 발송(유실 방지 — 억제는 확신 있을 때만).

/** 루틴 공시 패턴 — 임원/주주 소소한 지분변동·행정성 공시. 발송 억제(로그만).
 *  ⚠️ '최대주주변경'(중요)과 '최대주주등소유주식변동신고서'(루틴)는 다른 공시. */
const ROUTINE_PATTERNS: RegExp[] = [
  /소유주식변동신고서/,        // 최대주주등소유주식변동신고서 — 오늘 노이즈 실사례
  /소유상황보고서/,            // 임원·주요주주특정증권등소유상황보고서
  /주식매수선택권/,            // 스톡옵션 행사/부여
  /기업설명회.*개최|IR.*개최/, // IR 개최 안내
  /결산실적공시\s*예고/,
  /동일인등출자계열회사/,      // 계열사 상품·용역거래 (정기 행정성)
  /횡령.*혐의없음|소송등판결.*경미/,
];

export function isRoutineDisclosure(reportNm: string): boolean {
  const t = reportNm.replace(/\s+/g, '');
  return ROUTINE_PATTERNS.some(p => p.test(t));
}

export interface DisclosureJudgment {
  summary: string;
  /** 0-10 · null = 판정불가(LLM 전멸 — 유실 방지 위해 발송). */
  importance: number | null;
}

/** 발송 floor — config raw `dart.floor` (기본 6). */
export function resolveDartFloor(): number {
  try {
    const raw = getUserConfig().raw as Record<string, unknown> | undefined;
    const f = Number((raw?.dart as Record<string, unknown> | undefined)?.floor);
    if (Number.isFinite(f) && f >= 0 && f <= 10) return f;
  } catch { /* 기본값 */ }
  return 6;
}

const SUMMARY_SYSTEM = `너는 Conatus의 공시 데스크다. 아래 DART 공시 원문(텍스트 추출본)을 투자자 관점으로 판정·요약하라.

첫 줄에 반드시: 중요도: N  (N=0~10 정수)
- 8~10: 시장 반응 유발급 — 실적(잠정 포함)·유상증자/CB·합병분할·대규모 공급계약·자사주·배당 변경·최대주주 변경·소송 패소·상폐 사유
- 5~7: 유의 — 중간 규모 계약·지배구조 변화·조회공시 답변·시설투자
- 0~4: 루틴/경미 — 소액 지분변동·행정성 신고·정정(내용 경미)

이어서(한국어·4줄 이내):
**핵심**: 무엇을 공시했나 (숫자 있으면 반드시 포함 — 매출/영업이익/증감율/금액 등)
**함의**: 주가/섹터 관점 시사점 1문장 (매매 지시 금지 — 관찰 포인트)

규칙: 원문에 있는 내용만. 지어내지 마라.`;

/** LLM 요약+중요도 — fail-soft: 프로바이더 부재/실패 시 원문 발췌 + importance null. */
export async function summarizeDisclosure(title: string, text: string): Promise<DisclosureJudgment> {
  if (anyProviderAvailable()) {
    try {
      const provider = getProviderForConfig(getUserConfig());
      if (provider.streamChat) {
        const messages: LLMMessage[] = [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: `공시명: ${title}\n\n${text.slice(0, 9000)}` },
        ];
        let out = '';
        for await (const d of textOnly(provider.streamChat(messages, { temperature: 0.2, maxTokens: 400 }))) out += d;
        out = out.trim();
        if (out) return parseJudgment(out);
      }
    } catch { /* 폴백 */ }
  }
  return { summary: `(요약 불가 — 원문 발췌) ${text.slice(0, 400)}`, importance: null };
}

export function parseJudgment(out: string): DisclosureJudgment {
  const m = out.match(/중요도\s*[:：]?\s*\**\s*(\d{1,2})/);
  const n = m ? Math.min(10, Math.max(0, parseInt(m[1]!, 10))) : null;
  // 중요도 줄은 본문에서 제거 (알림엔 별도 표기)
  const summary = out.replace(/^.*중요도\s*[:：]?[^\n]*\n?/, '').trim() || out;
  return { summary, importance: n };
}

// ── seen state (rcept_no dedup · 최근 500건 유지) ──

export function loadSeen(path = DART_SEEN_PATH): Set<string> {
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8')) as { seen?: string[] };
    return new Set(Array.isArray(j.seen) ? j.seen : []);
  } catch { return new Set(); }
}

export function saveSeen(seen: Set<string>, path = DART_SEEN_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ seen: [...seen].slice(-500) }));
}

export function viewerUrl(rceptNo: string): string {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}
