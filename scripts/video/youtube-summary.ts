import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { downloadAudio, splitAudio } from '../../skills/youtube-master/src/audio.js';
import { transcribeChunks } from '../../skills/youtube-master/src/stt.js';
import { which } from '../../skills/youtube-master/src/util.js';
import { judge } from '../../src/llm/judge-layer.js';
import {
  dispatchYoutubeTranscript, extractYoutubeVideoId, type YoutubeTranscriptResult,
} from '../../src/skills/tools/youtube-transcript.js';

type Summary = { verdict: string; keyPoints: string[]; cards: string[] };
type StudyNote = { concepts: string[]; terms: { term: string; definition: string }[]; steps: string[]; questions: string[] };

const oneItem = (item: unknown): item is string =>
  typeof item === 'string' && !!item.trim() &&
  !/[\r\n\u2028\u2029]/u.test(item) &&
  !/^(?:#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|>)/u.test(item.trim());
const lines = (items: unknown): items is string[] =>
  Array.isArray(items) && items.every(oneItem);
type Result =
  | { outcome: 'ok'; path: string; videoId: string }
  | { outcome: 'no-transcript'; videoId: string; reason?: 'stt-unavailable' }
  | { outcome: 'invalid-video-id' };

function parseSummary(value: unknown): Summary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!oneItem(v.verdict) ||
      !lines(v.keyPoints) || v.keyPoints.length < 5 || v.keyPoints.length > 7 ||
      !lines(v.cards) || v.cards.length === 0 ||
      !v.cards.every(card => /^Q: \S.*\? A: \S.*$/u.test(card.trim()))) return null;
  return { verdict: v.verdict.trim(), keyPoints: v.keyPoints.map(s => s.trim()), cards: v.cards.map(s => s.trim()) };
}

function parseStudyNote(value: unknown): StudyNote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!lines(v.concepts) || v.concepts.length === 0 ||
      !Array.isArray(v.terms) || v.terms.length === 0 ||
      !v.terms.every((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) &&
        oneItem((entry as Record<string, unknown>).term) && oneItem((entry as Record<string, unknown>).definition)) ||
      !lines(v.steps) || v.steps.length === 0 ||
      !lines(v.questions) || v.questions.length < 3 || v.questions.length > 5) return null;
  return {
    concepts: v.concepts.map(s => s.trim()),
    terms: (v.terms as { term: string; definition: string }[]).map(({ term, definition }) => ({ term: term.trim(), definition: definition.trim() })),
    steps: v.steps.map(s => s.trim()), questions: v.questions.map(s => s.trim()),
  };
}

