#!/usr/bin/env bun
import { absorbTweetVisuals } from '../src/visual.js';
import { parseArgs } from 'node:util';
import { initEnv } from '../src/env.js';
import { detectSource, sourceLabel } from '../src/detect.js';
import { decideRoute } from '../src/router.js';
import { delegateYouTube } from '../src/delegate.js';
import { fetchTweetMeta, fetchReplies, extractLinks, extractXInternalUrls, isXInternalUrl, fetchArticleContent, looksLikeOnlyUrls, guessHeadingFromSummary, insertRefLinksAfterToc } from '../src/x-api.js';
import { summarizeXPost, summarizeXArticle, summarizeGeneric, parseMetaFromSummary } from '../src/summarize.js';
import { fetchWebContent, fetchGitHubRepo, fetchGitHubPR, fetchGitHubIssue, fetchGitHubCommit, fetchLocalFile, summarizeFullWithCli, enrichWithOmniCrawl } from '../src/fetch.js';
import { getSaveDir, saveMarkdown } from '../src/obsidian.js';
import { appendDiagramToMarkdown, wantsDiagram } from '../src/diagram.js';
import { transcribeTweetMedia, transcriptAppendix } from '../src/media.js';
import type { DetectedSource, RouteDecision, OutputTarget, DigestResult } from '../src/types.js';

initEnv();

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    message:      { type: 'string', short: 'm' },
    format:       { type: 'string' },
    target:       { type: 'string' },
    print:        { type: 'boolean', default: false },
    'dry-run':    { type: 'boolean', default: false },
    'no-obsidian': { type: 'boolean', default: false },
    'output-dir': { type: 'string' },
    content:      { type: 'string' },
    diagram:      { type: 'boolean', default: false },
    'no-media':   { type: 'boolean', default: false },
    'media-lang': { type: 'string' },
    'self-test':  { type: 'boolean', default: false },
    help:         { type: 'boolean', short: 'h', default: false },
  },
});

if (flags.help) { printHelp(); process.exit(0); }
if (flags['self-test']) { runSelfTest(); process.exit(0); }

const input = positionals[0];
if (!input) { console.error('Error: 입력(URL/파일)을 제공해주세요.'); printHelp(); process.exit(1); }

main().catch(err => { console.error(`Error: ${err.message}`); process.exit(1); });

async function main() {
  const source = detectSource(input);
  const intentText = [flags.message, ...positionals.slice(1)].filter(Boolean).join(' ').trim();
  const route = decideRoute({ intentText, forceFormat: flags.format, forceTargets: flags['no-obsidian'] ? 'markdown' : flags.target });
  const addDiagram = flags.diagram || wantsDiagram(intentText);

  console.log('━'.repeat(60));
  console.log('OmniDigest');
  console.log('━'.repeat(60));
  console.log(`입력: ${input}\n소스: ${sourceLabel(source.type)}\n포맷: ${route.format}\n타겟: ${route.targets.join(', ')}${route.summarizeFull ? '\n모드: sum full (summarize CLI end-to-end)' : route.useSummarize ? '\n추출: summarize CLI 우선' : ''}${route.enrichWithCrawl === 'force' ? '\n보강: omni-crawl (명시 요청)' : '\n보강: smart (자동 판단)'}${addDiagram ? '\n다이어그램: 포함' : ''}\n이유: ${route.reason}\n`);

  if (flags['dry-run']) { console.log(JSON.stringify({ source, route, diagram: addDiagram }, null, 2)); return; }

  let result: DigestResult;
  switch (source.type) {
    case 'x-post':     result = await digestXPost(source, route, addDiagram); break;
    case 'x-article':  result = await digestXArticle(source, route, addDiagram); break;
    case 'youtube':
      if (route.useSummarize) { result = await digestYouTubeViaSummarize(source, route, addDiagram); break; }
      result = await digestYouTube(source, route, intentText); break;
    case 'web':
      if (route.summarizeFull) { result = await digestSummarizeFull(source, route, addDiagram); break; }
      result = await digestGeneric(source, route, addDiagram, () => fetchWebContent(source.input, route.useSummarize)); break;
    case 'github-repo':   result = await digestGeneric(source, route, addDiagram, () => Promise.resolve(fetchGitHubRepo(source.owner!, source.repo!))); break;
    case 'github-pr':     result = await digestGeneric(source, route, addDiagram, () => Promise.resolve(fetchGitHubPR(source.owner!, source.repo!, source.ref!))); break;
    case 'github-issue':  result = await digestGeneric(source, route, addDiagram, () => Promise.resolve(fetchGitHubIssue(source.owner!, source.repo!, source.ref!))); break;
    case 'github-commit': result = await digestGeneric(source, route, addDiagram, () => Promise.resolve(fetchGitHubCommit(source.owner!, source.repo!, source.ref!))); break;
    case 'local-file':    result = await digestLocalFile(source, route, addDiagram); break;
    default: throw new Error(`지원하지 않는 입력: ${input}`);
  }

  console.log('━'.repeat(60));
  for (const p of result.savedPaths) console.log(`저장: ${p}`);
  if (flags.print && result.markdown) { console.log('\n---BEGIN_OMNI_DIGEST_MARKDOWN---\n'); console.log(result.markdown); console.log('\n---END_OMNI_DIGEST_MARKDOWN---\n'); }
  for (const s of result.signals) console.log(`\n${s}`);
  console.log('━'.repeat(60));
}

