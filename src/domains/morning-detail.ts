// ── 종합 아침 브리핑 · 상세 리포트 조립 + S3 이중 업로드 (2026-07-10) ────────────
//
// 대표 지시: "S3 에 상세 리포트를 쌓아두고, 디테일은 업로드 후 주소를 준다. 단 markdown
// 본문도 같이 쌓는다." 텔레그램엔 에센셜만, 풀 디테일(모든 테이블·근거·인과·버즈·회고)은
// markdown 으로 조립 → md 그대로 + HTML 렌더 둘 다 S3 date-키로 적재하고 링크만 반환.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { s3ElanousKey, s3PublicUrl, uploadText, isS3Available } from '../storage/s3.js';
import { renderHtmlPage } from './md-to-html.js';
import { renderSemisDetail } from './kg-semis.js';
import { marketClock } from './finance.js';
import { feedBySource } from './morning-synthesis.js';
import type { MorningSources } from './morning-synthesis.js';
import type { SignalDetection } from './signal-board.js';

export interface MorningRlaScorecard {
  readonly schema: 'elanous.rla-event-response-scorecard.v1';
  readonly label: string;
  readonly releaseVersion: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly source: {
    readonly knowledgePackIncidentCount: number;
    readonly unclassifiedKnowledgePackIncidentIds: readonly string[];
    readonly releaseSimRigCaseCount: number;
    readonly unclassifiedReleaseSimRigCaseIds: readonly string[];
  };
  readonly timing: 'unmeasured';
  readonly liveReleaseMeasurement: false;
  readonly scores: readonly {
    readonly eventId: string;
    readonly name: string;
    readonly sampleCount: number;
    readonly plannedCount: number;
    readonly unsupportedCount: number;
    readonly score: number;
    readonly measurement: 'shadow-plan-coverage' | 'no-matching-inputs';
  }[];
}

function isMorningRlaScorecard(value: unknown): value is MorningRlaScorecard {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<MorningRlaScorecard>;
  return report.schema === 'elanous.rla-event-response-scorecard.v1'
    && typeof report.label === 'string' && typeof report.releaseVersion === 'string'
    && typeof report.runId === 'string' && typeof report.generatedAt === 'string'
    && Number.isFinite(Date.parse(report.generatedAt))
    && report.timing === 'unmeasured' && report.liveReleaseMeasurement === false
    && Number.isSafeInteger(report.source?.knowledgePackIncidentCount)
    && Number.isSafeInteger(report.source?.releaseSimRigCaseCount)
    && Array.isArray(report.source?.unclassifiedKnowledgePackIncidentIds)
    && Array.isArray(report.source?.unclassifiedReleaseSimRigCaseIds)
    && Array.isArray(report.scores) && report.scores.length === 10
    && report.scores.every((score) => score && typeof score.eventId === 'string' && typeof score.name === 'string'
      && Number.isSafeInteger(score.sampleCount) && Number.isSafeInteger(score.plannedCount)
      && Number.isSafeInteger(score.unsupportedCount) && Number.isFinite(score.score)
      && score.score >= 0 && score.score <= 100
      && (score.measurement === 'shadow-plan-coverage' || score.measurement === 'no-matching-inputs'));
}

/** Most recent per-release shadow scorecard; invalid or partially-written records are ignored. */
export function readLatestMorningRlaScorecard(releaseRoot = join(elanousStateRoot(), 'release')): MorningRlaScorecard | null {
  if (!existsSync(releaseRoot)) return null;
  const reports: MorningRlaScorecard[] = [];
  try {
    for (const entry of readdirSync(releaseRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(releaseRoot, entry.name, 'scorecard.json'), 'utf8'));
        if (isMorningRlaScorecard(parsed)) reports.push(parsed);
      } catch { /* absent or incomplete release scorecard */ }
    }
  } catch { return null; }
  return reports.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))[0] ?? null;
}

export function renderRlaScorecardSection(report: MorningRlaScorecard): string {
  const rows = report.scores.map((score) =>
    `| ${score.eventId} ${score.name.replaceAll('|', '\\|')} | ${score.sampleCount} | ${score.plannedCount} | ${score.unsupportedCount} | ${score.measurement === 'no-matching-inputs' ? '미측정(표본 없음)' : `${score.score}%`} |`).join('\n');
  const unclassified = report.source.unclassifiedKnowledgePackIncidentIds.length + report.source.unclassifiedReleaseSimRigCaseIds.length;
  return `## 🧪 ${report.label}\n\n_판 ${report.releaseVersion} · run ${report.runId} · 노하우팩 ${report.source.knowledgePackIncidentCount}건 · release-sim-rig ${report.source.releaseSimRigCaseCount}종 · 분류 대기 ${unclassified}건(계획 결과는 JSON에 보존) · 생성 ${report.generatedAt} · 시간/실발행 결과는 미측정_\n\n| 사건 | 입력 수 | 계획 가능 | 처방 불가 | 점수(계획 가능 비율) |\n|---|---:|---:|---:|---:|\n${rows}`;
}

