// ELN-OP-MEMORY-SEED (TC-H-CC-1 · OP #128162/#128202 · 11-22) — Claude OP 기억 → eln OP 자리 기억 원장 시딩.
// 진단 seat-state/OP/DIAG-ELN-OP-COORDINATOR-1122.md §2·지렛대 4: OP 자리 기억 저장소(seats/OP)가 비어 있어
// 규칙 위반·남의 일 재조사가 반복된다. 이 모듈은 한 번의 계획으로
//   ① Claude Code OP 기억 폴더(⭐ 색인 포함 — seat-memory-import 재사용)
//   ② OPS-RULES 섹션별 발췌(ops-rule-<슬러그> · 섹션 = 기억 1개) · ③ DECISIONS-OP.tsv 최근 N행(행 = 기억 1개 · op-decision-<ts>)
//     ⊕ 최신 행 고정 기억(op-decision-latest) · ④ LANDING-KNOWHOW 머리(landing-knowhow · 선택)
// 를 `<memoryRoot>/seats/OP` 에 합성해 심는다. 생성 기억 색인 줄이 맨 앞에 와서 부트 카드가 먼저 보여 준다.
// 원본 소스는 읽기만 한다 · 기본 dry-run · 비밀처럼 보이면 그 기억만 거부(이름만) · 소스 없으면 그 소스만 건너뛴다(fail-soft).
//
// JUD-C HOLD judb-39558-bc0378ab(OP 필수 #128783) — «전체 개수 상한 자르기 금지 · 항목마다 기억 1개(≤200토큰)»:
// 옛 clipAtLine 통짜 생성 기억(OPS 다이제스트 3000자 앞부분만 생존 → 마지막 섹션 유실 · 결정 25행 중 앞 16행만 생존 →
// 최신 행 유실)을 폐지하고, 각 항목을 회상 예산(1500토큰) 안에 드는 작은 기억으로 나눠 «모두» 심는다.
// 회상은 고치지 않는다 — hit 여럿이 1500토큰 안에 함께 실리는 게 seat-memory recall 의 기존 동작이다.

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { estimateTokens } from '../tokens.js';
import {
  listSeatMemories, looksSecret, parseSeatMemoryText, readSeatMemoryIndex, seatMemoryFileName, seatMemoryIndexLine,
  type SeatMemoryEntry,
} from './seat-memory.js';
import {
  applySeatMemoryImport, planSeatMemoryImport, summarizeSeatMemoryImport, supplementalFileName, SUPPLEMENTAL_MARKER,
  type SeatMemoryImportAction, type SeatMemoryImportPlan, type SeatMemoryImportSummary, type SeatMemoryImportSkip,
} from './seat-memory-import.js';
export interface OpMemorySeedOptions {
  /** Claude Code OP 기억 폴더(…/.claude/projects/<project>/memory) — 읽기 전용. */
  claudeDir: string;
  /** seat-state/OPS/OPS-RULES.md — 읽기 전용. */
  opsRulesPath: string;
  /** seat-state/OP/DECISIONS-OP.tsv — 읽기 전용. */
  decisionsPath: string;
  /** seat-state/OP/LANDING-KNOWHOW.md — 읽기 전용 · 미지정이면 생성 0. */
  landingPath?: string;
  to: string;
  seat: string;
  /** DECISIONS 최근 행 수(기본 25). */
  decisionsRecent?: number;
  /** 출처 신뢰 확인(JUD jud-39558) — 허용 경로 목록. 모든 읽기 전용 소스(claudeDir·OPS-RULES·DECISIONS·LANDING)가
   *  이 루트 안에 있어야 한다 — 밖이면 그 소스는 건너뛴다(비신뢰 소스가 회상 최상위에 못 들어간다). */
  allowedSourceRoots: string[];
}

export interface OpMemorySeedPlan extends SeatMemoryImportPlan {
  /** 이 계획이 새로 만든 요약 기억(고정 순서) — skipped 된 것은 빠진다. */
  generated: Array<{ name: string; action: SeatMemoryImportAction }>;
}

export const OP_SEED_DECISIONS_RECENT_DEFAULT = 25;
/** JUD-C judb-39558-bc0378ab(OP 필수 #128783) — 항목 = 기억 1개 · 본문 토큰 상한.
 *  턴 회상 예산 maxTokens 1500 이라 여러 hit(각 ≤200토큰)가 한 블록에 5~7개 함께 실린다.
 *  초과 항목은 «앞자르기»가 아니라 다음 칸(OPS 섹션)·문자 클립(결정 행)으로 나눈다. */
