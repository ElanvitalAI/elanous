import { openSync, closeSync, readFileSync, statSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { judge } from '../llm/judge-layer.js';
import { CardStore, type TaskCard } from '../task-cards/card-store.js';
import { CliUserError } from '../cli/cli-user-error.js';
import { DecisionLedger, type DecisionCategory, type RaiseInput } from '../decisions/decision-ledger.js';
import { listChecklist, type Checklist } from '../release-loop/checklist.js';
import { placeCell, type PlacementCell, type PlacementDecision, type PlacementDeps } from '../release-loop/placement.js';

export type FlowCell = PlacementCell & { falsifier: string };
export type FlowGate = { title: string; text: string; category: 'money' | 'publish' | 'security' | 'irreversible' };
export type FlowSplit = { cells: FlowCell[]; gated: FlowGate[]; fallback: boolean };
export type FlowResult = { cardId: string; cells: number; placements: PlacementDecision[]; unplaced: Array<{ id: string; reason: string }>; decisions: string[]; text: string; duplicate?: boolean };
export interface FlowDeps {
  store?: CardStore;
  judge?: typeof judge;
  place?: typeof placeCell;
  placement?: PlacementDeps;
  raise?: (input: RaiseInput, ref: string) => string;
  reply?: (cardId: string, text: string) => Promise<void>;
}

function log(event: 'split' | 'placed' | 'gated' | 'fallback', data: Record<string, unknown>): void {
  debug.log('flow', event, data);
}

const categories: Array<[RegExp, FlowGate['category']]> = [
  [/결제|구매|송금|지불|payment|purchase|charge|pay\b|transfer money/i, 'money'],
  [/외부\s*게시|공개\s*게시|발행|배포|publish|post publicly/i, 'publish'],
  [/보안|인증|권한|비밀|secret|credential|security/i, 'security'],
  [/되돌릴 수 없|비가역|삭제|폐기|irreversib|permanent delet/i, 'irreversible'],
];
function unsafe(text: string): FlowGate['category'] | undefined {
  return categories.find(([pattern]) => pattern.test(text))?.[1];
}
function portions(text: string): string[] {
  return text.split(/(?:\r?\n|[.!?。！？]\s+|\s+(?:and|then|그리고|및)\s+)/i).map(s => s.trim()).filter(Boolean);
}
function gate(text: string, category: FlowGate['category']): FlowGate {
  return { title: text.split(/\r?\n/, 1)[0]!.slice(0, 100), text, category };
}
function valid(value: unknown): { cells: Array<{ id: string; title: string; owner: string; falsifier: string; predecessors: string[]; priority?: PlacementCell['priority']; deadlineVersion?: string }>; gated: FlowGate[] } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.cells) || !Array.isArray(v.gated) || v.cells.length > 4 || v.cells.length + v.gated.length === 0) return null;
  const cells = v.cells as Array<Record<string, unknown>>;
  if (cells.some(c => !/^[a-zA-Z0-9_-]{1,32}$/.test(String(c.id ?? '')) || typeof c.title !== 'string' || !c.title.trim()
    || !['OP', 'TC', 'MK', 'UX'].includes(String(c.owner)) || typeof c.falsifier !== 'string' || !c.falsifier.trim()
    || !Array.isArray(c.predecessors) || c.predecessors.some(p => typeof p !== 'string')
    || c.priority !== undefined && !['P0', 'P1', 'P2'].includes(String(c.priority))
    || c.deadlineVersion !== undefined && typeof c.deadlineVersion !== 'string')) return null;
  const ids = cells.map(c => c.id as string);
  if (new Set(ids).size !== ids.length || cells.some((c, index) => (c.predecessors as string[]).some(p => !ids.slice(0, index).includes(p)))) return null;
  const gated = v.gated as Array<Record<string, unknown>>;
  if (gated.some(g => typeof g.title !== 'string' || !g.title.trim() || typeof g.text !== 'string' || !g.text.trim() || !categories.some(([, category]) => category === g.category))) return null;
  return v as ReturnType<typeof valid> & { cells: typeof cells; gated: FlowGate[] };
}

