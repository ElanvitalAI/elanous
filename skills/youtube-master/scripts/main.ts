#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initEnv, env } from '../src/env.js';
import { extractVideoId, fetchYoutubeMeta, formatTime } from '../src/youtube.js';
import { fetchSupadataTranscript, judgeTranscriptSufficiency } from '../src/transcript.js';
import { downloadAudio, splitAudio } from '../src/audio.js';
import { transcribeChunks } from '../src/stt.js';
import { summarize, parseMetaFromSummary } from '../src/summarize.js';
import { getSaveDir, saveMarkdown, prepareRunDir, persistArtifacts } from '../src/obsidian.js';
import { classifyDomain, stagingEnabled, stagingSubdir } from '../src/domain-staging.js';
import { buildStudyNote } from '../src/study-note.js';
import { decideRoute } from '../src/router.js';
import type { VideoMeta, ArtifactInfo, RouteDecision, TranscriptSegment, OutputFormat } from '../src/types.js';

// ── Init ──

initEnv();

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    message:          { type: 'string', short: 'm' },
    intent:           { type: 'string' },
    only:             { type: 'string' },
    format:           { type: 'string' },
    target:           { type: 'string' },
    'cloud-stt':      { type: 'boolean', default: false },
    'transcript-file': { type: 'string' },
    print:            { type: 'boolean', default: false },
    'dry-run':        { type: 'boolean', default: false },
    'no-obsidian':    { type: 'boolean', default: false },
    'output-dir':     { type: 'string' },
    'self-test':      { type: 'boolean', default: false },
    help:             { type: 'boolean', short: 'h', default: false },
  },
});

if (flags.help) {
  printHelp();
  process.exit(0);
}

if (flags['self-test']) {
  runSelfTest();
  process.exit(0);
}

