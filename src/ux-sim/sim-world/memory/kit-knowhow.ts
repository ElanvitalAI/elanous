// SIM-WORLD memory · kit/knowhow — the one KNOWHOW card parser (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-12) and the
// callers moved onto it (seat packs · K3 coordinator pack · export lint), driven over real-shaped and seeded KNOWHOW
// documents. Deterministic, LLM 0, no disk: the generator draws from a PRNG seeded from ctx.seed (never Math.random)
// and records its own ground truth, so a grammar change that flips a card's id or 상태 turns red here.
import { parseKnowhowDoc, type KnowhowDoc } from '../../../kit/knowhow/index.js';
import { parseKnowhowDoc as parseK3Pack } from '../../../loops/orchestrator/knowhow-pack.js';
import { KnowhowLintError, lintKnowhow } from '../../../seat-loop/knowhow-lint.js';
import { parseKnowhowItems } from '../../../seat-loop/seat-knowhow.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const DEVICE = 'KIT-KNOWHOW-PARSER';

interface KitKnowhowDevice {
  readonly kit: (body: string, opts?: { endAtAnyHeading?: boolean }) => KnowhowDoc;
  readonly seatItems: typeof parseKnowhowItems;
  readonly k3: typeof parseK3Pack;
  readonly lint: typeof lintKnowhow;
}

export const simWorldDevices: readonly SimWorldDeviceDef<KitKnowhowDevice>[] = [{
  id: DEVICE,
  title: 'kit/knowhow card parser with its callers (seat packs · K3 coordinator pack · export lint) — pure functions, no disk',
  create: () => ({ kit: parseKnowhowDoc, seatItems: parseKnowhowItems, k3: parseK3Pack, lint: lintKnowhow }),
}];

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── real-shaped literal document (status spellings copied from 내부 문서 `KNOWHOW`) ──────────────────────
const REAL_DOC = [
  '# UX 노하우',
  '',
  '서두 — 카드 아님.',
  '',
  '## K-UX-31 PR 본문 갱신은 리뷰 중에 하지 않는다 (작성 2026-10-12)',
  '- 상황: 리뷰가 도는 PR 의 본문을 고치려 할 때.',
  '- 처방(힐링): 리뷰가 끝난 뒤 고친다.',
  '- 검증: 2026-10-12 참 (UX)',
  '- 출처: 2026-10-12 UX #26634 실측 · 상태: active.',
  '',
  '## K-UX-32 Commander parseAsync (작성 2026-10-14)',
  '- 상태: active. 위 사건의 수치는 2026-10-16 표본이다.',
  '- 검증: 2026-10-14 못잼',
  '',
  '### 2026-10-17 · 겹침 증거의 분기 순서',
  '- 관측: 같은 파일의 다른 hunk.',
  '',
  '## K-UX-7a 잘못된 제목',
  '- 출처: 상태: active',
  '',
  '## 로직화 후보 — 카드 아님',
  '- 출처: 상태: active',
  '',
  '## K-UX-33 울타리 안 제목은 카드가 아니다',
  '```',
  '## K-UX-999 울타리',
  '- 상태: stale',
  '```',
  '- 출처: run-97a23efa · 상태: unproven(운영 live-capture 경로)',
].join('\n');

// ── seeded generator ────────────────────────────────────────────────────────────────────────────────────
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Five generator seeds derived from the run seed. */
export function kitKnowhowSeeds(seed: number): number[] {
  return [0, 1, 2, 3, 4].map((k) => (Math.imul(seed + 1, 2654435761) + k * 40503) >>> 0);
}

interface TruthCard { id: string; seat: string; sub: string | null; status: string; command: boolean }
interface GeneratedDoc { body: string; cards: TruthCard[]; malformed: string[] }

const STATUS_SPELLINGS: ReadonlyArray<[string, string]> = [
  ['active', 'active'], ['active.', 'active'], ['active(로직 착지 전)', 'active'], ['unproven', 'unproven'],
  ['unproven(운영 확인 대기)', 'unproven'], ['stale', 'stale'], ['superseded-by', 'superseded-by'], ['contradicted', 'contradicted'],
];

