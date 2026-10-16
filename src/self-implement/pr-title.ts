import { readFileSync } from 'node:fs';
import { parseAskProseTitle } from '../self-dev/launch-preflight.js';
import { extractVerbatimOriginalAsk } from './goal-author.js';

export function goalDocumentForReleaseNote(goalFile?: string): string {
  if (!goalFile) return '';
  try { return readFileSync(goalFile, 'utf8'); }
  catch { return ''; }
}

function isRepositoryRelativePath(candidate: string): boolean {
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[\\/]|[A-Za-z]:[\\/])/.test(candidate)) return false;
  const parts = candidate.split('/');
  return parts.length > 1
    && parts.every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part))
    && /\.[A-Za-z0-9]+$/.test(parts.at(-1)!);
}

function extractRepositoryRelativePaths(first: string): string[] {
  const candidates = first.split(/[\s,;()[\]{}"'`<>]+/).filter(Boolean);
  return candidates.filter(isRepositoryRelativePath);
}

function parseAskMarkdownH1(feature: string): string | undefined {
  // ⛔ 펜스는 «문자»만이 아니라 «길이»로 닫힌다(CommonMark): 닫는 줄은 같은 문자 · 여는 줄 이상의 길이 · 뒤에 정보 문자열 없음.
  //   🩸 2026-09-23(#20050 착지 직후 실물): GOAL 문서가 원래 ask 를 ```` 네 개 펜스로 싸고, 그 안에 ``` 블록이 있다.
  //   문자만 보면 안쪽 ``` 이 바깥 ```` 를 «닫아» 안팎이 뒤집히고 ```bash 안의 `# 주석` 이 다시 제목이 됐다.
  let fence: { marker: '`' | '~'; run: number } | undefined;
  for (const line of feature.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = trimmed[0] === '`' || trimmed[0] === '~' ? trimmed[0] : undefined;
    let run = 0;
    if (marker) {
      while (run < trimmed.length && trimmed[run] === marker) run += 1;
    }
    if (marker && run >= 3) {
      if (!fence) {
        fence = { marker, run };
        continue;
      }
      if (fence.marker === marker && run >= fence.run && trimmed.slice(run).trim() === '') {
        fence = undefined;
        continue;
      }
    }
    if (fence) continue;
    if (line[0] !== '#' || line[1] === '#') continue;
    if (line.length < 2 || !/\s/.test(line[1]!)) continue;
    const text = line.slice(1).trim();
    if (text) return text;
  }
  return undefined;
}

function prTitleCodePointCount(text: string): number {
  return Array.from(text).length;
}

function truncatePrTitle(text: string): string {
  const points = Array.from(text);
  return points.length <= 72 ? text : `${points.slice(0, 69).join('')}...`;
}

export function goalChecklistIds(feature: string, goalFile?: string): string[] {
  const document = goalFile ? goalDocumentForReleaseNote(goalFile) : feature;
  const declaration = document.split(/\r?\n/).find((line) => line.startsWith('- 칸 id: '));
  const declared = declaration?.slice('- 칸 id: '.length).trim();
  if (declared && declared !== 'not declared') {
    return [...new Set(declared.split(' · ').map((id) => id.trim()).filter(Boolean))];
  }
  const firstLine = feature.split(/\r?\n/, 1)[0] ?? '';
  return [...new Set(Array.from(firstLine.matchAll(/\b[A-Z][A-Z0-9]+-[A-Z0-9]+\b/g), (match) => match[0]))];
}

function prTitleWithoutChecklistId(feature: string): string {
  const proseTitle = parseAskProseTitle(feature);
  if (proseTitle) return truncatePrTitle(proseTitle);

  const headingTitle = parseAskMarkdownH1(feature);
  if (headingTitle) return truncatePrTitle(headingTitle);

  // ⛔ GOAL 문서는 원래 ask 를 `Original ask (verbatim, unmodified):` 아래 ```` 펜스로 싣는다 — 그 안은 «코드»가 아니라 인용된 마크다운이다.
  //   🩸 2026-09-23: #20051 이 펜스를 길이로 닫게 고치자 그 인용 블록 안의 H1 까지 «건너뛰어»,
  //   첫 줄이 `대상 경로:` 인 GOAL 문서 대부분이 경로 요약 제목으로 떨어졌다(실물: #20055 `src/self-implement: gate-baseline.ts, …`).
  //   ⇒ 인용된 ask 를 꺼내 그 «안»에서 같은 규칙(제목: 줄 → 펜스 밖 H1)으로 한 번 더 찾는다.
  //   ⚠️ 정보 문자열이 붙은 펜스(```bash 등)로 싸였으면 그 안은 «코드»다 — 인용된 마크다운으로 보지 않는다.
  const verbatim = extractVerbatimOriginalAsk(feature);
  const opener = verbatim?.range ? feature.slice(0, verbatim.range.start).split(/\r?\n/).filter((line, i, all) => i === all.length - 2)[0] ?? '' : '';
  const verbatimAsk = verbatim && /^\s*(`{3,}|~{3,})\s*$/.test(opener) ? verbatim.ask : undefined;
  if (verbatimAsk) {
    const askTitle = parseAskProseTitle(verbatimAsk) ?? parseAskMarkdownH1(verbatimAsk);
    if (askTitle) return truncatePrTitle(askTitle);
  }

  const first = feature.split('\n')[0]!.trim();
  const paths = extractRepositoryRelativePaths(first);
  if (!paths.length) return truncatePrTitle(first);

  const pathParts = paths.map((path) => path.split('/'));
  const commonParts: string[] = [];
  for (let index = 0; index < pathParts[0]!.length - 1; index++) {
    const part = pathParts[0]![index]!;
    if (!pathParts.every((parts) => parts[index] === part)) break;
    commonParts.push(part);
  }
  const fileNames = pathParts.map((parts) => parts.at(-1)!);
  const directoryPrefix = commonParts.length ? `${commonParts.join('/')}: ` : '';
  const titlePrefix = prTitleCodePointCount(directoryPrefix) + prTitleCodePointCount(fileNames[0]!) <= 72 ? directoryPrefix : '';
  const title = fileNames.reduce((result, fileName) => {
    const next = result ? `${result}, ${fileName}` : fileName;
    return prTitleCodePointCount(titlePrefix) + prTitleCodePointCount(next) <= 72 ? next : result;
  }, '');
  if (title) return `${titlePrefix}${title}`;
  const firstFileName = fileNames[0]!;
  return truncatePrTitle(firstFileName);
}

export function prTitle(feature: string, goalFile?: string): string {
  const title = prTitleWithoutChecklistId(feature);
  const id = goalChecklistIds(feature, goalFile)[0];
  if (!id) return title;
  return truncatePrTitle(title.startsWith(`${id}: `) ? title : `${id}: ${title}`);
}