const videoUrl = positionals[0];
if (!videoUrl) {
  console.error('Error: YouTube URL을 입력해주세요.');
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

// ── Main pipeline ──

async function main() {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    throw new Error('유효하지 않은 YouTube URL입니다.');
  }

  const intentText = [flags.intent, flags.message, ...positionals.slice(1)].filter(Boolean).join(' ').trim();

  // Fetch metadata (needed for routing and output)
  let meta: VideoMeta | null = null;
  try {
    console.log('  메타데이터 조회...');
    meta = await fetchYoutubeMeta(videoId);
    console.log(`  ${meta.title} (${meta.channel}, ${meta.duration})`);
  } catch (e: any) {
    console.log(`  메타데이터 조회 실패: ${e.message}`);
  }

  // Route decision
  const route = decideRoute({
    intentText,
    durationSec: meta?.durationSec,
    only: flags.only,
    forceFormat: flags.format,
    forceTarget: flags['no-obsidian'] ? 'markdown' : flags.target,
    cloudStt: flags['cloud-stt'],
  });

  console.log(`  라우트: format=${route.format}, target=${route.target}, transcript=${route.transcriptStrategy}`);
  console.log(`  이유: ${route.reason}`);

  if (flags['dry-run']) {
    console.log(JSON.stringify({ route, videoId, title: meta?.title, durationSec: meta?.durationSec }, null, 2));
    return;
  }

  // ── Dispatch by format ──

  if (route.format === 'metadata') {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  if (route.format === 'transcript') {
    const transcript = await acquireTranscript(videoUrl, meta, route, videoId);
    if (flags.print) {
      console.log('\n---BEGIN_YOUTUBE_MASTER_MARKDOWN---\n');
      console.log(transcript);
      console.log('\n---END_YOUTUBE_MASTER_MARKDOWN---\n');
    } else {
      console.log(transcript);
    }
    return;
  }

  // Summary formats: brief, cards, detailed, study-note
  const summaryFormat: 'brief' | 'cards' | 'detailed' =
    route.format === 'study-note' ? 'cards' :
    (['brief', 'cards', 'detailed'].includes(route.format) ? route.format as 'brief' | 'cards' | 'detailed' : 'cards');

  // Acquire transcript
  const transcript = await acquireTranscript(videoUrl, meta, route, videoId);

  // Build timeline hint (for cards/detailed)
  let timelineHint = '';
  if (summaryFormat !== 'brief' && (globalSegments?.length ?? 0) > 0) {
    const interval = 30;
    let nextMark = 0;
    const samples: string[] = [];
    for (const seg of globalSegments!) {
      if (seg.offset >= nextMark) {
        const secs = Math.floor(seg.offset);
        samples.push(`[${formatTime(seg.offset)}](https://www.youtube.com/watch?v=${videoId}&t=${secs}s) ${seg.text}`);
        nextMark = seg.offset + interval;
      }
    }
    timelineHint = samples.join('\n');
  }

  // Summarize
  console.log('  요약 생성 중...');
  const started = Date.now();
  const rawSummary = await summarize({
    transcript,
    meta: {
      title: meta?.title || 'Untitled',
      channel: meta?.channel || 'Unknown',
      videoUrl,
    },
    format: summaryFormat,
    timelineHint,
    useCloudSttPrompt: usedCloudStt,
  });
  console.log(`  요약 완료 (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const { genre, keywords, body: summaryBody } = parseMetaFromSummary(rawSummary);

  // Study note post-processing
  if (route.format === 'study-note') {
    console.log('  학습노트 생성 중...');
    const result = buildStudyNote({
      summaryBody,
      url: videoUrl,
      videoId,
      meta,
      transcriptStrategy: route.transcriptStrategy,
      backendFilePath: null,
    });
    if (result.filePath) {
      console.log(`  학습노트 저장: ${result.filePath}`);
    }
    if (flags.print) {
      console.log('\n---BEGIN_YOUTUBE_MASTER_MARKDOWN---\n');
      console.log(result.markdown);
      console.log('\n---END_YOUTUBE_MASTER_MARKDOWN---\n');
    }
    outputSignals(route);
    return;
  }

  // Save markdown — 도메인 스테이징 라우팅(00. Inbox/_staging/<domain>/·토글 OBSIDIAN_STAGING_BY_DOMAIN)
  const domain = classifyDomain([genre, ...keywords, meta?.title, meta?.channel]);
  const stagingSub = stagingEnabled() ? stagingSubdir(domain) : undefined;
  const saveDir = flags['output-dir'] || getSaveDir(stagingSub);
  let savedPath: string | null = null;
  if (saveDir && route.target !== 'markdown') {
    savedPath = await saveMarkdown({
      meta: meta || { title: 'Untitled', channel: 'Unknown', description: '', uploaded: '', duration: 'N/A', durationSec: 0, durationIso: '', views: 0, likes: 0 },
      videoUrl,
      videoId,
      summaryBody,
      genre,
      keywords,
      saveDir,
      domain,
      artifacts: globalArtifacts || undefined,
      cloudStt: usedCloudStt,
    });
    console.log(`  저장 완료: ${savedPath}`);
  }

  if (flags.print) {
    console.log('\n---BEGIN_YOUTUBE_MASTER_MARKDOWN---\n');
    console.log(summaryBody);
    console.log('\n---END_YOUTUBE_MASTER_MARKDOWN---\n');
  }

  outputSignals(route);
}

// ── Transcript acquisition (auto-fallback) ──

let globalSegments: TranscriptSegment[] | null = null;
let usedCloudStt = false;
let globalArtifacts: ArtifactInfo | null = null;

async function acquireTranscript(
  url: string,
  meta: VideoMeta | null,
  route: RouteDecision,
  videoId: string,
): Promise<string> {
  // Pre-supplied transcript
  if (flags['transcript-file']) {
    console.log(`  제공된 자막 파일 사용: ${flags['transcript-file']}`);
    return (await readFile(flags['transcript-file'], 'utf-8')).trim();
  }

  // Force Cloud STT
  if (route.transcriptStrategy === 'cloud-stt') {
    return acquireCloudSttTranscript(url, meta, videoId);
  }

  // Auto: try Supadata first
  console.log('  [1/3] Supadata 자막 조회...');
  const supadataStart = Date.now();
  const result = await fetchSupadataTranscript(url);
  const supadataElapsed = ((Date.now() - supadataStart) / 1000).toFixed(1);
  if (result.text && result.text.trim().length > 0) {
    globalSegments = result.segments;
    const sufficiency = judgeTranscriptSufficiency(result.text, meta?.durationSec || 0);
    if (sufficiency.sufficient) {
      console.log(`  [1/3] Supadata 성공 (${supadataElapsed}s, ${result.text.length.toLocaleString()}자, ${result.segments.length}세그먼트)`);
      return result.text;
    }
    console.log(`  [1/3] Supadata 부족 (${supadataElapsed}s): ${sufficiency.reason}`);
  } else {
    console.log(`  [1/3] Supadata 실패 (${supadataElapsed}s) — 자막 없음`);
  }

  // Fallback: description or Cloud STT
  if (meta?.description && meta.description.length > 500) {
    const hasCloudSttKeys = !!(env('ELEVENLABS_API_KEY') || env('XI_API_KEY') || env('OPENAI_API_KEY') || env('GEMINI_API_KEY') || env('GOOGLE_API_KEY'));
    if (hasCloudSttKeys) {
      console.log('  [2/3] Cloud STT 폴백 결정 (Supadata 실패 + STT 키 보유)');
      return acquireCloudSttTranscript(url, meta, videoId);
    }
    console.log(`  [2/3] 영상 설명으로 대체 (${meta.description.length.toLocaleString()}자, STT 키 없음)`);
    return meta.description;
  }

  // Last resort: Cloud STT
  console.log('  [2/3] Cloud STT 최후 시도 (설명 부족 또는 없음)');
  return acquireCloudSttTranscript(url, meta, videoId);
}

async function acquireCloudSttTranscript(url: string, meta: VideoMeta | null, videoId: string): Promise<string> {
  usedCloudStt = true;
  const segmentMinutes = Number(env('WHISPER_SEGMENT_MINUTES', '25'));
  const segmentSeconds = segmentMinutes * 60;
  const sttStart = Date.now();

  const tmpDir = await mkdtemp(join(tmpdir(), 'yt-master-'));
  try {
    console.log('  [3/3] Cloud STT 시작...');
    console.log('  [3/3] 오디오 다운로드...');
    const dlStart = Date.now();
    const audioPath = await downloadAudio(url, tmpDir);
    console.log(`  [3/3] 오디오 다운로드 완료 (${((Date.now() - dlStart) / 1000).toFixed(1)}s)`);

    console.log('  [3/3] 오디오 분할...');
    const chunks = await splitAudio(audioPath, tmpDir, segmentSeconds);

    console.log(`  [3/3] Cloud STT 전사 (${chunks.length}청크)...`);
    const sttTranscribeStart = Date.now();
    const result = await transcribeChunks(chunks);
    console.log(`  [3/3] Cloud STT 전사 완료 (${((Date.now() - sttTranscribeStart) / 1000).toFixed(1)}s, ${result.transcript.length.toLocaleString()}자, 엔진: ${result.engine})`);

    // Persist artifacts if Obsidian is configured
    const saveDir = getSaveDir();
    if (saveDir && meta) {
      const runDir = await prepareRunDir(saveDir, meta, videoId);
      globalArtifacts = await persistArtifacts(
        runDir, meta, url, audioPath, chunks,
        result.transcript, result.chunkTexts, result.engine,
      );
      console.log(`  아티팩트 저장: ${runDir}`);
    }

    return result.transcript;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Output signals ──

function outputSignals(route: RouteDecision) {
  if (route.target === 'web-html') {
    console.log('\n---SIGNAL: webDeploy=html-only---');
  } else if (route.target === 'web-deploy') {
    console.log('\n---SIGNAL: webDeploy=deploy---');
  } else if (route.target === 'pdf') {
    console.log('\n---SIGNAL: pdfRequested=true---');
  }
}

// ── Self-test ──

function runSelfTest() {
  console.log('=== youtube-master self-test ===\n');

  const cases = [
    { text: '', expect: { format: 'cards', target: 'obsidian', ts: 'auto' } },
    { text: '요약', expect: { format: 'cards', target: 'obsidian', ts: 'auto' } },
    { text: '짧게 요약', expect: { format: 'brief', target: 'obsidian', ts: 'auto' } },
    { text: '상세 분석', expect: { format: 'detailed', target: 'obsidian', ts: 'auto' } },
    { text: '학습노트로 정리해줘', expect: { format: 'study-note', target: 'obsidian', ts: 'auto' } },
    { text: '자막만 뽑아줘', expect: { format: 'transcript', target: 'markdown', ts: 'auto' } },
    { text: '자막 강화해서 요약', expect: { format: 'cards', target: 'obsidian', ts: 'cloud-stt' } },
    { text: '일레븐랩스로 전사 강화', expect: { format: 'cards', target: 'obsidian', ts: 'cloud-stt' } },
    { text: 'cc웹', expect: { format: 'cards', target: 'web-html', ts: 'auto' } },
    { text: 'ccv웹', expect: { format: 'cards', target: 'web-deploy', ts: 'auto' } },
    { text: 'pdf로 저장', expect: { format: 'cards', target: 'pdf', ts: 'auto' } },
    { text: 'markdown으로', expect: { format: 'cards', target: 'markdown', ts: 'auto' } },
    { text: '노트 + 자막 강화', expect: { format: 'study-note', target: 'obsidian', ts: 'cloud-stt' } },
    { text: '간단히 정리 pdf', expect: { format: 'brief', target: 'pdf', ts: 'auto' } },
    { text: '메타데이터', expect: { format: 'metadata', target: 'markdown', ts: 'auto' } },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const result = decideRoute({ intentText: tc.text });
    const ok = result.format === tc.expect.format
      && result.target === tc.expect.target
      && result.transcriptStrategy === tc.expect.ts;

    if (ok) {
      console.log(`  PASS: "${tc.text || '(empty)'}" → ${result.format}/${result.target}/${result.transcriptStrategy}`);
      passed++;
    } else {
      console.log(`  FAIL: "${tc.text || '(empty)'}"`);
      console.log(`    expect: ${tc.expect.format}/${tc.expect.target}/${tc.expect.ts}`);
      console.log(`    got:    ${result.format}/${result.target}/${result.transcriptStrategy}`);
      failed++;
    }
  }

  // --only tests
  const onlyCases = [
    { only: 'transcript', expect: 'transcript' },
    { only: 'metadata', expect: 'metadata' },
  ];
  for (const tc of onlyCases) {
    const result = decideRoute({ intentText: '', only: tc.only });
    if (result.format === tc.expect) {
      console.log(`  PASS: --only ${tc.only} → ${result.format}`);
      passed++;
    } else {
      console.log(`  FAIL: --only ${tc.only} → expected ${tc.expect}, got ${result.format}`);
      failed++;
    }
  }

  // Long video test
  const longResult = decideRoute({ intentText: '요약', durationSec: 4000 });
  if (longResult.transcriptStrategy === 'cloud-stt') {
    console.log(`  PASS: 긴 영상 (4000s) → cloud-stt`);
    passed++;
  } else {
    console.log(`  FAIL: 긴 영상 (4000s) → expected cloud-stt, got ${longResult.transcriptStrategy}`);
    failed++;
  }

  console.log(`\n결과: ${passed} passed, ${failed} failed`);

  // Dependency checks
  console.log('\n--- 의존성 체크 ---');
  const checks: Array<[string, () => boolean]> = [
    ['YOUTUBE_API_KEY', () => !!env('YOUTUBE_API_KEY')],
    ['SUPADATA_API_KEY', () => !!env('SUPADATA_API_KEY')],
    ['XAI_API_KEY', () => !!env('XAI_API_KEY')],
    ['OBSIDIAN_VAULT_ROOT', () => !!env('OBSIDIAN_VAULT_ROOT')],
    ['OPENAI_API_KEY (선택)', () => !!env('OPENAI_API_KEY')],
    ['ELEVENLABS_API_KEY (선택)', () => !!(env('ELEVENLABS_API_KEY') || env('XI_API_KEY'))],
  ];

  for (const [name, check] of checks) {
    console.log(`  ${check() ? 'OK' : 'MISSING'}: ${name}`);
  }

  if (failed > 0) process.exit(1);
}

// ── Help ──

function printHelp() {
  console.log(`
youtube-master — 통합 YouTube 처리 스킬

사용법:
  npx tsx scripts/main.ts <URL> [OPTIONS]

옵션:
  --message, -m <text>     사용자 의도 (자동 라우팅)
  --only <sub>             부분 실행: transcript, metadata
  --format <fmt>           출력 형식: brief, cards, detailed, study-note
  --target <tgt>           출력 타겟: obsidian, markdown, web, pdf
  --cloud-stt              Cloud STT 강제
  --transcript-file <path> 기존 자막 파일 공급
  --print                  결과 stdout 출력
  --dry-run                라우팅 결정만 출력
  --no-obsidian            Obsidian 저장 생략
  --output-dir <path>      저장 디렉토리 오버라이드
  --self-test              라우팅 테스트
  --help, -h               도움말
`);
}
