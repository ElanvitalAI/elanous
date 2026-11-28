// SIM-WORLD supervisors — DECISION-TO-BUS-AUTO (0.3.40 P0 · CEO 11-28 20:4x «구조화»: several evening CEO decisions lived only in
// the ledger / a docs change log / mail and eln OP acted against them). One scene drives the REAL pieces over a universe:
// the decisions ledger (raise → decide — its decide path posts the pointer) · the `eln decisions crown` record fields
// (crownRecordInput → importRecorded → pointDecisionToBus) · a REAL git repo whose first-parent commits add «변경 이력» rows
// to 내부 문서 `*` · the sweep (legacy = the kit's syncDecisionBus · graph = the trigger node decisionBusSync with the
// node input read from graphs/triggers/decision-bus.yaml) · the HQ bus files · OP's seat digest (seatBusDigests over the
// default org) · the msg ledger card. Nothing is faked. Five seeds, both engines. Expectations are independent literals (rule 11).
//   DECISION-BUS-TWO-SOURCES  ledger 2 ⊕ doc rows 3 → HQ pointers 5 · rerun → 0 new · OP digest carries all 5 · not acked
//                             for 25 h → OP card 1 · rerun → still 1 · ack → a later sweep cards nothing
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DecisionLedger } from '../../../decisions/decision-ledger.js';
import { gitAt, type GitRun } from '../../../git-fs/smart-run.js';
import { crownRecordInput, decisionBusPolicyOf, pointDecisionToBus, syncDecisionBus, type DecisionBusReport } from '../../../kit/decision-bus/index.js';
import { decisionBusSync } from '../../../loops/trigger-nodes.js';
import { busDigest, readBus } from '../../../op-context-bus/bus.js';
import { ackSeatDigests, seatBusDigests } from '../../../op-context-bus/seat-turn.js';
import { busSpacesForSeat } from '../../../op-context-bus/spaces.js';
import { openMsgStore } from '../../../msg/msg-store.js';
import { DEFAULT_ORG } from '../../../org/org-map.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = join(import.meta.dir, '..', '..', '..', '..');
const NOW = new Date('2026-11-28T12:00:00.000Z');
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const ID = ['-c', 'user.name=sim', '-c', 'user.email=sim@elanous.local', '-c', 'commit.gpgsign=false'];
const versions = () => ({ released: '0.3.39', dev: '0.3.40-dev.0', codename: null });
/** The real trigger node input (one place for every number). */
const nodeInput = (): Record<string, unknown> => {
  const g = parse(readFileSync(join(REPO, 'graphs', 'triggers', 'decision-bus.yaml'), 'utf8')) as { nodes: Array<{ input?: Record<string, unknown> }> };
  return g.nodes.find((n) => n.input)!.input!; // the one node with an input = the sweep
};

const DOC = 'docs/conductor/SIM-PLAN.md';
const LOG_HEAD = '## 8b. 변경 이력 (11-28)\n\n| 시각 | 무엇이 바뀌었나 | 왜(\u{1F451} 원문) | 문서 어디 |\n|---|---|---|---|\n';
const MAP = '## 9. 칸 지도\n\n| 칸 | 주인 |\n|---|---|\n| MAP-ROW-1 | OP |\n';
const rowA = (s: number) => `| 19:1x | 문서 먼저 s${s} | «문서 먼저» | §7a |\n`;
const rowB = (s: number) => `| 19:3x | 시뮬 상품 우산 s${s} | «시뮬 월드 = 경쟁력» | §8 |\n`;
const rowC = (s: number) => `| 19:4x | 다음 주 = 두 축 s${s} | «다음 주는 워커 통합의 주» | §8 · §9 |\n`;

