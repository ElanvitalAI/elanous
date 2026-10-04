import { debug } from '../../debug/log.js';

export interface AuthorInput {
  title: string;
  text: string;
  cellId: string;
  version: string;
}

export interface AuthorInputSignal {
  kind: 'path' | 'symbol' | 'command' | 'marker';
  match: string;
  field: 'title' | 'text';
  reason: string;
}

export interface AuthorInputCheck {
  verdict: 'approved' | 'resubmit' | 'confirm' | 'uncheckable';
  signals: AuthorInputSignal[];
  units: { checked: number; candidates: number };
  implementationRatio: number | null;
}

const TOKEN_SHAPES: ReadonlyArray<{ kind: AuthorInputSignal['kind']; pattern: RegExp; reason: string }> = [
  { kind: 'path', pattern: /[\w.@~-]+\/[\w./@~-]+|[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}/g,
    reason: '경로 또는 파일 이름 꼴' },
  { kind: 'symbol', pattern: /[A-Za-z_][\w.]*\(\)|`[A-Za-z_][\w.]*`/g,
    reason: '함수 또는 심볼 이름 꼴' },
  { kind: 'command', pattern: /\b(?:bun|npm|pnpm|yarn|npx|bunx|node|deno|python3?|pip|uv|make|git|gh|cargo|go|docker|kubectl|elanous|eln|bash|sh|zsh|curl)\s+[a-z][\w-]*\b|--[\w-]+/g,
    reason: '실행 명령 또는 플래그 꼴' },
  { kind: 'marker', pattern: /대상 경로:|경계:|불변식:|판정 신호:|관측\s*=|기대\s*=/g,
    reason: '골 구조 마커 꼴' },
];

const KOREAN_DIRECTIVE = /하라|해라|하세요|하십시오|해\s?주세요|해\s?줘|해야|바꿔|고쳐|넣어|빼|돌려|추가|수정|삭제|판정|실행|쓰라/;
const ENGLISH_DIRECTIVE = /\b(?:please|must|should)\b|^\s*(?:run|edit|change|fix|add|remove|delete|update|modify|execute|test|build|use|write|implement|create|set|check|verify)\b/i;

function sentences(value: string): string[] {
  return value.split(/(?<=[.?])(?=\s|$)|\n+/).map(part => part.trim()).filter(Boolean);
}

export function checkAuthorInput({ title, text, cellId, version }: AuthorInput): AuthorInputCheck {
  const valid = [title, text, cellId, version].every(value => typeof value === 'string' && !!value.trim())
    && /^\d+\.\d+\.\d+$/.test(version);
  const signals: AuthorInputSignal[] = [];
  let checked = 0;
  let candidates = 0;
  let directed = false;

  if (valid) {
    for (const field of ['title', 'text'] as const) {
      for (const sentence of sentences(field === 'title' ? title : text)) {
        checked++;
        let found = false;
        for (const { kind, pattern, reason } of TOKEN_SHAPES) {
          for (const match of sentence.matchAll(pattern)) {
            signals.push({ kind, match: match[0], field, reason });
            found = true;
            if (kind === 'marker' || kind === 'command') directed = true;
          }
        }
        if (found) {
          candidates++;
          if (KOREAN_DIRECTIVE.test(sentence) || ENGLISH_DIRECTIVE.test(sentence)) directed = true;
        }
      }
    }
  }

  const verdict: AuthorInputCheck['verdict'] = !valid ? 'uncheckable'
    : signals.length === 0 ? 'approved' : directed ? 'resubmit' : 'confirm';
  const implementationRatio = valid ? candidates / checked : null;
  debug.log('author.par', 'input-checked', {
    cellId, version, verdict, signals: signals.length, ratio: implementationRatio,
  });
  return { verdict, signals, units: { checked, candidates }, implementationRatio };
}
