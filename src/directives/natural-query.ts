// Natural-language question → period · channel · question shape · topic.
// Time and channel words come from an explicit vocabulary (KST). The topic is whatever is left after those words,
// question filler and particles are taken out — it is never pattern-matched; it goes to the hybrid search as is.
import type { DirectiveAgent } from './sources.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const KST_MS = 9 * HOUR_MS;

export type AskIntent = 'search' | 'said' | 'history';
export interface NaturalQuery {
  /** What the person talked about — goes to the hybrid search. */
  topic: string;
  since?: string;
  until?: string;
  /** Channel filter as a comma list (`telegram,codex`). */
  source?: string;
  intent: AskIntent;
  /** KST day (`YYYY-MM-DD`) when the question names a single day. */
  day?: string;
  /** The words consumed as time / channel / shape, for the one-line «understood as». */
  understood: string[];
}

const CHANNELS: Record<string, DirectiveAgent> = {
  텔레그램: 'telegram', 텔레: 'telegram', telegram: 'telegram', tg: 'telegram',
  코덱스: 'codex', codex: 'codex',
  eln: 'elanous', 엘라누스: 'elanous', elanous: 'elanous', tui: 'elanous',
  클로드: 'claude-code', claude: 'claude-code', 클코: 'claude-code',
  pwa: 'pwa', 웹앱: 'pwa', 웹채팅: 'pwa',
  grok: 'grok', 그록: 'grok',
};
const DAY_OFFSETS: Record<string, number> = { 오늘: 0, today: 0, 어제: 1, yesterday: 1, 그제: 2, 그저께: 2, 엊그제: 2, 엊그저께: 2 };
/** Parts of a day as [start hour, end hour) KST. */
const DAY_PARTS: Record<string, [number, number]> = {
  새벽: [0, 6], 아침: [6, 12], morning: [6, 12], 오전: [0, 12], 점심: [11, 14], 낮: [11, 17],
  오후: [12, 18], afternoon: [12, 18], 저녁: [18, 24], evening: [18, 24], 밤: [18, 24], night: [18, 24], tonight: [18, 24],
};
const HISTORY_WORDS = new Set(['내역', '이력', '히스토리', 'history', '테마', 'theme', '흐름', '변천', '경과']);
const FILLER = new Set([
  '뭐라고', '뭐라', '뭐', '뭘', '무슨', '어떤', '했지', '했나', '했어', '했었지', '했더라', '했었나', '했는지', '했던', '했다', '하던',
  '얘기한', '얘기했던', '얘기', '이야기한', '이야기', '말한', '말했던', '말했지', '말', '한', '거', '것', '건', '게',
  '관련', '관련해서', '관련된', '대해', '대해서', '대한', '시킨', '시켰던', '요청', '요청들', '요청한', '요청했던', '지시한', '알려줘', '알려주세요', '알려', '주세요',
  '보여줘', '찾아줘', '이렇게', '이런', '그런', '적', '있어', '있나', '있나요', '있었나', '있었나요', '있었어', '있었지', '있니', '없어', '없나',
  '대표가', '대표님이', '내가', '제가', '전에', '언제', '며칠날', '며칠', '동안', '중에', '중', '좀',
  'what', 'did', 'i', 'say', 'said', 'ever', 'about', 'the', 'a', 'an', 'when', 'was', 'tell', 'me', 'show', 'ask', 'asked', 'requests', 'request', 'related', 'to', 'on', 'in',
]);
// Longest first. Stripped from a word only for vocabulary lookup and, for words of three or more letters, from the topic.
const PARTICLES = ['에서는', '에서', '에는', '으로', '부터', '까지', '동안', '에게', '한테', '이라고', '라고', '이랑', '하고', '에', '엔', '로', '은', '는', '이', '가', '을', '를', '의', '도', '쯤'];