function wish(card: TaskCard): { title: string; text: string; source: string; priority: PlacementCell['priority']; deadlineVersion?: string } {
  if (!card.goalId.startsWith('wish:')) throw new CliUserError(`Wish 카드가 아니다: ${card.id}`);
  const sections = card.sections.filter(s => s.key.startsWith('intake:wish:'));
  const raw = sections.at(-1);
  if (!raw) throw new CliUserError(`원문 없는 Wish 카드: ${card.id}`);
  const value = JSON.parse(raw.content) as { source?: string; title?: string; text?: string | null; priority?: string; deadlineVersion?: string };
  const source = value.source && value.source !== 'wish' ? value.source : 'folder';
  const text = value.text?.trim() || (source === 'folder' ? value.title?.trim() : null);
  if (!text) throw new CliUserError(`원문 없는 Wish 카드: ${card.id}`);
  return { title: value.title || card.title, text, source, priority: value.priority === 'P0' || value.priority === 'P1' ? value.priority : 'P2', ...(value.deadlineVersion ? { deadlineVersion: value.deadlineVersion } : {}) };
}

/** Judge decisions are checked independently for sensitive text; a failed classification never schedules a sensitive part. */
export async function splitCard(card: TaskCard, deps: FlowDeps = {}): Promise<FlowSplit> {
  const cached = card.sections.find(s => s.key === 'flow:split:0');
  if (cached) return JSON.parse(cached.content) as FlowSplit;
  const source = wish(card);
  const decision = await (deps.judge ?? judge)({ site: 'flow.split', prompt: `Split this wish into 1-4 small, independently falsifiable release cells. Route owner using existing seats OP (operations), TC (engineering), MK (content), UX (experience). Return JSON only: {"cells":[{"id":"a","title":"...","owner":"TC","falsifier":"one-line check","predecessors":[],"priority":"P2","deadlineVersion":"... only for P1"}],"gated":[{"title":"...","text":"original sensitive part","category":"money|publish|security|irreversible"}]}. Never turn external publishing, payment, security or irreversible actions into cells; split ONLY those parts into gated decisions. Preserve the other parts. Card priority is ${source.priority}${source.deadlineVersion ? `, deadlineVersion ${source.deadlineVersion}` : ''}. Source ${source.source}. Title ${source.title}. Verbatim wish:\n${source.text}`, schema: valid });
  const parsed = decision.ok && decision.value.cells.every(c => (c.priority ?? source.priority) !== 'P1' || Boolean(c.deadlineVersion ?? source.deadlineVersion)) ? decision.value : null;
  const prefix = `FLOW-${card.id.replaceAll('-', '')}`;
  const gated: FlowGate[] = parsed ? [...parsed.gated] : [];
  const risky = portions(source.text).flatMap(part => { const category = unsafe(part); return category ? [gate(part, category)] : []; });
  for (const part of risky) if (!gated.some(g => g.text.includes(part.text.replace(/[.!?。！？]+$/, '')))) gated.push(part);
  const safeParts = portions(source.text).filter(part => !unsafe(part));
  const rawCells = parsed ? parsed.cells : safeParts.length || !risky.length
    ? [{ id: 'a', title: risky.length ? safeParts.join(' ').slice(0, 80) : source.title, owner: 'OP', falsifier: `카드 ${card.id} 원문의 안전한 요구를 확인한다`, predecessors: [] }]
    : [];
  const cells: FlowCell[] = rawCells.filter(c => !unsafe(c.title) && !unsafe(c.falsifier) && !risky.some(part => c.title.includes(part.text)))
    .map(c => ({ id: `${prefix}-${c.id}`, title: c.title, owner: c.owner, falsifier: c.falsifier,
      priority: c.priority ?? source.priority, predecessors: c.predecessors.map(p => `${prefix}-${p}`),
      ...((c.deadlineVersion ?? source.deadlineVersion) ? { deadlineVersion: c.deadlineVersion ?? source.deadlineVersion } : {}) }));
  if (parsed && risky.length && risky.some(part => !parsed.gated.some(g => g.text.includes(part.text.replace(/[.!?。！？]+$/, ''))))) {
    cells.length = 0;
    if (safeParts.length) cells.push({ id: `${prefix}-safe`, title: safeParts.join(' ').slice(0, 80), owner: 'OP', falsifier: `안전한 부분만 검증: ${safeParts.join(' ').slice(0, 100)}`, priority: source.priority, predecessors: [], ...(source.deadlineVersion ? { deadlineVersion: source.deadlineVersion } : {}) });
  }
  if (risky.length) for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.title === source.title && unsafe(source.text)) cells.splice(i, 1);
  const result = { cells, gated, fallback: !parsed };
  if (!parsed) log('fallback', { cardId: card.id, reason: decision.ok ? 'schema' : decision.reason });
  log('split', { cardId: card.id, cells: cells.length, gated: gated.length });
  return result;
}

