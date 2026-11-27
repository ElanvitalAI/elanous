// kit/knowhow — one parser for seat KNOWHOW cards (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-12).
//
// Before this kit, four modules read `내부 문서 `KNOWHOW`` and each split cards its own way:
//   seat-loop/seat-knowhow.ts (seat packs ⊕ loop agents) · loops/orchestrator/knowhow-pack.ts (K3 pack) ·
//   self-implement/knowhow-pack.ts (goal ⊕ heal packs) · seat-loop/knowhow-lint.ts (export lint).
// They disagreed on where a card ends, which `상태:` counts and whether «active.» is active.
//
// 세 얼굴: 관측 = callers log their own pack rows (`seat.loop pack-loaded` · `loop.knowhow-pack load`); this kit
// returns `malformed` headings so a caller can count or refuse them / 판단 근거 = one grammar below (the lint grammar) /
// 수복 = the per-module splitters are gone; a format fix lands here once.
//
// Grammar (the lint grammar, now shared):
//   · a card starts at `## K-<SEAT>[-<SUB>]-<N>` followed by end of line, whitespace, `:` or `—`; a caller that names
//     its seat (`seatKnowhowCards`) also reads hyphenated loop-agent seats (`K-JUDGE-BUTLER-001`);
//   · a card ends at the next `#` or `##` heading outside a code fence — `###` subsections (`### 처방: …`) stay
//     inside the card (RFC v2 cards use them); the export lint asks for `endAtAnyHeading` and stops at every heading;
//   · a `##` heading that looks like `K-…` but breaks the grammar (e.g. `## K-OP-7a`) is `malformed`, never a card;
//   · a field is a bullet line `- 라벨: 값` (or `* 라벨: 값`); the label runs to the first colon;
//   · 상태 = the explicit `- 상태:` field, else an inline `상태:` inside a field (출처 first) — its first ASCII word,
//     so `active.` / `active(로직 착지 전)` read as `active`; no 상태 at all stays '' (never assumed active);
//   · 종류 = explicit `- 종류:` field, else inline `종류:` — one of KNOWHOW_KINDS, else 'fact';
//   · 검증 = the LAST `- 검증:` field: `YYYY-MM-DD 참` / `거짓` / `못잼`; a later malformed line clears an earlier «참».

export type KnowhowKind = 'fact' | 'warning' | 'heuristic' | 'playbook' | 'case';

/** Half-life per kind in days (RFC-seat-knowhow-packs §A1) — case never expires. */
export const KNOWHOW_HALF_LIFE_DAYS: Record<KnowhowKind, number> = {
  fact: 14,
  warning: 30,
  heuristic: 90,
  playbook: 60,
  case: Number.POSITIVE_INFINITY,
};