/** main: M0 (doc with no log rows · 3 h ago) → M1 (+ rows A B · 2 h ago) → M2 (+ row C · a «칸 지도» row · a file outside docs · 1 h ago) → M3 (prose only · 30 min ago). */
function repo(dir: string, seed: number): { git: GitRun; m2: string; m1: string } {
  mkdirSync(join(dir, 'docs', 'conductor'), { recursive: true });
  const git = gitAt(dir, { timeoutMs: 30_000 });
  const must = (args: string[], at?: Date): string => {
    const env = at ? { GIT_AUTHOR_DATE: at.toISOString(), GIT_COMMITTER_DATE: at.toISOString() } : undefined;
    const r = git(args, env ? { env } : {}); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`); return r.stdout.trim();
  };
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
  const put = (text: string) => writeFileSync(join(dir, DOC), text);
  const commit = (msg: string, at: Date) => { must(['add', '-A']); must([...ID, 'commit', '-q', '-m', msg], at); return must(['rev-parse', 'HEAD']); };
  must(['init', '-q', '-b', 'main']);
  put(`# SIM PLAN s${seed}\n\n본문.\n\n${LOG_HEAD}\n${MAP}`); commit('docs: plan', ago(180));
  put(`# SIM PLAN s${seed}\n\n본문.\n\n${LOG_HEAD}${rowA(seed)}${rowB(seed)}\n${MAP}`); const m1 = commit('docs: rows A B', ago(120));
  put(`# SIM PLAN s${seed}\n\n본문.\n\n${LOG_HEAD}${rowA(seed)}${rowB(seed)}${rowC(seed)}\n${MAP}| MAP-ROW-2 | MK |\n`);
  writeFileSync(join(dir, 'README.md'), `| 변경 이력 | outside docs s${seed} |\n`); const m2 = commit('docs: row C', ago(60));
  put(`# SIM PLAN s${seed}\n\n본문 고침.\n\n${LOG_HEAD}${rowA(seed)}${rowB(seed)}${rowC(seed)}\n${MAP}| MAP-ROW-2 | MK |\n`); commit('docs: prose', ago(30));
  return { git, m1, m2 };
}

async function sweep(engine: SimWorldEngine, stateRoot: string, git: GitRun, now: Date): Promise<DecisionBusReport> {
  if (engine === 'legacy') {
    return syncDecisionBus({ stateRoot, policy: { ...decisionBusPolicyOf(nodeInput()), ref: 'main' }, now, git,
      decisions: () => new DecisionLedger({ stateDir: stateRoot, resolveVersion: versions }).list({ status: 'decided' }) });
  }
  const out = await decisionBusSync({ runId: 'sim', input: { stage: 'live', window: now.toISOString(), vars: { stateRoot, seatState: join(stateRoot, 'seat-state') } } as never,
    nodeInput: { ...nodeInput(), ref: 'main' } }, { now, git });
  return out as unknown as DecisionBusReport;
}

async function twoSources(ctx: SimWorldScenarioContext, seed: number, engine: SimWorldEngine): Promise<SimWorldScenarioOutcome | null> {
  const tag = `decision-bus-${engine}-s${seed}`;
  const stateRoot = join(ctx.universeRoot, tag, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const { git, m1, m2 } = repo(join(ctx.universeRoot, tag, 'repo'), seed);
  // ledger source ①: a card decided through the ledger's own decide path (its pointer is posted there and then)
  const ledger = new DecisionLedger({ stateDir: stateRoot, now: () => new Date(NOW.getTime() - 50 * 60_000), resolveVersion: versions });
  const card = ledger.raise({ title: `인프라 칸 주인 s${seed}`, category: 'scope', scqa: { s: '인프라 칸 주인이 비었다', c: 'MK 는 문서 P0 전담이다' },
    options: [{ key: 'a', label: 'TC 로', consequence: 'MK 는 문서만' }, { key: 'b', label: 'MK 로', consequence: '문서 P0 지연' }],
    recommendation: { option: 'a', why: 'MK 문서 전담' }, raisedBy: { agent: 'OP' } });
  const decided = ledger.decide(card.id, 'a', { kind: 'auto', agent: 'OP', delegation: '\u{1F451} 19:1x MK = 문서 P0 전담' }, `MK 는 문서 전담 s${seed}`);
  // ledger source ②: `eln decisions crown` — the same fields the CLI builds, then the same shared pointer function
  const relay = crownRecordInput({ summary: `발행은 REL 이 · TC 아님 s${seed}`, quote: `발행은 TC 에 넘기지 마세요 s${seed}`, at: new Date(NOW.getTime() - 40 * 60_000).toISOString(), doc: 'docs/conductor/SIM-PLAN.md §8b', seat: 'CLAUDE-OP' });
  const recorder = new DecisionLedger({ stateDir: stateRoot, now: () => new Date(NOW.getTime() - 40 * 60_000), resolveVersion: versions });
  const crown = recorder.importRecorded(relay.input, undefined, { kind: 'imported', source: relay.source }, relay.note);
  pointDecisionToBus(stateRoot, crown, 'HQ', 'OP', NOW.getTime() - 40 * 60_000);
  const hq = () => readBus(stateRoot, 'HQ').filter((i) => i.type === 'decision' && i.from === 'DECISIONS');
  if (hq().length !== 2) return fail('ledger-path', `${tag}: HQ pointers after the two ledger records = ${hq().length} (want 2)`);

  const first = await sweep(engine, stateRoot, git, NOW);
  const items = hq();
  if (items.length !== 5) return fail('five', `${tag}: HQ pointers = ${items.length} (want 5) · ${first.line}`);
  if (first.ledger.posted !== 0 || first.ledger.duplicate !== 2 || first.docs.posted !== 3 || first.docs.rows !== 3)
    return fail('first-sweep', `${tag}: ledger +${first.ledger.posted}=${first.ledger.duplicate} docs +${first.docs.posted} rows ${first.docs.rows} (want ledger +0=2 · docs +3 rows 3)`);
  const bodies = items.map((i) => i.body);
  const want = [
    `\u{1F451} 결정 ${decided.id} · 인프라 칸 주인 s${seed} → a: TC 로 · 위임 OP · «MK 는 문서 전담 s${seed}» · 정본 eln decisions show ${decided.id}`,
    `\u{1F451} 결정 ${crown.id} · 발행은 REL 이 · TC 아님 s${seed} · \u{1F451} 원문 중계 · «발행은 TC 에 넘기지 마세요 s${seed}» · 정본 docs/conductor/SIM-PLAN.md §8b`,
    `\u{1F451} 결정(문서 이력) · 19:1x · 문서 먼저 s${seed} · §7a · «문서 먼저» · 정본 ${DOC} §8b. 변경 이력 (11-28) @${m1.slice(0, 12)}`,
    `\u{1F451} 결정(문서 이력) · 19:3x · 시뮬 상품 우산 s${seed} · §8 · «시뮬 월드 = 경쟁력» · 정본 ${DOC} §8b. 변경 이력 (11-28) @${m1.slice(0, 12)}`,
    `\u{1F451} 결정(문서 이력) · 19:4x · 다음 주 = 두 축 s${seed} · §8 · §9 · «다음 주는 워커 통합의 주» · 정본 ${DOC} §8b. 변경 이력 (11-28) @${m2.slice(0, 12)}`,
  ];
  if (JSON.stringify(bodies) !== JSON.stringify(want)) return fail('bodies', `${tag}: ${JSON.stringify(bodies)}\nwant ${JSON.stringify(want)}`);

  const again = await sweep(engine, stateRoot, git, new Date(NOW.getTime() + 10 * 60_000));
  if (hq().length !== 5 || again.ledger.posted + again.docs.posted !== 0) return fail('rerun', `${tag}: rerun added ${again.ledger.posted + again.docs.posted} · HQ ${hq().length} (want +0 · 5)`);

  // delivery: what `eln bus digest --for OP --space HQ` prints ⊕ eln OP's turn digest (own space ⊕ HQ for a coordinator)
  const cli = busDigest(stateRoot, { forSeat: 'OP' }, 'HQ');
  if (!items.every((i) => cli.includes(i.id))) return fail('cli-digest', `${tag}: digest misses ids · ${cli}`);
  const spaces = busSpacesForSeat('OP', DEFAULT_ORG);
  if (!spaces.some((s) => s.space === 'HQ' && s.view === 'full')) return fail('op-spaces', `${tag}: OP spaces ${JSON.stringify(spaces)} (want HQ full)`);
  const turn = seatBusDigests(stateRoot, { seat: 'OP', now: NOW.getTime(), spaces });
  const hqBlock = turn.blocks.find((b) => b.space === 'HQ')?.text ?? '';
  if (!hqBlock.includes('할 일(소화됨):')) return fail('turn-todo', `${tag}: OP's HQ block does not list the pointers as 할 일 · ${hqBlock}`);
  if (!items.every((i) => JSON.stringify(turn).includes(i.id))) return fail('turn-digest', `${tag}: OP turn digest misses ids`);

  // unread 25 h → one OP card · a rerun → still one
  const later = new Date(NOW.getTime() + 25 * 3_600_000);
  const s3 = await sweep(engine, stateRoot, git, later);
  const s4 = await sweep(engine, stateRoot, git, new Date(later.getTime() + 10 * 60_000));
  const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
  let cards: number;
  try { cards = (store.db.query(`SELECT COUNT(*) AS n FROM msg_messages WHERE sender = 'DECISIONS' AND recipient = 'OP'`).get() as { n: number }).n; } finally { store.close(); }
  if (s3.card.overdue !== 5 || cards !== 1 || s4.card.messageId !== s3.card.messageId) return fail('unread-card', `${tag}: overdue ${s3.card.overdue} cards ${cards} ids ${s3.card.messageId}/${s4.card.messageId} (want 5 · 1 · same)`);
  // eln OP's turn acks its digest (the read cursor) → nothing overdue on a later sweep
  const acked = ackSeatDigests(stateRoot, 'OP', turn);
  if (!acked.includes('HQ')) return fail('turn-ack', `${tag}: OP turn acked ${JSON.stringify(acked)} (want HQ among them)`);
  const s5 = await sweep(engine, stateRoot, git, new Date(later.getTime() + 20 * 60_000));
  if (s5.card.overdue !== 0) return fail('after-ack', `${tag}: overdue after ack ${s5.card.overdue} (want 0)`);
  ctx.recorder.event('decision-bus:two-sources', { seed, engine, pointers: 5, card: s3.card.messageId });
  return null;
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'DECISION-BUS-TWO-SOURCES',
    title: '\u{1F451} decisions from two canons (ledger 2 ⊕ docs change-log rows 3) → 5 HQ bus pointers · rerun +0 · OP digest carries them · unread 25 h → OP card 1 · ack → 0',
    async run(ctx) {
      for (const seed of [0, 1, 2, 3, 4].map((i) => ctx.seed + i)) { const out = await twoSources(ctx, seed, ctx.engine); if (out) return out; }
      ctx.recorder.event('decision-bus:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5 });
      return { ok: true };
    },
  },
];
