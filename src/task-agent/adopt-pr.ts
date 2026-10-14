/** Attach an existing open PR to a TA card without starting another implementation run. */
import { randomBytes } from 'node:crypto';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { remoteLedgerMirrorDir } from './parent-host.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { cardPrNumber, updateTaskCard, type TaskCard } from './task-hand.js';

export interface AdoptPrView {
  number: number; url: string; state: string; baseRefName: string; headRefOid: string;
}
export interface AdoptPrInput {
  pr: AdoptPrView;
  repo: string;
  statePath: string;
  cardId?: string;
  version?: string;
  checklist?: { version: string; id: string; title: string; status: string };
  now?: Date;
  terminalRunEvidence?: boolean;
  unlinkedTerminal?: boolean;
  observedRun?: { runId?: string; runChildId?: string; parentHost?: string; launchId?: string };
  observedChecklist?: { id: string; version: string; status: string; cardVersion?: string };
  checklistAtWrite?: () => { id: string; status: string } | undefined;
}

/** A bound implementation may still push to its PR. Require the child to have stopped on this exact PR first. */
export function adoptedRunTerminal(card: TaskCard, pr: AdoptPrView,
  load: (runId: string, dir: string) => RunLedgerEntry[] | null = loadRunLedger, allowUnlinked = false): boolean {
  if (!card.runId) return false;
  const dir = card.parentHost ? remoteLedgerMirrorDir(prodInstanceRoot(), card.parentHost.host) : runLedgerDir();
  try {
    const parent = load(card.runId, dir);
    if (!parent) return false;
    const childIds = parent.filter((entry) => entry.event === 'pod-child-run' && typeof entry.data?.childRunId === 'string')
      .map((entry) => String(entry.data.childRunId));
    const candidates = childIds.length ? childIds : [card.runId];
    let allStopped = candidates.length > 0;
    let noPrEvents = true;
    let exactMatches = 0;
    for (const childId of candidates) {
      const child = childId === card.runId ? parent : load(childId, dir);
      if (!child) { allStopped = false; continue; }
      let prAt = -1;
      let statusAt = -1;
      for (let at = child.length - 1; at >= 0 && (prAt < 0 || statusAt < 0); at--) {
        if (prAt < 0 && child[at]?.event === 'pr-opened') prAt = at;
        if (statusAt < 0 && child[at]?.event === 'run-status') statusAt = at;
      }
      const opened = child[prAt];
      const status = child[statusAt];
      if (prAt >= 0) noPrEvents = false;
      if (!status || !['completed', 'failed', 'cancelled'].includes(String(status.data?.runStatus))) allStopped = false;
      if ((!card.runChildId || card.runChildId === childId) && opened?.data?.number === pr.number && opened.data?.url === pr.url && statusAt > prAt) exactMatches++;
    }
    if (!allStopped) return false;
    if (exactMatches === 1) return true;
    if (allowUnlinked && exactMatches === 0 && noPrEvents && (!card.runChildId || candidates.includes(card.runChildId))) return true;
  } catch { /* unreadable is not terminal evidence */ }
  return false;
}