function bare(word: string): string {
  const lower = word.toLowerCase();
  for (const particle of PARTICLES) if (lower.length > particle.length && lower.endsWith(particle)) return lower.slice(0, -particle.length);
  return lower;
}
const kstDay = (ms: number) => new Date(ms + KST_MS).toISOString().slice(0, 10);
const kstMidnight = (day: string) => Date.parse(`${day}T00:00:00+09:00`);
/** Monday 00:00 KST of the week containing `ms`. */
function weekStart(ms: number): number {
  const day = kstDay(ms);
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return kstMidnight(day) - weekday * DAY_MS;
}
function unitMs(unit: string): number | undefined {
  return ({ 분: 60_000, m: 60_000, min: 60_000, minutes: 60_000, 시간: HOUR_MS, h: HOUR_MS, hours: HOUR_MS, 일: DAY_MS, d: DAY_MS, days: DAY_MS, 주: 7 * DAY_MS, 주일: 7 * DAY_MS, w: 7 * DAY_MS, weeks: 7 * DAY_MS } as Record<string, number>)[unit];
}

export function parseNaturalQuery(text: string, now = Date.now()): NaturalQuery {
  const understood: string[] = [];
  const topic: string[] = [];
  // Quoted words are the topic verbatim (did-I-say: «X 라고 한 적 있어?»).
  let rest = text;
  for (const [open, close] of [['«', '»'], ['"', '"'], ['“', '”'], ["'", "'"], ['「', '」']] as const) {
    for (;;) {
      const start = rest.indexOf(open);
      const end = start < 0 ? -1 : rest.indexOf(close, start + 1);
      if (start < 0 || end < 0) break;
      topic.push(rest.slice(start + 1, end).trim());
      rest = `${rest.slice(0, start)} ${rest.slice(end + 1)}`;
    }
  }
  const words = rest.split(/\s+/).map(word => word.replace(/^[(\[,.!?~]+|[)\],.!?~]+$/g, '')).filter(Boolean);
  const channels = new Set<DirectiveAgent>();
  let dayStart: number | undefined;
  let since: number | undefined;
  let until: number | undefined;
  let part: [number, number] | undefined;
  let intent: AskIntent = 'search';
  let month: number | undefined;
  const setDay = (start: number, word: string) => { dayStart = start; understood.push(word); };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const b = bare(word);
    const next = words[i + 1] ? bare(words[i + 1]!) : '';
    const plain = word.toLowerCase();
    if (CHANNELS[b] ?? CHANNELS[plain]) { channels.add((CHANNELS[b] ?? CHANNELS[plain])!); understood.push(word); continue; }
    if (b in DAY_OFFSETS) { setDay(kstMidnight(kstDay(now - DAY_OFFSETS[b]! * DAY_MS)), word); continue; }
    if (DAY_PARTS[b]) { part = DAY_PARTS[b]; understood.push(word); continue; }
    if (HISTORY_WORDS.has(b)) { intent = 'history'; understood.push(word); continue; }
    if ((b === '적' || b === '적이') && /^(있|없)/.test(next)) { if (intent === 'search') intent = 'said'; understood.push(word); continue; }
    if (b === 'did' && words.slice(i + 1, i + 4).some(w => /^say|^said|^mention/i.test(w))) { if (intent === 'search') intent = 'said'; continue; }
    // Week words: 지난주 · 지난 주 · last week · 이번 주 · 금주 · this week.
    if (b === '지난주' || b === '저번주' || ((b === '지난' || b === '저번' || b === 'last') && (next === '주' || next === 'week'))) {
      const start = weekStart(now) - 7 * DAY_MS; since = start; until = start + 7 * DAY_MS - 1; understood.push(word);
      if (b !== '지난주' && b !== '저번주') i++;
      continue;
    }
    if (b === '이번주' || b === '금주' || ((b === '이번' || b === 'this') && (next === '주' || next === 'week'))) {
      since = weekStart(now); until = now; understood.push(word);
      if (b !== '이번주' && b !== '금주') i++;
      continue;
    }
    // Rolling windows: 지난/최근 일주일 · 지난 3일 · past 7 days · 일주일.
    if (b === '일주일' || b === '한주' || b === '1주일') { since = now - 7 * DAY_MS; until = now; understood.push(word); continue; }
    if (b === '지난' || b === '최근' || b === '요즘' || b === 'past' || b === 'recent') {
      const count = /^(\d+)(분|시간|일|주|주일)$/.exec(next);
      if (count) { since = now - Number(count[1]) * unitMs(count[2]!)!; until = now; understood.push(`${word} ${words[i + 1]}`); i++; }
      else if (b === '최근' || b === '요즘') { since = now - 7 * DAY_MS; until = now; understood.push(word); }
      continue;
    }
    // N시간 전 · 3일 전 · 30분 전 · 3 hours ago · 3h ago: from then until now.
    const ago = /^(\d+)(분|시간|일|주)$/.exec(b) ?? /^(\d+)(m|h|d|w)$/.exec(b);
    if (ago && (next === '전' || next === 'ago' || next.startsWith('전'))) {
      since = now - Number(ago[1]) * unitMs(ago[2]!)!; until = now; understood.push(`${word} ${words[i + 1]}`); i++; continue;
    }
    if (/^\d+$/.test(b) && /^(hours?|minutes?|days?|weeks?)$/.test(next) && /^ago/i.test(words[i + 2] ?? '')) {
      const unit = next.startsWith('hour') ? HOUR_MS : next.startsWith('minute') ? 60_000 : next.startsWith('week') ? 7 * DAY_MS : DAY_MS;
      since = now - Number(b) * unit; until = now; understood.push(`${word} ${words[i + 1]} ${words[i + 2]}`); i += 2; continue;
    }
    // Dates: 2026-11-23 · 11/23 · 11월 23일 · 23일.
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
    const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(b);
    const monthWord = /^(\d{1,2})월$/.exec(b);
    const dayWord = /^(\d{1,2})일$/.exec(b);
    if (iso || slash || dayWord) {
      const year = Number(kstDay(now).slice(0, 4));
      const [y, m, d] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
        : slash ? [year, Number(slash[1]), Number(slash[2])]
        : [year, month ?? Number(kstDay(now).slice(5, 7)), Number(dayWord![1])];
      let day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      // Without a year a date after today means last year.
      if (!iso && kstMidnight(day) > now) day = `${y - 1}${day.slice(4)}`;
      if (Number.isFinite(kstMidnight(day)) && kstDay(kstMidnight(day)) === day) { setDay(kstMidnight(day), word); continue; }
    }
    if (monthWord) { month = Number(monthWord[1]); understood.push(word); continue; }
    if (FILLER.has(b) || FILLER.has(plain) || PARTICLES.includes(plain)) continue;
    // Topic: keep the word, minus a trailing particle on longer words (발행이 → 발행 · 로스터를 → 로스터).
    topic.push(word.length >= 3 && b.length >= 2 ? word.slice(0, b.length) : word);
  }
  if (dayStart !== undefined) {
    since = part ? dayStart + part[0] * HOUR_MS : dayStart;
    until = part ? dayStart + part[1] * HOUR_MS - 1 : dayStart + DAY_MS - 1;
  } else if (part && since === undefined) {
    const today = kstMidnight(kstDay(now));
    since = today + part[0] * HOUR_MS; until = today + part[1] * HOUR_MS - 1;
  }
  if (intent === 'history' && since === undefined) { since = now - 7 * DAY_MS; until = now; }
  return {
    topic: topic.filter(Boolean).join(' '),
    ...(since !== undefined ? { since: new Date(since).toISOString() } : {}),
    ...(until !== undefined ? { until: new Date(until).toISOString() } : {}),
    ...(channels.size ? { source: [...channels].join(',') } : {}),
    intent,
    ...(dayStart !== undefined ? { day: kstDay(dayStart) } : {}),
    understood,
  };
}