export async function runYoutubeSummary(
  url: string,
  stateRoot: string,
  deps: {
    transcript?: (url: string) => Promise<YoutubeTranscriptResult>;
    binary?: (name: 'yt-dlp' | 'ffmpeg') => string;
    download?: (url: string, dir: string) => Promise<string>;
    split?: (audio: string, dir: string, seconds: number) => Promise<string[]>;
    stt?: (chunks: string[]) => Promise<{ transcript: string }>;
    call?: (args: { prompt: string; signal?: AbortSignal; provider: string; model: string }) => Promise<{ text: string }>;
    format?: unknown;
  } = {},
): Promise<Result> {
  const format = deps.format === undefined ? 'summary' : deps.format;
  if (format !== 'summary' && format !== 'study-note') throw new Error('input.format must be summary or study-note');
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) return { outcome: 'invalid-video-id' };
  const transcript = await (deps.transcript ?? (source => dispatchYoutubeTranscript({ url: source })))(url);
  let text = transcript.text;
  if (!text.trim() || transcript.provider === 'none') {
    try {
      for (const name of ['yt-dlp', 'ffmpeg'] as const) (deps.binary ?? which)(name);
    } catch {
      return { outcome: 'no-transcript', videoId, reason: 'stt-unavailable' };
    }
    const dir = mkdtempSync(join(tmpdir(), 'youtube-summary-stt-'));
    try {
      const audio = await (deps.download ?? downloadAudio)(url, dir);
      const chunks = await (deps.split ?? splitAudio)(audio, dir, 25 * 60);
      text = (await (deps.stt ?? transcribeChunks)(chunks)).transcript;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!text.trim()) return { outcome: 'no-transcript', videoId };
  }

  if (format === 'study-note') {
    const decision = await judge({
      site: 'video.youtube-summary',
      prompt: `Create a study note only from the supplied YouTube transcript. Do not invent facts. Return ONLY JSON with exactly these fields: {"concepts":["concise concept explanations"],"terms":[{"term":"term","definition":"definition"}],"steps":["ordered explanation of the subject"],"questions":["3 to 5 self-check questions"]}. Include at least one concept, term and step, and 3 to 5 questions. Keep every item on one line. Write in the transcript's language.\n\nTranscript for ${videoId}:\n${text}`,
      schema: parseStudyNote,
      ...(deps.call ? { call: deps.call, resolveRoleProvider: () => ({ provider: { name: 'fake' }, model: 'fake' }) } : {}),
    });
    if (!decision.ok) throw new Error(`YouTube study-note judge failed: ${decision.reason}`);
    const { concepts, terms, steps, questions } = decision.value;
    const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    const markdown = `# YouTube study note — ${videoId}\n\nSource: https://www.youtube.com/watch?v=${videoId}\n\n## 개념 정리\n${concepts.map(s => `- ${s}`).join('\n')}\n\n## 용어 표\n| 용어 | 뜻 |\n| --- | --- |\n${terms.map(({ term, definition }) => `| ${cell(term)} | ${cell(definition)} |`).join('\n')}\n\n## 단계별 설명\n${steps.map((s, index) => `${index + 1}. ${s}`).join('\n')}\n\n## 스스로 확인 문제\n${questions.map((s, index) => `${index + 1}. ${s}`).join('\n')}\n`;
    const path = join(resolve(stateRoot), 'youtube-summary', `${videoId}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdown);
    return { outcome: 'ok', path, videoId };
  }

  const decision = await judge({
    site: 'video.youtube-summary',
    prompt: `Summarize only the supplied YouTube transcript. Do not invent facts. Return ONLY JSON with exactly these fields: {"verdict":"one-line conclusion","keyPoints":["5 to 7 concise key points"],"cards":["Q: A question? A: Its answer."]}. Include one or more cards, each on one line in this Q:/A: format. Write in the transcript's language.\n\nTranscript for ${videoId}:\n${text}`,
    schema: parseSummary,
    ...(deps.call ? { call: deps.call, resolveRoleProvider: () => ({ provider: { name: 'fake' }, model: 'fake' }) } : {}),
  });
  if (!decision.ok) throw new Error(`YouTube summary judge failed: ${decision.reason}`);
  const { verdict, keyPoints, cards } = decision.value;
  const markdown = `# YouTube summary — ${videoId}\n\nSource: https://www.youtube.com/watch?v=${videoId}\n\n## One-line verdict\n${verdict}\n\n## Key points\n${keyPoints.map(point => `- ${point}`).join('\n')}\n\n## Cards\n${cards.map((card, index) => `### Card ${index + 1}\n${card}`).join('\n\n')}\n`;
  const path = join(resolve(stateRoot), 'youtube-summary', `${videoId}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown);
  return { outcome: 'ok', path, videoId };
}

if (import.meta.main) {
  try {
    const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
    if (!contextPath) throw new Error('ELANOUS_GRAPH_CONTEXT required');
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { graphId?: string; nodeId?: string; input?: { url?: unknown; format?: unknown } };
    if (context.graphId !== 'youtube-summary' || context.nodeId !== 'summary') throw new Error('youtube-summary graph context mismatch');
    if (typeof context.input?.url !== 'string' || !context.input.url.trim()) throw new Error('input.url required');
    const root = resolve(contextPath, '..', '..', '..', '..');
    console.log(JSON.stringify(await runYoutubeSummary(context.input.url, root, { format: context.input.format })));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'fail', reason: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
