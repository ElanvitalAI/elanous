// DEC-TG(대표 10-02 07:1x) — «밖에 있어도 주요 결정을 텔레그램·디스코드로 다 끝낸다».
// `elanous decisions raise` 로 올라온 결정 → 대표 DM 카드(SCQA 요약 ⊕ 선택지 버튼 ⊕ 메모 달기) → 누르면 CLI `decide` 와 같은
// 원장 메서드로 기록 → 올린 자리에 회신 → 카드는 «결정됨: A · 시각»으로 바뀐다.
// ⛔ 보안: 버튼은 대표 id 만 받는다(그 밖은 무시 ⊕ 관측). 되돌릴 수 없는 범주(결제·외부 게시·보안·비가역)는 «되돌릴 수 없음» ⊕ 두 번 확인.
// 플랫폼(텔레그램·디스코드)은 `CardTransport` 하나만 구현한다 — 판단은 전부 여기 있다.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { readPendingQuestions } from '../ask-user-question/pending-questions.js';
import { DecisionLedger, type DecisionEntry } from './decision-ledger.js';

export type CardPlatform = 'telegram' | 'discord' | 'webpush';
export interface CardButton { label: string; data: string }
export interface CardView { text: string; buttons: CardButton[][] }
export interface CardRef { chat: string; message: string }

/** What a platform must provide. Every method is best-effort; failures are observed, never thrown to the poller. */
export interface CardTransport {
  platform: CardPlatform;
  /** Owner DM destinations (Telegram chat id = user id for a DM; Discord DM channel id). */
  ownerChats(): Promise<string[]>;
  send(chat: string, view: CardView): Promise<CardRef | null>;
  edit(ref: CardRef, view: CardView): Promise<void>;
  /** Plain text (reminders, list replies). */
  notify(chat: string, text: string): Promise<void>;
}

const IRREVERSIBLE = new Set(['money', 'publish', 'security', 'irreversible', 'secret']);
export const DECISION_DATA_PREFIX = 'dec:';
const REMIND_BEFORE_MS = 2 * 3600_000;

export function isIrreversible(entry: Pick<DecisionEntry, 'category'>): boolean {
  return IRREVERSIBLE.has(entry.category);
}

const kst = (at: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));

/** The card opens with a short pitch; the full question and choice buttons remain below it. */
export function renderCardText(e: DecisionEntry, extra: { note?: string; confirm?: string } = {}): string {
  const recommendedKey = 'option' in e.recommendation ? e.recommendation.option : undefined;
  const recommended = e.options.find(o => o.key === recommendedKey);
  const alternative = e.options.find(o => o.key === e.alternative);
  const lines = [
    `🗳 결정 요청 ${e.id}${isIrreversible(e) ? ' · ⚠️ 되돌릴 수 없음' : ''}`,
    `«${e.title}» · 올린 자리: ${e.raisedBy.agent}${e.raisedBy.track ? `(${e.raisedBy.track})` : ''}`,
    '',
    `S: ${e.scqa.s.replace(/\s+/g, ' ')}`,
    `C: ${e.scqa.c.replace(/\s+/g, ' ')}`,
    `Q: ${(e.scqa.q ?? '(비움)').replace(/\s+/g, ' ')}`,
    `A: ${(e.scqa.a ?? '(비움)').replace(/\s+/g, ' ')}`,
    'skipped' in e.recommendation ? `권고 없음: ${e.recommendation.reason}` : `권고: ${recommended?.label ?? e.recommendation.option} — ${e.recommendation.why}`,
    ...(alternative ? [`대안: ${alternative.label} — ${alternative.consequence}`] : []),
    e.crossCheck?.length ? `교차 확인: ${e.crossCheck.map(check => `${check.seat} ✓ ${check.note.replace(/\s+/g, ' ')}`).join(' · ')}` : `교차 확인 없음(${e.crossCheckSkipped ?? '미기재'})`,
    ...(e.dissent ? [`이견: ${e.dissent}`] : []),
    ...(e.dueAt ? [`기한: ${kst(e.dueAt)} KST`] : []),
    ...(e.pendingQuestion ? ['', `대기 질문 전문:\n${e.pendingQuestion}`] : []),
    '',
    ...e.options.map((o) => `${o.key.toUpperCase()}) ${o.label} — ${o.consequence}`),
    ...(extra.note ? ['', `📝 메모: ${extra.note}`] : []),
  ];
  if (extra.confirm) {
    const option = e.options.find((o) => o.key === extra.confirm);
    lines.push('', `⚠️ ${extra.confirm.toUpperCase()}) ${option?.label ?? ''} — 되돌릴 수 없습니다. 정말 이것으로 정할까요?`);
  }
  return lines.join('\n');
}

