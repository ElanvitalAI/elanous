import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import { cleanTitle, safeName, escapeQuotes, escapeTable, reflowParagraphs, dateStamp } from './util.js';
import { getStudyNoteSaveDir } from './obsidian.js';
import type { VideoMeta, TranscriptStrategy } from './types.js';

export interface StudyNoteInput {
  summaryBody: string;
  url: string;
  videoId: string;
  meta: VideoMeta | null;
  transcriptStrategy: TranscriptStrategy;
  backendFilePath?: string | null;
}

interface Card {
  title: string;
  content: string;
  preview: string;
}

function extractCards(body: string): Card[] {
  const text = String(body || '');
  const regex = /(🟪|🟦)\s*카드\s*\d+\s*[—-]\s*(.+?)(?=\n)([\s\S]*?)(?=\n(?:🟪|🟦)\s*카드\s*\d+\s*[—-]|$)/g;
  const cards: Card[] = [];
  let match;
  while ((match = regex.exec(text))) {
    const title = cleanTitle(match[2]);
    const content = match[3].trim();
    const preview = content.replace(/\s+/g, ' ').slice(0, 110) || title;
    cards.push({ title, content, preview });
  }
  return cards;
}

function renderChapter(card: Card, idx: number, url: string): string {
  return [
    `### ${(idx + 1).toString().padStart(2, '0')}. ${card.title}`,
    '',
    `[이 구간 바로가기](${url})`,
    '',
    '**학습 내용**',
    '',
    reflowParagraphs(card.content),
    '',
    `> 인사이트: ${card.preview}`,
  ].join('\n');
}

function renderFallbackChapter(body: string, url: string): string {
  const cleaned = reflowParagraphs(body.replace(/^#+\s+/gm, '').slice(0, 2500));
  return [
    '### 01. 전체 요약 기반 학습',
    '',
    `[이 구간 바로가기](${url})`,
    '',
    '**학습 내용**',
    '',
    cleaned,
    '',
    '> 인사이트: 카드 단위 추출이 없어 전체 요약 중심으로 정리했습니다.',
  ].join('\n');
}

export function buildStudyNote(input: StudyNoteInput): { filePath: string | null; markdown: string } {
  const title = cleanTitle(input.meta?.title || 'Untitled');
  const today = new Date().toISOString().slice(0, 10);
  const ds = dateStamp();
  const isCloudStt = input.transcriptStrategy === 'cloud-stt';

  const cards = extractCards(input.summaryBody);
  const tocRows = cards.length
    ? cards.map((c, idx) => `| ${idx + 1} | ${escapeTable(c.title)} | ${escapeTable(c.preview)} | -- |`).join('\n')
    : '| 1 | 전체 요약 | 자동 추출된 카드가 없어 전체 요약 기준으로 정리 | -- |';

  const chapters = cards.length
    ? cards.map((c, idx) => renderChapter(c, idx, input.url)).join('\n\n')
    : renderFallbackChapter(input.summaryBody, input.url);

  const insights = cards.length
    ? cards.slice(0, 5).map((c) => `- ${c.title}: ${c.preview}`).join('\n')
    : '- 전체 요약을 먼저 읽고, 필요한 구간은 원본 영상에서 다시 확인해 주세요.';

  const related = isCloudStt
    ? '- [[Cloud STT 요약]]\n- [[긴 영상 요약 워크플로]]'
    : '- [[YouTube 요약]]\n- [[Obsidian 정리 습관]]';

  const markdown = [
    '---',
    `title: "${today} ${escapeQuotes(title)}"`,
    `created: "${new Date().toISOString()}"`,
    `last_modified: "${new Date().toISOString()}"`,
    'tags:',
    '  - 리소스/유튜브학습',
    '  - 리소스/AI리소스/YouTube',
    `status: 학습중`,
    `type: 학습노트`,
    `priority: 중간`,
    `source_url: "${input.url}"`,
    'domain: 리소스',
    `subdomain: YouTube`,
    `category: ${isCloudStt ? 'Cloud_STT_요약' : '기본요약'}`,
    'para_category: 기타',
    'entity_type: 학습노트',
    'aliases: []',
    'knowledge_connections: []',
    '---',
    '',
    '## 영상 정보',
    '',
    '| 항목 | 내용 |',
    '|------|------|',
    `| 정리일 | ${today} |`,
    `| 영상 길이 | ${escapeTable(input.meta?.duration || 'N/A')} |`,
    `| 원본 영상 | [바로가기](${input.url}) |`,
    `| 채널 | ${escapeTable(input.meta?.channel || 'Unknown')} |`,
    `| 업로드일 | ${escapeTable(input.meta?.uploaded?.split('T')[0] || 'N/A')} |`,
    `| 전사 경로 | ${isCloudStt ? 'Cloud STT' : 'Supadata'} |`,
    input.backendFilePath ? `| 원본 파일 | \`${input.backendFilePath}\` |` : '',
    '',
    '## 전체 영상 바로가기',
    `- [YouTube에서 전체 영상 보기](${input.url})`,
    '',
    '## 이 영상에서 배울 수 있는 것',
    isCloudStt
      ? '- 긴 영상이나 자막이 불안정한 상황에서도, 핵심 논지를 놓치지 않고 학습용 구조로 재정리할 수 있습니다.'
      : '- 일반 YouTube 요약을 학습노트 형태로 다시 정리해, 나중에 복습하기 쉬운 구조로 바꿔둡니다.',
    '- 카드형 요약을 학습 관점으로 다시 풀어 써서, "무엇을 말했는지 / 왜 중요한지 / 어떻게 써먹을지"를 중심으로 읽을 수 있습니다.',
    '',
    '## 목차 및 타임스탬프',
    '',
    '| 순서 | 구간 제목 | 핵심 내용 | 중요도 |',
    '|------|-----------|----------|--------|',
    tocRows,
    '',
    '## 구간별 상세 학습',
    '',
    chapters,
    '',
    '## 핵심 개념 정리',
    insights,
    '',
    '## 개인 인사이트',
    '- 이 영상의 가장 큰 포인트: 핵심 주장과 근거를 카드 단위로 다시 읽으면, 원본을 다시 틀지 않아도 전체 흐름이 복원됩니다.',
    `- 바로 적용할 부분: ${isCloudStt ? '긴 영상도 Cloud STT로 안정적으로 기록하는 습관' : '짧은 영상은 기본 요약 후 곧바로 노트화하는 습관'}`,
    '- 추가로 공부할 주제: 이 영상에서 언급된 사례를 실제 작업 맥락에 연결해 보기',
    '',
    '## 관련 학습',
    related,
    '',
    '---',
    '',
    '## 원본 요약 재료',
    '',
    input.summaryBody || '_원본 요약 본문을 캡처하지 못했습니다._',
    '',
  ].filter((line) => line !== '').join('\n');

  // Save to Obsidian if configured
  const saveDir = getStudyNoteSaveDir();
  if (!saveDir) {
    return { filePath: null, markdown };
  }

  mkdirSync(saveDir, { recursive: true });
  let filePath = join(saveDir, `${ds}_${safeName(title)}_study-note.md`);
  let n = 1;
  while (existsSync(filePath)) {
    filePath = join(saveDir, `${ds}_${safeName(title)}_study-note_${n}.md`);
    n += 1;
  }
  writeFileSync(filePath, markdown, 'utf8');
  return { filePath, markdown };
}