export const OP_SEED_ITEM_TOKENS_MAX = 200;

/** OP 승인 출처 4곳(JUD jud-39558 · OP #128879) — CLI 기본. 이 밖 소스는 전부 거부. */
export const OP_SEED_ALLOWED_SOURCE_ROOTS: readonly string[] = Object.freeze([
  join(homedir(), '.claude', 'projects', '-Users-user-elanous-hq-repo-git', 'memory'),
  join(homedir(), 'elanous-hq', 'seat-state', 'OPS', 'OPS-RULES.md'),
  join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'DECISIONS-OP.tsv'),
  join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'LANDING-KNOWHOW.md'),
]);
/** LANDING 은 이번 지시 밖 — 기존 통짜 2000자 클립 유지(clipAtLine 은 이 방어선으로만 쓴다). */
const LANDING_BODY_MAX = 2_000;

/** 줄 경계에서 자른다(중간 낱말 잘림 방지) — 60% 지점 이전에 줄이 없으면 그냥 자른다.
 *  JUD-C 이후 용도: 개별 항목 방어선(LANDING 머리·200토큰 클립)만 — 통짜 생성 기억은 폐지했다. */
const clipAtLine = (text: string, cap: number): string => {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const breakAt = cut.lastIndexOf('\n');
  const head = breakAt > cap * 0.6 ? cut.slice(0, breakAt) : cut;
  return `${head}\n…(상한 ${cap}자에서 자름 — 정본 파일 참조)`;
};

/** 항목 본문 래퍼(사실/출처/How-to) 접두·접미 — 래퍼 포함 200토큰 안에 들어가게 원문 예산을 미리 뺀다. */
const DECISION_WRAP_HEAD = '사실: OP 결정 원장 행 원문.\n\n- ';
const DECISION_WRAP_TAIL = '\n\n출처: seat-state/OP/DECISIONS-OP.tsv\nHow to apply: 판정 충돌·승인 발행 전 대조.';
const OPS_WRAP_TAIL = '\n\n출처: seat-state/OPS/OPS-RULES.md\nHow to apply: 칸 착수·판정·보고 전 대조.';

/** 상한을 넘는 «한 줄» 을 내용 소실 0 조각으로 나눈다 — 문자 클립 폐지(JUD-C judb-39558-73dd8d11f3ed · OP #129161).
 *  조각을 이어 붙이면 원문이 복원되고, 각 조각은 head·tail 래퍼 포함 예산 안이다(최대 접두 길이 이분 탐색). */
const splitLineByTokens = (line: string, maxTokens: number, head: string, tail: string): string[] => {
  const fits = (piece: string): boolean => estimateTokens(`${head}${piece}${tail}`) <= maxTokens;
  if (fits(line)) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > 0 && !fits(rest)) {
    if (!fits(rest.slice(0, 1))) break; // 래퍼만으로 예산을 넘는 극단 방어 — 호출부가 이런 예산을 만들지 않는다
    let lo = 1;
    let hi = rest.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(rest.slice(0, mid))) lo = mid;
      else hi = mid - 1;
    }
    pieces.push(rest.slice(0, lo));
    rest = rest.slice(lo);
  }
  pieces.push(rest);
  return pieces;
};

/** 결정 «행» → 기억 조각들 — 상한 이내면 1개, 넘으면 내용 보존 분할(출처 줄·순번은 렌더에서 · 자릿수 여유분 head 로 예산 보장). */
interface DecisionPiece { piece: string; i: number; n: number }
const splitDecisionRow = (row: string): DecisionPiece[] => {
  const headEst = `사실: OP 결정 원장 최신 행 원문 — 출처 줄 99999 · 조각 999/999.\n\n- `;
  const pieces = splitLineByTokens(row, OP_SEED_ITEM_TOKENS_MAX, headEst, DECISION_WRAP_TAIL);
  return pieces.map((piece, i) => ({ piece, i: i + 1, n: pieces.length }));
};