export function generateKnowhowDoc(seed: number): GeneratedDoc {
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const lines: string[] = ['# 노하우', '', '서두 — 카드 아님.', ''];
  const cards: TruthCard[] = [];
  const malformed: string[] = [];
  const n = 6 + Math.floor(r() * 8);
  let next = 100;
  for (let i = 0; i < n; i++) {
    const seat = pick(['OP', 'OP', 'TC', 'UX']);
    const sub = seat === 'OP' && r() < 0.2 ? 'PR' : null;
    next += 1 + Math.floor(r() * 3);
    const id = `K-${seat}${sub ? `-${sub}` : ''}-${next}`;
    const sep = pick([' ', ': ', ' — ']);
    lines.push(`## ${id}${sep}카드 ${i}`);
    lines.push(`- 상황: 시드 ${seed} 의 ${i} 번째 상황.`);
    if (r() < 0.3) lines.push('### 처방: 세부 사다리', '- 단계: 한 줄씩 탄다.');
    const command = r() < 0.6;
    if (command) lines.push(pick(['- 재는 명령: `eln ops status`', '- 재는 명령: `git status --porcelain`']));
    if (r() < 0.5) lines.push(`- 검증: 2026-10-${String(1 + Math.floor(r() * 28)).padStart(2, '0')} ${pick(['참 (OP)', '거짓', '못잼'])}`);
    let status = '';
    const mode = r();
    if (mode < 0.45) {
      const [spelled, word] = pick(STATUS_SPELLINGS);
      lines.push(`- 출처: 시드 ${seed} · 상태: ${spelled}`);
      status = word;
    } else if (mode < 0.8) {
      const [spelled, word] = pick(STATUS_SPELLINGS);
      lines.push(`- 상태: ${spelled}`, '- 출처: 시드 기록');
      status = word;
    } else {
      lines.push('- 출처: 상태 없는 카드');
    }
    if (r() < 0.2) lines.push('```', '## K-OP-9999 울타리 안', '- 상태: stale', '```');
    lines.push('');
    cards.push({ id, seat, sub, status, command });
    if (r() < 0.25) {
      const bad = `K-${seat}-${next}x`;
      lines.push(`## ${bad} 잘못된 제목`, '- 출처: 상태: active', '');
      malformed.push(bad);
    }
    if (r() < 0.2) lines.push('## 부록 — 카드 아님', '- 출처: 상태: active', '');
  }
  return { body: lines.join(r() < 0.3 ? '\r\n' : '\n'), cards, malformed };
}

