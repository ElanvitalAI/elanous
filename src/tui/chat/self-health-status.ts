import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import type { LogRecord } from '../../mss/logging/record.js';
import { codeRevision } from '../../version/code-revision.js';

export const NEXT_TUI_SELF_HEALTH_WINDOW_MS = 30 * 60_000;
const MAX_OBSERVATIONS = 512;
const MAX_SESSION_LINKS = 256;

export interface NextTuiSelfHealthSnapshot {
  readonly sessionId: string;
  readonly capturedAt: number;
  readonly line: string;
  readonly source: 'installed' | 'checkout' | 'unknown';
  readonly runningSha: string | null;
  readonly installedSha: string | null;
  readonly errorCount: number | null;
  readonly representativeError: string | null;
  readonly creditSource: string | null;
  readonly creditKnown: boolean;
}

interface Observation {
  readonly at: number;
  readonly sessionId: string | null;
  readonly summary: string;
  readonly provider?: string;
}

interface CreditObservation {
  readonly at: number;
  readonly sessionId: string | null;
  readonly source: string;
}

export interface NextTuiSelfHealthDeps {
  readonly now?: () => number;
  readonly runningRevision?: () => string | undefined;
  readonly installedRevision?: () => string | undefined;
  readonly loggingLive?: () => boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shortSha(value: string | null | undefined): string | null {
  return value && /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 7) : null;
}

function currentInstalledRevision(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(homedir(), '.local', 'share', 'elanous', 'current', 'install.json'), 'utf8'));
    const commit = object(parsed).commit;
    return typeof commit === 'string' && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : undefined;
  } catch { return undefined; }
}

function runtimeSource(): NextTuiSelfHealthSnapshot['source'] {
  const path = import.meta.dir.replaceAll('\\', '/');
  if (path.includes('/.local/share/elanous/versions/') || path.includes('/.local/share/elanous/current/')) return 'installed';
  return codeRevision() ? 'checkout' : 'unknown';
}

function classifyError(record: Pick<LogRecord, 'category' | 'event' | 'data' | 'level'>): string | null {
  const data = object(record.data);
  if (record.category === 'llm.call' && record.event === 'outcome-trace') {
    const status = typeof data.status === 'number' ? data.status : null;
    if (status === null || (status < 400 && status !== 0)) return null;
    const provider = typeof data.provider === 'string' ? data.provider : 'LLM';
    return status === 0 ? `${provider} 연결 오류` : `${provider} HTTP ${status}`;
  }
  if (record.category === 'llm.response.status' && /^codex (response\.failed|error)$/.test(record.event)) return `Codex ${record.event}`;
  if (record.category === 'llm.router' && record.event === 'tool-loop.max-turns.no-final-synthesis') return '도구 예산 소진';
  if (record.category === 'llm.router' && record.event === 'tool-loop.synthesis-ignored.hard-stop') return '최종 합성 중단';
  if ((record.category === 'tools.search' && record.event === 'broad-search-blocked')
    || (record.category === 'session-runtime.search' && /blocked$/.test(record.event))) return '탐색 가드 거부';
  if (record.category === 'tui.event-loop' && record.event === 'stall' && typeof data.lagMs === 'number' && data.lagMs > 1_000) return `이벤트 루프 정지 ${Math.round(data.lagMs)}ms`;
  if (record.level === 'error' || record.level === 'critical') return `기록된 오류 (${record.category})`;
  return null;
}

function creditSource(record: Pick<LogRecord, 'category' | 'event' | 'data' | 'level'>): string | null {
  if (record.category !== 'llm.usage' || record.event !== 'llm-usage') return null;
  const data = object(record.data);
  const cost = object(data.cost);
  if (data.billing !== 'credit' && cost.kind !== 'credit') return null;
  const provider = typeof data.billingProvider === 'string' ? data.billingProvider
    : typeof data.provider === 'string' ? data.provider : '제공자 모름';
  const site = typeof data.site === 'string' ? data.site : '경로 모름';
  const model = typeof data.model === 'string' ? data.model : '모델 모름';
  return `${provider}/${model} · ${site} · llm.usage billing=credit`;
}

function immutableSnapshot(input: Omit<NextTuiSelfHealthSnapshot, 'line'>): NextTuiSelfHealthSnapshot {
  const build = input.runningSha
    ? input.source === 'installed'
      ? input.installedSha ? input.runningSha === input.installedSha
        ? `실행 설치본 ${shortSha(input.runningSha)} · 최신`
        : `실행 설치본 ${shortSha(input.runningSha)} · 설치본 ${shortSha(input.installedSha)} · 재기동 필요`
        : `실행 설치본 ${shortSha(input.runningSha)} · 현재 설치본 모름`
      : input.source === 'checkout'
        ? `실행 체크아웃 ${shortSha(input.runningSha)} · 설치본 ${shortSha(input.installedSha) ?? '대조 모름'}`
        : `실행 판 ${shortSha(input.runningSha)} · 출처 모름`
    : '실행 판 모름';
  const errors = input.errorCount === null
    ? '최근 30분 오류 모름(로그 비활성)'
    : input.errorCount === 0 ? '최근 30분 오류 없음'
      : `최근 30분 오류 ${input.errorCount}회 · 대표 ${input.representativeError ?? '문면 모름'}`;
  const credit = input.creditKnown ? `크레딧 ${input.creditSource ?? '최근 30분 사용 없음'}` : '크레딧 출처 모름(로그 비활성)';
  const line = `[자기 건강 · Next · ${input.sessionId.slice(0, 8)}] ${build} · ${errors} · ${credit}`;
  return Object.freeze({ ...input, line });
}