/** OPS-RULES 핵심 줄: 제목·인용·표 행·글머리표만 남긴다(빈 줄·코드 울타리 제외). */
const digestOpsRules = (text: string): string => text
  .replace(/\r\n?/g, '\n').split('\n')
  .filter(l => /^(#|>|\||-)/.test(l.trim()) && l.trim() !== '|---|' && l.trim() !== '|:--|')
  .join('\n').trim();

/** 다이제스트 줄을 `^#` 제목 경로로 섹션별로 나눈다 — 원본 OPS-RULES.md 줄 번호(1-based)를 함께 달아
 *  분할 조각의 출처 줄 표기에 쓴다(JUD-C judb-39558-73dd8d11f3ed · OP #129161).
 *  JUD-C judb-39558-bc0378ab — 섹션 = 기억 1개 · 전체 개수 상한 자르기 금지(마지막 섹션까지 온전히 시딩). */
const splitOpsSections = (text: string): Array<{ title: string; lines: Array<{ text: string; no: number }> }> => {
  const digestLines = digestOpsRules(text);
  const keptNos: number[] = [];
  text.replace(/\r\n?/g, '\n').split('\n').forEach((l, i) => {
    if (/^(#|>|\||-)/.test(l.trim()) && l.trim() !== '|---|' && l.trim() !== '|:--|') keptNos.push(i + 1);
  });
  const out: Array<{ title: string; lines: Array<{ text: string; no: number }> }> = [];
  let current: { title: string; lines: Array<{ text: string; no: number }> } | null = null;
  digestLines.split('\n').forEach((line, di) => {
    if (/^#/.test(line.trim())) {
      current = { title: line.trim().replace(/^#+\s*/, ''), lines: [] };
      out.push(current);
    } else {
      if (!current) current = { title: '개요', lines: [] }, out.push(current);
      current.lines.push({ text: line, no: keptNos[di] ?? 0 });
    }
  });
  return out.filter(s => s.lines.some(l => l.text.trim()));
};

/** 섹션 제목 슬러그 — seatMemoryFileName 과 같은 규칙(\p{L} 허용 — 한글 슬러그 그대로). */
const slugify = (title: string): string =>
  title.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || '섹션';

/** 섹션 한 개를 상한 이하 덩어리로 나눈다 — 앞자르기 금지, 전 줄 보존. «빈 덩어리 무조건 수용» 분기 폐지:
 *  상한을 넘는 «한 줄» 은 그대로 통과시키지 않고 줄 내용 분할로 조각낸다(JUD-C judb-39558-73dd8d11f3ed · OP #129161).
 *  분할 조각은 렌더 시 `원문 … 〔출처 줄 no · 조각 i/n〕` 표기 — 이어 붙이면 원문 복원(내용 소실 0). */
interface OpsPiece { text: string; no: number; frag?: { i: number; n: number } }
const renderOpsPieces = (chunk: OpsPiece[]): string =>
  chunk.map(l => l.frag ? `${l.text} 〔출처 줄 ${l.no} · 조각 ${l.frag.i}/${l.frag.n}〕` : l.text).join('\n');
const chunkSection = (lines: Array<{ text: string; no: number }>, maxTokens: number, sectionTitle: string): OpsPiece[][] => {
  // 조각 마커·«발췌» 머리줄·출처 행까지 포함한 최악 여유분 head/tail — 각 조각 기억 본문이 래퍼 포함 상한 안이게.
  const headEst = `사실: OPS-RULES «${sectionTitle}» 발췌 (999/999).\n\n`;
  const markEst = ` 〔출처 줄 999999 · 조각 999/999〕`;
  const chunks: OpsPiece[][] = [];
  let cur: OpsPiece[] = [];
  for (const line of lines) {
    const pieces = splitLineByTokens(line.text, maxTokens, headEst, `${markEst}${OPS_WRAP_TAIL}`);
    if (pieces.length > 1) { // 상한 초과 단일 줄 → 줄 내용 분할(조각마다 기억 1개)
      if (cur.length) { chunks.push(cur); cur = []; }
      pieces.forEach((piece, pi) => chunks.push([{ text: piece, no: line.no, frag: { i: pi + 1, n: pieces.length } }]));
      continue;
    }
    if (cur.length && estimateTokens(`${renderOpsPieces(cur)}\n${line.text}${OPS_WRAP_TAIL}`) > maxTokens) { chunks.push(cur); cur = []; }
    cur.push(line);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
};

/** DECISIONS TSV — 비어 있지 않은 행의 마지막 N행을 원문 그대로(열 순서가 시대별로 섞여 있어 통째로 보존).
 *  JUD-C judb-39558-f46e95fe: 원본 1-based 줄 번호를 필터·슬라이스 «전에» 붙여 들고 간다 — 빈 줄·선행 기록이
 *  있어도 출처 줄 = 원본 TSV 실제 줄 번호(옛 배열 순번 오표기 폐지). */
const recentDecisions = (text: string, recent: number): Array<{ row: string; no: number }> => text
  .replace(/\r\n?/g, '\n').split('\n').map((row, i) => ({ row, no: i + 1 }))
  .filter(l => l.row.trim()).slice(-recent);

/** 행 첫 열 타임스탬프 → `YYYYMMDD-HHmm` 슬러그. 비정규형이면 행 내용 sha 앞 6자. */
const decisionSlug = (row: string): string => {
  const first = row.split('\t')[0] ?? '';
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):?(\d{2})/.exec(first);
  if (m) return `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}`;
  return createHash('sha256').update(row).digest('hex').slice(0, 6);
};

/** 행 앞부분 요약(description 용) — 첫 두 열 ⊕ 세째 열 머리(고유 낱말이 description 을 향하게 해 회상 랭킹이 최신 행을 찾게 한다). */
const rowHead = (row: string): string => {
  const cols = row.split('\t');
  const head = [...cols.slice(0, 2).filter(Boolean), ...(cols[2] ? [cols[2].slice(0, 60)] : [])];
  return head.join(' · ');
};

/** 행에서 날짜 표기(description 용) — 없으면 빈칸. */
const rowDate = (row: string): string => /(\d{4}-\d{2}-\d{2})/.exec(row)?.[1] ?? '';

const renderMemoryFile = (name: string, description: string, type: 'feedback' | 'project' | 'reference', body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;

/** 생성 기억 후보 하나 — 이름·본문이 정해진 상태(비밀 검사·파일 매핑은 계획 단계에서). */
interface GeneratedItem {
  name: string;
  /** skipped 보고에 쓸 이름(비밀 항목 식별용 — 대상 파일과 같은 꼴). */
  skipFile: string;
  description: string;
  type: 'feedback' | 'project' | 'reference';
  body: string;
}

/** 생성 기억 이름 판정 — 프리픽스로(이제 항목마다 기억 1개라 이름이 수백 개다).
 *  claude 이식분에 이 프리픽스 이름이 있으면 이식에서 뺀다(생성 기억이 이긴다 — 기존 규칙). */
const isGeneratedMemoryName = (name: string): boolean =>
  name.startsWith('ops-rule-') || name.startsWith('op-decision-') || name === 'landing-knowhow';

/** 경로 포함 판정(JUD jud-39558 출처 확인) — realOrSelf 로 푼 실제 경로 기준. */
const isInsideRoot = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** 실재하는 가장 가까운 조상까지 realpath 로 풀고 나머지를 붙인다(심볼릭 링크·아직 없는 경로도 바르게 잰다). */
const realOrSelf = (path: string): string => {
  const abs = resolve(path);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(basename(head));
    head = parent;
  }
  try { return join(realpathSync(head), ...tail); } catch { return abs; }
};

/** 쓰기 범위 검증(JUD jud-39558) — 시딩은 <memoryRoot>/seats/<SEAT> 한 디렉터리 안에서만(공유·타 자리 저장소 거부). */
const assertSeedScope = (to: string, seat: string): void => {
  const abs = resolve(to);
  if (basename(abs) !== seat || basename(dirname(abs)) !== 'seats') {
    throw new Error(`seed-op 쓰기 범위 위반 — to 는 <memoryRoot>/seats/${seat} 안이어야 한다(공유·타 자리 저장소 거부 · JUD jud-39558): ${to}`);
  }
};

/** 소스 원문 → 생성 기억 항목 전부(순서 = 색인 순서: ops-rule-* 소스 순 → op-decision-latest → op-decision-<ts> 최신→오래 → landing).
 *  JUD-C judb-39558-bc0378ab(OP 필수 #128783): 항목마다 기억 1개(≤200토큰) — 전체 개수 상한 자르기 없이 «모두» 심는다. */
const generatedItems = (opts: OpMemorySeedOptions, raws: Record<'opsRules' | 'decisions' | 'landing', string | null>): GeneratedItem[] => {
  const items: GeneratedItem[] = [];
  const usedNames = new Set<string>(['op-decision-latest', 'landing-knowhow']);
  /** 이름 중복 방지(섹션 슬러그 충돌·결정 슬러그 충돌) — `-2`, `-3` 접미. 멱등: 같은 소스 → 같은 이름. */
  const uniqueName = (base: string): string => {
    let name = base;
    let n = 1;
    while (usedNames.has(name)) { n += 1; name = `${base}-${n}`; }
    usedNames.add(name);
    return name;
  };

  // ② OPS-RULES — 섹션 = 기억 1개(ops-rule-<슬러그>) · 섹션이 길면 줄 단위 분할(-2, -3… 전 줄 보존).
  //    상한 초과 단일 규칙 줄 = 줄 내용 분할 — 각 조각이 기억 1개, 마커 〔출처 줄 · 조각 i/n〕 로 원문 복원 가능.
  if (raws.opsRules !== null) {
    const sections = splitOpsSections(raws.opsRules);
    for (const section of sections) {
      const base = `ops-rule-${slugify(section.title)}`;
      const chunks = chunkSection(section.lines, OP_SEED_ITEM_TOKENS_MAX, section.title);
      chunks.forEach((chunkLines, i) => {
        const name = uniqueName(i === 0 ? base : `${base}-${i + 1}`);
        const body = [
          `사실: OPS-RULES «${section.title}» 발췌${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}.`,
          '',
          renderOpsPieces(chunkLines),
          '',
          '출처: seat-state/OPS/OPS-RULES.md',
          'How to apply: 칸 착수·판정·보고 전 대조.',
        ].join('\n');
        items.push({ name, skipFile: `${base}.md`, description: `OPS 규칙 — ${section.title}`, type: 'feedback', body });
      });
    }
  }

  // ③ DECISIONS — 행 = 기억 1개(op-decision-<타임스탬프슬러그>) ⊕ 마지막 행 고정 기억(op-decision-latest).
  //    상한 초과 단일 행 = 내용 보존 분할(JUD-C judb-39558-73dd8d11f3ed) — 조각마다 기억 1개(-p2, -p3…) · 출처 줄·순번 표기.
  if (raws.decisions !== null) {
    const rows = recentDecisions(raws.decisions, opts.decisionsRecent ?? OP_SEED_DECISIONS_RECENT_DEFAULT);
    const perRow: Array<{ name: string; row: string; no: number }> = [];
    for (const r of rows) perRow.push({ name: uniqueName(`op-decision-${decisionSlug(r.row)}`), row: r.row, no: r.no });
    const decisionBody = (head: string, piece: string): string =>
      `${head}\n\n- ${piece}\n\n출처: seat-state/OP/DECISIONS-OP.tsv\nHow to apply: 판정 충돌·승인 발행 전 대조.`;
    // 최신(마지막) 행 고정 기억 — 일반 «최근 결정» 쿼리가 최신 행에 닿게 하는 장치. 상한 초과 행은 조각 1만
    // 고정 기억에(«조각 1/N · 잇는 조각은 op-decision-* 개별 조각 기억에») — 전체 조각을 2벌 시딩하면
    // 회상 maxHits(5)를 넘쳐 조각 유실이 생긴다(JUD-C judb-39558-73dd8d11f3ed ② — 조각 전체 턴 회상).
    if (perRow.length > 0) {
      const latest = perRow[perRow.length - 1]!;
      const lp = splitDecisionRow(latest.row);
      const first = lp[0]!;
      items.push({
        name: 'op-decision-latest', skipFile: 'op-decision-latest.md',
        description: `OP 결정 최신(최근)${lp.length > 1 ? ` — 조각 1/${lp.length} · 잇는 조각은 op-decision-${decisionSlug(latest.row)}-p* 기억` : ''} — ${rowHead(latest.row)}`, type: 'project',
        body: decisionBody(`사실: OP 결정 원장 최신 행 원문${lp.length > 1 ? ` — 출처 줄 ${latest.no} · 조각 1/${lp.length}` : ''}.`, first.piece),
      });
    }
    // 개별 행 — 색인은 최신→오래 순서로.
    for (let ri = perRow.length - 1; ri >= 0; ri--) {
      const { name, row, no } = perRow[ri]!;
      const pieces = splitDecisionRow(row);
      pieces.forEach((p, k) => items.push({
        name: k === 0 ? name : `${name}-p${p.i}`, skipFile: `${name}.md`,
        description: `OP 결정 ${rowDate(row) || '원장'}${pieces.length > 1 ? ` — 조각 ${p.i}/${p.n}` : ''} — ${rowHead(row)}`, type: 'project',
        body: decisionBody(`사실: OP 결정 원장 행 원문${pieces.length > 1 ? ` — 출처 줄 ${no} · 조각 ${p.i}/${p.n}` : ''}.`, p.piece),
      }));
    }
  }

  // ④ LANDING — 이번 지시 밖(기존 통짜 2000자 클립) · 출처 표기만 ②③ 과 맞춘다.
  if (raws.landing !== null) {
    const body = `사실: 착지 조정 원장 머리 발췌.\n\n${clipAtLine(raws.landing.replace(/\r\n?/g, '\n').trim(), LANDING_BODY_MAX)}\n\n출처: seat-state/OP/LANDING-KNOWHOW.md\n정본: LANDING-KNOWHOW.md (승화 사다리 — 노하우→규칙→로직→시뮬→손 은퇴).`;
    items.push({ name: 'landing-knowhow', skipFile: 'landing-knowhow.md', description: '착지 조정 노하우 원장(LANDING-KNOWHOW) — 승화 사다리·꼴·감지·조정 표', type: 'reference', body });
  }

  return items;
};

/** 원본을 읽어 합성 시딩 계획을 만든다(쓰기 0). */
export function planOpMemorySeed(opts: OpMemorySeedOptions): OpMemorySeedPlan {
  assertSeedScope(opts.to, opts.seat);
  const allowedRoots = opts.allowedSourceRoots.map(realOrSelf);
  const sourceAllowed = (p: string): boolean => allowedRoots.some(r => isInsideRoot(realOrSelf(p), r));

  // JUD-C judb-39558 ① — Claude 원본 폴더가 없거나 허용 루트 밖이면 그 소스만 건너뛰고
  // 나머지 유효 소스(OPS-RULES·DECISIONS·LANDING)의 시딩 계획은 진행한다(fail-soft — 이식 계획을 빈 계획으로 대체).
  const claudeAllowed = sourceAllowed(opts.claudeDir);
  const claudeDirUsable = claudeAllowed && existsSync(opts.claudeDir)
    && (() => { try { return lstatSync(opts.claudeDir).isDirectory(); } catch { return false; } })();
  const base: SeatMemoryImportPlan = claudeDirUsable
    ? planSeatMemoryImport({ from: opts.claudeDir, to: opts.to, seat: opts.seat })
    : { from: opts.claudeDir, to: opts.to, seat: opts.seat, files: [], skipped: [], index: '', indexDroppedLines: 0 };

  // 같은 name 소유자 — 대상 저장소 기존 파일 ⊕ 이번 claude 이식분(이식 규칙: 같은 name 은 그 파일을 고친다). 비신뢰 claude 는 제외.
  const fileByName = new Map<string, string>();
  for (const e of listSeatMemories(opts.to)) fileByName.set(e.name, e.file);
  if (claudeDirUsable) for (const f of base.files) fileByName.set(f.name, f.file);

  const files = (claudeDirUsable ? base.files : []).filter(f => !isGeneratedMemoryName(f.name));
  const skipped: SeatMemoryImportPlan['skipped'] = claudeDirUsable
    ? [...base.skipped]
    : [{ file: basename(opts.claudeDir), reason: claudeAllowed ? ('not-regular-file' as SeatMemoryImportSkip) : 'source-outside-allowed-roots' }];
  // JUD-C judb-39558-d415b76374f7(② · #129883) — 생성 이름 원본의 처분 계약 원장: claude 원본 중 생성 이름 기억은 이식에서
  // 제외되므로(생성 기억이 그 이름 공간을 소유), 대상에도 없고 동일 이름 생성물도 없는 것의 줄이 색인에 남으면 끊어진 링크가 된다.
  // 이식 제외된 원본 전부를 skipped 원장에 기록해 처분(미이식 — 원본은 읽기 전용 claudeDir 에 유지)을 관측 가능하게 한다.
  const transplantFiles = new Set(files.map(f => f.file));
  if (claudeDirUsable) for (const f of base.files) {
    if (isGeneratedMemoryName(f.name) && !transplantFiles.has(f.file)) {
      skipped.push({ file: f.file, reason: 'superseded-by-generated-name' });
    }
  }
  const generated: Array<{ name: string; action: SeatMemoryImportAction }> = [];
  const generatedLines: string[] = [];
  const generatedTargets = new Set<string>();

  // 소스 원문 읽기 — 허용 루트 밖·부재·읽기 실패면 그 «소스» 를 통째로 skip(기존 fail-soft).
  type RawKey = 'opsRules' | 'decisions' | 'landing';
  const raws: Record<RawKey, string | null> = { opsRules: null, decisions: null, landing: null };
  const sourceSpecs: Array<{ key: RawKey; path: string | undefined; skipFile: string }> = [
    { key: 'opsRules', path: opts.opsRulesPath, skipFile: 'OPS-RULES.md' },
    { key: 'decisions', path: opts.decisionsPath, skipFile: 'DECISIONS-OP.tsv' },
    { key: 'landing', path: opts.landingPath, skipFile: 'LANDING-KNOWHOW.md' },
  ];
  for (const spec of sourceSpecs) {
    if (!spec.path) continue; // landingPath 미지정 = 생성 0
    if (!sourceAllowed(spec.path)) { skipped.push({ file: spec.skipFile, reason: 'source-outside-allowed-roots' }); continue; }
    if (!existsSync(spec.path) || !lstatSync(spec.path).isFile()) { skipped.push({ file: spec.skipFile, reason: 'not-regular-file' as SeatMemoryImportSkip }); continue; }
    try { raws[spec.key] = readFileSync(spec.path, 'utf8'); } catch { skipped.push({ file: spec.skipFile, reason: 'not-regular-file' as SeatMemoryImportSkip }); }
  }

  for (const item of generatedItems(opts, raws)) {
    const target = fileByName.get(item.name) ?? seatMemoryFileName(item.name);
    const text = renderMemoryFile(item.name, item.description, item.type, item.body);
    if (looksSecret(text)) {
      // 비밀 섞인 «항목» 만 빼고 나머지 항목은 그대로 시딩 — 전체 소스 skip 은 «모두 심기» 위반(JUD-C #128783).
      skipped.push({ file: item.skipFile, reason: 'secret-pattern' });
      continue;
    }
    const entry: SeatMemoryEntry | null = parseSeatMemoryText(text, target);
    if (!entry) { skipped.push({ file: item.skipFile, reason: 'unparsable' as SeatMemoryImportSkip }); continue; }
    let action: SeatMemoryImportAction = 'create';
    try { action = existsSync(join(opts.to, target)) ? (readFileSync(join(opts.to, target), 'utf8') === text ? 'same' : 'update') : 'create'; } catch { action = 'create'; }
    files.push({ file: target, name: item.name, action, text });
    generated.push({ name: item.name, action });
    generatedLines.push(seatMemoryIndexLine(entry));
    generatedTargets.add(target);
  }

  // 색인: 생성 기억 줄이 맨 앞(ops-rule-* 소스 순 → op-decision-latest → op-decision-<ts> 최신→오래 → landing)
  //        → 원본 ⭐ 순서(claude 이식 계획) → 나머지. 생성 대상 줄은 아래에서 중복 제거.
  const linkOf = (line: string): string | null => /\]\(([^)\s]+\.md)\)/.exec(line)?.[1] ?? null;
  const baseLines = claudeDirUsable ? base.index.replace(/\n+$/, '').split('\n').filter(l => l.trim()) : [];
  const targetFileAlive = (file: string): boolean => {
    try { return lstatSync(join(opts.to, file)).isFile(); } catch { return false; }
  };
  const kept = baseLines.filter(l => {
    const link = linkOf(l);
    if (!link) return true;
    if (generatedTargets.has(link)) return false; // 생성 줄이 맨 앞에 실리므로 중복 줄은 버림(기존 규칙)
    // JUD-C judb-39558-d415b76374f7(② · #129883) — 이번 계획 파일·대상 기존 파일 어디에도 없는 링크(이식 제외 원본 등)는
    // 색인이 없는 파일을 가리키는 끊어진 링크가 된다 → 줄을 버린다(처분: 미이식·미색인 · 원본은 읽기 전용 claudeDir 에 유지).
    return files.some(f => f.file === link) || targetFileAlive(link);
  });
  // JUD-C judb-39558-f46e95fe(H1 · OP probe CONFIRMED) — 기존 색인 줄 보존·병합 + 보조 색인 항상:
  // 주 색인 = 생성 줄 → claude ⭐ 줄 → 대상 주 색인의 «기존» 줄(링크 대상 파일이 이 계획 뒤에도 살아 있을 때만 —
  // 옛 버전은 주 색인을 새로 짜서 기존 줄을 통째로 잃었다). 주 색인에 줄이 없는 기억(대상 미색인 ⊕ claude 미색인)은
  // 보조 색인(MEMORY-UNINDEXED*)에 «항상» 실어 색인 접근 공백을 없앤다(claudeDir 부재 시에도 — applySeatMemoryImport 는
  // supplementalIndex 가 있을 때만 보조 색인을 쓰므로 plan 이 이를 전달해야 한다).
  const mainDraft = [...generatedLines, ...kept];
  const hasLine = (lines: string[], file: string): boolean => lines.some(l => l.includes(`](${file})`));
  const preserved: string[] = [];
  for (const line of readSeatMemoryIndex(opts.to).replace(/\n+$/, '').split('\n')) {
    const link = linkOf(line);
    if (!link || basename(link) !== link || looksSecret(line)) continue;
    if (hasLine(mainDraft, link) || hasLine(preserved, link)) continue;
    if (!files.some(f => f.file === link) && !targetFileAlive(link)) continue;
    preserved.push(line);
  }
  const mainLines = [...mainDraft, ...preserved];
  const supplemental: string[] = [];
  for (const entry of listSeatMemories(opts.to)) { // ① 대상 기존 기억 — 색인 접근 보존 회귀의 핵심
    if (!hasLine(mainLines, entry.file) && !hasLine(supplemental, entry.file)) supplemental.push(seatMemoryIndexLine(entry));
  }
  if (claudeDirUsable) for (const f of base.files) { // ② claude 이식 기억(reference 문서 제외 — import.ts 와 같은 규칙)
    if (f.reference || hasLine(mainLines, f.file) || hasLine(supplemental, f.file)) continue;
    // JUD-C judb-39558-d415b76374f7(② · #129883) — 이식 제외(생성 이름) 원본 중 이번 계획 파일·대상 기존 파일 어디에도
    // 없는 것은 보조 색인에 실으면 끊어진 링크가 된다 → 제외(처분: 미이식·미색인 · skipped 원장에 기록 · 원본은 claudeDir 에 유지).
    if (isGeneratedMemoryName(f.name) && !files.some(x => x.file === f.file) && !targetFileAlive(f.file)) continue;
    const entry = parseSeatMemoryText(f.text, f.file);
    if (entry) supplemental.push(seatMemoryIndexLine(entry));
  }
  const supplementalFile = supplemental.length ? supplementalFileName(base.from, opts.to) : null;
  const index = mainLines.join('\n');

  return {
    from: base.from, to: base.to, seat: base.seat, files, skipped,
    index: index ? `${index}\n` : '', indexDroppedLines: claudeDirUsable ? base.indexDroppedLines : 0,
    ...(supplementalFile ? { supplementalIndex: { file: supplementalFile, text: `${SUPPLEMENTAL_MARKER}\n${supplemental.join('\n')}\n` } } : {}),
    generated,
  };
}

/** 계획대로 쓴다 — 쓰기·원장 이벤트는 이식 경로(applySeatMemoryImport)와 같다. 원본은 다시 읽지 않는다. */
export function applyOpMemorySeed(plan: OpMemorySeedPlan): SeatMemoryImportSummary {
  assertSeedScope(plan.to, plan.seat);
  return applySeatMemoryImport(plan);
}

/** 생성 요약 — 항목마다 기억 1개 시대가 되어 이름이 수백 개다. CLI 출력 폭발을 막으려
 *  개수 ⊕ 대표(최신 결정·OPS 첫/끝 섹션)만 보여 준다. 호출부(memory-cli)는 join(', ') 만 쓴다. */
export function summarizeOpMemorySeed(plan: OpMemorySeedPlan, applied: boolean): SeatMemoryImportSummary & { generated: string[] } {
  const names = plan.generated.map(g => g.name);
  const sample: string[] = [];
  const opsFirst = names.find(n => n.startsWith('ops-rule-'));
  const opsRuleNames = names.filter((n: string) => n.startsWith('ops-rule-'));
  const opsLast = opsRuleNames.length ? opsRuleNames[opsRuleNames.length - 1] : undefined;
  if (opsFirst) sample.push(opsFirst);
  if (opsLast && opsLast !== opsFirst) sample.push(opsLast);
  if (names.includes('op-decision-latest')) sample.push('op-decision-latest');
  sample.push('landing-knowhow');
  const summary = names.length > 8
    ? [`${names.length}개`, ...sample.filter(s => names.includes(s))]
    : names;
  return { ...summarizeSeatMemoryImport(plan, applied), generated: summary };
}