function decisionInput(card: TaskCard, part: FlowGate): RaiseInput {
  return { title: part.title.slice(0, 120), category: part.category as DecisionCategory,
    scqa: { s: `의뢰 카드 ${card.id}에 다음 작업이 포함됨`, c: `대표 판단 전 자동 판 배치 금지: ${part.category}` },
    pendingQuestion: part.text, options: [
      { key: 'a', label: '승인 후 별도로 진행', consequence: '대표 결정 뒤 별도 집행' },
      { key: 'b', label: '진행하지 않음', consequence: '이 부분의 집행 중지' },
    ], recommendation: { skipped: true, reason: '대표가 직접 판단해야 함' },
    crossCheckSkipped: '자동 안전 분기', raisedBy: { agent: 'flow', track: 'OP' } };
}

/** The only release write is placeCell: per-cell journals allow recovery after a process dies mid-card. */
export async function placeCards(card: TaskCard, split: FlowSplit, deps: FlowDeps = {}, dryRun = false): Promise<FlowResult> {
  const store = deps.store ?? new CardStore();
  const placements: PlacementDecision[] = [], unplaced: FlowResult['unplaced'] = [], decisions: string[] = [];
  const preview = new Map<string, Checklist>();
  const placement: PlacementDeps = { ...deps.placement, dryRun, ...(dryRun ? { checklist: (version: string) => {
    let snapshot = preview.get(version);
    if (!snapshot) { snapshot = structuredClone((deps.placement?.checklist ?? listChecklist)(version)); preview.set(version, snapshot); }
    return snapshot;
  } } : {}) };
  try {
    for (const [index, part] of split.gated.entries()) {
      const key = `flow:gated:${index}`;
      const existing = store.getCard(card.id)?.sections.find(s => s.key === key);
      if (existing) { decisions.push(JSON.parse(existing.content).decisionId as string); continue; }
      if (dryRun) { decisions.push('dry-run'); continue; }
      const ref = `flow:${card.id}:gated:${index}`;
      const decisionId = deps.raise ? deps.raise({ ...decisionInput(card, part), refs: [ref] }, ref)
        : new DecisionLedger({ stateDir: store.root }).raiseOnce({ ...decisionInput(card, part), refs: [ref] }, ref).id;
      store.appendSection(card.id, { key, owner: 'flow', content: JSON.stringify({ decisionId, category: part.category, title: part.title }) });
      decisions.push(decisionId);
      log('gated', { cardId: card.id, decisionId, category: part.category });
    }
    for (const cell of split.cells) {
      const key = `flow:placed:${cell.id}`;
      const existing = store.getCard(card.id)?.sections.find(s => s.key === key);
      if (existing && !dryRun) {
        const saved = JSON.parse(existing.content) as { decision?: PlacementDecision; reason?: string };
        if (saved.decision) placements.push(saved.decision);
        else unplaced.push({ id: cell.id, reason: saved.reason! });
        continue;
      }
      let record: { decision?: PlacementDecision; reason?: string };
      const blockedBy = cell.predecessors.find(id => unplaced.some(item => item.id === id));
      if (blockedBy) {
        record = { reason: `선행 칸 ${blockedBy} 미배치` };
        unplaced.push({ id: cell.id, reason: record.reason! });
        if (!dryRun) store.appendSection(card.id, { key, owner: 'flow', content: JSON.stringify(record) });
        log('placed', { cardId: card.id, id: cell.id, reason: record.reason, dryRun });
        continue;
      }
      try {
        const { falsifier: _falsifier, ...input } = cell;
        const decision = (deps.place ?? placeCell)(input, placement);
        record = { decision };
        placements.push(decision);
        if (dryRun) preview.get(decision.version)?.items.push({ ...input, status: 'yellow', updatedAt: new Date().toISOString(), updatedBy: 'flow' });
        log('placed', { cardId: card.id, id: cell.id, version: decision.version, dryRun });
      } catch (error) {
        if (!(error instanceof CliUserError) || !error.message.includes('배치할 판이 없다')) throw error;
        record = { reason: error.message };
        unplaced.push({ id: cell.id, reason: error.message });
        log('placed', { cardId: card.id, id: cell.id, reason: error.message, dryRun });
      }
      if (!dryRun) store.appendSection(card.id, { key, owner: 'flow', content: JSON.stringify(record) });
    }
    const versions = [...new Set(placements.map(p => p.version))];
    const text = `칸 ${split.cells.length}개 · 판 ${versions.length ? versions.join(', ') : '미배치'}${unplaced.length ? ` · 미배치 ${unplaced.length}개` : ''}${decisions.length ? ` · 결정 ${decisions.length}개` : ''}`;
    return { cardId: card.id, cells: split.cells.length, placements, unplaced, decisions, text };
  } finally { if (!deps.store) store.close(); }
}