export function renderCard(e: DecisionEntry, extra: { note?: string; confirm?: string } = {}): CardView {
  const text = renderCardText(e, extra);
  if (e.status === 'decided') {
    const option = e.options.find((o) => o.key === e.choice);
    return { text: `${text}\n\n✅ 결정됨: ${e.choice?.toUpperCase() ?? '?'}) ${option?.label ?? ''} · ${e.decidedAt ? kst(e.decidedAt) : ''}${e.note ? `\n📝 ${e.note}` : ''}`, buttons: [] };
  }
  if (e.status === 'withdrawn') return { text: `${text}\n\n↩️ 철회됨${e.withdrawReason ? `: ${e.withdrawReason}` : ''}`, buttons: [] };
  if (extra.confirm) {
    return { text, buttons: [[
      { label: `✅ 예, ${extra.confirm.toUpperCase()} 로 정한다`, data: `${DECISION_DATA_PREFIX}${e.id}:${extra.confirm}:ok` },
      { label: '취소', data: `${DECISION_DATA_PREFIX}${e.id}:-` },
    ]] };
  }
  const choices = e.options.map((o) => ({ label: Array.from(`${o.key.toUpperCase()}) ${o.label}`).slice(0, 60).join(''), data: `${DECISION_DATA_PREFIX}${e.id}:${o.key}` }));
  const rows: CardButton[][] = [];
  for (let i = 0; i < choices.length; i += 2) rows.push(choices.slice(i, i + 2));
  rows.push([{ label: '📝 메모 달기', data: `${DECISION_DATA_PREFIX}${e.id}:memo` }]);
  return { text, buttons: rows };
}

export type ParsedTap = { id: string; action: 'choose'; key: string; confirmed: boolean } | { id: string; action: 'memo' } | { id: string; action: 'cancel' };

export function parseTap(data: string): ParsedTap | null {
  const m = /^dec:(D-\d{8}-\d+):([a-z]|memo|-)(:ok)?$/.exec(data);
  if (!m) return null;
  if (m[2] === 'memo') return { id: m[1]!, action: 'memo' };
  if (m[2] === '-') return { id: m[1]!, action: 'cancel' };
  return { id: m[1]!, action: 'choose', key: m[2]!, confirmed: Boolean(m[3]) };
}

interface CardState {
  /** First start of this platform's service — decisions raised before it are not pushed (no burst of old items at
   *  deploy); they stay reachable through `/decisions`. */
  since?: string;
  cards: Record<string, { refs: CardRef[]; closed?: boolean; remindedAt?: string; note?: string }>;
}

export interface DecisionCardServiceOptions {
  transport: CardTransport;
  /** Owner user ids for this platform — taps from anyone else are refused and observed. */
  ownerIds: readonly string[];
  ledger?: DecisionLedger;
  pendingQuestions?: typeof readPendingQuestions;
  /** Where this platform keeps which card it sent (one file per platform — the two bots may run in different processes). */
  statePath?: string;
  now?: () => Date;
  /** Tell the seat that raised it. Default: none (observed only). */
  replyToRaiser?: (entry: DecisionEntry, via: CardPlatform) => Promise<void>;
}

export type TapOutcome =
  | { kind: 'refused' } | { kind: 'ignored' } | { kind: 'unknown' }
  | { kind: 'confirm'; view: CardView; toast: string }
  | { kind: 'decided'; view: CardView; toast: string }
  | { kind: 'cancelled'; view: CardView; toast: string }
  | { kind: 'memo-requested'; toast: string }
  | { kind: 'closed'; view: CardView; toast: string };

/** One per platform bot. `tick()` sends new cards, closes decided ones, sends reminders; `tap()` handles a button. */
export class DecisionCardService {
  private readonly ledger: DecisionLedger;
  private readonly statePath: string;
  private readonly now: () => Date;
  constructor(private readonly opts: DecisionCardServiceOptions) {
    this.ledger = opts.ledger ?? new DecisionLedger();
    this.statePath = opts.statePath ?? join(this.ledger.path, '..', `cards-${opts.transport.platform}.json`);
    this.now = opts.now ?? (() => new Date());
  }