export function isNextTuiSelfHealthSnapshot(value: unknown): value is NextTuiSelfHealthSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.sessionId === 'string' && snapshot.sessionId.length > 0
    && typeof snapshot.capturedAt === 'number' && typeof snapshot.line === 'string'
    && (snapshot.source === 'installed' || snapshot.source === 'checkout' || snapshot.source === 'unknown')
    && (typeof snapshot.runningSha === 'string' || snapshot.runningSha === null)
    && (typeof snapshot.installedSha === 'string' || snapshot.installedSha === null)
    && (typeof snapshot.errorCount === 'number' || snapshot.errorCount === null)
    && (typeof snapshot.representativeError === 'string' || snapshot.representativeError === null)
    && (typeof snapshot.creditSource === 'string' || snapshot.creditSource === null)
    && typeof snapshot.creditKnown === 'boolean';
}

export class NextTuiSelfHealthTracker {
  readonly sink = { name: 'next-tui-self-health', emit: (record: LogRecord) => this.observe(record) };
  private readonly observations: Observation[] = [];
  private readonly parents = new Map<string, string>();
  private readonly now: () => number;
  private readonly runningRevision: () => string | undefined;
  private readonly installedRevision: () => string | undefined;
  private readonly loggingLive: () => boolean;
  private readonly source = runtimeSource();
  private readonly bootRevision: string | undefined;
  private credit: CreditObservation | null = null;
  private activeSessionId = '';
  private uninstall: (() => void) | null = null;

  constructor(deps: NextTuiSelfHealthDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.runningRevision = deps.runningRevision ?? codeRevision;
    this.installedRevision = deps.installedRevision ?? currentInstalledRevision;
    this.loggingLive = deps.loggingLive ?? (() => debug.isAnySinkEnabled());
    this.bootRevision = this.runningRevision();
  }

  setSessionId(sessionId: string): void { this.activeSessionId = sessionId; }

  install(): void {
    this.uninstall ??= debug.registerSink(this.sink);
  }

  dispose(): void {
    this.uninstall?.();
    this.uninstall = null;
    this.observations.length = 0;
    this.parents.clear();
    this.credit = null;
    this.activeSessionId = '';
  }

  observe(record: Pick<LogRecord, 'category' | 'event' | 'data' | 'level'> & { readonly ts?: string; readonly session_id?: string }): void {
    const at = record.ts ? Date.parse(record.ts) : this.now();
    const sessionId = typeof record.session_id === 'string' ? record.session_id : null;
    if (record.category === 'session.link' && record.event === 'child-scope') {
      const data = object(record.data);
      if (typeof data.parentSessionId === 'string' && typeof data.childSessionId === 'string') {
        if (this.parents.size >= MAX_SESSION_LINKS) this.parents.delete(this.parents.keys().next().value as string);
        this.parents.set(data.childSessionId, data.parentSessionId);
      }
      return;
    }
    const error = classifyError(record);
    if (error) this.push({ at, sessionId, summary: error });
    const credit = creditSource(record);
    if (credit) this.credit = { at, sessionId, source: credit };
  }

  private push(observation: Observation): void {
    this.observations.push(observation);
    if (this.observations.length > MAX_OBSERVATIONS) this.observations.splice(0, this.observations.length - MAX_OBSERVATIONS);
  }

  private belongsToActiveSession(sessionId: string | null, own: ReadonlySet<string>): boolean {
    if (!sessionId) return false;
    let current: string | undefined = sessionId;
    for (let hop = 0; current && hop < 8; hop++) {
      if (own.has(current)) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  snapshot(sessionId = this.activeSessionId): NextTuiSelfHealthSnapshot {
    this.activeSessionId = sessionId;
    const capturedAt = this.now();
    const live = (() => { try { return this.loggingLive(); } catch { return false; } })();
    const own = new Set([sessionId]);
    const since = capturedAt - NEXT_TUI_SELF_HEALTH_WINDOW_MS;
    const recent = live ? this.observations.filter((item) => item.at >= since && item.at <= capturedAt && this.belongsToActiveSession(item.sessionId, own)) : [];
    const latest = recent.at(-1);
    const credit = this.credit && this.credit.at >= since && this.credit.at <= capturedAt && this.belongsToActiveSession(this.credit.sessionId, own)
      ? this.credit.source : null;
    const running = (() => { try { return this.bootRevision; } catch { return undefined; } })();
    const installed = (() => { try { return this.installedRevision(); } catch { return undefined; } })();
    return immutableSnapshot({
      sessionId,
      capturedAt,
      source: this.source,
      runningSha: shortSha(running),
      installedSha: shortSha(installed),
      errorCount: live ? recent.length : null,
      representativeError: latest?.summary ?? null,
      creditSource: live ? credit : null,
      creditKnown: live,
    });
  }
}

export function installNextTuiSelfHealthTracker(): NextTuiSelfHealthTracker | null {
  if (process.env.ELANOUS_NEXT_TUI_SELF_HEALTH !== '1') return null;
  const tracker = new NextTuiSelfHealthTracker();
  tracker.install();
  return tracker;
}

