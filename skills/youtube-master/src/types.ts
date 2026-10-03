/* ── Output axes ── */

export type OutputFormat =
  | 'brief'       // 서머리 요약
  | 'cards'       // 상세 카드별 요약 (기본)
  | 'detailed'    // 상세 요약
  | 'study-note'  // 학습노트
  | 'transcript'  // 자막 원문만
  | 'metadata';   // 메타데이터 JSON만

export type OutputTarget =
  | 'obsidian'    // Obsidian vault .md 저장 (기본)
  | 'markdown'    // stdout / 로컬 .md
  | 'web-html'    // content-to-web 연계 (HTML만)
  | 'web-deploy'  // content-to-web 연계 (배포)
  | 'pdf';        // PDF 생성

export type TranscriptStrategy = 'auto' | 'cloud-stt';

/* ── Route decision ── */

export interface RouteDecision {
  format: OutputFormat;
  target: OutputTarget;
  transcriptStrategy: TranscriptStrategy;
  reason: string;
}

/* ── Video metadata ── */

export interface VideoMeta {
  title: string;
  channel: string;
  description: string;
  uploaded: string;
  duration: string;        // 사람이 읽는 형태 (e.g. "1시간 23분")
  durationSec: number;
  durationIso: string;     // ISO 8601 원본
  views: number;
  likes: number;
}

/* ── STT ── */

export type SttEngine = 'elevenlabs' | 'openai' | 'gemini';

export interface TranscribeResult {
  transcript: string;
  chunkTexts: string[];
  engine: SttEngine;
}

/* ── Artifacts ── */

export interface ArtifactInfo {
  runDir: string;
  audioFile: string;
  chunkFiles: string[];
  transcriptFile: string;
  sttEngine: SttEngine;
}

/* ── Summarize ── */

export interface SummaryConfig {
  transcript: string;
  title: string;
  channel: string;
  videoUrl: string;
  format: 'brief' | 'cards' | 'detailed';
}

/* ── Transcript segment (Supadata) ── */

export interface TranscriptSegment {
  text: string;
  offset: number;       // seconds
  duration: number;
}

/* ── Pipeline result ── */

export interface PipelineResult {
  markdown: string;
  savedPath: string | null;
  route: RouteDecision;
  meta: VideoMeta | null;
  artifacts: ArtifactInfo | null;
  webDeploy: 'html-only' | 'deploy' | null;
  pdfRequested: boolean;
}
