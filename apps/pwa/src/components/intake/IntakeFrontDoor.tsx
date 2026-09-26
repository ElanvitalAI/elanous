'use client';

// `/intake` 첫 입구. 규칙 미리보기와 사용자 요청 시 분류기 ⊕ 세 실행 버튼.
// 흡수 · 작업 분할 · 그래프는 이미 있는 입구만 부른다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import {
  getAbsorbStatus,
  getGraphStatus,
  getRunEvents,
  intakeTextPreview,
  routeIntake,
  submitAbsorb,
  submitGraph,
  type AbsorbStatus,
  type GraphStatus,
  type RunEvent,
  type IntakeRouteDecision,
  type IntakeRouteTrack,
} from '@/lib/intake-front-door-api';
import { summarizeAbsorbStatus } from '@/lib/intake-absorb-status';
import { summarizeRunEvents, type RunTimeline } from '@/lib/intake-run-timeline';
import { MemoIntakePreview } from './MemoIntakePreview';

const RECENT_KEY = 'elanous.intake.recent';
const RECENT_LIMIT = 20;
const POLL_MS = 5_000;
const RUN_POLL_MS = 30_000;
const ABSORB_POLL_MS = 60_000;
const POLL_MAX_MS = 5 * 60 * 1_000;
/** 칸 입력이 멈춘 뒤 판정을 묻는 간격. 자동 실행은 없다. */
export const ROUTE_DEBOUNCE_MS = 500;
const EXPLAINER = '보내면 elanous 가 이 글을 처리합니다(흡수 · 작업 분할 · 그래프 실행).';
const ABSORB_COPY = '대기열에 넣었습니다(아침 정기 흡수에서 처리)';

const CHIP_LABEL: Record<IntakeRouteTrack, string> = {
  absorb: '→ 흡수',
  tasks: '→ 작업',
  graph: '→ 그래프',
  'ask-human': '→ 직접 고르세요',
};

function routeReasonLabel(chip: IntakeRouteDecision): string {
  if (chip.decidedBy !== 'classifier') return chip.reason;
  if (chip.reason.startsWith('classifier-failed:')) return '분류기가 못 갈랐습니다 — 직접 골라 주세요';
  if (chip.reason.startsWith('classifier-low-confidence:')) {
    const track = chip.reason.slice('classifier-low-confidence:'.length) as IntakeRouteTrack;
    return `분류기 추정: ${CHIP_LABEL[track]?.slice(2) ?? track} (확신 낮음)`;
  }
  return chip.reason;
}

/** 추천 갈래가 강조할 버튼. ask-human 은 어느 버튼도 강조하지 않는다. tasks 는 «작업으로 나누기». */
export function emphasizedTrack(track: IntakeRouteTrack | null): 'absorb' | 'split' | 'graph' | null {
  if (track === 'absorb') return 'absorb';
  if (track === 'tasks') return 'split';
  if (track === 'graph') return 'graph';
  return null;
}