/** Card heading — `## K-<자리>[-<갈래>]-<번호>` then end of line · whitespace · colon · em dash. */
export const KNOWHOW_CARD_HEADING = /^[ \t]{0,3}##\s+(K-([A-Za-z]+)(?:-([A-Za-z]{1,4}))?-(\d+))(?=$|\s|:|—)(.*)$/u;
/** A `##` heading that looks like a card but breaks the grammar (e.g. `## K-OP-7a`). */
export const KNOWHOW_CARD_HEADING_LIKE = /^[ \t]{0,3}##\s*(K-[^\s:]*)/iu;
const SECTION_HEADING = /^[ \t]{0,3}#{1,2}(?!#)/u;
const ANY_HEADING = /^[ \t]{0,3}#/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FIELD = /^[ \t]*[-*][ \t]*([^:\r\n]+):[ \t]*(.*)$/u;
const STATUS_WORD = /^([A-Za-z][A-Za-z-]*)/u;
const INLINE_STATUS = /(?:^|[\s·，,;|(])상태:\s*([A-Za-z][A-Za-z-]*)/u;
const INLINE_KIND = /(?:^|[\s·，,;|(])종류:\s*([A-Za-z]+)/u;
// 참/거짓 뒤 경계는 \b 대신 명시적 뒷자리 제한 — \w 가 ASCII 한정이라 참(한글) 뒤에서 \b 가 경계로 안 센다.
const VERIFIED_TRUE = /^\s*(\d{4}-\d{2}-\d{2})\s*참(?![^\s(·])/u;
const VERIFIED_FALSE = /^\s*(\d{4}-\d{2}-\d{2})\s*거짓(?![^\s(·])/u;
const VERIFIED_UNVERIFIABLE = /^\s*(\d{4}-\d{2}-\d{2})\s*못잼/u;

export interface KnowhowField {
  /** Text before the first colon, trimmed — parenthetical kept (`처방(힐링)`). */
  label: string;
  value: string;
  /** 1-based line number in the document. */
  line: number;
}

export interface KnowhowCard {
  /** Full id as written, e.g. `K-OP-012` · `K-OP-PR-01`. */
  id: string;
  /** Seat segment as written (`OP`). */
  seat: string;
  /** Optional sub-track segment (`PR` in `K-OP-PR-01`), null when absent. */
  sub: string | null;
  num: number;
  /** Heading text after the id, leading `:`/`—`/spaces removed. */
  title: string;
  /** 1-based heading line. */
  line: number;
  /** Heading line ⊕ body, trimmed — what a pack injects. */
  text: string;
  /** Body lines (after the heading) with their 1-based line numbers. */
  lines: Array<[number, string]>;
  /** Body lines outside code fences (fence markers excluded) — fields are read from these only. */
  prose: Array<[number, string]>;
  fields: KnowhowField[];
  /** Declared 상태 word — '' when the card declares none. */
  status: string;
  kind: KnowhowKind;
  kindDeclared: boolean;
  /** Last 검증 line: true = 참 · false = 거짓 · null = 못잼 / unparsable / none. */
  verified: boolean | null;
  verifiedAt: Date | null;
  /** Whether any 검증 line exists (a malformed one included). */
  hasVerification: boolean;
}

export interface KnowhowMalformed {
  line: number;
  /** The id-ish token, e.g. `K-OP-7a`. */
  id: string;
}

export interface KnowhowDoc {
  cards: KnowhowCard[];
  malformed: KnowhowMalformed[];
}

function isKind(value: string): value is KnowhowKind {
  return Object.prototype.hasOwnProperty.call(KNOWHOW_HALF_LIFE_DAYS, value);
}

function calendarDate(isoDay: string): Date | null {
  const date = new Date(`${isoDay}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === isoDay ? date : null;
}

/** Parse one `- 라벨: 값` bullet; null when the line is not a field. */
export function parseKnowhowField(line: string): { label: string; value: string } | null {
  const m = line.match(FIELD);
  if (!m) return null;
  const label = m[1]!.trim();
  if (!label) return null;
  return { label, value: m[2]!.trim() };
}

/** First non-empty field value whose label matches; '' when none. */
export function knowhowField(card: Pick<KnowhowCard, 'fields'>, label: RegExp | string): string {
  for (const field of card.fields) {
    const hit = typeof label === 'string' ? field.label === label : label.test(field.label);
    if (hit && field.value) return field.value;
  }
  return '';
}

function deriveStatus(fields: readonly KnowhowField[]): string {
  const explicit = [...fields].reverse().find(f => f.label === '상태'); // the last explicit 상태 line wins
  if (explicit) return explicit.value.match(STATUS_WORD)?.[1] ?? '';
  const ordered = [...fields.filter(f => f.label === '출처'), ...fields.filter(f => f.label !== '출처')];
  for (const field of ordered) {
    const m = field.value.match(INLINE_STATUS);
    if (m) return m[1]!;
  }
  return '';
}

function deriveKind(fields: readonly KnowhowField[]): KnowhowKind | null {
  const explicit = fields.find(f => f.label === '종류');
  const word = explicit?.value.match(/^([A-Za-z]+)/u)?.[1];
  if (word && isKind(word)) return word;
  for (const field of fields) {
    const m = field.value.match(INLINE_KIND);
    if (m && isKind(m[1]!)) return m[1] as KnowhowKind;
  }
  return null;
}

function deriveVerification(fields: readonly KnowhowField[]): { verified: boolean | null; verifiedAt: Date | null; has: boolean } {
  let verified: boolean | null = null;
  let verifiedAt: Date | null = null;
  let has = false;
  for (const field of fields) {
    if (field.label !== '검증') continue;
    // A later verification line supersedes the earlier one even when malformed.
    has = true;
    verified = null;
    verifiedAt = null;
    const t = field.value.match(VERIFIED_TRUE);
    const f = field.value.match(VERIFIED_FALSE);
    const u = field.value.match(VERIFIED_UNVERIFIABLE);
    if (t) { verified = true; verifiedAt = calendarDate(t[1]!); }
    else if (f) { verified = false; verifiedAt = calendarDate(f[1]!); }
    else if (u) { verified = null; verifiedAt = calendarDate(u[1]!); }
  }
  return { verified, verifiedAt, has };
}

function buildCard(heading: RegExpMatchArray, headingLine: string, line: number, lines: Array<[number, string]>,
  prose: Array<[number, string]>): KnowhowCard {
  const fields: KnowhowField[] = [];
  for (const [n, text] of prose) {
    const field = parseKnowhowField(text);
    if (field) fields.push({ ...field, line: n });
  }
  const kind = deriveKind(fields);
  const v = deriveVerification(fields);
  return {
    id: heading[1]!,
    seat: heading[2]!,
    sub: heading[3] ?? null,
    num: Number(heading[4]),
    title: heading[5]!.replace(/^[:\s—]+/u, '').trim(),
    line,
    text: [headingLine, ...lines.map(([, l]) => l)].join('\n').trim(),
    lines,
    prose,
    fields,
    status: deriveStatus(fields),
    kind: kind ?? 'fact',
    kindDeclared: kind !== null,
    verified: v.verified,
    verifiedAt: v.verifiedAt,
    hasVerification: v.has,
  };
}

/** Split a KNOWHOW document into cards (grammar above). Never throws; malformed headings are returned, not cards. */
export function parseKnowhowDoc(body: string, opts: { endAtAnyHeading?: boolean; seat?: string; allSeats?: boolean } = {}): KnowhowDoc {
  const ends = opts.endAtAnyHeading ? ANY_HEADING : SECTION_HEADING;
  // A named seat may itself carry hyphens (loop agents: `K-JUDGE-BUTLER-001`), which the generic grammar cannot split.
  const seatHeading = opts.seat
    ? new RegExp(`^[ \\t]{0,3}##\\s+(K-(${opts.seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?:-([A-Za-z]{1,4}))?-(\\d+))(?=$|\\s|:|—)(.*)$`, 'iu')
    : null;
  const cards: KnowhowCard[] = [];
  const malformed: KnowhowMalformed[] = [];
  let open: { heading: RegExpMatchArray; headingLine: string; line: number; lines: Array<[number, string]>;
    prose: Array<[number, string]> } | null = null;
  let fence: { marker: string; length: number } | null = null;
  const close = (): void => {
    if (open) cards.push(buildCard(open.heading, open.headingLine, open.line, open.lines, open.prose));
    open = null;
  };
  for (const [index, line] of body.split(/\r?\n/u).entries()) {
    const n = index + 1;
    const fenceLine = line.match(FENCE);
    if (fence) {
      if (fenceLine && fenceLine[1]![0] === fence.marker && fenceLine[1]!.length >= fence.length
        && /^[ \t]*$/u.test(fenceLine[2]!)) fence = null;
      open?.lines.push([n, line]);
      continue;
    }
    if (fenceLine) {
      fence = { marker: fenceLine[1]![0]!, length: fenceLine[1]!.length };
      open?.lines.push([n, line]);
      continue;
    }
    const heading = (seatHeading ? line.match(seatHeading) : null)
      ?? (opts.allSeats ? line.match(/^[ \t]{0,3}##\s+(K-([A-Za-z]+(?:-[A-Za-z]+)*)(?:-([A-Za-z]{1,4}))?-(\d+))(?=$|\s|:|—)(.*)$/u) : null)
      ?? line.match(KNOWHOW_CARD_HEADING);
    if (heading) {
      close();
      open = { heading, headingLine: line, line: n, lines: [], prose: [] };
      continue;
    }
    if (ends.test(line)) {
      const like = line.match(KNOWHOW_CARD_HEADING_LIKE);
      if (like) malformed.push({ line: n, id: like[1]! });
      close();
      continue;
    }
    open?.lines.push([n, line]);
    open?.prose.push([n, line]);
  }
  close();
  return { cards, malformed };
}

/** Cards of one seat (case-insensitive; hyphenated seats such as `JUDGE-BUTLER` included).
 *  `withSub` keeps `K-<SEAT>-<SUB>-<N>` cards too (default false). */
export function seatKnowhowCards(body: string, seat: string, opts: { withSub?: boolean } = {}): KnowhowCard[] {
  const want = seat.toUpperCase();
  return parseKnowhowDoc(body, { seat }).cards.filter(c => c.seat.toUpperCase() === want && (opts.withSub || c.sub === null));
}
