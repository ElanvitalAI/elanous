import { defaultHerdrCliRunner, type HerdrCliRunner } from '../../pty-shell/herdr-prompt.js';
import type { SidetabRow } from '../../sidetab-core/model.js';

const HERDR_ROW_PREFIX = 'herdr:';
const SNAPSHOT_TIMEOUT_MS = 1_500;
const PANE_READ_TIMEOUT_MS = 1_000;
const PANE_INPUT_TIMEOUT_MS = 1_000;

export type HerdrSidetabStatus =
  | 'working' | 'idle' | 'needs-approval' | 'done-verified' | 'done-unverified' | 'stopped' | 'unknown';

export interface HerdrPaneSnapshot {
  readonly pane_id: string;
  readonly workspace_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly terminal_title?: string;
  readonly terminal_title_stripped?: string;
  readonly cwd?: string;
  readonly alive?: boolean;
  readonly cost_usd?: number;
  readonly costUsd?: number;
  readonly cost?: number;
  readonly [key: string]: unknown;
}

export interface HerdrSidetabPortalOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: HerdrCliRunner;
  /** Independent completion evidence; Herdr's own `done` report is never treated as verification. */
  readonly isVerified?: (pane: HerdrPaneSnapshot) => boolean;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export interface HerdrSidetabPortal {
  enabled(): boolean;
  refreshRows(): Promise<readonly SidetabRow[]>;
  rows(): readonly SidetabRow[];
  readPane(paneId: string): Promise<string>;
  sendText(paneId: string, text: string): Promise<void>;
  sendKey(paneId: string, key: string): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function paneRowsFromSnapshot(value: unknown): HerdrPaneSnapshot[] {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  if (!result) throw new Error('Herdr snapshot 형식 오류 · result 객체가 없습니다');
  const session = asRecord(result?.session_snapshot);
  const panes = result?.panes ?? session?.panes;
  if (!Array.isArray(panes)) throw new Error('Herdr snapshot 형식 오류 · panes 배열이 없습니다');
  const invalidPane = panes.findIndex((candidate) => {
    const pane = asRecord(candidate);
    return typeof pane?.pane_id !== 'string' || pane.pane_id.length === 0;
  });
  if (invalidPane >= 0) throw new Error(`Herdr snapshot 형식 오류 · panes[${invalidPane}].pane_id가 없습니다`);
  return panes as HerdrPaneSnapshot[];
}

function statusOf(pane: HerdrPaneSnapshot, verified: boolean): HerdrSidetabStatus {
  const state = (pane.agent_status ?? '').trim().toLowerCase().replaceAll('_', '-');
  // Approval is a first-class state. Never collapse it into idle, even if a pane has no running process.
  if (state === 'blocked' || state === 'needs-approval' || state === 'approval-required') return 'needs-approval';
  // A completed pane remains completed after its process exits. Herdr's `done` is not verification.
  if (state === 'done' || state === 'complete' || state === 'completed') return verified ? 'done-verified' : 'done-unverified';
  if (pane.alive === false || state === 'stopped' || state === 'exited') return 'stopped';
  if (state === 'working' || state === 'busy') return 'working';
  if (state === 'idle') return 'idle';
  return 'unknown';
}

function displayState(status: HerdrSidetabStatus): { badge: SidetabRow['badge']; label: string } {
  switch (status) {
    case 'working': return { badge: 'busy', label: '실행 중' };
    case 'idle': return { badge: 'idle', label: '대기' };
    case 'needs-approval': return { badge: 'busy', label: '승인 필요' };
    case 'done-verified': return { badge: 'idle', label: '검증 완료' };
    case 'done-unverified': return { badge: 'unknown', label: '미검증 완료' };
    case 'stopped': return { badge: 'exited', label: '멈춤' };
    case 'unknown': return { badge: 'unknown', label: '상태 미상' };
  }
}

function finiteCost(pane: HerdrPaneSnapshot): number | undefined {
  for (const value of [pane.cost_usd, pane.costUsd, pane.cost]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function rowFromPane(pane: HerdrPaneSnapshot, verified: boolean): SidetabRow {
  const status = statusOf(pane, verified);
  const display = displayState(status);
  const title = pane.terminal_title_stripped || pane.terminal_title || pane.agent || pane.pane_id;
  const cost = finiteCost(pane);
  const costText = cost === undefined ? '비용 —' : `비용 $${cost.toFixed(2)}`;
  return {
    id: `${HERDR_ROW_PREFIX}${pane.pane_id}`,
    label: `Herdr · ${display.label} · ${title} · ${costText}`,
    kind: 'herdr',
    badge: display.badge,
  };
}

function paneIdFromRow(row: SidetabRow): string | undefined {
  if (row.kind !== 'herdr' || !row.id.startsWith(HERDR_ROW_PREFIX)) return undefined;
  const id = row.id.slice(HERDR_ROW_PREFIX.length);
  return /^w[A-Za-z0-9_-]+:p[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}

function commandOutput(result: { code: number | null; stdout: string; stderr: string }): string {
  if (result.code !== 0) {
    const body = result.stderr.trim();
    let message = body || `herdr exited with rc=${result.code ?? 'unknown'}`;
    if (body.startsWith('{')) {
      try {
        const error = asRecord(asRecord(JSON.parse(body))?.error);
        if (typeof error?.message === 'string') message = error.message;
      } catch { /* preserve stderr */ }
    }
    throw new Error(message);
  }
  const text = result.stdout.trim();
  if (!text.startsWith('{')) return text;
  try {
    const resultEnvelope = asRecord(asRecord(JSON.parse(text))?.result);
    for (const key of ['text', 'output', 'screen', 'content'] as const) {
      if (typeof resultEnvelope?.[key] === 'string') return resultEnvelope[key] as string;
    }
  } catch { /* plain terminal text may begin with a brace */ }
  return text;
}

function logicalKey(key: string): string {
  const aliases: Record<string, string> = {
    '\r': 'enter', '\n': 'enter', '\x1b': 'esc', '\x7f': 'backspace', '\t': 'tab',
    '\x03': 'ctrl+c', '\x04': 'ctrl+d', '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down',
    '\x1b[C': 'right', '\x1bOC': 'right', '\x1b[D': 'left', '\x1bOD': 'left',
  };
  const mapped = aliases[key];
  if (mapped) return mapped;
  if (key.startsWith('\x1b')) throw new Error('지원되지 않는 Herdr escape key입니다');
  return key;
}

export function createHerdrSidetabPortal(options: HerdrSidetabPortalOptions = {}): HerdrSidetabPortal {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultHerdrCliRunner(env);
  const isVerified = options.isVerified ?? (() => false);
  const log = options.log ?? (() => {});
  let cachedRows: SidetabRow[] = [];
  let snapshotError: string | null = null;
  let refreshPending: Promise<readonly SidetabRow[]> | null = null;

  const visibleRows = (): SidetabRow[] => {
    const rows = snapshotError
      ? cachedRows.map((row) => ({ ...row, label: `${row.label} · 오래된 스냅샷` }))
      : [...cachedRows];
    if (snapshotError) {
      rows.push({
        id: 'herdr:snapshot-status',
        label: `Herdr · snapshot 갱신 실패 · ${snapshotError}`,
        kind: 'status',
        badge: 'unknown',
      });
    }
    return rows;
  };

  const requireEnabledPane = (paneId: string): void => {
    if (env.HERDR_ENV !== '1') throw new Error('Herdr 포털은 Herdr 관리 pane 안에서만 사용할 수 있습니다');
    if (!/^w[A-Za-z0-9_-]+:p[A-Za-z0-9_-]+$/.test(paneId)) throw new Error('Herdr pane id가 올바르지 않습니다');
  };

  return {
    enabled: () => env.HERDR_ENV === '1',
    async refreshRows() {
      if (env.HERDR_ENV !== '1') return [];
      if (refreshPending) return refreshPending;
      refreshPending = (async () => {
        const result = await run(['api', 'snapshot'], SNAPSHOT_TIMEOUT_MS);
        const output = commandOutput(result);
        let snapshot: unknown;
        try { snapshot = JSON.parse(output); }
        catch { throw new Error('Herdr snapshot 형식 오류 · JSON을 읽을 수 없습니다'); }
        const panes = paneRowsFromSnapshot(snapshot);
        cachedRows = panes.map((pane) => rowFromPane(pane, isVerified(pane)));
        snapshotError = null;
        log('snapshot', { panes: cachedRows.length });
        return visibleRows();
      })().catch((error: unknown) => {
        snapshotError = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, ' ').slice(0, 160);
        log('snapshot-failed', { error: snapshotError });
        return visibleRows();
      }).finally(() => { refreshPending = null; });
      return refreshPending;
    },
    rows: visibleRows,
    async readPane(paneId) {
      requireEnabledPane(paneId);
      const result = await run(['pane', 'read', paneId, '--source', 'visible', '--format', 'ansi'], PANE_READ_TIMEOUT_MS);
      return commandOutput(result);
    },
    async sendText(paneId, text) {
      requireEnabledPane(paneId);
      if (!text) return;
      const result = await run(['pane', 'send-text', paneId, text], PANE_INPUT_TIMEOUT_MS);
      commandOutput(result);
    },
    async sendKey(paneId, key) {
      requireEnabledPane(paneId);
      const normalized = logicalKey(key);
      if (!normalized) return;
      const result = await run(['pane', 'send-keys', paneId, normalized], PANE_INPUT_TIMEOUT_MS);
      commandOutput(result);
    },
  };
}

export function herdrPaneIdFromSidetabRow(row: SidetabRow): string | undefined {
  return paneIdFromRow(row);
}