export interface RoutePreviewClock {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * 입력이 멈춘 뒤 ROUTE_DEBOUNCE_MS 에 routeIntake 한 번.
 * 보내는 함수는 여기 없다 — 자동 실행 0.
 */
export function scheduleRoutePreview(
  text: string,
  ask: (value: string) => void,
  clock: RoutePreviewClock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
): () => void {
  const value = text.trim();
  if (!value) return () => {};
  const handle = clock.setTimeout(() => ask(value), ROUTE_DEBOUNCE_MS);
  return () => clock.clearTimeout(handle);
}

type Track = 'absorb' | 'split' | 'graph';

interface RecentSend {
  track: Track;
  at: string;
  preview: string;
  ids?: string[];
  acceptanceId?: string;
  runId?: string;
}

export interface IntakeFrontDoorState {
  text: string;
  busy: boolean;
  error: string | null;
  absorbIds: string[] | null;
  acceptanceId: string | null;
  graph: GraphStatus | null;
  runEvents?: Record<string, RunEvent[]>;
  splitOpen: boolean;
  splitMemo: string;
  recent: RecentSend[];
  /** 판정 칩. 없거나 실패면 칩을 그리지 않는다. */
  route?: IntakeRouteDecision | null;
}

export interface IntakeFrontDoorDeps {
  now?: () => string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export interface IntakeActionResult {
  absorbIds?: string[];
  acceptanceId?: string;
  recentPreview: string;
}

function storageOf(deps?: IntakeFrontDoorDeps): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (deps?.storage) return deps.storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readRecent(deps?: IntakeFrontDoorDeps): RecentSend[] {
  try {
    const raw = storageOf(deps)?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as RecentSend[] : [];
  } catch {
    return [];
  }
}

export function remember(entry: RecentSend, deps?: IntakeFrontDoorDeps): RecentSend[] {
  const next = [entry, ...readRecent(deps)].slice(0, RECENT_LIMIT);
  try {
    storageOf(deps)?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // 저장이 막혀도 화면은 돈다.
  }
  return next;
}

/** 흡수·그래프 버튼이 누르는 기존 입구. 원문 전체는 결과에 남기지 않는다. */
export async function runIntakeAction(
  client: Parameters<typeof submitAbsorb>[0],
  track: 'absorb' | 'graph',
  text: string,
): Promise<IntakeActionResult> {
  const recentPreview = intakeTextPreview(text);
  if (track === 'absorb') {
    const result = await submitAbsorb(client, text);
    return { absorbIds: result.ids, recentPreview };
  }
  const result = await submitGraph(client, text);
  return { acceptanceId: result.acceptanceId, recentPreview };
}

export function IntakeFrontDoor({
  state: stateOverride,
  deps,
}: {
  state?: IntakeFrontDoorState;
  deps?: IntakeFrontDoorDeps;
} = {}) {
  const { client } = useDaemon();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [absorbIds, setAbsorbIds] = useState<string[] | null>(null);
  const [acceptanceId, setAcceptanceId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphStatus | null>(null);
  const [runEvents, setRunEvents] = useState<Record<string, RunEvent[]>>({});
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitMemo, setSplitMemo] = useState('');
  const [recent, setRecent] = useState<RecentSend[]>([]);
  const [absorbStatuses, setAbsorbStatuses] = useState<Record<string, AbsorbStatus | null>>({});
  const absorbStatusesRef = useRef(absorbStatuses);
  const absorbIdsToCheck = useMemo(() => [...new Set(recent
    .filter((row) => row.track === 'absorb')
    .flatMap((row) => row.ids ?? []))], [recent]);
  const absorbIdsRef = useRef(absorbIdsToCheck);
  absorbIdsRef.current = absorbIdsToCheck;
  const pollAbsorbRef = useRef<(id: string) => void>(() => {});
  const [route, setRoute] = useState<IntakeRouteDecision | null>(null);
  const [classifying, setClassifying] = useState(false);
  const classifyingRef = useRef(false);
  const routeRequest = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const pollStarted = useRef<number | null>(null);
  const runEventsRef = useRef(runEvents);
  const recentRef = useRef(recent);
  const runIds = useMemo(() => [...new Set([
    ...recent.filter((row) => row.track === 'graph').map((row) => row.runId),
    graph?.runId,
  ].filter((id): id is string => Boolean(id)))], [recent, graph?.runId]);

  useEffect(() => {
    setRecent(readRecent(deps));
  }, [deps]);

  useEffect(() => {
    recentRef.current = recent;
  }, [recent]);

  useEffect(() => {
    let stopped = false;
    const timers = new Map<string, ReturnType<typeof setTimeout> | null>();
    const tick = async (id: string): Promise<void> => {
      if (stopped || !absorbIdsRef.current.includes(id) || summarizeAbsorbStatus(absorbStatusesRef.current[id] ?? null).settled) return;
      let status: AbsorbStatus | null = null;
      try {
        status = await getAbsorbStatus(client, id);
      } catch {
        // 조회 실패는 찾을 수 없음으로 표시하고 다음 주기에 다시 묻는다.
      }
      if (stopped) return;
      absorbStatusesRef.current = { ...absorbStatusesRef.current, [id]: status };
      setAbsorbStatuses(absorbStatusesRef.current);
      if (absorbIdsRef.current.includes(id) && !summarizeAbsorbStatus(status).settled) {
        timers.set(id, setTimeout(() => { void tick(id); }, ABSORB_POLL_MS));
      } else {
        timers.delete(id);
      }
    };
    pollAbsorbRef.current = (id) => {
      if (timers.has(id) || summarizeAbsorbStatus(absorbStatusesRef.current[id] ?? null).settled) return;
      timers.set(id, null);
      void tick(id);
    };
    absorbIdsRef.current.forEach(pollAbsorbRef.current);
    return () => {
      stopped = true;
      for (const timer of timers.values()) if (timer !== null) clearTimeout(timer);
      timers.clear();
      pollAbsorbRef.current = () => {};
    };
  }, [client]);

  useEffect(() => {
    absorbIdsToCheck.forEach(pollAbsorbRef.current);
  }, [absorbIdsToCheck]);

  const record = useCallback((entry: Omit<RecentSend, 'at' | 'preview'> & { preview: string }) => {
    setRecent(remember({ ...entry, at: deps?.now?.() ?? new Date().toISOString() }, deps));
  }, [deps]);

  const onAbsorb = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setAbsorbIds(null);
    try {
      const result = await runIntakeAction(client, 'absorb', value);
      setAbsorbIds(result.absorbIds ?? []);
      record({ track: 'absorb', preview: result.recentPreview, ids: result.absorbIds });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, client, record, text]);