// ── X Post (absorbed) ──

async function digestXPost(source: DetectedSource, route: RouteDecision, addDiagram: boolean): Promise<DigestResult> {
  console.log('[X Post] 메타데이터 수집...');
  const meta = await fetchTweetMeta(source.tweetId!);
  console.log(`  ${meta.author} | ${meta.createdAt} | Likes: ${meta.likeCount}\n`);

  console.log('  댓글 & 링크 수집...');
  const [links, replies] = await Promise.all([extractLinks(meta.text), fetchReplies(meta.conversationId)]);
  const xInternal = extractXInternalUrls(meta.text);
  const allRefLinks = [...new Set([...links, ...xInternal])];
  const videoCount = meta.media.filter(m => m.type === 'video' || m.type === 'animated_gif').length;
  console.log(`  댓글 ${replies.length}개, 링크 ${allRefLinks.length}개${meta.isLongform ? ', 장문(note_tweet) 전문 확보' : ''}${videoCount ? `, 영상 ${videoCount}개` : ''}\n`);

  // 첨부 영상 STT — 기본 자동(영상 있으면 전사), --no-media 로 비활성
  let mediaAppendix = '';
  if (videoCount > 0 && !flags['no-media']) {
    console.log('  [미디어] 첨부 영상 전사...');
    const t = await transcribeTweetMedia(meta.media, { lang: flags['media-lang'] });
    if (t) {
      meta.mediaTranscript = t.transcript;
      mediaAppendix = `\n\n${transcriptAppendix(t)}`;
    }
    console.log('');
  }

  // 첨부 사진·영상 화면 — 전사는 소리만 본다(말 없는 데모·표 이미지는 전사가 비었다)
  if (meta.media.length > 0 && !flags['no-media']) {
    console.log('  [시각] 첨부 이미지·영상 화면 흡수...');
    const v = await absorbTweetVisuals(meta.media, { tweetId: source.tweetId! });
    if (v) {
      meta.mediaTranscript = [meta.mediaTranscript, v.promptText].filter(Boolean).join('\n\n');
      mediaAppendix += `\n\n${v.markdown}`;
    }
    console.log('');
  }

  console.log('  Grok 요약 생성...');
  const started = Date.now();
  let raw = await summarizeXPost(meta, replies, allRefLinks, route.format);
  console.log(`  완료 (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);

  const { genre, keywords, body } = parseMetaFromSummary(raw);
  let heading = meta.text.replace(/\s+/g, ' ').trim().substring(0, 60) || 'Untitled';
  if (looksLikeOnlyUrls(meta.text)) heading = guessHeadingFromSummary(body, 'X Post');
  // 한글 없이 한자·가나뿐인 원문은 파일 이름에서 글자가 거의 다 빠진다(safeName 은 영숫자·한글만) — 요약의 결론 문장(한국어)을 제목으로(2026-09-27 · `…__Jev_50_laya-mlx…`).
  else if (!/[가-힣]/.test(meta.text) && /[\u3040-\u30ff\u3400-\u9fff]/.test(meta.text)) heading = guessHeadingFromSummary(body, 'X Post');

  const refBlock = allRefLinks.length > 0 ? ['# 참조 링크', ...allRefLinks.map(u => `- ${u}`)].join('\n') : '';
  let finalBody = refBlock ? insertRefLinksAfterToc(body, refBlock) : body;
  if (addDiagram) finalBody = await appendDiagramToMarkdown(finalBody);

  const savedPaths: string[] = [];
  if (route.targets.includes('obsidian')) {
    const dir = flags['output-dir'] || getSaveDir(source.type);
    if (dir) savedPaths.push(await saveMarkdown({
      title: heading, sourceType: source.type, sourceUrl: source.input,
      summaryBody: finalBody, genre, keywords, saveDir: dir,
      extraFrontmatter: `author: "${meta.author}"\nviews: ${meta.metrics.impression_count}\nlikes: ${meta.metrics.like_count}\nretweets: ${meta.metrics.retweet_count}${meta.mediaTranscript ? '\nhas_video_transcript: true' : ''}`,
      appendix: `# 원문\n${meta.text}${mediaAppendix}`,
    }));
  }
  return { markdown: finalBody, title: heading, source, savedPaths, signals: buildSignals(route.targets) };
}