/** The PR is read from the selected repository before this call; rejudge checks it again before every live move. */
export function adoptExistingPr(input: AdoptPrInput): { card: TaskCard; created: boolean; changed: boolean } {
  const { pr } = input;
  const slug = pr.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+\/?$/)?.[1];
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.state !== 'OPEN' || pr.baseRefName !== 'main'
    || !slug || slug.toLowerCase() !== input.repo.toLowerCase()
    || Number(pr.url.match(/\/pull\/(\d+)/)?.[1]) !== pr.number
    || !/^[a-f0-9]{40}$/i.test(pr.headRefOid)) throw new Error('입양할 PR은 현재 저장소의 OPEN/main PR 번호·URL·head SHA40이어야 한다');
  if ((input.cardId === undefined) === (input.checklist === undefined)) throw new Error('--card 또는 --checklist/--version 중 하나만 준다');
  if (input.cardId && !input.version) throw new Error('기존 카드는 체크리스트 판을 확정해야 한다');
  if (input.checklist && (!input.checklist.id || !input.checklist.title || !input.checklist.version
    || ['green', 'done'].includes(input.checklist.status))) throw new Error('입양할 체크리스트 칸은 미완 판·id·제목이어야 한다');
  const id = input.cardId ?? `ta-${(input.now ?? new Date()).toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
  const at = (input.now ?? new Date()).toISOString();
  let created = false;
  let changed = false;
  const result = updateTaskCard(input.statePath, id, (current, tasks) => {
    const duplicate = Object.values(tasks).find((card) => card.id !== id && cardPrNumber(card) === pr.number);
    if (duplicate) throw new Error(`PR #${pr.number}는 이미 카드 ${duplicate.id}에 묶였다`);
    const checklistId = current?.checklistId ?? input.checklist?.id;
    const checklistVersion = input.version ?? input.checklist?.version;
    const sameCell = Object.values(tasks).find((card) => card.id !== id && card.status === 'launched' && card.taLand === true
      && cardPrNumber(card) !== undefined && card.checklistId === checklistId
      && (!card.checklistVersion || !checklistVersion || card.checklistVersion === checklistVersion));
    if (sameCell) throw new Error(`칸 ${checklistId}에 이미 TA 착지 후보 카드 ${sameCell.id}가 있다`);
    if (!input.cardId) {
      const owner = Object.values(tasks).find((card) => card.status === 'launched' && card.checklistId === checklistId
        && (!card.checklistVersion || !checklistVersion || card.checklistVersion === checklistVersion));
      if (owner) throw new Error(`칸 ${checklistId}에 기존 카드 ${owner.id}가 있다 — --card로 그 카드를 선택한다`);
    }
    if (input.cardId && (!input.observedRun || current?.runId !== input.observedRun.runId
      || current?.runChildId !== input.observedRun.runChildId
      || current?.parentHost?.host !== input.observedRun.parentHost
      || current?.launchId !== input.observedRun.launchId))
      throw new Error(`입양 중 카드 런 식별자가 바뀌었다: ${id}`);
    if (input.cardId && (!input.observedChecklist || current?.checklistId !== input.observedChecklist.id
      || current?.checklistVersion !== input.observedChecklist.cardVersion
      || input.version !== input.observedChecklist.version
      || ['green', 'done'].includes(input.observedChecklist.status)))
      throw new Error(`입양 중 카드 칸·판이 바뀌었다: ${id}`);
    const liveCell = input.checklistAtWrite?.();
    if (input.checklistAtWrite && (!liveCell || liveCell.id !== checklistId || ['green', 'done'].includes(liveCell.status)))
      throw new Error(`입양 중 체크리스트 칸이 바뀌거나 완료됐다: ${checklistId}`);
    if (current?.adoptedPr?.pr === pr.number && cardPrNumber(current) === pr.number && current.taLand === true
      && typeof current.pr === 'object' && current.pr.url === pr.url) {
      if (current.status !== 'launched') throw new Error(`이미 닫힌 입양 카드다: ${id} (${current.status})`);
      if (current.checklistVersion !== (input.version ?? input.checklist?.version)) throw new Error(`이미 입양한 카드의 판이 다르다: ${current.checklistVersion ?? '미기록'} ≠ ${input.version ?? input.checklist?.version}`);
      return undefined;
    }
    if (input.cardId) {
      const boundPr = current && cardPrNumber(current);
      const sameBoundPr = boundPr === pr.number && typeof current?.pr === 'object' && current.pr.url === pr.url;
      if (!current || current.status !== 'launched' || !current.checklistId
        || (boundPr !== undefined && !sameBoundPr)
        || (input.checklist && current.checklistId !== input.checklist.id)) throw new Error(`입양할 launched·미바인딩/동일 PR 바인딩 카드가 아니다: ${id}`);
      if (boundPr !== undefined && input.unlinkedTerminal)
        throw new Error(`이미 PR이 바인딩된 카드는 --unlinked-terminal로 입양할 수 없다: ${id}`);
      if (input.terminalRunEvidence !== true) throw new Error(`구현 런 종결·PR 근거가 없다: ${current.runId ?? current.launchId ?? 'runId 없음'} — runId 없는 카드는 tasks close 후 --checklist 새 카드로 입양`);
      if (input.version && current.checklistVersion && current.checklistVersion !== input.version)
        throw new Error(`카드 판이 다르다: ${current.checklistVersion} ≠ ${input.version}`);
    } else {
      if (current) throw new Error(`새 카드 id 충돌: ${id}`);
    }
    const base: TaskCard = current ?? {
      id, text: input.checklist!.title, checklistId: input.checklist!.id,
      createdAt: at, status: 'launched', history: [],
    };
    created = !current;
    changed = true;
    return { ...base, ...(input.version || input.checklist ? { checklistVersion: input.version ?? input.checklist!.version } : {}),
      taLand: true, pr: { number: pr.number, url: pr.url },
      adoptedPr: { pr: pr.number, url: pr.url, head: pr.headRefOid, at },
      history: [...base.history, { at, event: 'pr-adopted', pr: pr.number, head: pr.headRefOid,
        detail: `기존 OPEN PR 입양 · ${pr.url} · 새 구현 발사 0${input.unlinkedTerminal ? ' · 명시적 비연결 종결 원장' : ''}` }],
    };
  });
  if (!result) throw new Error(`카드 쓰기 실패: ${id}`);
  return { card: result, created, changed };
}