  const onSplit = useCallback(() => {
    const value = text.trim();
    if (!value || busy) return;
    setSplitMemo(value);
    setSplitOpen(true);
    record({ track: 'split', preview: intakeTextPreview(value) });
  }, [busy, record, text]);

  const onGraph = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setAcceptanceId(null);
    setGraph(null);
    try {
      const result = await runIntakeAction(client, 'graph', value);
      setAcceptanceId(result.acceptanceId ?? null);
      pollStarted.current = Date.now();
      record({ track: 'graph', preview: result.recentPreview, acceptanceId: result.acceptanceId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, client, record, text]);

  useEffect(() => {
    const request = ++routeRequest.current;
    setRoute(null);
    if (!text.trim()) return;
    const cancel = scheduleRoutePreview(text, (value) => {
      void routeIntake(client, value).then(
        (decision) => {
          if (routeRequest.current === request) setRoute(decision);
        },
        () => {
          if (routeRequest.current === request) setRoute(null);
        },
      );
    });
    return () => {
      ++routeRequest.current;
      cancel();
    };
  }, [client, text]);

  const onClassify = useCallback(async () => {
    const value = text.trim();
    if (!value || classifyingRef.current || busy || route?.reason !== 'rule-unknown') return;
    const request = ++routeRequest.current;
    classifyingRef.current = true;
    setClassifying(true);
    try {
      const decision = await routeIntake(client, value, { classify: true });
      if (routeRequest.current === request && textRef.current.trim() === value) setRoute(decision);
    } catch {
      if (routeRequest.current === request && textRef.current.trim() === value) {
        setRoute({ track: 'ask-human', confidence: 0, reason: 'classifier-failed:request-error', decidedBy: 'classifier' });
      }
    } finally {
      classifyingRef.current = false;
      setClassifying(false);
    }
  }, [busy, client, route?.reason, text]);

  useEffect(() => {
    if (!acceptanceId) return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      const started = pollStarted.current ?? Date.now();
      if (Date.now() - started > POLL_MAX_MS) return;
      try {
        const status = await getGraphStatus(client, acceptanceId);
        if (!stopped) {
          setGraph(status);
          if (status.runId && recentRef.current.some((row) => row.track === 'graph' && row.acceptanceId === acceptanceId && row.runId !== status.runId)) {
            const next = recentRef.current.map((row) => row.track === 'graph' && row.acceptanceId === acceptanceId
              ? { ...row, runId: status.runId }
              : row);
            recentRef.current = next;
            try { storageOf(deps)?.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 저장이 막혀도 화면은 돈다. */ }
            setRecent(next);
          }
        }
      } catch {
        // 다음 주기에 다시 묻는다. 화면은 유지.
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [acceptanceId, client, deps]);

  useEffect(() => {
    runEventsRef.current = runEvents;
  }, [runEvents]);

  useEffect(() => {
    if (runIds.length === 0) return;
    let stopped = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (stopped || pending) return;
      const active = runIds.filter((id) => !summarizeRunEvents(runEventsRef.current[id] ?? []).done);
      if (active.length === 0) return;
      pending = true;
      try {
        const results = await Promise.allSettled(active.map((id) => getRunEvents(client, id)));
        if (stopped) return;
        const updates: Record<string, RunEvent[]> = {};
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') updates[active[index]!] = result.value;
        });
        if (Object.keys(updates).length > 0) {
          runEventsRef.current = { ...runEventsRef.current, ...updates };
          setRunEvents(runEventsRef.current);
        }
      } finally {
        pending = false;
        if (!stopped && runIds.some((id) => !summarizeRunEvents(runEventsRef.current[id] ?? []).done)) {
          timer = setTimeout(() => { void tick(); }, RUN_POLL_MS);
        }
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, runIds]);

  const view: IntakeFrontDoorState = stateOverride ?? {
    text, busy, error, absorbIds, acceptanceId, graph, runEvents, splitOpen, splitMemo, recent, route,
  };
  const graphLine = useMemo(() => {
    if (!view.acceptanceId) return null;
    return { acceptanceId: view.acceptanceId, phase: view.graph?.phase, runId: view.graph?.runId };
  }, [view.acceptanceId, view.graph]);
  const timelineFor = (row: RecentSend): RunTimeline | null => {
    const id = row.runId ?? (row.acceptanceId === view.acceptanceId ? graphLine?.runId : undefined);
    return id ? summarizeRunEvents(view.runEvents?.[id] ?? []) : null;
  };
  const fieldEmpty = view.text.trim().length === 0;
  const chip = view.route ?? null;
  const emphasis = chip ? emphasizedTrack(chip.track) : null;
  const buttonClass = (track: 'absorb' | 'split' | 'graph'): string | undefined => (
    emphasis === track ? 'ring-2 ring-ring' : undefined
  );

  return (
    <section className="mx-auto flex max-w-lg flex-col gap-4 p-4" data-testid="intake-front-door">
      <header className="space-y-1">
        <h1 className="font-heading text-lg font-medium">Intake</h1>
      </header>

      <textarea
        value={view.text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        disabled={view.busy}
        data-testid="intake-front-door-field"
        aria-label="intake"
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-xs text-muted-foreground" data-testid="intake-front-door-explainer">{EXPLAINER}</p>

      {chip && (
        <div data-testid="intake-route-chip" data-auto-submit="0" className="space-y-0.5 text-sm">
          <p data-testid="intake-route-chip-label">{CHIP_LABEL[chip.track]}</p>
          {chip.decidedBy === 'classifier' && (
            <p data-testid="intake-route-chip-classifier">분류기 판정 · 확신 {Math.round(chip.confidence * 100)}%</p>
          )}
          <p data-testid="intake-route-chip-reason" className="text-xs text-muted-foreground">{routeReasonLabel(chip)}</p>
          {chip.reason === 'rule-unknown' && (
            <Button type="button" size="sm" variant="outline" disabled={classifying || view.busy || fieldEmpty} onClick={() => void onClassify()} data-testid="intake-route-classify">
              분류기로 가르기
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className={buttonClass('absorb')} aria-pressed={emphasis === 'absorb'} disabled={fieldEmpty || view.busy} onClick={() => void onAbsorb()} data-testid="intake-absorb" data-emphasized={emphasis === 'absorb' ? 'true' : 'false'}>
          흡수
        </Button>
        <Button type="button" size="sm" variant="outline" className={buttonClass('split')} aria-pressed={emphasis === 'split'} disabled={fieldEmpty || view.busy} onClick={onSplit} data-testid="intake-split" data-emphasized={emphasis === 'split' ? 'true' : 'false'}>
          작업으로 나누기
        </Button>
        <Button type="button" size="sm" variant="secondary" className={buttonClass('graph')} aria-pressed={emphasis === 'graph'} disabled={fieldEmpty || view.busy} onClick={() => void onGraph()} data-testid="intake-graph" data-emphasized={emphasis === 'graph' ? 'true' : 'false'}>
          그래프로 실행
        </Button>
      </div>

      {view.absorbIds && (
        <div data-testid="intake-absorb-result" className="space-y-1 text-sm">
          <p>{ABSORB_COPY}</p>
          <ul>
            {view.absorbIds.map((id) => (
              <li key={id} data-testid="intake-absorb-id">{id}</li>
            ))}
          </ul>
        </div>
      )}

      {graphLine && (
        <div data-testid="intake-graph-result" className="space-y-1 text-sm">
          <p data-testid="intake-acceptance-id">{graphLine.acceptanceId}</p>
          {graphLine.phase && <p data-testid="intake-graph-phase">{graphLine.phase}</p>}
          {graphLine.runId && <p data-testid="intake-graph-run">{graphLine.runId}</p>}
        </div>
      )}

      {view.error && <p className="text-sm text-destructive" data-testid="intake-front-door-error">{view.error}</p>}

      {view.splitOpen && (
        <div data-testid="intake-split-host">
          <MemoIntakePreview initialMemo={view.splitMemo} onClose={() => setSplitOpen(false)} />
        </div>
      )}

      {view.recent.length > 0 && (
        <ul data-testid="intake-recent" className="space-y-1 text-xs text-muted-foreground">
          {view.recent.map((row, i) => {
            const timeline = timelineFor(row);
            return (
              <li key={`${row.at}-${i}`} data-testid="intake-recent-row">
                {row.track} · {row.preview}
                {row.ids ? ` · ${row.ids.join(', ')}` : ''}
                {row.track === 'absorb' && row.ids?.map((id) => {
                  const summary = Object.hasOwn(absorbStatuses, id)
                    ? summarizeAbsorbStatus(absorbStatuses[id] ?? null)
                    : null;
                  return <span key={id} data-testid="intake-absorb-status"> · 흡수: {summary?.label ?? '조회 중'}{summary?.noteRef ? ` · ${summary.noteRef}` : ''}</span>;
                })}
                {row.acceptanceId ? ` · ${row.acceptanceId}` : ''}
                {timeline?.stage && <span data-testid="intake-run-stage"> · 단계: {timeline.stage}</span>}
                {timeline?.lastEventAt && <time data-testid="intake-run-last-event" dateTime={timeline.lastEventAt}> · 마지막 사건: {timeline.lastEventAt}</time>}
                {timeline?.done && <span data-testid="intake-run-outcome"> · {timeline.outcome === 'completed' ? '완료' : timeline.outcome === 'failed' ? '실패' : '결과 미상'}{timeline.error ? ` · ${timeline.error.split('\n')[0]}` : ''}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