const cardId = (text: string) => text.match(/^## (K-[^\s:]+?)(?=$|\s|:|—)/u)?.[1] ?? '';

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'KIT-KNOWHOW-REAL-SHAPES',
    title: 'real KNOWHOW spellings: «active.» / «unproven(…)» read cleanly · ### note stays in its card · malformed and fenced headings are not cards',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<KitKnowhowDevice>(DEVICE);
      const doc = d.kit(REAL_DOC);
      const view = doc.cards.map((c) => [c.id, c.status]);
      ctx.recorder.event('kit-knowhow:real', { cards: view, malformed: doc.malformed });
      const want = [['K-UX-31', 'active'], ['K-UX-32', 'active'], ['K-UX-33', 'unproven']];
      if (!eq(view, want)) return fail('real-shape-misread', `cards ${JSON.stringify(view)} ≠ ${JSON.stringify(want)}`);
      if (!eq(doc.malformed, [{ line: 18, id: 'K-UX-7a' }])) return fail('malformed-missed', JSON.stringify(doc.malformed));
      if (!doc.cards[1]!.text.includes('### 2026-10-17')) return fail('subsection-dropped', 'K-UX-32 lost its ### note');
      const seat = d.seatItems(REAL_DOC, 'UX').map((i) => [cardId(i.text), i.status]);
      if (!eq(seat, want)) return fail('seat-pack-disagrees', JSON.stringify(seat));
      try { d.lint(REAL_DOC, 'docs/roles/UX/KNOWHOW.md'); return fail('lint-accepted-malformed', 'lint passed a doc with K-UX-7a'); }
      catch (error) {
        if (!(error instanceof KnowhowLintError) || !error.message.includes('K-UX-7a')) return fail('lint-wrong-refusal', String(error));
      }
      return { ok: true };
    },
  },
  {
    id: 'KIT-KNOWHOW-GENERATED',
    title: 'five seeded documents: every card id, seat, sub-track and 상태 the generator wrote is what the kit reads; malformed headings are counted',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<KitKnowhowDevice>(DEVICE);
      const rows: Array<Record<string, unknown>> = [];
      for (const seed of kitKnowhowSeeds(ctx.seed)) {
        const g = generateKnowhowDoc(seed);
        const doc = d.kit(g.body);
        const got = doc.cards.map((c) => ({ id: c.id, seat: c.seat, sub: c.sub, status: c.status }));
        const want = g.cards.map((c) => ({ id: c.id, seat: c.seat, sub: c.sub, status: c.status }));
        rows.push({ seed, cards: want.length, malformed: g.malformed.length });
        if (!eq(got, want)) return fail('generated-misread', `seed ${seed}: kit ${JSON.stringify(got)} ≠ truth ${JSON.stringify(want)}`);
        if (!eq(doc.malformed.map((m) => m.id), g.malformed)) return fail('malformed-miscount', `seed ${seed}: ${JSON.stringify(doc.malformed)} ≠ ${JSON.stringify(g.malformed)}`);
      }
      ctx.recorder.event('kit-knowhow:generated', { rows });
      return { ok: true };
    },
  },
  {
    id: 'KIT-KNOWHOW-CALLERS-AGREE',
    title: 'seat packs, the K3 coordinator pack and the export lint read the same cards from the same seeded documents',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<KitKnowhowDevice>(DEVICE);
      for (const seed of kitKnowhowSeeds(ctx.seed)) {
        const g = generateKnowhowDoc(seed);
        for (const seat of ['OP', 'TC', 'UX']) {
          const got = d.seatItems(g.body, seat).map((i) => [cardId(i.text), i.status]);
          const want = g.cards.filter((c) => c.seat === seat && c.sub === null).map((c) => [c.id, c.status]);
          if (!eq(got, want)) return fail('seat-pack-disagrees', `seed ${seed} seat ${seat}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
        }
        const k3 = d.k3(g.body).map((i) => i.id);
        const k3Want = g.cards.filter((c) => c.seat === 'OP' && c.status === 'active' && c.command).map((c) => c.id).sort((a, b) => a.localeCompare(b));
        if (!eq(k3, k3Want)) return fail('k3-pack-disagrees', `seed ${seed}: ${JSON.stringify(k3)} ≠ ${JSON.stringify(k3Want)}`);
        if (g.malformed.length > 0) {
          try { d.lint(g.body, 'docs/roles/OP/KNOWHOW.md'); return fail('lint-accepted-malformed', `seed ${seed}: ${g.malformed[0]}`); }
          catch (error) {
            if (!(error instanceof KnowhowLintError) || !error.message.includes(g.malformed[0]!)) return fail('lint-wrong-refusal', `seed ${seed}: ${String(error)}`);
          }
        }
      }
      ctx.recorder.event('kit-knowhow:callers', { seeds: kitKnowhowSeeds(ctx.seed) });
      return { ok: true };
    },
  },
  {
    id: 'KIT-KNOWHOW-DETERMINISM',
    title: 'same seed ⇒ same document and same parse; the next seed ⇒ another document; CRLF and LF read alike',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<KitKnowhowDevice>(DEVICE);
      const [s0, s1] = kitKnowhowSeeds(ctx.seed);
      const a = generateKnowhowDoc(s0!);
      const b = generateKnowhowDoc(s0!);
      const c = generateKnowhowDoc(s1!);
      if (a.body !== b.body || !eq(d.kit(a.body), d.kit(b.body))) return fail('nondeterministic', `seed ${s0} produced two documents or two parses`);
      if (a.body === c.body) return fail('seed-ignored', `seeds ${s0} and ${s1} produced the same document`);
      const lf = a.body.replace(/\r\n/g, '\n');
      const crlf = lf.replace(/\n/g, '\r\n');
      const pick = (doc: KnowhowDoc) => doc.cards.map((card) => [card.id, card.status, card.kind, card.verified, card.fields.length]);
      if (!eq(pick(d.kit(lf)), pick(d.kit(crlf)))) return fail('crlf-differs', `seed ${s0}: LF and CRLF parse differently`);
      ctx.recorder.event('kit-knowhow:determinism', { s0, s1, cards: a.cards.length });
      return { ok: true };
    },
  },
];