// ── X Article (absorbed) ──

async function digestXArticle(source: DetectedSource, route: RouteDecision, addDiagram: boolean): Promise<DigestResult> {
  console.log('[X Article] Jina Reader로 본문 수집...');
  const content = await fetchArticleContent(source.input);
  console.log(`  ${content.length.toLocaleString()}자\n`);

  console.log('  Grok 요약 생성...');
  const started = Date.now();
  const raw = await summarizeXArticle(content, source.authorHandle!, route.format);
  console.log(`  완료 (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);

  const { genre, keywords, body } = parseMetaFromSummary(raw);
  let heading = 'X Article';
  const em = body.match(/Executive Summary[\s\S]*?[-•]\s*(.+)/);
  if (em) heading = em[1].replace(/[*_`]/g, '').trim().substring(0, 60);
  else for (const l of body.split('\n')) { const c = l.replace(/^#+\s*/, '').trim(); if (c && !/^(Table of Contents|Executive Summary|SCQA)/i.test(c)) { heading = c.substring(0, 60); break; } }

  let finalBody = body;
  if (addDiagram) finalBody = await appendDiagramToMarkdown(finalBody);

  const savedPaths: string[] = [];
  if (route.targets.includes('obsidian')) {
    const dir = flags['output-dir'] || getSaveDir(source.type);
    if (dir) savedPaths.push(await saveMarkdown({
      title: heading, sourceType: source.type, sourceUrl: source.input,
      summaryBody: finalBody, genre, keywords, saveDir: dir,
      extraFrontmatter: `author: "@${source.authorHandle}"\ncontent_type: "article"`,
    }));
  }
  return { markdown: finalBody, title: heading, source, savedPaths, signals: buildSignals(route.targets) };
}

// ── YouTube (delegated) ──

async function digestYouTube(source: DetectedSource, route: RouteDecision, intent: string): Promise<DigestResult> {
  console.log('[YouTube] youtube-master 위임...\n');
  const { markdown, savedPath, fullOutput } = delegateYouTube(source.input, route.format, route.targets, intent);
  const signals = buildSignals(route.targets, fullOutput);
  return { markdown, title: 'YouTube Summary', source, savedPaths: savedPath ? [savedPath] : [], signals };
}

// ── YouTube via summarize CLI (sum 모드) ──

async function digestYouTubeViaSummarize(source: DetectedSource, route: RouteDecision, addDiagram: boolean): Promise<DigestResult> {
  // sum full: summarize CLI가 추출+요약 모두
  if (route.summarizeFull) {
    console.log('[YouTube sum full] summarize CLI end-to-end...\n');
    const result = summarizeFullWithCli(source.input, route.format === 'essential' ? 'medium' : 'xl');
    if (result) return {
      markdown: result.content, title: result.title, source,
      savedPaths: [], signals: buildSignals(route.targets),
    };
    console.log('  sum full 실패, sum 모드로 폴백...\n');
  }

  // sum: summarize --extract로 자막 추출 → Grok 요약
  console.log('[YouTube sum] summarize CLI로 자막 추출...\n');
  const { execSync } = await import('node:child_process');
  try {
    const transcript = execSync(
      `summarize "${source.input}" --extract --format md --lang auto`,
      { encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (transcript.length < 50) throw new Error('자막이 너무 짧음');
    console.log(`  자막 추출 성공 (${transcript.length.toLocaleString()}자)\n`);

    let title = 'YouTube Summary';
    const hm = transcript.match(/^#\s+(.+)$/m);
    if (hm) title = hm[1].trim();

    return await summarizeAndSave(transcript, title, 'YouTube', source, route, addDiagram);
  } catch (e: any) {
    console.log(`  summarize CLI 실패: ${e.message?.split('\n')[0]}`);
    console.log('  youtube-master로 폴백...\n');
    return digestYouTube(source, route, '');
  }
}

// ── Generic (Web, GitHub) ──

async function digestGeneric(
  source: DetectedSource, route: RouteDecision, addDiagram: boolean,
  fetcher: () => Promise<{ title: string; content: string }>,
): Promise<DigestResult> {
  console.log(`[${sourceLabel(source.type)}] 콘텐츠 수집...\n`);
  const { title, content } = await fetcher();
  console.log(`  ${title} (${content.length.toLocaleString()}자)\n`);
  return await summarizeAndSave(content, title, sourceLabel(source.type), source, route, addDiagram);
}

// ── Local file ──

async function digestLocalFile(source: DetectedSource, route: RouteDecision, addDiagram: boolean): Promise<DigestResult> {
  console.log('[File] 로컬 파일 처리...\n');
  if (flags.content) {
    const title = source.input.split('/').pop() || 'Document';
    return await summarizeAndSave(flags.content, title, '문서', source, route, addDiagram);
  }
  const { title, content } = await fetchLocalFile(source.input);
  if (content.startsWith('[')) { console.log(`  ⚠ ${content}`); return { markdown: content, title, source, savedPaths: [], signals: [] }; }
  return await summarizeAndSave(content, title, '문서', source, route, addDiagram);
}

// ── Summarize Full (sum full: summarize CLI end-to-end, Grok 스킵) ──

async function digestSummarizeFull(source: DetectedSource, route: RouteDecision, addDiagram: boolean): Promise<DigestResult> {
  const lengthMap: Record<string, string> = { essential: 'medium', 'rich-cards': 'xl', rich: 'xxl' };
  const length = lengthMap[route.format] || 'xl';

  console.log(`[sum full] summarize CLI end-to-end (length=${length})...\n`);
  const started = Date.now();
  const result = summarizeFullWithCli(source.input, length);
  if (!result) {
    console.log('  sum full 실패, 기본 파이프라인으로 폴백...\n');
    return digestGeneric(source, route, addDiagram, () => fetchWebContent(source.input, true));
  }
  console.log(`  완료 (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);

  let finalBody = result.content;
  if (addDiagram) finalBody = await appendDiagramToMarkdown(finalBody);

  const savedPaths: string[] = [];
  if (route.targets.includes('obsidian')) {
    const dir = flags['output-dir'] || getSaveDir(source.type);
    if (dir) savedPaths.push(await saveMarkdown({
      title: result.title, sourceType: source.type,
      sourceUrl: source.input, summaryBody: finalBody,
      genre: '', keywords: [], saveDir: dir,
    }));
  }
  return { markdown: finalBody, title: result.title, source, savedPaths, signals: buildSignals(route.targets) };
}

// ── Shared ──

async function summarizeAndSave(content: string, title: string, srcLabel: string, source: DetectedSource, route: RouteDecision, addDiagram: boolean): Promise<DigestResult> {
  // omni-crawl 컨텍스트 보강
  // force: 사용자 명시 요청 (enrich, 풍부하게, crawl 등)
  // smart: 본문이 짧거나(< 2000자) rich 형식인데 전문 주제일 때 자동 판단
  let enrichedContent = content;
  const shouldEnrich = route.enrichWithCrawl === 'force'
    || (route.enrichWithCrawl === 'smart' && route.format === 'rich' && content.length < 2000);
  if (shouldEnrich) {
    const mode = route.enrichWithCrawl === 'force' ? '명시 요청' : '스마트 판단 (본문 부족)';
    console.log(`  omni-crawl 컨텍스트 보강 (${mode})...`);
    const crawlQuery = title.length > 5 ? title : content.substring(0, 200).replace(/[#\n]/g, ' ').trim();
    const crawled = enrichWithOmniCrawl(crawlQuery);
    if (crawled) {
      enrichedContent = content + '\n\n---\n\n# 배경 정보 (omni-crawl)\n\n' + crawled;
      console.log(`  본문 + 배경 정보 합산: ${enrichedContent.length.toLocaleString()}자\n`);
    }
  }

  console.log('  Grok 요약 생성...');
  const started = Date.now();
  const raw = await summarizeGeneric(enrichedContent, title, srcLabel, /^https?:\/\//.test(source.input) ? source.input : undefined, route.format);
  console.log(`  완료 (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);

  const { genre, keywords, body } = parseMetaFromSummary(raw);
  let finalBody = body;
  if (addDiagram) finalBody = await appendDiagramToMarkdown(finalBody);

  const savedPaths: string[] = [];
  if (route.targets.includes('obsidian')) {
    const dir = flags['output-dir'] || getSaveDir(source.type);
    if (dir) savedPaths.push(await saveMarkdown({
      title, sourceType: source.type, sourceUrl: /^https?:\/\//.test(source.input) ? source.input : undefined,
      summaryBody: finalBody, genre, keywords, saveDir: dir,
    }));
  }
  return { markdown: finalBody, title, source, savedPaths, signals: buildSignals(route.targets) };
}

function buildSignals(targets: OutputTarget[], existingOutput?: string): string[] {
  const s: string[] = [];
  const hasWeb = existingOutput?.includes('---SIGNAL: webDeploy=');
  const hasPdf = existingOutput?.includes('---SIGNAL: pdfRequested=');
  if (!hasWeb) {
    if (targets.includes('web')) s.push('---SIGNAL: webDeploy=html-only---');
    if (targets.includes('web-deploy')) s.push('---SIGNAL: webDeploy=deploy---');
  }
  if (!hasPdf && targets.includes('pdf')) s.push('---SIGNAL: pdfRequested=true---');
  return s;
}

// ── Self-test ──

function runSelfTest() {
  console.log('=== omni-digest self-test ===\n');
  let passed = 0, failed = 0;

  const dc: Array<{ i: string; e: string }> = [
    { i: 'https://x.com/u/status/1', e: 'x-post' }, { i: 'https://x.com/u/article/1', e: 'x-article' },
    { i: 'https://twitter.com/u/status/1', e: 'x-post' }, { i: 'https://youtube.com/watch?v=a', e: 'youtube' },
    { i: 'https://youtu.be/a', e: 'youtube' }, { i: 'https://github.com/o/r', e: 'github-repo' },
    { i: 'https://github.com/o/r/pull/1', e: 'github-pr' }, { i: 'https://github.com/o/r/issues/1', e: 'github-issue' },
    { i: 'https://github.com/o/r/commit/abc', e: 'github-commit' }, { i: 'https://example.com/a', e: 'web' },
    { i: '/p/doc.pdf', e: 'local-file' }, { i: 'photo.png', e: 'local-file' },
  ];
  for (const { i, e } of dc) { const r = detectSource(i); if (r.type === e) { console.log(`  PASS: detect "${i}" → ${r.type}`); passed++; } else { console.log(`  FAIL: detect "${i}" → ${r.type} (expected ${e})`); failed++; } }

  const rc: Array<{ t: string; ef: string; et: string }> = [
    { t: '', ef: 'rich-cards', et: 'obsidian' }, { t: '짧게', ef: 'essential', et: 'obsidian' },
    { t: '상세 분석', ef: 'rich', et: 'obsidian' }, { t: 'cc웹', ef: 'rich-cards', et: 'obsidian,web' },
    { t: 'ccv웹', ef: 'rich-cards', et: 'obsidian,web-deploy' }, { t: 'pdf로', ef: 'rich-cards', et: 'obsidian,pdf' },
    { t: 'markdown으로', ef: 'rich-cards', et: 'markdown' },
  ];
  for (const { t, ef, et } of rc) { const r = decideRoute({ intentText: t }); const gt = r.targets.join(','); if (r.format === ef && gt === et) { console.log(`  PASS: route "${t || '(empty)'}" → ${r.format}/${gt}`); passed++; } else { console.log(`  FAIL: route "${t || '(empty)'}" → ${r.format}/${gt} (expected ${ef}/${et})`); failed++; } }

  // summarize CLI routing test
  const sumRoute = decideRoute({ intentText: 'sum 요약' });
  if (sumRoute.useSummarize) { console.log('  PASS: "sum" → useSummarize=true'); passed++; } else { console.log('  FAIL: "sum" → useSummarize should be true'); failed++; }
  const noSumRoute = decideRoute({ intentText: '요약해줘' });
  if (!noSumRoute.useSummarize) { console.log('  PASS: no "sum" → useSummarize=false'); passed++; } else { console.log('  FAIL: no "sum" → useSummarize should be false'); failed++; }
  const sumFullRoute = decideRoute({ intentText: 'sum full 요약' });
  if (sumFullRoute.summarizeFull && sumFullRoute.useSummarize) { console.log('  PASS: "sum full" → summarizeFull=true'); passed++; } else { console.log('  FAIL: "sum full" → summarizeFull should be true'); failed++; }

  // enrichWithCrawl test
  const crawlRoute = decideRoute({ intentText: 'enrich 풍부하게 요약' });
  if (crawlRoute.enrichWithCrawl === 'force') { console.log('  PASS: "enrich 풍부하게" → force'); passed++; } else { console.log('  FAIL: "enrich" → should be force'); failed++; }
  const crawlRoute2 = decideRoute({ intentText: 'crawl deep dive' });
  if (crawlRoute2.enrichWithCrawl === 'force') { console.log('  PASS: "crawl deep dive" → force'); passed++; } else { console.log('  FAIL: "crawl" → should be force'); failed++; }
  const smartRoute = decideRoute({ intentText: '요약해줘' });
  if (smartRoute.enrichWithCrawl === 'smart') { console.log('  PASS: 기본 → smart'); passed++; } else { console.log('  FAIL: 기본 → should be smart'); failed++; }

  // diagram intent test
  if (wantsDiagram('다이어그램 포함 요약') && !wantsDiagram('요약만')) { console.log('  PASS: diagram intent'); passed++; } else { console.log('  FAIL: diagram intent'); failed++; }

  console.log(`\n결과: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function printHelp() {
  console.log(`
omni-digest — 통합 콘텐츠 요약 스킬

사용법: bun scripts/main.ts <INPUT> [OPTIONS]

입력: URL (X, YouTube, GitHub, 웹) 또는 로컬 파일 경로

옵션:
  --message, -m <text>   사용자 의도 (자동 라우팅)
  --format <fmt>         요약 형식: essential, rich-cards, rich
  --target <tgt>         출력 타겟 (쉼표): obsidian, markdown, web, web-deploy, pdf
  --diagram              다이어그램 포함
  --no-media             첨부 영상 STT 전사 비활성 (기본: 영상 있으면 자동 전사)
  --media-lang <code>    전사 언어 (기본 en, 예: ko)
  --content <text>       사전 추출 콘텐츠 (Claude 파이핑)
  --print                stdout 출력
  --dry-run              라우팅만 확인
  --no-obsidian          Obsidian 생략
  --output-dir <path>    저장 경로 오버라이드
  --self-test            테스트
  --help, -h             도움말
`);
}