/** 코드펜스로 감싼 monospace 블록(sqlite -column 정렬 보존). 빈 문자열이면 ''. */
function fenced(label: string, table: string): string {
  const t = (table || '').trim();
  return t ? `## ${label}\n\n\`\`\`\n${t}\n\`\`\`` : '';
}

/** SignalDetection 목록 → 불릿(제목 + 부연). */
function bullets(rows: SignalDetection[], max: number): string {
  return rows.slice(0, max).map(d => {
    const link = d.link ? ` ([링크](${d.link}))` : '';
    return `- **${d.title}**${d.detail ? ` — ${d.detail}` : ''}${link}`;
  }).join('\n');
}

/** 밤사이 소스 번들 → 풀 디테일 Markdown. */
export function assembleDetailMarkdown(src: MorningSources, rlaScorecard?: MorningRlaScorecard | null): string {
  const { buzz, dig, signal, reflection } = feedBySource(src.board);
  const parts: string[] = [
    `# 🌅 Conatus 상세 아침 브리핑 — ${src.dateKr}`,
    `_${marketClock()}_`,
  ];

  // 국면
  if (src.regimeSummary) parts.push(`## 🧭 국면\n\n${src.regimeSummary.trim()}`);
  if (src.regimeRipple) parts.push(src.regimeRipple.trim());

  // 매크로
  if (src.macro) parts.push(`## 📈 매크로 핵심\n\n${src.macro.trim()}`);

  // 반도체 밸류체인(대표 관심사·1급)
  const semis = renderSemisDetail(src.semis);
  if (semis) parts.push(semis);

  // 미국장(us-pulse 06:35 결산)
  if (src.usPulse) parts.push(`## 🇺🇸 미국장 (${src.usPulse.date} 결산)\n\n${src.usPulse.report.trim()}`);

  // S&P 히트맵 텍스트
  if (src.finviz) parts.push(`## 🗺️ S&P 히트맵\n\n${src.finviz.trim()}`);

  // 정량 테이블(정렬 보존)
  parts.push(fenced('📊 시장 Backbone', src.backbone));
  parts.push(fenced('🔄 자산군 회전', src.rotation));
  parts.push(fenced('🌍 국가 매력도', src.country));
  parts.push(fenced('🏭 섹터 로테이션', src.sector));
  parts.push(fenced('🤝 13F 기관 컨센서스', src.movers13f));

  // 센티-실측 괴리
  if (src.dislocation) parts.push(`## ⚠️ 센티-실측 괴리\n\n${src.dislocation.trim()}`);

  // 커뮤니티 버즈
  if (buzz.length) parts.push(`## 💬 커뮤니티 버즈\n\n${bullets(buzz, 12)}`);

  // 디깅 + 신호
  if (dig.length) parts.push(`## 🔎 디깅 리포트\n\n${bullets(dig, 8)}`);
  if (signal.length) parts.push(`## 📟 신호 타임라인\n\n${bullets(signal, 12)}`);

  // 밤샘 회고/기억 루프
  if (reflection.length) parts.push(`## 🧠 회고·기억 루프\n\n${bullets(reflection, 8)}`);

  if (rlaScorecard) parts.push(renderRlaScorecardSection(rlaScorecard));

  parts.push('\n---\n_출처: elanous finance 종합 (밤사이 자율 루프 산출물 종합). 매매는 verify+HITL._');

  return parts.filter(Boolean).join('\n\n');
}

export interface UploadedReport { mdUrl: string; htmlUrl: string }

/** 상세 리포트를 S3 에 md + html 이중 적재(date-키). S3 불가 시 null(fail-soft·에센셜만 발송). */
export function uploadMorningReport(date: string, md: string, opts: { imageUrl?: string; title?: string } = {}): UploadedReport | null {
  if (!isS3Available()) return null;
  try {
    const title = opts.title ?? `Conatus 상세 아침 브리핑 — ${date}`;
    const html = renderHtmlPage({ title, subtitle: marketClock(), bodyMd: md, imageUrl: opts.imageUrl });
    const mdKey = s3ElanousKey('morning', `${date}.md`);
    const htmlKey = s3ElanousKey('morning', `${date}.html`);
    uploadText(md, mdKey, 'text/markdown; charset=utf-8');
    uploadText(html, htmlKey, 'text/html; charset=utf-8');
    return { mdUrl: s3PublicUrl(mdKey), htmlUrl: s3PublicUrl(htmlKey) };
  } catch { return null; }
}