async function locked<T>(store: CardStore, id: string, fn: () => Promise<T>): Promise<T> {
  const dir = join(store.root, 'task-cards', 'flow-locks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.lock`);
  const until = Date.now() + 10_000;
  let fd: number;
  for (;;) {
    try { fd = openSync(path, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(path, 'utf8'));
        if (pid > 0 && Date.now() - statSync(path).mtimeMs > 30_000) {
          try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; } }
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; }
      if (Date.now() > until) throw new CliUserError(`카드 처리 잠금 대기 초과: ${id}`);
      await Bun.sleep(25);
    }
  }
  try { writeSync(fd, String(process.pid)); return await fn(); }
  finally { closeSync(fd); unlinkSync(path); }
}

async function notify(card: TaskCard, result: FlowResult, deps: FlowDeps): Promise<void> {
  if (!card.sections.some(s => s.key === 'intake:reply:0' || s.key === 'reply:0')) {
    debug.log('flow', 'reply-missing', { cardId: card.id });
    return;
  }
  try {
    const send = deps.reply ?? (await import('../intake-plane/wish-reply.js')).sendCardReply;
    if (send) await send(card.id, result.text);
  } catch (error) { debug.log('flow', 'reply-failed', { cardId: card.id, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
}

export async function flowCard(cardId: string, deps: FlowDeps = {}, dryRun = false): Promise<FlowResult> {
  const store = deps.store ?? new CardStore(undefined, dryRun);
  try {
    const run = async () => {
      const card = store.getCard(cardId);
      if (!card) throw new CliUserError(`카드가 없다: ${cardId}`);
      const completed = card.sections.find(s => s.key === 'flow:result:0');
      if (completed && !dryRun) return { ...JSON.parse(completed.content) as FlowResult, duplicate: true };
      if (card.status !== 'open') throw new CliUserError(`닫힌 카드: ${cardId}`);
      const split = await splitCard(card, deps);
      if (!dryRun && !card.sections.some(s => s.key === 'flow:split:0')) store.appendSection(cardId, { key: 'flow:split:0', owner: 'flow', content: JSON.stringify(split) });
      const result = await placeCards(card, split, { ...deps, store }, dryRun);
      if (!dryRun) {
        store.appendSection(cardId, { key: 'flow:result:0', owner: 'flow', content: JSON.stringify(result) });
        await notify(store.getCard(cardId)!, result, deps);
      }
      return result;
    };
    return dryRun ? await run() : await locked(store, cardId, run);
  } finally { if (!deps.store) store.close(); }
}

/** One fresh Wish card per invocation, shared with the orchestrator node rather than calling the CLI. */
export async function flowTick(deps: FlowDeps = {}): Promise<FlowResult | null> {
  const store = deps.store ?? new CardStore();
  try {
    const card = store.listCards({ open: true }).filter(c => c.goalId.startsWith('wish:') && !c.sections.some(s => s.key === 'flow:result:0'))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    return card ? await flowCard(card.id, { ...deps, store }) : null;
  } finally { if (!deps.store) store.close(); }
}