  private load(): CardState {
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')) as CardState; } catch { return { cards: {} }; }
  }
  private save(state: CardState): void {
    mkdirSync(join(this.statePath, '..'), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  isOwner(userId: string): boolean { return this.opts.ownerIds.includes(userId); }

  /** Send cards for new open decisions · close cards decided elsewhere · remind two hours before a deadline. */
  async tick(): Promise<{ sent: number; closed: number; reminded: number }> {
    const platform = this.opts.transport.platform;
    const state = this.load();
    let sent = 0; let closed = 0; let reminded = 0;
    let all: DecisionEntry[];
    try { all = this.ledger.list({ status: 'all' }); } catch (error) {
      debug.log('decisions.telegram', 'ledger-unreadable', { platform, reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' });
      return { sent, closed, reminded };
    }
    let dirty = false;
    if (!state.since) { state.since = this.now().toISOString(); dirty = true; debug.log('decisions.telegram', 'baseline', { platform, since: state.since }); }
    // Same state root as the ledger — the H2 answer writer delivers under the ledger's stateDir, so the questions are read there too.
    const pending = this.opts.pendingQuestions ? this.opts.pendingQuestions() : readPendingQuestions({ root: () => join(this.ledger.path, '..', '..') });
    if (pending.ok) {
      const seen = new Set(all.flatMap(entry => entry.resume ? [entry.resume.questionId] : []));
      for (const record of pending.questions) {
        for (const question of record.questions) {
          const data = { questionId: record.id, runId: record.runId };
          if (record.expiresAt && record.expiresAt <= this.now().toISOString()) {
            debug.log('hitl.card-bridge', 'skipped', { ...data, reason: 'expired' });
            continue;
          }
          if (question.impact !== 'high' && question.impact !== 'critical') {
            debug.log('hitl.card-bridge', 'skipped', { ...data, reason: 'impact' });
            continue;
          }
          if (record.questions.length !== 1 || question.options.length < 2 || question.options.length > 4) {
            debug.log('hitl.card-bridge', 'skipped', { ...data, reason: 'options' });
            continue;
          }
          if (seen.has(record.id)) {
            debug.log('hitl.card-bridge', 'dedup', { ...data, decisionId: all.find(entry => entry.resume?.questionId === record.id)?.id, reason: 'already-raised' });
            continue;
          }
          try {
            const keys = ['a', 'b', 'c', 'd'];
            const recommended = question.recommendedIndex;
            const entry = this.ledger.raise({
              title: question.question.split(/\r?\n/, 1)[0]!.slice(0, 120),
              category: question.impact === 'critical' ? 'irreversible' : 'scope',
              scqa: { s: Array.from(question.question.split(/\r?\n/, 1)[0]!).slice(0, 200).join(''), c: 'The requesting run is waiting for this choice.' },
              pendingQuestion: question.question,
              options: question.options.map((option, index) => ({ key: keys[index]!, label: option.label, consequence: option.description })),
              recommendation: recommended !== undefined && Number.isInteger(recommended) && recommended >= 0 && recommended < question.options.length
                ? { option: keys[recommended]!, why: '런이 추천' } : { skipped: true, reason: '추천 없음' },
              raisedBy: { agent: 'harness' },
              resume: { questionId: record.id, ...(record.runId === undefined ? {} : { runId: record.runId }) },
              ...(record.expiresAt ? { dueAt: record.expiresAt } : {}),
            });
            seen.add(record.id);
            all.unshift(entry);
            debug.log('hitl.card-bridge', 'raised', { ...data, decisionId: entry.id });
          } catch (error) {
            debug.log('hitl.card-bridge', 'skipped', { ...data, reason: error instanceof Error ? error.name : 'unknown' });
          }
        }
      }
    } else debug.log('hitl.card-bridge', 'skipped', { reason: 'pending-unreadable' });
    const chats = await this.opts.transport.ownerChats().catch(() => [] as string[]);
    for (const e of all) {
      const card = state.cards[e.id];
      if (e.status === 'open' && !card && e.options.length >= 2 && e.raisedAt !== undefined && e.raisedAt >= state.since) {
        const refs: CardRef[] = [];
        for (const chat of chats) {
          const ref = await this.opts.transport.send(chat, renderCard(e)).catch(() => null);
          if (ref) refs.push(ref);
        }
        if (refs.length) { state.cards[e.id] = { refs }; sent++; }
        debug.log('decisions.telegram', 'card-sent', { platform, id: e.id, category: e.category, chats: chats.length, delivered: refs.length });
        continue;
      }
      if (card && !card.closed && e.status !== 'open') {
        for (const ref of card.refs) await this.opts.transport.edit(ref, renderCard(e)).catch(() => undefined);
        card.closed = true; closed++;
        debug.log('decisions.telegram', 'card-closed', { platform, id: e.id, status: e.status });
        continue;
      }
      if (e.status === 'open' && card && e.dueAt && !card.remindedAt && this.now().getTime() >= Date.parse(e.dueAt) - REMIND_BEFORE_MS) {
        for (const chat of chats) await this.opts.transport.notify(chat, `⏰ 기한 2시간 전 — ${e.id} «${e.title}» (기한 ${kst(e.dueAt)}) · 카드에서 정하거나 /decisions`).catch(() => undefined);
        card.remindedAt = this.now().toISOString(); reminded++;
        debug.log('decisions.telegram', 'reminded', { platform, id: e.id });
      }
    }
    if (dirty || sent || closed || reminded) this.save(state);
    return { sent, closed, reminded };
  }

  /** A button tap. Never throws. */
  async tap(userId: string, data: string): Promise<TapOutcome> {
    const platform = this.opts.transport.platform;
    const parsed = parseTap(data);
    if (!parsed) return { kind: 'ignored' };
    if (!this.isOwner(userId)) {
      debug.log('decisions.telegram', 'tap-refused', { platform, id: parsed.id }, { level: 'warn' });
      return { kind: 'refused' };
    }
    let entry: DecisionEntry;
    try { entry = this.ledger.show(parsed.id); } catch { return { kind: 'unknown' }; }
    const state = this.load();
    const card = state.cards[entry.id];
    if (entry.status !== 'open') return { kind: 'closed', view: renderCard(entry), toast: '이미 정해진 결정입니다' };
    if (parsed.action === 'memo') {
      debug.log('decisions.telegram', 'memo-requested', { platform, id: entry.id });
      return { kind: 'memo-requested', toast: '메모를 보내 주세요 — 다음 메시지가 메모가 됩니다' };
    }
    if (parsed.action === 'cancel') return { kind: 'cancelled', view: renderCard(entry, card?.note ? { note: card.note } : {}), toast: '취소했습니다' };
    if (!entry.options.some((o) => o.key === parsed.key)) return { kind: 'unknown' };
    if (isIrreversible(entry) && !parsed.confirmed) {
      debug.log('decisions.telegram', 'confirm-asked', { platform, id: entry.id, key: parsed.key });
      return { kind: 'confirm', view: renderCard(entry, { confirm: parsed.key, ...(card?.note ? { note: card.note } : {}) }), toast: '되돌릴 수 없는 결정 — 한 번 더 확인해 주세요' };
    }
    let decided: DecisionEntry;
    let answerDelivery: ReturnType<DecisionLedger['decideWithDelivery']>['delivery'] = null;
    try {
      // Same ledger method the CLI `decide` uses — one record path.
      const recorded = this.ledger.decideWithDelivery(entry.id, parsed.key, { kind: 'human' }, card?.note);
      decided = recorded.entry;
      answerDelivery = recorded.delivery;
    } catch (error) {
      debug.log('decisions.telegram', 'decide-failed', { platform, id: entry.id, reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' });
      try { const now = this.ledger.show(entry.id); if (now.status !== 'open') return { kind: 'closed', view: renderCard(now), toast: '이미 정해진 결정입니다' }; } catch { /* fall through */ }
      return { kind: 'unknown' };
    }
    const view = renderCard(decided);
    if (card) {
      for (const ref of card.refs) await this.opts.transport.edit(ref, view).catch(() => undefined);
      card.closed = true;
      this.save(state);
    }
    debug.log('decisions.telegram', 'decided', { platform, id: decided.id, choice: decided.choice, category: decided.category, noted: Boolean(decided.note) });
    await this.opts.replyToRaiser?.(decided, platform).catch((error: unknown) => {
      debug.log('decisions.telegram', 'reply-failed', { platform, id: decided.id, reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' });
    });
    return { kind: 'decided', view, toast: answerDelivery && !answerDelivery.ok
      ? `결정은 기록됐지만 런 답 전달 실패 — decisions retry-answer ${decided.id}`
      : `결정했습니다: ${decided.choice?.toUpperCase()}` };
  }

  /** Store a memo typed after «메모 달기»; the card shows it and the eventual decision carries it. */
  async setNote(userId: string, id: string, note: string): Promise<CardView | null> {
    if (!this.isOwner(userId)) return null;
    let entry: DecisionEntry;
    try { entry = this.ledger.show(id); } catch { return null; }
    const clean = note.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean || entry.status !== 'open') return null;
    const state = this.load();
    const card = state.cards[id] ?? { refs: [] };
    card.note = clean;
    state.cards[id] = card;
    this.save(state);
    const view = renderCard(entry, { note: clean });
    for (const ref of card.refs) await this.opts.transport.edit(ref, view).catch(() => undefined);
    debug.log('decisions.telegram', 'memo-set', { platform: this.opts.transport.platform, id, chars: clean.length });
    return view;
  }

  /** `/decisions` — open decisions as one list; each card is sent again so the buttons are at hand. */
  async listOpen(chat: string): Promise<string> {
    let open: DecisionEntry[];
    try { open = this.ledger.list({ status: 'open' }).filter((e) => e.options.length >= 2); } catch { return '결정 원장을 읽지 못했습니다.'; }
    if (!open.length) return '열린 결정이 없습니다.';
    const state = this.load();
    for (const e of open) {
      const ref = await this.opts.transport.send(chat, renderCard(e, state.cards[e.id]?.note ? { note: state.cards[e.id]!.note } : {})).catch(() => null);
      if (ref) { const card = state.cards[e.id] ?? { refs: [] }; card.refs.push(ref); state.cards[e.id] = card; }
    }
    this.save(state);
    debug.log('decisions.telegram', 'listed', { platform: this.opts.transport.platform, open: open.length });
    return `열린 결정 ${open.length}건 — ${open.map((e) => `${e.id}${e.dueAt ? `(기한 ${kst(e.dueAt)})` : ''}`).join(' · ')}`;
  }
}

/** Reply line for the seat that raised it. Posted to the coordination PR when `decisions.replyGhPr` = "owner/repo#N". */
export function raiserReplyText(e: DecisionEntry, via: CardPlatform): string {
  const option = e.options.find((o) => o.key === e.choice);
  const at = e.decidedAt ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(e.decidedAt)) : '';
  return `**[대표]** ${at} KST → ${e.raisedBy.agent} · 결정 ${e.id} «${e.title}» = ${e.choice?.toUpperCase()}) ${option?.label ?? ''}${e.note ? ` · 메모: ${e.note}` : ''} (${via === 'telegram' ? '텔레그램' : '디스코드'})`;
}

export function ghPrReplier(target: string, run: (args: string[], stdin: string) => Promise<number> = runGh): (e: DecisionEntry, via: CardPlatform) => Promise<void> {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(target.trim());
  return async (e, via) => {
    if (!m) throw new Error('decisions.replyGhPr must be owner/repo#N');
    const code = await run(['pr', 'comment', m[2]!, '--repo', m[1]!, '--body-file', '-'], raiserReplyText(e, via));
    debug.log('decisions.telegram', 'replied', { id: e.id, via, target: 'gh-pr', ok: code === 0 });
    if (code !== 0) throw new Error(`gh exit ${code}`);
  };
}

/** Post as the automation App (not the machine's personal gh login — that would make 대표 a participant and mail them),
 *  with proxy variables removed (they break gh on the ops host). TC review #22660. */
export async function runGh(args: string[], stdin: string): Promise<number> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(https?|all|no)_proxy$/i.test(k)) env[k] = v;
  try {
    const { githubAutomationToken } = await import('../auth/github-app-token.js');
    const token = githubAutomationToken();
    if (token) env.GH_TOKEN = token;
    debug.log('decisions.telegram', 'reply-identity', { app: Boolean(token) });
  } catch { /* falls back to the machine login */ }
  const proc = Bun.spawn(['gh', ...args], { stdin: new Blob([stdin]), stdout: 'ignore', stderr: 'ignore', env });
  return proc.exited;
}
