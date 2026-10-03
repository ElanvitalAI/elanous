import { env } from './env.js';
import type { OutputFormat, OutputTarget, TranscriptStrategy, RouteDecision } from './types.js';

export interface RouterInput {
  intentText: string;
  durationSec?: number;
  only?: string;
  forceFormat?: string;
  forceTarget?: string;
  cloudStt?: boolean;
}

export function decideRoute(input: RouterInput): RouteDecision {
  const text = (input.intentText || '').trim();

  // 1. --only flag (highest priority)
  if (input.only) {
    switch (input.only) {
      case 'transcript':
        return { format: 'transcript', target: 'markdown', transcriptStrategy: 'auto', reason: '--only transcript' };
      case 'metadata':
        return { format: 'metadata', target: 'markdown', transcriptStrategy: 'auto', reason: '--only metadata' };
      case 'summary':
        return { format: 'cards', target: 'markdown', transcriptStrategy: 'auto', reason: '--only summary' };
      default:
        return { format: 'cards', target: 'obsidian', transcriptStrategy: 'auto', reason: `--only ${input.only} (unknown, default)` };
    }
  }

  // 2. --force flags
  let format: OutputFormat = 'cards';
  let target: OutputTarget = 'obsidian';
  let transcriptStrategy: TranscriptStrategy = 'auto';
  const reasons: string[] = [];

  if (input.forceFormat) {
    const valid: OutputFormat[] = ['brief', 'cards', 'detailed', 'study-note', 'transcript', 'metadata'];
    format = valid.includes(input.forceFormat as OutputFormat) ? input.forceFormat as OutputFormat : 'cards';
    reasons.push(`--format ${input.forceFormat}`);
  }
  if (input.forceTarget) {
    const validT: OutputTarget[] = ['obsidian', 'markdown', 'web-html', 'web-deploy', 'pdf'];
    target = validT.includes(input.forceTarget as OutputTarget) ? input.forceTarget as OutputTarget : 'obsidian';
    reasons.push(`--target ${input.forceTarget}`);
  }
  if (input.cloudStt) {
    transcriptStrategy = 'cloud-stt';
    reasons.push('--cloud-stt');
  }
  if (reasons.length) {
    return { format, target, transcriptStrategy, reason: reasons.join(', ') };
  }

  // 3. Intent-based parsing

  // Format detection
  if (/자막만|transcript만|get\s?transcript/i.test(text)) {
    format = 'transcript';
    reasons.push('자막 추출 의도');
  } else if (/메타데이터|metadata/i.test(text)) {
    format = 'metadata';
    reasons.push('메타데이터 의도');
  } else if (/노트|학습\s?노트|study\s?note|learning\s?note|lecture\s?note|정리해\s?줘|노트로\s?정리/i.test(text)) {
    format = 'study-note';
    reasons.push('학습노트 의도');
  } else if (/상세|자세히|깊게|detailed|분석|심층/i.test(text)) {
    format = 'detailed';
    reasons.push('상세 요약 의도');
  } else if (/간단히|짧게|요약만|brief|빠르게/i.test(text)) {
    format = 'brief';
    reasons.push('간략 요약 의도');
  } else {
    format = 'cards';
    reasons.push('기본 카드형 요약');
  }

  // Target detection
  if (/ccv웹/i.test(text)) {
    target = 'web-deploy';
    reasons.push('ccv웹 배포 의도');
  } else if (/cc웹|웹으로|웹페이지/i.test(text)) {
    target = 'web-html';
    reasons.push('cc웹 HTML 의도');
  } else if (/pdf|PDF로/i.test(text)) {
    target = 'pdf';
    reasons.push('PDF 의도');
  } else if (/markdown|md로/i.test(text)) {
    target = 'markdown';
    reasons.push('마크다운 출력');
  } else if (format === 'transcript' || format === 'metadata') {
    target = 'markdown';
    reasons.push('추출 형식 → 기본 markdown');
  } else {
    target = 'obsidian';
  }

  // Transcript strategy
  if (/자막\s?강화|전사\s?강화|음성\s?인식|stt|whisper|elevenlabs|일레븐랩스/i.test(text)) {
    transcriptStrategy = 'cloud-stt';
    reasons.push('자막 강화 요청');
  } else {
    const longThreshold = Number(env('YOUTUBE_MASTER_LONG_VIDEO_SECONDS', '3600'));
    if (input.durationSec && input.durationSec >= longThreshold) {
      transcriptStrategy = 'cloud-stt';
      reasons.push(`긴 영상 (${input.durationSec}s >= ${longThreshold}s)`);
    }
  }

  return { format, target, transcriptStrategy, reason: reasons.join(', ') };
}
